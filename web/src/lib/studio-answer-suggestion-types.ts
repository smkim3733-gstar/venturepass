import { z } from "zod";
import { sourceCoordinateSchema } from "./studio-source-location-types";

export const answerSuggestionRuleVersion = "exact-excerpts-v1" as const;
export const answerSuggestionLimits = {
  sources: 6,
  sourceCharacters: 60_000,
  candidates: 10,
  quote: 1500,
  requestBytes: 64 * 1024,
  approvalMs: 120_000,
  approvals: 20,
} as const;
const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.number().int().nonnegative().safe(),
  offset = z.number().int().nonnegative().max(100_000);
const quote = z
  .string()
  .min(1)
  .max(answerSuggestionLimits.quote)
  .refine((value) => Boolean(value.trim()));
export const answerSuggestionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agency-request"),
      requestRecordId: uuid,
      requestVersionId: uuid,
      quote,
      start: offset,
      end: offset,
    })
    .strict(),
  z
    .object({
      kind: z.literal("visit-question"),
      planId: uuid,
      planVersion: z.number().int().positive(),
      questionIndex: z.number().int().min(0).max(29),
      questionText: z.string().min(1).max(3000),
      questionSha256: sha,
    })
    .strict(),
]);
export type AnswerSuggestionTarget = z.infer<typeof answerSuggestionTargetSchema>;
export const answerSuggestionSourceSelectionSchema = z
  .object({ sourceId: uuid, sourceUpdatedAt: z.string().min(1).max(100), textSha256: sha })
  .strict();
export const answerSuggestionInputSchema = z
  .object({
    revision,
    target: answerSuggestionTargetSchema,
    sourceSelections: z
      .array(answerSuggestionSourceSelectionSchema)
      .min(1)
      .max(answerSuggestionLimits.sources)
      .refine((items) => new Set(items.map((item) => item.sourceId)).size === items.length),
  })
  .strict();
export type AnswerSuggestionInput = z.infer<typeof answerSuggestionInputSchema>;
export const answerSuggestionBindingSchema = z
  .object({
    caseId: uuid,
    companyRevision: revision,
    target: answerSuggestionTargetSchema,
    targetSha256: sha,
    sources: z
      .array(
        answerSuggestionSourceSelectionSchema.extend({
          sourceName: z.string().min(1).max(200),
          characters: z.number().int().min(1).max(answerSuggestionLimits.sourceCharacters),
          locationsSha256: sha.nullable(),
        }),
      )
      .min(1)
      .max(answerSuggestionLimits.sources),
    inputSha256: sha,
  })
  .strict();
export type AnswerSuggestionBinding = z.infer<typeof answerSuggestionBindingSchema>;
export const answerSuggestionCandidateSchema = z
  .object({
    id: sha,
    sourceId: uuid,
    sourceName: z.string().min(1).max(200),
    sourceUpdatedAt: z.string().min(1).max(100),
    textSha256: sha,
    start: offset,
    end: offset,
    quote,
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    coordinate: sourceCoordinateSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.end > value.start &&
      value.end - value.start === value.quote.length &&
      value.lineEnd >= value.lineStart,
  );
export type AnswerSuggestionCandidate = z.infer<typeof answerSuggestionCandidateSchema>;
export const answerSuggestionsSchema = z
  .object({
    ruleVersion: z.literal(answerSuggestionRuleVersion),
    mode: z.enum(["assisted", "ai"]),
    model: z.string().max(100).nullable(),
    binding: answerSuggestionBindingSchema,
    candidates: z.array(answerSuggestionCandidateSchema).max(answerSuggestionLimits.candidates),
    followUpQuestions: z.array(z.string().max(500)).max(5),
    warnings: z.array(z.string().max(500)).max(10),
    reviewStatus: z.literal("unreviewed"),
    originalCheck: z.literal("not-read"),
    databaseChanged: z.literal(false),
  })
  .strict();
export type AnswerSuggestions = z.infer<typeof answerSuggestionsSchema>;
export const answerSuggestionAiSelectionSchema = z
  .object({
    selections: z
      .array(z.object({ sourceId: uuid, start: offset, end: offset, quote }).strict())
      .max(answerSuggestionLimits.candidates),
  })
  .strict();
export type AnswerSuggestionAiSelection = z.infer<typeof answerSuggestionAiSelectionSchema>;
export const answerSuggestionApprovalSchema = z
  .object({
    token: uuid,
    expiresAt: z.string().datetime(),
    binding: answerSuggestionBindingSchema,
    provider: z.literal("openai"),
    destination: z.literal("https://api.openai.com/v1/responses"),
    purpose: z.literal("select-exact-answer-excerpts"),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
    payloadSha256: sha,
  })
  .strict();
export type AnswerSuggestionApproval = z.infer<typeof answerSuggestionApprovalSchema>;
export const answerSuggestionTransmissionSchema = z
  .object({
    targetText: z.string().min(1).max(3000),
    sources: z
      .array(
        z
          .object({
            sourceId: uuid,
            sourceName: z.string().min(1).max(200),
            text: z.string().min(1).max(answerSuggestionLimits.sourceCharacters),
          })
          .strict(),
      )
      .min(1)
      .max(answerSuggestionLimits.sources),
  })
  .strict();
export type AnswerSuggestionTransmission = z.infer<typeof answerSuggestionTransmissionSchema>;
export const answerSuggestionAiPreviewSchema = z
  .object({
    approval: answerSuggestionApprovalSchema,
    transmission: answerSuggestionTransmissionSchema,
    externalTransmissionPerformed: z.literal(false),
  })
  .strict();
export type AnswerSuggestionAiPreview = z.infer<typeof answerSuggestionAiPreviewSchema>;
export const answerSuggestionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("local"), input: answerSuggestionInputSchema }).strict(),
  z.object({ action: z.literal("prepare-ai"), input: answerSuggestionInputSchema }).strict(),
  z
    .object({
      action: z.literal("run-ai"),
      input: answerSuggestionInputSchema,
      approval: answerSuggestionApprovalSchema,
      approved: z.literal(true),
    })
    .strict(),
]);
export type AnswerSuggestionCommand = z.infer<typeof answerSuggestionCommandSchema>;

/** Fixed unreviewed text only. Selected excerpts remain attributed quotations, not verified facts. */
export function answerSuggestionDraft(
  target: AnswerSuggestionTarget,
  candidates: AnswerSuggestionCandidate[],
) {
  const prompt = target.kind === "agency-request" ? target.quote : target.questionText;
  return [
    "[미검토 답변 준비 · 실제 발언·기관 발송·사실 확인 아님]",
    `요청·질문: ${prompt}`,
    "선택한 등록 자료의 원문:",
    ...candidates.map(
      (item) => `- ${item.quote} (${item.sourceName}, 등록 본문 ${item.lineStart}행)`,
    ),
    "[담당자 확인 필요: 인용의 대상·기간·맥락과 실제 답변을 원본에 대조하여 작성하세요.]",
  ].join("\n");
}
