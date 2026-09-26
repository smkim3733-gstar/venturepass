import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  type CaseMutation,
  type SourceDocument,
  type StudioCase,
  type WorkflowTask,
} from "./studio-schema";
import {
  diagnosisCriteriaVersion,
  emptyDiagnosisAnswers,
  MAX_DIAGNOSIS_TEXT,
  type Diagnosis,
  type DiagnosisAnswers,
} from "./studio-diagnosis-types";
import { diagnosisHistoryCharacters } from "./studio-diagnosis";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  aiConstructor: vi.fn(),
  aiParse: vi.fn(),
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
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: vi.fn() }));
import { PATCH, GET } from "@/app/api/studio/cases/[caseId]/route";

let directory: string;
let company: StudioCase;
const quote = "이 문서는 가상기업의 기본요건을 수동 검토하기 위한 시험 문장입니다.";
const mutate = (mutation: CaseMutation) =>
  (company = state.store!.mutate(company.id, mutation, () => []));
const context = (id = company.id) => ({ params: Promise.resolve({ caseId: id }) });
function request(body: unknown, headers: Record<string, string> = {}, query = "") {
  return new Request(`http://localhost:3000/api/studio/cases/fixture${query}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const patch = (body: unknown, id = company.id) => PATCH(request(body), context(id));
const diagnoseBody = (overrides: Record<string, unknown> = {}) => ({
  action: "diagnose",
  revision: company.revision,
  clientRequestId: randomUUID(),
  ...overrides,
});
async function diagnose() {
  const response = await patch(diagnoseBody());
  expect(response.status).toBe(200);
  company = await response.json();
  return company.diagnoses.at(-1)!;
}
function sourceInput(overrides: Partial<SourceDocument> = {}): SourceDocument {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: "가상 검토 자료",
    kind: "other",
    text: quote,
    originalName: "fixture.pdf",
    mimeType: "application/pdf",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function addSource(overrides: Partial<SourceDocument> = {}, id = company.id) {
  const source = sourceInput(overrides);
  const current = state.store!.get(id);
  const next =
    source.originalName !== null
      ? state.store!.addUpload(
          id,
          current.revision,
          source,
          Buffer.from("%PDF-1.7\nSYNTHETIC ORIGINAL"),
        )
      : state.store!.mutate(id, { action: "source", revision: current.revision, source }, () => []);
  if (id === company.id) company = next;
  return next.sources.find((item) => item.id === source.id)!;
}
function supportedAnswers(source: SourceDocument): DiagnosisAnswers {
  const assessment = () => ({
    status: "supported" as const,
    reviewed: true,
    note: "사용자가 시험 원문을 대조함",
    evidence: [
      { sourceId: source.id, sourceUpdatedAt: source.updatedAt, quote, locator: "본문 1문단" },
    ],
  });
  return {
    entityType: "corporate",
    criteriaVersion: diagnosisCriteriaVersion,
    sme: assessment(),
    industryEligibility: assessment(),
  };
}
const answersBody = (answers = emptyDiagnosisAnswers()) => ({
  action: "diagnosis-answers",
  revision: company.revision,
  answers,
});
function taskInput(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: randomUUID(),
    title: "시험 업무",
    category: "other",
    dueDate: "",
    status: "pending",
    notes: "",
    ...overrides,
  };
}
const taskBody = (diagnosis: Diagnosis, actionIds = [diagnosis.actions[0].id]) => ({
  action: "diagnosis-tasks",
  revision: company.revision,
  diagnosisId: diagnosis.id,
  actionIds,
});
function replaceBody(body: unknown, id = company.id) {
  const db = new DatabaseSync(join(directory, "studio.sqlite"));
  try {
    db.prepare("UPDATE studio_cases SET body = ? WHERE id = ?").run(JSON.stringify(body), id);
  } finally {
    db.close();
  }
}
const refresh = () => (company = state.store!.get(company.id));
function restart() {
  state.store!.close();
  state.store = new StudioStore(directory);
  refresh();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "venture-diagnosis-test-"));
  state.store = new StudioStore(directory);
  company = state.store.create({ ...emptyProfile(), companyName: "사전진단 가상기업" });
  state.aiConstructor.mockReset();
  state.aiParse.mockReset();
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  state.store!.close();
  const boundary = relative(resolve(tmpdir()), resolve(directory));
  if (!boundary.startsWith("venture-diagnosis-test-") || boundary.includes(".."))
    throw new Error("Unsafe synthetic cleanup");
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("사전진단 답변·버전·기업별 저장 — 임시 SQLite", () => {
  it.each(["same-ms", "clock-backward"])(
    "단조 자료버전: %s 수정에서 인용 문장이 남아 있어도 과거 요건검토를 unknown 처리한다",
    async (clock) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const originalTime = new Date("2026-09-25T01:00:00.000Z");
        vi.setSystemTime(originalTime);
        const source = addSource();
        company = await (await patch(answersBody(supportedAnswers(source)))).json();
        const before = await diagnose();
        const eligibility = (diagnosis: Diagnosis) =>
          diagnosis.items.filter((item) =>
            ["eligibility-sme", "eligibility-industryEligibility"].includes(item.id),
          );
        expect(eligibility(before).every((item) => item.status === "supported")).toBe(true);
        vi.setSystemTime(
          new Date(originalTime.getTime() - (clock === "clock-backward" ? 60_000 : 0)),
        );
        mutate({
          action: "source",
          revision: company.revision,
          source: { ...source, text: `${quote}\n나머지 본문의 중요한 조건을 수정했습니다.` },
        });
        expect(company.sources[0].text).toContain(quote);
        expect(company.sources[0].updatedAt).toBe(
          new Date(originalTime.getTime() + 1).toISOString(),
        );
        const current = await diagnose();
        expect(
          eligibility(current).every(
            (item) => item.status === "unknown" && item.evidence.length === 0,
          ),
        ).toBe(true);
        expect(company.diagnoses[0]).toEqual({ ...before, stale: true });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("legacy 기업에 기본 답변·빈 이력을 보완하고 재시작해도 원래 자료를 보존한다", async () => {
    const legacy = { ...company } as Record<string, unknown>;
    delete legacy.diagnosisAnswers;
    delete legacy.diagnoses;
    replaceBody(legacy);
    restart();
    expect(company.diagnosisAnswers).toEqual(emptyDiagnosisAnswers());
    expect(company.diagnoses).toEqual([]);
    expect(company.revision).toBe(0);
    const result = await diagnose();
    expect(result.version).toBe(1);
    restart();
    expect(company.diagnoses).toEqual([result]);
  });

  it("서버가 식별자·버전·기준·자료지문을 생성하며 AI나 기관 단계를 바꾸지 않는다", async () => {
    const before = structuredClone(company);
    const diagnosis = await diagnose();
    expect(diagnosis).toMatchObject({
      version: 1,
      mode: "assisted",
      sourceRevision: before.revision,
      criteriaVersion: diagnosisCriteriaVersion,
      stale: false,
    });
    expect(diagnosis.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(diagnosis.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnosis.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(diagnosis.generatedAt))).toBe(false);
    expect(company).toMatchObject({
      stage: before.stage,
      stageHistory: before.stageHistory,
      sources: before.sources,
      analysis: before.analysis,
      plans: before.plans,
    });
    expect(state.aiConstructor).not.toHaveBeenCalled();
    expect(state.aiParse).not.toHaveBeenCalled();
    const first = structuredClone(diagnosis);
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, technologySummary: "새 기술 설명" },
    });
    expect((await diagnose()).version).toBe(2);
    expect(company.diagnoses[0]).toEqual({ ...first, stale: true });
  });

  it("정확 인용·검토 확인·현행기준 답변을 저장하고 서버 근거에 출처를 남긴다", async () => {
    const source = addSource();
    const answers = supportedAnswers(source);
    const response = await patch(answersBody(answers));
    expect(response.status).toBe(200);
    company = await response.json();
    expect(company.diagnosisAnswers).toEqual(answers);
    const diagnosis = await diagnose();
    expect(diagnosis.items.flatMap((item) => item.evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: source.id,
          sourceName: source.name,
          quote,
          locator: "본문 1문단",
        }),
      ]),
    );
    restart();
    expect(company.diagnosisAnswers).toEqual(answers);
    expect(company.diagnoses[0].stale).toBe(false);
  });

  it.each(["foreign", "missing", "changed-quote", "pending"])(
    "%s 근거는 답변 저장을 거부하고 기존 상태를 보존한다",
    async (kind) => {
      const other = state.store!.create({ ...emptyProfile(), companyName: "다른 가상기업" });
      const source =
        kind === "pending"
          ? addSource({
              text: "",
              extraction: "pending",
              originalName: "pending.pdf",
              mimeType: "application/pdf",
              warnings: [...originalOnlyWarnings],
            })
          : addSource({}, kind === "foreign" ? other.id : company.id);
      const answers = supportedAnswers(source);
      if (kind === "missing") answers.sme.evidence[0].sourceId = randomUUID();
      if (kind === "changed-quote") answers.sme.evidence[0].quote = "현재 원문에 없는 임의 주장";
      const before = refresh();
      const response = await patch(answersBody(answers));
      expect([400, 409, 404, 422]).toContain(response.status);
      expect(state.store!.get(company.id)).toEqual(before);
    },
  );

  it("자료를 편집한 뒤 예전 인용을 현재 확인 사실로 다시 저장하지 못한다", async () => {
    const source = addSource();
    const answers = supportedAnswers(source);
    mutate({
      action: "source",
      revision: company.revision,
      source: { ...source, text: "수정된 다른 원문입니다." },
    });
    const before = structuredClone(company);
    const response = await patch(answersBody(answers));
    expect([400, 409, 422]).toContain(response.status);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("구 기준 답변을 현행 기준 확인으로 자동 승격하지 않는다", async () => {
    const source = addSource();
    const answers = supportedAnswers(source);
    answers.criteriaVersion = "old-criteria";
    const response = await patch(answersBody(answers));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("DIAGNOSIS_EVIDENCE_INVALID");
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it("근거 삭제 후 새 진단은 예전 기본요건 충족을 재사용하지 않는다", async () => {
    const source = addSource();
    const response = await patch(answersBody(supportedAnswers(source)));
    company = await response.json();
    const original = await diagnose();
    expect(
      original.items
        .filter(
          (item) => item.id === "eligibility-sme" || item.id === "eligibility-industryEligibility",
        )
        .every((item) => item.status === "supported"),
    ).toBe(true);
    mutate({ action: "delete-source", revision: company.revision, sourceId: source.id });
    const latest = await diagnose();
    expect(
      latest.items
        .filter(
          (item) => item.id === "eligibility-sme" || item.id === "eligibility-industryEligibility",
        )
        .every((item) => item.status === "unknown" && item.evidence.length === 0),
    ).toBe(true);
    expect(company.diagnoses[0]).toEqual({ ...original, stale: true });
  });

  it("기술 설명만 수정하면 기본요건 답변은 보존하되 이전 진단은 stale로 표시한다", async () => {
    const source = addSource();
    const answers = supportedAnswers(source);
    company = await (await patch(answersBody(answers))).json();
    const diagnosis = await diagnose();
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, technologySummary: "변경된 기술 설명" },
    });
    expect(company.diagnosisAnswers).toEqual(answers);
    expect(company.diagnoses[0]).toEqual({ ...diagnosis, stale: true });
  });

  it.each(["answers", "source", "profile", "delete-source"])(
    "%s 변경은 과거 진단을 stale로 만들고 결과 본문은 보존한다",
    async (change) => {
      const source = addSource();
      const initial = await diagnose();
      if (change === "answers")
        mutate({
          action: "diagnosis-answers",
          revision: company.revision,
          answers: { ...emptyDiagnosisAnswers(), entityType: "corporate" },
        });
      if (change === "source")
        mutate({
          action: "source",
          revision: company.revision,
          source: { ...source, text: "다른 가상 원문" },
        });
      if (change === "profile")
        mutate({
          action: "profile",
          revision: company.revision,
          profile: { ...company.profile, technologySummary: "새 사업 설명" },
        });
      if (change === "delete-source")
        mutate({ action: "delete-source", revision: company.revision, sourceId: source.id });
      expect(company.diagnoses[0]).toEqual({ ...initial, stale: true });
      restart();
      expect(company.diagnoses[0].stale).toBe(true);
    },
  );

  it.each(["task", "stage", "analysis"])(
    "%s 운영 변경은 입력자료 진단을 stale로 만들지 않는다",
    async (change) => {
      const initial = await diagnose();
      if (change === "task")
        mutate({ action: "task", revision: company.revision, task: taskInput() });
      if (change === "stage")
        mutate({
          action: "stage",
          revision: company.revision,
          stage: "payment",
          occurredOn: "",
          note: "담당자 수동 기록",
        });
      if (change === "analysis")
        company = state.store!.saveAnalysis(
          company.id,
          company.revision,
          { summary: "별도 자료 정리", facts: [], candidates: [], questions: [], warnings: [] },
          "assisted",
        );
      expect(company.diagnoses[0]).toEqual(initial);
    },
  );

  it("예전 기준으로 저장된 진단은 재조회 시 stale 처리한다", async () => {
    await diagnose();
    const old = structuredClone(company);
    old.diagnoses[0].criteriaVersion = "previous-criteria";
    old.diagnoses[0].stale = false;
    replaceBody(old);
    restart();
    expect(company.diagnoses[0].stale).toBe(true);
    expect(company.diagnoses[0].criteriaVersion).toBe("previous-criteria");
  });

  it.each([
    "companyName",
    "businessNumber",
    "industry",
    "applicationDate",
    "applicationKind",
  ] as const)(
    "핵심 기업정보 %s 변경은 기본요건 답변을 미확인으로 되돌리고 근거 메모를 보존한다",
    async (key) => {
      const source = addSource();
      const answers = supportedAnswers(source);
      const saved = await patch(answersBody(answers));
      expect(saved.status).toBe(200);
      company = await saved.json();
      const diagnosis = await diagnose();
      const values = {
        companyName: "다른 기업명",
        businessNumber: "1111111111",
        industry: "수정 업종",
        applicationDate: "2026-10-01",
        applicationKind: "renewal",
      } as const;
      mutate({
        action: "profile",
        revision: company.revision,
        profile: { ...company.profile, [key]: values[key] },
      });
      for (const field of ["sme", "industryEligibility"] as const)
        expect(company.diagnosisAnswers[field]).toEqual({
          ...answers[field],
          status: "unknown",
          reviewed: false,
        });
      expect(company.diagnoses[0]).toEqual({ ...diagnosis, stale: true });
    },
  );

  it("원문은 같아도 자료 버전이 다른 답변 인용은 거부한다", async () => {
    const source = addSource();
    const answers = supportedAnswers(source);
    answers.sme.evidence[0].sourceUpdatedAt = "2000-01-01T00:00:00.000Z";
    const response = await patch(answersBody(answers));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("DIAGNOSIS_EVIDENCE_INVALID");
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it.each(["typed", "consultation"])(
    "%s 진술은 등록 원문이어도 기본요건 문서 확인으로 승격하지 않는다",
    async (kind) => {
      const source = addSource(
        kind === "typed"
          ? { originalName: null, mimeType: null, extraction: "manual" }
          : { kind: "consultation" },
      );
      const response = await patch(answersBody(supportedAnswers(source)));
      expect(response.status).toBe(422);
      expect((await response.json()).code).toBe("DIAGNOSIS_EVIDENCE_INVALID");
    },
  );

  it("같은 nonce·동일 요청은 응답 유실/재시작/자료 변경 뒤에도 진단을 추가하지 않는다", async () => {
    const body = diagnoseBody();
    const initial = await patch(body);
    expect(initial.status).toBe(200);
    company = await initial.json();
    const saved = structuredClone(company.diagnoses[0]);
    restart();
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, customers: "새 고객 설명" },
    });
    const before = structuredClone(company);
    const replay = await patch(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(before);
    expect(state.store!.get(company.id).diagnoses).toEqual([{ ...saved, stale: true }]);
  });

  it.each(["none", "task", "stage", "analysis", "restart"])(
    "%s 뒤 같은 입력의 새 nonce는 이력·시각·자료버전을 바꾸지 않고 현재 결과를 재사용한다",
    async (change) => {
      const diagnosis = await diagnose();
      if (change === "task")
        mutate({ action: "task", revision: company.revision, task: taskInput() });
      if (change === "stage")
        mutate({
          action: "stage",
          revision: company.revision,
          stage: "payment",
          note: "가상 운영 기록",
          occurredOn: "",
        });
      if (change === "analysis")
        company = state.store!.saveAnalysis(
          company.id,
          company.revision,
          { summary: "운영 자료 정리", facts: [], candidates: [], questions: [], warnings: [] },
          "assisted",
        );
      if (change === "restart") restart();
      const before = structuredClone(company);
      const body = diagnoseBody();
      const response = await patch(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(before);
      expect(state.store!.get(company.id)).toEqual(before);
      expect(before.diagnoses).toEqual([diagnosis]);
      expect((await patch({ ...body, revision: company.revision - 1 })).status).toBe(409);
    },
  );

  it("같은 nonce에 다른 revision 요청은 충돌하고 새로운 nonce의 낡은 CAS도 거부한다", async () => {
    const body = diagnoseBody();
    const first = await patch(body);
    company = await first.json();
    const before = structuredClone(company);
    const collision = await patch({ ...body, revision: company.revision });
    expect(collision.status).toBe(409);
    expect((await collision.json()).code).toBe("DIAGNOSIS_REPLAY_CONFLICT");
    const stale = await patch({ ...body, clientRequestId: randomUUID() });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("STALE_REVISION");
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("별도 Store의 동시 스냅샷 CAS는 첫 결과를 덮지 않는다", async () => {
    const second = new StudioStore(directory);
    try {
      const stale = second.get(company.id);
      await diagnose();
      expect(() =>
        second.mutate(
          company.id,
          { action: "diagnose", revision: stale.revision, clientRequestId: randomUUID() },
          () => [],
        ),
      ).toThrow(expect.objectContaining({ code: "STALE_REVISION" }));
      expect(second.get(company.id)).toEqual(company);
    } finally {
      second.close();
    }
  });

  it("기업별 nonce·이력은 다른 기업과 공유하지 않는다", async () => {
    const other = state.store!.create({ ...emptyProfile(), companyName: "다른 가상기업" });
    const body = diagnoseBody();
    const left = await patch(body);
    company = await left.json();
    const right = await patch({ ...body, revision: other.revision }, other.id);
    expect(right.status).toBe(200);
    const otherSaved = await right.json();
    expect(otherSaved.diagnoses[0].id).not.toBe(company.diagnoses[0].id);
    expect(state.store!.get(company.id)).toEqual(company);
  });
});

describe("진단 과제 연결·이력 한도", () => {
  it("최신 진단 과제를 서버 본문으로 연결하고 재요청해도 중복 생성하지 않는다", async () => {
    const diagnosis = await diagnose();
    expect(diagnosis.actions.length).toBeGreaterThan(0);
    const first = await patch(taskBody(diagnosis));
    expect(first.status).toBe(200);
    company = await first.json();
    const linked = structuredClone(company.tasks);
    expect(linked[0]).toMatchObject({
      title: diagnosis.actions[0].title,
      notes: diagnosis.actions[0].notes,
      category: "evidence",
      status: "pending",
      diagnosisOrigin: { diagnosisId: diagnosis.id, actionId: diagnosis.actions[0].id },
    });
    const again = await patch(taskBody(diagnosis));
    expect(again.status).toBe(200);
    company = await again.json();
    expect(company.tasks).toEqual(linked);
    expect(company.diagnoses[0].stale).toBe(false);
    restart();
    expect(company.tasks).toEqual(linked);
  });

  it.each(["old", "foreign", "missing", "stale", "unknown-action", "duplicate-action"])(
    "%s 진단·과제 연결은 전체 변경을 거부한다",
    async (kind) => {
      let diagnosis = await diagnose();
      if (kind === "old") {
        mutate({
          action: "profile",
          revision: company.revision,
          profile: { ...company.profile, technologySummary: "새 기술 설명" },
        });
        await diagnose();
      }
      if (kind === "foreign") {
        const other = state.store!.create({ ...emptyProfile(), companyName: "별도기업" });
        diagnosis = state.store!.mutate(
          other.id,
          { action: "diagnose", revision: other.revision, clientRequestId: randomUUID() },
          () => [],
        ).diagnoses[0];
      }
      if (kind === "stale")
        mutate({
          action: "profile",
          revision: company.revision,
          profile: { ...company.profile, industry: "새 업종" },
        });
      const body = taskBody(diagnosis);
      if (kind === "missing") body.diagnosisId = randomUUID();
      if (kind === "unknown-action") body.actionIds = ["forged-action"];
      if (kind === "duplicate-action") body.actionIds = [body.actionIds[0], body.actionIds[0]];
      const before = structuredClone(company);
      const response = await patch(body);
      expect([400, 409, 422]).toContain(response.status);
      expect(state.store!.get(company.id)).toEqual(before);
    },
  );

  it("일반 업무 저장으로 진단 출처를 위조하거나 기존 출처를 갈아끼울 수 없다", async () => {
    const diagnosis = await diagnose();
    const forged = { diagnosisId: diagnosis.id, actionId: diagnosis.actions[0].id };
    mutate({
      action: "task",
      revision: company.revision,
      task: taskInput({ diagnosisOrigin: forged }),
    });
    expect(company.tasks[0].diagnosisOrigin).toBeUndefined();
    const linkedResponse = await patch(taskBody(diagnosis));
    company = await linkedResponse.json();
    const linked = company.tasks.find((task) => task.diagnosisOrigin)!;
    mutate({
      action: "task",
      revision: company.revision,
      task: {
        ...linked,
        title: "수정 업무",
        diagnosisOrigin: { diagnosisId: randomUUID(), actionId: "forged" },
      },
    });
    expect(company.tasks.find((task) => task.id === linked.id)?.diagnosisOrigin).toEqual(forged);
  });

  it("업무 200개 한도에서는 기존 업무·진단을 보존하고 새 연결을 거부한다", async () => {
    const diagnosis = await diagnose();
    const full = structuredClone(company);
    full.tasks = Array.from({ length: 200 }, () => taskInput());
    replaceBody(full);
    refresh();
    const before = structuredClone(company);
    const response = await patch(taskBody(diagnosis));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("TASK_LIMIT");
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("진단 50개 한도에서는 이력을 삭제·축약하지 않고 신규 버전을 거부한다", async () => {
    const initial = await diagnose();
    const minimal = {
      ...initial,
      items: [
        {
          id: "item",
          title: "검토",
          area: "eligibility" as const,
          status: "unknown" as const,
          reason: "",
          evidence: [],
          unknowns: [],
          nextActions: [],
        },
      ],
      questions: [],
      actions: [],
      warnings: [],
    };
    const full = structuredClone(company);
    full.diagnoses = Array.from({ length: 50 }, (_, index) => ({
      ...minimal,
      id: randomUUID(),
      clientRequestId: randomUUID(),
      version: index + 1,
    }));
    replaceBody(full);
    refresh();
    const reused = await patch(diagnoseBody());
    expect(reused.status).toBe(200);
    expect(await reused.json()).toEqual(company);
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, technologySummary: "새 진단이 필요한 입력" },
    });
    const before = structuredClone(company);
    const response = await patch(diagnoseBody());
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("DIAGNOSIS_LIMIT");
    expect(state.store!.get(company.id)).toEqual(before);
    restart();
    expect(company.diagnoses).toHaveLength(50);
  });

  it("20만 자 이력 한도 초과는 트랜잭션을 rollback하고 과거 원문을 보존한다", async () => {
    const initial = await diagnose();
    const large: Diagnosis = {
      ...initial,
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `i${index}`,
        title: "검토",
        area: "eligibility",
        status: "unknown",
        reason: "x".repeat(3000),
        evidence: [],
        unknowns: [],
        nextActions: [],
      })),
      warnings: Array.from({ length: 30 }, () => "x".repeat(2000)),
      questions: Array.from({ length: 5 }, (_, index) => ({
        id: `q${index}`,
        itemId: "i0",
        question: "x".repeat(2000),
        reason: "x".repeat(2000),
      })),
      actions: [],
    };
    const excess = diagnosisHistoryCharacters([large]) - (MAX_DIAGNOSIS_TEXT - 1);
    expect(excess).toBeGreaterThanOrEqual(0);
    expect(excess).toBeLessThan(2000);
    large.questions[0].reason = large.questions[0].reason.slice(excess);
    const full = structuredClone(company);
    full.diagnoses = [large];
    replaceBody(full);
    refresh();
    const reused = await patch(diagnoseBody());
    expect(reused.status).toBe(200);
    expect(await reused.json()).toEqual(company);
    mutate({
      action: "profile",
      revision: company.revision,
      profile: { ...company.profile, technologySummary: "새 진단이 필요한 입력" },
    });
    const before = structuredClone(company);
    const response = await patch(diagnoseBody());
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("DIAGNOSIS_TEXT_LIMIT");
    expect(state.store!.get(company.id)).toEqual(before);
  });
});

describe("진단 API 경계", () => {
  it("API 외 직접 저장 호출도 서버 진단 결과 주입을 거부한다", () => {
    const before = structuredClone(company);
    expect(() =>
      state.store!.mutate(
        company.id,
        { ...diagnoseBody(), outcome: "draft_recommended" } as unknown as CaseMutation,
        () => [],
      ),
    ).toThrow();
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it("제한보다 큰 JSON 본문은 기록을 변경하지 않고 거부한다", async () => {
    const response = await patch(diagnoseBody({ extra: "x".repeat(2 * 1024 * 1024) }));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("TOO_LARGE");
    expect(state.store!.get(company.id)).toEqual(company);
  });
  it.each(["diagnose", "diagnosis-answers", "diagnosis-tasks"])(
    "%s는 공식 입력 잠금 중 변경하지 않는다",
    async (action) => {
      const diagnosis = await diagnose();
      const body =
        action === "diagnose"
          ? diagnoseBody()
          : action === "diagnosis-answers"
            ? answersBody()
            : taskBody(diagnosis);
      const before = structuredClone(company);
      await withVentureInputCompanyLock(company.id, async () => {
        const response = await patch(body);
        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe("INPUT_IN_PROGRESS");
      });
      expect(state.store!.get(company.id)).toEqual(before);
    },
  );

  it.each([
    "id",
    "generatedAt",
    "outcome",
    "items",
    "criteriaVersion",
    "inputFingerprint",
    "version",
    "stale",
  ])("diagnose의 서버 필드 %s 주입은 거부한다", async (key) => {
    const before = structuredClone(company);
    const response = await patch(diagnoseBody({ [key]: key === "items" ? [] : "forged" }));
    expect(response.status).toBe(400);
    expect(state.store!.get(company.id)).toEqual(before);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", null])(
    "유효하지 않은 revision %s는 거부한다",
    async (revision) => {
      expect((await patch(diagnoseBody({ revision }))).status).toBe(400);
      expect(state.store!.get(company.id)).toEqual(company);
    },
  );

  it.each(["unreviewed", "no-evidence", "unknown-key", "nested-key", "long-note"])(
    "잘못된 답변 %s는 엄격히 거부한다",
    async (kind) => {
      const source = addSource();
      const answers = supportedAnswers(source);
      if (kind === "unreviewed") answers.sme.reviewed = false;
      if (kind === "no-evidence") answers.sme.evidence = [];
      if (kind === "long-note") answers.sme.note = "x".repeat(2001);
      if (kind === "unknown-key") Object.assign(answers, { outcome: "draft_recommended" });
      if (kind === "nested-key") Object.assign(answers.sme, { approved: true });
      const before = structuredClone(company);
      expect((await patch(answersBody(answers))).status).toBe(400);
      expect(state.store!.get(company.id)).toEqual(before);
    },
  );

  it.each(["diagnose", "diagnosis-answers", "diagnosis-tasks"])(
    "%s는 URL 매개변수로 다른 경로를 지시할 수 없다",
    async (action) => {
      const diagnosis = await diagnose();
      const body =
        action === "diagnose"
          ? diagnoseBody()
          : action === "diagnosis-answers"
            ? answersBody()
            : taskBody(diagnosis);
      const response = await PATCH(request(body, {}, "?path=outside"), context());
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("INVALID_QUERY");
    },
  );

  it.each([
    { origin: "https://outside.test" },
    { "sec-fetch-site": "cross-site" },
    { host: "outside.test" },
  ] as Record<string, string>[])("외부 요청 %j는 로컬 기록을 변경하지 않는다", async (headers) => {
    expect((await PATCH(request(diagnoseBody(), headers), context())).status).toBe(403);
    expect(state.store!.get(company.id)).toEqual(company);
  });

  it("조회 API는 저장된 회사 이력만 반환하고 캐시하지 않는다", async () => {
    await diagnose();
    const response = await GET(
      new Request("http://localhost:3000/api/studio/cases/fixture"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(company);
  });
});
