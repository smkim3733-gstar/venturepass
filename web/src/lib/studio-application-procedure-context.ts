import type { StudioCase } from "./studio-schema";
import { isAgencyNoticeRecord, type AgencyRecord } from "./studio-agency-records";
import { applicationMetadata, currentApplicationLinks } from "./studio-application-types";
import type { ApplicationProcedure } from "./studio-application-procedure-types";

function agencyChain(record: AgencyRecord) {
  if (isAgencyNoticeRecord(record))
    return { chainKind: "notice" as const, chainRootId: record.noticeRecordId };
  if (record.kind === "request" || record.kind === "request-correction")
    return { chainKind: "request" as const, chainRootId: record.requestRecordId };
  return null;
}
export async function procedureContextSha(text: string) {
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
    (await procedureContextSha(JSON.stringify(cycle))) !== record.applicationSha256
  )
    reasons.push("신청 회차 정보가 바뀌었거나 없습니다.");
  const link = currentApplicationLinks(company).find(
    (item) => item.chainKind === record.chainKind && item.chainRootId === record.chainRootId,
  );
  if (
    !link ||
    link.id !== record.linkEventId ||
    link.applicationId !== record.applicationId ||
    (await procedureContextSha(JSON.stringify(link))) !== record.linkEventSha256
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
    (await procedureContextSha(JSON.stringify(agency))) !== record.agencySha256
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
      (await procedureContextSha(source.text)) !== snapshot.textSha256 ||
      source.originalName !== (snapshot.original?.originalName ?? null) ||
      source.mimeType !== (snapshot.original?.mimeType ?? null)
    )
      reasons.push("연결한 추가 증빙을 다시 확인해 주세요.");
  }
  return [...new Set(reasons)];
}
