import { z } from "zod";
import { ventureMyIdentitySchema, ventureMyStatusUrl } from "./venturein-my-status";
import { ventureMyReadContextSchema, ventureMyApplicationSchema } from "./venturein-my-status-view";

export const ventureBoundTargetSchema = z.object({
  applicationId: z.string().uuid(), metadataVersionId: z.string().uuid(),
  bindingId: z.string().uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const readBoundMyStatusSchema = ventureMyReadContextSchema.omit({ caseId: true }).extend({
  action: z.literal("read-bound-my-status"), target: ventureBoundTargetSchema,
  confirmed: z.literal(true),
}).strict();
export const ventureBoundReadContextSchema = ventureMyReadContextSchema.extend({
  target: ventureBoundTargetSchema.extend({ applicationNumber: ventureMyIdentitySchema }).strict(),
}).strict();
export type VentureBoundReadContext = z.infer<typeof ventureBoundReadContextSchema>;
export function ventureBoundReadCommand(raw: VentureBoundReadContext) {
  const { caseId, target, ...versions } = ventureBoundReadContextSchema.parse(raw); void caseId;
  const { applicationNumber, ...identity } = target; void applicationNumber;
  return readBoundMyStatusSchema.parse({ ...versions, action: "read-bound-my-status", target: identity, confirmed: true });
}
const tableSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("observed") }).strict(),
  z.object({ state: z.literal("not-present") }).strict(),
  z.object({ state: z.literal("unsupported"),
    reason: z.enum(["ambiguous-structure", "observation-limit", "unsupported-content"]) }).strict(),
]);
const responseSchema = ventureBoundReadContextSchema.extend({
  format: z.literal("venturepass-bound-my-status-read-v1"),
  documentRevision: z.number().int().nonnegative().safe(),
  scope: z.literal("manual-application-binding"), applicationAttribution: z.literal("manual-unverified"),
  observation: z.object({
    origin: z.literal("page-observation"), screenId: z.string().min(1).max(100),
    observedAt: z.string().datetime(), url: z.literal(ventureMyStatusUrl), companyNumberMatched: z.literal(true),
    applicationTable: tableSchema,
    target: z.object({ applicationNumber: ventureMyIdentitySchema,
      state: z.enum(["matched", "not-observed", "unverified"]), row: ventureMyApplicationSchema.nullable() }).strict(),
    progressAttribution: z.literal("unverified"), certificateApplicationLink: z.literal("unverified"),
    officialStatusChecked: z.literal(false), receiptVerified: z.literal(false),
    transmissionAllowed: z.literal(false), databaseChanged: z.literal(false),
  }).strict(),
}).strict();
export type VentureBoundReadResult = z.infer<typeof responseSchema>;
export function readVentureBoundResult(raw: unknown, expected: VentureBoundReadContext): VentureBoundReadResult {
  const context = ventureBoundReadContextSchema.parse(expected);
  const value = responseSchema.parse(raw);
  const fail = (): never => { throw Error("원래 신청 회차와 번호 연결에 맞는 읽기 결과인지 확인하지 못했습니다."); };
  const { target, ...owner } = context;
  if (Object.entries(owner).some(([k,v]) => value[k as keyof typeof owner] !== v) ||
    JSON.stringify(target) !== JSON.stringify(value.target)) fail();
  const observed = value.observation;
  if (observed.target.applicationNumber !== target.applicationNumber) fail();
  if (observed.target.state === "matched") {
    if (observed.applicationTable.state !== "observed" || !observed.target.row ||
      observed.target.row.applicationNumber !== target.applicationNumber) fail();
  } else {
    if (observed.target.row !== null ||
      (observed.target.state === "not-observed") !== (observed.applicationTable.state === "observed")) fail();
  }
  return value;
}
