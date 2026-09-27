import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  sectionDefinitions,
  type AnalysisContent,
  type Candidate,
  type PlanContent,
  type ReviewFinding,
  type StudioCase,
} from "./studio-schema";
import {
  guidedPreparationApproval,
  guidedPreparationDigest,
} from "./studio-guided-preparation-state";
import {
  unresolvedGuidedPreparationRuns,
  type GuidedPreparationRun,
} from "./studio-guided-preparation-types";
import { reviewPlan } from "./studio-engine";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { studioGenerationJobs } from "./studio-generation-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  parse: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.parse };
    constructor(options: unknown) {
      state.constructor(options);
    }
  },
}));
import { GET, POST } from "@/app/api/studio/cases/[caseId]/guided-preparation/route";
import { POST as legacyGenerate } from "@/app/api/studio/cases/[caseId]/generate/route";

let directory: string, company: StudioCase;
const url = "http://localhost:3000/api/studio/guided-preparation";
const context = () => ({ params: Promise.resolve({ caseId: company.id }) });
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const start = () => ({
  action: "start" as const,
  revision: company.revision,
  clientRequestId: randomUUID(),
  approved: true as const,
  approval: guidedPreparationApproval(company, "mock-model"),
});
const restart = (previousRunId: string) => ({
  ...start(),
  action: "restart" as const,
  previousRunId,
  acknowledgedPreviousAttempt: true as const,
});
const answer = (output_parsed: unknown) => ({ status: "completed", output_parsed });
const candidate: Candidate = {
  id: "synthetic-topic",
  classification: "current",
  title: "가상 센서 분석 기술",
  problem: "관찰 시간이 오래 걸림",
  solution: "가상 센서 데이터를 분석합니다",
  targetCustomer: "가상 시험 고객",
  differentiation: "차별성 확인 필요",
  stage: "시험 구상",
  businessModel: "검토할 계획",
  recommendation: "입력 설명과 관련된 검토 후보",
  evidence: [
    { sourceId: "profile", quote: "가상 센서 데이터를 분석합니다", locator: "technologySummary" },
  ],
  gaps: ["실제 시험 자료 확인 필요"],
};
const analysis = (count = 1): AnalysisContent => ({
  summary: "합성 자료 분석",
  facts: [],
  candidates: count ? [candidate] : [],
  questions: [
    { id: "q1", question: "시험 자료가 있나요?", reason: "실제 역량 확인", priority: "high" },
  ],
  warnings: [],
});
const plan = () => ({
  title: "가상 계획서",
  summary: "공식 화면 대조가 필요한 검토 초안",
  sections: sectionDefinitions.map((item) => ({
    ...item,
    content: "가상 센서 데이터를 분석합니다. [확인 필요] 실제 시험 자료를 추가해야 합니다.",
    evidence: candidate.evidence,
    needsConfirmation: true,
  })),
  actionItems: ["실제 시험 자료 확인"],
  interviewQuestions: ["실제 시험 자료를 확인할 수 있나요?"],
});
async function post(body: unknown) {
  return POST(request(body), context());
}
async function accept(body: unknown) {
  const response = await post(body),
    payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  company = payload.company;
  return payload.run as GuidedPreparationRun;
}
function select() {
  company = state.store!.mutate(
    company.id,
    {
      action: "select-candidate",
      revision: company.revision,
      clientRequestId: randomUUID(),
      candidateId: candidate.id,
      analysisGeneratedAt: company.analysis!.generatedAt,
      analysisSourceRevision: company.analysis!.sourceRevision,
      expectedSelectedCandidateId: company.selectedCandidateId,
      reason: "가상 시험 자료와 확인할 부분을 보고 이 주제를 선택했습니다.",
    },
    reviewPlan,
  );
}
function changeProfile() {
  company = state.store!.mutate(
    company.id,
    {
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, technologySummary: "바뀐 가상 기술 설명" },
    },
    reviewPlan,
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-guided-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({
    ...emptyProfile(),
    companyName: "합성 시험기업",
    businessNumber: "PRIVATE-FIELD",
    technologySummary: "가상 센서 데이터를 분석합니다",
  });
  state.parse.mockReset();
  state.constructor.mockClear();
  studioGenerationJobs.clear();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-key-never-sent");
  vi.stubEnv("OPENAI_MODEL", "mock-model");
});
afterEach(() => {
  state.store!.close();
  vi.unstubAllEnvs();
  studioGenerationJobs.clear();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-guided-test-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("승인 범위에 묶인 AI 준비", () => {
  it("GET은 원본·본문을 승인표에 복제하거나 전송하지 않고 범위만 안내한다", async () => {
    const response = await GET(new Request(url), context()),
      payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.approval).toMatchObject({
      provider: "OpenAI",
      originalFilesIncluded: false,
      profileIncluded: true,
      businessNumberIncluded: false,
      derivedDraftIncluded: true,
      autoRevisionLimit: 1,
    });
    expect(JSON.stringify(payload.approval)).not.toContain("PRIVATE-FIELD");
    expect(state.parse).not.toHaveBeenCalled();
    expect(state.store!.get(company.id).revision).toBe(0);
  });
  it("SDK 환경 목적지 변경을 상속하지 않고 승인한 OpenAI 주소만 사용한다", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://unapproved.example/v1");
    state.parse.mockResolvedValueOnce(answer(analysis()));
    await accept(start());
    expect(state.constructor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.openai.com/v1", maxRetries: 0 }),
    );
  });
  it("자료 승인 1회→AI 분석→명시 주제 선택→AI 작성·독립 검토; 확인완료는 만들지 않는다", async () => {
    state.parse.mockResolvedValueOnce(answer(analysis()));
    const input = start(),
      run = await accept(input);
    expect(run.status).toBe("awaiting_choice");
    expect(company.selectedCandidateId).toBeNull();
    expect(company.candidateSelections).toHaveLength(0);
    expect(company.plans).toHaveLength(0);
    expect(await accept(input)).toEqual(run);
    expect(state.parse).toHaveBeenCalledTimes(1);
    select();
    state.parse
      .mockResolvedValueOnce(answer(plan()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const continuation = {
      action: "continue",
      revision: company.revision,
      clientRequestId: randomUUID(),
      runId: run.id,
    };
    const done = await accept(continuation);
    expect(done.status).toBe("awaiting_review");
    expect(done.approval).toEqual(run.approval);
    expect(company.plans).toHaveLength(1);
    expect(company.plans[0]).toMatchObject({ mode: "ai", confirmedAt: null });
    expect(company.candidateSelections).toHaveLength(1);
    expect(state.parse).toHaveBeenCalledTimes(3);
    expect(state.constructor.mock.calls.every(([options]) => options.maxRetries === 0)).toBe(true);
    expect(
      state.parse.mock.calls.every(
        ([options]) =>
          options.store === false && !JSON.stringify(options.input).includes("PRIVATE-FIELD"),
      ),
    ).toBe(true);
    await accept(continuation);
    expect(state.parse).toHaveBeenCalledTimes(3);
    expect(company.plans).toHaveLength(1);
  });
  it("부족 자료 질문이 있어도 선택 가능한 후보가 있으면 작성 가능한 원고를 계속 만든다", async () => {
    company = state.store!.saveAnalysis(company.id, company.revision, analysis(), "ai");
    select();
    const originalSelection = structuredClone(company.candidateSelections);
    state.parse
      .mockResolvedValueOnce(answer(plan()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const run = await accept(start());
    expect(run.status).toBe("awaiting_review");
    expect(state.parse).toHaveBeenCalledTimes(2);
    expect(company.candidateSelections).toEqual(originalSelection);
    expect(company.plans[0].content.actionItems.length).toBeGreaterThan(0);
  });
  it("후보가 없으면 구체적 질문을 보존하고 원고·기관 상태를 만들지 않는다", async () => {
    state.parse.mockResolvedValueOnce(answer(analysis(0)));
    expect((await accept(start())).status).toBe("awaiting_materials");
    expect(company.analysis!.questions).toHaveLength(1);
    expect(company.plans).toHaveLength(0);
    expect(company.stage).toBe("preparing");
  });
  it("동의 누락·다른 기업·모델·대상변경은 첫 AI 요청 전에 거부한다", async () => {
    const input = start();
    for (const body of [
      { ...input, approved: false },
      { ...input, approval: { ...input.approval, caseId: randomUUID() } },
      { ...input, approval: { ...input.approval, model: "changed" } },
    ])
      expect((await post(body)).status).toBeGreaterThanOrEqual(400);
    changeProfile();
    expect((await post(input)).status).toBe(409);
    expect(state.parse).not.toHaveBeenCalled();
    expect(state.store!.get(company.id).guidedPreparationRuns ?? []).toHaveLength(0);
  });
  it("선택 없는 continue나 선택 후 증빙 변경은 전송하지 않는다", async () => {
    state.parse.mockResolvedValueOnce(answer(analysis()));
    const run = await accept(start());
    expect(
      (
        await post({
          action: "continue",
          revision: company.revision,
          clientRequestId: randomUUID(),
          runId: run.id,
        })
      ).status,
    ).toBe(409);
    select();
    changeProfile();
    expect(
      (
        await post({
          action: "continue",
          revision: company.revision,
          clientRequestId: randomUUID(),
          runId: run.id,
        })
      ).status,
    ).toBe(409);
    expect(state.parse).toHaveBeenCalledTimes(1);
  });
  it("독립 검토 전에 자료가 바뀌면 후속 AI 요청과 늦은 저장을 막는다", async () => {
    company = state.store!.saveAnalysis(company.id, company.revision, analysis(), "ai");
    select();
    state.parse.mockImplementationOnce(async () => {
      company = state.store!.get(company.id);
      changeProfile();
      return answer(plan());
    });
    const response = await post(start());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ accepted: true, code: "GUIDED_INPUT_CHANGED" });
    expect(state.parse).toHaveBeenCalledTimes(1);
    expect(state.store!.get(company.id).plans).toHaveLength(0);
    company = state.store!.get(company.id);
    expect((await post(start())).status).toBe(409);
    expect(state.parse).toHaveBeenCalledTimes(1);
  });
  it("모호한 외부 실패는 보존하고 같은 자료를 새 nonce로 다시 전송하지 않는다", async () => {
    state.parse.mockRejectedValueOnce(new Error("private provider body"));
    const run = await accept(start());
    expect(run.status).toBe("failed");
    expect(JSON.stringify(company)).not.toContain("private provider body");
    expect((await post(start())).status).toBe(409);
    expect(state.parse).toHaveBeenCalledTimes(1);
  });
  it("실행 중 legacy 생성도 막고 durable 시작 후 재시작은 재전송하지 않는다", async () => {
    const input = start();
    state.store!.beginGuidedPreparation(company.id, input, "mock-model");
    state.store!.close();
    state.store = new StudioStore(directory);
    company = state.store.get(company.id);
    await accept(input);
    expect(state.parse).not.toHaveBeenCalled();
    expect((await post(start())).status).toBe(409);
    expect(
      (
        await legacyGenerate(
          request({ revision: company.revision, operation: "analyze", mode: "ai" }),
          context(),
        )
      ).status,
    ).toBe(409);
    expect(state.parse).not.toHaveBeenCalled();
  });
  it("동시 호출은 같은 요청의 저장 여부를 알려주고 실제 AI 전송은 한 번만 한다", async () => {
    let release!: (value: ReturnType<typeof answer>) => void;
    state.parse.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const input = start(),
      first = post(input);
    await vi.waitFor(() => expect(state.parse).toHaveBeenCalledTimes(1));
    const duplicate = await post(input);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ accepted: true, code: "GUIDED_BUSY" });
    const separate = await post({ ...input, clientRequestId: randomUUID() });
    expect(separate.status).toBe(409);
    expect(await separate.json()).toMatchObject({ accepted: false });
    company = state.store!.get(company.id);
    const whileActive = await post(restart(company.guidedPreparationRuns!.at(-1)!.id));
    expect(whileActive.status).toBe(409);
    expect(await whileActive.json()).toMatchObject({ accepted: false, code: "GUIDED_BUSY" });
    expect((await (await GET(new Request(url), context())).json()).active).toBe(true);
    release(answer(analysis()));
    expect((await first).status).toBe(200);
    expect(state.parse).toHaveBeenCalledTimes(1);
  });
  it("완료된 원고는 새 승인·새 nonce로 다시 작성하고 이전 원고와 연결 이력을 보존한다", async () => {
    company = state.store!.saveAnalysis(company.id, company.revision, analysis(), "ai");
    select();
    state.parse
      .mockResolvedValueOnce(answer(plan()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const first = await accept(start()),
      originalPlan = structuredClone(company.plans[0]);
    state.parse
      .mockResolvedValueOnce(answer(plan()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const input = restart(first.id),
      second = await accept(input);
    expect(second).toMatchObject({ retryOfId: first.id, status: "awaiting_review" });
    expect(company.plans).toHaveLength(2);
    expect(company.plans[0]).toEqual(originalPlan);
    expect(company.guidedPreparationRuns![0]).toEqual(first);
    await accept(input);
    expect(company.plans).toHaveLength(2);
    expect(state.parse).toHaveBeenCalledTimes(4);
    expect((await post(restart(first.id))).status).toBe(409);
  });
  it("실패 재실행도 명시 인지가 필요하며 같은 자료는 최초 포함 세 번까지만 허용한다", async () => {
    state.parse.mockRejectedValue(new Error("synthetic unavailable response"));
    let previous = await accept(start());
    expect(
      (await post({ ...restart(previous.id), acknowledgedPreviousAttempt: false })).status,
    ).toBe(400);
    expect((await post({ ...restart(previous.id), approved: false })).status).toBe(400);
    expect((await post(restart(randomUUID()))).status).toBe(409);
    previous = await accept(restart(previous.id));
    previous = await accept(restart(previous.id));
    const limited = await post(restart(previous.id));
    expect(limited.status).toBe(409);
    expect(await limited.json()).toMatchObject({ code: "GUIDED_RESTART_LIMIT", accepted: false });
    expect(state.parse).toHaveBeenCalledTimes(3);
    expect(company.guidedPreparationRuns).toHaveLength(3);
  });
  it("중단된 미확인 요청은 자료가 바뀌어도 새 승인으로만 이어가고 원래 기록을 보존한다", async () => {
    const oldInput = start();
    const initial = state.store!.beginGuidedPreparation(company.id, oldInput, "mock-model");
    company = initial.company;
    changeProfile();
    expect((await post(start())).status).toBe(409);
    const changedAnalysis = analysis();
    changedAnalysis.candidates[0] = {
      ...candidate,
      evidence: [
        { sourceId: "profile", quote: "바뀐 가상 기술 설명", locator: "technologySummary" },
      ],
    };
    state.parse.mockResolvedValueOnce(answer(changedAnalysis));
    const next = await accept(restart(initial.run.id));
    expect(next).toMatchObject({ retryOfId: initial.run.id, status: "awaiting_choice" });
    expect(company.guidedPreparationRuns![0]).toEqual(initial.run);
    expect(unresolvedGuidedPreparationRuns(company.guidedPreparationRuns)).toHaveLength(0);
    expect(() =>
      state.store!.commitGuidedPreparation(company.id, company.revision, initial.run.id, {
        phase: "analysis",
        content: analysis(),
      }),
    ).toThrow();
    expect(state.parse).toHaveBeenCalledTimes(1);
  });
  it("AI 미설정·공식 입력 잠금·외부 Origin·query를 전송 없이 거부한다", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await post(start())).status).toBe(503);
    vi.stubEnv("OPENAI_API_KEY", "synthetic");
    await withVentureInputCompanyLock(company.id, async () => {
      expect((await post(start())).status).toBe(409);
    });
    expect(
      (await POST(request(start(), { origin: "https://evil.example" }), context())).status,
    ).toBe(403);
    expect((await GET(new Request(`${url}?x=1`), context())).status).toBe(400);
    expect(state.parse).not.toHaveBeenCalled();
  });
});

const repairFinding: ReviewFinding = {
  id: "synthetic-semantic-finding",
  severity: "error",
  category: "fact-vs-plan",
  message: "원문은 센서 데이터 분석을 설명하지만 본문은 시험을 완료했다고 바꿨습니다.",
  action: "시험 완료 표현을 원문의 센서 데이터 분석 설명으로 수정하세요.",
  sectionKey: "solution",
  sourceIds: ["profile"],
};

function repairDrafts(): { initial: PlanContent; repaired: PlanContent } {
  const initial = plan();
  initial.sections.find((item) => item.key === "solution")!.content =
    "가상 센서 분석 시험을 완료했습니다. [확인 필요] 실제 시험 자료를 추가해야 합니다.";
  return { initial, repaired: plan() };
}

function prepareSelectedCompany() {
  company = state.store!.saveAnalysis(company.id, company.revision, analysis(), "ai");
  select();
}

describe("승인한 1회 자동 수정의 저장·복구 경계", () => {
  it("자동 수정 동의가 없던 과거 승인은 continue·replay에서도 범위를 넓히지 않는다", async () => {
    state.parse.mockResolvedValueOnce(answer(analysis()));
    const input = start();
    await accept(input);
    // Reproduce a durable record written by the earlier app, not a new reduced approval.
    delete input.approval.autoRevisionLimit;
    const legacy = structuredClone(company);
    const saved = legacy.guidedPreparationRuns![0];
    delete saved.approval.autoRevisionLimit;
    saved.requests[0].digest = guidedPreparationDigest(input);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    try {
      db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
        JSON.stringify(legacy),
        legacy.id,
      );
    } finally {
      db.close();
    }
    company = state.store!.get(company.id);
    const legacyApproval = structuredClone(company.guidedPreparationRuns![0].approval);
    const nonceReceipt = structuredClone(company.guidedPreparationRuns![0].requests[0]);
    const beforeCalls = state.parse.mock.calls.length;
    expect((await accept(input)).approval).toEqual(legacyApproval);
    expect(state.parse).toHaveBeenCalledTimes(beforeCalls);
    const preview = await (await GET(new Request(url), context())).json();
    expect(preview.approval.autoRevisionLimit).toBe(1);
    expect(preview.company.guidedPreparationRuns[0].approval).not.toHaveProperty(
      "autoRevisionLimit",
    );
    select();
    const { initial } = repairDrafts();
    state.parse
      .mockResolvedValueOnce(answer(initial))
      .mockResolvedValueOnce(answer({ findings: [repairFinding] }));
    const continuation = {
      action: "continue",
      revision: company.revision,
      clientRequestId: randomUUID(),
      runId: saved.id,
    };
    const result = await accept(continuation);
    expect(result).toMatchObject({ status: "awaiting_review", approval: legacyApproval });
    expect(result).not.toHaveProperty("repair");
    expect(result.requests[0]).toEqual(nonceReceipt);
    expect(company.plans).toHaveLength(1);
    expect(state.parse).toHaveBeenCalledTimes(3);
    await accept(continuation);
    await accept(input);
    expect(state.parse).toHaveBeenCalledTimes(3);
    expect(company.guidedPreparationRuns![0].approval).toEqual(legacyApproval);
    expect(company.guidedPreparationRuns![0].requests[0]).toEqual(nonceReceipt);
  });

  it("수정 전 초안과 1회 시도를 먼저 저장한 뒤 수정·재검토 결과를 별도 원고로 보존한다", async () => {
    prepareSelectedCompany();
    const { initial, repaired } = repairDrafts();
    let durableInitial: StudioCase["plans"][number] | undefined;
    state.parse
      .mockResolvedValueOnce(answer(initial))
      .mockResolvedValueOnce(answer({ findings: [repairFinding] }))
      .mockImplementationOnce(async () => {
        const checkpoint = state.store!.get(company.id);
        expect(checkpoint.plans).toHaveLength(1);
        durableInitial = structuredClone(checkpoint.plans[0]);
        const pending = checkpoint.guidedPreparationRuns!.at(-1)!;
        expect(pending).toMatchObject({
          status: "running",
          planId: durableInitial.id,
          repair: {
            initialPlanId: durableInitial.id,
            finalPlanId: null,
            status: "pending",
            attempted: true,
          },
        });
        expect(pending.repair!.attemptedAt).not.toBeNull();
        expect(durableInitial.confirmedAt).toBeNull();
        return answer(repaired);
      })
      .mockResolvedValueOnce(answer({ findings: [] }));
    const input = start();
    const result = await accept(input);
    expect(company.plans).toHaveLength(2);
    expect(company.plans[0]).toEqual(durableInitial);
    const final = company.plans[1];
    expect(result).toMatchObject({
      status: "awaiting_review",
      planId: final.id,
      repair: {
        initialPlanId: company.plans[0].id,
        finalPlanId: final.id,
        status: "applied",
        attempted: true,
      },
    });
    expect(final.content.sections.find((item) => item.key === "solution")!.content).toBe(
      repaired.sections.find((item) => item.key === "solution")!.content,
    );
    expect(result.repair!.completedAt).not.toBeNull();
    expect(result.repair!.initialReviewCount).toBeGreaterThan(result.repair!.finalReviewCount!);
    expect(company.plans.every((item) => item.confirmedAt === null)).toBe(true);
    expect(final.content.sections.every((item) => item.needsConfirmation)).toBe(true);
    expect(state.parse).toHaveBeenCalledTimes(4);
    const revision = company.revision;
    expect(await accept(input)).toEqual(result);
    expect(company.revision).toBe(revision);
    expect(company.plans).toHaveLength(2);
    expect(state.parse).toHaveBeenCalledTimes(4);
  });

  it("수정 요청의 네트워크 실패에서도 초안은 남기고 자동 재전송 없이 검토로 전환한다", async () => {
    prepareSelectedCompany();
    const { initial } = repairDrafts();
    state.parse
      .mockResolvedValueOnce(answer(initial))
      .mockResolvedValueOnce(answer({ findings: [repairFinding] }))
      .mockRejectedValueOnce(new Error("synthetic-private-repair-provider-body"));
    const input = start();
    const result = await accept(input);
    expect(company.plans).toHaveLength(1);
    expect(result).toMatchObject({
      status: "awaiting_review",
      planId: company.plans[0].id,
      repair: {
        status: "failed",
        attempted: true,
        initialPlanId: company.plans[0].id,
        finalPlanId: company.plans[0].id,
      },
    });
    expect(company.plans[0].confirmedAt).toBeNull();
    expect(company.plans[0].content.sections.find((item) => item.key === "solution")!.content).toBe(
      initial.sections.find((item) => item.key === "solution")!.content,
    );
    expect(JSON.stringify(company)).not.toContain("synthetic-private-repair-provider-body");
    expect(state.parse).toHaveBeenCalledTimes(3);
    await accept(input);
    expect(state.parse).toHaveBeenCalledTimes(3);
    expect(company.plans).toHaveLength(1);
  });

  it("초안을 저장한 뒤 회사 자료가 바뀌면 늦은 수정본과 재검토를 거부한다", async () => {
    prepareSelectedCompany();
    const { initial, repaired } = repairDrafts();
    let initialId = "";
    state.parse
      .mockResolvedValueOnce(answer(initial))
      .mockResolvedValueOnce(answer({ findings: [repairFinding] }))
      .mockImplementationOnce(async () => {
        company = state.store!.get(company.id);
        initialId = company.plans[0].id;
        expect(company.guidedPreparationRuns!.at(-1)!.repair?.attempted).toBe(true);
        changeProfile();
        return answer(repaired);
      });
    const input = start();
    const response = await post(input);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "GUIDED_INPUT_CHANGED", accepted: true });
    company = state.store!.get(company.id);
    expect(company.profile.technologySummary).toBe("바뀐 가상 기술 설명");
    expect(company.plans).toHaveLength(1);
    expect(company.plans[0]).toMatchObject({ id: initialId, confirmedAt: null });
    expect(company.guidedPreparationRuns!.at(-1)!.repair).toMatchObject({
      initialPlanId: initialId,
      finalPlanId: null,
      attempted: true,
    });
    expect(state.parse).toHaveBeenCalledTimes(3);
    await accept(input);
    expect(state.parse).toHaveBeenCalledTimes(3);
    expect(company.plans).toHaveLength(1);
  });

  it("저장소의 자동 수정 시작을 두 번 호출해도 두 번째 실행을 허용하지 않는다", () => {
    prepareSelectedCompany();
    const started = state.store!.beginGuidedPreparation(company.id, start(), "mock-model");
    company = started.company;
    const initial = plan();
    company = state.store!.checkpointGuidedPlan(
      company.id,
      company.revision,
      started.run.id,
      initial,
      reviewPlan(company, initial),
    );
    expect(company.guidedPreparationRuns!.at(-1)!.repair).toMatchObject({
      status: "pending",
      attempted: false,
    });
    company = state.store!.beginGuidedRepair(company.id, company.revision, started.run.id);
    const checkpoint = structuredClone(company);
    expect(() =>
      state.store!.beginGuidedRepair(company.id, company.revision, started.run.id),
    ).toThrow();
    expect(state.store!.get(company.id)).toEqual(checkpoint);
    expect(company.guidedPreparationRuns!.at(-1)!.repair).toMatchObject({
      status: "pending",
      attempted: true,
    });
    expect(company.plans).toHaveLength(1);
    expect(state.parse).not.toHaveBeenCalled();
  });
});
