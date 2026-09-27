import { z } from "zod";
import {
  candidateSchema,
  companyProfileSchema,
  planContentSchema,
  sourceSchema,
} from "./studio-schema";
import {
  planQualityEvaluationSchema,
  type PlanQualityEvaluation,
} from "./studio-plan-quality-evaluation-types";
import { planQualitySummarySchema } from "./studio-plan-quality-summary-schema";
export * from "./studio-plan-quality-evaluation-types";
const labelId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const planQualityStoreLimits = {
  runs: 20,
  revisions: 200,
  recordBytes: 512 * 1024,
  createBodyBytes: 4096,
  recordBodyBytes: 768 * 1024,
  pinnedBytes: 8 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
} as const;
export const planQualityManifestEntrySchema = z
  .object({
    fixtureId: labelId,
    label: z.string().min(1),
    synthetic: z.literal(true),
    sourceDigest: digest,
    candidateDigest: digest,
    inputPlanDigest: digest,
    rubricDigest: digest,
    expectedDisposition: z.enum(["reviewable", "revise", "request-evidence"]),
    expectedChecks: z.array(z.string()),
    sufficientForCompleteDraft: z.null(),
    mustBlockSubmission: z.null(),
  })
  .strict();
export const planQualityManifestSchema = z.array(planQualityManifestEntrySchema).length(50);
export type PlanQualityManifestEntry = z.infer<typeof planQualityManifestEntrySchema>;
export const planQualityCreateRunSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    manifestDigest: digest,
  })
  .strict();
export const planQualitySaveRecordSchema = z
  .object({
    revision: z.number().int().min(0).max(planQualityStoreLimits.revisions),
    clientRequestId: z.string().uuid(),
    record: planQualityEvaluationSchema,
  })
  .strict();
export type PlanQualityCreateRunRequest = z.infer<typeof planQualityCreateRunSchema>;
export type PlanQualitySaveRecordRequest = z.infer<typeof planQualitySaveRecordSchema>;
export const planQualityReceiptSchema = z
  .object({
    kind: z.enum(["create", "record"]),
    runId: z.string().uuid(),
    revision: z.number().int().min(0),
    clientRequestId: z.string().uuid(),
    inputDigest: digest,
  })
  .strict();
export type PlanQualityReceipt = z.infer<typeof planQualityReceiptSchema>;
export const planQualityRequestResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("committed"), receipt: planQualityReceiptSchema }).strict(),
  z.object({ state: z.literal("not-observed") }).strict(),
]);
export const planQualityHistorySchema = planQualityReceiptSchema
  .extend({
    fixtureId: labelId.nullable(),
    fixtureRevision: z.number().int().min(0),
    recordDigest: digest.nullable(),
    recordedAt: z.string().datetime(),
  })
  .strict();
export const planQualityRunSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    revision: z.number().int().min(0),
    clientRequestId: z.string().uuid(),
    manifestDigest: digest,
    manifestCurrent: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordSource: z.literal("user-supplied-records"),
  })
  .strict();
export type PlanQualityRunSummary = z.infer<typeof planQualityRunSummarySchema>;
export const planQualityRunSnapshotSchema = planQualityRunSummarySchema
  .extend({
    currentRevision: z.number().int().min(0),
    manifest: planQualityManifestSchema,
    records: z.array(planQualityEvaluationSchema).length(50),
    history: z
      .array(planQualityHistorySchema)
      .min(1)
      .max(planQualityStoreLimits.revisions + 1),
    summary: planQualitySummarySchema.nullable(),
  })
  .strict();
export type PlanQualityRunSnapshot = z.infer<typeof planQualityRunSnapshotSchema>;
export const planQualityArchiveSchema = planQualityRunSnapshotSchema
  .omit({ currentRevision: true, manifestCurrent: true, summary: true })
  .extend({
    schemaVersion: z.literal(1),
    notice: z.literal(
      "사용자가 입력한 평가 기록입니다. 실제 실행·비용·독립 평가 완료를 자동으로 증명하지 않습니다.",
    ),
  })
  .strict();
export const planQualityCatalogSchema = z
  .object({
    manifestDigest: digest,
    manifest: planQualityManifestSchema,
    runs: z.array(planQualityRunSummarySchema).max(planQualityStoreLimits.runs),
  })
  .strict();
export const planQualityMutationResultSchema = z
  .object({ run: planQualityRunSnapshotSchema, replayed: z.boolean() })
  .strict();
export const planQualityFixtureSchema = z
  .object({
    id: labelId,
    label: z.string(),
    synthetic: z.literal(true),
    profile: companyProfileSchema,
    sources: z.array(sourceSchema),
    candidate: candidateSchema,
    plan: planContentSchema,
    semanticRubric: z
      .object({
        expectedDisposition: z.enum(["reviewable", "revise", "request-evidence"]),
        expectedChecks: z.array(z.string()),
        ruleGateLimitation: z.string(),
      })
      .strict(),
    deterministicExpectation: z
      .object({
        requiredFindings: z.array(
          z
            .object({
              category: z.string(),
              severity: z.enum(["error", "warning", "info"]),
              sectionKey: z.string().nullable().optional(),
            })
            .strict(),
        ),
        forbiddenCategories: z.array(z.string()),
        errorCount: z.number().int().optional(),
      })
      .strict(),
  })
  .strict();
export const planQualityFixtureResponseSchema = z
  .object({ fixture: planQualityFixtureSchema, template: planQualityEvaluationSchema })
  .strict();
export type PlanQualityStoredFixture = z.infer<typeof planQualityFixtureSchema>;
export function createPlanQualityRecordTemplate(
  entry: PlanQualityManifestEntry,
): PlanQualityEvaluation {
  const { fixtureId, sourceDigest, candidateDigest, inputPlanDigest, rubricDigest } = entry;
  return {
    schemaVersion: 1,
    fixtureId,
    sourceDigest,
    candidateDigest,
    inputPlanDigest,
    rubricDigest,
    answerKey: null,
    execution: null,
    humanReviews: [],
    resolution: null,
  };
}
/** Canonical object passed to SHA256; nonce is included and object keys must be sorted recursively. */
export function planQualityRequestDigestInput(
  kind: "create",
  input: PlanQualityCreateRunRequest,
): unknown;
export function planQualityRequestDigestInput(
  kind: "record",
  input: PlanQualitySaveRecordRequest,
  runId: string,
): unknown;
export function planQualityRequestDigestInput(
  kind: "create" | "record",
  input: PlanQualityCreateRunRequest | PlanQualitySaveRecordRequest,
  runId?: string,
) {
  return kind === "create" ? { kind, input } : { kind, runId, input };
}
export function planQualityDownloadName(runId: string, revision: number) {
  return `venturepass-quality-${runId}-r${revision}.json`;
}
