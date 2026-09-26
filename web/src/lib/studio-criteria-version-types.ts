import { z } from "zod";
import type { ApplicationState } from "./studio-application-types";

// Manual reference records, separate from the built-in diagnosis criteria and agency verification.
export const criteriaVersionLimits = {
  versions: 50,
  bindings: 100,
  documents: 50,
  sources: 10,
  characters: 500_000,
  requestBytes: 128 * 1024,
} as const;
export const criteriaReferenceDownloadName = "venturepass-criteria-reference.md";
const uuid = z.string().uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.number().int().nonnegative().safe();
export const criteriaCheckedOnSchema = z
  .string()
  .max(10)
  .refine((value) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) === 0) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "확인일을 실제 날짜 또는 공란으로 기록해 주세요.");
const url = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        Boolean(parsed.hostname) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "출처 URL은 http(s) 주소 또는 공란으로 기록해 주세요.");
export const criteriaReferenceSchema = z
  .object({
    title: z.string().trim().max(200),
    url,
    quote: z.string().max(3000),
    note: z.string().max(2000),
  })
  .strict();
export const criteriaDocumentSchema = z
  .object({
    id: uuid,
    name: z.string().trim().min(1).max(200),
    appliesTo: z.string().max(2000),
    period: z.string().max(2000),
    issueDateCondition: z.string().max(2000),
    alternativeCondition: z.string().max(2000),
    autoLinkGuidance: z.string().max(2000),
    note: z.string().max(2000),
  })
  .strict();
export const criteriaVersionDetailsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    versionLabel: z.string().trim().min(1).max(100),
    applicationPath: z.string().max(200),
    checkedOn: criteriaCheckedOnSchema,
    sources: z.array(criteriaReferenceSchema).max(criteriaVersionLimits.sources),
    documents: z.array(criteriaDocumentSchema).max(criteriaVersionLimits.documents),
  })
  .strict()
  .refine(
    (value) => new Set(value.documents.map((item) => item.id)).size === value.documents.length,
    "서류 식별자가 중복되었습니다.",
  );
export type CriteriaVersionDetails = z.infer<typeof criteriaVersionDetailsSchema>;
const authored = {
  recordedBy: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(2000),
};
export const appendCriteriaVersionInputSchema = z
  .object({
    criteriaId: uuid.nullable(),
    previousVersionId: uuid.nullable(),
    details: criteriaVersionDetailsSchema,
    ...authored,
  })
  .strict()
  .refine(
    (value) => (value.criteriaId === null) === (value.previousVersionId === null),
    "기준과 이전 버전을 함께 선택해 주세요.",
  );
export type AppendCriteriaVersionInput = z.infer<typeof appendCriteriaVersionInputSchema>;
export const pinApplicationCriteriaInputSchema = z
  .object({
    applicationId: uuid,
    applicationMetadataVersionId: uuid,
    criteriaVersionId: uuid,
    criteriaContentSha256: sha,
    previousBindingId: uuid.nullable(),
    ...authored,
  })
  .strict();
export type PinApplicationCriteriaInput = z.infer<typeof pinApplicationCriteriaInputSchema>;
const request = { revision, clientRequestId: uuid };
export const criteriaVersionActions = [
  "append-criteria-version",
  "pin-application-criteria",
] as const;
export const criteriaVersionMutationSchema = z.union([
  z
    .object({
      action: z.literal("append-criteria-version"),
      ...request,
      ...appendCriteriaVersionInputSchema.shape,
    })
    .strict()
    .refine(
      (value) => (value.criteriaId === null) === (value.previousVersionId === null),
      "기준과 이전 버전을 함께 선택해 주세요.",
    ),
  z
    .object({
      action: z.literal("pin-application-criteria"),
      ...request,
      ...pinApplicationCriteriaInputSchema.shape,
    })
    .strict(),
]);
export type CriteriaVersionMutation = z.infer<typeof criteriaVersionMutationSchema>;
const record = {
  id: uuid,
  caseId: uuid,
  clientRequestId: uuid,
  inputDigest: sha,
  recordedAt: z.string().datetime(),
  origin: z.literal("manual"),
  officialVerification: z.literal("unverified"),
};
export const criteriaVersionSchema = z
  .object({
    ...record,
    criteriaId: uuid,
    previousVersionId: uuid.nullable(),
    version: z.number().int().min(1).max(criteriaVersionLimits.versions),
    details: criteriaVersionDetailsSchema,
    contentSha256: sha,
    ...authored,
  })
  .strict();
export type CriteriaVersion = z.infer<typeof criteriaVersionSchema>;
export const applicationCriteriaBindingSchema = z
  .object({
    ...record,
    applicationId: uuid,
    previousBindingId: uuid.nullable(),
    version: z.number().int().min(1).max(criteriaVersionLimits.bindings),
    criteriaId: uuid,
    criteriaVersionId: uuid,
    criteriaVersion: z.number().int().min(1).max(criteriaVersionLimits.versions),
    criteriaContentSha256: sha,
    criteriaSummary: z
      .object({
        title: z.string().max(200),
        versionLabel: z.string().max(100),
        applicationPath: z.string().max(200),
        checkedOn: criteriaCheckedOnSchema,
      })
      .strict(),
    applicationSnapshot: z
      .object({
        metadataVersionId: uuid,
        title: z.string().max(200),
        kind: z.enum(["new", "renewal"]),
        plannedOn: criteriaCheckedOnSchema,
        criteriaNote: z.string().max(2000),
        previousApplicationId: uuid.nullable(),
      })
      .strict(),
    companySnapshot: z
      .object({ revision, companyName: z.string().max(100), businessNumber: z.string().max(30) })
      .strict(),
    ...authored,
  })
  .strict();
export type ApplicationCriteriaBinding = z.infer<typeof applicationCriteriaBindingSchema>;
export type CriteriaVersionState = ApplicationState & {
  id: string;
  revision: number;
  profile: { companyName: string; businessNumber: string };
  criteriaVersions?: CriteriaVersion[];
  applicationCriteriaBindings?: ApplicationCriteriaBinding[];
};
export const criteriaContextReasonSchema = z.enum([
  "application-missing",
  "application-changed",
  "company-changed",
  "criteria-missing",
  "criteria-changed",
  "newer-criteria-version",
  "binding-invalid",
]);
export type CriteriaContextReason = z.infer<typeof criteriaContextReasonSchema>;
export const criteriaContextReasonLabels: Record<CriteriaContextReason, string> = {
  "application-missing": "연결한 신청 회차를 확인할 수 없습니다.",
  "application-changed": "연결 이후 회차 정보가 변경되어 재확인이 필요합니다.",
  "company-changed": "연결 이후 회사명 또는 사업자번호가 변경되었습니다.",
  "criteria-missing": "고정한 기준 버전을 확인할 수 없습니다.",
  "criteria-changed": "고정한 기준 내용의 식별값이 일치하지 않습니다.",
  "newer-criteria-version": "새 기준 버전이 있습니다. 과거 연결은 자동 교체하지 않습니다.",
  "binding-invalid": "연결 이력을 정확히 확인할 수 없습니다.",
};
export type ApplicationCriteriaContext = {
  status: "unpinned" | "pinned-unverified" | "needs-review" | "unresolved";
  bindingId: string | null;
  criteriaVersionId: string | null;
  reasons: CriteriaContextReason[];
  officialVerification: "unverified";
};
export const applicationCriteriaContextSchema = z
  .object({
    status: z.enum(["unpinned", "pinned-unverified", "needs-review", "unresolved"]),
    bindingId: uuid.nullable(),
    criteriaVersionId: uuid.nullable(),
    reasons: z.array(criteriaContextReasonSchema).max(7),
    officialVerification: z.literal("unverified"),
  })
  .strict();
export const applicationCriteriaContextsSchema = z
  .array(z.object({ applicationId: uuid, context: applicationCriteriaContextSchema }).strict())
  .max(30);
/** UI lookup only. Server core validates the pinned content hashes again. */
export function latestApplicationCriteriaBinding(
  state: CriteriaVersionState,
  applicationId: string,
) {
  return (
    (state.applicationCriteriaBindings ?? [])
      .filter((item) => item.caseId === state.id && item.applicationId === applicationId)
      .at(-1) ?? null
  );
}
export function criteriaFieldStatus(value: string): "unrecorded" | "recorded-unverified" {
  return value.trim() ? "recorded-unverified" : "unrecorded";
}
