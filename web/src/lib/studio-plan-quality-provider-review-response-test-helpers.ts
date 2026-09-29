import { randomUUID } from "node:crypto";
import { reviewDispatchFixture } from "./studio-plan-quality-provider-review-dispatch-test-helpers";
import {
  prepareProviderReviewDispatch,
  type ProviderReviewDispatchIdentity,
} from "./studio-plan-quality-provider-review-dispatch-plan";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import type {
  ProviderReviewResponseCapture,
  ProviderReviewResponseInput,
} from "./studio-plan-quality-provider-review-response";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import type { ProviderExecutionCommand } from "./studio-plan-quality-provider-execution-types";

export function reviewResponseCapture(
  dispatch: ProviderReviewDispatchIdentity,
): ProviderReviewResponseCapture {
  return {
    dispatch,
    responseRequestId: randomUUID(),
    response: generationResponseFixture(dispatch.generation.dispatch).response,
  };
}
/** Synthetic in-memory r7; never connects to storage or a provider. */
export function reviewResponseFixture() {
  const f = reviewDispatchFixture(),
    result = prepareProviderReviewDispatch(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  const ledger = f.input.archive.archive.ledger;
  ledger.artifacts.push(result.plan.rows.artifact);
  ledger.events.push(...result.plan.rows.events);
  ledger.receipts.push(...result.plan.rows.receipts);
  const capture = reviewResponseCapture(result.plan.identity);
  const input: ProviderReviewResponseInput = {
    capture,
    archive: f.input.archive,
    inspectedAt: "2026-09-27T03:39:00.000Z",
    additionalUsedBytes: 0,
  };
  return { input, capture };
}
export function appendReviewStopFixture(input: ProviderReviewResponseInput) {
  const state = inspectProviderTransmissionApprovalArchive(input.archive).reservationArchive.ledger
      .provider,
    snapshot = state.snapshots[0],
    budget = state.budgets.find((row) => row.scopeId === snapshot.run.preparation.budget.scopeId)!;
  if (snapshot.archiveFormatVersion !== 3 || snapshot.revision !== 7) throw Error("Expected r7");
  const command: ProviderExecutionCommand<"execution-stopped"> = {
    clientRequestId: randomUUID(),
    expectedRevision: 7,
    payload: {
      kind: "execution-stopped",
      outcome: "result-unobserved",
      failureCode: "INTERRUPTED",
      finalArtifactSha256: null,
    },
  };
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: snapshot.run.id,
    revision: 8,
    budgetRevision: budget.revision,
    previousEventDigest: snapshot.events[6].eventDigest,
    recordedAt: input.inspectedAt,
    payload: { ...command.payload, releasedBudgetEventDigests: [] },
  });
  const receipt = createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    kind: "provider-finish",
    clientRequestId: command.clientRequestId,
    inputDigest: providerExecutionOperationDigest(snapshot.run.id, command),
    runId: snapshot.run.id,
    runRevision: 8,
    budgetRevision: budget.revision,
    operationDigest: event.eventDigest,
    recordedAt: event.recordedAt,
  });
  input.archive.archive.ledger.events.push(event);
  input.archive.archive.ledger.receipts.push(receipt);
  return event;
}
