import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase, type SourceDocument } from "./studio-schema";
import { agencyRecordSchema } from "./studio-agency-records";
import {
  appealPreparationInputSchema,
  appealPreparationContext,
  type AppealPreparationInput,
} from "./studio-appeal-types";
import {
  appealInputDigest,
  assertAppealCapacity,
  buildAppealPreparation,
  isAppealReplay,
} from "./studio-appeal";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const id = randomUUID();
  const now = "2026-09-25T00:00:00.000Z";
  const notice = agencyRecordSchema.parse({
    id,
    clientRequestId: randomUUID(),
    inputDigest: "a".repeat(64),
    kind: "notice",
    noticeRecordId: id,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "가상기관",
    title: "가상 결과",
    body: "실증 근거를 보강해 주세요.",
    occurredOn: "",
    note: "",
    details: {
      category: "decision",
      decisionText: "미확인",
      notifiedOn: "",
      reasons: "실증 근거 부족",
    },
    evidence: [],
  });
  const company: StudioCase = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "가상기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    agencyRecords: [notice],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const input: AppealPreparationInput = {
    preparationId: null,
    previousVersionId: null,
    noticeRecordId: id,
    noticeVersionId: id,
    title: "소명 초안",
    intent: "undecided",
    intentNote: "",
    deadlineOn: "",
    deadlineNote: "",
    reasons: [
      {
        id: randomUUID(),
        noticeField: "reasons",
        noticeQuote: "실증 근거 부족",
        claim: "",
        planClaim: null,
        gap: "추가 증거 확인",
        evidence: [],
        additionalEvidence: [],
        draft: "초안",
      },
    ],
    review: { reviewed: false, reviewer: "", note: "" },
  };
  const generated = {
    id: randomUUID(),
    clientRequestId: randomUUID(),
    inputDigest: appealInputDigest(input),
    recordedAt: now,
  };
  const reader = vi.fn<
    (sourceId: string) => { source: SourceDocument; buffer: Buffer; sha256: string }
  >(() => {
    throw new Error("Unexpected file read");
  });
  return { company, input, generated, reader };
}
function source(index = 0, original = false): SourceDocument {
  return {
    id: randomUUID(),
    name: `합성자료${index}`,
    kind: "other",
    text: "본문 정확 인용",
    originalName: original ? "fixture.pdf" : null,
    mimeType: original ? "application/pdf" : null,
    extraction: "manual",
    warnings: [],
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}
const reference = (item: SourceDocument) => ({
  sourceId: item.id,
  sourceUpdatedAt: item.updatedAt,
  quote: "본문 정확 인용",
  locator: "1쪽",
});

describe("소명 준비 입력·버전·원본 경계", () => {
  it.each([
    [
      "reviewer 없이 검토",
      (input: AppealPreparationInput) => {
        input.review.reviewed = true;
      },
    ],
    [
      "없는 날짜",
      (input: AppealPreparationInput) => {
        input.deadlineOn = "2026-02-30";
      },
    ],
    [
      "빈 사유",
      (input: AppealPreparationInput) => {
        input.reasons = [];
      },
    ],
    [
      "공백 인용",
      (input: AppealPreparationInput) => {
        input.reasons[0].noticeQuote = " ";
      },
    ],
    [
      "중복 사유",
      (input: AppealPreparationInput) => {
        input.reasons.push(structuredClone(input.reasons[0]));
      },
    ],
    [
      "짝없는 버전",
      (input: AppealPreparationInput) => {
        input.preparationId = randomUUID();
      },
    ],
    [
      "사유 21개",
      (input: AppealPreparationInput) => {
        input.reasons = Array.from({ length: 21 }, () => ({
          ...input.reasons[0],
          id: randomUUID(),
        }));
      },
    ],
  ])("rejects %s", (_name, change) => {
    const { input } = fixture();
    change(input);
    expect(appealPreparationInputSchema.safeParse(input).success).toBe(false);
  });
  it("rejects duplicate existing/additional evidence and client-generated original metadata", () => {
    const { input } = fixture();
    const ref = reference(source());
    input.reasons[0].evidence = [ref];
    input.reasons[0].additionalEvidence = [ref];
    expect(appealPreparationInputSchema.safeParse(input).success).toBe(false);
    input.reasons[0].additionalEvidence = [];
    const forged = structuredClone(input) as unknown as { reasons: { evidence: unknown[] }[] };
    forged.reasons[0].evidence = [{ ...ref, sha256: "a".repeat(64) }];
    expect(appealPreparationInputSchema.safeParse(forged).success).toBe(false);
  });
  it("preserves an unknown deadline and manual intent without interpreting decision text", () => {
    const { company, input, generated, reader } = fixture();
    input.intent = "not-pursuing";
    const record = buildAppealPreparation(company, input, generated, reader);
    expect(record.deadlineOn).toBe("");
    expect(record.intent).toBe("not-pursuing");
    expect(reader).not.toHaveBeenCalled();
  });
  it("accepts exact body quote while preserving the full manual original elsewhere", () => {
    const { company, input, generated, reader } = fixture();
    input.reasons[0].noticeField = "body";
    input.reasons[0].noticeQuote = "실증 근거를 보강";
    const record = buildAppealPreparation(company, input, generated, reader);
    expect(appealPreparationContext(company, record).state).toBe("current");
  });
  it("counts distinct sources across all reasons before opening files", () => {
    const { company, input, generated, reader } = fixture();
    company.sources = Array.from({ length: 11 }, (_, index) => source(index, true));
    input.reasons[0].evidence = company.sources.slice(0, 10).map(reference);
    input.reasons.push({
      ...input.reasons[0],
      id: randomUUID(),
      evidence: [reference(company.sources[10])],
    });
    expect(() => buildAppealPreparation(company, input, generated, reader)).toThrow(
      expect.objectContaining({ code: "APPEAL_SOURCE_LIMIT" }),
    );
    expect(reader).not.toHaveBeenCalled();
  });
  it("deduplicates file capture across reasons and verifies both passes", () => {
    const { company, input, generated, reader } = fixture();
    const item = source(0, true);
    company.sources = [item];
    input.reasons[0].evidence = [reference(item)];
    input.reasons.push({ ...input.reasons[0], id: randomUUID() });
    const buffer = Buffer.from("synthetic");
    reader.mockReturnValue({ source: item, buffer, sha256: sha(buffer) });
    const record = buildAppealPreparation(company, input, generated, reader);
    expect(record.sourceSnapshots).toHaveLength(1);
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("rejects source metadata changes during original capture", () => {
    const { company, input, generated, reader } = fixture();
    const item = source(0, true);
    company.sources = [item];
    input.reasons[0].evidence = [reference(item)];
    reader.mockReturnValue({
      source: { ...item, updatedAt: "changed" },
      buffer: Buffer.from("x"),
      sha256: sha("x"),
    });
    expect(() => buildAppealPreparation(company, input, generated, reader)).toThrow(
      expect.objectContaining({ code: "APPEAL_SOURCE_STALE" }),
    );
  });
  it.each(["per-file", "batch"])("enforces %s original limits", (scope) => {
    const { company, input, generated, reader } = fixture();
    company.sources = Array.from({ length: scope === "batch" ? 3 : 1 }, (_, index) =>
      source(index, true),
    );
    input.reasons[0].evidence = company.sources.map(reference);
    const buffer = Buffer.alloc(scope === "batch" ? 9 * 1024 * 1024 : 12 * 1024 * 1024 + 1);
    reader.mockImplementation((id) => ({
      source: company.sources.find((item) => item.id === id)!,
      buffer,
      sha256: sha(buffer),
    }));
    expect(() => buildAppealPreparation(company, input, generated, reader)).toThrow(
      expect.objectContaining({ code: "APPEAL_ORIGINAL_LIMIT" }),
    );
  });
  it("rejects originals changed from an existing agency evidence snapshot", () => {
    const { company, input, generated, reader } = fixture();
    const item = source(0, true);
    company.sources = [item];
    input.reasons[0].evidence = [reference(item)];
    company.agencyRecords[0].evidence = [
      {
        sourceId: item.id,
        sourceName: item.name,
        originalName: item.originalName!,
        mimeType: item.mimeType,
        sizeBytes: 1,
        sha256: sha("a"),
        sourceUpdatedAt: item.updatedAt,
        capturedAt: generated.recordedAt,
      },
    ];
    reader.mockReturnValue({ source: item, buffer: Buffer.from("b"), sha256: sha("b") });
    expect(() => buildAppealPreparation(company, input, generated, reader)).toThrow(
      expect.objectContaining({ code: "APPEAL_ORIGINAL_CHANGED" }),
    );
  });
  it("does not block updated source text when the immutable original bytes are preserved", () => {
    const { company, input, generated, reader } = fixture();
    const item = source(0, true);
    const buffer = Buffer.from("x");
    company.sources = [item];
    input.reasons[0].evidence = [reference(item)];
    reader.mockReturnValue({ source: item, buffer, sha256: sha(buffer) });
    const first = buildAppealPreparation(company, input, generated, reader);
    company.appealPreparations = [first];
    item.text += " 수정 설명";
    item.updatedAt = "2026-09-26T00:00:00.000Z";
    input.preparationId = first.id;
    input.previousVersionId = first.id;
    input.reasons[0].evidence[0] = reference(item);
    const second = buildAppealPreparation(
      company,
      input,
      { ...generated, id: randomUUID() },
      reader,
    );
    expect(second.sourceSnapshots[0].textSha256).not.toBe(first.sourceSnapshots[0].textSha256);
    expect(second.sourceSnapshots[0].original?.sha256).toBe(
      first.sourceSnapshots[0].original?.sha256,
    );
    expect(appealPreparationContext(company, first).state).toBe("stale");
  });
  it("rejects plan quote changes under an already snapshotted plan id", () => {
    const { company, input, generated, reader } = fixture();
    const plan = {
      id: randomUUID(),
      version: 1,
      candidateId: "candidate",
      generatedAt: generated.recordedAt,
      mode: "manual" as const,
      sourceRevision: 0,
      content: {
        title: "초안",
        summary: "",
        sections: [
          {
            key: "market",
            title: "시장",
            content: "기존 주장",
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
      confirmedAt: null,
    };
    company.plans = [plan];
    input.reasons[0].planClaim = { planId: plan.id, sectionKey: "market", quote: "기존 주장" };
    const first = buildAppealPreparation(company, input, generated, reader);
    company.appealPreparations = [first];
    plan.content.summary = "변조된 내용";
    input.preparationId = first.id;
    input.previousVersionId = first.id;
    expect(() =>
      buildAppealPreparation(company, input, { ...generated, id: randomUUID() }, reader),
    ).toThrow(expect.objectContaining({ code: "APPEAL_PLAN_CHANGED" }));
  });
  it("aggregates all history strings and refuses overflow without trimming", () => {
    const { company, input, generated, reader } = fixture();
    const record = buildAppealPreparation(company, input, generated, reader);
    const records = Array.from({ length: 30 }, () => ({
      ...record,
      reasons: [{ ...record.reasons[0], draft: "가".repeat(10_000) }],
    }));
    const before = structuredClone(records);
    expect(() => assertAppealCapacity(records)).toThrow(
      expect.objectContaining({ code: "APPEAL_LIMIT" }),
    );
    expect(records).toEqual(before);
  });
  it("replay requires unique canonical nonce and never treats another input as the same save", () => {
    const { company, input, generated, reader } = fixture();
    const record = buildAppealPreparation(company, input, generated, reader);
    expect(isAppealReplay([record], generated.clientRequestId, generated.inputDigest)).toBe(true);
    expect(isAppealReplay([record], randomUUID(), generated.inputDigest)).toBe(false);
    expect(() => isAppealReplay([record], generated.clientRequestId, sha("changed"))).toThrow();
    expect(() =>
      isAppealReplay([record, record], generated.clientRequestId, generated.inputDigest),
    ).toThrow();
  });
  it("reports missing sources and plans, never keeping a current review", () => {
    const { company, input, generated, reader } = fixture();
    const item = source();
    company.sources = [item];
    input.reasons[0].evidence = [reference(item)];
    input.review = { reviewed: true, reviewer: "담당자", note: "" };
    const record = buildAppealPreparation(company, input, generated, reader);
    company.sources = [];
    expect(appealPreparationContext(company, record)).toMatchObject({
      state: "missing",
      reviewCurrent: false,
    });
    company.agencyRecords = [];
    expect(appealPreparationContext(company, record).issues).toContain(
      "연결한 결과 통보를 찾을 수 없습니다.",
    );
  });
});
