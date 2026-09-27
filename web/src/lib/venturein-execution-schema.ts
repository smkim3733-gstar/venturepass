import { z } from "zod";
import { preparedPackageSummarySchema } from "./studio-prepared-package-types";
import { ventureTextSourceSchema } from "./venturein-preflight";
import type {
  VentureResolvedText,
  VentureResolvedAttachment,
  VenturePreflightIssue,
} from "./venturein-preflight";

const revision = z.number().int().nonnegative().safe();
/** Unknown/new failure codes require a separate review before recovery can be enabled. */
export const ventureRecoverableCodes = [
  "TARGET_CHANGED",
  "TARGET_NOT_EMPTY",
  "TARGET_AMBIGUOUS",
  "TARGET_UNSTABLE",
  "TARGET_FORBIDDEN",
  "VALUE_UNCONFIRMED",
  "SCREEN_CHANGED",
  "COMPANY_UNVERIFIED",
  "SCREEN_INCOMPLETE",
  "INVALID_INPUT",
  "INVALID_VALUE",
  "SESSION_CHANGED",
  "PRESERVED_TARGET_CHANGED",
] as const;
export const ventureExecutionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("compare-prepared-package"),
      revision,
      accountRevision: revision,
      companyRevision: revision,
      preparedPackageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("compare"),
      revision,
      accountRevision: revision,
      companyRevision: revision,
    })
    .strict(),
  z
    .object({
      action: z.literal("prepare"),
      revision,
      accountRevision: revision,
      companyRevision: revision,
      preparedPackageId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("execute"), token: z.string().uuid(), approved: z.literal(true) })
    .strict(),
  z
    .object({
      action: z.literal("prepare-recovery"),
      revision,
      accountRevision: revision,
      companyRevision: revision,
    })
    .strict(),
  z
    .object({
      action: z.literal("execute-recovery"),
      token: z.string().uuid(),
      approved: z.literal(true),
    })
    .strict(),
]);

export const ventureInputComparisonFieldSchema = z
  .object({
    fieldKey: z.string().min(1).max(256),
    kind: z.enum(["text", "file"]),
    state: z.enum(["matched", "empty", "conflict", "unknown"]),
    code: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(100)
      .nullable(),
  })
  .strict();
export type VentureInputComparisonField = z.infer<typeof ventureInputComparisonFieldSchema>;
export type VentureInputComparison = {
  scope: "current-mapping";
  observedAt: string;
  workflowRevision: number;
  companyRevision: number;
  accountRevision: number;
  snapshotId: string;
  sessionStartedAt: string;
  fields: VentureInputComparisonField[];
};

const fieldKeys = z.array(z.string().min(1).max(256)).max(50);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const venturePreparedBindingManifestSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal("selected-prepared-fields"),
    caseId: z.string().uuid(),
    companyRevision: revision,
    package: z
      .object({
        id: z.string().uuid(),
        version: z.number().int().positive().max(20),
        caseRevision: revision,
        createdAt: z.string().datetime(),
        zipSha256: sha256,
        zipSizeBytes: z
          .number()
          .int()
          .positive()
          .max(28 * 1024 * 1024),
      })
      .strict(),
    plan: z
      .object({
        id: z.string().uuid(),
        version: z.number().int().positive().safe(),
        contentSha256: sha256,
      })
      .strict(),
    targets: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("text"),
              fieldKey: z.string().min(1).max(256),
              source: ventureTextSourceSchema,
              valueSha256: sha256,
              characterCount: z.number().int().min(1).max(20000),
            })
            .strict(),
          z
            .object({
              kind: z.literal("file"),
              fieldKey: z.string().min(1).max(256),
              files: z
                .array(
                  z
                    .object({
                      sourceId: z.string().uuid(),
                      sourceUpdatedAt: z.string().datetime({ offset: true }),
                      originalName: z.string().min(1).max(200),
                      mimeType: z.string().max(150).nullable(),
                      sizeBytes: z
                        .number()
                        .int()
                        .positive()
                        .max(12 * 1024 * 1024),
                      sha256,
                    })
                    .strict(),
                )
                .min(1)
                .max(10),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(50),
  })
  .strict();
export const venturePreparedPackageBindingSchema = z
  .object({
    binding: venturePreparedBindingManifestSchema,
    digest: sha256,
    packageDraft: z.boolean(),
    companyRevisionChanged: z.boolean(),
  })
  .strict();
export type VenturePreparedPackageBinding = z.infer<typeof venturePreparedPackageBindingSchema>;
export const venturePreparedBindingResultSchema = z
  .object({
    scope: z.literal("selected-prepared-fields"),
    matched: z.boolean(),
    issues: z
      .array(
        z
          .object({
            code: z.enum([
              "INVALID_INPUT",
              "PACKAGE_COMPANY_MISMATCH",
              "PACKAGE_METADATA_INCONSISTENT",
              "PACKAGE_ARCHIVE_UNVERIFIED",
              "PACKAGE_ARCHIVE_MISMATCH",
              "PLAN_BINDING_MISMATCH",
              "PLAN_CONTENT_MISMATCH",
              "SELECTION_EMPTY",
              "SELECTION_LIMIT",
              "TARGET_DUPLICATE",
              "TARGET_UNCONFIRMED",
              "TEXT_VALUE_INVALID",
              "TEXT_CURRENT_MISMATCH",
              "PROFILE_VALUE_MISMATCH",
              "PLAN_SECTION_AMBIGUOUS",
              "ATTACHMENT_SOURCE_DUPLICATE",
              "ATTACHMENT_TARGET_INVALID",
              "ATTACHMENT_NOT_PACKAGED",
              "ATTACHMENT_METADATA_MISMATCH",
              "ATTACHMENT_CONTENT_MISMATCH",
            ]),
            fieldKey: z.string().min(1).max(256).optional(),
            sourceId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(1000),
    companyRevisionChanged: z.boolean().nullable(),
    packageDraft: z.boolean().nullable(),
    binding: venturePreparedBindingManifestSchema.nullable(),
    digest: sha256.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.matched
        ? !value.binding ||
          !value.digest ||
          value.issues.length > 0 ||
          value.packageDraft === null ||
          value.companyRevisionChanged === null
        : value.binding !== null || value.digest !== null || value.issues.length === 0
    )
      context.addIssue({ code: "custom", message: "준비본 대조 상태가 일치하지 않습니다." });
  });
export const venturePreparedComparisonSchema = z
  .object({
    caseId: z.string().uuid(),
    workflowRevision: revision,
    companyRevision: revision,
    accountRevision: revision,
    snapshotId: z.string().min(1).max(200),
    sessionStartedAt: z.string().datetime(),
    preparedPackage: preparedPackageSummarySchema,
    result: venturePreparedBindingResultSchema,
  })
  .strict();
export type VenturePreparedComparison = z.infer<typeof venturePreparedComparisonSchema>;
const executionManifestBase = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    draftFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    caseId: z.string().uuid(),
    companyRevision: revision,
    accountRevision: revision,
    workflowRevision: revision,
    sessionStartedAt: z.string().datetime(),
    snapshotId: z.string().min(1).max(200),
    targets: z
      .array(
        z.object({ fieldKey: z.string().min(1).max(256), kind: z.enum(["text", "file"]) }).strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export const ventureExecutionManifestSchema = z
  .discriminatedUnion("version", [
    executionManifestBase,
    executionManifestBase
      .extend({ version: z.literal(2), preparedPackage: venturePreparedPackageBindingSchema })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.version !== 2) return;
    const binding = value.preparedPackage.binding;
    if (
      binding.caseId !== value.caseId ||
      binding.companyRevision !== value.companyRevision ||
      JSON.stringify(binding.targets.map(({ fieldKey, kind }) => ({ fieldKey, kind }))) !==
        JSON.stringify(value.targets)
    )
      context.addIssue({ code: "custom", message: "준비본과 실행 범위가 일치하지 않습니다." });
  });

/** Legacy optional fields never constitute evidence that no input was attempted. */
export const ventureExecutionAttemptSchema = z
  .object({
    id: z.string().uuid(),
    snapshotId: z.string().min(1).max(200),
    status: z.enum(["running", "completed", "stopped"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    completedFieldKeys: z.array(z.string().min(1).max(256)).max(150),
    attachmentFieldKeys: z.array(z.string().min(1).max(256)).max(50).default([]),
    attemptedFieldKey: z.string().min(1).max(256).nullable(),
    requestedFieldKeys: fieldKeys.optional(),
    preservedFieldKeys: fieldKeys.optional(),
    touchedFieldKeys: fieldKeys.optional(),
    priorExecutionId: z.string().uuid().nullable().optional(),
    code: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(100)
      .nullable(),
  })
  .strict();
/** A receipt contains identifiers and outcomes only, never entered values or raw browser errors. */
export const ventureExecutionRecordSchema = ventureExecutionAttemptSchema
  .extend({
    manifest: ventureExecutionManifestSchema.optional(),
    previousAttempts: z.array(ventureExecutionAttemptSchema).max(9).optional(),
  })
  .strict();
export type VentureExecutionAttempt = z.infer<typeof ventureExecutionAttemptSchema>;
export type VentureExecutionRecord = z.infer<typeof ventureExecutionRecordSchema>;
export type VentureExecutionReview = {
  scope: "selected-fields";
  submissionReady: boolean;
  remainingIssues: VenturePreflightIssue[];
  token: string;
  expiresAt: string;
  workflowRevision: number;
  companyRevision: number;
  accountRevision: number;
  snapshotId: string;
  sessionStartedAt: string;
  destination: string;
  companyName: string;
  fieldCount: number;
  fields: VentureResolvedText[];
  attachments: (VentureResolvedAttachment & { sha256: string })[];
  attachmentCount: number;
  totalAttachmentBytes: number;
  /** Absent for legacy v1 approval; never inferred from another/current package. */
  preparedPackage?: VenturePreparedPackageBinding;
};

export type VentureRecoveryReview = Omit<
  VentureExecutionReview,
  "scope" | "attachments" | "attachmentCount" | "totalAttachmentBytes"
> & {
  scope: "text-recovery";
  priorExecutionId: string;
  observedAt: string;
  protectedFields: { fieldKey: string; label: string }[];
};
