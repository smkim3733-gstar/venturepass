import "server-only";
import { createHash } from "node:crypto";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerGenerationDispatchIdentitySchema,
  type ProviderGenerationDispatchIdentity,
} from "./studio-plan-quality-provider-dispatch-plan";
import {
  captureGenerationResponseInput,
  type ProviderGenerationResponseInput,
  type ProviderGenerationResponseRecord,
} from "./studio-plan-quality-provider-generation-response";
import type {
  ProviderGenerationValidationIdentity,
  ProviderGenerationValidationRecord,
} from "./studio-plan-quality-provider-generation-validation";
import type {
  ProviderGenerationStopIdentity,
  ProviderGenerationStopRecord,
} from "./studio-plan-quality-provider-generation-stop";
import type { ProviderOwnedSdkDispatchResult } from "./studio-plan-quality-provider-sdk-dispatch";
import type { ProviderSnapshot } from "./studio-plan-quality-provider-types";
import type { PlanQualityStore } from "./studio-plan-quality-store";
/** Internal continuation port. Concrete stores retain all write/send authorization. */
export type ProviderGenerationRunnerStore = Pick<
  PlanQualityStore,
  | "providerGet"
  | "providerRecordGenerationStop"
  | "providerGenerationStopLookup"
  | "providerRecordGenerationResponse"
  | "providerGenerationResponseLookup"
  | "providerArtifact"
  | "providerGenerationValidationLookup"
  | "providerPrepareGenerationValidation"
  | "providerRecordGenerationValidation"
  | "providerGenerationDispatchLookup"
>;

/** Versioned server nonce namespace; retain v1 for recovery of existing executions.
 * UUIDv5 (SHA-1 namespace/name), not a capability. Every store still audits global collisions. */
export function providerGenerationRunnerNonces(raw: unknown) {
  const identity = providerGenerationDispatchIdentitySchema.parse(raw);
  const name = JSON.stringify([
    identity.runId,
    identity.runDigest,
    identity.approvalBindingDigest,
    identity.preparedRequestId,
    identity.dispatchRequestId,
  ]);
  const nonce = (stage: string) => {
    const bytes = createHash("sha1")
      .update(Buffer.from("a43e7eed2f815b4c9de72b03ee247ab2", "hex"))
      .update(`venturepass/generation-runner/v1/${stage}/${name}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return Object.freeze({
    responseRequestId: nonce("response"),
    validationRequestId: nonce("validation"),
    unobservedStopRequestId: nonce("unobserved-stop"),
    responseStopRequestId: nonce("response-stop"),
  });
}

type Stage = "dispatch" | "response" | "validation" | "stop" | "history";
export type ProviderGenerationRunnerResult = {
  status: "generation-validated" | "generation-stopped" | "last-confirmed";
  snapshot: ProviderSnapshot | null;
  replayed: boolean;
  recoveredStages: Stage[];
  failure: { stage: Stage; reason: string } | null;
  transport: Pick<
    ProviderOwnedSdkDispatchResult,
    "delivery" | "fetchStarted" | "finalCheckFailedAfterStart" | "refusal"
  > | null;
  response: ProviderGenerationResponseRecord | null;
  validation: ProviderGenerationValidationRecord | null;
  stop: ProviderGenerationStopRecord | null;
  /** Sensitive server-only evidence. Retain on uncertain persistence; never log or expose in UI.
   * Recovery accepts the same capture and never constructs an SDK or resends a request. */
  pendingCapture: ProviderGenerationResponseInput | null;
  executionCompleted: false;
  reviewStarted: false;
  automaticRetryAllowed: false;
};

class GenerationContinuation {
  readonly nonces;
  readonly result: ProviderGenerationRunnerResult = {
    status: "last-confirmed",
    snapshot: null,
    replayed: false,
    recoveredStages: [],
    failure: null,
    transport: null,
    response: null,
    validation: null,
    stop: null,
    pendingCapture: null,
    executionCompleted: false,
    reviewStarted: false,
    automaticRetryAllowed: false,
  };
  constructor(
    readonly store: ProviderGenerationRunnerStore,
    readonly dispatch: ProviderGenerationDispatchIdentity,
  ) {
    this.nonces = providerGenerationRunnerNonces(dispatch);
  }
  fail(stage: Stage, reason: string) {
    this.result.failure = { stage, reason };
    return this.finish();
  }
  refresh() {
    const snapshot = this.store.providerGet(this.dispatch.runId);
    if (snapshot.run.runDigest !== this.dispatch.runDigest) throw Error("RUN_BINDING_CHANGED");
    this.result.snapshot = snapshot;
    return snapshot;
  }
  finish() {
    try {
      this.refresh();
    } catch {
      // Keep only previously confirmed evidence, never synthesize a revision or release a hold.
    }
    return freezeProviderValue(this.result);
  }
  unobservedStop(): ProviderGenerationStopIdentity {
    return {
      dispatch: this.dispatch,
      stopRequestId: this.nonces.unobservedStopRequestId,
      observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
    };
  }
  responseStop(response: ProviderGenerationResponseRecord): ProviderGenerationStopIdentity {
    return {
      dispatch: this.dispatch,
      stopRequestId: this.nonces.responseStopRequestId,
      observation: {
        kind: "response",
        responseRequestId: response.responseRequestId,
        responseEventDigest: response.responseEventDigest,
      },
    };
  }
  /** A failed write may have committed. Recover using the identical command, never a new nonce. */
  writeOrLookup<T extends { state: "committed" }>(
    stage: Stage,
    write: () => { record: T },
    lookup: () => T | { state: "not-observed" },
  ): T | null {
    try {
      return write().record;
    } catch {
      try {
        const found = lookup();
        if (found.state === "committed") {
          this.result.recoveredStages.push(stage);
          return found;
        }
      } catch {
        // A failed lookup cannot establish rollback or permission to retry the network.
      }
      return null;
    }
  }
  stop(identity: ProviderGenerationStopIdentity) {
    const record = this.writeOrLookup(
      "stop",
      () => this.store.providerRecordGenerationStop(identity),
      () => this.store.providerGenerationStopLookup(identity),
    );
    if (!record) return this.fail("stop", "persistence-unconfirmed");
    this.result.stop = record;
    this.result.status = "generation-stopped";
    return this.finish();
  }
  persist(capture: ProviderGenerationResponseInput) {
    this.result.pendingCapture = capture;
    const response = this.writeOrLookup(
      "response",
      () => this.store.providerRecordGenerationResponse(capture),
      () => this.store.providerGenerationResponseLookup(capture),
    );
    if (!response) return this.fail("response", "persistence-unconfirmed");
    this.result.pendingCapture = null;
    this.result.response = response;
    return this.continueRecorded();
  }
  /** This is historical recovery, never permission to resend or proof an absent response ended. */
  history() {
    this.result.replayed = true;
    try {
      const snapshot = this.refresh();
      const event = snapshot.events.find(
        (row) => row.payload.kind === "response-received" && row.payload.phase === "generation",
      );
      if (event) {
        const artifact = this.store.providerArtifact(this.dispatch.runId, "generation-response");
        const envelope = JSON.parse(artifact.body.toString("utf8"));
        const input = captureGenerationResponseInput({
          dispatch: this.dispatch,
          responseRequestId: this.nonces.responseRequestId,
          response: envelope.response,
        });
        const record = this.store.providerGenerationResponseLookup(input);
        if (record.state !== "committed") return this.fail("history", "response-unconfirmed");
        this.result.response = record;
      }
      return this.continueRecorded();
    } catch {
      return this.fail("history", "evidence-unconfirmed");
    }
  }
  continueRecorded(): ProviderGenerationRunnerResult {
    try {
      const snapshot = this.refresh();
      const response = this.result.response;
      const stopped = snapshot.events.find((row) => row.payload.kind === "execution-stopped");
      // Only r4/r5 are generation stops. Later review stops/completion must still recover the
      // original generation validation below, without treating it as permission to resend.
      if (stopped && (stopped.revision === 4 || stopped.revision === 5)) {
        const identity =
          stopped.revision === 4
            ? this.unobservedStop()
            : stopped.revision === 5 && response
              ? this.responseStop(response)
              : null;
        if (!identity) return this.fail("history", "stop-scope-changed");
        const record = this.store.providerGenerationStopLookup(identity);
        if (record.state !== "committed") return this.fail("history", "stop-unconfirmed");
        this.result.stop = record;
        this.result.status = "generation-stopped";
        return this.finish();
      }
      if (!response) return this.fail("dispatch", "outcome-unobserved");
      const identity: ProviderGenerationValidationIdentity = {
        dispatch: this.dispatch,
        responseRequestId: response.responseRequestId,
        responseEventDigest: response.responseEventDigest,
        validationRequestId: this.nonces.validationRequestId,
      };
      const previous = this.store.providerGenerationValidationLookup(identity);
      if (previous.state === "committed") {
        this.result.validation = previous;
        this.result.status = "generation-validated";
        return this.finish();
      }
      const prepared = this.store.providerPrepareGenerationValidation(identity);
      if (prepared.status !== "prepared") {
        if (["usage-unknown", "budget-bound-breached", "output-invalid"].includes(prepared.reason))
          return this.stop(this.responseStop(response));
        return this.fail("validation", prepared.reason);
      }
      const record = this.writeOrLookup(
        "validation",
        () => this.store.providerRecordGenerationValidation(identity),
        () => this.store.providerGenerationValidationLookup(identity),
      );
      if (!record) return this.fail("validation", "persistence-unconfirmed");
      this.result.validation = record;
      this.result.status = "generation-validated";
      return this.finish();
    } catch {
      return this.fail("history", "evidence-unconfirmed");
    }
  }
}

/** Original approval-bound generation only. The command contains identity, never configuration,
 * transport, credentials or nonces for later phases. A trusted store supplies its scoped port
 * and dispatch operation. This continuation grants no authority. r5 is not overall completion. */
export async function runQualityProviderGenerationContinuation(
  store: ProviderGenerationRunnerStore,
  raw: unknown,
  send: PlanQualityStore["providerSimulateGenerationSdkDispatch"],
): Promise<ProviderGenerationRunnerResult> {
  const dispatch = freezeProviderValue(providerGenerationDispatchIdentitySchema.parse(raw));
  const run = new GenerationContinuation(store, dispatch);
  let sent;
  try {
    sent = await send(dispatch);
  } catch {
    try {
      const found = store.providerGenerationDispatchLookup(dispatch);
      if (found.state === "committed") {
        run.result.recoveredStages.push("dispatch");
        return run.history();
      }
    } catch {
      // Neither rejection nor COMMIT acknowledgement loss creates a new send capability.
    }
    return run.fail("dispatch", "dispatch-unconfirmed");
  }
  if (!sent.newlyCommitted || sent.replayed || !sent.transport) return run.history();
  const { delivery, fetchStarted, finalCheckFailedAfterStart, refusal, observation } =
    sent.transport;
  run.result.transport = { delivery, fetchStarted, finalCheckFailedAfterStart, refusal };
  // Even a final writer COMMIT error after fetch start must not discard an observed response.
  if (observation?.kind === "response-captured") {
    return run.persist(
      captureGenerationResponseInput({
        dispatch,
        responseRequestId: run.nonces.responseRequestId,
        response: observation.response,
      }),
    );
  }
  // Only this newly-owned invocation may classify its local send outcome. A historical r3
  // could still belong to an in-flight owner and is deliberately never stopped by replay.
  return run.stop(run.unobservedStop());
}

/** Explicit server recovery for a retained capture. No SDK call, dispatch write or fresh nonce.
 * This evidence must stay in trusted server memory/storage, never become a client command. */
export function recoverQualityProviderGenerationCapture(
  store: ProviderGenerationRunnerStore,
  raw: unknown,
) {
  const capture = captureGenerationResponseInput(raw);
  const run = new GenerationContinuation(store, capture.dispatch);
  if (capture.responseRequestId !== run.nonces.responseRequestId)
    return run.fail("response", "recovery-nonce-conflict");
  run.result.replayed = true;
  return run.persist(capture);
}

/** Existing constructor-gated synthetic entry point. */
export function runQualityProviderGenerationSimulation(store: PlanQualityStore, raw: unknown) {
  return runQualityProviderGenerationContinuation(store, raw, (id) =>
    store.providerSimulateGenerationSdkDispatch(id),
  );
}
