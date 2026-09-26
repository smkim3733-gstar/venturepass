import { z } from "zod";
import { sourceCoordinateSchema } from "./studio-source-location-types";

export const sourceSuggestionRuleVersion = "explicit-local-fields-v1";
export const sourceSuggestionLimits = {
  candidates: 100,
  selections: 7,
  receipts: 200,
  characters: 200_000,
  requestBytes: 64 * 1024,
  previewRequestBytes: 8192,
} as const;
export const sourceSuggestionTargets = [
  "sourceKind",
  "companyName",
  "businessNumber",
  "industry",
  "foundedOn",
  "paidInCapital",
  "closingMonth",
] as const;
export const sourceSuggestionTargetLabels: Record<
  (typeof sourceSuggestionTargets)[number],
  string
> = {
  sourceKind: "자료 종류",
  companyName: "기업명",
  businessNumber: "사업자등록번호",
  industry: "업종",
  foundedOn: "설립일",
  paidInCapital: "납입자본금(원)",
  closingMonth: "결산월",
};
export type SourceSuggestionTarget = (typeof sourceSuggestionTargets)[number];
const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  timestamp = z.string().min(1).max(100),
  revision = z.number().int().nonnegative().safe();
export const sourceSuggestionBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source-text"), sourceUpdatedAt: timestamp }).strict(),
  z.object({ kind: z.literal("intake-result"), itemId: uuid, resultId: uuid }).strict(),
]);
export const sourceSuggestionPreviewInputSchema = z
  .object({ revision, sourceId: uuid, basis: sourceSuggestionBasisSchema })
  .strict();
export type SourceSuggestionPreviewInput = z.infer<typeof sourceSuggestionPreviewInputSchema>;
export const sourceSuggestionBindingSchema = z
  .object({
    ruleVersion: z.literal(sourceSuggestionRuleVersion),
    sourceId: uuid,
    sourceUpdatedAt: timestamp,
    basis: sourceSuggestionBasisSchema,
    textSha256: sha,
    locationsSha256: sha.nullable(),
    original: z
      .object({
        sourceId: uuid,
        sha256: sha,
        sizeBytes: z
          .number()
          .int()
          .nonnegative()
          .max(12 * 1024 * 1024),
        originalName: z.string().min(1).max(200),
        mimeType: z.string().max(150).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SourceSuggestionBinding = z.infer<typeof sourceSuggestionBindingSchema>;
export const sourceSuggestionIdentitySchema = z
  .object({ status: z.enum(["matched", "mismatch", "unverified"]), reason: z.string().max(500) })
  .strict();
const position = {
  quote: z.string().min(1).max(1000),
  start: z.number().int().nonnegative().max(100000),
  end: z.number().int().positive().max(100000),
  lineStart: z.number().int().positive().max(100001),
  lineEnd: z.number().int().positive().max(100001),
  coordinate: sourceCoordinateSchema.nullable(),
};
export const sourceSuggestionCandidateSchema = z
  .object({
    id: sha,
    target: z.enum(sourceSuggestionTargets),
    value: z.string().min(1).max(100),
    currentValue: z.string().max(100),
    ...position,
  })
  .strict()
  .refine(
    (value) =>
      value.end > value.start &&
      value.quote.length === value.end - value.start &&
      value.lineEnd >= value.lineStart,
    "인용 범위를 확인해 주세요.",
  );
export type SourceSuggestionCandidate = z.infer<typeof sourceSuggestionCandidateSchema>;
export const sourceSuggestionsPreviewSchema = z
  .object({
    companyRevision: revision,
    ruleVersion: z.literal(sourceSuggestionRuleVersion),
    binding: sourceSuggestionBindingSchema,
    identity: sourceSuggestionIdentitySchema,
    profileAllowed: z.boolean(),
    blockedTargets: z
      .array(
        z
          .object({
            target: z.enum(sourceSuggestionTargets),
            code: z.string().max(100),
            reason: z.string().max(500),
          })
          .strict(),
      )
      .max(sourceSuggestionLimits.selections),
    candidates: z.array(sourceSuggestionCandidateSchema).max(sourceSuggestionLimits.candidates),
    unresolved: z
      .array(
        z.object({ code: z.string().max(100), message: z.string().max(500), ...position }).strict(),
      )
      .max(sourceSuggestionLimits.candidates),
  })
  .strict();
export type SourceSuggestionsPreview = z.infer<typeof sourceSuggestionsPreviewSchema>;
export const sourceSuggestionAdoptionInputSchema = z
  .object({
    binding: sourceSuggestionBindingSchema,
    selections: z
      .array(
        z
          .object({
            candidateId: sha,
            target: z.enum(sourceSuggestionTargets),
            expectedCurrentValue: z.string().max(100),
          })
          .strict(),
      )
      .min(1)
      .max(sourceSuggestionLimits.selections),
    reviewed: z.literal(true),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.selections.map((entry) => entry.target)).size === value.selections.length &&
      new Set(value.selections.map((entry) => entry.candidateId)).size === value.selections.length,
    "항목별 제안은 하나만 선택해 주세요.",
  );
export type SourceSuggestionAdoptionInput = z.infer<typeof sourceSuggestionAdoptionInputSchema>;
export const adoptSourceSuggestionsMutationSchema = z
  .object({
    action: z.literal("adopt-source-suggestions"),
    revision,
    clientRequestId: uuid,
    ...sourceSuggestionAdoptionInputSchema.shape,
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.selections.map((entry) => entry.target)).size === value.selections.length &&
      new Set(value.selections.map((entry) => entry.candidateId)).size === value.selections.length,
    "항목별 제안은 하나만 선택해 주세요.",
  );
export const sourceSuggestionReceiptSchema = z
  .object({
    id: uuid,
    version: z.number().int().positive().max(sourceSuggestionLimits.receipts),
    clientRequestId: uuid,
    inputDigest: sha,
    recordedAt: z.string().datetime(),
    origin: z.literal("manual-local-suggestion"),
    binding: sourceSuggestionBindingSchema,
    identity: sourceSuggestionIdentitySchema,
    selections: z
      .array(
        z
          .object({
            candidateId: sha,
            target: z.enum(sourceSuggestionTargets),
            previousValue: z.string().max(100),
            value: z.string().min(1).max(100),
            ...position,
          })
          .strict(),
      )
      .min(1)
      .max(sourceSuggestionLimits.selections),
    reviewed: z.literal(true),
    profileChanged: z.boolean(),
    sourceKindChanged: z.boolean(),
    sourceUpdatedAtAfter: timestamp,
  })
  .strict();
export type SourceSuggestionReceipt = z.infer<typeof sourceSuggestionReceiptSchema>;
