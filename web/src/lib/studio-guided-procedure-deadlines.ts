import {
  applicationProcedureUiContext,
  procedureContextSha,
} from "./studio-application-procedure-context";
import {
  applicationProcedureInputSchema,
  applicationProcedureSchema,
  extensionStatusLabels,
  type ApplicationProcedure,
} from "./studio-application-procedure-types";
import { currentRequests } from "./studio-guided-agency-records";
import type { StudioCase } from "./studio-schema";

export type GuidedProcedureDeadline = {
  requestRecordId: string;
  requestVersionId: string;
  state: "pending" | "current" | "review";
  message: string;
  dueOn: string | null;
  record: Pick<
    ApplicationProcedure,
    | "id"
    | "title"
    | "version"
    | "dueOn"
    | "dueBasis"
    | "extendedDueOn"
    | "extensionBasis"
    | "extensionStatus"
    | "recordedBy"
    | "recordedAt"
  > | null;
};
/** Bound to the exact immutable case object as well as its ID/revision. Never a write approval. */
export type GuidedProcedureDeadlines = {
  company: StudioCase;
  caseId: string;
  revision: number;
  entries: GuidedProcedureDeadline[];
};
export function guidedProcedureDeadline(
  company: StudioCase,
  requestRecordId: string,
  requestVersionId: string,
  resolved?: GuidedProcedureDeadlines,
): GuidedProcedureDeadline | undefined {
  if (
    !company.applicationProcedures.some(
      (r) => r.chainKind === "request" && r.chainRootId === requestRecordId,
    )
  )
    return undefined;
  const current =
    resolved?.company === company &&
    resolved.caseId === company.id &&
    resolved.revision === company.revision;
  const matches = current
    ? resolved.entries.filter(
        (r) => r.requestRecordId === requestRecordId && r.requestVersionId === requestVersionId,
      )
    : [];
  return matches.length === 1
    ? matches[0]
    : {
        requestRecordId,
        requestVersionId,
        state: "pending",
        message: "연결된 절차의 기한을 대조하고 있습니다.",
        dueOn: null,
        record: null,
      };
}
/** In-memory, read-only reminder dates. Does not verify agency approval or original file bytes. */
export async function resolveGuidedProcedureDeadlines(
  company: StudioCase,
): Promise<GuidedProcedureDeadlines> {
  const result: GuidedProcedureDeadlines = {
    company,
    caseId: company.id,
    revision: company.revision,
    entries: [],
  };
  for (const { root, latest } of currentRequests(company)) {
    const related = company.applicationProcedures.filter(
      (r) => r.chainKind === "request" && r.chainRootId === root.id,
    );
    if (!related.length) continue;
    const entry: GuidedProcedureDeadline = {
      requestRecordId: root.id,
      requestVersionId: latest.id,
      state: "review",
      message: "절차 기록의 연결을 다시 확인해 주세요. 요청 원문 기한을 유지합니다.",
      dueOn: null,
      record: null,
    };
    result.entries.push(entry);
    const roots = [...new Set(related.map((r) => r.procedureId))];
    if (roots.length !== 1) {
      entry.message =
        "연결된 절차가 여러 개여서 적용할 기한을 정할 수 없습니다. 회차 기록에서 확인해 주세요.";
      continue;
    }
    const chain = company.applicationProcedures.filter((r) => r.procedureId === roots[0]);
    if (
      chain.some(
        (r, i) =>
          r.chainKind !== "request" ||
          r.chainRootId !== root.id ||
          r.version !== i + 1 ||
          r.previousVersionId !== (chain[i - 1]?.id ?? null) ||
          (i === 0 && r.id !== r.procedureId) ||
          r.applicationId !== chain[0].applicationId ||
          company.applicationProcedures.filter((other) => other.id === r.id).length !== 1,
      )
    )
      continue;
    const stored = applicationProcedureSchema.safeParse(chain.at(-1));
    if (!stored.success) continue;
    const record = stored.data;
    // Reapply input refinements: stored schema alone cannot prove a supported date/basis pairing.
    const { id, procedureId, previousVersionId, linkEventId } = record;
    const fields = Object.fromEntries(
      Object.keys(applicationProcedureInputSchema.shape).map((key) => [
        key,
        record[key as keyof ApplicationProcedure],
      ]),
    );
    const input = applicationProcedureInputSchema.safeParse({
      ...fields,
      procedureId: previousVersionId ? procedureId : null,
      previousVersionId,
      expectedLinkEventId: linkEventId,
    });
    if (
      !input.success ||
      record.agencyVersionId !== latest.id ||
      JSON.stringify(record.agencySnapshot) !== JSON.stringify(latest) ||
      company.applicationEvents.filter((e) => e.id === linkEventId).length !== 1
    )
      continue;
    try {
      if ((await procedureContextSha(JSON.stringify(input.data))) !== record.inputDigest) continue;
      const reasons = await applicationProcedureUiContext(company, record);
      if (reasons.length) {
        entry.message = reasons.join(" ") + " 요청 원문 기한을 유지합니다.";
        continue;
      }
    } catch {
      entry.message = "절차 연결을 대조하지 못했습니다. 요청 원문 기한을 확인해 주세요.";
      continue;
    }
    const extended = record.extensionStatus === "reported_allowed" && record.extendedDueOn;
    entry.state = "current";
    entry.dueOn = extended || record.dueOn || latest.dueOn || null;
    entry.message = extended
      ? "연장 허용으로 기록한 날짜를 안내에 사용합니다. 기관 허용을 자동 확인한 것은 아닙니다."
      : record.dueOn
        ? `절차 기록 기준 · ${extensionStatusLabels[record.extensionStatus]}. 기관 상태를 자동 확인한 것은 아닙니다.`
        : "절차에 별도 기한이 없어 요청 원문의 기한을 유지합니다. 기관 상태를 자동 확인한 것은 아닙니다.";
    entry.record = {
      id,
      title: record.title,
      version: record.version,
      dueOn: record.dueOn,
      dueBasis: record.dueBasis,
      extendedDueOn: record.extendedDueOn,
      extensionBasis: record.extensionBasis,
      extensionStatus: record.extensionStatus,
      recordedBy: record.recordedBy,
      recordedAt: record.recordedAt,
    };
  }
  return result;
}
