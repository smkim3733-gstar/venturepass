import { randomUUID } from "node:crypto";
import { createProviderTransmissionApprovalMigrationCoverage } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { prepareProviderTransmissionApproval } from "./studio-plan-quality-provider-transmission-plan";
import { transmissionFixture } from "./studio-plan-quality-provider-transmission-test-helpers";
import { config } from "./studio-plan-quality-provider-reservation-test-helpers";
import type { ProviderGenerationDispatchInput } from "./studio-plan-quality-provider-dispatch-plan";

/** Production-shaped but entirely synthetic in-memory records. No DB or transport. */
export function generationDispatchFixture(configuration = config()) {
  const transmission = transmissionFixture(configuration);
  const archive = transmission.input.current.archive;
  const coverage = createProviderTransmissionApprovalMigrationCoverage(archive);
  const approved = prepareProviderTransmissionApproval(transmission.input);
  if (approved.status !== "prepared") throw new Error(approved.reason);
  archive.ledger.events.push(approved.plan.rows.event);
  archive.ledger.receipts.push(approved.plan.rows.receipt);
  const binding = approved.plan.rows.binding;
  const input: ProviderGenerationDispatchInput = {
    identity: {
      runId: binding.runId,
      runDigest: binding.runDigest,
      approvalBindingDigest: binding.recordDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    },
    inspectedAt: "2026-09-27T03:35:00.000Z",
    configuration,
    archive: { archive, coverage, records: [binding] },
    additionalUsedBytes: 0,
  };
  return { input, transmission, approval: approved.plan };
}
