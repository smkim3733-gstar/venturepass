import { z } from "zod";
import {
  planSupplementInputSchema,
  planSupplementBindingSchema,
} from "./studio-plan-supplement-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();
export const planSupplementModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
export const planSupplementExecutionApprovalSchema = z
  .object({
    purpose: z.literal("propose-one-section-supplement"),
    requestVersion: z.literal("one-section-supplement-v1"),
    provider: z.literal("openai"),
    destination: z.literal("https://api.openai.com/v1/responses"),
    model: planSupplementModelSchema,
    binding: planSupplementBindingSchema,
    payloadSha256: hash,
    targetBodyIncluded: z.literal(true),
    originalFilesIncluded: z.literal(false),
    otherSectionsIncluded: z.literal(false),
    callLimit: z.literal(1),
    automaticRetryLimit: z.literal(0),
  })
  .strict();
export type PlanSupplementExecutionApproval = z.infer<typeof planSupplementExecutionApprovalSchema>;
export const planSupplementExecutionCommandSchema = z
  .object({
    action: z.literal("propose-section"),
    clientRequestId: z.string().uuid(),
    input: planSupplementInputSchema,
    approval: planSupplementExecutionApprovalSchema,
    approved: z.literal(true),
  })
  .strict();
export type PlanSupplementExecutionCommand = z.infer<typeof planSupplementExecutionCommandSchema>;
// Raw JSON is retained as observed, including invalid/refused/incomplete provider content.
// A captured response is neither a valid proposal nor authority to change a manuscript.
export const planSupplementCaptureSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("response"),
      rawJson: z
        .string()
        .min(1)
        .max(1024 * 1024)
        .refine((text) => new TextEncoder().encode(text).length <= 1024 * 1024)
        .refine((text) => {
          try {
            const value: unknown = JSON.parse(text);
            return value !== null && typeof value === "object" && !Array.isArray(value);
          } catch {
            return false;
          }
        }),
    })
    .strict(),
  z.object({ kind: z.literal("not-sent") }).strict(),
  z.object({ kind: z.literal("unobserved") }).strict(),
]);
export type PlanSupplementCapture = z.infer<typeof planSupplementCaptureSchema>;
export const planSupplementExecutionRecordSchema = z
  .object({
    id: z.string().uuid(),
    command: planSupplementExecutionCommandSchema,
    commandSha256: hash,
    reservationRevision: revision,
    createdAt: z.string().datetime(),
    capture: planSupplementCaptureSchema.nullable(),
    captureSha256: hash.nullable(),
    finishedRevision: revision.nullable(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.reservationRevision === value.command.input.revision + 1 &&
      (value.capture === null
        ? value.captureSha256 === null &&
          value.finishedRevision === null &&
          value.finishedAt === null
        : value.captureSha256 !== null &&
          value.finishedRevision !== null &&
          value.finishedRevision > value.reservationRevision &&
          value.finishedAt !== null),
  );
export type PlanSupplementExecutionRecord = z.infer<typeof planSupplementExecutionRecordSchema>;
