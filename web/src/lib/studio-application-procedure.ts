// Local manual history only. Does not change an application, task, or official status.
import { createHash } from "node:crypto";
import type { StudioCase, SourceDocument } from "./studio-schema";
import { StudioError } from "./studio-http";
import { isAgencyNoticeRecord, type AgencyRecord } from "./studio-agency-records";
import { applicationMetadata, currentApplicationLinks } from "./studio-application-types";
import { originalConflicts } from "./studio-evidence-history";
import {
  applicationProcedureInputSchema,
  applicationProcedureSchema,
  applicationProcedureLimits,
  type ApplicationProcedure,
  type ApplicationProcedureInput,
} from "./studio-application-procedure-types";

type ReadOriginal = (id: string) => { source: SourceDocument; buffer: Buffer; sha256: string };
type Generated = Pick<ApplicationProcedure, "id" | "clientRequestId" | "recordedAt">;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(code: string, status = 409): never {
  throw new StudioError(
    "신청 회차와 기관 기록·근거의 정확한 버전을 확인해 주세요. 이전 절차 기록은 보존됩니다.",
    status,
    code,
  );
}
export const applicationProcedureDigest = (input: ApplicationProcedureInput) =>
  hash(JSON.stringify(applicationProcedureInputSchema.parse(input)));
export function isApplicationProcedureReplay(
  records: ApplicationProcedure[],
  nonce: string,
  digest: string,
) {
  const matches = records.filter((record) => record.clientRequestId === nonce);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== digest) fail("PROCEDURE_REQUEST_CONFLICT");
  return true;
}
export function assertApplicationProcedureCapacity(records: ApplicationProcedure[]) {
  const characters = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, child) => sum + characters(child), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, child) => sum + characters(child), 0)
          : 0;
  if (
    records.length > applicationProcedureLimits.versions ||
    characters(records) > applicationProcedureLimits.characters
  )
    fail("PROCEDURE_HISTORY_LIMIT", 413);
}
function chainFor(record: AgencyRecord): { chainKind: "request" | "notice"; chainRootId: string } {
  if (isAgencyNoticeRecord(record))
    return { chainKind: "notice", chainRootId: record.noticeRecordId };
  if (record.kind === "request" || record.kind === "request-correction")
    return { chainKind: "request", chainRootId: record.requestRecordId };
  return fail("PROCEDURE_AGENCY_REQUIRED", 422);
}
function sameChain(record: AgencyRecord, chain: { chainKind: string; chainRootId: string }) {
  if (chain.chainKind === "notice")
    return isAgencyNoticeRecord(record) && record.noticeRecordId === chain.chainRootId;
  return (
    (record.kind === "request" || record.kind === "request-correction") &&
    record.requestRecordId === chain.chainRootId
  );
}
function linkedContext(company: StudioCase, input: ApplicationProcedureInput) {
  if (company.applications.filter((item) => item.id === input.applicationId).length !== 1)
    fail("PROCEDURE_APPLICATION_NOT_FOUND", 404);
  const cycle = applicationMetadata(company, input.applicationId)!;
  if (cycle.metadataVersionId !== input.applicationMetadataVersionId)
    fail("PROCEDURE_APPLICATION_STALE");
  const matches = company.agencyRecords.filter((item) => item.id === input.agencyVersionId);
  if (matches.length !== 1) fail("PROCEDURE_AGENCY_NOT_FOUND", 404);
  const agency = matches[0],
    chain = chainFor(agency);
  const versions = company.agencyRecords.filter((item) => sameChain(item, chain));
  if (
    versions.filter((item) => item.kind === chain.chainKind && item.id === chain.chainRootId)
      .length !== 1 ||
    versions.at(-1)?.id !== agency.id
  )
    fail("PROCEDURE_AGENCY_STALE");
  const link = currentApplicationLinks(company).find(
    (item) => item.chainKind === chain.chainKind && item.chainRootId === chain.chainRootId,
  );
  if (!link || link.id !== input.expectedLinkEventId || link.applicationId !== cycle.id)
    fail("PROCEDURE_LINK_STALE");
  return { cycle, agency, chain, link };
}
function captureSources(
  company: StudioCase,
  records: ApplicationProcedure[],
  input: ApplicationProcedureInput,
  recordedAt: string,
  readOriginal: ReadOriginal,
): ApplicationProcedure["sourceSnapshots"] {
  const sources = input.evidence.map((reference) => {
    const matches = company.sources.filter((source) => source.id === reference.sourceId);
    if (matches.length !== 1) fail("PROCEDURE_SOURCE_NOT_FOUND", 404);
    const source = matches[0];
    if (
      source.updatedAt !== reference.sourceUpdatedAt ||
      (reference.quote === ""
        ? !source.originalName
        : !reference.quote.trim() ||
          source.extraction === "pending" ||
          !source.text.includes(reference.quote))
    )
      fail("PROCEDURE_SOURCE_STALE");
    return source;
  });
  let total = 0;
  const snapshots: ApplicationProcedure["sourceSnapshots"] = sources.map((source) => {
    let original: ApplicationProcedure["sourceSnapshots"][number]["original"] = null;
    if (source.originalName) {
      const current = readOriginal(source.id);
      if (
        JSON.stringify(current.source) !== JSON.stringify(source) ||
        current.sha256 !== hash(current.buffer)
      )
        fail("PROCEDURE_ORIGINAL_CHANGED");
      total += current.buffer.length;
      if (
        current.buffer.length > applicationProcedureLimits.originalBytes ||
        total > applicationProcedureLimits.totalOriginalBytes
      )
        fail("PROCEDURE_ORIGINAL_LIMIT", 413);
      original = {
        sourceId: source.id,
        sourceName: source.name,
        sourceUpdatedAt: source.updatedAt,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: current.buffer.length,
        sha256: current.sha256,
        capturedAt: recordedAt,
      };
      const saved = records
        .flatMap((record) => record.sourceSnapshots)
        .flatMap((snapshot) => (snapshot.original ? [snapshot.original] : []));
      if (
        originalConflicts(company, original) ||
        saved.some(
          (old) =>
            old.sourceId === source.id &&
            (old.sha256 !== original!.sha256 ||
              old.originalName !== original!.originalName ||
              old.mimeType !== original!.mimeType ||
              old.sizeBytes !== original!.sizeBytes),
        )
      )
        fail("PROCEDURE_ORIGINAL_CHANGED");
    }
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      extraction: source.extraction,
      textSha256: hash(source.text),
      original,
    };
  });
  for (const snapshot of snapshots) {
    if (!snapshot.original) continue;
    const current = readOriginal(snapshot.sourceId),
      source = sources.find((item) => item.id === snapshot.sourceId)!;
    if (
      JSON.stringify(current.source) !== JSON.stringify(source) ||
      current.sha256 !== snapshot.original.sha256 ||
      hash(current.buffer) !== snapshot.original.sha256 ||
      current.buffer.length !== snapshot.original.sizeBytes
    )
      fail("PROCEDURE_ORIGINAL_CHANGED");
  }
  return snapshots;
}
/** Pure builder plus bounded original reads; append inside the existing store transaction. */
export function buildApplicationProcedure(
  company: StudioCase,
  records: ApplicationProcedure[],
  raw: ApplicationProcedureInput,
  generated: Generated,
  readOriginal: ReadOriginal,
): ApplicationProcedure {
  const input = applicationProcedureInputSchema.parse(raw);
  const { cycle, agency, chain, link } = linkedContext(company, input);
  const applicationSha256 = hash(JSON.stringify(cycle));
  const agencySha256 = hash(JSON.stringify(agency));
  const linkEventSha256 = hash(JSON.stringify(link));
  if (
    records.some(
      (record) =>
        record.applicationId === cycle.id &&
        record.applicationMetadataVersionId === cycle.metadataVersionId &&
        record.applicationSha256 !== applicationSha256,
    )
  )
    fail("PROCEDURE_APPLICATION_CHANGED");
  if (
    records.some(
      (record) => record.agencyVersionId === agency.id && record.agencySha256 !== agencySha256,
    )
  )
    fail("PROCEDURE_AGENCY_CHANGED");
  if (
    records.some(
      (record) => record.linkEventId === link.id && record.linkEventSha256 !== linkEventSha256,
    )
  )
    fail("PROCEDURE_LINK_CHANGED");
  let previous: ApplicationProcedure | undefined;
  if (input.procedureId) {
    const roots = records.filter(
      (item) =>
        item.id === input.procedureId &&
        item.procedureId === item.id &&
        item.previousVersionId === null,
    );
    if (roots.length !== 1) fail("PROCEDURE_NOT_FOUND", 404);
    previous = records.filter((item) => item.procedureId === input.procedureId).at(-1);
    if (!previous || previous.id !== input.previousVersionId) fail("PROCEDURE_VERSION_STALE");
    if (
      previous.applicationId !== cycle.id ||
      previous.chainKind !== chain.chainKind ||
      previous.chainRootId !== chain.chainRootId
    )
      fail("PROCEDURE_ROOT_MISMATCH");
  }
  const sourceSnapshots = captureSources(
    company,
    records,
    input,
    generated.recordedAt,
    readOriginal,
  );
  const { expectedLinkEventId, ...fields } = input;
  const result = applicationProcedureSchema.parse({
    ...fields,
    ...generated,
    procedureId: input.procedureId ?? generated.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    applicationTitle: cycle.title,
    applicationSha256,
    ...chain,
    linkEventId: expectedLinkEventId,
    linkEventSha256,
    agencySnapshot: structuredClone(agency),
    agencySha256,
    sourceSnapshots,
    inputDigest: applicationProcedureDigest(input),
    origin: "manual",
    officialVerification: "unverified",
  });
  assertApplicationProcedureCapacity([...records, result]);
  return result;
}

/** Observes current metadata only, never asserts official receipt, extension, or completion. */
export function applicationProcedureContext(
  company: StudioCase,
  record: ApplicationProcedure,
): string[] {
  const issues: string[] = [];
  const cycle = applicationMetadata(company, record.applicationId);
  if (
    !cycle ||
    cycle.metadataVersionId !== record.applicationMetadataVersionId ||
    cycle.title !== record.applicationTitle ||
    hash(JSON.stringify(cycle)) !== record.applicationSha256
  )
    issues.push("신청 회차 정보가 바뀌었거나 없습니다.");
  const link = currentApplicationLinks(company).find(
    (item) => item.chainKind === record.chainKind && item.chainRootId === record.chainRootId,
  );
  if (
    !link ||
    link.id !== record.linkEventId ||
    link.applicationId !== record.applicationId ||
    hash(JSON.stringify(link)) !== record.linkEventSha256
  )
    issues.push("기관 기록의 회차 귀속이 바뀌었거나 없습니다.");
  const agency = company.agencyRecords.filter((item) => sameChain(item, record)).at(-1);
  if (
    !agency ||
    agency.id !== record.agencyVersionId ||
    hash(JSON.stringify(agency)) !== record.agencySha256
  )
    issues.push("기관 요청·통보가 정정되었거나 없습니다.");
  for (const snapshot of record.sourceSnapshots) {
    const source = company.sources.find((item) => item.id === snapshot.sourceId);
    if (
      !source ||
      source.updatedAt !== snapshot.sourceUpdatedAt ||
      source.name !== snapshot.sourceName ||
      source.extraction !== snapshot.extraction ||
      hash(source.text) !== snapshot.textSha256 ||
      source.originalName !== (snapshot.original?.originalName ?? null) ||
      source.mimeType !== (snapshot.original?.mimeType ?? null)
    )
      issues.push("연결한 추가 증빙을 다시 확인해 주세요.");
  }
  return [...new Set(issues)];
}
