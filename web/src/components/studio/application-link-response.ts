import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  applicationMutationSchema,
  currentApplicationLinks,
  isApplicationLink,
  type ApplicationMutation,
} from "@/lib/studio-application-types";
import { isAgencyNoticeRecord } from "@/lib/studio-agency-records";

export type ApplicationLinkMutation = Extract<
  ApplicationMutation,
  { action: "link-application-agency" | "correct-application-agency-link" }
>;
export function isApplicationLinkMutation(value: {
  action: string;
}): value is ApplicationLinkMutation {
  return (
    value.action === "link-application-agency" || value.action === "correct-application-agency-link"
  );
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Match the original link and exact selected agency version; never writes or authenticates a receipt. */
export function applicationLinkSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  value: ApplicationLinkMutation,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    command = applicationMutationSchema.safeParse(value);
  if (
    !response.success ||
    !before.success ||
    !command.success ||
    !isApplicationLinkMutation(command.data)
  )
    return false;
  const saved = response.data,
    base = before.data,
    input = command.data;
  if (saved.id !== base.id || saved.revision <= base.revision || input.revision !== base.revision)
    return false;
  const all = [...saved.applications, ...saved.applicationEvents],
    originals = [...base.applications, ...base.applicationEvents];
  if (
    new Set(all.map((r) => r.id)).size !== all.length ||
    new Set(originals.map((r) => r.id)).size !== originals.length
  )
    return false;
  const matches = all.filter((r) => r.clientRequestId === input.clientRequestId);
  // The editor keeps its pre-send company while explicitly retrying the same request.
  if (matches.length !== 1 || originals.some((r) => r.clientRequestId === input.clientRequestId))
    return false;
  const record = matches[0];
  if (!("chainRootId" in record) || !isApplicationLink(record)) return false;
  if (
    !equal(saved.applications, base.applications) ||
    !equal(saved.applicationEvents, [...base.applicationEvents, record])
  )
    return false;
  for (const key of [
    "agencyRecords",
    "plans",
    "sources",
    "tasks",
    "profile",
    "analysis",
    "selectedCandidateId",
    "stage",
  ] as const)
    if (!equal(saved[key], base[key])) return false;
  const selected = base.agencyRecords.filter((r) => r.id === input.recordId);
  if (selected.length !== 1) return false;
  const version = selected[0],
    notice = isAgencyNoticeRecord(version);
  const chainKind = notice ? "notice" : "request";
  const rootId = notice ? version.noticeRecordId : version.requestRecordId;
  const roots = base.agencyRecords.filter((r) => r.id === rootId);
  if (roots.length !== 1 || roots[0].kind !== chainKind) return false;
  const previous = currentApplicationLinks(base).find(
    (r) => r.chainRootId === rootId && r.chainKind === chainKind,
  );
  const correction = input.action === "correct-application-agency-link";
  const target = correction ? input.toApplicationId : input.applicationId;
  if (target !== null && base.applications.filter((c) => c.id === target).length !== 1)
    return false;
  if (correction) {
    if (
      !previous ||
      previous.id !== input.previousLinkEventId ||
      previous.applicationId !== input.fromApplicationId
    )
      return false;
  } else if (previous) return false;
  return (
    record.kind === (correction ? "agency-link-correction" : "agency-link") &&
    record.applicationId === target &&
    record.fromApplicationId === (previous?.applicationId ?? null) &&
    record.previousLinkEventId === (previous?.id ?? null) &&
    record.chainRootId === rootId &&
    record.chainKind === chainKind &&
    record.recordVersionId === input.recordId &&
    record.note === input.note &&
    currentApplicationLinks(saved).some(
      (r) => r.id === record.id && r.clientRequestId === input.clientRequestId,
    )
  );
}
