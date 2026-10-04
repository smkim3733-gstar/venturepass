import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  sectionDefinitions,
  type AnalysisContent,
  type Candidate,
  type StudioCase,
} from "./studio-schema";
import {
  guidedPreparationApproval,
  guidedPreparationInputCompany,
  guidedSelectedPreparationApproval,
} from "./studio-guided-preparation-state";
import {
  guidedPreparationApprovalSchema,
  type GuidedPreparationRun,
} from "./studio-guided-preparation-types";
import { reviewPlan } from "./studio-engine";
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
import { POST as previewPOST } from "@/app/api/studio/cases/[caseId]/guided-preparation/preview/route";
import { serializeStudioAiInput } from "./studio-ai-input";
import { sourceSchema } from "./studio-schema";

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
  approval: guidedSelectedPreparationApproval(company, "mock-model", [company.sources[0].id]),
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
  directory = mkdtempSync(join(tmpdir(), "venture-guided-selection-"));
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
  if (!boundary.startsWith("venture-guided-selection-") || boundary.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

function source(text = "SELECTED-BODY", name = "selected.pdf") {
  const now = new Date().toISOString();
  return sourceSchema.parse({
    id: randomUUID(),
    name,
    kind: "technology",
    text,
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
}
function addSources() {
  for (const entry of [source(), source("EXCLUDED-BODY", "EXCLUDED-NAME.docx")])
    company = state.store!.mutate(
      company.id,
      { action: "source", revision: company.revision, source: entry },
      reviewPlan,
    );
}
function scopedAnalysis() {
  const value = analysis();
  value.candidates = [
    {
      ...candidate,
      evidence: [{ sourceId: company.sources[0].id, quote: "SELECTED-BODY", locator: "본문" }],
    },
  ];
  return value;
}
function scopedPlan() {
  const value = plan();
  value.sections = value.sections.map((item) => ({
    ...item,
    evidence: scopedAnalysis().candidates[0].evidence,
  }));
  return value;
}
const continuation = (runId: string) => ({
  action: "continue" as const,
  revision: company.revision,
  clientRequestId: randomUUID(),
  runId,
});
async function preview(body: unknown, headers: Record<string, string> = {}) {
  return previewPOST(request(body, headers), context());
}
function storedBytes() {
  const db = new DatabaseSync(join(directory, "studio.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT body FROM studio_cases WHERE id=?").get(company.id)!.body;
  } finally {
    db.close();
  }
}
function assertRequestsScoped(expectedCount: number) {
  expect(state.parse).toHaveBeenCalledTimes(expectedCount);
  for (const [options] of state.parse.mock.calls) {
    const bytes = JSON.stringify(options.input);
    expect(bytes).toContain("SELECTED-BODY");
    for (const forbidden of ["EXCLUDED-BODY", "EXCLUDED-NAME", "PRIVATE-FIELD"])
      expect(bytes).not.toContain(forbidden);
    expect(options.store).toBe(false);
  }
  expect(state.constructor.mock.calls.every(([options]) => options.maxRetries === 0)).toBe(true);
}

describe("선택 근거의 서버 승인과 실제 입력 결합", () => {
  it("키 없이 미리보기만 만들고 순서를 원래 자료 순으로 고정한다", async () => {
    addSources();
    vi.stubEnv("OPENAI_API_KEY", "");
    const before = JSON.stringify(state.store!.get(company.id));
    const response = await preview({
      revision: company.revision,
      sourceIds: company.sources.map((s) => s.id).reverse(),
    });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({
      aiConfigured: false,
      transmissionAllowed: false,
      inputCharacterLimit: 240000,
      overInputLimit: false,
    });
    expect(view.approval.sourceIds).toEqual(company.sources.map((s) => s.id));
    expect(view.inputCharacters).toBe(serializeStudioAiInput(company).length);
    expect(JSON.stringify(state.store!.get(company.id))).toBe(before);
    expect(state.parse).not.toHaveBeenCalled();
    view.company.sources[0].text = "caller mutation";
    view.approval.sourceIds.reverse();
    expect(JSON.stringify(state.store!.get(company.id))).toBe(before);
  });
  it("잘못된 선택·추가 입력·기한 아닌 revision·Origin·query·본문 크기는 쓰기 전에 거절한다", async () => {
    addSources();
    const ids = company.sources.map((s) => s.id),
      revision = company.revision;
    for (const bad of [
      { revision, sourceIds: [ids[0], ids[0]] },
      { revision, sourceIds: [randomUUID()] },
      { revision: revision - 1, sourceIds: ids },
      { revision, sourceIds: ids, text: "injection" },
      { revision, sourceIds: Array.from({ length: 101 }, () => randomUUID()) },
    ])
      expect((await preview(bad)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await preview({ revision, sourceIds: ids }, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(
      (await preview({ revision, sourceIds: ids }, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(
      (
        await previewPOST(
          new Request(`${url}?x=1`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          context(),
        )
      ).status,
    ).toBe(400);
    expect((await preview({ revision, sourceIds: ids, filler: "a".repeat(9000) })).status).toBe(
      413,
    );
    expect(state.store!.get(company.id).revision).toBe(revision);
    expect(state.parse).not.toHaveBeenCalled();
  });
  it("0개 선택은 회사 설명만 분석하며 근거 없는 확인 완료를 만들지 않는다", async () => {
    addSources();
    const input = start();
    input.approval = guidedSelectedPreparationApproval(company, "mock-model", []);
    state.parse.mockResolvedValueOnce(answer(analysis(0)));
    const run = await accept(input);
    expect(run).toMatchObject({
      status: "awaiting_materials",
      approval: { sourceIds: [], sourceNames: [], sourceScope: "selected-sources-v1" },
    });
    expect(JSON.stringify(state.parse.mock.calls[0][0].input)).not.toContain("SELECTED-BODY");
    expect(JSON.stringify(state.parse.mock.calls[0][0].input)).not.toContain("EXCLUDED-BODY");
    expect(company.plans).toHaveLength(0);
    expect(company.sources).toHaveLength(2);
  });
  it("미판독 원본은 선택할 수 없고 기존 미판독 개수만 입력한다", () => {
    addSources();
    const pending = { ...source("", "UNREAD-PRIVATE.pdf"), extraction: "pending" as const };
    const fixture = { ...company, sources: [...company.sources, pending] };
    expect(() => guidedSelectedPreparationApproval(fixture, "mock-model", [pending.id])).toThrow();
    const approval = guidedSelectedPreparationApproval(fixture, "mock-model", [
      company.sources[0].id,
    ]);
    const input = guidedPreparationInputCompany(fixture, approval),
      json = serializeStudioAiInput(input);
    expect(JSON.parse(json).unextractedSourceCount).toBe(1);
    expect(json).not.toContain("UNREAD-PRIVATE");
    expect(json).not.toContain("EXCLUDED-BODY");
    input.sources[0].text = "changed copy";
    expect(fixture.sources[0].text).toBe("SELECTED-BODY");
  });
  it("100개 신원과 정확한 부분집합은 유지하고 긴 입력도 조용히 자르지 않는다", async () => {
    const fixture = {
      ...company,
      sources: Array.from({ length: 100 }, (_, i) => source('"'.repeat(2500), `합성${i}.pdf`)),
    };
    const all = guidedSelectedPreparationApproval(
      fixture,
      "mock-model",
      fixture.sources.map((s) => s.id),
    );
    expect(all.sourceIds).toHaveLength(100);
    expect(
      serializeStudioAiInput(guidedPreparationInputCompany(fixture, all)).length,
    ).toBeGreaterThan(240000);
    const subset = guidedSelectedPreparationApproval(fixture, "mock-model", [
      fixture.sources[99].id,
    ]);
    const decoded = JSON.parse(
      serializeStudioAiInput(guidedPreparationInputCompany(fixture, subset)),
    );
    expect(decoded.sources).toHaveLength(1);
    expect(decoded.sources[0].text).toBe(fixture.sources[99].text);
    addSources();
    for (const item of company.sources)
      company = state.store!.mutate(
        company.id,
        {
          action: "source",
          revision: company.revision,
          source: { ...item, text: '"'.repeat(62000) },
        },
        reviewPlan,
      );
    const input = start();
    input.approval = guidedSelectedPreparationApproval(
      company,
      "mock-model",
      company.sources.map((s) => s.id),
    );
    const view = await (
      await preview({ revision: company.revision, sourceIds: input.approval.sourceIds })
    ).json();
    expect(view.overInputLimit).toBe(true);
    expect((await accept(input)).status).toBe("failed");
    expect(state.parse).not.toHaveBeenCalled();
    expect(company.sources.every((s) => s.text.length === 62000)).toBe(true);
  });
  it("선택 분석→명시 주제→초안·검토 모두 정확한 부분집합을 쓰며 원본 자료를 보존한다", async () => {
    addSources();
    const sources = JSON.stringify(company.sources),
      input = start();
    state.parse.mockResolvedValueOnce(answer(scopedAnalysis()));
    const run = await accept(input);
    select();
    state.parse
      .mockResolvedValueOnce(answer(scopedPlan()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const next = continuation(run.id),
      done = await accept(next);
    expect(done.status).toBe("awaiting_review");
    expect(done.approval).toEqual(input.approval);
    expect(company.plans[0].confirmedAt).toBeNull();
    expect(JSON.stringify(company.sources)).toBe(sources);
    const before = JSON.stringify(company);
    await accept(input);
    await accept(next);
    expect(JSON.stringify(company)).toBe(before);
    assertRequestsScoped(3);
  });
  it("1회 수정과 재검토에도 제외 자료가 섞이지 않고 수정 전 원고를 보존한다", async () => {
    addSources();
    state.parse.mockResolvedValueOnce(answer(scopedAnalysis()));
    const run = await accept(start());
    select();
    const initial = scopedPlan();
    initial.sections.find((s) => s.key === "solution")!.content =
      "시험을 완료했습니다. [확인 필요]";
    const finding = {
      id: "synthetic-finding",
      severity: "error",
      category: "fact-vs-plan",
      message: "원문은 검토 자료이지만 본문은 시험 완료로 바뀌었습니다.",
      action: "시험 완료 표현을 원문에 맞춰 수정하세요.",
      sectionKey: "solution",
      sourceIds: [company.sources[0].id],
    };
    let initialCheckpoint: StudioCase["plans"][number] | undefined;
    state.parse
      .mockResolvedValueOnce(answer(initial))
      .mockResolvedValueOnce(answer({ findings: [finding] }))
      .mockImplementationOnce(async () => {
        initialCheckpoint = state.store!.get(company.id).plans[0];
        return answer(scopedPlan());
      })
      .mockResolvedValueOnce(answer({ findings: [] }));
    const done = await accept(continuation(run.id));
    expect(done.repair).toMatchObject({ attempted: true, status: "applied" });
    expect(company.plans).toHaveLength(2);
    expect(company.plans[0]).toEqual(initialCheckpoint);
    expect(company.plans[0].content.sections).toEqual(initial.sections);
    expect(company.plans.every((p) => p.confirmedAt === null)).toBe(true);
    assertRequestsScoped(5);
  });
  it("과거 전체 범위 분석·완료 원고·승인 bytes를 보존하며 새 선택에는 다시 분석한다", async () => {
    addSources();
    const oldStart = { ...start(), approval: guidedPreparationApproval(company, "mock-model") };
    state.parse.mockResolvedValueOnce(answer(analysis()));
    const old = await accept(oldStart);
    select();
    state.parse
      .mockResolvedValueOnce(answer(plan()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    await accept(continuation(old.id));
    const oldBytes = JSON.stringify(company.guidedPreparationRuns![0]),
      oldPlans = JSON.stringify(company.plans);
    expect(company.guidedPreparationRuns![0].approval).not.toHaveProperty("sourceScope");
    state.parse.mockResolvedValueOnce(answer(scopedAnalysis()));
    const fresh = await accept(start());
    expect(fresh.phase).toBe("analysis");
    expect(fresh.status).toBe("awaiting_choice");
    expect(JSON.stringify(company.guidedPreparationRuns![0])).toBe(oldBytes);
    expect(JSON.stringify(company.plans)).toBe(oldPlans);
    expect(state.parse).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(guidedPreparationApprovalSchema.parse(oldStart.approval))).toBe(
      JSON.stringify(oldStart.approval),
    );
    const defaultView = await (await GET(new Request(url), context())).json();
    expect(defaultView.approval).not.toHaveProperty("sourceScope");
    expect(defaultView.company.guidedPreparationRuns.at(-1).approval).toEqual(fresh.approval);
  });
  it("이름·순서·범위·모델·revision 바꿔치기와 새 필드는 실행 전에 거절한다", async () => {
    addSources();
    const input = start();
    const badApprovals = [
      { ...input.approval, sourceNames: ["changed"] },
      { ...input.approval, sourceIds: [company.sources[1].id] },
      { ...input.approval, sourceScope: undefined },
      { ...input.approval, model: "wrong" },
      { ...input.approval, revision: 0 },
      { ...input.approval, text: "injection" },
    ];
    const all = guidedSelectedPreparationApproval(
      company,
      "mock-model",
      company.sources.map((s) => s.id),
    );
    badApprovals.push({
      ...all,
      sourceIds: [...all.sourceIds].reverse(),
      sourceNames: [...all.sourceNames].reverse(),
    });
    for (const approval of badApprovals)
      expect((await post({ ...input, approval })).status).toBeGreaterThanOrEqual(400);
    expect(state.parse).not.toHaveBeenCalled();
    expect(state.store!.get(company.id).guidedPreparationRuns ?? []).toHaveLength(0);
  });
  it("미리보기 뒤 제외 자료만 바뀌어도 원래 승인과 CAS를 거절한다", async () => {
    addSources();
    const input = start(),
      excluded = company.sources[1];
    company = state.store!.mutate(
      company.id,
      {
        action: "source",
        revision: company.revision,
        source: { ...excluded, text: "changed excluded" },
      },
      reviewPlan,
    );
    expect((await post(input)).status).toBe(409);
    expect((await post({ ...input, revision: company.revision })).status).toBe(409);
    expect(state.parse).not.toHaveBeenCalled();
  });
  it.each(["analysis", "plan", "repair"] as const)(
    "%s 실행 중 입력 변경은 늦은 결과·추가 요청을 막는다",
    async (phase) => {
      addSources();
      let input: unknown = start();
      if (phase !== "analysis") {
        state.parse.mockResolvedValueOnce(answer(scopedAnalysis()));
        const run = await accept(input);
        select();
        input = continuation(run.id);
      }
      if (phase === "repair")
        state.parse.mockResolvedValueOnce(answer(scopedPlan())).mockResolvedValueOnce(
          answer({
            findings: [
              {
                id: "f",
                severity: "error",
                category: "fact-vs-plan",
                message: "계획이 완료로 바뀌었습니다",
                action: "계획 표현으로 수정하세요",
                sectionKey: "solution",
                sourceIds: [company.sources[0].id],
              },
            ],
          }),
        );
      state.parse.mockImplementationOnce(async () => {
        company = state.store!.get(company.id);
        changeProfile();
        return answer(phase === "analysis" ? scopedAnalysis() : scopedPlan());
      });
      const response = await post(input);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        accepted: true,
        code: phase === "analysis" ? "STALE_REVISION" : "GUIDED_INPUT_CHANGED",
      });
      company = state.store!.get(company.id);
      expect(company.plans).toHaveLength(phase === "repair" ? 1 : 0);
      expect(state.parse).toHaveBeenCalledTimes(
        phase === "analysis" ? 1 : phase === "plan" ? 2 : 4,
      );
      const count = state.parse.mock.calls.length;
      await accept(input);
      expect(state.parse).toHaveBeenCalledTimes(count);
    },
  );
  it("교체된 분석 또는 continue에 새 범위를 주입하면 전송하지 않는다", async () => {
    addSources();
    state.parse.mockResolvedValueOnce(answer(scopedAnalysis()));
    const run = await accept(start());
    select();
    expect((await post({ ...continuation(run.id), approval: start().approval })).status).toBe(400);
    company = state.store!.saveAnalysis(company.id, company.revision, analysis(), "ai");
    select();
    expect((await post(continuation(run.id))).status).toBe(409);
    expect(state.parse).toHaveBeenCalledTimes(1);
  });
  it("전송 전 durable 시작 뒤 서버 재열기는 같은 nonce만 조회하며 미확인을 재전송하지 않는다", async () => {
    addSources();
    const input = start();
    state.store!.beginGuidedPreparation(company.id, input, "mock-model");
    state.store!.close();
    state.store = new StudioStore(directory);
    company = state.store.get(company.id);
    const recovered = await accept(input);
    expect(recovered.status).toBe("running");
    expect(
      (await post({ ...input, approval: { ...input.approval, sourceNames: ["different"] } }))
        .status,
    ).toBe(409);
    expect((await post(start())).status).toBe(409);
    expect(
      (await post({ ...restart(recovered.id), acknowledgedPreviousAttempt: false })).status,
    ).toBe(400);
    expect(state.parse).not.toHaveBeenCalled();
    const snapshot = JSON.stringify(company.guidedPreparationRuns![0]);
    state.parse.mockResolvedValueOnce(answer(scopedAnalysis()));
    const next = await accept(restart(recovered.id));
    expect(next.phase).toBe("analysis");
    expect(next.retryOfId).toBe(recovered.id);
    expect(JSON.stringify(company.guidedPreparationRuns![0])).toBe(snapshot);
    assertRequestsScoped(1);
  });
  it("실행 중 중복 요청은 새 SDK 작업을 만들지 않는다", async () => {
    addSources();
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
    release(answer(scopedAnalysis()));
    expect((await first).status).toBe(200);
    assertRequestsScoped(1);
  });
  it("공급자 결과의 제외 자료 인용을 거절하고 원래 승인 범위를 보존한다", async () => {
    addSources();
    const bad = analysis();
    bad.candidates[0] = {
      ...candidate,
      evidence: [{ sourceId: company.sources[1].id, quote: "EXCLUDED-BODY", locator: "본문" }],
    };
    const input = start();
    state.parse.mockResolvedValueOnce(answer(bad));
    const run = await accept(input);
    expect(run.status).toBe("failed");
    expect(company.analysis).toBeNull();
    expect(run.approval).toEqual(input.approval);
    assertRequestsScoped(1);
  });
  it.each(["fact", "candidate", "section", "review", "checkpoint"] as const)(
    "%s 저장 경계도 제외 자료 인용을 거절하고 rollback한다",
    async (kind) => {
      addSources();
      const started = state.store!.beginGuidedPreparation(company.id, start(), "mock-model");
      company = started.company;
      const ref = { sourceId: company.sources[1].id, quote: "EXCLUDED-BODY", locator: "본문" };
      if (kind === "fact" || kind === "candidate") {
        const value = scopedAnalysis();
        if (kind === "fact")
          value.facts = [{ id: "f", statement: "합성 주장", status: "reported", evidence: [ref] }];
        else value.candidates[0].evidence = [ref];
        const before = storedBytes();
        expect(() =>
          state.store!.commitGuidedPreparation(company.id, company.revision, started.run.id, {
            phase: "analysis",
            content: value,
          }),
        ).toThrowError(expect.objectContaining({ code: "GUIDED_RESULT_SCOPE_CHANGED" }));
        expect(storedBytes()).toBe(before);
      } else {
        company = state.store!.commitGuidedPreparation(
          company.id,
          company.revision,
          started.run.id,
          { phase: "analysis", content: scopedAnalysis() },
        ).company;
        select();
        company = state.store!.beginGuidedPreparation(
          company.id,
          continuation(started.run.id),
          "mock-model",
        ).company;
        const value = scopedPlan();
        if (kind !== "review") value.sections[0].evidence = [ref];
        const review =
          kind === "review"
            ? [
                {
                  id: "f",
                  severity: "error" as const,
                  category: "fact-vs-plan" as const,
                  message: "합성",
                  sectionKey: null,
                  action: "확인",
                  sourceIds: [company.sources[1].id],
                },
              ]
            : [];
        const before = storedBytes();
        expect(() =>
          kind === "checkpoint"
            ? state.store!.checkpointGuidedPlan(
                company.id,
                company.revision,
                started.run.id,
                value,
                review,
              )
            : state.store!.commitGuidedPreparation(company.id, company.revision, started.run.id, {
                phase: "plan",
                content: value,
                review,
              }),
        ).toThrowError(expect.objectContaining({ code: "GUIDED_RESULT_SCOPE_CHANGED" }));
        expect(storedBytes()).toBe(before);
      }
      expect(state.parse).not.toHaveBeenCalled();
    },
  );
});

describe("범위 축소와 기존 승인 방어 유지", () => {
  it("전체 장문은 초과해도 선택한 본문은 전체 길이 그대로 전송한다", async () => {
    addSources();
    for (const item of company.sources)
      company = state.store!.mutate(
        company.id,
        {
          action: "source",
          revision: company.revision,
          source: { ...item, text: '"'.repeat(62000) },
        },
        reviewPlan,
      );
    const all = await (
      await preview({ revision: company.revision, sourceIds: company.sources.map((s) => s.id) })
    ).json();
    const one = await (
      await preview({ revision: company.revision, sourceIds: [company.sources[0].id] })
    ).json();
    expect(all.overInputLimit).toBe(true);
    expect(one.overInputLimit).toBe(false);
    state.parse.mockResolvedValueOnce(answer(analysis(0)));
    await accept({ ...start(), approval: one.approval });
    const input = JSON.parse(
      state.parse.mock.calls[0][0].input.find((item: { role: string }) => item.role === "user")
        .content,
    );
    expect(input.sources).toHaveLength(1);
    expect(input.sources[0].text).toBe('"'.repeat(62000));
    expect(company.sources).toHaveLength(2);
  });
  it("읽기 사본의 회사·본문·이름·순서 변조는 승인 범위를 넓히지 못한다", () => {
    addSources();
    const approval = start().approval;
    for (const changed of [
      { ...company, id: randomUUID() },
      {
        ...company,
        sources: company.sources.map((s, i) => (i === 0 ? { ...s, text: "altered" } : s)),
      },
      {
        ...company,
        sources: company.sources.map((s, i) => (i === 0 ? { ...s, name: "altered" } : s)),
      },
    ])
      expect(() => guidedPreparationInputCompany(changed, approval)).toThrowError(
        expect.objectContaining({ code: "GUIDED_INPUT_CHANGED" }),
      );
    expect(() =>
      guidedPreparationInputCompany(company, { ...approval, sourceIds: [company.sources[1].id] }),
    ).toThrow();
    expect(() =>
      guidedPreparationInputCompany(company, { ...approval, sourceNames: ["altered"] }),
    ).toThrow();
    expect(serializeStudioAiInput(guidedPreparationInputCompany(company, approval))).not.toContain(
      "EXCLUDED-BODY",
    );
  });
  it("선택 미리보기는 키·명시 승인·모델·Origin 검사를 대신하지 않는다", async () => {
    addSources();
    const input = start(),
      before = storedBytes();
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await post(input)).status).toBe(503);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-never-sent");
    expect((await post({ ...input, approved: false })).status).toBe(400);
    vi.stubEnv("OPENAI_MODEL", "different-model");
    expect((await post(input)).status).toBe(409);
    vi.stubEnv("OPENAI_MODEL", "mock-model");
    expect((await POST(request(input, { origin: "https://evil.example" }), context())).status).toBe(
      403,
    );
    expect(state.parse).not.toHaveBeenCalled();
    expect(storedBytes()).toBe(before);
  });
});
