import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import {
  emptyProfile,
  originalOnlyWarnings,
  type BusinessPlan,
  type SourceDocument,
  type StudioCase,
} from "./studio-schema";
import { visitAnswerContext, type VisitAnswerInput } from "./studio-visit-answer-types";
import { withVentureInputCompanyLock } from "./venturein-input-lock";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as StudioStore | null,
  ai: vi.fn(),
  runner: vi.fn(),
}));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()),
  getStudioStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.ai();
    }
  },
}));
vi.mock("@/lib/venturein-runner", () => ({ stopVentureSession: state.runner }));
import { PATCH } from "@/app/api/studio/cases/[caseId]/route";

describe("실사 답변 API / 실제 임시 SQLite", () => {
  let directory: string;
  let company: StudioCase;
  const store = () => state.store!;
  const read = () => (company = store().get(company.id));
  const mutate = (input: Parameters<StudioStore["mutate"]>[1]) =>
    (company = store().mutate(company.id, input, () => []));
  const saveFixture = (value: unknown = company) => {
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(value), company.id);
    db.close();
    read();
  };
  const plan = (): BusinessPlan => ({
    id: randomUUID(),
    version: 1,
    generatedAt: "2026-09-25T00:00:00.000Z",
    mode: "manual",
    candidateId: "fixture",
    sourceRevision: 0,
    content: {
      title: "합성 계획서",
      summary: "현장 설명 준비",
      sections: [
        {
          key: "technology",
          title: "기술",
          content: "시험 10건을 진행 중입니다.",
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: [],
      interviewQuestions: ["현재 검증 상태는 무엇인가요?", "준비한 자료는 무엇인가요?"],
    },
    review: [],
    confirmedAt: null,
  });
  const input = (): VisitAnswerInput => ({
    answerId: null,
    previousVersionId: null,
    planId: company.plans[0].id,
    questionIndex: 0,
    questionText: company.plans[0].content.interviewQuestions[0],
    submissionRecordId: null,
    respondentRole: "technical",
    respondentName: "가상 응답자",
    answerText: "시험 12건을 진행 중입니다.",
    pairs: [
      {
        id: randomUUID(),
        answerQuote: "시험 12건",
        planReference: { sectionKey: "technology", quote: "시험 10건" },
        sources: [],
        contextNote: "기간·범위 확인",
      },
    ],
    followUpNote: "미확인 사항을 남깁니다.",
    review: { reviewed: false, reviewer: "", note: "" },
  });
  const body = (answer = input(), clientRequestId = randomUUID(), revision = company.revision) => ({
    action: "append-visit-answer",
    revision,
    clientRequestId,
    answer,
  });
  const patch = (
    payload: unknown,
    suffix = "",
    headers: Record<string, string> = {},
    caseId = company.id,
  ) =>
    PATCH(
      new Request(`http://localhost:3000/api/studio/cases/${caseId}${suffix}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ caseId }) },
    );
  const save = async (answer = input()) => {
    const result = await patch(body(answer));
    expect(result.status).toBe(200);
    company = await result.json();
    return company.visitAnswers.at(-1)!;
  };
  const next = (value: VisitAnswerInput): VisitAnswerInput => ({
    ...structuredClone(value),
    answerId: company.visitAnswers.at(-1)!.answerId,
    previousVersionId: company.visitAnswers.at(-1)!.id,
  });
  const source = (original = false, pending = false) => {
    const time = new Date().toISOString();
    const item: SourceDocument = {
      id: randomUUID(),
      name: "가상 검증 자료",
      kind: "other",
      text: pending ? "" : "시험 10건을 진행 중입니다. 확인이 필요합니다.",
      originalName: original ? "synthetic.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: pending ? "pending" : "manual",
      warnings: pending ? [...originalOnlyWarnings] : [],
      createdAt: time,
      updatedAt: time,
    };
    const bytes = Buffer.from("%PDF-1.7\nsynthetic fixture\n%%EOF");
    if (original) company = store().addUpload(company.id, company.revision, item, bytes);
    else mutate({ action: "source", revision: company.revision, source: item });
    return {
      source: company.sources.find((entry) => entry.id === item.id)!,
      bytes,
      path: join(directory, "originals", company.id, `${item.id}.bin`),
    };
  };
  const reference = (item: SourceDocument, quote = "시험 10건") => ({
    sourceId: item.id,
    sourceUpdatedAt: item.updatedAt,
    quote,
    locator: "등록 본문",
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "venture-visit-test-"));
    state.store = new StudioStore(directory);
    company = store().create({ ...emptyProfile(), companyName: "합성 실사 답변 회사" });
    company.plans = [plan()];
    saveFixture();
    state.ai.mockClear();
    state.runner.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store().close();
    const boundary = relative(resolve(tmpdir()), resolve(directory));
    if (!boundary.startsWith("venture-visit-test-") || boundary.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
    expect(state.ai).not.toHaveBeenCalled();
    expect(state.runner).not.toHaveBeenCalled();
  });
  it("appends an unreviewed local answer, preserving source/plan/stage/tasks/analysis", async () => {
    const before = structuredClone(company);
    const answer = await save();
    expect(answer).toMatchObject({
      answerId: answer.id,
      version: 1,
      origin: "manual",
      review: { reviewedAt: null },
      questionSnapshot: { planVersion: 1 },
    });
    expect(company.revision).toBe(before.revision + 1);
    for (const key of [
      "sources",
      "plans",
      "analysis",
      "tasks",
      "stage",
      "stageHistory",
      "agencyRecords",
      "applicationEvents",
      "appealPreparations",
      "responsePreparations",
    ] as const)
      expect(company[key]).toEqual(before[key]);
    const db = new DatabaseSync(join(directory, "studio.sqlite"));
    expect(
      db.prepare("SELECT evidence_revision FROM studio_cases WHERE id=?").get(company.id),
    ).toEqual({ evidence_revision: 0 });
    db.close();
  });
  it("stores incomplete answers with warnings without marking completion", async () => {
    const value = input();
    value.answerText = "";
    value.pairs = [];
    const record = await save(value);
    expect(record.checks.map((entry) => entry.code)).toEqual([
      "UNANSWERED",
      "NO_PAIRS",
      "MANUAL_CONTEXT_REQUIRED",
    ]);
    expect(company.stage).toBe("preparing");
  });
  it("records explicit later internal review and immutable previous versions", async () => {
    const value = input();
    const first = await save(value);
    const updated = next(value);
    updated.review = { reviewed: true, reviewer: "가상 검토자", note: "숫자 차이 미해결" };
    const second = await save(updated);
    expect(second.review.reviewedAt).not.toBeNull();
    expect(second.version).toBe(2);
    expect(company.visitAnswers[0]).toEqual(first);
    expect(second.checks.some((entry) => entry.code === "NUMERIC_SPELLING_DIFFERENCE")).toBe(true);
  });
  it("replays the exact nonce with stale revision, across process restart, without writes", async () => {
    const request = body();
    expect((await patch(request)).status).toBe(200);
    const saved = structuredClone(read());
    store().close();
    state.store = new StudioStore(directory);
    const replay = await patch(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(saved);
    expect(read()).toEqual(saved);
  });
  it("rejects a reused nonce with different content and leaves DB unchanged", async () => {
    const request = body();
    expect((await patch(request)).status).toBe(200);
    const saved = structuredClone(read());
    request.answer.followUpNote += "변경";
    const response = await patch(request);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "VISIT_ANSWER_REQUEST_CONFLICT" });
    expect(read()).toEqual(saved);
  });
  it("rejects stale CAS and another same-question root", async () => {
    const value = input();
    const revision = company.revision;
    await save(value);
    const before = structuredClone(company);
    expect((await patch(body(next(value), randomUUID(), revision))).status).toBe(409);
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("rejects an outdated previous version and root movement", async () => {
    const value = input();
    await save(value);
    const old = next(value);
    await save(old);
    const before = structuredClone(company);
    expect((await patch(body(old))).status).toBe(409);
    const moved = next(value);
    moved.questionIndex = 1;
    moved.questionText = company.plans[0].content.interviewQuestions[1];
    expect((await patch(body(moved))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("allows old stored plans, preserving the actual selected question version", async () => {
    const second = plan();
    second.version = 2;
    company.plans.push(second);
    saveFixture();
    expect((await save()).questionSnapshot.planVersion).toBe(1);
  });
  it.each(["plan", "source", "answer-root", "submission"])("rejects foreign %s", async (kind) => {
    const other = store().create({ ...emptyProfile(), companyName: "다른 합성 회사" });
    const value = input();
    if (kind === "plan") value.planId = randomUUID();
    if (kind === "source")
      value.pairs[0].sources = [
        { sourceId: randomUUID(), sourceUpdatedAt: "old", quote: "시험", locator: "" },
      ];
    if (kind === "answer-root") {
      value.answerId = randomUUID();
      value.previousVersionId = randomUUID();
    }
    if (kind === "submission") value.submissionRecordId = randomUUID();
    const before = structuredClone(company);
    const result = await patch(body(value));
    expect(result.status).toBe(404);
    expect(read()).toEqual(before);
    expect(store().get(other.id).visitAnswers).toEqual([]);
  });
  it.each([
    "first-review",
    "origin",
    "hash",
    "revision",
    "pair-key",
    "question-index",
    "unknown-body",
  ])("rejects strict payload %s", async (kind) => {
    const request: Record<string, unknown> = body();
    const value = request.answer as VisitAnswerInput & Record<string, unknown>;
    if (kind === "first-review") value.review = { reviewed: true, reviewer: "검토자", note: "" };
    if (kind === "origin") value.origin = "official";
    if (kind === "hash") value.questionSha256 = "a".repeat(64);
    if (kind === "revision") request.revision = -1;
    if (kind === "pair-key")
      value.pairs = [
        { ...value.pairs[0], verdict: "verified" } as VisitAnswerInput["pairs"][number],
      ];
    if (kind === "question-index") value.questionIndex = 30;
    if (kind === "unknown-body") request.autoSubmit = true;
    const before = structuredClone(company);
    expect((await patch(request)).status).toBe(400);
    expect(read()).toEqual(before);
  });
  it("rejects URL parameters, external Origin, and oversized requests", async () => {
    const request = body();
    const before = structuredClone(company);
    expect((await patch(request, "?mode=automatic")).status).toBe(400);
    expect((await patch(request, "", { origin: "https://external.invalid" })).status).toBe(403);
    expect(
      (
        await patch({
          ...request,
          answer: { ...request.answer, answerText: "x".repeat(512 * 1024) },
        })
      ).status,
    ).toBe(413);
    expect(read()).toEqual(before);
  });
  it("blocks while official input holds the company lock", async () => {
    const before = structuredClone(company);
    await withVentureInputCompanyLock(company.id, async () =>
      expect((await patch(body())).status).toBe(409),
    );
    expect(read()).toEqual(before);
    expect((await patch(body())).status).toBe(200);
  });
  it("captures a pending original twice without source mutations or analysis", async () => {
    const item = source(true, true);
    const value = input();
    value.pairs[0].sources = [reference(item.source, "")];
    const beforeSource = structuredClone(item.source);
    const spy = vi.spyOn(store(), "originalForVentureInput");
    const record = await save(value);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(record.sourceSnapshots[0]).toMatchObject({
      extraction: "pending",
      original: { sha256: createHash("sha256").update(item.bytes).digest("hex") },
    });
    expect(company.sources[0]).toEqual(beforeSource);
    expect(record.checks.some((entry) => entry.code === "ORIGINAL_ONLY")).toBe(true);
  });
  it("rejects pending quotation and stale source timestamps, preserving empty history", async () => {
    const item = source(true, true);
    const value = input();
    value.pairs[0].sources = [reference(item.source)];
    expect((await patch(body(value))).status).toBe(409);
    value.pairs[0].sources[0].quote = "";
    value.pairs[0].sources[0].sourceUpdatedAt = "old";
    expect((await patch(body(value))).status).toBe(409);
    expect(read().visitAnswers).toEqual([]);
  });
  it("rejects exact-quote mismatches without reading originals", async () => {
    const item = source(true);
    const value = input();
    value.pairs[0].sources = [reference(item.source, "없는 내용")];
    const spy = vi.spyOn(store(), "originalForVentureInput");
    expect((await patch(body(value))).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });
  it("blocks a same-sized original change between captures atomically", async () => {
    const item = source(true);
    const value = input();
    value.pairs[0].sources = [reference(item.source)];
    const before = structuredClone(company);
    const original = store().originalForVentureInput.bind(store());
    let reads = 0;
    vi.spyOn(store(), "originalForVentureInput").mockImplementation((caseId, sourceId) => {
      const result = original(caseId, sourceId);
      if (++reads === 1) {
        const changed = Buffer.from(item.bytes);
        changed[12] ^= 1;
        writeFileSync(item.path, changed);
      }
      return result;
    });
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("blocks referenced text/original deletion and marks edited text stale", async () => {
    const item = source();
    const value = input();
    value.pairs[0].sources = [reference(item.source)];
    const saved = await save(value);
    expect(
      (
        await patch({
          action: "delete-source",
          revision: company.revision,
          sourceId: item.source.id,
        })
      ).status,
    ).toBe(409);
    mutate({
      action: "source",
      revision: company.revision,
      source: { ...item.source, text: `${item.source.text} 추가 메모` },
    });
    expect(visitAnswerContext(company, saved)).toMatchObject({
      state: "stale",
      reviewCurrent: false,
    });
    expect(company.visitAnswers[0]).toEqual(saved);
  });
  it("refuses same-ID plan mutation after a captured visit answer", async () => {
    const value = input();
    await save(value);
    company.plans[0].content.summary += "변경";
    saveFixture();
    const before = structuredClone(company);
    expect((await patch(body(next(value)))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("pins a matching manual submission event without making it official", async () => {
    mutate({
      action: "create-application",
      revision: company.revision,
      clientRequestId: randomUUID(),
      title: "합성 회차",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
    });
    mutate({
      action: "record-application-submission",
      revision: company.revision,
      clientRequestId: randomUUID(),
      applicationId: company.applications[0].id,
      planId: company.plans[0].id,
      sourceIds: [],
      taskIds: [],
      receiptRecordId: null,
      occurredOn: "2026-09-25",
      recordedBy: "담당자",
      note: "수동 기록",
    });
    const value = input();
    value.submissionRecordId = company.applicationEvents.at(-1)!.id;
    const saved = await save(value);
    expect(saved.submissionSnapshot).toMatchObject({
      id: value.submissionRecordId,
      applicationId: company.applications[0].id,
      version: 1,
    });
    expect(company.stage).toBe("preparing");
  });
  it("protects visit original fingerprints from later agency records", async () => {
    const item = source(true);
    const value = input();
    value.pairs[0].sources = [reference(item.source)];
    const first = await save(value);
    const changed = Buffer.from(item.bytes);
    changed[12] ^= 1;
    writeFileSync(item.path, changed);
    const before = structuredClone(company);
    const response = await patch({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "가상 기관",
        title: "추가 설명 요청",
        body: "미확인",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [item.source.id],
      },
    });
    expect(response.status).toBe(409);
    expect(read()).toEqual(before);
    expect(company.visitAnswers[0]).toEqual(first);
  });
  it("protects prior agency original fingerprints when creating visit answers", async () => {
    const item = source(true);
    mutate({
      action: "append-agency-record",
      revision: company.revision,
      clientRequestId: randomUUID(),
      record: {
        kind: "request",
        institution: "가상 기관",
        title: "설명 요청",
        body: "원문",
        occurredOn: "",
        dueOn: "",
        dueNote: "",
        note: "",
        sourceIds: [item.source.id],
      },
    });
    const changed = Buffer.from(item.bytes);
    changed[12] ^= 1;
    writeFileSync(item.path, changed);
    const value = input();
    value.pairs[0].sources = [reference(item.source)];
    const before = structuredClone(company);
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
  it("defaults legacy records to empty answers and retains them after restart", async () => {
    const legacy = { ...company } as Partial<StudioCase>;
    delete legacy.visitAnswers;
    saveFixture(legacy);
    expect(company.visitAnswers).toEqual([]);
    const first = await save();
    store().close();
    state.store = new StudioStore(directory);
    expect(read().visitAnswers).toEqual([first]);
  });
  it("refuses history cap without removing old versions or writing a revision", async () => {
    const first = await save();
    company.visitAnswers = Array.from({ length: 100 }, () => ({
      ...first,
      id: randomUUID(),
      answerId: randomUUID(),
      clientRequestId: randomUUID(),
      questionIndex: 1,
      questionText: company.plans[0].content.interviewQuestions[1],
      answerText: "",
      pairs: [],
      followUpNote: "",
      checks: [],
    }));
    saveFixture();
    const before = structuredClone(company);
    expect(await patch(body())).toMatchObject({ status: 409 });
    expect(read()).toEqual(before);
  });
  it("refuses aggregate text overflow with rollback and no trimming", async () => {
    const first = await save();
    company.visitAnswers = Array.from({ length: 18 }, () => ({
      ...first,
      id: randomUUID(),
      answerId: randomUUID(),
      clientRequestId: randomUUID(),
      answerText: "x".repeat(10000),
    }));
    saveFixture();
    const value = input();
    value.questionIndex = 1;
    value.questionText = company.plans[0].content.interviewQuestions[1];
    value.answerText = "x".repeat(10000);
    value.pairs = [];
    const before = structuredClone(company);
    expect((await patch(body(value))).status).toBe(409);
    expect(read()).toEqual(before);
  });
}, 20_000);
