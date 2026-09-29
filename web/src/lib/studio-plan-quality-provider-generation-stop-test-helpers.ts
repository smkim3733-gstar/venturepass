import { randomUUID } from "node:crypto";
import { generationValidationFixture } from "./studio-plan-quality-provider-generation-validation-test-helpers";
import type { ProviderGenerationValidationIdentity } from "./studio-plan-quality-provider-generation-validation";
import type {
  ProviderGenerationStopInput,
  ProviderGenerationStopPlan,
} from "./studio-plan-quality-provider-generation-stop";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  generationResponseCommand,
  captureGenerationResponseInput,
} from "./studio-plan-quality-provider-generation-response";
import { assessProviderUsage } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  providerUsageRecognitionPayload,
} from "../../scripts/local-data-quality-provider-execution.mjs";

export function generationStopFixture(
  kind: "unobserved" | "unknown" | "bound" | "invalid" | "valid" = "invalid",
) {
  const f = generationValidationFixture((response) => {
    if (kind === "unknown") delete response.usage;
    if (kind === "bound")
      response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "invalid") response.output = [];
  });
  const original = f.input.identity as ProviderGenerationValidationIdentity,
    ledger = f.input.archive.archive.ledger;
  if (kind === "unobserved") {
    ledger.events = ledger.events.filter(
      (row) => (row as { eventDigest: string }).eventDigest !== f.response.eventDigest,
    );
    ledger.receipts = ledger.receipts.filter(
      (row) => (row as { clientRequestId: string }).clientRequestId !== original.responseRequestId,
    );
    ledger.artifacts = ledger.artifacts.filter(
      (row) => (row as { key: string }).key !== "generation-response",
    );
    if (f.response.payload.kind !== "response-received") throw Error("Response required");
    const usageDigest = f.response.payload.usageBudgetEventDigest;
    ledger.budgetEvents = ledger.budgetEvents.filter(
      (row) => (row as { eventDigest: string }).eventDigest !== usageDigest,
    );
  }
  const input: ProviderGenerationStopInput = {
    ...f.input,
    identity: {
      dispatch: original.dispatch,
      stopRequestId: randomUUID(),
      observation:
        kind === "unobserved"
          ? { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" }
          : {
              kind: "response",
              responseRequestId: original.responseRequestId,
              responseEventDigest: original.responseEventDigest,
            },
    },
  };
  return { input, raw: f.raw };
}
export function applyGenerationStopPlan(
  input: ProviderGenerationStopInput,
  plan: ProviderGenerationStopPlan,
) {
  const archive = structuredClone(input.archive),
    ledger = archive.archive.ledger;
  ledger.budgetEvents.push(plan.rows.budgetEvent);
  ledger.events.push(plan.rows.event);
  ledger.receipts.push(plan.rows.receipt);
  return archive;
}
/** Build the same native late capture as the response store, after a planned unobserved stop. */
export function appendLateStopTestResponse(
  archive: ProviderGenerationStopInput["archive"],
  raw: ReturnType<typeof generationStopFixture>["raw"],
) {
  const state = inspectProviderTransmissionApprovalArchive(archive).reservationArchive.ledger,
    snapshot = state.provider.snapshots.find((row) => row.run.id === raw.dispatch.runId)!;
  if (snapshot.archiveFormatVersion !== 3) throw Error("Native required");
  const approval = snapshot.events[0];
  if (approval.payload.kind !== "transmission-approved") throw Error("Approval required");
  const command = generationResponseCommand(
      captureGenerationResponseInput(raw),
      snapshot,
      snapshot.revision,
    ),
    assessment = assessProviderUsage({
      response: raw.response,
      policy: approval.payload.manifest.executionContract.usagePolicy,
      financialBasis: snapshot.run.preparation.financialBasis,
      phase: "generation",
    }),
    recognition = providerUsageRecognitionPayload(
      snapshot.run,
      "generation",
      command.payload.dispatchEventDigest,
      command.artifact!.sha256,
      assessment,
    ),
    budget = state.provider.budgets.find(
      (row) => row.scopeId === snapshot.run.preparation.budget.scopeId,
    )!,
    recordedAt = "2026-09-27T03:38:00.000Z";
  const usage = recognition
    ? createProviderExecutionBudgetEvent({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        environment: "production",
        provenance: "explicit-user",
        revision: budget.revision + 1,
        previousDigest: budget.headDigest,
        eventId: raw.responseRequestId,
        recordedAt,
        currency: budget.currency!,
        unitScale: budget.unitScale!,
        payload: recognition,
      })
    : null;
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: snapshot.run.id,
    revision: snapshot.revision + 1,
    budgetRevision: usage?.revision ?? budget.revision,
    previousEventDigest: snapshot.events.at(-1)!.eventDigest,
    recordedAt,
    payload: {
      ...command.payload,
      usageAssessment: assessment,
      usageBudgetEventDigest: usage?.eventDigest ?? null,
    },
  });
  const ledger = archive.archive.ledger;
  if (usage) ledger.budgetEvents.push(usage);
  ledger.artifacts.push(command.artifact!);
  ledger.events.push(event);
  ledger.receipts.push(
    createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: budget.scopeId,
      kind: "provider-response",
      clientRequestId: raw.responseRequestId,
      inputDigest: providerExecutionOperationDigest(snapshot.run.id, command),
      runId: snapshot.run.id,
      runRevision: event.revision,
      budgetRevision: event.budgetRevision,
      operationDigest: event.eventDigest,
      recordedAt,
    }),
  );
}
