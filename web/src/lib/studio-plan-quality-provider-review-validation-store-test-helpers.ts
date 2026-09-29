import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { reviewDispatchStoreFixture } from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import type {
  ProviderExecutionCommand,
  ProviderExecutionSnapshot,
} from "./studio-plan-quality-provider-execution-types";
import {
  createProviderExecutionArtifact,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

/** Synthetic r8 fixture only, never real provider transport. */
export async function reviewValidationStoreFixture(store: PlanQualityStore) {
  const capture = reviewResponseCapture(await reviewDispatchStoreFixture(store));
  await store.providerSimulateReviewDispatch(capture.dispatch, {
    provenance: "synthetic-test",
    send: async () => undefined,
  });
  setReviewValidationOutput(capture.response);
  const response = store.providerRecordReviewResponse(capture).record;
  return {
    capture,
    identity: {
      dispatch: capture.dispatch,
      responseRequestId: capture.responseRequestId,
      responseEventDigest: response.responseEventDigest,
      validationRequestId: randomUUID(),
    },
  };
}

/** Native synthetic terminal fixture for recovery/competition tests only. No application stop API.
 * A stale snapshot loses to the unique event revision inside this write transaction. */
export function appendReviewTerminalFixture(
  db: DatabaseSync,
  snapshot: ProviderExecutionSnapshot,
  finalRawBody?: string,
) {
  if (
    snapshot.archiveFormatVersion !== 3 ||
    snapshot.terminal ||
    ![8, 9].includes(snapshot.revision) ||
    (finalRawBody !== undefined && snapshot.revision !== 9)
  )
    throw Error("Expected active review r8 or r9");
  const run = snapshot.run,
    budget = getProviderExecutionBudgetSnapshot(
      snapshot.budgetEvents,
      run.preparation.budget.scopeId,
    ),
    artifact =
      finalRawBody === undefined
        ? null
        : createProviderExecutionArtifact({
            runId: run.id,
            key: "final-result",
            body: finalRawBody,
          }),
    recordedAt = new Date().toISOString();
  const command: ProviderExecutionCommand<"execution-stopped"> = {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    ...(artifact ? { artifact } : {}),
    payload: {
      kind: "execution-stopped",
      outcome: artifact ? "completed" : "output-invalid",
      failureCode: artifact ? null : "OUTPUT_INVALID",
      finalArtifactSha256: artifact?.sha256 ?? null,
    },
  };
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: run.id,
    revision: snapshot.revision + 1,
    budgetRevision: budget.revision,
    previousEventDigest: snapshot.events.at(-1)!.eventDigest,
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
    runRevision: event.revision,
    budgetRevision: budget.revision,
    operationDigest: event.eventDigest,
    recordedAt,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    if (artifact)
      db.prepare(
        "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
      ).run(
        run.id,
        artifact.key,
        Buffer.from(artifact.body, "utf8"),
        artifact.sha256,
        artifact.sizeBytes,
      );
    db.prepare(
      "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
    ).run(run.id, event.revision, JSON.stringify(event), digest(event));
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
