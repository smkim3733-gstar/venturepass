import { z } from "zod";
import { ventureMyIdentitySchema } from "./venturein-my-status";

export const applicationNumberBindingLimits = { records: 200 } as const;
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requiredText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !!value.trim());

/** A manual local statement. Never a supplied page observation or official receipt. */
export const applicationNumberBindingCommandSchema = z
  .object({
    action: z.literal("record-application-number"),
    revision,
    clientRequestId: uuid,
    applicationId: uuid,
    metadataVersionId: uuid,
    expectedPreviousBindingId: uuid.nullable(),
    operation: z.enum(["bind", "release"]),
    applicationNumber: ventureMyIdentitySchema.nullable(),
    recordedBy: requiredText(100),
    reason: requiredText(2000),
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.operation === "bind") !== (value.applicationNumber !== null))
      ctx.addIssue({
        code: "custom",
        path: ["applicationNumber"],
        message: "연결할 번호 또는 해제를 정확히 지정해 주세요.",
      });
    if (value.operation === "release" && value.expectedPreviousBindingId === null)
      ctx.addIssue({
        code: "custom",
        path: ["expectedPreviousBindingId"],
        message: "해제할 원래 연결 버전이 필요합니다.",
      });
  });
export type ApplicationNumberBindingCommand = z.infer<typeof applicationNumberBindingCommandSchema>;

export const applicationNumberBindingRecordSchema = z
  .object({
    id: uuid,
    caseId: uuid,
    origin: z.literal("manual"),
    officialVerification: z.literal("unverified"),
    recordedAt: z.string().datetime(),
    committedRevision: revision,
    command: applicationNumberBindingCommandSchema,
    inputDigest: digest,
    previousRecordId: uuid.nullable(),
    previousRecordDigest: digest.nullable(),
    companySnapshot: z
      .object({
        companyName: z.string().max(100),
        businessNumber: z.string().max(30),
      })
      .strict(),
    applicationSnapshot: z
      .object({
        cycleDigest: digest,
        metadataDigest: digest,
        title: z.string().max(200),
      })
      .strict(),
    recordDigest: digest,
  })
  .strict();
export type ApplicationNumberBindingRecord = z.infer<typeof applicationNumberBindingRecordSchema>;

/** Optional on old companies; the head anchors a removed/reordered tail while it survives. */
export const applicationNumberBindingHistorySchema = z
  .object({
    formatVersion: z.literal(1),
    headId: uuid,
    headDigest: digest,
    records: z
      .array(applicationNumberBindingRecordSchema)
      .min(1)
      .max(applicationNumberBindingLimits.records),
  })
  .strict();
export type ApplicationNumberBindingHistory = z.infer<typeof applicationNumberBindingHistorySchema>;
