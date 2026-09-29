import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import type {
  ProviderExecutionCommand,
  ProviderExecutionSnapshot,
} from "./studio-plan-quality-provider-execution-types";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest } from "../../scripts/local-data-quality-provider.mjs";

/** All input and mock requests are synthetic and owned by the caller's temporary test DB. */
export async function reviewDispatchStoreFixture(
  store: PlanQualityStore,
): Promise<ProviderReviewDispatchIdentity> {
  const raw = generationResponseFixture(generationDispatchStoreFixture(store));
  raw.response.output = [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify(actualTestPlan(store.candidateRegistryGet(1))),
        },
      ],
    },
  ];
  await store.providerSimulateGenerationDispatch(raw.dispatch, {
    provenance: "synthetic-test",
    send: async () => undefined,
  });
  const response = store.providerRecordGenerationResponse(raw).record;
  const generation = {
    dispatch: raw.dispatch,
    responseRequestId: raw.responseRequestId,
    responseEventDigest: response.responseEventDigest,
    validationRequestId: randomUUID(),
  };
  const validation = store.providerRecordGenerationValidation(generation).record;
  return {
    generation,
    validationEventDigest: validation.validationEventDigest,
    preparedRequestId: randomUUID(),
    dispatchRequestId: randomUUID(),
  };
}

/** Native synthetic terminal fixture only. Keeps review cost held after an unobserved intent. */
export function appendReviewUnobservedStop(db: DatabaseSync, snapshot: ProviderExecutionSnapshot) {
  if (snapshot.revision !== 7 || snapshot.terminal) throw Error("Expected active review r7");
  const run = snapshot.run,
    budget = getProviderExecutionBudgetSnapshot(
      snapshot.budgetEvents,
      run.preparation.budget.scopeId,
    );
  const recordedAt = new Date().toISOString();
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
    runId: run.id,
    revision: 8,
    budgetRevision: budget.revision,
    previousEventDigest: snapshot.events[6].eventDigest,
    recordedAt,
    payload: { ...command.payload, releasedBudgetEventDigests: [] },
  });
  const receipt = createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    kind: "provider-finish",
    clientRequestId: command.clientRequestId,
    inputDigest: providerExecutionOperationDigest(run.id, command),
    runId: run.id,
    runRevision: 8,
    budgetRevision: budget.revision,
    operationDigest: event.eventDigest,
    recordedAt,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
    ).run(run.id, 8, JSON.stringify(event), providerDigest(event));
    db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
      receipt.clientRequestId,
      JSON.stringify(receipt),
      providerDigest(receipt),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
