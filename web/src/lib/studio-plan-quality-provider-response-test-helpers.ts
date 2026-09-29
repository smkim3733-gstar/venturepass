import { randomUUID } from "node:crypto";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderGenerationResponseInput } from "./studio-plan-quality-provider-generation-response";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProviderExecutionCommand,
  ProviderExecutionSnapshot,
} from "./studio-plan-quality-provider-execution-types";
import {
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

export function generationResponseFixture(
  dispatch: ProviderGenerationDispatchIdentity,
): ProviderGenerationResponseInput {
  return {
    dispatch,
    responseRequestId: randomUUID(),
    response: {
      id: "synthetic-response",
      _request_id: "synthetic-request",
      model: "gpt-5.4-2026-03-05",
      service_tier: "default",
      status: "completed",
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "synthetic unvalidated output" }],
        },
      ],
    },
  };
}

/** Native late-response prefix, inserted only in isolated test DBs. No production gate is opened. */
export function appendUnobservedGenerationStop(
  db: DatabaseSync,
  snapshot: ProviderExecutionSnapshot,
) {
  const run = snapshot.run,
    budget = getProviderExecutionBudgetSnapshot(
      snapshot.budgetEvents,
      run.preparation.budget.scopeId,
    );
  const release = createProviderExecutionBudgetEvent({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    environment: run.environment,
    provenance: run.approval.provenance,
    revision: budget.revision + 1,
    previousDigest: budget.headDigest,
    eventId: randomUUID(),
    recordedAt: new Date().toISOString(),
    currency: budget.currency!,
    unitScale: budget.unitScale!,
    payload: {
      kind: "release-phase",
      phase: "review",
      runId: run.id,
      reservationDigest: run.reservationDigest,
      releasedUnits: run.preparation.financialBasis.costs!.review.totalUnits,
      reason: "not-dispatched",
    },
  });
  const command: ProviderExecutionCommand<"execution-stopped"> = {
    clientRequestId: randomUUID(),
    expectedRevision: 3,
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
    runId: run.id,
    revision: 4,
    budgetRevision: release.revision,
    previousEventDigest: snapshot.events[2].eventDigest,
    recordedAt: release.recordedAt,
    payload: { ...command.payload, releasedBudgetEventDigests: [release.eventDigest] },
  });
  const receipt = createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    kind: "provider-finish",
    clientRequestId: command.clientRequestId,
    inputDigest: providerExecutionOperationDigest(run.id, command),
    runId: run.id,
    runRevision: 4,
    budgetRevision: release.revision,
    operationDigest: event.eventDigest,
    recordedAt: release.recordedAt,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO quality_actual_budget_events(scope_id,revision,body,body_hash) VALUES(?,?,?,?)",
    ).run(release.scopeId, release.revision, JSON.stringify(release), digest(release));
    db.prepare(
      "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
    ).run(run.id, 4, JSON.stringify(event), digest(event));
    db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
      receipt.clientRequestId,
      JSON.stringify(receipt),
      digest(receipt),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
