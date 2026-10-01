import { randomUUID } from "node:crypto";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { createProviderReservationMigrationCoverage } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  fixture as reservationFixture,
  prepared as reserve,
  withRows,
  config,
} from "./studio-plan-quality-provider-reservation-test-helpers";
import {
  createProviderTransmissionReview,
  type ProviderTransmissionReviewInput,
} from "./studio-plan-quality-provider-transmission-review";
import type { StoredProviderTransmissionReview } from "./studio-plan-quality-provider-transmission-review-types";
import {
  providerTransmissionCommandSchema,
  type ProviderTransmissionCommand,
} from "./studio-plan-quality-provider-transmission-command";
const inspectedAt = "2026-09-27T03:33:00.000Z",
  approvedAt = "2026-09-27T03:33:30.000Z",
  recordedAt = "2026-09-27T03:34:00.000Z";

export function transmissionReview(current: ProviderTransmissionReviewInput) {
  const result = createProviderTransmissionReview(current);
  if (result.status !== "review") throw new Error(result.reason);
  return result.review;
}
export function transmissionCommandFor(
  v: StoredProviderTransmissionReview,
): ProviderTransmissionCommand {
  return providerTransmissionCommandSchema.parse({
    commandVersion: 1,
    kind: "approve-provider-transmission",
    clientRequestId: randomUUID(),
    runId: v.run.id,
    runDigest: v.run.runDigest,
    approvedReviewDigest: v.reviewDigest,
    expectedArchiveDigest: v.archiveDigest,
    expectedCoverageDigest: v.coverageDigest,
    expectedReservationBindingDigest: v.reservation.bindingDigest,
    expectedManifestDigest: v.manifest.manifestDigest,
    expectedRun: { revision: 0, snapshotDigest: v.run.snapshotDigest },
    expectedPolicyHead: v.policy.head,
    expectedPolicyReference: v.policy.reservedReference,
    expectedBudgetHead: { revision: v.budget.revision, headDigest: v.budget.headDigest },
    approval: {
      noticeVersion: 1,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: digest(v.retention),
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      acknowledgedCurrentPolicyAndBudget: true,
      approvedAt,
    },
  });
}
export function transmissionFixture(configuration = config()) {
  const reservationInput = reservationFixture(configuration);
  const coverage = createProviderReservationMigrationCoverage(reservationInput.current.ledger);
  const reservation = reserve(reservationInput);
  withRows(reservationInput, reservation);
  const current = {
    selection: { runId: reservation.rows.run.id, runDigest: reservation.rows.run.runDigest },
    inspectedAt,
    configuration,
    archive: {
      ledger: reservationInput.current.ledger,
      coverage,
      records: [reservation.rows.binding],
    },
  };
  const value = transmissionReview(current);
  const input = {
    command: transmissionCommandFor(value),
    review: value,
    current: { ...current, inspectedAt: recordedAt },
    additionalUsedBytes: 0,
  };
  return { input, reservationInput, reservation };
}
