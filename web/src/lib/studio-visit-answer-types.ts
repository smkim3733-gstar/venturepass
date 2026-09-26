import { z } from "zod";
import { agencyEvidenceSnapshotSchema } from "./studio-agency-records";
import { isApplicationSubmission } from "./studio-application-types";
import type { StudioCase } from "./studio-schema";

export const visitAnswerLimits = {
  versions: 100,
  text: 200_000,
  pairs: 10,
  sources: 10,
  originalBytes: 24 * 1024 * 1024,
} as const;
export const visitRespondentLabels = {
  representative: "대표자",
  technical: "기술 담당자",
  staff: "실무 담당자",
  other: "기타 담당자",
} as const;
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const exactQuote = z
  .string()
  .min(1)
  .max(1500)
  .refine((value) => Boolean(value.trim()));
export const visitAnswerReferenceSchema = z
  .object({
    sourceId: uuid,
    sourceUpdatedAt: z.string().min(1).max(100),
    quote: z.string().max(1500),
    locator: z.string().max(150),
  })
  .strict();
export type VisitAnswerReference = z.infer<typeof visitAnswerReferenceSchema>;
export const visitAnswerPairSchema = z
  .object({
    id: uuid,
    answerQuote: exactQuote,
    planReference: z
      .object({ sectionKey: z.string().min(1).max(100), quote: exactQuote })
      .strict()
      .nullable(),
    sources: z.array(visitAnswerReferenceSchema).max(visitAnswerLimits.sources),
    contextNote: z.string().max(2000),
  })
  .strict()
  .refine(
    (pair) => pair.planReference !== null || pair.sources.length > 0,
    "답변 인용과 대조할 원고 또는 자료를 연결해 주세요.",
  )
  .refine(
    (pair) => new Set(pair.sources.map((source) => source.sourceId)).size === pair.sources.length,
    "한 대조 항목에 같은 자료를 중복 연결할 수 없습니다.",
  );
export type VisitAnswerPair = z.infer<typeof visitAnswerPairSchema>;
const answerFields = {
  planId: uuid,
  questionIndex: z.number().int().min(0).max(29),
  questionText: z
    .string()
    .min(1)
    .max(3000)
    .refine((value) => Boolean(value.trim())),
  submissionRecordId: uuid.nullable(),
  respondentRole: z.enum(["representative", "technical", "staff", "other"]),
  respondentName: z.string().trim().max(100),
  answerText: z.string().max(10_000),
  pairs: z
    .array(visitAnswerPairSchema)
    .max(visitAnswerLimits.pairs)
    .refine(
      (pairs) => new Set(pairs.map((pair) => pair.id)).size === pairs.length,
      "대조 항목 식별자가 중복되었습니다.",
    ),
  followUpNote: z.string().max(2000),
};
export const visitAnswerInputSchema = z
  .object({
    answerId: uuid.nullable(),
    previousVersionId: uuid.nullable(),
    ...answerFields,
    review: z
      .object({
        reviewed: z.boolean(),
        reviewer: z.string().trim().max(100),
        note: z.string().max(2000),
      })
      .strict(),
  })
  .strict()
  .refine(
    (input) => (input.answerId === null) === (input.previousVersionId === null),
    "최신 답변 버전의 연결 정보를 확인해 주세요.",
  )
  .refine(
    (input) =>
      !input.review.reviewed ||
      (input.answerId !== null &&
        Boolean(input.review.reviewer) &&
        Boolean(input.respondentName) &&
        Boolean(input.answerText.trim())),
    "최초 답변은 미검토로 저장합니다. 후속 내부 검토에는 답변·응답자·검토자를 입력해 주세요.",
  );
export type VisitAnswerInput = z.infer<typeof visitAnswerInputSchema>;
export const visitAnswerAppendMutationSchema = z
  .object({
    action: z.literal("append-visit-answer"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: uuid,
    answer: visitAnswerInputSchema,
  })
  .strict();
export const visitAnswerCheckCodes = [
  "UNANSWERED",
  "NO_PAIRS",
  "ORIGINAL_ONLY",
  "NUMERIC_SPELLING_DIFFERENCE",
  "MANUAL_CONTEXT_REQUIRED",
] as const;
const checkSchema = z
  .object({
    code: z.enum(visitAnswerCheckCodes),
    pairId: uuid.nullable(),
    message: z.string().max(300),
  })
  .strict();
export type VisitAnswerCheck = z.infer<typeof checkSchema>;
export const visitAnswerSchema = z
  .object({
    id: uuid,
    answerId: uuid,
    previousVersionId: uuid.nullable(),
    version: z.number().int().min(1).max(visitAnswerLimits.versions),
    clientRequestId: uuid,
    inputDigest: hash,
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
    ...answerFields,
    questionSnapshot: z
      .object({
        planId: uuid,
        planVersion: z.number().int(),
        planTitle: z.string().max(300),
        planContentSha256: hash,
        questionIndex: z.number().int().min(0).max(29),
        questionText: z.string().min(1).max(3000),
        questionSha256: hash,
      })
      .strict(),
    submissionSnapshot: z
      .object({
        id: uuid,
        applicationId: uuid,
        version: z.number().int().positive(),
        recordedAt: z.string().max(100),
        planContentSha256: hash,
      })
      .strict()
      .nullable(),
    sourceSnapshots: z
      .array(
        z
          .object({
            sourceId: uuid,
            sourceName: z.string().min(1).max(200),
            sourceUpdatedAt: z.string().min(1).max(100),
            extraction: z.enum(["local", "ai", "manual", "pending"]),
            textSha256: hash,
            original: agencyEvidenceSnapshotSchema.nullable(),
          })
          .strict(),
      )
      .max(visitAnswerLimits.sources),
    checkVersion: z.literal("paired-spelling-v1"),
    checks: z.array(checkSchema).max(30),
    review: z
      .object({
        reviewedAt: z.string().datetime().nullable(),
        reviewer: z.string().max(100),
        note: z.string().max(2000),
      })
      .strict(),
  })
  .strict();
export type VisitAnswer = z.infer<typeof visitAnswerSchema>;

/** Spelling differences only. Matching tokens never establish factual consistency. */
export function buildVisitAnswerChecks(
  input: Pick<VisitAnswerInput, "answerText" | "pairs">,
): VisitAnswerCheck[] {
  const checks: VisitAnswerCheck[] = [];
  if (!input.answerText.trim())
    checks.push({ code: "UNANSWERED", pairId: null, message: "답변이 미작성 상태입니다." });
  if (!input.pairs.length)
    checks.push({
      code: "NO_PAIRS",
      pairId: null,
      message: "답변 인용과 대조할 원고·자료가 연결되지 않았습니다.",
    });
  for (const pair of input.pairs) {
    if (pair.sources.some((source) => source.quote === ""))
      checks.push({
        code: "ORIGINAL_ONLY",
        pairId: pair.id,
        message: "원본만 연결한 자료가 있습니다. 본문과 답변의 관계는 판독하지 않았습니다.",
      });
    const numbers = (text: string) => text.match(/[+-]?\d+(?:[.,]\d+)*(?:%|％)?/g) ?? [];
    const answerNumbers = numbers(pair.answerQuote);
    const quotes = [
      pair.planReference?.quote,
      ...pair.sources.map((source) => source.quote),
    ].filter((quote): quote is string => Boolean(quote));
    if (
      answerNumbers.length &&
      quotes.some((quote) => {
        const values = numbers(quote);
        return values.length > 0 && JSON.stringify(values) !== JSON.stringify(answerNumbers);
      })
    ) {
      checks.push({
        code: "NUMERIC_SPELLING_DIFFERENCE",
        pairId: pair.id,
        message:
          "선택한 인용의 수치 표기가 다릅니다. 기간·단위·대상을 직접 확인해 주세요. 모순·오류 판정이 아닙니다.",
      });
    }
  }
  checks.push({
    code: "MANUAL_CONTEXT_REQUIRED",
    pairId: null,
    message:
      "인용·숫자가 같아도 사실 확인이나 답변 일관성 검증 완료를 뜻하지 않습니다. 연결하지 않은 답변과 기간·단위·대상은 담당자 확인이 필요합니다.",
  });
  return checks;
}

/** Current registered metadata/quotes only. Original bytes are checked on save. */
export function visitAnswerContext(
  company: Pick<StudioCase, "plans" | "sources" | "applicationEvents">,
  record: VisitAnswer,
) {
  const issues: string[] = [];
  let missing = false;
  const plans = company.plans.filter((plan) => plan.id === record.planId);
  const plan = plans.length === 1 ? plans[0] : undefined;
  if (!plan) {
    missing = true;
    issues.push("연결한 원고 버전을 고유하게 찾을 수 없습니다.");
  } else if (
    plan.version !== record.questionSnapshot.planVersion ||
    plan.content.title !== record.questionSnapshot.planTitle ||
    plan.content.interviewQuestions[record.questionIndex] !== record.questionText
  )
    issues.push("기준 원고·예상 질문이 변경되었습니다.");
  for (const pair of record.pairs) {
    if (!record.answerText.includes(pair.answerQuote))
      issues.push("답변 인용이 저장된 답변과 일치하지 않습니다.");
    if (pair.planReference && plan) {
      const reference = pair.planReference;
      const sections = plan.content.sections.filter(
        (section) => section.key === reference.sectionKey,
      );
      if (sections.length !== 1 || !sections[0].content.includes(reference.quote))
        issues.push("연결한 원고 항목·인용을 다시 확인해 주세요.");
    }
    for (const reference of pair.sources) {
      const sources = company.sources.filter((source) => source.id === reference.sourceId);
      const source = sources.length === 1 ? sources[0] : undefined;
      const snapshot = record.sourceSnapshots.find(
        (source) => source.sourceId === reference.sourceId,
      );
      if (!source || !snapshot) {
        missing = true;
        issues.push("연결한 자료를 찾을 수 없습니다.");
      } else if (
        source.updatedAt !== reference.sourceUpdatedAt ||
        source.updatedAt !== snapshot.sourceUpdatedAt ||
        source.name !== snapshot.sourceName ||
        source.extraction !== snapshot.extraction ||
        source.originalName !== (snapshot.original?.originalName ?? null) ||
        source.mimeType !== (snapshot.original?.mimeType ?? null) ||
        (reference.quote !== "" &&
          (source.extraction === "pending" || !source.text.includes(reference.quote)))
      )
        issues.push("자료가 변경되었습니다. 인용과 원본을 다시 확인해 주세요.");
    }
  }
  if (record.submissionRecordId) {
    const events = company.applicationEvents.filter(
      (event) => event.id === record.submissionRecordId && isApplicationSubmission(event),
    );
    const event = events.length === 1 ? events[0] : undefined;
    if (!event || !isApplicationSubmission(event)) {
      missing = true;
      issues.push("연결한 수동 제출 기록을 찾을 수 없습니다.");
    } else if (
      event.plan.id !== record.planId ||
      event.plan.contentSha256 !== record.questionSnapshot.planContentSha256 ||
      event.version !== record.submissionSnapshot?.version
    )
      issues.push("수동 제출 기록과 기준 원고의 연결을 다시 확인해 주세요.");
  }
  const state = missing ? "missing" : issues.length ? "stale" : "current";
  return {
    state: state as "current" | "stale" | "missing",
    issues: [...new Set(issues)],
    reviewCurrent: state === "current" && record.review.reviewedAt !== null,
    originalCheck: "saved-only" as const,
  };
}
