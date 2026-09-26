import { z } from "zod";
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
export const ventureExecutionManifestSchema = z
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
