import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  preparedPackageRecordSchema,
  type PreparedPackageRecord,
} from "./studio-prepared-package-types";
import {
  companyProfileSchema,
  planSchema,
  type BusinessPlan,
  type CompanyProfile,
} from "./studio-schema";
import {
  ventureTextSourceSchema,
  type VentureResolvedAttachment,
  type VentureResolvedText,
  type VentureTextSource,
} from "./venturein-preflight";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().nonnegative().safe();
const fieldKeySchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
const selectionSchema = z
  .object({
    planId: z.string().uuid().nullable(),
    planVersion: z.number().int().positive().safe().nullable(),
    textFields: z
      .array(
        z.object({
          fieldKey: fieldKeySchema,
          label: z.string(),
          source: ventureTextSourceSchema,
          value: z.string().max(20_000),
          characterCount: z.number().int().nonnegative().safe(),
          maxLength: z.number().int().nonnegative().safe().nullable(),
          required: z.boolean(),
          confirmed: z.boolean(),
          financialContext: z
            .object({ unit: z.enum(["원", "월"]), evidenceNote: z.string() })
            .optional(),
        }),
      )
      .max(50),
    attachments: z
      .array(
        z.object({
          fieldKey: fieldKeySchema,
          label: z.string(),
          sourceId: z.string().uuid(),
          sourceUpdatedAt: timestampSchema,
          originalName: z.string().min(1).max(200),
          mimeType: z.string().max(150).nullable(),
          sizeBytes: z
            .number()
            .int()
            .positive()
            .safe()
            .max(12 * 1024 * 1024),
          accept: z.string().nullable(),
          multiple: z.boolean(),
          confirmed: z.boolean(),
          sha256: hashSchema,
        }),
      )
      .max(10),
  })
  .strict();
const archiveSchema = z
  .object({
    packageId: z.string().uuid(),
    sha256: hashSchema,
    sizeBytes: z.number().int().positive().safe(),
    verified: z.boolean(),
  })
  .strict();

/** Produced by safe server-side archive verification, never copied from a request/approval flag. */
export type VenturePreparedArchiveVerification = z.infer<typeof archiveSchema>;
export type VenturePreparedBindingInput = {
  caseId: string;
  companyRevision: number;
  profile: CompanyProfile;
  plan: BusinessPlan | null;
  preparedPackage: PreparedPackageRecord;
  /** The caller must verify the stored ZIP bytes (for example, downloadPreparedPackage). */
  archive: VenturePreparedArchiveVerification | null;
  selection: {
    planId: string | null;
    planVersion: number | null;
    textFields: readonly VentureResolvedText[];
    /** SHA and metadata must come from safely read current originals, not browser input. */
    attachments: readonly (VentureResolvedAttachment & { sha256: string })[];
  };
};

export type VenturePreparedBindingIssueCode =
  | "INVALID_INPUT"
  | "PACKAGE_COMPANY_MISMATCH"
  | "PACKAGE_METADATA_INCONSISTENT"
  | "PACKAGE_ARCHIVE_UNVERIFIED"
  | "PACKAGE_ARCHIVE_MISMATCH"
  | "PLAN_BINDING_MISMATCH"
  | "PLAN_CONTENT_MISMATCH"
  | "SELECTION_EMPTY"
  | "SELECTION_LIMIT"
  | "TARGET_DUPLICATE"
  | "TARGET_UNCONFIRMED"
  | "TEXT_VALUE_INVALID"
  | "TEXT_CURRENT_MISMATCH"
  | "PROFILE_VALUE_MISMATCH"
  | "PLAN_SECTION_AMBIGUOUS"
  | "ATTACHMENT_SOURCE_DUPLICATE"
  | "ATTACHMENT_TARGET_INVALID"
  | "ATTACHMENT_NOT_PACKAGED"
  | "ATTACHMENT_METADATA_MISMATCH"
  | "ATTACHMENT_CONTENT_MISMATCH";
export type VenturePreparedBindingIssue = {
  code: VenturePreparedBindingIssueCode;
  fieldKey?: string;
  sourceId?: string;
};
export type VenturePreparedBindingManifest = {
  version: 1;
  scope: "selected-prepared-fields";
  caseId: string;
  companyRevision: number;
  package: {
    id: string;
    version: number;
    caseRevision: number;
    createdAt: string;
    zipSha256: string;
    zipSizeBytes: number;
  };
  plan: { id: string; version: number; contentSha256: string };
  targets: (
    | {
        kind: "text";
        fieldKey: string;
        source: VentureTextSource;
        valueSha256: string;
        characterCount: number;
      }
    | {
        kind: "file";
        fieldKey: string;
        files: {
          sourceId: string;
          sourceUpdatedAt: string;
          originalName: string;
          mimeType: string | null;
          sizeBytes: number;
          sha256: string;
        }[];
      }
  )[];
};
export type VenturePreparedBindingResult = {
  scope: "selected-prepared-fields";
  matched: boolean;
  issues: VenturePreparedBindingIssue[];
  companyRevisionChanged: boolean | null;
  packageDraft: boolean | null;
  binding: VenturePreparedBindingManifest | null;
  digest: string | null;
};

/** Object keys are canonical; target/file arrays retain the selected execution order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Pure local comparison, with no storage, browser or network access. Matching is NOT execution
 * permission, evidence review, whole-application readiness or official submission. Existing
 * preflight, company/screen observations, original protection and single-use approval remain required.
 * The complete plan is pinned; only selected profile values and originals enter the execution scope.
 */
export function compareVenturePreparedBinding(
  input: VenturePreparedBindingInput,
): VenturePreparedBindingResult {
  const result: VenturePreparedBindingResult = {
    scope: "selected-prepared-fields",
    matched: false,
    issues: [],
    companyRevisionChanged: null,
    packageDraft: null,
    binding: null,
    digest: null,
  };
  const add = (code: VenturePreparedBindingIssueCode, fieldKey?: string, sourceId?: string) => {
    result.issues.push({ code, ...(fieldKey && { fieldKey }), ...(sourceId && { sourceId }) });
  };
  if (
    !input ||
    !z.string().uuid().safeParse(input.caseId).success ||
    !revisionSchema.safeParse(input.companyRevision).success ||
    !companyProfileSchema.safeParse(input.profile).success ||
    !preparedPackageRecordSchema.safeParse(input.preparedPackage).success ||
    !selectionSchema.safeParse(input.selection).success ||
    (input.plan !== null && !planSchema.safeParse(input.plan).success)
  ) {
    add("INVALID_INPUT");
    return result;
  }
  // Validate without adopting schema-normalized strings: comparison must never trim/transform input.
  const saved = input.preparedPackage;
  const { textFields, attachments } = input.selection;
  result.companyRevisionChanged = input.companyRevision !== saved.caseRevision;
  result.packageDraft = saved.review.draft;
  if (saved.caseId !== input.caseId) add("PACKAGE_COMPANY_MISMATCH");
  if (
    saved.input.revision !== saved.caseRevision ||
    saved.input.planId !== saved.plan.id ||
    saved.input.clientRequestId !== saved.clientRequestId ||
    saved.plan.version < 1 ||
    new Set(saved.sourceIds).size !== saved.sourceIds.length ||
    new Set(saved.sources.map((item) => item.source.id)).size !== saved.sources.length ||
    JSON.stringify(saved.input.sourceIds) !== JSON.stringify(saved.sourceIds) ||
    JSON.stringify(saved.sources.map((item) => item.source.id)) !==
      JSON.stringify(saved.sourceIds) ||
    sha256(JSON.stringify(saved.plan.content)) !== saved.plan.contentSha256
  )
    add("PACKAGE_METADATA_INCONSISTENT");
  const archive = archiveSchema.safeParse(input.archive);
  if (!archive.success || !archive.data.verified) add("PACKAGE_ARCHIVE_UNVERIFIED");
  else if (
    archive.data.packageId !== saved.id ||
    archive.data.sha256 !== saved.zip.sha256 ||
    archive.data.sizeBytes !== saved.zip.sizeBytes
  )
    add("PACKAGE_ARCHIVE_MISMATCH");
  if (
    !input.plan ||
    input.selection.planId !== input.plan.id ||
    input.selection.planVersion !== input.plan.version ||
    input.plan.id !== saved.plan.id ||
    input.plan.version !== saved.plan.version
  )
    add("PLAN_BINDING_MISMATCH");
  if (input.plan && sha256(JSON.stringify(input.plan.content)) !== saved.plan.contentSha256)
    add("PLAN_CONTENT_MISMATCH");

  const textKeys = new Set(textFields.map((field) => field.fieldKey));
  const fileKeys = [...new Set(attachments.map((file) => file.fieldKey))];
  if (!textFields.length && !attachments.length) add("SELECTION_EMPTY");
  if (
    textFields.length + fileKeys.length > 50 ||
    textFields.reduce((total, field) => total + field.value.length, 0) > 100_000 ||
    attachments.reduce((total, file) => total + file.sizeBytes, 0) > 24 * 1024 * 1024
  )
    add("SELECTION_LIMIT");
  for (const field of textFields) {
    if (
      textFields.filter((item) => item.fieldKey === field.fieldKey).length !== 1 ||
      fileKeys.includes(field.fieldKey)
    )
      add("TARGET_DUPLICATE", field.fieldKey);
    if (!field.confirmed) add("TARGET_UNCONFIRMED", field.fieldKey);
    if (
      !field.value.trim() ||
      field.characterCount !== field.value.length ||
      (field.maxLength !== null && field.value.length > field.maxLength)
    )
      add("TEXT_VALUE_INVALID", field.fieldKey);
    if (field.source.kind === "profile") {
      const property = field.source.property;
      if (field.value !== input.profile[property]) add("TEXT_CURRENT_MISMATCH", field.fieldKey);
      if (field.value !== saved.company.profile[property])
        add("PROFILE_VALUE_MISMATCH", field.fieldKey);
    } else {
      const key = field.source.sectionKey;
      const current = input.plan?.content.sections.filter((section) => section.key === key) ?? [];
      const previous = saved.plan.content.sections.filter((section) => section.key === key);
      if (current.length !== 1 || previous.length !== 1)
        add("PLAN_SECTION_AMBIGUOUS", field.fieldKey);
      else if (field.value !== current[0].content || field.value !== previous[0].content)
        add("TEXT_CURRENT_MISMATCH", field.fieldKey);
    }
  }
  for (const file of attachments) {
    if (!file.confirmed) add("TARGET_UNCONFIRMED", file.fieldKey, file.sourceId);
    if (
      attachments.filter(
        (item) => item.fieldKey === file.fieldKey && item.sourceId === file.sourceId,
      ).length !== 1
    )
      add("ATTACHMENT_SOURCE_DUPLICATE", file.fieldKey, file.sourceId);
    const group = attachments.filter((item) => item.fieldKey === file.fieldKey);
    if (
      textKeys.has(file.fieldKey) ||
      (group.length > 1 && group.some((item) => !item.multiple)) ||
      group.some((item) => item.accept !== file.accept || item.multiple !== file.multiple)
    )
      add("ATTACHMENT_TARGET_INVALID", file.fieldKey, file.sourceId);
    const source = saved.sources.find((item) => item.source.id === file.sourceId);
    if (!source) add("ATTACHMENT_NOT_PACKAGED", file.fieldKey, file.sourceId);
    else {
      if (
        source.source.originalName !== file.originalName ||
        source.source.mimeType !== file.mimeType ||
        source.source.updatedAt !== file.sourceUpdatedAt ||
        source.originalSizeBytes !== file.sizeBytes
      )
        add("ATTACHMENT_METADATA_MISMATCH", file.fieldKey, file.sourceId);
      if (source.originalSha256 !== file.sha256)
        add("ATTACHMENT_CONTENT_MISMATCH", file.fieldKey, file.sourceId);
    }
  }
  if (result.issues.length) return result;
  const binding: VenturePreparedBindingManifest = {
    version: 1,
    scope: "selected-prepared-fields",
    caseId: input.caseId,
    companyRevision: input.companyRevision,
    package: {
      id: saved.id,
      version: saved.version,
      caseRevision: saved.caseRevision,
      createdAt: saved.createdAt,
      zipSha256: saved.zip.sha256,
      zipSizeBytes: saved.zip.sizeBytes,
    },
    plan: {
      id: saved.plan.id,
      version: saved.plan.version,
      contentSha256: saved.plan.contentSha256,
    },
    targets: [
      ...textFields.map((field) => ({
        kind: "text" as const,
        fieldKey: field.fieldKey,
        source: { ...field.source },
        valueSha256: sha256(field.value),
        characterCount: field.value.length,
      })),
      ...fileKeys.map((fieldKey) => ({
        kind: "file" as const,
        fieldKey,
        files: attachments
          .filter((file) => file.fieldKey === fieldKey)
          .map((file) => ({
            sourceId: file.sourceId,
            sourceUpdatedAt: file.sourceUpdatedAt,
            originalName: file.originalName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          })),
      })),
    ],
  };
  return { ...result, matched: true, binding, digest: sha256(canonical(binding)) };
}
