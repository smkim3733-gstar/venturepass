import { z } from "zod";
import { candidateSchema, companyProfileSchema, sourceSchema } from "./studio-schema";

export const candidateRegistrySetId = "ai-validation-candidates" as const;
export const candidateRegistryNotice =
  "AI가 작성한 합성 후보의 로컬 등록본입니다. 사람 정답표·독립 검증세트·실제 AI 성능평가 완료를 뜻하지 않습니다.";
export const candidateRegistryLimits = {
  versions: 20,
  candidates: 12,
  bodyBytes: 4096,
  pinnedBytes: 8 * 1024 * 1024,
} as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(candidateRegistryLimits.versions);
const candidateId = z
  .string()
  .regex(/^validation-candidate-[a-z0-9-]+$/)
  .max(120);
const status = {
  synthetic: z.literal(true),
  authoredBy: z.literal("ai"),
  humanAnswerKey: z.null(),
  independentHoldoutConfirmed: z.literal(false),
  performanceEvaluation: z.literal("not-performed"),
};
export const candidateRegistryInputSchema = z
  .object({
    profile: companyProfileSchema,
    sources: z.array(sourceSchema).min(4).max(100),
    candidate: candidateSchema,
  })
  .strict();
export const candidateRegistryReviewerMetadataSchema = z
  .object({
    sector: z.enum(["manufacturing", "software", "service"]),
    applicationKind: z.enum(["new", "renewal"]),
    materialDesign: z.enum(["connected-narrative", "intentional-gap", "intentional-conflict"]),
    challengeTags: z.array(z.string().min(1).max(100)).max(100),
    authoringNotes: z.array(z.string().min(1).max(10000)).max(100),
  })
  .strict();
export const candidateRegistryManifestEntrySchema = z
  .object({
    candidateId,
    label: z.string().min(1).max(200),
    sourceDigest: digest,
    candidateDigest: digest,
    modelInputDigest: digest,
    reviewerMetadataDigest: digest,
  })
  .strict();
export const candidateRegistryManifestSchema = z
  .array(candidateRegistryManifestEntrySchema)
  .length(candidateRegistryLimits.candidates);
export const candidateRegistryEntrySchema = z
  .object({
    candidateId,
    label: z.string().min(1).max(200),
    input: candidateRegistryInputSchema,
    reviewerMetadata: candidateRegistryReviewerMetadataSchema,
  })
  .strict();
export const candidateRegistrySourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    setId: z.literal(candidateRegistrySetId),
    ...status,
    sourceDigest: digest,
    manifestDigest: digest,
    manifest: candidateRegistryManifestSchema,
    entries: z.array(candidateRegistryEntrySchema).length(candidateRegistryLimits.candidates),
  })
  .strict();
export const candidateRegistryRegisterSchema = z
  .object({
    expectedVersion: z.number().int().min(0).max(candidateRegistryLimits.versions),
    clientRequestId: z.string().uuid(),
    sourceDigest: digest,
    acknowledgedCandidateStatus: z.literal(true),
  })
  .strict();
export const candidateRegistrySnapshotSchema = candidateRegistrySourceSchema
  .extend({
    kind: z.literal("validation-candidate-set"),
    version,
    previousVersion: version.nullable(),
    previousDigest: digest.nullable(),
    versionDigest: digest,
    registeredAt: z.string().datetime(),
    clientRequestId: z.string().uuid(),
    notice: z.literal(candidateRegistryNotice),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.version === 1 && (value.previousVersion !== null || value.previousDigest !== null)) ||
      (value.version > 1 &&
        (value.previousVersion !== value.version - 1 || value.previousDigest === null))
    )
      context.addIssue({ code: "custom", message: "후보 등록 버전 연결이 일치하지 않습니다." });
  });
export const candidateRegistrySummarySchema = z
  .object({
    setId: z.literal(candidateRegistrySetId),
    ...status,
    version,
    previousVersion: version.nullable(),
    previousDigest: digest.nullable(),
    versionDigest: digest,
    sourceDigest: digest,
    manifestDigest: digest,
    registeredAt: z.string().datetime(),
    clientRequestId: z.string().uuid(),
    candidateCount: z.literal(12),
  })
  .strict();
export const candidateRegistryReceiptSchema = z
  .object({
    kind: z.literal("register-candidate-set"),
    setId: z.literal(candidateRegistrySetId),
    version,
    clientRequestId: z.string().uuid(),
    inputDigest: digest,
    versionDigest: digest,
  })
  .strict();
export const candidateRegistryLookupSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("committed"), receipt: candidateRegistryReceiptSchema }).strict(),
  z.object({ state: z.literal("not-observed") }).strict(),
]);
export const candidateRegistryCatalogSchema = z
  .object({
    source: candidateRegistrySourceSchema,
    versions: z.array(candidateRegistrySummarySchema).max(candidateRegistryLimits.versions),
  })
  .strict();
export const candidateRegistryRegisterResultSchema = z
  .object({ snapshot: candidateRegistrySnapshotSchema, replayed: z.boolean() })
  .strict();
export type CandidateRegistrySource = z.infer<typeof candidateRegistrySourceSchema>;
export type CandidateRegistrySnapshot = z.infer<typeof candidateRegistrySnapshotSchema>;
export type CandidateRegistrySummary = z.infer<typeof candidateRegistrySummarySchema>;
export type CandidateRegistryReceipt = z.infer<typeof candidateRegistryReceiptSchema>;
export type CandidateRegistryRegisterRequest = z.infer<typeof candidateRegistryRegisterSchema>;
export type CandidateRegistryCatalog = z.infer<typeof candidateRegistryCatalogSchema>;
export type CandidateRegistryEntry = z.infer<typeof candidateRegistryEntrySchema>;
export function candidateRegistryRequestDigestInput(input: CandidateRegistryRegisterRequest) {
  return { kind: "register-candidate-set" as const, setId: candidateRegistrySetId, input };
}
export function candidateRegistrySourceDigestInput(entries: CandidateRegistryEntry[]) {
  return { schemaVersion: 1, setId: candidateRegistrySetId, entries };
}
export function candidateRegistryVersionDigestInput(
  value: Omit<CandidateRegistrySnapshot, "versionDigest"> | CandidateRegistrySnapshot,
) {
  const { versionDigest: _ignored, ...payload } = value as CandidateRegistrySnapshot;
  void _ignored;
  return payload;
}
export function candidateRegistryDownloadName(value: number) {
  return `venturepass-quality-candidates-v${value}.json`;
}
