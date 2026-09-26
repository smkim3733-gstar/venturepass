import { z } from "zod";

export const applicationLimits = {
  cycles: 30,
  events: 200,
  text: 200_000,
  originalCount: 10,
  originalBytes: 12 * 1024 * 1024,
  totalOriginalBytes: 24 * 1024 * 1024,
  taskCount: 20,
  evidenceCount: 200,
  snapshotBytes: 2 * 1024 * 1024,
  historyBytes: 8 * 1024 * 1024,
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
  }, "날짜를 YYYY-MM-DD 형식으로 확인해 주세요.");
const requiredDate = date.refine(Boolean, "제출했다고 기록할 날짜를 입력해 주세요.");
const ids = (max: number) =>
  z
    .array(uuid)
    .max(max)
    .refine((value) => new Set(value).size === value.length);
const detailsShape = {
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["new", "renewal"]),
  plannedOn: date,
  criteriaNote: z.string().max(2000),
  previousApplicationId: uuid.nullable(),
};
export const applicationDetailsSchema = z.object(detailsShape).strict();
const requestBase = {
  revision: z.number().int().nonnegative().safe(),
  clientRequestId: uuid,
};
const submissionShape = {
  applicationId: uuid,
  planId: uuid,
  sourceIds: ids(applicationLimits.originalCount),
  taskIds: ids(applicationLimits.taskCount),
  receiptRecordId: uuid.nullable(),
  occurredOn: requiredDate,
  recordedBy: z.string().trim().min(1).max(100),
  note: z.string().max(2000),
};
export const applicationActions = [
  "create-application",
  "correct-application",
  "record-application-submission",
  "correct-application-submission",
  "link-application-agency",
  "correct-application-agency-link",
] as const;
export const applicationMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-application"), ...requestBase, ...detailsShape }).strict(),
  z
    .object({
      action: z.literal("correct-application"),
      ...requestBase,
      applicationId: uuid,
      previousVersionId: uuid,
      ...detailsShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("record-application-submission"),
      ...requestBase,
      ...submissionShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("correct-application-submission"),
      ...requestBase,
      ...submissionShape,
      submissionRecordId: uuid,
      previousVersionId: uuid,
    })
    .strict(),
  z
    .object({
      action: z.literal("link-application-agency"),
      ...requestBase,
      applicationId: uuid,
      recordId: uuid,
      note: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("correct-application-agency-link"),
      ...requestBase,
      previousLinkEventId: uuid,
      fromApplicationId: uuid.nullable(),
      toApplicationId: uuid.nullable(),
      recordId: uuid,
      note: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export type ApplicationMutation = z.infer<typeof applicationMutationSchema>;
export function isApplicationMutation(value: { action: string }): value is ApplicationMutation {
  return (applicationActions as readonly string[]).includes(value.action);
}
const recordBase = {
  id: uuid,
  clientRequestId: uuid,
  inputDigest: digest,
  recordedAt: z.string().datetime(),
  origin: z.literal("manual"),
};
const companySnapshot = z
  .object({
    companyName: z.string().max(100),
    businessNumber: z.string().max(30),
  })
  .strict();
export const applicationCycleSchema = z
  .object({
    ...recordBase,
    ...detailsShape,
    companyAtCreation: companySnapshot,
  })
  .strict();
export type ApplicationCycle = z.infer<typeof applicationCycleSchema>;
const reviewSchema = z
  .object({
    id: z.string().max(200),
    severity: z.enum(["error", "warning", "info"]),
    category: z.string().max(200),
    message: z.string().max(3000),
    action: z.string().max(3000),
    sectionKey: z.string().max(200).nullable(),
    sourceIds: z.array(z.string().max(200)).max(200),
  })
  .strict();
const originalSchema = z
  .object({
    sourceId: uuid,
    sourceName: z.string().max(200),
    originalName: z.string().min(1).max(200),
    mimeType: z.string().max(150).nullable(),
    sizeBytes: z.number().int().nonnegative().max(applicationLimits.originalBytes),
    sha256: digest,
    sourceUpdatedAt: z.string().max(100),
  })
  .strict();
const evidenceSchema = z
  .object({
    sectionKey: z.string().max(200),
    sourceId: z.string().max(200),
    sourceName: z.string().max(200).nullable(),
    sourceUpdatedAt: z.string().max(100).nullable(),
    quote: z.string().max(1500),
    locator: z.string().max(150),
    state: z.enum(["matched", "missing", "pending", "mismatch"]),
  })
  .strict();
const ownerSchema = z
  .object({
    taskId: uuid,
    title: z.string().max(300),
    agencyOrigin: z.object({ requestRecordId: uuid, requestVersionId: uuid }).strict().nullable(),
    owners: z
      .object({
        materials: z.string().max(100),
        writing: z.string().max(100),
        review: z.string().max(100),
      })
      .strict(),
  })
  .strict();
const submissionRecordShape = {
  ...recordBase,
  applicationId: uuid,
  submissionRecordId: uuid,
  previousVersionId: uuid.nullable(),
  version: z.number().int().positive().max(applicationLimits.events),
  occurredOn: requiredDate,
  recordedBy: z.string().min(1).max(100),
  note: z.string().max(2000),
  claim: z.literal("reported-submitted"),
  officialVerification: z.literal("unverified"),
  companySnapshot: companySnapshot.extend({
    caseId: uuid,
    revision: z.number().int().nonnegative().safe(),
  }),
  plan: z
    .object({
      id: uuid,
      version: z.number().int(),
      generatedAt: z.string().max(100),
      mode: z.enum(["ai", "assisted", "manual"]),
      candidateId: z.string().max(200),
      sourceRevision: z.number().int(),
      contentSha256: digest,
      confirmedAt: z.string().max(100).nullable(),
      review: z.array(reviewSchema).max(200),
      sections: z
        .array(z.object({ key: z.string().max(200), needsConfirmation: z.boolean() }).strict())
        .max(20),
      latestVersion: z.boolean(),
      currentEvidence: z.boolean(),
    })
    .strict(),
  evidence: z.array(evidenceSchema).max(applicationLimits.evidenceCount),
  originals: z.array(originalSchema).max(applicationLimits.originalCount),
  owners: z.array(ownerSchema).max(applicationLimits.taskCount),
  receiptRecordId: uuid.nullable(),
};
const linkShape = {
  ...recordBase,
  applicationId: uuid.nullable(),
  fromApplicationId: uuid.nullable(),
  chainRootId: uuid,
  chainKind: z.enum(["request", "notice"]),
  recordVersionId: uuid,
  previousLinkEventId: uuid.nullable(),
  note: z.string().max(2000),
};
export const applicationEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...recordBase,
      kind: z.literal("cycle-correction"),
      applicationId: uuid,
      previousVersionId: uuid,
      details: applicationDetailsSchema,
    })
    .strict(),
  z.object({ ...submissionRecordShape, kind: z.literal("submission-recorded") }).strict(),
  z.object({ ...submissionRecordShape, kind: z.literal("submission-correction") }).strict(),
  z.object({ ...linkShape, kind: z.literal("agency-link") }).strict(),
  z.object({ ...linkShape, kind: z.literal("agency-link-correction") }).strict(),
]);
export type ApplicationEvent = z.infer<typeof applicationEventSchema>;
export type ApplicationSubmission = Extract<
  ApplicationEvent,
  { kind: "submission-recorded" | "submission-correction" }
>;
export type ApplicationLink = Extract<
  ApplicationEvent,
  { kind: "agency-link" | "agency-link-correction" }
>;
export type ApplicationState = {
  applications: ApplicationCycle[];
  applicationEvents: ApplicationEvent[];
};
export const isApplicationSubmission = (event: ApplicationEvent): event is ApplicationSubmission =>
  event.kind === "submission-recorded" || event.kind === "submission-correction";
export const isApplicationLink = (event: ApplicationEvent): event is ApplicationLink =>
  event.kind === "agency-link" || event.kind === "agency-link-correction";

/** Pure UI projections; none of these functions asserts agency submission or acceptance. */
export function applicationMetadata(state: ApplicationState, id: string) {
  const cycle = state.applications.find((item) => item.id === id);
  if (!cycle) return null;
  const correction = state.applicationEvents
    .filter((item) => item.kind === "cycle-correction" && item.applicationId === id)
    .at(-1);
  return {
    ...cycle,
    ...(correction?.kind === "cycle-correction" ? correction.details : {}),
    metadataVersionId: correction?.id ?? cycle.id,
  };
}
export function currentApplicationLinks(state: ApplicationState): ApplicationLink[] {
  const links = new Map<string, ApplicationLink>();
  for (const event of state.applicationEvents)
    if (isApplicationLink(event)) links.set(`${event.chainKind}:${event.chainRootId}`, event);
  return [...links.values()];
}
export function latestApplicationSubmissions(
  state: ApplicationState,
  applicationId: string,
): ApplicationSubmission[] {
  const submissions = new Map<string, ApplicationSubmission>();
  for (const event of state.applicationEvents)
    if (isApplicationSubmission(event) && event.applicationId === applicationId)
      submissions.set(event.submissionRecordId, event);
  return [...submissions.values()];
}
