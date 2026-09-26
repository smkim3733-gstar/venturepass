import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument } from "./studio-schema";
import { buildAgencyRecord, agencyRecordInputSchema } from "./studio-agency-records";
import { buildSourceLocationMetadata } from "./studio-source-location";
import {
  answerSuggestionSha as sha,
  buildAnswerSuggestionContext,
  buildLocalAnswerSuggestions,
  validateAiAnswerSuggestions,
} from "./studio-answer-suggestion";
import {
  answerSuggestionBindingSchema,
  answerSuggestionDraft,
  type AnswerSuggestionInput,
} from "./studio-answer-suggestion-types";

const now = "2026-09-26T00:00:00.000Z";
function fixture() {
  const source: SourceDocument = {
    id: randomUUID(),
    name: "합성 녹취",
    kind: "consultation",
    text: "인사말\n검증 상태는 개발 중입니다.\n추가 계약은 확인하지 않았습니다.",
    extraction: "manual",
    originalName: null,
    mimeType: null,
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 기업", financials: "비선택 비공개 재무" },
    sources: [source],
    analysis: null,
    selectedCandidateId: null,
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: now,
        mode: "manual",
        candidateId: "fixture",
        sourceRevision: 0,
        content: {
          title: "합성 계획",
          summary: "공유하지 않는 요약",
          sections: [
            {
              key: "technology",
              title: "기술",
              content: "등록 원고",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: ["검증 상태는 무엇인가요?"],
        },
        review: [],
        confirmedAt: null,
      },
    ],
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const questionText = company.plans[0].content.interviewQuestions[0];
  const input: AnswerSuggestionInput = {
    revision: 1,
    target: {
      kind: "visit-question",
      planId: company.plans[0].id,
      planVersion: 1,
      questionIndex: 0,
      questionText,
      questionSha256: sha(questionText),
    },
    sourceSelections: [{ sourceId: source.id, sourceUpdatedAt: now, textSha256: sha(source.text) }],
  };
  const context = () => buildAnswerSuggestionContext(company, input);
  const selection = (quote = "검증 상태는 개발 중입니다.") => ({
    sourceId: source.id,
    start: source.text.indexOf(quote),
    end: source.text.indexOf(quote) + quote.length,
    quote,
  });
  const agency = () => {
    const record = buildAgencyRecord(
      company.agencyRecords,
      agencyRecordInputSchema.parse({
        kind: "request",
        title: "합성 요청",
        institution: "합성 기관",
        body: "비선택 앞부분\n검증 상태를 설명해 주세요.\n비선택 뒷부분",
        occurredOn: "",
        note: "비공개 메모",
        dueOn: "",
        dueNote: "",
        sourceIds: [],
      }),
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: sha("fixture"),
        recordedAt: now,
        evidence: [],
      },
    );
    if (record.kind !== "request") throw new Error("Invalid synthetic request fixture");
    company.agencyRecords.push(record);
    const quote = "검증 상태를 설명해 주세요.";
    input.target = {
      kind: "agency-request",
      requestRecordId: record.id,
      requestVersionId: record.id,
      start: record.body.indexOf(quote),
      end: record.body.indexOf(quote) + quote.length,
      quote,
    };
    return record;
  };
  return { source: company.sources[0], company, input, context, selection, agency };
}

describe("등록 본문 기반 답변 인용 제안", () => {
  it("local suggestions preserve exact offsets and attribution without saving or confirming facts", () => {
    const f = fixture(),
      before = structuredClone(f.company);
    const result = buildLocalAnswerSuggestions(f.context());
    expect(result).toMatchObject({
      mode: "assisted",
      model: null,
      reviewStatus: "unreviewed",
      originalCheck: "not-read",
      databaseChanged: false,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      ...f.selection(),
      lineStart: 2,
      lineEnd: 2,
      coordinate: null,
    });
    expect(answerSuggestionDraft(f.input.target, result.candidates)).toContain("미검토 답변 준비");
    expect(f.company).toEqual(before);
  });
  it("the public binding can be rehashed from its strict schema without hidden key ordering", () => {
    const f = fixture(),
      context = f.context();
    const { inputSha256, ...exact } = answerSuggestionBindingSchema.parse(context.binding);
    expect(inputSha256).toBe(sha(JSON.stringify(exact)));
  });
  it("transmits only the selected request excerpt and selected registered bodies", () => {
    const f = fixture();
    f.agency();
    f.company.sources.push({
      ...f.source,
      id: randomUUID(),
      name: "비선택 자료",
      text: "SECRET_UNSELECTED",
    });
    const transmitted = JSON.stringify(f.context().transmission);
    expect(transmitted).toContain("검증 상태를 설명");
    for (const forbidden of [
      "비선택 앞부분",
      "비선택 뒷부분",
      "비공개 메모",
      "비선택 비공개 재무",
      "SECRET_UNSELECTED",
      "공유하지 않는 요약",
    ])
      expect(transmitted).not.toContain(forbidden);
  });
  it("requires the latest exact request version rather than silently retargeting a correction", () => {
    const f = fixture(),
      record = f.agency();
    f.company.agencyRecords.push({
      ...record,
      id: randomUUID(),
      kind: "request-correction",
      previousVersionId: record.id,
      version: 2,
    });
    expect(f.context).toThrowError(
      expect.objectContaining({ code: "ANSWER_SUGGESTION_TARGET_STALE" }),
    );
  });
  it.each([
    "revision",
    "source-time",
    "source-text",
    "pending",
    "foreign-source",
    "duplicate-source",
    "plan-version",
    "question-index",
    "question-hash",
    "duplicate-plan",
  ])("rejects changed/ambiguous %s", (kind) => {
    const f = fixture();
    if (kind === "revision") f.company.revision++;
    if (kind === "source-time") f.source.updatedAt += "x";
    if (kind === "source-text") f.source.text += "변경";
    if (kind === "pending") f.source.extraction = "pending";
    if (kind === "foreign-source") f.input.sourceSelections[0].sourceId = randomUUID();
    if (kind === "duplicate-source") f.company.sources.push({ ...f.source });
    if (kind === "duplicate-plan") f.company.plans.push(structuredClone(f.company.plans[0]));
    if (f.input.target.kind === "visit-question") {
      if (kind === "plan-version") f.input.target.planVersion++;
      if (kind === "question-index") f.input.target.questionIndex++;
      if (kind === "question-hash") f.input.target.questionSha256 = "0".repeat(64);
    }
    expect(f.context).toThrow();
  });
  it("rejects over-cap bodies without truncating them", () => {
    const f = fixture();
    f.source.text = "x".repeat(60_001);
    f.input.sourceSelections[0].textSha256 = sha(f.source.text);
    expect(f.context).toThrowError(expect.objectContaining({ code: "ANSWER_SUGGESTION_LIMIT" }));
  });
  it("offers an explicit missing-evidence question when literal matching finds nothing", () => {
    const f = fixture();
    f.source.text = "다른 이야기";
    f.input.sourceSelections[0].textSha256 = sha(f.source.text);
    const result = buildLocalAnswerSuggestions(f.context());
    expect(result.candidates).toEqual([]);
    expect(result.followUpQuestions[0]).toContain("찾지 못했습니다");
  });
  it("accepts only exact AI-selected text and generates no model-authored answer", () => {
    const f = fixture();
    const result = validateAiAnswerSuggestions(
      f.context(),
      { selections: [f.selection()] },
      "synthetic-model",
    );
    expect(result.mode).toBe("ai");
    expect(result.candidates[0].quote).toBe(f.selection().quote);
    expect(result.warnings[0]).toContain("의미·사실을 검증하지 않았습니다");
    expect(result).not.toHaveProperty("answer");
  });
  it.each([
    "invented",
    "foreign",
    "wrong-offset",
    "overlap",
    "duplicate",
    "answer",
    "coordinate",
    "split-surrogate",
  ])("rejects AI output %s", (kind) => {
    const f = fixture();
    let output: unknown = { selections: [f.selection()] };
    if (kind === "invented")
      output = { selections: [{ ...f.selection(), quote: "성공했습니다." }] };
    if (kind === "foreign") output = { selections: [{ ...f.selection(), sourceId: randomUUID() }] };
    if (kind === "wrong-offset") output = { selections: [{ ...f.selection(), start: 0 }] };
    if (kind === "overlap")
      output = {
        selections: [
          f.selection(),
          { ...f.selection(), end: f.selection().end - 1, quote: f.selection().quote.slice(0, -1) },
        ],
      };
    if (kind === "duplicate") output = { selections: [f.selection(), f.selection()] };
    if (kind === "answer") output = { selections: [], answer: "verified fact" };
    if (kind === "coordinate") output = { selections: [{ ...f.selection(), page: 1 }] };
    if (kind === "split-surrogate") {
      f.source.text = "😀검증";
      f.input.sourceSelections[0].textSha256 = sha(f.source.text);
      output = {
        selections: [{ sourceId: f.source.id, start: 1, end: 4, quote: f.source.text.slice(1, 4) }],
      };
    }
    expect(() => validateAiAnswerSuggestions(f.context(), output, "synthetic-model")).toThrowError(
      expect.objectContaining({ code: "ANSWER_SUGGESTION_OUTPUT_INVALID" }),
    );
  });
  it("never derives page/time from text labels, only retains an exact adopted structured range", () => {
    const f = fixture(),
      textSha = sha(f.source.text),
      resultId = randomUUID();
    const locations = buildSourceLocationMetadata(f.source.text, [
      { start: 0, end: f.source.text.length, coordinate: { kind: "ocr-page", pageNumber: 2 } },
    ]);
    // This read-only core fixture supplies only fields its location lookup observes.
    f.company.sourceIntakes.push({
      sourceId: f.source.id,
      adoption: {
        sourceUpdatedAt: f.source.updatedAt,
        adoptedTextSha256: textSha,
        resultTextSha256: textSha,
        resultId,
      },
      previousResults: [],
      result: { id: resultId, textSha256: textSha, locations },
    } as unknown as (typeof f.company.sourceIntakes)[number]);
    expect(
      validateAiAnswerSuggestions(f.context(), { selections: [f.selection()] }, "fixture")
        .candidates[0].coordinate,
    ).toEqual({ kind: "ocr-page", pageNumber: 2 });
    f.source.text += "\n수기 9쪽";
    f.input.sourceSelections[0].textSha256 = sha(f.source.text);
    expect(
      validateAiAnswerSuggestions(f.context(), { selections: [f.selection()] }, "fixture")
        .candidates[0].coordinate,
    ).toBeNull();
  });
});
