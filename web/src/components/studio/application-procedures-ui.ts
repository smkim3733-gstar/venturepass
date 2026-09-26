import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import { isAgencyNoticeRecord, type AgencyRecord } from "@/lib/studio-agency-records";
import { applicationMetadata, currentApplicationLinks } from "@/lib/studio-application-types";
import {
  applicationProcedureInputSchema,
  applicationProcedureSchema,
  type ApplicationProcedure,
  type ApplicationProcedureInput,
} from "@/lib/studio-application-procedure-types";

function agencyChain(record: AgencyRecord) {
  if (isAgencyNoticeRecord(record))
    return { chainKind: "notice" as const, chainRootId: record.noticeRecordId };
  if (record.kind === "request" || record.kind === "request-correction")
    return { chainKind: "request" as const, chainRootId: record.requestRecordId };
  return null;
}
export function procedureAgencyChoices(
  company: StudioCase,
  applicationId: string,
  previous?: ApplicationProcedure | null,
) {
  if (company.applications.filter((cycle) => cycle.id === applicationId).length !== 1) return [];
  return currentApplicationLinks(company)
    .filter((link) => link.applicationId === applicationId)
    .flatMap((link) => {
      if (
        previous &&
        (link.chainKind !== previous.chainKind || link.chainRootId !== previous.chainRootId)
      )
        return [];
      const versions = company.agencyRecords.filter((record) => {
        const chain = agencyChain(record);
        return chain?.chainKind === link.chainKind && chain.chainRootId === link.chainRootId;
      });
      const agency = versions.at(-1);
      if (
        !agency ||
        versions.filter(
          (record) => record.kind === link.chainKind && record.id === link.chainRootId,
        ).length !== 1 ||
        company.agencyRecords.filter((record) => record.id === agency.id).length !== 1
      )
        return [];
      return [{ agency, link, chainKind: link.chainKind, chainRootId: link.chainRootId }];
    });
}
export function emptyApplicationProcedure(
  previous?: ApplicationProcedure,
): ApplicationProcedureInput {
  return {
    procedureId: previous?.procedureId ?? null,
    previousVersionId: previous?.id ?? null,
    applicationId: previous?.applicationId ?? "",
    applicationMetadataVersionId: "",
    agencyVersionId: "",
    expectedLinkEventId: "",
    title: previous?.title ?? "",
    procedureType: previous?.procedureType ?? "unknown",
    requester: previous?.requester ?? "",
    requestedOn: previous?.requestedOn ?? "",
    dueOn: previous?.dueOn ?? "",
    dueBasis: previous?.dueBasis ?? "",
    extensionStatus: previous?.extensionStatus ?? "unknown",
    extensionRequestedOn: previous?.extensionRequestedOn ?? "",
    extensionDecidedOn: previous?.extensionDecidedOn ?? "",
    extendedDueOn: previous?.extendedDueOn ?? "",
    extensionBasis: previous?.extensionBasis ?? "",
    status: previous?.status ?? "unknown",
    statusBasis: previous?.statusBasis ?? "",
    completionBasis: previous?.completionBasis ?? "",
    recordedBy: "",
    note: previous?.note ?? "",
    evidence: [],
  };
}
export function latestApplicationProcedures(records: ApplicationProcedure[]) {
  const latest = new Map<string, ApplicationProcedure>();
  for (const record of records) latest.set(record.procedureId, record);
  return [...latest.values()];
}
export function applicationProcedureInputProblem(
  company: StudioCase,
  input: ApplicationProcedureInput,
): string {
  const parsed = applicationProcedureInputSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "절차 입력을 확인해 주세요.";
  const cycle = applicationMetadata(company, input.applicationId);
  if (!cycle || cycle.metadataVersionId !== input.applicationMetadataVersionId)
    return "신청 회차의 최신 정보 버전을 다시 선택해 주세요.";
  const previous = input.procedureId
    ? latestApplicationProcedures(company.applicationProcedures ?? []).find(
        (record) => record.procedureId === input.procedureId,
      )
    : null;
  if (
    input.procedureId &&
    (!previous ||
      previous.id !== input.previousVersionId ||
      previous.applicationId !== input.applicationId)
  )
    return "정정할 절차의 최신 이전 버전을 다시 확인해 주세요.";
  const choices = procedureAgencyChoices(company, input.applicationId, previous);
  if (
    !choices.some(
      (entry) =>
        entry.agency.id === input.agencyVersionId && entry.link.id === input.expectedLinkEventId,
    )
  )
    return "이 회차에 귀속된 기관 요청·통보의 최신 버전을 다시 선택해 주세요.";
  for (const reference of input.evidence) {
    const sources = company.sources.filter((source) => source.id === reference.sourceId),
      source = sources.length === 1 ? sources[0] : null;
    if (
      !source ||
      source.updatedAt !== reference.sourceUpdatedAt ||
      (reference.quote === ""
        ? !source.originalName
        : source.extraction === "pending" ||
          !reference.quote.trim() ||
          !source.text.includes(reference.quote))
    )
      return "추가 증빙의 현재 본문·수정시각·원본 연결을 다시 확인해 주세요.";
  }
  return "";
}
async function sha(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
/** Reads in-memory metadata and text only. Original file bytes and official state are not checked. */
export async function applicationProcedureUiContext(
  company: StudioCase,
  record: ApplicationProcedure,
): Promise<string[]> {
  const reasons: string[] = [],
    cycle = applicationMetadata(company, record.applicationId);
  if (
    company.applications.filter((item) => item.id === record.applicationId).length !== 1 ||
    !cycle ||
    cycle.metadataVersionId !== record.applicationMetadataVersionId ||
    cycle.title !== record.applicationTitle ||
    (await sha(JSON.stringify(cycle))) !== record.applicationSha256
  )
    reasons.push("신청 회차 정보가 바뀌었거나 없습니다.");
  const link = currentApplicationLinks(company).find(
    (item) => item.chainKind === record.chainKind && item.chainRootId === record.chainRootId,
  );
  if (
    !link ||
    link.id !== record.linkEventId ||
    link.applicationId !== record.applicationId ||
    (await sha(JSON.stringify(link))) !== record.linkEventSha256
  )
    reasons.push("기관 기록의 회차 귀속이 바뀌었거나 없습니다.");
  const agency = company.agencyRecords
    .filter((item) => {
      const chain = agencyChain(item);
      return chain?.chainKind === record.chainKind && chain.chainRootId === record.chainRootId;
    })
    .at(-1);
  if (
    !agency ||
    agency.id !== record.agencyVersionId ||
    (await sha(JSON.stringify(agency))) !== record.agencySha256
  )
    reasons.push("기관 요청·통보가 정정되었거나 없습니다.");
  for (const snapshot of record.sourceSnapshots) {
    const matches = company.sources.filter((source) => source.id === snapshot.sourceId),
      source = matches.length === 1 ? matches[0] : null;
    if (
      !source ||
      source.updatedAt !== snapshot.sourceUpdatedAt ||
      source.name !== snapshot.sourceName ||
      source.extraction !== snapshot.extraction ||
      (await sha(source.text)) !== snapshot.textSha256 ||
      source.originalName !== (snapshot.original?.originalName ?? null) ||
      source.mimeType !== (snapshot.original?.mimeType ?? null)
    )
      reasons.push("연결한 추가 증빙을 다시 확인해 주세요.");
  }
  return [...new Set(reasons)];
}
export async function applicationProcedureSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  clientRequestId: string,
  value: ApplicationProcedureInput,
): Promise<boolean> {
  const parsed = caseSchema.safeParse(raw),
    input = applicationProcedureInputSchema.safeParse(value);
  if (
    !parsed.success ||
    !input.success ||
    parsed.data.id !== company.id ||
    parsed.data.revision < company.revision
  )
    return false;
  const matches = parsed.data.applicationProcedures.filter(
    (record) => record.clientRequestId === clientRequestId,
  );
  if (matches.length !== 1) return false;
  const stored = applicationProcedureSchema.safeParse(matches[0]);
  if (!stored.success) return false;
  const record = stored.data;
  if (record.inputDigest !== (await sha(JSON.stringify(input.data)))) return false;
  const previous = input.data.procedureId
    ? latestApplicationProcedures(company.applicationProcedures).find(
        (entry) => entry.procedureId === input.data.procedureId,
      )
    : null;
  if (
    record.procedureId !== (input.data.procedureId ?? record.id) ||
    record.previousVersionId !== input.data.previousVersionId ||
    record.version !== (previous?.version ?? 0) + 1 ||
    record.applicationId !== input.data.applicationId ||
    record.applicationMetadataVersionId !== input.data.applicationMetadataVersionId ||
    record.agencyVersionId !== input.data.agencyVersionId ||
    record.linkEventId !== input.data.expectedLinkEventId
  )
    return false;
  const keys = Object.keys(input.data).filter(
    (key) => !["procedureId", "previousVersionId", "expectedLinkEventId"].includes(key),
  ) as Array<
    keyof Omit<
      ApplicationProcedureInput,
      "procedureId" | "previousVersionId" | "expectedLinkEventId"
    >
  >;
  return keys.every((key) => JSON.stringify(record[key]) === JSON.stringify(input.data[key]));
}
