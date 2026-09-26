import { z } from "zod";

// New opt-in contract. Existing local intake records receive no defaults or extra fields.
export const sourceIntakeExternalEngines = ["ai-document", "ai-transcription"] as const;
export const sourceIntakeExternalEngineSchema = z.enum(sourceIntakeExternalEngines);
export type SourceIntakeExternalEngine = z.infer<typeof sourceIntakeExternalEngineSchema>;
export const sourceIntakeExternalLimits = {
  fileBytes: 12 * 1024 * 1024,
  resultText: 100_000,
  requestBytes: 8192,
} as const;
export const sourceIntakeAudioExtensions = ["mp3", "m4a", "wav", "webm"] as const;
export const sourceIntakeExternalDocumentExtensions = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;
export const sourceIntakeExternalEngineLabels = {
  "ai-document": "OpenAI 문서 판독",
  "ai-transcription": "OpenAI 음성 전사",
} as const;
export const sourceIntakeExternalDestinations = {
  "ai-document": "https://api.openai.com/v1/responses",
  "ai-transcription": "https://api.openai.com/v1/audio/transcriptions",
} as const;
export const sourceIntakeExternalPurposes = {
  "ai-document": "document-text-extraction",
  "ai-transcription": "audio-transcription",
} as const;
export const sourceIntakeExternalPurposeLabels = {
  "document-text-extraction": "선택한 원본에서 검토 전 문서 본문 추출",
  "audio-transcription": "선택한 원본에서 검토 전 음성 본문 전사",
} as const;
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().safe();
const revision = z.number().int().nonnegative().safe();
export const sourceIntakeExternalModelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
export const sourceIntakeExternalNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => {
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return (
      name.lastIndexOf(".") > 0 &&
      name === name.trim() &&
      !/[\\/:\u0000-\u001f\u007f]/.test(name) &&
      !/[. ]$/.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
      (
        [...sourceIntakeAudioExtensions, ...sourceIntakeExternalDocumentExtensions] as string[]
      ).includes(extension)
    );
  }, "지원되는 원본 파일명을 확인해 주세요.");
const settings = {
  engine: sourceIntakeExternalEngineSchema,
  provider: z.literal("openai"),
  destination: z.enum([
    sourceIntakeExternalDestinations["ai-document"],
    sourceIntakeExternalDestinations["ai-transcription"],
  ]),
  model: sourceIntakeExternalModelSchema,
  purpose: z.enum([
    sourceIntakeExternalPurposes["ai-document"],
    sourceIntakeExternalPurposes["ai-transcription"],
  ]),
};
function matchingSettings(value: {
  engine: SourceIntakeExternalEngine;
  destination: string;
  purpose: string;
}) {
  return (
    value.destination === sourceIntakeExternalDestinations[value.engine] &&
    value.purpose === sourceIntakeExternalPurposes[value.engine]
  );
}
export const sourceIntakeExternalConfigurationSchema = z
  .object(settings)
  .strict()
  .refine(matchingSettings, "처리 방식과 고정 전송 대상을 확인해 주세요.");
export type SourceIntakeExternalConfiguration = z.infer<
  typeof sourceIntakeExternalConfigurationSchema
>;
export const sourceIntakeExternalApprovalSchema = z
  .object({
    version: z.literal(1),
    caseId: uuid,
    itemId: uuid,
    itemVersion: version,
    sourceId: uuid,
    sourceUpdatedAt: z.string().datetime(),
    originalSha256: sha,
    originalName: sourceIntakeExternalNameSchema,
    mimeType: z.string().max(150).nullable(),
    sizeBytes: z.number().int().min(1).max(sourceIntakeExternalLimits.fileBytes),
    ...settings,
  })
  .strict()
  .refine(matchingSettings, "처리 방식과 고정 전송 대상을 확인해 주세요.");
export type SourceIntakeExternalApproval = z.infer<typeof sourceIntakeExternalApprovalSchema>;
export const runExternalSourceIntakeSchema = z
  .object({
    action: z.literal("run-external"),
    revision,
    clientRequestId: uuid,
    itemId: uuid,
    expectedItemVersion: version,
    approval: sourceIntakeExternalApprovalSchema,
    approved: z.literal(true),
    acknowledgePossibleDuplicate: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.itemId === value.approval.itemId &&
      value.expectedItemVersion === value.approval.itemVersion,
    "승인한 접수 항목과 현재 버전을 확인해 주세요.",
  );
export type RunExternalSourceIntakeCommand = z.infer<typeof runExternalSourceIntakeSchema>;
export const sourceIntakeExternalApprovalPreviewInputSchema = z
  .object({
    revision,
    itemId: uuid,
    expectedItemVersion: version,
    engine: sourceIntakeExternalEngineSchema,
  })
  .strict();
export type SourceIntakeExternalApprovalPreviewInput = z.infer<
  typeof sourceIntakeExternalApprovalPreviewInputSchema
>;
export const sourceIntakeExternalApprovalPreviewSchema = z
  .object({
    companyRevision: revision,
    approval: sourceIntakeExternalApprovalSchema,
    requiresDuplicateAcknowledgement: z.boolean(),
    externalTransmissionPerformed: z.literal(false),
  })
  .strict();
export type SourceIntakeExternalApprovalPreview = z.infer<
  typeof sourceIntakeExternalApprovalPreviewSchema
>;
export const sourceIntakeExternalAttemptSchema = z
  .object({
    id: uuid,
    engine: sourceIntakeExternalEngineSchema,
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    originalSha256: sha,
    sourceUpdatedAt: z.string().datetime(),
    // Written BEFORE the provider call. True means transmission may have begun, not proof of receipt.
    externalRequestStarted: z.literal(true),
    externalApproval: sourceIntakeExternalApprovalSchema,
    approvalSha256: sha,
    clientRequestId: uuid,
    acknowledgePossibleDuplicate: z.boolean(),
    status: z.enum(["running", "completed", "unknown"]),
    code: z.string().max(100).nullable(),
    resultId: uuid.nullable(),
  })
  .strict();
export type SourceIntakeExternalAttempt = z.infer<typeof sourceIntakeExternalAttemptSchema>;
export const sourceIntakeExternalOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      content: z
        .object({
          kind: z.literal("plain"),
          text: z
            .string()
            .min(1)
            .max(sourceIntakeExternalLimits.resultText)
            .refine((value) => Boolean(value.trim())),
        })
        .strict(),
      warnings: z.array(z.string().max(1000)).max(30),
    })
    .strict(),
  z
    .object({ status: z.literal("unknown"), code: z.literal("INTAKE_EXTERNAL_RESULT_UNKNOWN") })
    .strict(),
]);
export type SourceIntakeExternalOutcome = z.infer<typeof sourceIntakeExternalOutcomeSchema>;
export function sourceIntakeExternalSupports(name: string, engine: SourceIntakeExternalEngine) {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (
    engine === "ai-document"
      ? sourceIntakeExternalDocumentExtensions
      : (sourceIntakeAudioExtensions as readonly string[])
  ).includes(extension);
}
export function sourceIntakeExternalConfiguration(
  engine: SourceIntakeExternalEngine,
  model: string,
): SourceIntakeExternalConfiguration {
  return sourceIntakeExternalConfigurationSchema.parse({
    engine,
    model,
    provider: "openai",
    destination: sourceIntakeExternalDestinations[engine],
    purpose: sourceIntakeExternalPurposes[engine],
  });
}
