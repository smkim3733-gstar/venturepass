import "server-only";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerProposalSourceDigestInput } from "./studio-plan-quality-provider-review-types";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import {
  inspectComparisonReservationState,
  assertComparisonFreeNonce,
  assertComparisonFreshIds,
  type ComparisonReservationState,
  type ComparisonReservationReview,
} from "./studio-public-claim-comparison-reservation";
import {
  createPublicComparisonNativeEvent,
  publicComparisonNativeInputDigest,
  type PublicComparisonNativeEvent,
  type PublicComparisonNativeRecords,
} from "./studio-public-claim-comparison-native";
import {
  inspectPublicClaimComparisonRequest,
  publicClaimComparisonRequestPins,
} from "./studio-public-claim-comparison-request";
import {
  comparisonPlanAuthority as authority,
  comparisonPlanFail as fail,
  comparisonBytes as bytes,
  comparisonSha as sha,
  createComparisonFinancialBasis,
} from "./studio-public-claim-comparison-financial";
import type { StudioCase } from "./studio-schema";
import {
  comparisonTransmissionBasisSchema,
  comparisonTransmissionBindingSchema,
  comparisonDispatchCommandSchema,
  comparisonUnknownCommandSchema,
  comparisonCaptureCommandSchema,
  comparisonTransmissionNotice,
  comparisonTransmissionTime as time,
  comparisonTransmissionUuid as uuid,
  type ComparisonTransmissionBinding,
  type ComparisonDispatchCommand,
  type ComparisonUnknownCommand,
  type ComparisonCaptureCommand,
} from "./studio-public-claim-comparison-transmission-types";
export * from "./studio-public-claim-comparison-transmission-types";

const MiB = 1024 * 1024;
type ReservationInspection = ReturnType<typeof inspectComparisonReservationState>;
type Receipt = PublicComparisonNativeRecords["receipts"][number];
type Artifact = PublicComparisonNativeRecords["artifacts"][number];
export type ComparisonTransmissionState = {
  reservation: ComparisonReservationState;
  transmissionBindings: ComparisonTransmissionBinding[];
};
const outerSchema = z
  .object({
    reservation: z.unknown(),
    transmissionBindings: z.array(comparisonTransmissionBindingSchema).max(20),
  })
  .strict();
const resultAuthority = { source: "supplied-transmission-plan" as const, owner: null, authority };
function parse<T>(schema: z.ZodType<T>, raw: unknown, limit = 8192): T {
  assertPublicComparisonDataOnly(raw, limit);
  if (bytes(raw) > limit) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return schema.parse(raw);
}
function same(a: unknown, b: unknown) {
  if (digest(a) !== digest(b)) fail("PUBLIC_COMPARISON_TRANSMISSION_CHANGED");
}
function view(s: ComparisonTransmissionState, reservation: ReservationInspection) {
  const transmissionBindingBytes = s.transmissionBindings.reduce((n, b) => n + bytes(b), 0);
  const totalExposureBytes =
    reservation.view.capacity.totalExposureBytes + transmissionBindingBytes;
  if (
    totalExposureBytes > 256 * MiB ||
    s.reservation.prefix.rows.transmissionRows.bindingRows.length + s.transmissionBindings.length >
      20
  )
    fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return {
    reservationArchiveDigest: reservation.view.archiveDigest,
    transmissionArchiveDigest: digest({
      reservationArchiveDigest: reservation.view.archiveDigest,
      transmissionBindings: s.transmissionBindings,
    }),
    capacity: { ...reservation.view.capacity, transmissionBindingBytes, totalExposureBytes },
  };
}
function original(s: ComparisonTransmissionState, runId: string) {
  const run = s.reservation.archive.records.runs.find((r) => r.id === runId);
  const binding = s.reservation.bindings.find((b) => b.runId === runId);
  if (!run || !binding) fail("PUBLIC_COMPARISON_RESERVATION_REQUIRED");
  // The reservation inspector has already rebuilt and exactly compared this review.
  const review = binding.approvedReview as ComparisonReservationReview;
  return { run, binding, review };
}
function runHead(s: ComparisonTransmissionState, runId: string) {
  const e = s.reservation.archive.records.events.filter((e) => e.runId === runId).at(-1);
  if (!e) fail();
  return { revision: e.revision, headDigest: e.eventDigest };
}
function validateBasis(raw: unknown, s: ComparisonTransmissionState, runId: string, at: string) {
  const b = parse(comparisonTransmissionBasisSchema, raw, 64 * 1024);
  const { run, review } = original(s, runId);
  if (
    b.model !== run.command.model ||
    b.contractDigest !== run.identity.contractDigest ||
    b.schemaDigest !== publicClaimComparisonRequestPins.schemaDigest ||
    b.financialBasisDigest !== review.financialBasis.basisDigest ||
    b.retentionNoticeDigest !== review.retentionNoticeDigest ||
    (s.reservation.prefix.environment === "production" && b.provenance !== "official-reviewed")
  )
    fail("PUBLIC_COMPARISON_TRANSMISSION_BASIS");
  same(b.notice, {
    ...comparisonTransmissionNotice,
    noticeDigest: digest(comparisonTransmissionNotice),
  });
  createComparisonFinancialBasis(
    review.financialBasis.evidence,
    run.identity,
    run.command.model,
    s.reservation.prefix.environment,
    at,
  );
  const sourceIds = new Set<string>();
  for (const source of b.sources) {
    if (
      sourceIds.has(source.id) ||
      sha(source.excerpt) !== source.excerptSha256 ||
      digest(providerProposalSourceDigestInput(source)) !== source.recordDigest ||
      (source.digestKind === "body") !== (source.bodySha256 !== null) ||
      Date.parse(source.retrievedAt) > Date.parse(source.reviewedAt) ||
      Date.parse(source.reviewedAt) > Date.parse(at) ||
      Date.parse(at) >= Date.parse(source.validUntil)
    )
      fail("PUBLIC_COMPARISON_TRANSMISSION_BASIS");
    sourceIds.add(source.id);
  }
  const used = new Set<string>();
  for (const item of Object.values(b.omissions)) {
    if (
      new Set(item.sourceIds).size !== item.sourceIds.length ||
      item.sourceIds.some((id) => !sourceIds.has(id))
    )
      fail("PUBLIC_COMPARISON_TRANSMISSION_BASIS");
    item.sourceIds.forEach((id) => used.add(id));
  }
  if (used.size !== sourceIds.size) fail("PUBLIC_COMPARISON_TRANSMISSION_BASIS");
  return b;
}
function reviewFor(
  s: ComparisonTransmissionState,
  inspected: ReservationInspection,
  runId: string,
  raw: unknown,
  atRaw: string,
) {
  const at = time.parse(atRaw),
    { run, binding, review: reserved } = original(s, runId);
  const head = runHead(s, runId),
    native = inspected.view.native;
  if (
    head.revision !== 1 ||
    s.transmissionBindings.some((b) => b.runId === runId) ||
    native.boundBreached ||
    native.heldUnits !== run.manifest.reservedUnits ||
    native.runs.some((r) => r.runId !== runId && !r.finalized)
  )
    fail("PUBLIC_COMPARISON_TRANSMISSION_UNAVAILABLE");
  if (Date.parse(at) < Date.parse(run.createdAt)) fail("PUBLIC_COMPARISON_TRANSMISSION_CHANGED");
  const basis = validateBasis(raw, s, runId, at);
  const expiresAt = new Date(
    Math.min(
      Date.parse(at) + 600000,
      Date.parse(run.manifest.expiresAt),
      Date.parse(reserved.financialBasis.validUntil),
      ...basis.sources.map((x) => Date.parse(x.validUntil)),
    ),
  ).toISOString();
  if (Date.parse(at) >= Date.parse(expiresAt)) fail("PUBLIC_COMPARISON_TRANSMISSION_EXPIRED");
  const v = view(s, inspected);
  const body = {
    reviewVersion: 1 as const,
    kind: "public-comparison-transmission-review" as const,
    purpose: "compare-public-claim" as const,
    source: "supplied-transmission-review" as const,
    inspectedAt: at,
    expiresAt,
    runId,
    runDigest: run.runDigest,
    reservationBindingDigest: binding.recordDigest,
    reservationDigest: binding.budgetEventDigest,
    manifestDigest: run.manifestDigest,
    request: run.command,
    identity: run.identity,
    contextSha256: run.manifest.contextSha256,
    companyId: run.command.selection.companyId,
    companyRevision: run.command.selection.companyRevision,
    databaseInstanceId: s.reservation.prefix.databaseInstanceId,
    scopeId: s.reservation.prefix.scopeId,
    environment: s.reservation.prefix.environment,
    coverageDigest: s.reservation.coverage.coverageDigest,
    ...v,
    runHead: head,
    budget: {
      revision: native.revision,
      headDigest: native.headDigest,
      currency: native.currency,
      unitScale: native.unitScale,
      capUnits: native.capUnits,
      recognizedUnits: native.recognizedUnits,
      heldUnits: native.heldUnits,
      availableUnits: native.availableUnits,
    },
    globalRunCount: inspected.view.globalRunCount,
    financialBasisDigest: basis.financialBasisDigest,
    retentionNoticeDigest: basis.retentionNoticeDigest,
    basis,
    owner: null,
    authority,
  };
  const review = { ...body, reviewDigest: digest(body) };
  if (bytes(review) > 64 * 1024) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return review;
}
export type ComparisonTransmissionReview = ReturnType<typeof reviewFor>;
function validateCommand(
  c: ComparisonDispatchCommand,
  r: ComparisonTransmissionReview,
  at: string,
) {
  same(c.expectedRunHead, r.runHead);
  same(c.expectedBudgetHead, { revision: r.budget.revision, headDigest: r.budget.headDigest });
  if (
    c.runId !== r.runId ||
    c.runDigest !== r.runDigest ||
    c.expectedReservationBindingDigest !== r.reservationBindingDigest ||
    c.approvedReviewDigest !== r.reviewDigest ||
    c.expectedTransmissionArchiveDigest !== r.transmissionArchiveDigest ||
    c.expectedCoverageDigest !== r.coverageDigest ||
    c.approval.noticeDigest !== r.basis.notice.noticeDigest ||
    c.approval.retentionNoticeDigest !== r.retentionNoticeDigest ||
    c.approval.exactRequestIdentityDigest !== digest(r.identity) ||
    c.approval.expiresAt !== r.expiresAt ||
    Date.parse(c.approval.approvedAt) < Date.parse(r.inspectedAt) ||
    Date.parse(c.approval.approvedAt) > Date.parse(at) ||
    Date.parse(at) >= Date.parse(r.expiresAt)
  )
    fail("PUBLIC_COMPARISON_TRANSMISSION_APPROVAL");
}
function bindingFor(
  c: ComparisonDispatchCommand,
  review: ComparisonTransmissionReview,
  e: PublicComparisonNativeEvent,
  receipt: Receipt,
) {
  const body = {
    recordVersion: 3 as const,
    kind: "public-comparison-transmission-binding" as const,
    purpose: "compare-public-claim" as const,
    clientRequestId: c.clientRequestId,
    command: c,
    commandDigest: digest(c),
    approvedReview: review,
    reviewDigest: review.reviewDigest,
    runId: c.runId,
    runDigest: c.runDigest,
    reservationBindingDigest: review.reservationBindingDigest,
    reservationDigest: review.reservationDigest,
    manifestDigest: review.manifestDigest,
    requestIdentityDigest: digest(review.identity),
    dispatchEventDigest: e.eventDigest,
    dispatchRevision: e.revision,
    nativeInputDigest: receipt.inputDigest,
    recordedAt: e.recordedAt,
    dispatchAllowed: false as const,
  };
  const b = comparisonTransmissionBindingSchema.parse({ ...body, recordDigest: digest(body) });
  if (bytes(b) > 64 * 1024) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return b;
}
/** Restore only the original complete-run prefix and this run's initial reservation.
 * Financial revision/hash bytes are never changed or filtered inside a run. */
function beforeDispatch(s: ComparisonTransmissionState, index: number, overhead: number) {
  const state = s.reservation,
    run = state.archive.records.runs[index];
  const earlier = new Set(state.archive.records.runs.slice(0, index).map((r) => r.id));
  const ids = new Set([...earlier, run.id]);
  const reserve = state.archive.financial.events.find((e) => e.payload.runId === run.id)!;
  const end = state.archive.financial.events.indexOf(reserve);
  const events = state.archive.records.events.filter(
    (e) => earlier.has(e.runId) || (e.runId === run.id && e.revision === 1),
  );
  const operations = new Set(events.map((e) => e.eventDigest));
  const financialEvents = state.archive.financial.events.slice(0, end + 1);
  if (financialEvents.some((e) => !ids.has(e.payload.runId))) fail();
  const financialOperations = new Set(financialEvents.map((e) => e.eventDigest));
  return {
    reservation: {
      ...state,
      additionalUsedBytes: overhead,
      bindings: state.bindings.slice(0, index + 1),
      archive: {
        records: {
          runs: state.archive.records.runs.slice(0, index + 1),
          events,
          receipts: state.archive.records.receipts.filter((r) => operations.has(r.operationDigest)),
          artifacts: state.archive.records.artifacts.filter(
            (a) =>
              earlier.has(a.runId) ||
              (a.runId === run.id && ["comparison-context", "comparison-request"].includes(a.key)),
          ),
        },
        financial: {
          events: financialEvents,
          receipts: state.archive.financial.receipts.filter((r) =>
            financialOperations.has(r.operationDigest),
          ),
        },
      },
    },
    transmissionBindings: s.transmissionBindings.filter((b) => earlier.has(b.runId)),
  };
}
function continuationFrom(
  s: ComparisonTransmissionState,
  binding: ComparisonTransmissionBinding,
  event: PublicComparisonNativeEvent,
) {
  const receipt = s.reservation.archive.records.receipts.find(
    (r) => r.operationDigest === event.eventDigest,
  );
  if (!receipt) fail();
  const base = {
    commandVersion: 1 as const,
    purpose: "compare-public-claim" as const,
    clientRequestId: receipt.clientRequestId,
    runId: event.runId,
    transmissionBindingDigest: binding.recordDigest,
    dispatchEventDigest: binding.dispatchEventDigest,
    expectedRunHead: { revision: event.revision - 1, headDigest: event.previousDigest },
  };
  if (event.payload.kind === "dispatch-unknown")
    return comparisonUnknownCommandSchema.parse({
      ...base,
      kind: "mark-public-comparison-unknown",
      reason: event.payload.reason,
    });
  if (event.payload.kind !== "response-captured") fail();
  const artifact = s.reservation.archive.records.artifacts.find(
    (a) => a.runId === event.runId && a.key === "comparison-response",
  );
  if (!artifact) fail();
  return comparisonCaptureCommandSchema.parse({
    ...base,
    kind: "persist-public-comparison-capture",
    responseArtifactSha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  });
}
export function inspectComparisonTransmissionState(raw: unknown) {
  assertPublicComparisonDataOnly(raw);
  const outer = outerSchema.parse(raw);
  const reservation = inspectComparisonReservationState(outer.reservation);
  const s: ComparisonTransmissionState = {
    reservation: reservation.state,
    transmissionBindings: structuredClone(outer.transmissionBindings),
  };
  const dispatches = s.reservation.archive.records.events.filter(
    (e) => e.payload.kind === "dispatch-recorded",
  );
  if (
    dispatches.length !== s.transmissionBindings.length ||
    new Set(s.transmissionBindings.map((b) => b.runId)).size !== s.transmissionBindings.length
  )
    fail("PUBLIC_COMPARISON_TRANSMISSION_BINDING_REQUIRED");
  const commands: Array<
    ComparisonDispatchCommand | ComparisonUnknownCommand | ComparisonCaptureCommand
  > = [];
  let bindingIndex = 0;
  for (const [index, run] of s.reservation.archive.records.runs.entries()) {
    const event = dispatches.find((e) => e.runId === run.id);
    if (!event) continue;
    const b = s.transmissionBindings[bindingIndex++];
    if (
      b.runId !== run.id ||
      bytes(b) > 64 * 1024 ||
      bytes(b.command) > 8192 ||
      bytes(b.approvedReview) > 64 * 1024
    )
      fail("PUBLIC_COMPARISON_TRANSMISSION_BINDING_REQUIRED");
    const skeleton = z
      .object({
        inspectedAt: time,
        basis: comparisonTransmissionBasisSchema,
        capacity: z
          .object({
            additionalUsedBytes: z
              .number()
              .int()
              .nonnegative()
              .safe()
              .max(256 * MiB),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(b.approvedReview);
    const previous = beforeDispatch(s, index, skeleton.capacity.additionalUsedBytes);
    const originalReservation = inspectComparisonReservationState(previous.reservation);
    const review = reviewFor(
      previous,
      originalReservation,
      run.id,
      skeleton.basis,
      skeleton.inspectedAt,
    );
    validateCommand(b.command, review, event.recordedAt);
    const receipt = s.reservation.archive.records.receipts.find(
      (r) => r.clientRequestId === b.clientRequestId,
    );
    if (!receipt || receipt.operationDigest !== event.eventDigest) fail();
    same(b, bindingFor(b.command, review, event, receipt));
    commands.push(b.command);
    for (const e of s.reservation.archive.records.events.filter((e) => e.runId === run.id))
      if (e.payload.kind === "dispatch-unknown" || e.payload.kind === "response-captured")
        commands.push(continuationFrom(s, b, e));
  }
  return {
    ...resultAuthority,
    status: "inspected" as const,
    state: s,
    reservation,
    view: view(s, reservation),
    commands,
  };
}
type Inspection = ReturnType<typeof inspectComparisonTransmissionState>;
export function createComparisonTransmissionReview(
  raw: unknown,
  company: StudioCase,
  runIdRaw: string,
  basis: unknown,
  at: string,
) {
  const a = inspectComparisonTransmissionState(raw),
    runId = uuid.parse(runIdRaw);
  assertPublicComparisonDataOnly(company, 8 * MiB);
  const { run } = original(a.state, runId);
  inspectPublicClaimComparisonRequest(company, run.command, run.identity);
  return structuredClone(reviewFor(a.state, a.reservation, runId, basis, at));
}
function replay(
  a: Inspection,
  c: ComparisonDispatchCommand | ComparisonUnknownCommand | ComparisonCaptureCommand,
) {
  const old = a.commands.find((x) => x.clientRequestId === c.clientRequestId);
  if (old) {
    same(old, c);
    const receipt = a.state.reservation.archive.records.receipts.find(
      (r) => r.clientRequestId === c.clientRequestId,
    )!;
    return {
      ...resultAuthority,
      status: "replay" as const,
      rows: null,
      command: structuredClone(old),
      receipt: structuredClone(receipt),
    };
  }
  assertComparisonFreeNonce(a.state.reservation, c.clientRequestId);
  return null;
}
function addEvent(
  s: ComparisonTransmissionState,
  nonce: string,
  eventId: string,
  at: string,
  runId: string,
  payload: PublicComparisonNativeEvent["payload"],
) {
  assertComparisonFreshIds(s.reservation, [nonce, eventId]);
  const head = runHead(s, runId);
  const event = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId,
    eventId,
    revision: head.revision + 1,
    previousDigest: head.headDigest,
    recordedAt: at,
    payload,
  });
  const receipt: Receipt = {
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId,
    clientRequestId: nonce,
    inputDigest: publicComparisonNativeInputDigest(event),
    eventRevision: event.revision,
    operationDigest: event.eventDigest,
    budgetOperationDigest: null,
    recordedAt: at,
  };
  s.reservation.archive.records.events.push(event);
  s.reservation.archive.records.receipts.push(receipt);
  return { event, receipt };
}
function result(
  s: ComparisonTransmissionState,
  rows: {
    event: PublicComparisonNativeEvent;
    receipt: Receipt;
    binding: ComparisonTransmissionBinding | null;
    artifact: Artifact | null;
  },
  operation: "approve-dispatch" | "mark-unknown" | "persist-capture",
) {
  const after = inspectComparisonTransmissionState(s);
  return {
    ...resultAuthority,
    status: "prepared-not-committed" as const,
    operation,
    transaction: "single-immediate-transaction-required" as const,
    rows,
    next: after.state,
    capacity: after.view.capacity,
  };
}
export function planComparisonDispatch(state: unknown, raw: unknown, currentRaw?: unknown) {
  const a = inspectComparisonTransmissionState(state),
    c = parse(comparisonDispatchCommandSchema, raw);
  const old = replay(a, c);
  if (old) return old;
  const cur = parse(
    z
      .object({
        company: z.unknown(),
        approvedReview: z.unknown(),
        basis: comparisonTransmissionBasisSchema,
        at: time,
        eventId: uuid,
      })
      .strict(),
    currentRaw,
    8 * MiB,
  );
  const { run } = original(a.state, c.runId);
  inspectPublicClaimComparisonRequest(cur.company as StudioCase, run.command, run.identity);
  const skeleton = z.object({ inspectedAt: time }).passthrough().parse(cur.approvedReview);
  const review = reviewFor(a.state, a.reservation, c.runId, cur.basis, skeleton.inspectedAt);
  same(cur.approvedReview, review);
  validateCommand(c, review, cur.at);
  validateBasis(cur.basis, a.state, c.runId, cur.at);
  const rows = addEvent(a.state, c.clientRequestId, cur.eventId, cur.at, c.runId, {
    kind: "dispatch-recorded",
    reservationDigest: review.reservationDigest,
    requestDigest: run.identity.requestDigest,
    manifestDigest: run.manifestDigest,
  });
  const binding = bindingFor(c, review, rows.event, rows.receipt);
  a.state.transmissionBindings.push(binding);
  return result(a.state, { ...rows, binding, artifact: null }, "approve-dispatch");
}
function continuation(a: Inspection, c: ComparisonUnknownCommand | ComparisonCaptureCommand) {
  const b = a.state.transmissionBindings.find((b) => b.runId === c.runId);
  if (
    !b ||
    b.recordDigest !== c.transmissionBindingDigest ||
    b.dispatchEventDigest !== c.dispatchEventDigest
  )
    fail("PUBLIC_COMPARISON_TRANSMISSION_CHANGED");
  same(c.expectedRunHead, runHead(a.state, c.runId));
  return b;
}
export function planComparisonUnknown(state: unknown, raw: unknown, currentRaw?: unknown) {
  const a = inspectComparisonTransmissionState(state),
    c = parse(comparisonUnknownCommandSchema, raw);
  const old = replay(a, c);
  if (old) return old;
  continuation(a, c);
  const cur = parse(z.object({ at: time, eventId: uuid }).strict(), currentRaw);
  const rows = addEvent(a.state, c.clientRequestId, cur.eventId, cur.at, c.runId, {
    kind: "dispatch-unknown",
    dispatchEventDigest: c.dispatchEventDigest,
    reason: c.reason,
  });
  return result(a.state, { ...rows, binding: null, artifact: null }, "mark-unknown");
}
export function planComparisonCapture(state: unknown, raw: unknown, currentRaw?: unknown) {
  const a = inspectComparisonTransmissionState(state),
    c = parse(comparisonCaptureCommandSchema, raw);
  const old = replay(a, c);
  if (old) return old;
  continuation(a, c);
  const cur = parse(
    z.object({ at: time, eventId: uuid, capture: z.unknown() }).strict(),
    currentRaw,
    8 * MiB,
  );
  // A supplied canonical copy, not a runtime-owned network capture.
  const capture = captureProviderResponse(cur.capture),
    body = JSON.stringify(capture);
  same(cur.capture, capture);
  const artifact: Artifact = {
    runId: c.runId,
    key: "comparison-response",
    body,
    sha256: sha(body),
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
  if (
    artifact.sizeBytes > 4 * MiB ||
    artifact.sha256 !== c.responseArtifactSha256 ||
    artifact.sizeBytes !== c.sizeBytes
  )
    fail("PUBLIC_COMPARISON_CAPTURE_CHANGED");
  a.state.reservation.archive.records.artifacts.push(artifact);
  const rows = addEvent(a.state, c.clientRequestId, cur.eventId, cur.at, c.runId, {
    kind: "response-captured",
    dispatchEventDigest: c.dispatchEventDigest,
    responseArtifactSha256: artifact.sha256,
  });
  return result(a.state, { ...rows, binding: null, artifact }, "persist-capture");
}
