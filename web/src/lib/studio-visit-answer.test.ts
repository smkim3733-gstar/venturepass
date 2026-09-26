import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument } from "./studio-schema";
import {
  assertVisitAnswerCapacity,
  buildVisitAnswer,
  isVisitAnswerReplay,
  visitAnswerInputDigest,
  type VisitAnswerCompany,
} from "./studio-visit-answer";
import {
  buildVisitAnswerChecks,
  visitAnswerContext,
  visitAnswerInputSchema,
  type VisitAnswerInput,
} from "./studio-visit-answer-types";

const now = "2026-09-25T00:00:00.000Z";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const planId = randomUUID();
  const company: VisitAnswerCompany = {
    ...caseSchema.parse({
      id: randomUUID(),
      profile: { ...emptyProfile(), companyName: "합성 실사 시험기업" },
      sources: [],
      plans: [
        {
          id: planId,
          version: 1,
          generatedAt: now,
          mode: "manual",
          candidateId: "fixture",
          sourceRevision: 0,
          content: {
            title: "가상 계획",
            summary: "요약",
            sections: [
              {
                key: "technology",
                title: "기술",
                content: "시험 10건, 개발 중입니다.",
                evidence: [],
                needsConfirmation: true,
              },
            ],
            actionItems: [],
            interviewQuestions: ["검증 상태는 무엇인가요?", "검증 상태는 무엇인가요?"],
          },
          review: [],
          confirmedAt: null,
        },
      ],
      analysis: null,
      selectedCandidateId: null,
      tasks: [],
      stage: "preparing",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }),
    visitAnswers: [],
  };
  const input: VisitAnswerInput = {
    answerId: null,
    previousVersionId: null,
    planId,
    questionIndex: 0,
    questionText: company.plans[0].content.interviewQuestions[0],
    submissionRecordId: null,
    respondentRole: "technical",
    respondentName: "가상 담당자",
    answerText: "시험 12건입니다.",
    pairs: [
      {
        id: randomUUID(),
        answerQuote: "시험 12건입니다.",
        planReference: { sectionKey: "technology", quote: "시험 10건" },
        sources: [],
        contextNote: "기간·대상 확인 필요",
      },
    ],
    followUpNote: "추가 확인",
    review: { reviewed: false, reviewer: "", note: "" },
  };
  const reader = vi.fn<
    (sourceId: string) => { source: SourceDocument; buffer: Buffer; sha256: string }
  >(() => {
    throw new Error("Unexpected file read");
  });
  const build = (value = input) =>
    buildVisitAnswer(
      company,
      visitAnswerInputSchema.parse(value),
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: visitAnswerInputDigest(value),
        recordedAt: now,
      },
      reader,
    );
  const next = (): VisitAnswerInput => ({
    ...structuredClone(input),
    answerId: company.visitAnswers[0].answerId,
    previousVersionId: company.visitAnswers.at(-1)!.id,
  });
  const addSource = (original = false, pending = false) => {
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 근거",
      kind: "other",
      text: pending ? "" : "시험 10건, 개발 중입니다.",
      originalName: original ? "fixture.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: pending ? "pending" : "manual",
      warnings: pending ? ["본문 미추출"] : [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    input.pairs[0].sources.push({
      sourceId: source.id,
      sourceUpdatedAt: now,
      quote: pending ? "" : "시험 10건",
      locator: "1쪽",
    });
    const buffer = Buffer.from("synthetic original");
    reader.mockReturnValue({ source, buffer, sha256: hash(buffer) });
    return { source, buffer };
  };
  return { company, input, reader, build, next, addSource };
}
describe("실사 답변의 정확한 버전·인용·원본 경계", () => {
  it("pins question index/text and hashes without claiming fact verification", () => {
    const { build, company, input } = fixture();
    const before = structuredClone(company);
    const record = build();
    expect(record.questionSnapshot).toMatchObject({
      planId: input.planId,
      planVersion: 1,
      questionIndex: 0,
      questionText: input.questionText,
      questionSha256: hash(input.questionText),
      planContentSha256: hash(JSON.stringify(company.plans[0].content)),
    });
    expect(record).toMatchObject({
      version: 1,
      origin: "manual",
      checkVersion: "paired-spelling-v1",
      review: { reviewedAt: null },
    });
    expect(record.checks.map((item) => item.code)).toEqual([
      "NUMERIC_SPELLING_DIFFERENCE",
      "MANUAL_CONTEXT_REQUIRED",
    ]);
    expect(company).toEqual(before);
  });
  it.each([
    [
      "question index",
      (f: ReturnType<typeof fixture>) => {
        f.input.questionIndex = 2;
      },
      "VISIT_QUESTION_CHANGED",
    ],
    [
      "question spelling",
      (f: ReturnType<typeof fixture>) => {
        f.input.questionText += " ";
      },
      "VISIT_QUESTION_CHANGED",
    ],
    [
      "foreign plan",
      (f: ReturnType<typeof fixture>) => {
        f.input.planId = randomUUID();
      },
      "VISIT_PLAN_NOT_FOUND",
    ],
    [
      "duplicate plan",
      (f: ReturnType<typeof fixture>) => {
        f.company.plans.push(structuredClone(f.company.plans[0]));
      },
      "VISIT_PLAN_NOT_FOUND",
    ],
    [
      "duplicate section",
      (f: ReturnType<typeof fixture>) => {
        f.company.plans[0].content.sections.push(
          structuredClone(f.company.plans[0].content.sections[0]),
        );
      },
      "VISIT_PLAN_QUOTE_INVALID",
    ],
    [
      "answer quote",
      (f: ReturnType<typeof fixture>) => {
        f.input.pairs[0].answerQuote = "없는 답변";
      },
      "VISIT_ANSWER_QUOTE_INVALID",
    ],
    [
      "plan quote",
      (f: ReturnType<typeof fixture>) => {
        f.input.pairs[0].planReference!.quote = "없는 원고";
      },
      "VISIT_PLAN_QUOTE_INVALID",
    ],
    [
      "foreign submission",
      (f: ReturnType<typeof fixture>) => {
        f.input.submissionRecordId = randomUUID();
      },
      "VISIT_SUBMISSION_NOT_FOUND",
    ],
  ])("rejects %s before reading files", (_name, change, code) => {
    const f = fixture();
    change(f);
    expect(f.build).toThrow(expect.objectContaining({ code }));
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("does not merge identical question text at a different index", () => {
    const f = fixture();
    const first = f.build();
    f.company.visitAnswers.push(first);
    const next = f.next();
    next.questionIndex = 1;
    expect(() => f.build(next)).toThrow(
      expect.objectContaining({ code: "VISIT_ANSWER_ROOT_MISMATCH" }),
    );
    expect(f.build({ ...f.input, questionIndex: 1 }).questionIndex).toBe(1);
  });
  it("appends review on the latest version while preserving first answer", () => {
    const f = fixture();
    const first = f.build();
    f.company.visitAnswers.push(first);
    const next = f.next();
    next.review = { reviewed: true, reviewer: "검토자", note: "본문 대조 기록만" };
    const second = f.build(next);
    expect(second).toMatchObject({
      answerId: first.id,
      previousVersionId: first.id,
      version: 2,
      review: { reviewedAt: now },
    });
    f.company.visitAnswers.push(second);
    expect(() => f.build(next)).toThrow(
      expect.objectContaining({ code: "VISIT_ANSWER_VERSION_STALE" }),
    );
    expect(() => f.build()).toThrow(
      expect.objectContaining({ code: "VISIT_ANSWER_ALREADY_EXISTS" }),
    );
    expect(f.company.visitAnswers[0]).toEqual(first);
    expect(second.checks.some((item) => item.code === "NUMERIC_SPELLING_DIFFERENCE")).toBe(true);
  });
  it("allows deliberate old plan selection without silently choosing latest", () => {
    const f = fixture();
    f.company.plans.push({ ...structuredClone(f.company.plans[0]), id: randomUUID(), version: 2 });
    expect(f.build().questionSnapshot.planVersion).toBe(1);
  });
  it("rejects same-ID plan changes despite a still-present exact quote", () => {
    const f = fixture();
    f.company.visitAnswers.push(f.build());
    f.company.plans[0].content.summary += "변경";
    expect(() => f.build(f.next())).toThrow(
      expect.objectContaining({ code: "VISIT_PLAN_CHANGED" }),
    );
  });
  it.each([
    "first-review",
    "root-pair",
    "unknown-key",
    "empty-pair",
    "duplicate-pair",
    "blank-quote",
    "answer-limit",
  ])("rejects strict input %s", (kind) => {
    const f = fixture();
    const value: Record<string, unknown> = structuredClone(f.input);
    if (kind === "first-review") value.review = { reviewed: true, reviewer: "검토자", note: "" };
    if (kind === "root-pair") value.previousVersionId = randomUUID();
    if (kind === "unknown-key") value.factVerified = true;
    if (kind === "empty-pair")
      value.pairs = [{ ...f.input.pairs[0], sources: [], planReference: null }];
    if (kind === "duplicate-pair") value.pairs = [f.input.pairs[0], f.input.pairs[0]];
    if (kind === "blank-quote") value.pairs = [{ ...f.input.pairs[0], answerQuote: " " }];
    if (kind === "answer-limit") value.answerText = "x".repeat(10001);
    expect(visitAnswerInputSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "foreign",
    "old-time",
    "missing-quote",
    "pending-quote",
    "empty-without-original",
    "duplicate-ref",
  ])("rejects source %s", (kind) => {
    const f = fixture();
    const { source } = f.addSource();
    const ref = f.input.pairs[0].sources[0];
    if (kind === "foreign") ref.sourceId = randomUUID();
    if (kind === "old-time") ref.sourceUpdatedAt = "old";
    if (kind === "missing-quote") ref.quote = "본문에 없음";
    if (kind === "pending-quote") source.extraction = "pending";
    if (kind === "empty-without-original") ref.quote = "";
    if (kind === "duplicate-ref") f.input.pairs[0].sources.push(ref);
    expect(f.build).toThrow();
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("stores pending original without turning it into analyzed evidence", () => {
    const f = fixture();
    const { source, buffer } = f.addSource(true, true);
    const record = f.build();
    expect(record.sourceSnapshots[0]).toMatchObject({
      sourceId: source.id,
      extraction: "pending",
      textSha256: hash(""),
      original: { sha256: hash(buffer), sizeBytes: buffer.length },
    });
    expect(record.checks.some((item) => item.code === "ORIGINAL_ONLY")).toBe(true);
    expect(f.reader).toHaveBeenCalledTimes(2);
    expect(source.text).toBe("");
  });
  it("rejects a same-sized changed original after capture and in later history", () => {
    const f = fixture();
    const { source, buffer } = f.addSource(true);
    const other = Buffer.alloc(buffer.length, 120);
    f.reader
      .mockReturnValueOnce({ source, buffer, sha256: hash(buffer) })
      .mockReturnValueOnce({ source, buffer: other, sha256: hash(other) });
    expect(f.build).toThrow(expect.objectContaining({ code: "VISIT_ORIGINAL_CHANGED" }));
    f.reader.mockReturnValue({ source, buffer, sha256: hash(buffer) });
    f.company.visitAnswers.push(f.build());
    f.reader.mockReturnValue({ source, buffer: other, sha256: hash(other) });
    expect(() => f.build(f.next())).toThrow(
      expect.objectContaining({ code: "VISIT_ORIGINAL_CHANGED" }),
    );
  });
  it("checks actual bytes rather than trusting a reported hash", () => {
    const f = fixture();
    const { source, buffer } = f.addSource(true);
    f.reader.mockReturnValue({ source, buffer, sha256: "a".repeat(64) });
    expect(f.build).toThrow(expect.objectContaining({ code: "VISIT_SOURCE_STALE" }));
  });
  it("enforces original and text/history limits without truncation", () => {
    const f = fixture();
    const { source } = f.addSource(true);
    const buffer = Buffer.alloc(12 * 1024 * 1024 + 1);
    f.reader.mockReturnValue({ source, buffer, sha256: hash(buffer) });
    expect(f.build).toThrow(expect.objectContaining({ code: "VISIT_ORIGINAL_LIMIT" }));
    const small = fixture().build();
    expect(() => assertVisitAnswerCapacity(Array(101).fill(small))).toThrow(
      expect.objectContaining({ code: "VISIT_ANSWER_LIMIT" }),
    );
    expect(() =>
      assertVisitAnswerCapacity(Array(21).fill({ ...small, answerText: "x".repeat(10000) })),
    ).toThrow(expect.objectContaining({ code: "VISIT_ANSWER_LIMIT" }));
  });
  it("preserves canonical nonce replay and rejects conflicting payloads", () => {
    const f = fixture();
    const record = f.build();
    expect(isVisitAnswerReplay([record], record.clientRequestId, record.inputDigest)).toBe(true);
    expect(isVisitAnswerReplay([record], randomUUID(), record.inputDigest)).toBe(false);
    expect(() => isVisitAnswerReplay([record], record.clientRequestId, "a".repeat(64))).toThrow(
      expect.objectContaining({ code: "VISIT_ANSWER_REQUEST_CONFLICT" }),
    );
  });
  it("marks source revision change as stale and removed source as missing", () => {
    const f = fixture();
    const { source } = f.addSource();
    const first = f.build();
    f.company.visitAnswers.push(first);
    const next = f.next();
    next.review = { reviewed: true, reviewer: "검토자", note: "" };
    const reviewed = f.build(next);
    expect(visitAnswerContext(f.company, reviewed)).toMatchObject({
      state: "current",
      reviewCurrent: true,
      originalCheck: "saved-only",
    });
    source.updatedAt += "x";
    expect(visitAnswerContext(f.company, reviewed)).toMatchObject({
      state: "stale",
      reviewCurrent: false,
    });
    f.company.sources = [];
    expect(visitAnswerContext(f.company, reviewed).state).toBe("missing");
  });
});
describe("수치 표기 대조는 사실 판정이 아니다", () => {
  it.each([
    ["10개", "10명", false],
    ["2024년 10건", "2025년 10건", true],
    ["1,000원", "1000원", true],
    ["개발 중", "시험 10건", false],
    ["10건", "10건", false],
  ])("%s / %s", (answer, quote, difference) => {
    const f = fixture();
    f.input.answerText = answer;
    f.input.pairs[0].answerQuote = answer;
    f.input.pairs[0].planReference!.quote = quote;
    const checks = buildVisitAnswerChecks(f.input);
    expect(checks.some((check) => check.code === "NUMERIC_SPELLING_DIFFERENCE")).toBe(difference);
    expect(checks.some((check) => check.code === "MANUAL_CONTEXT_REQUIRED")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain('"matched"');
  });
  it("retains unanswered and unlinked checks in an incomplete draft", () => {
    expect(
      buildVisitAnswerChecks({ answerText: "", pairs: [] }).map((check) => check.code),
    ).toEqual(["UNANSWERED", "NO_PAIRS", "MANUAL_CONTEXT_REQUIRED"]);
  });
});
