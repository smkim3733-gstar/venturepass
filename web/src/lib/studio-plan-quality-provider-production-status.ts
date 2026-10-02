import "server-only";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderExecutionSnapshot,
  VersionedProviderExecutionSnapshot,
} from "./studio-plan-quality-provider-execution-types";
import {
  providerProductionSelectionSchema,
  providerProductionViewSchema,
  type ProviderProductionSelection,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";

type PhaseView = NonNullable<ProviderProductionView["generation"]>;
const emptyPhase = (lastConfirmed: PhaseView["lastConfirmed"] = "none"): PhaseView => ({
  lastConfirmed,
  response: "not-observed",
  failureStage: null,
  stopOutcome: null,
});
/** INTERNAL read projection only. Caller must have audited the COMPLETE native archive in the
 * same transaction, including per-event receipts, original approval binding and artifact bodies.
 * A client-supplied snapshot/status/revision is never evidence. No runner or transport is called. */
export function projectAuditedProviderProductionStatus(
  selection: ProviderProductionSelection,
  snapshot: ProviderExecutionSnapshot,
): ProviderProductionView {
  if (snapshot.archiveFormatVersion !== 3) throw Error("PROVIDER_PRODUCTION_STATUS_SCOPE_INVALID");
  return project(selection, snapshot);
}

/** Version-aware projection only; caller supplies the same complete transaction audit. */
export function projectAuditedVersionedProviderProductionStatus(
  selection: ProviderProductionSelection,
  snapshot: ProviderExecutionSnapshot | VersionedProviderExecutionSnapshot,
): ProviderProductionView {
  return project(selection, snapshot);
}
function project(
  selection: ProviderProductionSelection,
  snapshot: ProviderExecutionSnapshot | VersionedProviderExecutionSnapshot,
): ProviderProductionView {
  const scope = providerProductionSelectionSchema.parse(selection);
  if (
    (snapshot.archiveFormatVersion !== 3 && snapshot.archiveFormatVersion !== 5) ||
    snapshot.run.environment !== "production" ||
    snapshot.run.id !== scope.runId ||
    snapshot.run.runDigest !== scope.runDigest
  )
    throw Error("PROVIDER_PRODUCTION_STATUS_SCOPE_INVALID");
  const generation = emptyPhase("approved");
  let review: PhaseView | null = null,
    completed = false,
    stopped = false;
  let current: PhaseView = generation;
  for (const event of snapshot.events) {
    const payload = event.payload;
    if (payload.kind === "transmission-approved") continue;
    if (payload.kind === "execution-stopped") {
      if (payload.outcome === "completed") {
        if (
          generation.lastConfirmed !== "validated" ||
          review?.lastConfirmed !== "validated" ||
          !payload.finalArtifactSha256 ||
          !snapshot.artifacts.some(
            (artifact) =>
              artifact.key === "final-result" && artifact.sha256 === payload.finalArtifactSha256,
          )
        )
          throw Error("PROVIDER_PRODUCTION_COMPLETION_UNCONFIRMED");
        review.lastConfirmed = "completed";
        completed = true;
      } else {
        current.lastConfirmed = "stopped";
        current.stopOutcome = payload.outcome;
        stopped = true;
      }
      continue;
    }
    current = payload.phase === "generation" ? generation : (review ??= emptyPhase());
    if (payload.kind === "response-received") {
      current.response = "recorded";
      // A late response settles evidence/cost without reviving a stopped execution.
      if (current.lastConfirmed !== "stopped") current.lastConfirmed = "response-recorded";
    } else if (payload.kind === "request-prepared") {
      current.lastConfirmed = "prepared";
    } else if (payload.kind === "dispatch-intent") {
      current.lastConfirmed = "dispatch-recorded";
      current.response = "unobserved";
    } else if (payload.kind === "domain-validated") {
      current.lastConfirmed = "validated";
    }
  }
  const reconcile =
    generation.response === "unobserved" ||
    review?.response === "unobserved" ||
    (stopped && snapshot.unsettled) ||
    [generation.stopOutcome, review?.stopOutcome].some(
      (outcome) => outcome === "needs-cost-review" || outcome === "bound-breached",
    );
  return freezeProviderValue(
    providerProductionViewSchema.parse({
      viewVersion: 1,
      selection: scope,
      status: completed ? "completed" : stopped ? "stopped" : "last-confirmed",
      reason: null,
      generation,
      review,
      lastAuditedRevision: snapshot.revision,
      lastAuditedBudget: snapshot.unsettled ? "unsettled" : "settled",
      recovery: !completed && reconcile ? "reconcile-before-continuing" : "none",
      executionCompleted: completed,
      automaticRetryAllowed: false,
    }),
  );
}
