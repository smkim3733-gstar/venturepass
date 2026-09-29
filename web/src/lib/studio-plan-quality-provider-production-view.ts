import "server-only";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderApprovedRunnerResult,
  ProviderReviewRunnerResult,
} from "./studio-plan-quality-provider-approved-runner";
import type { ProviderGenerationRunnerResult } from "./studio-plan-quality-provider-generation-runner";
import {
  providerProductionSelectionSchema,
  providerProductionViewSchema,
  type ProviderProductionSelection,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";

type Phase = NonNullable<ProviderProductionView["generation"]>;
function sameScope(selection: ProviderProductionSelection, identity: ProviderProductionSelection) {
  return (
    selection.runId === identity.runId &&
    selection.runDigest === identity.runDigest &&
    selection.approvalBindingDigest === identity.approvalBindingDigest
  );
}
function snapshotOf(
  selection: ProviderProductionSelection,
  result: ProviderGenerationRunnerResult | ProviderReviewRunnerResult,
) {
  const snapshot = result.snapshot;
  if (!snapshot) return null;
  if (
    snapshot.archiveFormatVersion !== 3 ||
    snapshot.run.environment !== "production" ||
    snapshot.run.id !== selection.runId ||
    snapshot.run.runDigest !== selection.runDigest
  )
    throw Error("PROVIDER_PRODUCTION_VIEW_SCOPE_INVALID");
  return snapshot;
}
function phaseView(
  selection: ProviderProductionSelection,
  result: ProviderGenerationRunnerResult | ProviderReviewRunnerResult,
  phase: "generation" | "review",
): Phase {
  const snapshot = snapshotOf(selection, result);
  const dispatchRecorded =
    snapshot?.events.some(
      (event) => event.payload.kind === "dispatch-intent" && event.payload.phase === phase,
    ) === true;
  // Only dedicated confirmed records promote response/validation/stop/completion. A revision,
  // snapshot.state or runner status string alone can never establish overall completion.
  const response = result.response?.state === "committed" && result.response.responsePersisted;
  const validation = result.validation?.state === "committed";
  const stop = result.stop?.state === "committed" && result.stop.stopPersisted;
  const finalization =
    "finalization" in result &&
    result.finalization?.state === "committed" &&
    result.finalization.completionPersisted &&
    result.finalization.finalResultPersisted;
  for (const record of [result.response, result.validation, result.stop]) {
    if (!record) continue;
    const identity =
      "generation" in record.dispatch ? record.dispatch.generation.dispatch : record.dispatch;
    if (!sameScope(selection, identity)) throw Error("PROVIDER_PRODUCTION_VIEW_SCOPE_INVALID");
  }
  if (
    finalization &&
    "finalization" in result &&
    result.finalization &&
    !sameScope(selection, result.finalization.validation.dispatch.generation.dispatch)
  )
    throw Error("PROVIDER_PRODUCTION_VIEW_SCOPE_INVALID");
  return {
    lastConfirmed: finalization
      ? "completed"
      : stop
        ? "stopped"
        : validation
          ? "validated"
          : response
            ? "response-recorded"
            : dispatchRecorded
              ? "dispatch-recorded"
              : phase === "generation" && snapshot
                ? "approved"
                : "none",
    response: result.pendingCapture
      ? "captured-not-confirmed"
      : response
        ? "recorded"
        : dispatchRecorded
          ? "unobserved"
          : "not-observed",
    failureStage: result.failure?.stage ?? null,
    stopOutcome: stop ? result.stop!.outcome : null,
  };
}

/** Server-only whitelist projection, never object-spread internal results into a response. */
export function projectProviderProductionView(
  raw: unknown,
  result: ProviderApprovedRunnerResult,
): ProviderProductionView {
  const selection = providerProductionSelectionSchema.parse(raw);
  const generation = phaseView(selection, result.generation, "generation");
  const review = result.review ? phaseView(selection, result.review, "review") : null;
  const pending = !!(result.generation.pendingCapture || result.review?.pendingCapture);
  const completed =
    !pending &&
    generation.lastConfirmed === "validated" &&
    review?.lastConfirmed === "completed" &&
    result.executionCompleted === true &&
    result.review?.executionCompleted === true;
  // A missing top-level confirmation must not be presented as a completed phase either.
  if (!completed && review?.lastConfirmed === "completed") review.lastConfirmed = "validated";
  const snapshots = [
    snapshotOf(selection, result.generation),
    result.review ? snapshotOf(selection, result.review) : null,
  ];
  const snapshot = snapshots.reduce(
    (latest, item) => (item && (!latest || item.revision >= latest.revision) ? item : latest),
    null,
  );
  const stopped = generation.lastConfirmed === "stopped" || review?.lastConfirmed === "stopped";
  const reconcile =
    !completed &&
    (generation.response === "unobserved" ||
      review?.response === "unobserved" ||
      !!result.generation.failure ||
      !!result.review?.failure ||
      [generation.stopOutcome, review?.stopOutcome].some(
        (outcome) => outcome === "needs-cost-review" || outcome === "bound-breached",
      ));
  return freezeProviderValue(
    providerProductionViewSchema.parse({
      viewVersion: 1,
      selection,
      status: pending
        ? "capture-recovery-required"
        : completed
          ? "completed"
          : stopped
            ? "stopped"
            : "last-confirmed",
      reason: null,
      generation,
      review,
      lastAuditedRevision: snapshot?.revision ?? null,
      lastAuditedBudget: snapshot ? (snapshot.unsettled ? "unsettled" : "settled") : "unconfirmed",
      recovery: pending ? "server-capture" : reconcile ? "reconcile-before-continuing" : "none",
      executionCompleted: completed,
      automaticRetryAllowed: false,
    }),
  );
}

export function unavailableProviderProductionView(
  selection: ProviderProductionSelection | null,
  reason: NonNullable<ProviderProductionView["reason"]>,
): ProviderProductionView {
  return freezeProviderValue(
    providerProductionViewSchema.parse({
      viewVersion: 1,
      selection,
      status: "unavailable",
      reason,
      generation: null,
      review: null,
      lastAuditedRevision: null,
      lastAuditedBudget: "unconfirmed",
      recovery: "reconcile-before-continuing",
      executionCompleted: false,
      automaticRetryAllowed: false,
    }),
  );
}
