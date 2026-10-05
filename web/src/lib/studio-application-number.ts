// Node-only local writer helpers. No SDK, credentials, browser, or external requests.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import type { StudioCase } from "./studio-schema";
import { applicationMetadata } from "./studio-application-types";
import { assertApplicationCapacity } from "./studio-applications";
import { guidedApplicationHistory } from "./studio-guided-applications";
import { normalizeVentureBusinessNumber } from "./venturein-inspection";
import {
  applicationNumberBindingCommandSchema,
  applicationNumberBindingHistorySchema,
  applicationNumberBindingRecordSchema,
  applicationNumberBindingLimits,
  type ApplicationNumberBindingCommand,
  type ApplicationNumberBindingRecord,
  type ApplicationNumberBindingHistory,
} from "./studio-application-number-types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code = "APPLICATION_NUMBER_HISTORY_INVALID", status = 409): never {
  throw new StudioError(
    "신청번호와 원래 신청 회차·연결 이력을 확인해 주세요. 기존 기록은 보존했습니다.",
    status,
    code,
  );
}
export function applicationNumberCommandDigest(
  caseId: string,
  raw: ApplicationNumberBindingCommand,
) {
  return hash({
    formatVersion: 1,
    caseId,
    command: applicationNumberBindingCommandSchema.parse(raw),
  });
}
function recordDigest(record: Omit<ApplicationNumberBindingRecord, "recordDigest">) {
  return hash(record);
}
function snapshot(company: StudioCase, applicationId: string, metadataVersionId: string) {
  const cycle = company.applications.find((item) => item.id === applicationId);
  if (!cycle) fail();
  const metadata =
    metadataVersionId === cycle.id
      ? cycle
      : company.applicationEvents.find(
          (item) =>
            item.kind === "cycle-correction" &&
            item.id === metadataVersionId &&
            item.applicationId === applicationId,
        );
  if (!metadata || !("title" in metadata || metadata.kind === "cycle-correction")) fail();
  return {
    cycleDigest: hash(cycle),
    metadataDigest: hash(metadata),
    title: "title" in metadata ? metadata.title : metadata.details.title,
  };
}
function legacyRecords(company: StudioCase) {
  return [...company.applications, ...company.applicationEvents, ...company.applicationProcedures];
}
function validateApplications(company: StudioCase) {
  if (guidedApplicationHistory(company).needsInspection) fail();
  // Reuse the existing metadata chain, additionally reject dangling/cyclic predecessor rounds.
  for (const cycle of company.applications) {
    const seen = new Set<string>();
    let id: string | null = cycle.id;
    while (id !== null) {
      if (seen.has(id)) fail();
      seen.add(id);
      const metadata = applicationMetadata(company, id);
      if (!metadata) fail();
      id = metadata.previousApplicationId;
    }
  }
}
/** Audits stored identities and full binding order; never repairs history or checks an official site. */
export function auditApplicationNumberBindings(company: StudioCase) {
  validateApplications(company);
  const heads = new Map<string, ApplicationNumberBindingRecord>();
  const raw = company.applicationNumberBindings;
  if (raw === undefined) return { records: [] as ApplicationNumberBindingRecord[], heads };
  const parsed = applicationNumberBindingHistorySchema.safeParse(raw);
  if (!parsed.success) fail();
  const history = parsed.data;
  const ids = new Set(legacyRecords(company).map((item) => item.id));
  const nonces = new Set(legacyRecords(company).map((item) => item.clientRequestId));
  let previous: ApplicationNumberBindingRecord | undefined;
  for (const entry of history.records) {
    const { recordDigest: storedDigest, ...body } = entry;
    const command = entry.command;
    const prior = heads.get(command.applicationId);
    if (
      entry.caseId !== company.id ||
      ids.has(entry.id) ||
      nonces.has(command.clientRequestId) ||
      entry.inputDigest !== applicationNumberCommandDigest(company.id, command) ||
      storedDigest !== recordDigest(body) ||
      entry.previousRecordId !== (previous?.id ?? null) ||
      entry.previousRecordDigest !== (previous?.recordDigest ?? null) ||
      entry.committedRevision !== command.revision + 1 ||
      entry.committedRevision > company.revision ||
      (previous && entry.committedRevision <= previous.committedRevision) ||
      !normalizeVentureBusinessNumber(entry.companySnapshot.businessNumber) ||
      hash(entry.applicationSnapshot) !==
        hash(snapshot(company, command.applicationId, command.metadataVersionId)) ||
      command.expectedPreviousBindingId !== (prior?.id ?? null) ||
      (command.operation === "release" && prior?.command.operation !== "bind")
    )
      fail();
    if (
      command.operation === "bind" &&
      [...heads.values()].some(
        (item) =>
          item.command.applicationId !== command.applicationId &&
          item.command.operation === "bind" &&
          item.command.applicationNumber === command.applicationNumber,
      )
    )
      fail();
    ids.add(entry.id);
    nonces.add(command.clientRequestId);
    heads.set(command.applicationId, entry);
    previous = entry;
  }
  if (history.headId !== previous?.id || history.headDigest !== previous.recordDigest) fail();
  return { records: history.records, heads };
}
/** Original command lookup remains valid after later corrections, without resurrecting its number. */
export function findApplicationNumberReplay(
  company: StudioCase,
  raw: ApplicationNumberBindingCommand,
) {
  const command = applicationNumberBindingCommandSchema.parse(raw);
  const { records } = auditApplicationNumberBindings(company);
  const existing = records.find((item) => item.command.clientRequestId === command.clientRequestId);
  if (existing) {
    if (existing.inputDigest !== applicationNumberCommandDigest(company.id, command))
      fail("APPLICATION_NUMBER_REQUEST_CONFLICT");
    return structuredClone(existing);
  }
  if (legacyRecords(company).some((item) => item.clientRequestId === command.clientRequestId))
    fail("APPLICATION_NUMBER_REQUEST_CONFLICT");
  return null;
}
export function buildApplicationNumberBinding(
  company: StudioCase,
  raw: ApplicationNumberBindingCommand,
  context: { id: string; recordedAt: string },
): ApplicationNumberBindingHistory {
  const command = applicationNumberBindingCommandSchema.parse(raw);
  const { records, heads } = auditApplicationNumberBindings(company);
  if (findApplicationNumberReplay(company, command)) fail("APPLICATION_NUMBER_REQUEST_CONFLICT");
  if (command.revision !== company.revision) fail("STALE_REVISION");
  if (records.length >= applicationNumberBindingLimits.records)
    fail("APPLICATION_NUMBER_HISTORY_LIMIT", 413);
  const metadata = applicationMetadata(company, command.applicationId);
  if (!metadata || metadata.metadataVersionId !== command.metadataVersionId)
    fail("APPLICATION_NUMBER_TARGET_CHANGED");
  const prior = heads.get(command.applicationId);
  if (
    command.expectedPreviousBindingId !== (prior?.id ?? null) ||
    (command.operation === "release" && prior?.command.operation !== "bind")
  )
    fail("APPLICATION_NUMBER_TARGET_CHANGED");
  if (!normalizeVentureBusinessNumber(company.profile.businessNumber))
    fail("APPLICATION_NUMBER_COMPANY_UNVERIFIED");
  if (
    command.operation === "bind" &&
    [...heads.values()].some(
      (item) =>
        item.command.applicationId !== command.applicationId &&
        item.command.operation === "bind" &&
        item.command.applicationNumber === command.applicationNumber,
    )
  )
    fail("APPLICATION_NUMBER_ALREADY_BOUND");
  const previous = records.at(-1);
  const body = {
    id: context.id,
    caseId: company.id,
    origin: "manual" as const,
    officialVerification: "unverified" as const,
    recordedAt: context.recordedAt,
    committedRevision: company.revision + 1,
    command,
    inputDigest: applicationNumberCommandDigest(company.id, command),
    previousRecordId: previous?.id ?? null,
    previousRecordDigest: previous?.recordDigest ?? null,
    companySnapshot: {
      companyName: company.profile.companyName,
      businessNumber: company.profile.businessNumber,
    },
    applicationSnapshot: snapshot(company, command.applicationId, command.metadataVersionId),
  };
  const entry = applicationNumberBindingRecordSchema.parse({
    ...body,
    recordDigest: recordDigest(body),
  });
  const history = applicationNumberBindingHistorySchema.parse({
    formatVersion: 1,
    headId: entry.id,
    headDigest: entry.recordDigest,
    records: [...records, entry],
  });
  const proposed = {
    ...company,
    revision: entry.committedRevision,
    applicationNumberBindings: history,
  };
  auditApplicationNumberBindings(proposed);
  assertApplicationCapacity(proposed);
  return history;
}
/** A manual selection only. Stale identity never becomes a current automatic read target. */
export function currentApplicationNumberBinding(company: StudioCase, applicationId: string) {
  const entry = auditApplicationNumberBindings(company).heads.get(applicationId);
  if (!entry || entry.command.operation === "release")
    return { state: "unassigned" as const, record: entry ?? null };
  const metadata = applicationMetadata(company, applicationId);
  const currentNumber = normalizeVentureBusinessNumber(company.profile.businessNumber);
  const current =
    !!currentNumber &&
    currentNumber === normalizeVentureBusinessNumber(entry.companySnapshot.businessNumber) &&
    metadata?.metadataVersionId === entry.command.metadataVersionId;
  return {
    state: current ? ("manual-unverified" as const) : ("stale" as const),
    record: structuredClone(entry),
  };
}
