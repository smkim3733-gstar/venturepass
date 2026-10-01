/** In-memory synthetic registered candidate and approved reservation; no DB or provider IO. */
import { randomUUID } from "node:crypto";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { commandFor } from "./studio-plan-quality-provider-reservation-test-helpers";
import type { ProviderTransmissionReviewInput } from "./studio-plan-quality-provider-transmission-review";
import { createProviderReservationMigrationCoverage } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
const v2 = "plan-observation-v2";
const configuration = readFixedProviderConfiguration()!;
const inspectedAt = "2026-09-27T03:33:00.000Z";
type Inspection = Omit<ProviderTransmissionReviewInput, "configuration">;

export function versionedTransmissionFixture(version: PlanPromptVersion = v2) {
  const registry = actualTestRegistry();
  const server = createServerProviderPolicyContext(version, configuration);
  const current = {
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: actualTestNow,
    budgetEvents: [],
    expectedBudgetHead: { revision: 0, headDigest: null },
  };
  const review = server.review(current);
  if (review.status !== "review") throw Error(review.reason);
  const adoption = server.prepareAdoption({
    current,
    review: review.review,
    usedRequestIds: [],
    currentPolicyHead: { revision: 0, headDigest: null },
    command: providerPolicyAdoptionCommandSchema.parse({
      commandVersion: 1,
      kind: "adopt-provider-policy",
      clientRequestId: randomUUID(),
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: current.candidateId,
      expectedPolicyHead: { revision: 0, headDigest: null },
      approvedReviewDigest: review.review.reviewDigest,
      budgetAction: "initialize-proposed-budget",
      initialBudgetRequestId: randomUUID(),
      approval: {
        noticeVersion: 1,
        acknowledgedPolicy: true,
        acknowledgedBudgetAction: true,
        reservationAndTransmission: "separate-approval-required",
        approvedAt: actualTestNow,
      },
    }),
  });
  if (adoption.status !== "prepared" || !adoption.plan.initialization) throw Error("adoption");
  const ledger: ProviderTransmissionReviewInput["archive"]["ledger"] = {
    runs: [],
    events: [],
    artifacts: [],
    budgetEvents: [adoption.plan.initialization.event],
    receipts: [adoption.plan.initialization.receipt],
    policies: [adoption.plan.record],
    otherNonces: [],
    registries: [registry],
  };
  const coverage = createProviderReservationMigrationCoverage(ledger);
  const reservedCurrent = {
    selection: {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: current.candidateId,
    },
    inspectedAt: "2026-09-27T03:30:00.000Z",
    ledger,
  };
  const reservationReview = server.reservationReview(reservedCurrent);
  if (reservationReview.status !== "review") throw Error(reservationReview.reason);
  const reservation = server.prepareReservation({
    command: commandFor(reservationReview.review),
    review: reservationReview.review,
    current: { ...reservedCurrent, inspectedAt: "2026-09-27T03:32:00.000Z" },
    runId: randomUUID(),
    additionalUsedBytes: 0,
  });
  if (reservation.status !== "prepared") throw Error(reservation.reason);
  const rows = reservation.plan.rows;
  ledger.runs.push(rows.run);
  ledger.artifacts.push(rows.artifact);
  ledger.budgetEvents.push(rows.budgetEvent);
  ledger.receipts.push(rows.receipt);
  return {
    server,
    rows,
    input: {
      selection: { runId: rows.run.id, runDigest: rows.run.runDigest },
      inspectedAt,
      archive: { ledger, coverage, records: [rows.binding] },
    } satisfies Inspection,
  };
}
