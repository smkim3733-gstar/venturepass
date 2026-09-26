import { z } from "zod";
import { agencyRecordSchema } from "./studio-agency-records";
import { appealReferenceSchema, appealPreparationSchema } from "./studio-appeal-types";

export const applicationProcedureLimits = {
  versions: 100,
  characters: 300_000,
  sources: 6,
  originalBytes: 12 * 1024 * 1024,
  totalOriginalBytes: 24 * 1024 * 1024,
  requestBytes: 64 * 1024,
} as const;
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z
  .string()
  .max(10)
  .refine((value) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "날짜를 확인해 주세요. 미확인 날짜는 비워 두세요.");
export const procedureTypeLabels = {
  unknown: "절차 미확인",
  document: "서류 확인·보완",
  evaluation: "평가 보완",
  committee: "위원회 보완",
  appeal: "이의신청 보완",
  other: "기타 절차",
} as const;
export const extensionStatusLabels = {
  unknown: "연장 상태 미확인",
  not_requested: "미요청으로 기록",
  reported_requested: "요청했다고 기록",
  reported_allowed: "허용됐다고 기록",
  reported_denied: "불허됐다고 기록",
} as const;
export const procedureStatusLabels = {
  unknown: "진행 상태 미확인",
  preparing: "대응 준비 중",
  reported_responded: "대응했다고 기록",
  reported_reconsideration: "재심의 중이라고 기록",
  reported_completed: "완료됐다고 기록",
} as const;
const fields = {
  title: z.string().trim().min(1).max(200),
  procedureType: z.enum(
    Object.keys(procedureTypeLabels) as ["unknown", ...Array<keyof typeof procedureTypeLabels>],
  ),
  requester: z.string().max(200),
  requestedOn: date,
  dueOn: date,
  dueBasis: z.string().max(2000),
  extensionStatus: z.enum(
    Object.keys(extensionStatusLabels) as ["unknown", ...Array<keyof typeof extensionStatusLabels>],
  ),
  extensionRequestedOn: date,
  extensionDecidedOn: date,
  extendedDueOn: date,
  extensionBasis: z.string().max(2000),
  status: z.enum(
    Object.keys(procedureStatusLabels) as ["unknown", ...Array<keyof typeof procedureStatusLabels>],
  ),
  statusBasis: z.string().max(2000),
  completionBasis: z.string().max(2000),
  recordedBy: z.string().trim().min(1).max(100),
  note: z.string().max(2000),
  evidence: z
    .array(appealReferenceSchema)
    .max(applicationProcedureLimits.sources)
    .refine((items) => new Set(items.map((item) => item.sourceId)).size === items.length),
};
export const applicationProcedureInputSchema = z
  .object({
    procedureId: uuid.nullable(),
    previousVersionId: uuid.nullable(),
    applicationId: uuid,
    applicationMetadataVersionId: uuid,
    agencyVersionId: uuid,
    expectedLinkEventId: uuid,
    ...fields,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if ((value.procedureId === null) !== (value.previousVersionId === null))
      issue("previousVersionId", "정정할 이전 버전을 확인해 주세요.");
    if (value.dueOn && !value.dueBasis.trim())
      issue("dueBasis", "안내기한을 기록한 근거를 적어 주세요.");
    if (value.extendedDueOn && value.extensionStatus !== "reported_allowed")
      issue("extendedDueOn", "연장 허용 기록과 기한을 함께 확인해 주세요.");
    if (
      (value.extensionStatus !== "unknown" ||
        value.extensionRequestedOn ||
        value.extensionDecidedOn) &&
      !value.extensionBasis.trim()
    )
      issue("extensionBasis", "연장 상태를 기록한 근거를 적어 주세요.");
    if (
      value.extensionRequestedOn &&
      value.extensionDecidedOn &&
      value.extensionRequestedOn > value.extensionDecidedOn
    )
      issue("extensionDecidedOn", "연장 요청일과 결과 기록일의 순서를 확인해 주세요.");
    if (value.status !== "unknown" && !value.statusBasis.trim())
      issue("statusBasis", "진행 상태를 기록한 근거를 적어 주세요.");
    if (value.status === "reported_completed" && !value.completionBasis.trim())
      issue("completionBasis", "완료됐다고 기록할 근거를 적어 주세요.");
  });
export type ApplicationProcedureInput = z.infer<typeof applicationProcedureInputSchema>;
export const appendApplicationProcedureSchema = z
  .object({
    action: z.literal("append-application-procedure"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: uuid,
    procedure: applicationProcedureInputSchema,
  })
  .strict();
export const applicationProcedureSchema = z
  .object({
    ...fields,
    id: uuid,
    procedureId: uuid,
    previousVersionId: uuid.nullable(),
    version: z.number().int().min(1).max(applicationProcedureLimits.versions),
    applicationId: uuid,
    applicationMetadataVersionId: uuid,
    applicationTitle: z.string().max(200),
    applicationSha256: digest,
    agencyVersionId: uuid,
    chainKind: z.enum(["request", "notice"]),
    chainRootId: uuid,
    linkEventId: uuid,
    linkEventSha256: digest,
    agencySnapshot: agencyRecordSchema,
    agencySha256: digest,
    sourceSnapshots: appealPreparationSchema.shape.sourceSnapshots,
    clientRequestId: uuid,
    inputDigest: digest,
    recordedAt: z.string().datetime(),
    origin: z.literal("manual"),
    officialVerification: z.literal("unverified"),
  })
  .strict();
export type ApplicationProcedure = z.infer<typeof applicationProcedureSchema>;
