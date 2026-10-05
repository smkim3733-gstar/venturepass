import "server-only";
import {
  auditComparisonPostcaptureRows,
  comparisonPostcapturePreview,
  comparisonPostcaptureRecordedRows,
  comparisonResultCommandSchema,
  comparisonCloseCommandSchema,
  planComparisonResultRows,
  planComparisonCloseRows,
  type ComparisonResultCommand,
  type ComparisonCloseCommand,
} from "./studio-public-claim-comparison-postcapture";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  comparisonTransmissionCore as core,
  comparisonTransmissionBindingSchema,
  comparisonDispatchCommandSchema,
  comparisonUnknownCommandSchema,
  comparisonCaptureCommandSchema,
  comparisonTransmissionBasisSchema,
  comparisonTransmissionTime as time,
  comparisonTransmissionUuid as uuid,
  type ComparisonTransmissionCoreState,
} from "./studio-public-claim-comparison-transmission";
import {
  inspectComparisonReservationState,
  assertComparisonFreeNonce,
} from "./studio-public-claim-comparison-reservation";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import {
  comparisonUsagePolicySchema,
  validateComparisonUsagePolicy,
} from "./studio-public-claim-comparison-usage";
import {
  comparisonHashSchema as hash,
  comparisonBytes as bytes,
  comparisonPlanFail as fail,
  comparisonPlanAuthority as authority,
} from "./studio-public-claim-comparison-financial";
import { inspectPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import type { StudioCase } from "./studio-schema";
import type {
  PublicComparisonNativeEvent,
  PublicComparisonNativeRecords,
} from "./studio-public-claim-comparison-native";

export const comparisonDispatchV2CommandSchema = comparisonDispatchCommandSchema
  .extend({
    commandVersion: z.literal(2),
    usagePolicyDigest: hash,
  })
  .strict();
export const comparisonTransmissionV4BindingSchema = comparisonTransmissionBindingSchema
  .extend({
    recordVersion: z.literal(4),
    command: comparisonDispatchV2CommandSchema,
  })
  .strict();
export const comparisonTransmissionAnyBindingSchema = z.discriminatedUnion("recordVersion", [
  comparisonTransmissionBindingSchema,
  comparisonTransmissionV4BindingSchema,
]);
export type ComparisonTransmissionV4Binding = z.infer<typeof comparisonTransmissionV4BindingSchema>;
export type ComparisonTransmissionAnyBinding = z.infer<
  typeof comparisonTransmissionAnyBindingSchema
>;
export type ComparisonTransmissionV4State =
  ComparisonTransmissionCoreState<ComparisonTransmissionAnyBinding>;
const outer = z
  .object({
    reservation: z.unknown(),
    transmissionBindings: z.array(comparisonTransmissionAnyBindingSchema).max(20),
  })
  .strict();
const resultAuthority = { source: "supplied-transmission-plan" as const, owner: null, authority };

function reviewFor(
  s: ComparisonTransmissionV4State,
  reservation: ReturnType<typeof inspectComparisonReservationState>,
  runId: string,
  basis: unknown,
  policy: unknown,
  at: string,
) {
  const base = core.reviewFor(s, reservation, runId, basis, at);
  const original = core.original(s, runId);
  const usagePolicy = validateComparisonUsagePolicy(
    policy,
    original.review.financialBasis,
    original.run.identity,
    base.basis,
    s.reservation.prefix.environment,
    at,
  );
  const old: Omit<typeof base, "reviewDigest"> & { reviewDigest?: string } = { ...base };
  delete old.reviewDigest;
  const body = {
    ...old,
    reviewVersion: 2 as const,
    expiresAt: new Date(
      Math.min(Date.parse(base.expiresAt), Date.parse(usagePolicy.authority.validUntil)),
    ).toISOString(),
    usagePolicy,
    usagePolicyDigest: digest(usagePolicy),
  };
  const result = { ...body, reviewDigest: digest(body) };
  if (bytes(result) > 64 * 1024) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return result;
}
export type ComparisonTransmissionV2Review = ReturnType<typeof reviewFor>;
function validateCommand(
  c: z.infer<typeof comparisonDispatchV2CommandSchema>,
  review: ComparisonTransmissionV2Review,
  at: string,
) {
  core.validateCommand(c, review, at);
  if (c.usagePolicyDigest !== review.usagePolicyDigest)
    fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
}
function bindingFor(
  c: z.infer<typeof comparisonDispatchV2CommandSchema>,
  review: ComparisonTransmissionV2Review,
  e: PublicComparisonNativeEvent,
  receipt: PublicComparisonNativeRecords["receipts"][number],
) {
  const body = core.bindingBodyFor(c, review, e, receipt, 4);
  const b = comparisonTransmissionV4BindingSchema.parse({ ...body, recordDigest: digest(body) });
  if (bytes(b) > 64 * 1024) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  return b;
}
/** Full native/financial/reservation audit plus exact versioned transmission history. */
export function inspectComparisonTransmissionV4State(raw: unknown) {
  assertPublicComparisonDataOnly(raw);
  const parsed = outer.parse(raw);
  const reservation = inspectComparisonReservationState(parsed.reservation);
  const s: ComparisonTransmissionV4State = {
    reservation: reservation.state,
    transmissionBindings: structuredClone(parsed.transmissionBindings),
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
    | z.infer<typeof comparisonDispatchCommandSchema>
    | z.infer<typeof comparisonDispatchV2CommandSchema>
    | z.infer<typeof comparisonUnknownCommandSchema>
    | z.infer<typeof comparisonCaptureCommandSchema>
    | ComparisonResultCommand
    | ComparisonCloseCommand
  > = [];
  let indexBinding = 0;
  for (const [index, run] of s.reservation.archive.records.runs.entries()) {
    const e = dispatches.find((e) => e.runId === run.id);
    if (!e) continue;
    const b = s.transmissionBindings[indexBinding++];
    if (
      b.runId !== run.id ||
      bytes(b) > 65536 ||
      bytes(b.command) > 8192 ||
      bytes(b.approvedReview) > 65536
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
              .max(256 * 1024 * 1024),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(b.approvedReview);
    const previous = core.beforeDispatch(s, index, skeleton.capacity.additionalUsedBytes);
    const inspected = inspectComparisonReservationState(previous.reservation);
    const receipt = s.reservation.archive.records.receipts.find(
      (r) => r.clientRequestId === b.clientRequestId,
    );
    if (!receipt || receipt.operationDigest !== e.eventDigest) fail();
    if (b.recordVersion === 3) {
      const review = core.reviewFor(
        previous,
        inspected,
        run.id,
        skeleton.basis,
        skeleton.inspectedAt,
      );
      core.validateCommand(b.command, review, e.recordedAt);
      core.same(b, core.bindingFor(b.command, review, e, receipt));
    } else {
      const policy = z
        .object({ usagePolicy: comparisonUsagePolicySchema })
        .passthrough()
        .parse(b.approvedReview).usagePolicy;
      const review = reviewFor(
        previous,
        inspected,
        run.id,
        skeleton.basis,
        policy,
        skeleton.inspectedAt,
      );
      validateCommand(b.command, review, e.recordedAt);
      const original = core.original(s, run.id);
      validateComparisonUsagePolicy(
        policy,
        original.review.financialBasis,
        run.identity,
        review.basis,
        s.reservation.prefix.environment,
        e.recordedAt,
      );
      core.same(b, bindingFor(b.command, review, e, receipt));
    }
    commands.push(b.command);
    for (const event of s.reservation.archive.records.events.filter((x) => x.runId === run.id))
      if (event.payload.kind === "dispatch-unknown" || event.payload.kind === "response-captured")
        commands.push(core.continuationFrom(s, b, event));
  }
  commands.push(...auditComparisonPostcaptureRows(s));
  return {
    ...resultAuthority,
    status: "inspected" as const,
    state: s,
    reservation,
    view: core.view(s, reservation),
    commands,
  };
}
type Inspection = ReturnType<typeof inspectComparisonTransmissionV4State>;
type Command = Inspection["commands"][number];
function replay(a: Inspection, c: Command) {
  const old = a.commands.find((x) => x.clientRequestId === c.clientRequestId);
  if (old) {
    core.same(old, c);
    return {
      ...resultAuthority,
      status: "replay" as const,
      rows: null,
      command: structuredClone(old),
      receipt: structuredClone(
        a.state.reservation.archive.records.receipts.find(
          (r) => r.clientRequestId === c.clientRequestId,
        )!,
      ),
    };
  }
  assertComparisonFreeNonce(a.state.reservation, c.clientRequestId);
  return null;
}
export function createComparisonTransmissionV2Review(
  state: unknown,
  company: StudioCase,
  runIdRaw: string,
  basis: unknown,
  policy: unknown,
  at: string,
) {
  const a = inspectComparisonTransmissionV4State(state),
    runId = uuid.parse(runIdRaw);
  assertPublicComparisonDataOnly(company, 8 * 1024 * 1024);
  const { run } = core.original(a.state, runId);
  inspectPublicClaimComparisonRequest(company, run.command, run.identity);
  return structuredClone(reviewFor(a.state, a.reservation, runId, basis, policy, at));
}
export function planComparisonDispatchV2(state: unknown, raw: unknown, currentRaw?: unknown) {
  const a = inspectComparisonTransmissionV4State(state),
    c = core.parse(comparisonDispatchV2CommandSchema, raw);
  const old = replay(a, c);
  if (old) return old;
  const cur = core.parse(
    z
      .object({
        company: z.unknown(),
        approvedReview: z.unknown(),
        basis: comparisonTransmissionBasisSchema,
        usagePolicy: comparisonUsagePolicySchema,
        at: time,
        eventId: uuid,
      })
      .strict(),
    currentRaw,
    8 * 1024 * 1024,
  );
  const { run, review: reserved } = core.original(a.state, c.runId);
  inspectPublicClaimComparisonRequest(cur.company as StudioCase, run.command, run.identity);
  const skeleton = z.object({ inspectedAt: time }).passthrough().parse(cur.approvedReview);
  const review = reviewFor(
    a.state,
    a.reservation,
    c.runId,
    cur.basis,
    cur.usagePolicy,
    skeleton.inspectedAt,
  );
  core.same(cur.approvedReview, review);
  validateCommand(c, review, cur.at);
  core.validateBasis(cur.basis, a.state, c.runId, cur.at);
  validateComparisonUsagePolicy(
    cur.usagePolicy,
    reserved.financialBasis,
    run.identity,
    cur.basis,
    a.state.reservation.prefix.environment,
    cur.at,
  );
  const rows = core.addEvent(a.state, c.clientRequestId, cur.eventId, cur.at, c.runId, {
    kind: "dispatch-recorded",
    reservationDigest: review.reservationDigest,
    requestDigest: run.identity.requestDigest,
    manifestDigest: run.manifestDigest,
  });
  const binding = bindingFor(c, review, rows.event, rows.receipt);
  a.state.transmissionBindings.push(binding);
  const after = inspectComparisonTransmissionV4State(a.state);
  return {
    ...resultAuthority,
    status: "prepared-not-committed" as const,
    operation: "approve-dispatch" as const,
    transaction: "single-immediate-transaction-required" as const,
    rows: { ...rows, binding, artifact: null },
    next: after.state,
    capacity: after.view.capacity,
  };
}
function continuation(
  a: Inspection,
  c:
    z.infer<typeof comparisonUnknownCommandSchema> | z.infer<typeof comparisonCaptureCommandSchema>,
) {
  const b = a.state.transmissionBindings.find((b) => b.runId === c.runId);
  if (
    !b ||
    b.recordDigest !== c.transmissionBindingDigest ||
    b.dispatchEventDigest !== c.dispatchEventDigest
  )
    fail("PUBLIC_COMPARISON_TRANSMISSION_CHANGED");
  core.same(c.expectedRunHead, core.runHead(a.state, c.runId));
}
export function planComparisonContinuationV4(state: unknown, raw: unknown, currentRaw?: unknown) {
  const a = inspectComparisonTransmissionV4State(state);
  const c = core.parse(
    z.discriminatedUnion("kind", [comparisonUnknownCommandSchema, comparisonCaptureCommandSchema]),
    raw,
  );
  const old = replay(a, c);
  if (old) return old;
  continuation(a, c);
  const rows =
    c.kind === "mark-public-comparison-unknown"
      ? { ...core.unknownRowsFor(a.state, c, currentRaw), artifact: null }
      : core.captureRowsFor(a.state, c, currentRaw);
  const after = inspectComparisonTransmissionV4State(a.state);
  return {
    ...resultAuthority,
    status: "prepared-not-committed" as const,
    operation:
      c.kind === "mark-public-comparison-unknown"
        ? ("mark-unknown" as const)
        : ("persist-capture" as const),
    transaction: "single-immediate-transaction-required" as const,
    rows: { ...rows, binding: null },
    next: after.state,
    capacity: after.view.capacity,
  };
}

export function createComparisonPostcapturePreview(state: unknown, runId: string) {
  const a = inspectComparisonTransmissionV4State(state);
  return {
    ...resultAuthority,
    source: "supplied-postcapture-plan" as const,
    ...comparisonPostcapturePreview(a.state, uuid.parse(runId)),
  };
}
export function planComparisonPostcapture(state: unknown, raw: unknown, currentRaw?: unknown) {
  const a = inspectComparisonTransmissionV4State(state);
  const c = core.parse(
    z.discriminatedUnion("kind", [comparisonResultCommandSchema, comparisonCloseCommandSchema]),
    raw,
  );
  const old = replay(a, c);
  if (old)
    return {
      ...old,
      source: "supplied-postcapture-plan" as const,
      recordedRows: structuredClone(comparisonPostcaptureRecordedRows(a.state, c)),
    };
  if (c.kind === "record-public-comparison-result") {
    const rows = planComparisonResultRows(a.state, c, currentRaw);
    const after = inspectComparisonTransmissionV4State(a.state);
    core.same(
      after.commands.find((x) => x.clientRequestId === c.clientRequestId),
      c,
    );
    return {
      ...resultAuthority,
      source: "supplied-postcapture-plan" as const,
      status: "prepared-not-committed" as const,
      operation: "record-result" as const,
      transaction: "single-immediate-transaction-required" as const,
      rows,
      next: after.state,
      capacity: after.view.capacity,
    };
  }
  const result = planComparisonCloseRows(a.state, a.reservation.view, c, currentRaw);
  if (result.status === "blocked")
    return {
      ...resultAuthority,
      source: "supplied-postcapture-plan" as const,
      ...result,
    };
  const after = inspectComparisonTransmissionV4State(a.state);
  core.same(
    after.commands.find((x) => x.clientRequestId === c.clientRequestId),
    c,
  );
  return {
    ...resultAuthority,
    source: "supplied-postcapture-plan" as const,
    status: "prepared-not-committed" as const,
    operation: "settle-finalize" as const,
    transaction: "single-immediate-transaction-required" as const,
    rows: result.rows,
    next: after.state,
    capacity: after.view.capacity,
  };
}
export { comparisonResultCommandSchema, comparisonCloseCommandSchema };
