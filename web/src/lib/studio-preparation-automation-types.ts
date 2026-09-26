import { z } from "zod";

export const preparationAutomationLimits = {
  settings: 50,
  disableReserve: 1,
  events: 200,
  batches: 50,
  requests: 20,
  characters: 250_000,
} as const;
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.number().int().nonnegative().safe(),
  at = z.string().datetime();
const unique = (ids: string[]) => ids.length === new Set(ids).size;
export const preparationAutomationSettingSchema = z
  .object({
    id: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    version: revision.refine((value) => value > 0),
    enabled: z.boolean(),
    baselineFingerprint: hash,
    at,
  })
  .strict();
export const preparationAutomationEventSchema = z
  .object({
    id: uuid,
    kind: z.enum(["profile", "source", "agency-request", "agency-response"]),
    targetId: uuid,
    targetVersion: z.string().max(100),
    change: z.enum(["added", "updated", "removed"]),
    sourceReadiness: z.enum(["ready", "pending", "empty"]).nullable(),
    beforeSha256: hash.nullable(),
    afterSha256: hash.nullable(),
    changeDigest: hash,
    settingVersion: revision,
    companyRevision: revision,
    at,
  })
  .strict();
export const preparationAutomationCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), clientRequestId: uuid }).strict(),
  z.object({ action: z.literal("resume"), clientRequestId: uuid, runId: uuid }).strict(),
  z
    .object({
      action: z.literal("continue"),
      clientRequestId: uuid,
      runId: uuid,
      candidateId: z.string().min(1).max(300),
      candidateDigest: hash,
    })
    .strict(),
]);
export const preparationAutomationBatchSchema = z
  .object({
    id: uuid,
    settingVersion: revision,
    inputFingerprint: hash,
    eventIds: z.array(uuid).min(1).max(preparationAutomationLimits.events).refine(unique),
    pendingSourceIds: z.array(uuid).max(40).refine(unique),
    agencyRecordIds: z.array(uuid).max(preparationAutomationLimits.events).refine(unique),
    status: z.enum([
      "running",
      "awaiting_choice",
      "awaiting_materials",
      "awaiting_review",
      "source-review",
      "request-review",
      "failed",
      "blocked",
      "superseded",
    ]),
    code: z
      .enum([
        "AUTOMATION_SOURCE_REVIEW",
        "AUTOMATION_REQUEST_REVIEW",
        "AUTOMATION_MATERIALS_REQUIRED",
        "AUTOMATION_STALE",
        "AUTOMATION_DISABLED",
        "AUTOMATION_PREPARATION_FAILED",
      ])
      .nullable(),
    command: preparationAutomationCommandSchema.nullable(),
    preparationRunId: uuid.nullable(),
    requests: z
      .array(
        z
          .object({ clientRequestId: uuid, digest: hash, preparationRequestId: uuid.nullable() })
          .strict(),
      )
      .min(1)
      .max(preparationAutomationLimits.requests),
    createdAt: at,
    updatedAt: at,
  })
  .strict();
export const preparationAutomationSchema = z
  .object({
    caseId: uuid.nullable(),
    settings: z
      .array(preparationAutomationSettingSchema)
      .max(preparationAutomationLimits.settings + preparationAutomationLimits.disableReserve),
    events: z.array(preparationAutomationEventSchema).max(preparationAutomationLimits.events),
    batches: z.array(preparationAutomationBatchSchema).max(preparationAutomationLimits.batches),
    overflow: z.object({ at, companyRevision: revision, changeDigest: hash }).strict().nullable(),
  })
  .strict();
export type PreparationAutomation = z.infer<typeof preparationAutomationSchema>;
export type PreparationAutomationSetting = z.infer<typeof preparationAutomationSettingSchema>;
export type PreparationAutomationEvent = z.infer<typeof preparationAutomationEventSchema>;
export type PreparationAutomationBatch = z.infer<typeof preparationAutomationBatchSchema>;
export type PreparationAutomationCommand = z.infer<typeof preparationAutomationCommandSchema>;
export const emptyPreparationAutomation = (): PreparationAutomation => ({
  caseId: null,
  settings: [],
  events: [],
  batches: [],
  overflow: null,
});
export const currentPreparationAutomationSetting = (state?: PreparationAutomation) =>
  state?.settings.at(-1) ?? null;
export const preparationAutomationEnabled = (state?: PreparationAutomation) =>
  currentPreparationAutomationSetting(state)?.enabled ?? false;
const request = { revision, clientRequestId: uuid, expectedSettingVersion: revision };
export const preparationAutomationSettingInputSchema = z
  .object({ action: z.literal("set-preparation-automation"), ...request, enabled: z.boolean() })
  .strict();
export type PreparationAutomationSettingInput = z.infer<
  typeof preparationAutomationSettingInputSchema
>;
export const preparationAutomationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run-pending"), ...request }).strict(),
  z.object({ action: z.literal("resume-batch"), ...request, batchId: uuid }).strict(),
  z
    .object({
      action: z.literal("continue-batch"),
      ...request,
      batchId: uuid,
      candidateId: z.string().min(1).max(300),
      candidateDigest: hash,
    })
    .strict(),
]);
export type PreparationAutomationRequest = z.infer<typeof preparationAutomationRequestSchema>;
// This is a UI admission check, not authorization. Server still verifies company/CAS/permission.
export function canRequestPreparationAutomation(input: {
  enabled: boolean;
  overflow: boolean;
  sameCompanyRevision: boolean;
  visible: boolean;
  dirty: boolean;
  busy: boolean;
  officialInput: boolean;
}) {
  return (
    input.enabled &&
    !input.overflow &&
    input.sameCompanyRevision &&
    input.visible &&
    !input.dirty &&
    !input.busy &&
    !input.officialInput
  );
}
