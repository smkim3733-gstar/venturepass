import { z } from "zod";
import { ventureMyIdentitySchema, ventureMyStatusLimits, ventureMyStatusUrl } from "./venturein-my-status";
import type { StudioCase } from "./studio-schema";
import type { VentureConnectionStatus } from "./venturein-schema";
import type { VentureWorkflowStatus } from "./venturein-workflow";

const revision = z.number().int().nonnegative().safe();
export const readCurrentMyStatusSchema = z.object({
  action: z.literal("read-current-my-status"), companyRevision: revision,
  accountRevision: revision, workflowRevision: revision,
  sessionStartedAt: z.string().datetime(), confirmed: z.literal(true),
}).strict();
const contextSchema = readCurrentMyStatusSchema.omit({ action: true, confirmed: true })
  .extend({ caseId: z.string().uuid() }).strict();
export type VentureMyReadContext = z.infer<typeof contextSchema>;
export function ventureMyReadContext(
  company: Pick<StudioCase, "id" | "revision">,
  connection: VentureConnectionStatus,
  workflow: VentureWorkflowStatus,
): VentureMyReadContext | null {
  if (!connection.account.saved || connection.session.state !== "connected_unmapped" ||
    workflow.accountRevision !== connection.account.revision || workflow.report.caseId !== company.id ||
    workflow.session.state !== connection.session.state ||
    workflow.session.startedAt !== connection.session.startedAt ||
    (workflow.snapshot && workflow.snapshot.caseId !== company.id) ||
    (workflow.draft && workflow.draft.caseId !== company.id)) return null;
  const value = contextSchema.safeParse({ caseId: company.id, companyRevision: company.revision,
    accountRevision: connection.account.revision, workflowRevision: workflow.revision,
    sessionStartedAt: connection.session.startedAt });
  return value.success ? value.data : null;
}
export function ventureMyReadCommand(context: VentureMyReadContext) {
  const { caseId, ...versions } = contextSchema.parse(context); void caseId;
  return readCurrentMyStatusSchema.parse({ ...versions, action: "read-current-my-status", confirmed: true });
}
const text = z.string().min(1).max(ventureMyStatusLimits.cellChars).nullable();
const application = z.object({ applicationNumber: ventureMyIdentitySchema,
  applicationDateText: text, notifiedDateText: text, resultText: text }).strict();
const certificate = z.object({ certificateNumber: ventureMyIdentitySchema,
  typeText: text, issuedDateText: text, validityText: text, firstConfirmedDateText: text,
  cancelledDateText: text }).strict();
function rows<T extends z.ZodType>(row: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("observed"), rows: z.array(row).max(ventureMyStatusLimits.rows) }).strict(),
    z.object({ state: z.literal("not-present"), rows: z.array(row).length(0) }).strict(),
    z.object({ state: z.literal("unsupported"), rows: z.array(row).length(0),
      reason: z.enum(["ambiguous-structure", "observation-limit", "unsupported-content"]) }).strict(),
  ]);
}
const responseSchema = contextSchema.extend({
  format: z.literal("venturepass-my-status-read-v1"), documentRevision: revision,
  scope: z.literal("company-screen"), applicationAttribution: z.literal("unavailable-no-application-number"),
  observation: z.object({ origin: z.literal("page-observation"), screenId: z.string().min(1).max(100),
    observedAt: z.string().datetime(), url: z.literal(ventureMyStatusUrl), companyNumberMatched: z.literal(true),
    applications: rows(application), certificates: rows(certificate),
    target: z.object({ applicationNumber: z.null(), state: z.literal("not-requested"), row: z.null() }).strict(),
    progressAttribution: z.literal("unverified"), certificateApplicationLink: z.literal("unverified"),
    officialStatusChecked: z.literal(false), receiptVerified: z.literal(false),
    transmissionAllowed: z.literal(false), databaseChanged: z.literal(false),
  }).strict(),
}).strict();
export type VentureMyReadResult = z.infer<typeof responseSchema>;
export function readVentureMyResult(value: unknown, expected: VentureMyReadContext): VentureMyReadResult {
  const context = contextSchema.parse(expected);
  const result = responseSchema.safeParse(value);
  const fail = (): never => { throw Error("현재 회사와 원래 읽기 요청에 맞는 결과인지 확인하지 못했습니다."); };
  if (!result.success) return fail();
  const data = result.data;
  if (Object.entries(context).some(([key, v]) => data[key as keyof VentureMyReadContext] !== v)) return fail();
  const applications = data.observation.applications.rows.map(r => r.applicationNumber);
  const certificates = data.observation.certificates.rows.map(r => r.certificateNumber);
  if (new Set(applications).size !== applications.length || new Set(certificates).size !== certificates.length) return fail();
  return data;
}

export function ventureMyReadFailure(code?: string) {
  if (code === "UNSUPPORTED_PAGE")
    return "현재 페이지는 MY벤처현황 읽기를 지원하지 않습니다. 앱 Edge 창의 MY벤처현황 화면을 확인해 주세요. 자동으로 이동하거나 다시 읽지 않습니다.";
  if (code === "MY_STATUS_SESSION_CHANGED")
    return "원래 계정에 연결된 앱 세션을 확인할 수 없습니다. 세션이 만료되거나 계정 연결 정보가 없는 경우 이 읽기를 사용할 수 없습니다. 자동 재로그인하지 않습니다.";
  return "현재 창을 읽지 못했습니다. 회사·계정 연결과 MY벤처현황 화면을 확인한 뒤 직접 다시 읽어 주세요. 결과는 자동으로 재조회하지 않습니다.";
}
