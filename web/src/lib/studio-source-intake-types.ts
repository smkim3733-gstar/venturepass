import { z } from "zod";
import type { StudioCase } from "./studio-schema";
import {
  runExternalSourceIntakeSchema,
  sourceIntakeAudioExtensions,
  sourceIntakeExternalAttemptSchema,
  sourceIntakeExternalSupports,
} from "./studio-source-intake-external-types";
import {
  sourceLocationMetadataSchema,
  type SourceLocationMetadata,
} from "./studio-source-location-types";

export const sourceIntakeLimits = {
  filesPerBatch: 10,
  fileBytes: 12 * 1024 * 1024,
  batchBytes: 24 * 1024 * 1024,
  items: 100,
  attempts: 10,
  requests: 20,
  resultText: 100_000,
  retainedText: 500_000,
} as const;
export const sourceIntakeExtensions = [
  "pdf",
  "docx",
  "xlsx",
  "txt",
  "md",
  "csv",
  "tsv",
  "srt",
  "vtt",
  "png",
  "jpg",
  "jpeg",
  "webp",
  ...sourceIntakeAudioExtensions,
] as const;
export const sourceIntakeLocalEngineSchema = z.enum(["local-document", "windows-ko"]);
export type SourceIntakeLocalEngine = z.infer<typeof sourceIntakeLocalEngineSchema>;
export const sourceIntakeEngineSchema = z.enum([
  "local-document",
  "windows-ko",
  "ai-document",
  "ai-transcription",
]);
export type SourceIntakeEngine = z.infer<typeof sourceIntakeEngineSchema>;
export function sourceIntakeExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
export function sourceIntakeEngineSupports(name: string, engine: SourceIntakeEngine) {
  if (engine === "ai-document" || engine === "ai-transcription")
    return sourceIntakeExternalSupports(name, engine);
  const extension = sourceIntakeExtension(name);
  return engine === "windows-ko"
    ? ["pdf", "png", "jpg", "jpeg", "webp"].includes(extension)
    : ["pdf", "docx", "xlsx", "txt", "md", "csv", "tsv", "srt", "vtt"].includes(extension);
}
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();
const at = z.string().datetime();
export const sourceIntakeNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      name === name.trim() &&
      !/[\\/:\u0000-\u001f\u007f]/.test(name) &&
      !/[. ]$/.test(name) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
      (sourceIntakeExtensions as readonly string[]).includes(sourceIntakeExtension(name)),
    "지원되는 파일명만 사용할 수 있습니다.",
  );
const mime = z
  .string()
  .min(1)
  .max(150)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?charset=(?:utf-8|us-ascii))?$/i,
  )
  .refine((value) => !value.includes(";") || value.toLowerCase().startsWith("text/"));
const kind = z.enum(["consultation", "patent", "technology", "finance", "market", "team", "other"]);
const file = z
  .object({
    clientFileId: uuid,
    originalName: sourceIntakeNameSchema,
    kind,
    sizeBytes: z.number().int().min(1).max(sourceIntakeLimits.fileBytes),
  })
  .strict();
const common = { revision, clientRequestId: uuid };
const target = { ...common, itemId: uuid, expectedItemVersion: z.number().int().positive().safe() };
export const createSourceIntakeSchema = z
  .object({
    action: z.literal("create"),
    ...common,
    files: z.array(file).min(1).max(sourceIntakeLimits.filesPerBatch),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.files.map((entry) => entry.clientFileId)).size === value.files.length &&
      value.files.reduce((sum, entry) => sum + entry.sizeBytes, 0) <= sourceIntakeLimits.batchBytes,
    "파일 식별자 중복 또는 접수 용량 초과입니다.",
  );
export const sourceIntakeOriginalInputSchema = z
  .object({ ...common, expectedItemVersion: z.number().int().positive().safe() })
  .strict();
export const runSourceIntakeSchema = z
  .object({ action: z.literal("run-next"), ...target, engine: sourceIntakeLocalEngineSchema })
  .strict();
export const resumeSourceIntakeSchema = z
  .object({ action: z.literal("resume"), ...target })
  .strict();
export const adoptSourceIntakeSchema = z
  .object({
    action: z.literal("adopt"),
    ...target,
    resultId: uuid,
    sourceUpdatedAt: at,
    originalSha256: sha,
    text: z.string().trim().min(1).max(sourceIntakeLimits.resultText),
    reviewed: z.literal(true),
  })
  .strict();
export const discardSourceIntakeSchema = z
  .object({
    action: z.literal("discard-result"),
    ...target,
    resultId: uuid,
    confirmed: z.literal(true),
  })
  .strict();
export const cancelSourceIntakeSchema = z
  .object({ action: z.literal("cancel-awaiting-original"), ...target, confirmed: z.literal(true) })
  .strict();
export const sourceIntakeCommandSchema = z.union([
  createSourceIntakeSchema,
  runSourceIntakeSchema,
  resumeSourceIntakeSchema,
  adoptSourceIntakeSchema,
  discardSourceIntakeSchema,
  cancelSourceIntakeSchema,
  runExternalSourceIntakeSchema,
]);
export type SourceIntakeCommand = z.infer<typeof sourceIntakeCommandSchema>;
export type CreateSourceIntakeCommand = z.infer<typeof createSourceIntakeSchema>;
export type RunSourceIntakeCommand = z.infer<typeof runSourceIntakeSchema>;
export type ResumeSourceIntakeCommand = z.infer<typeof resumeSourceIntakeSchema>;
export type AdoptSourceIntakeCommand = z.infer<typeof adoptSourceIntakeSchema>;
export type DiscardSourceIntakeCommand = z.infer<typeof discardSourceIntakeSchema>;
export type CancelSourceIntakeCommand = z.infer<typeof cancelSourceIntakeSchema>;
export type SourceIntakeOriginalInput = z.infer<typeof sourceIntakeOriginalInputSchema>;
export const sourceIntakeContentSchema = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("plain"), text: z.string().max(sourceIntakeLimits.resultText) })
      .strict(),
    z
      .object({
        kind: z.literal("pages"),
        pages: z
          .array(
            z
              .object({
                pageNumber: z.number().int().positive().max(120),
                text: z.string().max(sourceIntakeLimits.resultText),
              })
              .strict(),
          )
          .min(1)
          .max(120),
      })
      .strict(),
  ])
  .refine(
    (content) =>
      content.kind !== "pages" ||
      content.pages.every((page, index) => page.pageNumber === index + 1),
    "페이지 번호가 연속되어야 합니다.",
  );
export type SourceIntakeContent = z.infer<typeof sourceIntakeContentSchema>;
export function sourceIntakeResultText(content: SourceIntakeContent): string {
  return content.kind === "plain"
    ? content.text
    : content.pages.map((page) => `[페이지 ${page.pageNumber}]\n${page.text}`).join("\n\n");
}
export const sourceIntakePhaseSchema = z.enum([
  "awaiting_original",
  "storing_original",
  "original_stored",
  "extracting_local",
  "awaiting_method",
  "awaiting_review",
  "awaiting_capacity",
  "retryable_failure",
  "adopted",
  "result_discarded",
  "cancelled",
  "requesting_external",
  "external_result_unknown",
]);
export const sourceIntakePhaseLabels: Record<z.infer<typeof sourceIntakePhaseSchema>, string> = {
  awaiting_original: "원본 업로드 대기",
  storing_original: "원본 저장 확인 필요",
  original_stored: "원본 보관 완료",
  extracting_local: "로컬 판독 진행 중",
  awaiting_method: "판독 방법 선택 필요",
  awaiting_review: "판독문 검토 대기",
  awaiting_capacity: "보관 한도 확인 필요",
  retryable_failure: "재시도 가능 오류",
  adopted: "검토 본문 채택됨",
  result_discarded: "미검토 판독문 폐기됨",
  cancelled: "원본 미접수 항목 취소됨",
  requesting_external: "외부 요청 진행 또는 결과 확인 필요",
  external_result_unknown: "외부 처리 결과 미확인 · 자동 재전송 안 함",
};
const result = z
  .object({
    id: uuid,
    attemptId: uuid,
    engine: sourceIntakeEngineSchema,
    generatedAt: at,
    originalSha256: sha,
    sourceUpdatedAt: at,
    textSha256: sha,
    content: sourceIntakeContentSchema.nullable(),
    locations: sourceLocationMetadataSchema.optional(),
    warnings: z.array(z.string().max(1000)).max(30),
    reviewStatus: z.literal("unreviewed"),
    discardedAt: at.nullable(),
  })
  .strict();
export const sourceIntakeItemSchema = z
  .object({
    id: uuid,
    batchId: uuid,
    clientFileId: uuid,
    sourceId: uuid,
    version: z.number().int().positive().safe(),
    declared: file.omit({ clientFileId: true }),
    original: z
      .object({
        originalName: sourceIntakeNameSchema,
        mimeType: mime.nullable(),
        sizeBytes: z.number().int().min(1).max(sourceIntakeLimits.fileBytes),
        sha256: sha,
        sourceUpdatedAt: at,
      })
      .strict()
      .nullable(),
    phase: sourceIntakePhaseSchema,
    attempts: z
      .array(
        z.union([
          z
            .object({
              id: uuid,
              engine: sourceIntakeLocalEngineSchema,
              startedAt: at,
              finishedAt: at.nullable(),
              originalSha256: sha,
              sourceUpdatedAt: at,
              externalRequestStarted: z.literal(false),
              status: z.enum(["running", "completed", "failed"]),
              code: z.string().max(100).nullable(),
              resultId: uuid.nullable(),
            })
            .strict(),
          sourceIntakeExternalAttemptSchema,
        ]),
      )
      .max(sourceIntakeLimits.attempts),
    result: result.nullable(),
    previousResults: z.array(result).max(sourceIntakeLimits.attempts),
    adoption: z
      .object({
        id: uuid,
        clientRequestId: uuid,
        inputDigest: sha,
        resultId: uuid,
        resultTextSha256: sha,
        adoptedTextSha256: sha,
        sourceUpdatedAt: at,
        adoptedAt: at,
      })
      .strict()
      .nullable(),
    requests: z
      .array(
        z
          .object({
            clientRequestId: uuid,
            inputDigest: sha,
            action: z.enum([
              "create",
              "original",
              "run-next",
              "resume",
              "adopt",
              "discard-result",
              "cancel-awaiting-original",
              "run-external",
            ]),
          })
          .strict(),
      )
      .max(sourceIntakeLimits.requests),
    createdAt: at,
    updatedAt: at,
    code: z.string().max(100).nullable(),
  })
  .strict();
export type SourceIntakeItem = z.infer<typeof sourceIntakeItemSchema>;
export type SourceIntakeResponse = {
  company: StudioCase;
  batchId: string;
  item: SourceIntakeItem | null;
};
export type SourceIntakeStatus = { company: StudioCase; activeItemIds: string[] };
export type SourceIntakeAttemptBinding = {
  revision: number;
  itemId: string;
  itemVersion: number;
  attemptId: string;
};
export type SourceIntakeOutcome =
  | {
      status: "completed";
      content: SourceIntakeContent;
      warnings: string[];
      locations?: SourceLocationMetadata;
    }
  | {
      status: "failed";
      code: string;
      phase: "awaiting_method" | "retryable_failure" | "awaiting_capacity";
    };
