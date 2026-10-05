import "server-only";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  assertPublicComparisonDataOnly,
  inspectPublicComparisonNativeArchive,
  lookupPublicComparisonNativeNonce,
  createPublicComparisonBudgetEvent,
  publicComparisonBudgetInputDigest,
  type PublicComparisonPrefix,
  type PublicComparisonCoverage,
  type PublicComparisonBudgetSuffix,
  type PublicComparisonBudgetEvent,
} from "./studio-public-claim-comparison-budget";
import {
  publicComparisonNativeRecordsSchema,
  createPublicComparisonNativeRun,
  createPublicComparisonNativeEvent,
  publicComparisonNativeInputDigest,
  type PublicComparisonNativeRecords,
  type PublicComparisonNativeEvent,
} from "./studio-public-claim-comparison-native";
import {
  buildPublicClaimComparisonRequest,
  inspectPublicClaimComparisonRequest,
  inspectArchivedPublicClaimRequest,
  publicClaimComparisonRequestCommandSchema,
  publicClaimComparisonRequestIdentitySchema,
  type PublicClaimComparisonRequestPreview,
} from "./studio-public-claim-comparison-request";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import type { StudioCase } from "./studio-schema";
import {
  comparisonPlanAuthority as authority,
  comparisonHashSchema as hash,
  comparisonPlanFail as fail,
  comparisonSha as sha,
  comparisonBytes as bytes,
  comparisonFinancialEvidenceSchema,
  createComparisonFinancialBasis,
  comparisonConsentNotice,
} from "./studio-public-claim-comparison-financial";

const MiB = 1024 * 1024;
const uuid = z.string().uuid(),
  integer = z.number().int().nonnegative().safe(),
  time = z.string().datetime();
const purpose = z.literal("compare-public-claim");
const head = z.object({ revision: integer, headDigest: hash }).strict();
const approval = z
  .object({
    noticeVersion: z.literal(1),
    noticeDigest: hash,
    retentionNoticeDigest: hash,
    approvedAt: time,
    expiresAt: time,
    comparisonPurposeAcknowledged: z.literal(true),
    selectedContentRetentionAcknowledged: z.literal(true),
    currentBudgetReservationAcknowledged: z.literal(true),
    financialBasisNotTokenFitAcknowledged: z.literal(true),
    noAutomaticRetryAcknowledged: z.literal(true),
    transmission: z.literal("separate-approval-required"),
  })
  .strict();
export const comparisonReserveCommandSchema = z
  .object({
    commandVersion: z.literal(1),
    kind: z.literal("reserve-public-claim-comparison"),
    purpose,
    clientRequestId: uuid,
    companyId: uuid,
    companyRevision: integer,
    request: publicClaimComparisonRequestCommandSchema,
    identity: publicClaimComparisonRequestIdentitySchema,
    approvedReviewDigest: hash,
    expectedArchiveDigest: hash,
    expectedBudgetHead: head,
    expectedGlobalRunCount: integer.max(20),
    approval,
  })
  .strict();
export const comparisonCancelCommandSchema = z
  .object({
    commandVersion: z.literal(1),
    kind: z.literal("cancel-public-claim-comparison"),
    purpose,
    clientRequestId: uuid,
    runId: uuid,
    expectedBindingDigest: hash,
    reservationDigest: hash,
    expectedRunHead: head,
    expectedBudgetHead: head,
  })
  .strict();
type Reserve = z.infer<typeof comparisonReserveCommandSchema>;
type Cancel = z.infer<typeof comparisonCancelCommandSchema>;
type Archive = {
  records: PublicComparisonNativeRecords;
  financial: Omit<PublicComparisonBudgetSuffix, "evidence">;
};
const bindingSchema = z
  .object({
    recordVersion: z.literal(3),
    kind: z.literal("public-comparison-reservation-binding"),
    purpose,
    clientRequestId: uuid,
    command: comparisonReserveCommandSchema,
    commandDigest: hash,
    approvedReview: z.unknown(),
    reviewDigest: hash,
    runId: uuid,
    runDigest: hash,
    manifestDigest: hash,
    reservedEventDigest: hash,
    budgetEventDigest: hash,
    nativeInputDigest: hash,
    recordedAt: time,
    dispatchAllowed: z.literal(false),
    recordDigest: hash,
  })
  .strict();
export type ComparisonReservationBinding = z.infer<typeof bindingSchema>;
export type ComparisonReservationState = {
  prefix: PublicComparisonPrefix;
  coverage: PublicComparisonCoverage;
  archive: Archive;
  bindings: ComparisonReservationBinding[];
  additionalUsedBytes: number;
};
const stateSchema = z
  .object({
    prefix: z.unknown(),
    coverage: z.unknown(),
    archive: z.unknown(),
    bindings: z.array(bindingSchema).max(20),
    additionalUsedBytes: integer.max(256 * MiB),
  })
  .strict();
const authorityResult = { source: "supplied-reservation-plan" as const, owner: null, authority };
function parse<T>(schema: z.ZodType<T>, raw: unknown, limit = 8192): T {
  assertPublicComparisonDataOnly(raw, limit);
  if (bytes(raw) > limit) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return schema.parse(raw);
}
function archiveDigest(s: ComparisonReservationState) {
  return digest({
    coverageDigest: s.coverage.coverageDigest,
    archive: s.archive,
    bindings: s.bindings,
  });
}
function view(s: ComparisonReservationState) {
  const native = inspectPublicComparisonNativeArchive(s.prefix, s.coverage, s.archive);
  const bindingBytes = s.bindings.reduce((n, b) => n + bytes(b), 0);
  const exposure =
    native.capacity.prefixUsedBytes +
    native.capacity.coverageBytes +
    native.capacity.comparisonUsedBytes +
    native.capacity.comparisonHeldBytes +
    bindingBytes +
    s.additionalUsedBytes;
  if (
    exposure > 256 * MiB ||
    s.prefix.rows.reservationRows.bindingRows.length + s.bindings.length > 20
  )
    fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return {
    native,
    archiveDigest: archiveDigest(s),
    globalRunCount: s.prefix.rows.actualRows.runs.length + s.archive.records.runs.length,
    capacity: {
      bindingBytes,
      additionalUsedBytes: s.additionalUsedBytes,
      totalExposureBytes: exposure,
    },
  };
}
type View = ReturnType<typeof view>;
function reviewFor(
  s: ComparisonReservationState,
  v: View,
  request: PublicClaimComparisonRequestPreview,
  context: string,
  evidence: unknown,
  at: string,
) {
  const financialBasis = createComparisonFinancialBasis(
    evidence,
    request.identity,
    request.command.model,
    s.prefix.environment,
    at,
  );
  if (
    financialBasis.costs.currency !== v.native.currency ||
    financialBasis.costs.unitScale !== v.native.unitScale ||
    v.native.heldUnits !== "0" ||
    v.native.boundBreached ||
    v.native.runs.some((r) => !r.finalized) ||
    BigInt(financialBasis.costs.reservedUnits) > BigInt(v.native.availableUnits)
  )
    fail("PUBLIC_COMPARISON_RESERVATION_UNAVAILABLE");
  const expiresAt = new Date(
    Math.min(Date.parse(at) + 600000, Date.parse(financialBasis.validUntil)),
  ).toISOString();
  const notice = { ...comparisonConsentNotice, noticeDigest: digest(comparisonConsentNotice) };
  const retentionNotice = financialBasis.evidence.retention;
  const body = {
    reviewVersion: 1 as const,
    kind: "public-comparison-reservation-review" as const,
    purpose: "compare-public-claim" as const,
    source: "supplied-reservation-review" as const,
    inspectedAt: at,
    expiresAt,
    databaseInstanceId: s.prefix.databaseInstanceId,
    coverageDigest: s.coverage.coverageDigest,
    scopeId: s.prefix.scopeId,
    environment: s.prefix.environment,
    archiveDigest: v.archiveDigest,
    companyId: request.command.selection.companyId,
    companyRevision: request.command.selection.companyRevision,
    request: request.command,
    identity: request.identity,
    contextSha256: sha(context),
    budget: {
      revision: v.native.revision,
      headDigest: v.native.headDigest,
      currency: v.native.currency,
      unitScale: v.native.unitScale,
      capUnits: v.native.capUnits,
      recognizedUnits: v.native.recognizedUnits,
      heldUnits: v.native.heldUnits,
      availableUnits: v.native.availableUnits,
    },
    globalRunCount: v.globalRunCount,
    capacity: v.capacity,
    financialBasis,
    retentionNotice,
    retentionNoticeDigest: digest(retentionNotice),
    notice,
    requestedTier: null,
    maxCalls: 1 as const,
    automaticRetryLimit: 0 as const,
    maxOutputTokens: 16000 as const,
    owner: null,
    authority,
  };
  const result = { ...body, reviewDigest: digest(body) };
  if (bytes(result) > 64 * 1024) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return result;
}
export type ComparisonReservationReview = ReturnType<typeof reviewFor>;
function same(a: unknown, b: unknown) {
  if (digest(a) !== digest(b)) fail("PUBLIC_COMPARISON_PLAN_CHANGED");
}
function validateCommand(c: Reserve, r: ComparisonReservationReview, at: string) {
  same(c.request, r.request);
  same(c.identity, r.identity);
  same(c.expectedBudgetHead, { revision: r.budget.revision, headDigest: r.budget.headDigest });
  if (
    c.companyId !== r.companyId ||
    c.companyRevision !== r.companyRevision ||
    c.approvedReviewDigest !== r.reviewDigest ||
    c.expectedArchiveDigest !== r.archiveDigest ||
    c.expectedGlobalRunCount !== r.globalRunCount ||
    c.approval.noticeDigest !== r.notice.noticeDigest ||
    c.approval.retentionNoticeDigest !== r.retentionNoticeDigest ||
    c.approval.expiresAt !== r.expiresAt ||
    Date.parse(c.approval.approvedAt) < Date.parse(r.inspectedAt) ||
    Date.parse(c.approval.approvedAt) > Date.parse(at) ||
    Date.parse(at) >= Date.parse(r.expiresAt)
  )
    fail("PUBLIC_COMPARISON_APPROVAL_MISMATCH");
}
function sliceBefore(s: ComparisonReservationState, index: number): ComparisonReservationState {
  const ids = new Set(s.archive.records.runs.slice(0, index).map((r) => r.id));
  return {
    ...s,
    archive: {
      records: {
        runs: s.archive.records.runs.slice(0, index),
        events: s.archive.records.events.filter((e) => ids.has(e.runId)),
        receipts: s.archive.records.receipts.filter((e) => ids.has(e.runId)),
        artifacts: s.archive.records.artifacts.filter((e) => ids.has(e.runId)),
      },
      financial: {
        events: s.archive.financial.events.filter((e) => ids.has(e.payload.runId)),
        receipts: s.archive.financial.receipts.filter((e) => ids.has(e.runId)),
      },
    },
    bindings: s.bindings.slice(0, index),
  };
}
function cancelFrom(
  s: ComparisonReservationState,
  b: ComparisonReservationBinding,
  e: PublicComparisonNativeEvent,
): Cancel {
  const receipt = s.archive.records.receipts.find((r) => r.operationDigest === e.eventDigest);
  const budget = s.archive.financial.events.find(
    (x) => x.eventDigest === receipt?.budgetOperationDigest,
  );
  if (e.payload.kind !== "cancelled" || !receipt || budget?.payload.kind !== "release-comparison")
    fail();
  return {
    commandVersion: 1,
    kind: "cancel-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: receipt.clientRequestId,
    runId: b.runId,
    expectedBindingDigest: b.recordDigest,
    reservationDigest: b.budgetEventDigest,
    expectedRunHead: { revision: e.revision - 1, headDigest: e.previousDigest },
    expectedBudgetHead: { revision: budget.revision - 1, headDigest: budget.previousDigest },
  };
}
/** Audit bound runs without consulting current company, settings, time, DB or providers. */
export function inspectComparisonReservationState(raw: unknown) {
  assertPublicComparisonDataOnly(raw);
  const outer = stateSchema.parse(raw);
  // view performs the full existing audit before interpreting the detached supplied copy.
  const s = structuredClone(outer) as ComparisonReservationState;
  const current = view(s);
  s.archive.records = publicComparisonNativeRecordsSchema.parse(s.archive.records);
  if (s.bindings.length !== s.archive.records.runs.length)
    fail("PUBLIC_COMPARISON_BINDING_REQUIRED");
  const cancellations: Cancel[] = [];
  for (const [i, run] of s.archive.records.runs.entries()) {
    const b = s.bindings[i];
    if (
      bytes(b) > 64 * 1024 ||
      b.runId !== run.id ||
      b.runDigest !== run.runDigest ||
      b.manifestDigest !== run.manifestDigest ||
      b.recordedAt !== run.createdAt ||
      b.clientRequestId !== b.command.clientRequestId
    )
      fail();
    const { recordDigest, ...body } = b;
    same(recordDigest, digest(body));
    same(b.commandDigest, digest(b.command));
    const archived = s.archive.records.artifacts.find(
      (a) => a.runId === run.id && a.key === "comparison-context",
    );
    if (!archived) fail();
    const request = inspectArchivedPublicClaimRequest(run.command, archived.body).request;
    const skeleton = z
      .object({
        inspectedAt: time,
        capacity: z.object({ additionalUsedBytes: integer }).passthrough(),
        financialBasis: z.object({ evidence: comparisonFinancialEvidenceSchema }).passthrough(),
      })
      .passthrough()
      .parse(b.approvedReview);
    const previous = sliceBefore(s, i);
    previous.additionalUsedBytes = skeleton.capacity.additionalUsedBytes;
    const review = reviewFor(
      previous,
      view(previous),
      request,
      archived.body,
      skeleton.financialBasis.evidence,
      skeleton.inspectedAt,
    );
    same(b.approvedReview, review);
    same(b.reviewDigest, review.reviewDigest);
    validateCommand(b.command, review, run.createdAt);
    same(run.command, b.command.request);
    same(run.identity, b.command.identity);
    same(run.manifest.expectedBudgetHead, b.command.expectedBudgetHead);
    if (
      run.manifest.reservedUnits !== review.financialBasis.costs.reservedUnits ||
      run.manifest.expiresAt !== review.expiresAt ||
      run.manifest.contextSha256 !== review.contextSha256
    )
      fail();
    const reserved = s.archive.records.events.find((e) => e.runId === run.id && e.revision === 1);
    const receipt = s.archive.records.receipts.find((r) => r.clientRequestId === b.clientRequestId);
    if (
      reserved?.payload.kind !== "reserved" ||
      reserved.eventDigest !== b.reservedEventDigest ||
      reserved.payload.budgetEventDigest !== b.budgetEventDigest ||
      receipt?.operationDigest !== b.reservedEventDigest ||
      receipt?.inputDigest !== b.nativeInputDigest ||
      receipt?.budgetOperationDigest !== b.budgetEventDigest
    )
      fail();
    const cancel = s.archive.records.events.find(
      (e) => e.runId === run.id && e.payload.kind === "cancelled",
    );
    if (cancel) {
      const end = s.archive.records.events.find(
        (e) => e.runId === run.id && e.revision === cancel.revision + 1,
      );
      if (end?.payload.kind !== "finalized" || end.recordedAt !== cancel.recordedAt)
        fail("PUBLIC_COMPARISON_PARTIAL_CANCELLATION");
      cancellations.push(cancelFrom(s, b, cancel));
    }
  }
  return {
    ...authorityResult,
    status: "inspected" as const,
    state: s,
    view: current,
    cancellations,
  };
}
function freeNonce(s: ComparisonReservationState, nonce: string) {
  const old = lookupPublicComparisonNativeNonce(s.prefix, s.coverage, s.archive, {
    nonce,
    inputDigest: digest({ purpose: "comparison-nonce-probe" }),
  });
  if (old.status !== "not-observed") fail("PUBLIC_COMPARISON_NONCE_CONFLICT");
}
function freshIds(s: ComparisonReservationState, ids: string[]) {
  const old = new Set([
    ...s.prefix.rows.actualRows.runs.map((r) => r.id),
    ...s.archive.records.runs.map((r) => r.id),
    ...s.prefix.rows.actualRows.budget.map((r) => JSON.parse(r.body).eventId as string),
    ...s.prefix.rows.actualRows.events.map((r) => JSON.parse(r.body).eventId as string),
    ...s.archive.financial.events.map((e) => e.eventId),
    ...s.archive.records.events.map((e) => e.eventId),
    ...s.archive.records.receipts.map((e) => e.clientRequestId),
  ]);
  if (new Set(ids).size !== ids.length || ids.some((id) => old.has(id)))
    fail("PUBLIC_COMPARISON_ID_CONFLICT");
}
export function createComparisonReservationReview(
  stateRaw: unknown,
  company: StudioCase,
  commandRaw: unknown,
  evidenceRaw: unknown,
  at: string,
) {
  const inspected = inspectComparisonReservationState(stateRaw);
  assertPublicComparisonDataOnly(company, 8 * MiB);
  const command = parse(publicClaimComparisonRequestCommandSchema, commandRaw);
  const request = buildPublicClaimComparisonRequest(company, command);
  const context = JSON.stringify(preparePublicClaimComparison(company, command.selection));
  return reviewFor(inspected.state, inspected.view, request, context, evidenceRaw, time.parse(at));
}
function artifact(
  runId: string,
  key: PublicComparisonNativeRecords["artifacts"][number]["key"],
  body: string,
) {
  return { runId, key, body, sha256: sha(body), sizeBytes: Buffer.byteLength(body) };
}
function addMoney(
  s: ComparisonReservationState,
  e: PublicComparisonNativeEvent,
  b: PublicComparisonBudgetEvent,
  nonce: string,
) {
  const inputDigest = publicComparisonBudgetInputDigest(b);
  s.archive.financial.events.push(b);
  s.archive.financial.receipts.push({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    scopeId: b.scopeId,
    clientRequestId: nonce,
    runId: e.runId,
    inputDigest,
    budgetRevision: b.revision,
    operationDigest: b.eventDigest,
    recordedAt: e.recordedAt,
  });
  const receipt = {
    schemaVersion: 3 as const,
    purpose: "compare-public-claim" as const,
    runId: e.runId,
    clientRequestId: nonce,
    inputDigest,
    eventRevision: e.revision,
    operationDigest: e.eventDigest,
    budgetOperationDigest: b.eventDigest,
    recordedAt: e.recordedAt,
  };
  s.archive.records.events.push(e);
  s.archive.records.receipts.push(receipt);
  return receipt;
}
function money(
  s: ComparisonReservationState,
  v: View,
  eventId: string,
  at: string,
  payload: PublicComparisonBudgetEvent["payload"],
) {
  return createPublicComparisonBudgetEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    scopeId: s.prefix.scopeId,
    environment: s.prefix.environment,
    provenance: s.prefix.environment === "synthetic-test" ? "synthetic-test" : "explicit-user",
    currency: v.native.currency!,
    unitScale: v.native.unitScale!,
    revision: v.native.revision + 1,
    previousDigest: v.native.headDigest!,
    eventId,
    recordedAt: at,
    payload,
  });
}
/** Replay checks the complete original command before even examining current input. */
export function planComparisonReservation(stateRaw: unknown, raw: unknown, currentRaw?: unknown) {
  const c = parse(comparisonReserveCommandSchema, raw);
  const inspected = inspectComparisonReservationState(stateRaw),
    s = inspected.state;
  const existing = s.bindings.find((b) => b.clientRequestId === c.clientRequestId);
  if (existing) {
    same(existing.command, c);
    return { ...authorityResult, status: "replay" as const, binding: existing, rows: null };
  }
  freeNonce(s, c.clientRequestId);
  const cur = parse(
    z
      .object({
        company: z.unknown(),
        approvedReview: z.unknown(),
        evidence: comparisonFinancialEvidenceSchema,
        at: time,
        runId: uuid,
        eventId: uuid,
        budgetEventId: uuid,
      })
      .strict(),
    currentRaw,
    8 * MiB,
  );
  const request = inspectPublicClaimComparisonRequest(
    cur.company as StudioCase,
    c.request,
    c.identity,
  );
  const context = JSON.stringify(
    preparePublicClaimComparison(cur.company as StudioCase, c.request.selection),
  );
  const skeleton = z.object({ inspectedAt: time }).passthrough().parse(cur.approvedReview);
  const review = reviewFor(s, inspected.view, request, context, cur.evidence, skeleton.inspectedAt);
  same(cur.approvedReview, review);
  validateCommand(c, review, cur.at);
  // Recheck evidence at the supplied current time; the earlier review's digests remain immutable.
  createComparisonFinancialBasis(
    cur.evidence,
    c.identity,
    c.request.model,
    s.prefix.environment,
    cur.at,
  );
  freshIds(s, [c.clientRequestId, cur.runId, cur.eventId, cur.budgetEventId]);
  const manifest = {
    version: 1 as const,
    purpose: "compare-public-claim" as const,
    coverageDigest: s.coverage.coverageDigest,
    scopeId: s.prefix.scopeId,
    environment: s.prefix.environment,
    currency: review.budget.currency!,
    unitScale: review.budget.unitScale!,
    expectedBudgetHead: c.expectedBudgetHead,
    reservedUnits: review.financialBasis.costs.reservedUnits,
    requestIdentityDigest: digest(c.identity),
    contextSha256: review.contextSha256,
    expiresAt: review.expiresAt,
    maxCalls: 1 as const,
    automaticRetryLimit: 0 as const,
    storageReservationBytes: 33554432 as const,
    selectedContentRetentionAcknowledged: true as const,
    comparisonPurposeAcknowledged: true as const,
  };
  const run = createPublicComparisonNativeRun({
    schemaVersion: 3,
    archiveFormatVersion: 4,
    purpose: "compare-public-claim",
    id: cur.runId,
    createdAt: cur.at,
    command: c.request,
    identity: c.identity,
    manifest,
    manifestDigest: digest(manifest),
  });
  const b = money(s, inspected.view, cur.budgetEventId, cur.at, {
    kind: "reserve-comparison",
    runId: run.id,
    requestDigest: c.identity.requestDigest,
    manifestDigest: run.manifestDigest,
    reservedUnits: manifest.reservedUnits,
  });
  const e = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId: run.id,
    eventId: cur.eventId,
    revision: 1,
    previousDigest: run.runDigest,
    recordedAt: cur.at,
    payload: { kind: "reserved", budgetEventDigest: b.eventDigest },
  });
  const artifacts = [
    artifact(run.id, "comparison-context", context),
    artifact(run.id, "comparison-request", request.rawBody),
  ];
  s.archive.records.runs.push(run);
  s.archive.records.artifacts.push(...artifacts);
  const receipt = addMoney(s, e, b, c.clientRequestId);
  const bindingBody = {
    recordVersion: 3 as const,
    kind: "public-comparison-reservation-binding" as const,
    purpose: "compare-public-claim" as const,
    clientRequestId: c.clientRequestId,
    command: c,
    commandDigest: digest(c),
    approvedReview: review,
    reviewDigest: review.reviewDigest,
    runId: run.id,
    runDigest: run.runDigest,
    manifestDigest: run.manifestDigest,
    reservedEventDigest: e.eventDigest,
    budgetEventDigest: b.eventDigest,
    nativeInputDigest: receipt.inputDigest,
    recordedAt: cur.at,
    dispatchAllowed: false as const,
  };
  const binding = bindingSchema.parse({ ...bindingBody, recordDigest: digest(bindingBody) });
  s.bindings.push(binding);
  const after = inspectComparisonReservationState(s);
  return {
    ...authorityResult,
    status: "prepared-not-committed" as const,
    operation: "reserve" as const,
    transaction: "single-immediate-transaction-required" as const,
    rows: { run, artifacts, budgetEvent: b, event: e, receipt, binding },
    next: after.state,
    capacity: after.view.capacity,
  };
}
export function planComparisonCancellation(stateRaw: unknown, raw: unknown, currentRaw?: unknown) {
  const c = parse(comparisonCancelCommandSchema, raw);
  const inspected = inspectComparisonReservationState(stateRaw),
    s = inspected.state;
  const existing = inspected.cancellations.find((x) => x.clientRequestId === c.clientRequestId);
  if (existing) {
    same(existing, c);
    return { ...authorityResult, status: "replay" as const, command: existing, rows: null };
  }
  freeNonce(s, c.clientRequestId);
  const binding = s.bindings.find((b) => b.runId === c.runId);
  const run = s.archive.records.runs.find((r) => r.id === c.runId);
  const summary = inspected.view.native.runs.find((r) => r.runId === c.runId);
  if (
    !binding ||
    !run ||
    !summary ||
    summary.dispatchRecorded ||
    summary.costSettled ||
    summary.finalized
  )
    fail("PUBLIC_COMPARISON_NOT_CANCELLABLE");
  if (
    c.expectedBindingDigest !== binding.recordDigest ||
    c.reservationDigest !== binding.budgetEventDigest
  )
    fail();
  same(c.expectedRunHead, { revision: summary.revision, headDigest: summary.headDigest });
  same(c.expectedBudgetHead, {
    revision: inspected.view.native.revision,
    headDigest: inspected.view.native.headDigest,
  });
  const cur = parse(
    z
      .object({
        at: time,
        eventId: uuid,
        budgetEventId: uuid,
        finalEventId: uuid,
        finalizationNonce: uuid,
      })
      .strict(),
    currentRaw,
  );
  freeNonce(s, cur.finalizationNonce);
  freshIds(s, [
    c.clientRequestId,
    cur.eventId,
    cur.budgetEventId,
    cur.finalEventId,
    cur.finalizationNonce,
  ]);
  const e = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId: run.id,
    eventId: cur.eventId,
    revision: summary.revision + 1,
    previousDigest: summary.headDigest,
    recordedAt: cur.at,
    payload: {
      kind: "cancelled",
      reservationDigest: binding.budgetEventDigest,
      reason: "not-dispatched",
    },
  });
  const b = money(s, inspected.view, cur.budgetEventId, cur.at, {
    kind: "release-comparison",
    runId: run.id,
    reservationDigest: binding.budgetEventDigest,
    reason: "not-dispatched",
    cancellationEventDigest: e.eventDigest,
    releasedUnits: run.manifest.reservedUnits,
  });
  const receipt = addMoney(s, e, b, c.clientRequestId);
  const final = artifact(
    run.id,
    "final-result",
    JSON.stringify({
      schemaVersion: 3,
      purpose: "compare-public-claim",
      runId: run.id,
      requestDigest: run.identity.requestDigest,
      manifestDigest: run.manifestDigest,
      cancelled: true,
      responseArtifactSha256: null,
      comparisonState: null,
      assessmentDigest: null,
      costSettled: true,
      source: "supplied-native-archive",
      currentContextVerified: false,
      dispatchAllowed: false,
      costAssessmentVerified: false,
    }),
  );
  const end = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId: run.id,
    eventId: cur.finalEventId,
    revision: e.revision + 1,
    previousDigest: e.eventDigest,
    recordedAt: cur.at,
    payload: { kind: "finalized", finalArtifactSha256: final.sha256 },
  });
  const endReceipt = {
    schemaVersion: 3 as const,
    purpose: "compare-public-claim" as const,
    runId: run.id,
    clientRequestId: cur.finalizationNonce,
    inputDigest: publicComparisonNativeInputDigest(end),
    eventRevision: end.revision,
    operationDigest: end.eventDigest,
    budgetOperationDigest: null,
    recordedAt: cur.at,
  };
  s.archive.records.artifacts.push(final);
  s.archive.records.events.push(end);
  s.archive.records.receipts.push(endReceipt);
  const after = inspectComparisonReservationState(s);
  same(
    after.cancellations.find((x) => x.clientRequestId === c.clientRequestId),
    c,
  );
  return {
    ...authorityResult,
    status: "prepared-not-committed" as const,
    operation: "cancel" as const,
    transaction: "single-immediate-transaction-required" as const,
    rows: { events: [e, end], budgetEvent: b, receipts: [receipt, endReceipt], artifact: final },
    next: after.state,
    capacity: after.view.capacity,
  };
}

export { bindingSchema as comparisonReservationBindingSchema };
