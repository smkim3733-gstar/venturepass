// Node-only storage helper. Client components import studio-application-types instead.
import { createHash, randomUUID } from "node:crypto";
import { isAgencyNoticeRecord, type AgencyRecord } from "./studio-agency-records";
import type { SourceDocument, StudioCase } from "./studio-schema";
import { StudioError } from "./studio-http";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import {
  applicationCycleSchema,
  applicationDetailsSchema,
  applicationEventSchema,
  applicationLimits,
  applicationMetadata,
  applicationMutationSchema,
  currentApplicationLinks,
  isApplicationSubmission,
  latestApplicationSubmissions,
  type ApplicationMutation,
  type ApplicationState,
  type ApplicationSubmission,
} from "./studio-application-types";

type Company = StudioCase & ApplicationState;
type Original = { source: SourceDocument; buffer: Buffer; sha256: string };
type Context = { evidenceRevision: number; readOriginal: (sourceId: string) => Original };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(code: string, status = 409): never {
  throw new StudioError(
    "신청회차와 연결한 기록·원고·원본을 확인해 주세요. 기존 이력은 보존했습니다.",
    status,
    code,
  );
}
export function applicationInputDigest(input: ApplicationMutation) {
  const canonical = { ...applicationMutationSchema.parse(input) };
  Reflect.deleteProperty(canonical, "revision");
  Reflect.deleteProperty(canonical, "clientRequestId");
  return hash(JSON.stringify(canonical));
}
export function isApplicationReplay(record: ApplicationState, input: ApplicationMutation) {
  const matches = [...record.applications, ...record.applicationEvents].filter(
    (item) => item.clientRequestId === input.clientRequestId,
  );
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== applicationInputDigest(input))
    fail("APPLICATION_REQUEST_CONFLICT");
  return true;
}
export function assertApplicationCapacity(record: ApplicationState) {
  if (
    record.applications.length > applicationLimits.cycles ||
    record.applicationEvents.length > applicationLimits.events
  )
    fail("APPLICATION_HISTORY_LIMIT", 413);
  let characters = record.applications.reduce(
    (sum, item) => sum + item.title.length + item.criteriaNote.length,
    0,
  );
  for (const item of record.applicationEvents) {
    characters +=
      item.kind === "cycle-correction"
        ? item.details.title.length + item.details.criteriaNote.length
        : item.note.length + (isApplicationSubmission(item) ? item.recordedBy.length : 0);
    if (Buffer.byteLength(JSON.stringify(item)) > applicationLimits.snapshotBytes)
      fail("APPLICATION_SNAPSHOT_LIMIT", 413);
  }
  if (
    characters > applicationLimits.text ||
    Buffer.byteLength(
      JSON.stringify({
        applications: record.applications,
        applicationEvents: record.applicationEvents,
      }),
    ) > applicationLimits.historyBytes
  )
    fail("APPLICATION_HISTORY_LIMIT", 413);
}
export function applicationSourceReferenced(record: ApplicationState, sourceId: string) {
  return record.applicationEvents.some(
    (item) =>
      isApplicationSubmission(item) &&
      item.originals.some((original) => original.sourceId === sourceId),
  );
}
function requireCycle(record: ApplicationState, id: string) {
  const cycle = applicationMetadata(record, id);
  if (!cycle || record.applications.filter((item) => item.id === id).length !== 1)
    fail("APPLICATION_NOT_FOUND", 404);
  return cycle;
}
function validatePrevious(record: ApplicationState, id: string, previous: string | null) {
  const seen = new Set([id]);
  let current = previous;
  while (current) {
    if (seen.has(current)) fail("APPLICATION_CYCLE_REFERENCE");
    seen.add(current);
    current = requireCycle(record, current).previousApplicationId;
  }
}
function agencyChain(record: Company, id: string) {
  const matches = record.agencyRecords.filter((item) => item.id === id);
  if (matches.length !== 1) fail("APPLICATION_AGENCY_NOT_FOUND", 404);
  const version = matches[0];
  const notice = isAgencyNoticeRecord(version);
  const chainKind = notice ? ("notice" as const) : ("request" as const);
  const rootId = notice ? version.noticeRecordId : version.requestRecordId;
  const root = record.agencyRecords.filter(
    (item) => item.id === rootId && item.kind === (notice ? "notice" : "request"),
  );
  if (root.length !== 1) fail("APPLICATION_AGENCY_NOT_FOUND", 404);
  return { version, chainKind, rootId };
}
function linkFor(record: ApplicationState, chain: { rootId: string; chainKind: string }) {
  return currentApplicationLinks(record).find(
    (item) => item.chainRootId === chain.rootId && item.chainKind === chain.chainKind,
  );
}
function evidence(record: Company, plan: Company["plans"][number]) {
  return plan.content.sections.flatMap((section) =>
    section.evidence.map((reference) => {
      const source = record.sources.find((item) => item.id === reference.sourceId);
      const profile = reference.sourceId === "profile";
      const matched =
        Boolean(reference.quote.trim()) &&
        (profile
          ? Object.values(record.profile).some(
              (value) => typeof value === "string" && value.includes(reference.quote),
            )
          : Boolean(
              source && source.extraction !== "pending" && source.text.includes(reference.quote),
            ));
      return {
        sectionKey: section.key,
        sourceId: reference.sourceId,
        sourceName: profile ? "기업 기본정보" : (source?.name ?? null),
        sourceUpdatedAt: source?.updatedAt ?? null,
        quote: reference.quote,
        locator: reference.locator,
        state: matched
          ? ("matched" as const)
          : source?.extraction === "pending"
            ? ("pending" as const)
            : profile || source
              ? ("mismatch" as const)
              : ("missing" as const),
      };
    }),
  );
}
function originalSnapshot(
  record: Company,
  sourceId: string,
  context: Context,
): ApplicationSubmission["originals"][number] {
  const source = record.sources.filter((item) => item.id === sourceId && item.originalName);
  if (source.length !== 1) fail("SOURCE_NOT_FOUND", 404);
  const original = context.readOriginal(sourceId);
  if (
    JSON.stringify(original.source) !== JSON.stringify(source[0]) ||
    original.sha256 !== hash(original.buffer)
  )
    fail("APPLICATION_ORIGINAL_CHANGED");
  if (original.buffer.length > applicationLimits.originalBytes)
    fail("APPLICATION_ORIGINAL_LIMIT", 413);
  const value = {
    sourceId,
    sourceName: original.source.name,
    originalName: original.source.originalName!,
    mimeType: original.source.mimeType,
    sizeBytes: original.buffer.length,
    sha256: original.sha256,
    sourceUpdatedAt: original.source.updatedAt,
  };
  if (originalConflicts(record, value)) fail("APPLICATION_ORIGINAL_CHANGED");
  return value;
}
function receiptFor(
  record: Company,
  applicationId: string,
  id: string | null,
): AgencyRecord | null {
  if (!id) return null;
  const chain = agencyChain(record, id);
  const version = chain.version;
  if (
    (version.kind !== "notice" && version.kind !== "notice-correction") ||
    version.details.category !== "receipt"
  )
    fail("APPLICATION_RECEIPT_REQUIRED");
  if (linkFor(record, chain)?.applicationId !== applicationId) fail("APPLICATION_CHAIN_CONFLICT");
  return version;
}

/** Called only inside StudioStore's company lock + revision transaction; never performs an external action. */
export function applyApplicationMutation(
  record: Company,
  rawInput: ApplicationMutation,
  context: Context,
) {
  const input = applicationMutationSchema.parse(rawInput);
  const base = {
    id: randomUUID(),
    clientRequestId: input.clientRequestId,
    inputDigest: applicationInputDigest(input),
    recordedAt: new Date().toISOString(),
    origin: "manual" as const,
  };
  if (input.action === "create-application") {
    const details = applicationDetailsSchema.parse({
      title: input.title,
      kind: input.kind,
      plannedOn: input.plannedOn,
      criteriaNote: input.criteriaNote,
      previousApplicationId: input.previousApplicationId,
    });
    validatePrevious(record, base.id, details.previousApplicationId);
    record.applications.push(
      applicationCycleSchema.parse({
        ...base,
        ...details,
        companyAtCreation: {
          companyName: record.profile.companyName,
          businessNumber: record.profile.businessNumber,
        },
      }),
    );
  } else if (input.action === "correct-application") {
    const cycle = requireCycle(record, input.applicationId);
    if (cycle.metadataVersionId !== input.previousVersionId) fail("APPLICATION_VERSION_STALE");
    const details = applicationDetailsSchema.parse({
      title: input.title,
      kind: input.kind,
      plannedOn: input.plannedOn,
      criteriaNote: input.criteriaNote,
      previousApplicationId: input.previousApplicationId,
    });
    validatePrevious(record, cycle.id, details.previousApplicationId);
    record.applicationEvents.push(
      applicationEventSchema.parse({
        ...base,
        kind: "cycle-correction",
        applicationId: cycle.id,
        previousVersionId: input.previousVersionId,
        details,
      }),
    );
  } else if (
    input.action === "link-application-agency" ||
    input.action === "correct-application-agency-link"
  ) {
    const chain = agencyChain(record, input.recordId);
    const current = linkFor(record, chain);
    const correction = input.action === "correct-application-agency-link";
    const target = correction ? input.toApplicationId : input.applicationId;
    if (target) requireCycle(record, target);
    if (correction) {
      if (
        !current ||
        current.id !== input.previousLinkEventId ||
        current.applicationId !== input.fromApplicationId
      )
        fail("APPLICATION_LINK_STALE");
    } else if (current) fail("APPLICATION_CHAIN_ALREADY_LINKED");
    record.applicationEvents.push(
      applicationEventSchema.parse({
        ...base,
        kind: correction ? "agency-link-correction" : "agency-link",
        applicationId: target,
        fromApplicationId: current?.applicationId ?? null,
        chainRootId: chain.rootId,
        chainKind: chain.chainKind,
        recordVersionId: input.recordId,
        previousLinkEventId: current?.id ?? null,
        note: input.note,
      }),
    );
  } else {
    requireCycle(record, input.applicationId);
    const planMatches = record.plans.filter((item) => item.id === input.planId);
    if (planMatches.length !== 1) fail("PLAN_NOT_FOUND", 404);
    const plan = planMatches[0];
    const planDigest = hash(JSON.stringify(plan.content));
    if (
      planConflicts(record, { planId: plan.id, version: plan.version, contentSha256: planDigest })
    )
      fail("APPLICATION_PLAN_CHANGED");
    let prior: ApplicationSubmission | undefined;
    if (input.action === "correct-application-submission") {
      prior = latestApplicationSubmissions(record, input.applicationId).find(
        (item) => item.submissionRecordId === input.submissionRecordId,
      );
      if (!prior || prior.id !== input.previousVersionId) fail("APPLICATION_VERSION_STALE");
    }
    receiptFor(record, input.applicationId, input.receiptRecordId);
    // All membership checks precede opening any selected original.
    for (const id of input.sourceIds)
      if (record.sources.filter((item) => item.id === id && item.originalName).length !== 1)
        fail("SOURCE_NOT_FOUND", 404);
    const tasks = input.taskIds.map((id) => {
      const matches = record.tasks.filter((task) => task.id === id);
      if (matches.length !== 1) fail("APPLICATION_TASK_NOT_FOUND", 404);
      const task = matches[0];
      if (task.agencyOrigin) {
        const chain = agencyChain(record, task.agencyOrigin.requestVersionId);
        if (chain.chainKind !== "request" || chain.rootId !== task.agencyOrigin.requestRecordId)
          fail("APPLICATION_CHAIN_CONFLICT");
        const link = linkFor(record, chain);
        if (link?.applicationId && link.applicationId !== input.applicationId)
          fail("APPLICATION_CHAIN_CONFLICT");
      }
      return {
        taskId: task.id,
        title: task.title,
        agencyOrigin: task.agencyOrigin ?? null,
        owners: task.owners ?? { materials: "", writing: "", review: "" },
      };
    });
    const references = evidence(record, plan);
    if (references.length > applicationLimits.evidenceCount)
      fail("APPLICATION_SNAPSHOT_LIMIT", 413);
    const originals: ApplicationSubmission["originals"] = [];
    let totalOriginalBytes = 0;
    for (const id of input.sourceIds) {
      const original = originalSnapshot(record, id, context);
      totalOriginalBytes += original.sizeBytes;
      if (totalOriginalBytes > applicationLimits.totalOriginalBytes)
        fail("APPLICATION_ORIGINAL_LIMIT", 413);
      originals.push(original);
    }
    const event = applicationEventSchema.parse({
      ...base,
      kind: prior ? "submission-correction" : "submission-recorded",
      applicationId: input.applicationId,
      submissionRecordId: prior?.submissionRecordId ?? base.id,
      previousVersionId: prior?.id ?? null,
      version: prior ? prior.version + 1 : 1,
      occurredOn: input.occurredOn,
      recordedBy: input.recordedBy,
      note: input.note,
      claim: "reported-submitted",
      officialVerification: "unverified",
      companySnapshot: {
        caseId: record.id,
        revision: record.revision,
        companyName: record.profile.companyName,
        businessNumber: record.profile.businessNumber,
      },
      plan: {
        id: plan.id,
        version: plan.version,
        generatedAt: plan.generatedAt,
        mode: plan.mode,
        candidateId: plan.candidateId,
        sourceRevision: plan.sourceRevision,
        contentSha256: planDigest,
        confirmedAt: plan.confirmedAt,
        review: plan.review,
        sections: plan.content.sections.map((section) => ({
          key: section.key,
          needsConfirmation: section.needsConfirmation,
        })),
        latestVersion: record.plans.at(-1)?.id === plan.id,
        currentEvidence: Boolean(
          record.analysis &&
          plan.sourceRevision >= context.evidenceRevision &&
          plan.candidateId === record.selectedCandidateId,
        ),
      },
      evidence: references,
      originals,
      owners: tasks,
      receiptRecordId: input.receiptRecordId,
    });
    for (const original of originals)
      if (
        JSON.stringify(originalSnapshot(record, original.sourceId, context)) !==
        JSON.stringify(original)
      )
        fail("APPLICATION_ORIGINAL_CHANGED");
    record.applicationEvents.push(event);
  }
  assertApplicationCapacity(record);
}
