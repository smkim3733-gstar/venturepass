import "server-only";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  comparisonTransmissionCore as core,
  comparisonTransmissionHead as head,
  comparisonTransmissionTime as time,
  comparisonTransmissionUuid as uuid,
} from "./studio-public-claim-comparison-transmission";
import type {
  ComparisonTransmissionV4State,
  ComparisonTransmissionV2Review,
} from "./studio-public-claim-comparison-transmission-v4";
import {
  comparisonHashSchema as hash,
  comparisonPlanFail as fail,
} from "./studio-public-claim-comparison-financial";
import { assessComparisonUsage } from "./studio-public-claim-comparison-usage";
import { inspectArchivedPublicClaimRequest } from "./studio-public-claim-comparison-request";
import {
  derivePublicComparisonCapturedResult,
  publicComparisonValidatedBody,
  publicComparisonFinalBody,
  createPublicComparisonNativeEvent,
  type PublicComparisonNativeEvent,
} from "./studio-public-claim-comparison-native";
import {
  comparisonReservationRows as rows,
  assertComparisonFreeNonce,
  assertComparisonFreshIds,
  type inspectComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";

const base = {
  commandVersion: z.literal(1),
  purpose: z.literal("compare-public-claim"),
  clientRequestId: uuid,
  runId: uuid,
  transmissionBindingDigest: hash,
  dispatchEventDigest: hash,
  responseArtifactSha256: hash,
  expectedRunHead: head,
};
export const comparisonResultCommandSchema = z
  .object({
    ...base,
    kind: z.literal("record-public-comparison-result"),
    responseArtifactByteLength: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    expectedValidatedArtifactSha256: hash,
  })
  .strict();
export const comparisonCloseCommandSchema = z
  .object({
    ...base,
    kind: z.literal("settle-finalize-public-comparison"),
    comparisonEventDigest: hash,
    usagePolicyDigest: hash,
    expectedAssessmentDigest: hash,
    expectedBudgetHead: head,
  })
  .strict();
export type ComparisonResultCommand = z.infer<typeof comparisonResultCommandSchema>;
export type ComparisonCloseCommand = z.infer<typeof comparisonCloseCommandSchema>;
type State = ComparisonTransmissionV4State;
function receipt(s: State, e: PublicComparisonNativeEvent) {
  const r = s.reservation.archive.records.receipts.find((r) => r.operationDigest === e.eventDigest);
  if (!r) fail();
  return r;
}
function captured(s: State, runId: string) {
  const { run, review: reserved } = core.original(s, runId);
  const binding = s.transmissionBindings.find((b) => b.runId === runId);
  const response = s.reservation.archive.records.artifacts.find(
    (a) => a.runId === runId && a.key === "comparison-response",
  );
  const context = s.reservation.archive.records.artifacts.find(
    (a) => a.runId === runId && a.key === "comparison-context",
  );
  if (!binding || !response || !context) fail("PUBLIC_COMPARISON_CAPTURE_REQUIRED");
  const capture = JSON.parse(response.body);
  const { prepared } = inspectArchivedPublicClaimRequest(run.command, context.body);
  const compared = derivePublicComparisonCapturedResult(prepared, capture, run.command.model);
  const validated = rows.artifact(
    runId,
    "comparison-validated",
    JSON.stringify(publicComparisonValidatedBody(run.identity, response.sha256, compared)),
  );
  return { run, reserved, binding, response, capture, compared, validated };
}
function assessed(s: State, c: ReturnType<typeof captured>) {
  if (c.binding.recordVersion === 3)
    return {
      status: "unknown" as const,
      reasons: ["PRE_DISPATCH_USAGE_POLICY_MISSING"],
      assessment: null,
      usagePolicyDigest: null,
    };
  // Full transmission inspection has reconstructed this exact review before this helper runs.
  const review = c.binding.approvedReview as ComparisonTransmissionV2Review;
  const outcome = assessComparisonUsage({
    policy: review.usagePolicy,
    financialBasis: c.reserved.financialBasis,
    identity: c.run.identity,
    transmission: review.basis,
    environment: s.reservation.prefix.environment,
    dispatchedAt: c.binding.recordedAt,
    capture: c.capture,
  });
  if (outcome.status !== "known" || outcome.units === null)
    return {
      status: "unknown" as const,
      reasons: outcome.reasons,
      assessment: null,
      usagePolicyDigest: review.usagePolicyDigest,
    };
  return {
    status: "known" as const,
    reasons: [],
    usagePolicyDigest: review.usagePolicyDigest,
    assessment: {
      status: "known" as const,
      units: outcome.units,
      requestDigest: c.run.identity.requestDigest,
      dispatchEventDigest: c.binding.dispatchEventDigest,
      responseArtifactSha256: c.response.sha256,
      requestedTier: null,
      violations: outcome.violations,
    },
  };
}
export function comparisonPostcapturePreview(s: State, runId: string) {
  const c = captured(s, runId),
    a = assessed(s, c);
  return {
    responseArtifactSha256: c.response.sha256,
    responseArtifactByteLength: c.response.sizeBytes,
    expectedValidatedArtifactSha256: c.validated.sha256,
    comparisonState: c.compared.state,
    usage: a,
    expectedAssessmentDigest: a.assessment ? digest(a.assessment) : null,
  };
}
function resultCommand(
  s: State,
  b: State["transmissionBindings"][number],
  e: PublicComparisonNativeEvent,
) {
  if (e.payload.kind !== "comparison-recorded") fail();
  const response = s.reservation.archive.records.artifacts.find(
    (a) => a.runId === e.runId && a.key === "comparison-response",
  );
  if (!response) fail();
  return comparisonResultCommandSchema.parse({
    commandVersion: 1,
    purpose: "compare-public-claim",
    kind: "record-public-comparison-result",
    clientRequestId: receipt(s, e).clientRequestId,
    runId: e.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    responseArtifactSha256: response.sha256,
    responseArtifactByteLength: response.sizeBytes,
    expectedRunHead: { revision: e.revision - 1, headDigest: e.previousDigest },
    expectedValidatedArtifactSha256: e.payload.validatedArtifactSha256,
  });
}
/** Supplement the unchanged native/financial fold with policy arithmetic and exact complete groups. */
export function auditComparisonPostcaptureRows(s: State) {
  const commands: Array<ComparisonResultCommand | ComparisonCloseCommand> = [];
  for (const b of s.transmissionBindings) {
    const events = s.reservation.archive.records.events.filter((e) => e.runId === b.runId);
    const result = events.find((e) => e.payload.kind === "comparison-recorded");
    if (result) commands.push(resultCommand(s, b, result));
    if (b.recordVersion === 3) continue; // No retroactive policy adoption or legacy reinterpretation.
    const usage = events.find((e) => e.payload.kind === "usage-assessed"),
      cost = events.find((e) => e.payload.kind === "cost-settled"),
      final = events.find((e) => e.payload.kind === "finalized");
    if (!usage && !cost && !final) continue;
    if (
      !result ||
      !usage ||
      !cost ||
      !final ||
      usage.payload.kind !== "usage-assessed" ||
      cost.payload.kind !== "cost-settled" ||
      result.revision >= usage.revision ||
      cost.revision !== usage.revision + 1 ||
      final.revision !== cost.revision + 1 ||
      cost.previousDigest !== usage.eventDigest ||
      final.previousDigest !== cost.eventDigest ||
      usage.recordedAt !== cost.recordedAt ||
      final.recordedAt !== cost.recordedAt
    )
      fail("PUBLIC_COMPARISON_PARTIAL_CLOSE");
    const c = captured(s, b.runId),
      a = assessed(s, c);
    if (!a.assessment || !a.usagePolicyDigest) fail("PUBLIC_COMPARISON_USAGE_UNKNOWN");
    core.same(usage.payload.assessment, a.assessment);
    const budgetDigest = cost.payload.budgetEventDigest;
    const money = s.reservation.archive.financial.events.find(
      (e) => e.eventDigest === budgetDigest,
    );
    if (
      !money ||
      money.payload.kind !== "recognize-comparison-usage" ||
      money.recordedAt !== usage.recordedAt ||
      money.payload.recognizedUnits !== a.assessment.units
    )
      fail("PUBLIC_COMPARISON_PARTIAL_CLOSE");
    commands.push(
      comparisonCloseCommandSchema.parse({
        commandVersion: 1,
        purpose: "compare-public-claim",
        kind: "settle-finalize-public-comparison",
        clientRequestId: receipt(s, cost).clientRequestId,
        runId: b.runId,
        transmissionBindingDigest: b.recordDigest,
        dispatchEventDigest: b.dispatchEventDigest,
        responseArtifactSha256: c.response.sha256,
        comparisonEventDigest: result.eventDigest,
        usagePolicyDigest: a.usagePolicyDigest,
        expectedAssessmentDigest: digest(a.assessment),
        expectedRunHead: { revision: usage.revision - 1, headDigest: usage.previousDigest },
        expectedBudgetHead: { revision: money.revision - 1, headDigest: money.previousDigest },
      }),
    );
  }
  return commands;
}
function validateOriginal(s: State, c: ComparisonResultCommand | ComparisonCloseCommand) {
  const original = captured(s, c.runId);
  if (
    c.transmissionBindingDigest !== original.binding.recordDigest ||
    c.dispatchEventDigest !== original.binding.dispatchEventDigest ||
    c.responseArtifactSha256 !== original.response.sha256
  )
    fail("PUBLIC_COMPARISON_POSTCAPTURE_CHANGED");
  core.same(c.expectedRunHead, core.runHead(s, c.runId));
  return original;
}
export function planComparisonResultRows(
  s: State,
  c: ComparisonResultCommand,
  currentRaw?: unknown,
) {
  const original = validateOriginal(s, c);
  if (
    c.expectedValidatedArtifactSha256 !== original.validated.sha256 ||
    c.responseArtifactByteLength !== original.response.sizeBytes
  )
    fail("PUBLIC_COMPARISON_POSTCAPTURE_CHANGED");
  const cur = core.parse(z.object({ at: time, eventId: uuid }).strict(), currentRaw);
  s.reservation.archive.records.artifacts.push(original.validated);
  const eventRows = core.addEvent(s, c.clientRequestId, cur.eventId, cur.at, c.runId, {
    kind: "comparison-recorded",
    responseArtifactSha256: original.response.sha256,
    validatedArtifactSha256: original.validated.sha256,
  });
  return { ...eventRows, artifact: original.validated };
}
export function planComparisonCloseRows(
  s: State,
  view: ReturnType<typeof inspectComparisonReservationState>["view"],
  c: ComparisonCloseCommand,
  currentRaw?: unknown,
) {
  const original = validateOriginal(s, c);
  const events = s.reservation.archive.records.events.filter((e) => e.runId === c.runId);
  const compared = events.find((e) => e.payload.kind === "comparison-recorded");
  if (
    !compared ||
    compared.eventDigest !== c.comparisonEventDigest ||
    events.some((e) => ["usage-assessed", "cost-settled", "finalized"].includes(e.payload.kind))
  )
    fail("PUBLIC_COMPARISON_CLOSE_UNAVAILABLE");
  core.same(c.expectedBudgetHead, {
    revision: view.native.revision,
    headDigest: view.native.headDigest,
  });
  const assessedUsage = assessed(s, original);
  if (!assessedUsage.assessment || !assessedUsage.usagePolicyDigest)
    return {
      status: "blocked" as const,
      rows: null,
      reason: "PUBLIC_COMPARISON_USAGE_UNKNOWN",
      usage: assessedUsage,
    };
  const assessment = assessedUsage.assessment;
  if (
    c.usagePolicyDigest !== assessedUsage.usagePolicyDigest ||
    c.expectedAssessmentDigest !== digest(assessment)
  )
    fail("PUBLIC_COMPARISON_POSTCAPTURE_CHANGED");
  const cur = core.parse(
    z
      .object({
        at: time,
        usageEventId: uuid,
        usageNonce: uuid,
        costEventId: uuid,
        budgetEventId: uuid,
        finalEventId: uuid,
        finalizationNonce: uuid,
      })
      .strict(),
    currentRaw,
  );
  assertComparisonFreeNonce(s.reservation, cur.usageNonce);
  assertComparisonFreeNonce(s.reservation, cur.finalizationNonce);
  assertComparisonFreshIds(s.reservation, [
    c.clientRequestId,
    cur.usageEventId,
    cur.usageNonce,
    cur.costEventId,
    cur.budgetEventId,
    cur.finalEventId,
    cur.finalizationNonce,
  ]);
  const usage = core.addEvent(s, cur.usageNonce, cur.usageEventId, cur.at, c.runId, {
    kind: "usage-assessed",
    assessment,
  });
  const amount = BigInt(assessment.units),
    hold = BigInt(original.run.manifest.reservedUnits);
  const budget = rows.money(s.reservation, view, cur.budgetEventId, cur.at, {
    kind: "recognize-comparison-usage",
    runId: c.runId,
    reservationDigest: original.binding.reservationDigest,
    dispatchEventDigest: original.binding.dispatchEventDigest,
    responseArtifactSha256: original.response.sha256,
    usageAssessmentDigest: digest(assessment),
    recognizedUnits: amount.toString(),
    consumedHeldUnits: (amount < hold ? amount : hold).toString(),
    releasedHeldUnits: (amount < hold ? hold - amount : BigInt(0)).toString(),
    boundExcessUnits: (amount > hold ? amount - hold : BigInt(0)).toString(),
  });
  const cost = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId: c.runId,
    eventId: cur.costEventId,
    revision: usage.event.revision + 1,
    previousDigest: usage.event.eventDigest,
    recordedAt: cur.at,
    payload: { kind: "cost-settled", budgetEventDigest: budget.eventDigest },
  });
  const costReceipt = rows.addMoney(s.reservation, cost, budget, c.clientRequestId);
  const final = rows.artifact(
    c.runId,
    "final-result",
    JSON.stringify(
      publicComparisonFinalBody(original.run, {
        cancelled: false,
        responseArtifactSha256: original.response.sha256,
        comparisonState: original.compared.state,
        assessmentDigest: digest(assessment),
      }),
    ),
  );
  s.reservation.archive.records.artifacts.push(final);
  const end = core.addEvent(s, cur.finalizationNonce, cur.finalEventId, cur.at, c.runId, {
    kind: "finalized",
    finalArtifactSha256: final.sha256,
  });
  return {
    status: "prepared" as const,
    rows: {
      events: [usage.event, cost, end.event],
      budgetEvent: budget,
      receipts: [usage.receipt, costReceipt, end.receipt],
      artifact: final,
    },
  };
}

export function comparisonPostcaptureRecordedRows(
  s: State,
  c: ComparisonResultCommand | ComparisonCloseCommand,
) {
  const own = s.reservation.archive.records.receipts.find(
    (r) => r.clientRequestId === c.clientRequestId,
  );
  const e = s.reservation.archive.records.events.find(
    (e) => e.eventDigest === own?.operationDigest,
  );
  if (!own || !e) fail();
  if (c.kind === "record-public-comparison-result")
    return {
      event: e,
      receipt: own,
      artifact: s.reservation.archive.records.artifacts.find(
        (a) => a.runId === c.runId && a.key === "comparison-validated",
      )!,
    };
  const events = s.reservation.archive.records.events.filter(
    (x) => x.runId === c.runId && x.revision >= e.revision - 1 && x.revision <= e.revision + 1,
  );
  return {
    events,
    receipts: events.map((x) => receipt(s, x)),
    budgetEvent: s.reservation.archive.financial.events.find(
      (x) => x.eventDigest === own.budgetOperationDigest,
    )!,
    artifact: s.reservation.archive.records.artifacts.find(
      (a) => a.runId === c.runId && a.key === "final-result",
    )!,
  };
}
