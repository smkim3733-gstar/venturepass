import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  type AnalysisContent,
  type Candidate,
  type CaseMutation,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import {
  MAX_PREPARATION_REQUESTS,
  MAX_PREPARATION_RUNS,
  type PreparationRequest,
  type PreparationRun,
} from "./studio-preparation-types";
import { preparationDigest } from "./studio-preparation-state";
import * as engine from "./studio-engine";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  aiConstructor: vi.fn(),
  aiParse: vi.fn(),
  officialAction: vi.fn(() => {
    throw new Error("Official runner must not run in local preparation");
  }),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.aiParse };
    constructor() {
      state.aiConstructor();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({
  startVentureSession: state.officialAction,
  stopVentureSession: state.officialAction,
  continueVentureSession: state.officialAction,
  resumeVentureSession: state.officialAction,
  inspectVentureApplication: state.officialAction,
  previewVentureApplication: state.officialAction,
  compareVentureApplication: state.officialAction,
  inputVentureApplication: state.officialAction,
}));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/preparation/route";
import { POST as generate } from "@/app/api/studio/cases/[caseId]/generate/route";

let directory: string;
let company: StudioCase;
const context = (caseId = company.id) => ({ params: Promise.resolve({ caseId }) });
function request(body: unknown, headers: Record<string, string> = {}, query = "") {
  return new Request(`http://localhost:3000/api/studio/cases/fixture/preparation${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const post = (body: unknown, caseId = company.id) => POST(request(body), context(caseId));
const generatePlan = (mode: "assisted" | "ai" = "assisted") =>
  generate(
    new Request("http://localhost:3000/api/studio/cases/fixture/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "plan",
        mode,
        revision: company.revision,
      }),
    }),
    context(),
  );
const startBody = (overrides: Record<string, unknown> = {}) => ({
  action: "start",
  revision: company.revision,
  clientRequestId: randomUUID(),
  ...overrides,
});
const resumeBody = (run: PreparationRun, overrides: Record<string, unknown> = {}) => ({
  action: "resume",
  revision: company.revision,
  clientRequestId: randomUUID(),
  runId: run.id,
  ...overrides,
});
const continueBody = (run: PreparationRun, index = 0, overrides: Record<string, unknown> = {}) => ({
  action: "continue",
  revision: company.revision,
  clientRequestId: randomUUID(),
  runId: run.id,
  candidateId: run.candidates[index].id,
  candidateDigest: run.candidates[index].digest,
  ...overrides,
});
async function result(body: unknown) {
  const response = await post(body);
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  company = payload.company;
  return payload.run as PreparationRun;
}
const refresh = () => (company = state.store!.get(company.id));
const mutate = (mutation: CaseMutation) =>
  (company = state.store!.mutate(company.id, mutation, engine.reviewPlan));
function selectForPreparation(run: PreparationRun, index = 0) {
  mutate({
    action: "select-candidate",
    revision: company.revision,
    clientRequestId: randomUUID(),
    candidateId: run.candidates[index].id,
    analysisGeneratedAt: company.analysis!.generatedAt,
    analysisSourceRevision: company.analysis!.sourceRevision,
    expectedSelectedCandidateId: company.selectedCandidateId,
    reason: "합성 기술과 부족 자료를 직접 확인하고 이 후보를 선택했습니다.",
  });
  return continueBody(run, index);
}
function restart() {
  state.store!.close();
  state.store = new StudioStore(directory);
  refresh();
}
function replaceBody(body: unknown) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(
      JSON.stringify(body),
      company.id,
    );
  } finally {
    db.close();
  }
}
function candidate(index: number): Candidate {
  return {
    id: `candidate-${index}`,
    title: `가상 아이템 ${index}`,
    problem: "사용자가 입력한 가상 고객 문제",
    solution: `가상 해결 구성 ${index}`,
    targetCustomer: "검증하지 않은 가상 목표 고객",
    differentiation: "차별점은 확인이 필요합니다.",
    stage: "개발 구상",
    businessModel: "수익모델은 확인이 필요합니다.",
    recommendation: "사용자 검토용 후보",
    evidence: [],
    gaps: ["실제 개발·고객 증빙 확인 필요"],
  };
}
function seedAnalysis(count: number) {
  const content: AnalysisContent = {
    summary: "가상 자료로 구성한 로컬 분석",
    facts: [],
    candidates: Array.from({ length: count }, (_, i) => candidate(i + 1)),
    questions: [],
    warnings: ["실제 실적을 검증하지 않은 시험 자료입니다."],
  };
  company = state.store!.saveAnalysis(company.id, company.revision, content, "assisted");
  return company.analysis!;
}
function addSource(text = "가상 시험 자료 본문") {
  const now = new Date().toISOString();
  const source: SourceDocument = {
    id: randomUUID(),
    name: "가상 기술자료",
    kind: "technology",
    text,
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  mutate({ action: "source", revision: company.revision, source });
  return company.sources.find((item) => item.id === source.id)!;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "venture-preparation-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({ ...emptyProfile(), companyName: "로컬 준비 가상기업" });
  // Even with a configured-looking key, this feature must use local assisted mode only.
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key-must-not-be-used");
});
afterEach(() => {
  expect(state.aiConstructor).not.toHaveBeenCalled();
  expect(state.aiParse).not.toHaveBeenCalled();
  expect(state.officialAction).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-preparation-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("로컬 준비 자동진행 — 실제 임시 SQLite/API", () => {
  it("legacy 기업은 빈 진행기록으로 읽고 재시작 후에도 원래 기업정보를 보존한다", async () => {
    const legacy = { ...company } as Record<string, unknown>;
    delete legacy.preparationRuns;
    replaceBody(legacy);
    restart();
    expect(company.preparationRuns).toEqual([]);
    const response = await GET(
      new Request("http://localhost:3000/api/studio/cases/fixture/preparation"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      companyRevision: company.revision,
      runs: [],
      running: false,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(refresh().revision).toBe(0);
  });

  it("후보가 없으면 자료 보완에서 멈추고 계획서·기관 단계를 만들지 않는다", async () => {
    const before = structuredClone(company);
    const run = await result(startBody());
    expect(run).toMatchObject({ status: "awaiting_materials", mode: "assisted", stale: false });
    expect(run.candidates).toEqual([]);
    expect(company.diagnoses).toHaveLength(1);
    expect(company.analysis?.candidates).toEqual([]);
    expect(company.plans).toEqual([]);
    expect(company.stage).toBe(before.stage);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(company.sources).toEqual(before.sources);
    expect(company.diagnosisAnswers).toEqual(before.diagnosisAnswers);
    restart();
    expect(company.preparationRuns).toEqual([run]);
  });

  it("기술 설명에서 만든 단일 후보도 사용자 선택 전에 자동 원고를 만들지 않는다", async () => {
    mutate({
      action: "profile",
      revision: company.revision,
      profile: {
        ...company.profile,
        technologySummary: "가상 입력 처리 기술을 개발할 계획입니다.",
      },
    });
    const run = await result(startBody());
    expect(run.status).toBe("awaiting_choice");
    expect(run.candidates).toHaveLength(1);
    expect(company.selectedCandidateId).toBeNull();
    expect(company.plans).toEqual([]);
  });

  it.each([1, 2, 3])(
    "기존 %i개 후보 분석을 보존하고 선택한 후보로만 원고를 만든다",
    async (count) => {
      const analysis = structuredClone(seedAnalysis(count));
      const run = await result(startBody());
      expect(run.status).toBe("awaiting_choice");
      expect(run.candidates).toEqual(
        analysis.candidates.map((item) => ({ id: item.id, digest: preparationDigest(item) })),
      );
      expect(company.analysis).toEqual(analysis);
      expect(company.plans).toEqual([]);
      const finished = await result(selectForPreparation(run, count - 1));
      expect(finished).toMatchObject({
        status: "awaiting_review",
        phase: "review",
        selectedCandidateId: analysis.candidates[count - 1].id,
        stale: false,
      });
      expect(company.plans).toHaveLength(1);
      expect(company.plans[0]).toMatchObject({
        mode: "assisted",
        candidateId: analysis.candidates[count - 1].id,
        confirmedAt: null,
      });
      expect(company.stage).toBe("drafting");
      expect(finished.planId).toBe(company.plans[0].id);
    },
  );

  it("start·continue 응답 유실을 같은 nonce로 재시도해도 완료 단계와 원고를 다시 만들지 않는다", async () => {
    seedAnalysis(1);
    const first = startBody();
    const run = await result(first);
    const chosen = selectForPreparation(run);
    const finished = await result(chosen);
    const saved = structuredClone(company);
    restart();
    expect(await result(first)).toEqual(finished);
    expect(company).toEqual(saved);
    expect(await result(chosen)).toEqual(finished);
    expect(company).toEqual(saved);
    expect(company.plans).toHaveLength(1);
    expect(finished.steps.map((item) => item.phase)).toEqual([
      "diagnosis",
      "analysis",
      "selection",
      "plan",
    ]);
  });

  it.each(["choice", "review", "materials"])(
    "%s 대기에서 resume은 산출물을 중복 생성하지 않고 요청만 기록한다",
    async (phase) => {
      if (phase !== "materials") seedAnalysis(1);
      let run = await result(startBody());
      if (phase === "review") run = await result(selectForPreparation(run));
      const before = structuredClone(company);
      const body = resumeBody(run);
      const resumed = await result(body);
      expect(company.plans).toEqual(before.plans);
      expect(company.analysis).toEqual(before.analysis);
      expect(company.diagnoses).toEqual(before.diagnoses);
      expect(company.stageHistory).toEqual(before.stageHistory);
      expect(resumed.steps).toEqual(run.steps);
      expect(resumed.requests).toHaveLength(run.requests.length + 1);
      const saved = structuredClone(company);
      restart();
      expect(await result(body)).toEqual(resumed);
      expect(company).toEqual(saved);
    },
  );

  it("같은 nonce에 다른 후보·revision·action을 넣으면 409로 거부한다", async () => {
    seedAnalysis(2);
    const run = await result(startBody());
    const body = selectForPreparation(run);
    await result(body);
    const saved = structuredClone(company);
    for (const conflict of [
      { ...body, candidateId: run.candidates[1].id, candidateDigest: run.candidates[1].digest },
      { ...body, revision: company.revision },
      {
        action: "resume",
        revision: body.revision,
        clientRequestId: body.clientRequestId,
        runId: run.id,
      },
    ]) {
      const response = await post(conflict);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("PREPARATION_REQUEST_CONFLICT");
      expect(refresh()).toEqual(saved);
    }
  });

  it.each(["start", "continue", "resume"])(
    "%s의 신규 nonce는 오래된 CAS로 쓰지 않는다",
    async (action) => {
      seedAnalysis(1);
      const run = await result(startBody());
      const body =
        action === "start"
          ? startBody()
          : action === "continue"
            ? selectForPreparation(run)
            : resumeBody(run);
      const before = structuredClone(company);
      const response = await post({ ...body, revision: company.revision - 1 });
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("STALE_REVISION");
      expect(refresh()).toEqual(before);
    },
  );

  it.each(["missing", "digest", "foreign-run"])(
    "잘못된 후보 연결 %s는 산출물과 진행기록을 바꾸지 않는다",
    async (kind) => {
      seedAnalysis(1);
      const run = await result(startBody());
      const body = continueBody(
        run,
        0,
        kind === "missing"
          ? { candidateId: "unknown" }
          : kind === "digest"
            ? { candidateDigest: "a".repeat(64) }
            : { runId: randomUUID() },
      );
      const before = structuredClone(company);
      const response = await post(body);
      expect(response.status).toBe(409);
      expect(refresh()).toEqual(before);
    },
  );

  it("동일 후보 id라도 분석 내용이 달라지면 이전 digest의 선택을 거부한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const changed = {
      ...company.analysis!,
      candidates: [{ ...company.analysis!.candidates[0], solution: "교체된 다른 해결 구성" }],
    };
    company = state.store!.saveAnalysis(company.id, company.revision, changed, "assisted");
    const before = structuredClone(company);
    expect(company.preparationRuns[0].stale).toBe(true);
    const response = await post(continueBody(run));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PREPARATION_STALE");
    expect(refresh()).toEqual(before);
  });

  it.each(["profile", "source", "answers"])(
    "%s 입력 변경 뒤 과거 진행은 재개하지 않고 기존 산출물은 보존한다",
    async (change) => {
      const source = addSource();
      seedAnalysis(1);
      const run = await result(startBody());
      if (change === "profile")
        mutate({
          action: "profile",
          revision: company.revision,
          profile: { ...company.profile, customers: "수정된 고객 구상" },
        });
      if (change === "source")
        mutate({
          action: "source",
          revision: company.revision,
          source: { ...source, text: "자료 내용 수정" },
        });
      if (change === "answers")
        mutate({
          action: "diagnosis-answers",
          revision: company.revision,
          answers: { ...company.diagnosisAnswers, entityType: "corporate" },
        });
      const before = structuredClone(company);
      expect(company.preparationRuns[0].stale).toBe(true);
      expect((await post(resumeBody(run))).status).toBe(409);
      expect((await post(continueBody(run))).status).toBe(409);
      expect(refresh()).toEqual(before);
    },
  );

  it("자료 변경 후 동일 start nonce 응답은 현재 stale 기록만 돌려주고 재분석하지 않는다", async () => {
    seedAnalysis(1);
    const body = startBody();
    const run = await result(body);
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, customers: "새 고객 설명" },
    });
    const before = structuredClone(company);
    expect(await result(body)).toEqual({ ...run, stale: true });
    expect(company).toEqual(before);
    expect(company.analysis).toBeNull();
  });

  it("현재 선택과 수동 편집 원고가 있으면 버전·검토·확정을 수정하지 않고 재사용한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    await result(selectForPreparation(run));
    const oldPlan = company.plans[0];
    mutate({
      action: "save-plan",
      revision: company.revision,
      planId: oldPlan.id,
      content: { ...oldPlan.content, summary: "사용자가 편집한 검토 전 초안" },
    });
    const beforePlans = structuredClone(company.plans);
    const beforeHistory = structuredClone(company.stageHistory);
    const next = await result(startBody());
    expect(next.status).toBe("awaiting_review");
    expect(next.planId).toBe(beforePlans.at(-1)!.id);
    expect(next.steps.find((item) => item.phase === "plan")?.state).toBe("reused");
    expect(company.plans).toEqual(beforePlans);
    expect(company.stageHistory).toEqual(beforeHistory);
    expect(company.diagnoses).toHaveLength(1);
    expect(company.preparationRuns).toHaveLength(2);
  });

  it.each(["diagnosis", "analysis", "plan"])(
    "%s checkpoint 직후 재시작해도 이미 완료한 단계는 다시 쓰지 않는다",
    async (phase) => {
      seedAnalysis(1);
      const input = startBody() as PreparationRequest;
      company = state.store!.beginPreparation(company.id, input);
      const runId = company.preparationRuns[0].id;
      company = state.store!.commitPreparation(company.id, company.revision, runId, {
        phase: "diagnosis",
      });
      if (phase !== "diagnosis")
        company = state.store!.commitPreparation(company.id, company.revision, runId, {
          phase: "analysis",
          content: null,
        });
      if (phase === "plan") {
        const selection = selectForPreparation(company.preparationRuns[0]) as PreparationRequest;
        company = state.store!.beginPreparation(company.id, selection);
        const content = await engine.generatePlan(
          company,
          company.analysis!.candidates[0],
          "assisted",
        );
        content.sections = content.sections.map((section) => ({
          ...section,
          needsConfirmation: true,
        }));
        company = state.store!.commitPreparation(company.id, company.revision, runId, {
          phase: "plan",
          content,
          review: engine.reviewPlan(company, content),
        });
      }
      const before = structuredClone(company);
      restart();
      const resumed = await result(resumeBody(company.preparationRuns[0]));
      expect(company.diagnoses).toEqual(before.diagnoses);
      expect(company.analysis).toEqual(before.analysis);
      expect(company.plans).toEqual(before.plans);
      expect(resumed.steps.filter((step) => step.phase === "diagnosis")).toHaveLength(1);
      if (phase !== "diagnosis") expect(resumed.steps).toEqual(before.preparationRuns[0].steps);
    },
  );

  it("원고 생성 실패 후 재개는 완료한 진단·분석·선택을 보존하고 원고만 한 번 추가한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const before = structuredClone(company);
    vi.spyOn(engine, "generatePlan").mockRejectedValueOnce(
      new Error("Synthetic generation failure"),
    );
    const failed = await result(selectForPreparation(run));
    expect(failed).toMatchObject({ status: "failed", phase: "plan", code: "PREPARATION_FAILED" });
    expect(company.plans).toEqual([]);
    expect(company.analysis).toEqual(before.analysis);
    expect(company.diagnoses).toEqual(before.diagnoses);
    restart();
    const finished = await result(resumeBody(failed));
    expect(finished.status).toBe("awaiting_review");
    expect(company.plans).toHaveLength(1);
    expect(finished.steps).toHaveLength(4);
    expect(company.plans[0].content.sections.every((section) => section.needsConfirmation)).toBe(
      true,
    );
    expect(company.plans[0].confirmedAt).toBeNull();
  });

  it("진행 중 중복 POST는 busy로 거부하고 첫 요청 종료 후 잠금을 해제한다", async () => {
    let release!: (value: AnalysisContent) => void;
    const pending = new Promise<AnalysisContent>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(engine, "analyzeCompany").mockImplementationOnce(async () => {
      entered();
      return pending;
    });
    const body = startBody();
    const first = post(body);
    await started;
    const duplicate = await post(body);
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).code).toBe("PREPARATION_BUSY");
    release({ summary: "시험 분석", facts: [], candidates: [], questions: [], warnings: [] });
    expect((await first).status).toBe(200);
    refresh();
    expect((await post(resumeBody(company.preparationRuns[0]))).status).toBe(200);
  });

  it("분석 await 중 기업자료가 바뀌면 계산한 결과를 저장하지 않는다", async () => {
    vi.spyOn(engine, "analyzeCompany").mockImplementationOnce(async () => {
      refresh();
      mutate({
        action: "profile",
        revision: company.revision,
        profile: { ...company.profile, customers: "동시 수정 자료" },
      });
      return {
        summary: "저장되면 안 되는 결과",
        facts: [],
        candidates: [candidate(1)],
        questions: [],
        warnings: [],
      };
    });
    const response = await post(startBody());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("STALE_REVISION");
    refresh();
    expect(company.analysis).toBeNull();
    expect(company.plans).toEqual([]);
    expect(company.preparationRuns[0].stale).toBe(true);
  });

  it.each(["start", "continue", "resume"])(
    "회사 입력 lock 중 %s는 기록·산출물을 쓰지 않는다",
    async (action) => {
      seedAnalysis(1);
      const run = await result(startBody());
      const body =
        action === "start"
          ? startBody()
          : action === "continue"
            ? selectForPreparation(run)
            : resumeBody(run);
      const before = structuredClone(company);
      await withVentureInputCompanyLock(company.id, async () => {
        const response = await post(body);
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe("INPUT_IN_PROGRESS");
        expect(refresh()).toEqual(before);
      });
      expect((await post(resumeBody(run))).status).toBe(200);
    },
  );

  it("30개 진행기록은 버리지 않으며 31번째 새 진행만 거부한다", async () => {
    const run = await result(startBody());
    const runs = Array.from({ length: MAX_PREPARATION_RUNS }, (_, i) => ({
      ...run,
      id: randomUUID(),
      requests: [{ clientRequestId: randomUUID(), digest: preparationDigest({ index: i }) }],
    }));
    replaceBody({ ...company, preparationRuns: runs });
    refresh();
    const before = structuredClone(company);
    const response = await post(startBody());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PREPARATION_LIMIT");
    expect(refresh()).toEqual(before);
    restart();
    expect(company.preparationRuns).toHaveLength(MAX_PREPARATION_RUNS);
  });

  it("한 진행의 요청 20개 한도에서 동일 nonce 재조회는 허용하고 새 요청만 거부한다", async () => {
    const first = startBody();
    let run = await result(first);
    for (let i = 1; i < MAX_PREPARATION_REQUESTS; i++) run = await result(resumeBody(run));
    const before = structuredClone(company);
    expect(run.requests).toHaveLength(MAX_PREPARATION_REQUESTS);
    expect((await post(resumeBody(run))).status).toBe(409);
    expect(refresh()).toEqual(before);
    expect(await result(first)).toEqual(run);
    expect(company).toEqual(before);
  });

  it("다른 회사의 진행 id와 후보를 이용한 재개를 거부한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const other = state.store!.create({ ...emptyProfile(), companyName: "별도 가상기업" });
    const response = await post({ ...continueBody(run), revision: other.revision }, other.id);
    expect(response.status).toBe(409);
    expect(state.store!.get(other.id)).toEqual(other);
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it.each(["diagnosis", "analysis", "plan"])(
    "%s SQL commit 뒤 응답 유실은 재시작·동일 nonce 재요청으로 중복 없이 회복한다",
    async (phase) => {
      seedAnalysis(1);
      let body: Record<string, unknown> = startBody();
      if (phase === "plan") body = selectForPreparation(await result(body));
      const actualCommit = state.store!.commitPreparation.bind(state.store!);
      vi.spyOn(state.store!, "commitPreparation").mockImplementation((...args) => {
        const saved = actualCommit(...args);
        if (args[3].phase === phase)
          throw new Error("Synthetic response lost after durable commit");
        return saved;
      });
      const lost = await post(body);
      expect(lost.status).toBe(500);
      expect(await lost.json()).toMatchObject({ accepted: true, code: "PREPARATION_FAILED" });
      refresh();
      const before = structuredClone(company);
      expect(before.preparationRuns[0].steps.some((step) => step.phase === phase)).toBe(true);
      restart();
      const resumed = await result(body);
      expect(company.diagnoses).toEqual(before.diagnoses);
      expect(company.analysis).toEqual(before.analysis);
      expect(company.plans).toEqual(before.plans);
      expect(resumed.steps.filter((step) => step.phase === phase)).toHaveLength(1);
      expect(resumed.requests).toEqual(before.preparationRuns[0].requests);
    },
  );

  it("원고 checkpoint SQL 저장 실패는 원고·단계 승격을 함께 롤백하고 이후 한 번만 재개한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const beforeHistory = structuredClone(company.stageHistory);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER synthetic_plan_failure BEFORE UPDATE OF body ON studio_cases WHEN json_array_length(json_extract(NEW.body, '$.plans')) > json_array_length(json_extract(OLD.body, '$.plans')) BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
      );
      const failed = await result(selectForPreparation(run));
      expect(failed).toMatchObject({ status: "failed", phase: "plan" });
      expect(company.plans).toEqual([]);
      expect(company.stage).toBe("preparing");
      expect(company.stageHistory).toEqual(beforeHistory);
      expect(failed.steps.map((step) => step.phase)).toEqual([
        "diagnosis",
        "analysis",
        "selection",
      ]);
      db.exec("DROP TRIGGER synthetic_plan_failure");
      restart();
      const resumed = await result(resumeBody(failed));
      expect(resumed.status).toBe("awaiting_review");
      expect(company.plans).toHaveLength(1);
      expect(company.stageHistory).toHaveLength(beforeHistory.length + 1);
    } finally {
      db.close();
    }
  });

  it("직접 완료 checkpoint를 재호출하면 기존 산출물을 유지하고 중복 쓰기를 거부한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const finished = await result(selectForPreparation(run));
    const before = structuredClone(company);
    expect(() =>
      state.store!.commitPreparation(company.id, company.revision, finished.id, {
        phase: "plan",
        content: company.plans[0].content,
        review: company.plans[0].review,
      }),
    ).toThrow();
    expect(refresh()).toEqual(before);
  });

  it("원본만 보관한 pending 자료는 후보·분석 사실로 승격하지 않는다", async () => {
    const now = new Date().toISOString();
    const source: SourceDocument = {
      id: randomUUID(),
      name: "시험 기술 원본",
      kind: "technology",
      text: "",
      originalName: "fixture.pdf",
      mimeType: "application/pdf",
      extraction: "pending",
      warnings: ["원본만 보관했습니다."],
      createdAt: now,
      updatedAt: now,
    };
    const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC PENDING ORIGINAL");
    company = state.store!.addUpload(company.id, company.revision, source, bytes);
    const before = structuredClone(company.sources);
    const run = await result(startBody());
    expect(run.status).toBe("awaiting_materials");
    expect(company.analysis?.candidates).toEqual([]);
    expect(
      company.analysis?.facts.some((fact) =>
        fact.evidence.some((entry) => entry.sourceId === source.id),
      ),
    ).toBe(false);
    expect(company.sources).toEqual(before);
    expect(state.store!.originalForVentureInput(company.id, source.id).buffer).toEqual(bytes);
  });

  it("중복 후보 id 분석은 선택·원고 생성을 차단하고 분석 원본은 보존한다", async () => {
    const analysis = seedAnalysis(2);
    analysis.candidates[1].id = analysis.candidates[0].id;
    company = state.store!.saveAnalysis(company.id, company.revision, analysis, "assisted");
    const before = structuredClone(company.analysis);
    const run = await result(startBody());
    expect(run).toMatchObject({ status: "failed", phase: "analysis" });
    expect(company.analysis).toEqual(before);
    expect(company.plans).toEqual([]);
    expect(company.selectedCandidateId).toBeNull();
  });

  it("분석 await 중 공식 입력 lock이 생기면 checkpoint도 실패 기록도 덮지 않는다", async () => {
    let release!: (content: AnalysisContent) => void;
    const pending = new Promise<AnalysisContent>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(engine, "analyzeCompany").mockImplementationOnce(async () => {
      entered();
      return pending;
    });
    const body = startBody();
    const processing = post(body);
    await started;
    refresh();
    const checkpoint = structuredClone(company);
    await withVentureInputCompanyLock(company.id, async () => {
      release({ summary: "로컬 분석", facts: [], candidates: [], questions: [], warnings: [] });
      const response = await processing;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ accepted: true, code: "INPUT_IN_PROGRESS" });
      expect(refresh()).toEqual(checkpoint);
    });
    expect((await result(body)).status).toBe("awaiting_materials");
  });

  it("보존된 과거 원고 100개 한도에서 새 원고만 거부하며 오래된 버전은 삭제하지 않는다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    await result(selectForPreparation(run));
    const first = company.plans[0];
    const plans = Array.from({ length: 100 }, (_, i) => ({
      ...first,
      id: randomUUID(),
      version: i + 1,
    }));
    replaceBody({ ...company, plans });
    refresh();
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, technologySummary: "새로운 가상 기술 설명" },
    });
    const before = structuredClone(company.plans);
    const current = await result(startBody());
    const failed = await result(selectForPreparation(current));
    expect(failed.status).toBe("failed");
    expect(company.plans).toEqual(before);
    expect(company.plans).toHaveLength(100);
  });
});

describe("로컬 준비의 선택 이유 연결", () => {
  it.each(["assisted", "ai"] as const)(
    "별도 %s 원고 생성 API도 이유 없는 구형 선택을 계산 전에 거부한다",
    async (mode) => {
      seedAnalysis(1);
      replaceBody({ ...company, selectedCandidateId: company.analysis!.candidates[0].id });
      refresh();
      const before = structuredClone(company);
      const generation = vi.spyOn(engine, "generatePlan");
      const response = await generatePlan(mode);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "CANDIDATE_SELECTION_REQUIRED" });
      expect(refresh()).toEqual(before);
      expect(generation).not.toHaveBeenCalled();
    },
  );

  it("별도 원고 생성은 현재 선택 이유 저장 후 정상 동작하고 이유를 원고 본문에 복제하지 않는다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    selectForPreparation(run);
    const selections = structuredClone(company.candidateSelections);
    const response = await generatePlan();
    expect(response.status).toBe(200);
    company = await response.json();
    expect(company.plans).toHaveLength(1);
    expect(company.candidateSelections).toEqual(selections);
    expect(JSON.stringify(company.plans[0].content)).not.toContain(selections[0].reason);
  });

  it("별도 원고 계산 중 이유 연결이 사라지면 저장 경계에서 거부한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    selectForPreparation(run);
    const actualGenerate = engine.generatePlan;
    vi.spyOn(engine, "generatePlan").mockImplementationOnce(async (...args) => {
      const content = await actualGenerate(...args);
      refresh();
      replaceBody({ ...company, candidateSelections: [] });
      return content;
    });
    const response = await generatePlan();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CANDIDATE_SELECTION_REQUIRED" });
    refresh();
    expect(company.plans).toEqual([]);
    expect(company.stage).toBe("preparing");
  });

  it("안전 저장 메서드도 직접 호출 우회를 거부하지만 기존 원고의 수동 새 버전은 보존한다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    await result(selectForPreparation(run));
    const original = structuredClone(company.plans[0]);
    replaceBody({ ...company, candidateSelections: [] });
    restart();
    const before = structuredClone(company);
    expect(() =>
      state.store!.saveGeneratedPlan(
        company.id,
        company.revision,
        original.candidateId,
        original.content,
        original.review,
        "assisted",
      ),
    ).toThrow(expect.objectContaining({ code: "CANDIDATE_SELECTION_REQUIRED" }));
    expect(refresh()).toEqual(before);
    mutate({
      action: "save-plan",
      revision: company.revision,
      planId: original.id,
      content: { ...original.content, summary: "사용자가 명시적으로 수정한 새 버전" },
    });
    expect(company.plans).toHaveLength(2);
    expect(company.plans[0]).toEqual(original);
    expect(company.candidateSelections).toEqual([]);
    expect(company.plans[1].mode).toBe("manual");
  });

  it("선택 이유 없는 continue는 기존 후보를 선택하거나 원고를 생성하지 않는다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const before = structuredClone(company);
    const generation = vi.spyOn(engine, "generatePlan");
    const response = await post(continueBody(run));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "PREPARATION_SELECTION_REQUIRED",
      accepted: false,
    });
    expect(refresh()).toEqual(before);
    expect(company.selectedCandidateId).toBeNull();
    expect(company.candidateSelections).toEqual([]);
    expect(generation).not.toHaveBeenCalled();
  });

  it("선택 이유 없는 구형 선택·원고는 읽고 보존하되 start는 선택 확인에서 대기한다", async () => {
    seedAnalysis(1);
    const first = await result(startBody());
    await result(selectForPreparation(first));
    const legacy = structuredClone(company) as StudioCase & { candidateSelections?: unknown };
    delete (legacy as Partial<StudioCase>).candidateSelections;
    replaceBody(legacy);
    restart();
    const before = structuredClone(company);
    const generation = vi.spyOn(engine, "generatePlan");
    const run = await result(startBody());
    expect(run).toMatchObject({
      status: "awaiting_choice",
      phase: "choice",
      selectedCandidateId: null,
      planId: null,
    });
    expect(company.selectedCandidateId).toBe(before.selectedCandidateId);
    expect(company.plans).toEqual(before.plans);
    expect(company.candidateSelections).toEqual([]);
    expect(company.stageHistory).toEqual(before.stageHistory);
    expect(generation).not.toHaveBeenCalled();
    restart();
    expect(company.preparationRuns.at(-1)?.status).toBe("awaiting_choice");
  });

  it("이유 저장 후 최신 회사 revision만 이어가며 continue가 선택 이력을 중복 작성하지 않는다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const outdated = continueBody(run);
    const body = selectForPreparation(run);
    const selection = structuredClone(company.candidateSelections);
    const selectedRevision = company.revision;
    const before = structuredClone(company);
    expect((await post(outdated)).status).toBe(409);
    expect(refresh()).toEqual(before);
    expect(body.revision).toBe(selectedRevision);
    const finished = await result(body);
    expect(finished.status).toBe("awaiting_review");
    expect(company.candidateSelections).toEqual(selection);
    expect(selection).toHaveLength(1);
    expect(company.plans).toHaveLength(1);
    restart();
    const saved = structuredClone(company);
    expect(await result(body)).toEqual(finished);
    expect(company).toEqual(saved);
  });

  it("다른 후보의 저장 이유로 continue할 수 없다", async () => {
    seedAnalysis(2);
    const run = await result(startBody());
    selectForPreparation(run, 0);
    const before = structuredClone(company);
    const response = await post(continueBody(run, 1));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PREPARATION_SELECTION_REQUIRED" });
    expect(refresh()).toEqual(before);
  });

  it.each(["analysis-body", "candidate-body", "digest"])(
    "%s 변경 뒤 이전 선택 이유를 새 start에 자동 재사용하지 않는다",
    async (change) => {
      seedAnalysis(1);
      const first = await result(startBody());
      await result(selectForPreparation(first));
      const altered = structuredClone(company);
      if (change === "analysis-body") altered.analysis!.summary += " 다른 분석 설명";
      if (change === "candidate-body") altered.analysis!.candidates[0].solution += " 다른 해결";
      if (change === "digest") altered.candidateSelections[0].analysisDigest = "f".repeat(64);
      replaceBody(altered);
      restart();
      const plans = structuredClone(company.plans);
      const selections = structuredClone(company.candidateSelections);
      const generation = vi.spyOn(engine, "generatePlan");
      const run = await result(startBody());
      expect(run.status).toBe("awaiting_choice");
      expect(run.selectedCandidateId).toBeNull();
      expect(company.plans).toEqual(plans);
      expect(company.candidateSelections).toEqual(selections);
      expect(generation).not.toHaveBeenCalled();
    },
  );

  it.each(["running", "failed"])(
    "이유 없는 구형 %s 원고 checkpoint는 resume·replay·직접 commit으로 우회하지 못한다",
    async (status) => {
      seedAnalysis(1);
      const first = await result(startBody());
      const body = selectForPreparation(first) as PreparationRequest;
      company = state.store!.beginPreparation(company.id, body);
      const legacy = structuredClone(company);
      legacy.candidateSelections = [];
      legacy.preparationRuns[0].status = status as "running" | "failed";
      replaceBody(legacy);
      restart();
      const before = structuredClone(company);
      const generation = vi.spyOn(engine, "generatePlan");
      const response = await post(resumeBody(company.preparationRuns[0]));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "PREPARATION_STALE" });
      expect(refresh()).toEqual(before);
      const replay = await result(body);
      expect(replay.stale).toBe(true);
      expect(company).toEqual(before);
      expect(() =>
        state.store!.commitPreparation(company.id, company.revision, replay.id, {
          phase: "plan",
          content: null,
          review: [],
        }),
      ).toThrow(expect.objectContaining({ code: "PREPARATION_STALE" }));
      expect(refresh()).toEqual(before);
      expect(company.plans).toEqual([]);
      expect(generation).not.toHaveBeenCalled();
    },
  );

  it("원고 계산 중 선택 이유 연결이 사라지면 결과를 저장하지 않는다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const body = selectForPreparation(run);
    const actualGenerate = engine.generatePlan;
    vi.spyOn(engine, "generatePlan").mockImplementationOnce(async (...args) => {
      const content = await actualGenerate(...args);
      refresh();
      replaceBody({ ...company, candidateSelections: [] });
      return content;
    });
    const failed = await result(body);
    expect(failed).toMatchObject({ status: "blocked", code: "PREPARATION_STALE" });
    expect(company.plans).toEqual([]);
    expect(company.candidateSelections).toEqual([]);
    expect(company.stage).toBe("preparing");
  });

  it("이유 추가·정정만으로 완료한 준비와 기존 원고를 다시 만들지 않는다", async () => {
    seedAnalysis(1);
    const run = await result(startBody());
    const finished = await result(selectForPreparation(run));
    const plans = structuredClone(company.plans);
    selectForPreparation(finished);
    const selections = structuredClone(company.candidateSelections);
    const generation = vi.spyOn(engine, "generatePlan");
    const resumed = await result(resumeBody(finished));
    expect(resumed.status).toBe("awaiting_review");
    expect(company.plans).toEqual(plans);
    expect(company.candidateSelections).toEqual(selections);
    expect(selections).toHaveLength(2);
    expect(generation).not.toHaveBeenCalled();
  });
});

describe("로컬 준비 API의 입력 경계", () => {
  it.each([
    ["missing revision", { revision: undefined }],
    ["negative revision", { revision: -1 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["fraction revision", { revision: 0.5 }],
    ["invalid nonce", { clientRequestId: "not-a-uuid" }],
    ["client mode", { mode: "ai" }],
    ["client stage", { phase: "review" }],
    ["client artifact", { plan: { content: "forged" } }],
    ["client run", { runId: randomUUID() }],
    ["unknown action", { action: "submit" }],
  ])("%s 입력을 거부하고 저장하지 않는다", async (_label, invalid) => {
    const before = structuredClone(company);
    const response = await post(startBody(invalid));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
    expect(refresh()).toEqual(before);
  });

  it.each([
    ["origin", { origin: "https://example.com" }],
    ["fetch-site", { "sec-fetch-site": "cross-site" }],
    ["forwarded-host", { "x-forwarded-host": "example.com" }],
    ["host", { host: "example.com" }],
  ])("외부 %s 요청은 실행 전에 거부한다", async (_label, headers) => {
    const before = structuredClone(company);
    const response = await POST(request(startBody(), headers as Record<string, string>), context());
    expect(response.status).toBe(403);
    expect(refresh()).toEqual(before);
  });

  it.each(["GET", "POST"])("%s URL query를 거부한다", async (method) => {
    const response =
      method === "GET"
        ? await GET(
            new Request("http://localhost:3000/api/studio/cases/fixture/preparation?ignored=true"),
            context(),
          )
        : await POST(request(startBody(), {}, "?ignored=true"), context());
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_QUERY");
    expect(refresh().revision).toBe(0);
  });

  it.each(["missing", "invalid"])("%s 기업 식별자를 거부한다", async (kind) => {
    const response = await post(startBody(), kind === "missing" ? randomUUID() : "invalid");
    expect(response.status).toBe(kind === "missing" ? 404 : 400);
    expect(refresh().revision).toBe(0);
  });

  it.each(["content-type", "json", "body", "declared-body"])(
    "%s 경계 오류에서 기록을 생성하지 않는다",
    async (kind) => {
      const before = structuredClone(company);
      const req = new Request("http://localhost:3000/api/studio/cases/fixture/preparation", {
        method: "POST",
        headers: {
          "content-type": kind === "content-type" ? "text/plain" : "application/json",
          ...(kind === "declared-body" ? { "content-length": "5000" } : {}),
        },
        body:
          kind === "json"
            ? "{"
            : kind === "body"
              ? JSON.stringify({ ...startBody(), text: "x".repeat(5000) })
              : JSON.stringify(startBody()),
      });
      const response = await POST(req, context());
      expect(response.status).toBe(kind === "content-type" ? 415 : kind === "json" ? 400 : 413);
      expect(refresh()).toEqual(before);
    },
  );
});
