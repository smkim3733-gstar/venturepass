import { randomUUID } from "node:crypto";
import { actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import {
  prepareProviderGenerationDispatch,
  type ProviderGenerationDispatchIdentity,
} from "./studio-plan-quality-provider-dispatch-plan";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import {
  generationResponseCommand,
  captureGenerationResponseInput,
} from "./studio-plan-quality-provider-generation-response";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { assessProviderUsage } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  providerUsageRecognitionPayload,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import type { ProviderGenerationValidationInput } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderCapturedResponse } from "../../scripts/local-data-quality-provider-usage.mjs";

/** In-memory synthetic records, never a provider call or operational approval. */
export function generationValidationFixture(change?: (response: ProviderCapturedResponse) => void) {
  const f = generationDispatchFixture(),
    dispatch = prepareProviderGenerationDispatch(f.input);
  if (dispatch.status !== "prepared") throw new Error(dispatch.reason);
  const ledger = f.input.archive.archive.ledger;
  ledger.events.push(...dispatch.plan.rows.events);
  ledger.receipts.push(...dispatch.plan.rows.receipts);
  const state = inspectProviderTransmissionApprovalArchive(f.input.archive).reservationArchive
    .ledger;
  const snapshot = state.provider.snapshots[0];
  if (snapshot.archiveFormatVersion !== 3) throw new Error("Native execution required");
  const raw = generationResponseFixture(f.input.identity as ProviderGenerationDispatchIdentity);
  raw.response.output = [
    {
      type: "message",
      content: [
        { type: "output_text", text: JSON.stringify(actualTestPlan(ledger.registries[0])) },
      ],
    },
  ];
  change?.(raw.response);
  const captured = captureGenerationResponseInput(raw),
    command = generationResponseCommand(captured, snapshot, 3);
  const approval = snapshot.events[0];
  if (approval.payload.kind !== "transmission-approved") throw new Error("Approval required");
  const assessment = assessProviderUsage({
    response: captured.response,
    policy: approval.payload.manifest.executionContract.usagePolicy,
    financialBasis: snapshot.run.preparation.financialBasis,
    phase: "generation",
  });
  const recognition = providerUsageRecognitionPayload(
    snapshot.run,
    "generation",
    command.payload.dispatchEventDigest,
    command.artifact!.sha256,
    assessment,
  );
  const budget = state.provider.budgets.find(
      (row) => row.scopeId === snapshot.run.preparation.budget.scopeId,
    )!,
    recordedAt = "2026-09-27T03:36:00.000Z";
  const usage = recognition
    ? createProviderExecutionBudgetEvent({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        environment: "production",
        provenance: "explicit-user",
        revision: budget.revision + 1,
        previousDigest: budget.headDigest,
        eventId: command.clientRequestId,
        recordedAt,
        currency: budget.currency!,
        unitScale: budget.unitScale!,
        payload: recognition,
      })
    : null;
  if (usage) ledger.budgetEvents.push(usage);
  const response = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: snapshot.run.id,
    revision: 4,
    budgetRevision: usage?.revision ?? budget.revision,
    previousEventDigest: snapshot.events[2].eventDigest,
    recordedAt,
    payload: {
      ...command.payload,
      usageAssessment: assessment,
      usageBudgetEventDigest: usage?.eventDigest ?? null,
    },
  });
  ledger.artifacts.push(command.artifact!);
  ledger.events.push(response);
  ledger.receipts.push(
    createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: budget.scopeId,
      kind: "provider-response",
      clientRequestId: command.clientRequestId,
      inputDigest: providerExecutionOperationDigest(snapshot.run.id, command),
      runId: snapshot.run.id,
      runRevision: 4,
      budgetRevision: response.budgetRevision,
      operationDigest: response.eventDigest,
      recordedAt,
    }),
  );
  const input: ProviderGenerationValidationInput = {
    identity: {
      dispatch: raw.dispatch,
      responseRequestId: command.clientRequestId,
      responseEventDigest: response.eventDigest,
      validationRequestId: randomUUID(),
    },
    archive: f.input.archive,
    inspectedAt: "2026-09-27T03:37:00.000Z",
    additionalUsedBytes: 0,
  };
  return { input, raw, response, registry: ledger.registries[0] };
}
