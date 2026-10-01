import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerGenerationRunnerNonces,
  providerGenerationSimulationPort,
  runQualityProviderGenerationContinuation,
  type ProviderGenerationRunnerStore,
  type ProviderGenerationRunnerResult,
} from "./studio-plan-quality-provider-generation-runner";
import { providerGenerationValidationIdentitySchema } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import {
  captureReviewResponseInput,
  type ProviderReviewResponseCapture,
  type ProviderReviewResponseRecord,
} from "./studio-plan-quality-provider-review-response";
import type {
  ProviderReviewValidationIdentity,
  ProviderReviewValidationRecord,
} from "./studio-plan-quality-provider-review-validation";
import type {
  ProviderFinalizationIdentity,
  ProviderFinalizationRecord,
} from "./studio-plan-quality-provider-finalization";
import type {
  ProviderReviewStopIdentity,
  ProviderReviewStopRecord,
} from "./studio-plan-quality-provider-review-stop";
import type { StoredProviderSnapshot } from "./studio-plan-quality-provider-types";
import type { PlanQualityStore } from "./studio-plan-quality-store";
/** Internal continuation port. Concrete stores retain all write/send authorization. */
export type ProviderApprovedRunnerStore = ProviderGenerationRunnerStore &
  Pick<
    PlanQualityStore,
    | "providerRecordReviewStop"
    | "providerReviewStopLookup"
    | "providerRecordReviewResponse"
    | "providerReviewResponseLookup"
    | "providerArtifact"
    | "providerReviewValidationLookup"
    | "providerPrepareReviewValidation"
    | "providerRecordReviewValidation"
    | "providerFinalizationLookup"
    | "providerPrepareFinalization"
    | "providerRecordFinalization"
    | "providerReviewDispatchLookup"
  >;

const generationScopeSchema = z
  .object({
    generation: providerGenerationValidationIdentitySchema,
    validationEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Server-only v1 namespace. A deterministic identity is not execution authority. The store
 * still audits the original generation receipts, validation digest and every nonce collision. */
export function providerReviewRunnerScope(raw: unknown) {
  const scope = generationScopeSchema.parse(raw),
    g = scope.generation,
    d = g.dispatch;
  const generationNonces = providerGenerationRunnerNonces(d);
  if (
    g.responseRequestId !== generationNonces.responseRequestId ||
    g.validationRequestId !== generationNonces.validationRequestId
  )
    throw Error("PROVIDER_REVIEW_RUNNER_GENERATION_NONCE_CONFLICT");
  const name = JSON.stringify([
    d.runId,
    d.runDigest,
    d.approvalBindingDigest,
    d.preparedRequestId,
    d.dispatchRequestId,
    g.responseRequestId,
    g.responseEventDigest,
    g.validationRequestId,
    scope.validationEventDigest,
  ]);
  const nonce = (stage: string) => {
    const bytes = createHash("sha1")
      .update(Buffer.from("a43e7eed2f815b4c9de72b03ee247ab2", "hex"))
      .update(`venturepass/review-runner/v1/${stage}/${name}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return freezeProviderValue({
    dispatch: {
      ...scope,
      preparedRequestId: nonce("prepared"),
      dispatchRequestId: nonce("dispatch"),
    },
    nonces: {
      responseRequestId: nonce("response"),
      validationRequestId: nonce("validation"),
      finalizationRequestId: nonce("finalization"),
      unobservedStopRequestId: nonce("unobserved-stop"),
      responseStopRequestId: nonce("response-stop"),
    },
  });
}
type ReviewScope = ReturnType<typeof providerReviewRunnerScope>;
type Stage = "dispatch" | "response" | "validation" | "finalization" | "stop" | "history";
export type ProviderReviewRunnerResult = {
  status: "completed" | "review-validated" | "review-stopped" | "last-confirmed";
  /** Last audited read; confirmed phase records can be newer if a later snapshot read fails. */
  snapshot: StoredProviderSnapshot | null;
  replayed: boolean;
  recoveredStages: Stage[];
  failure: { stage: Stage; reason: string } | null;
  transport: ProviderGenerationRunnerResult["transport"];
  response: ProviderReviewResponseRecord | null;
  validation: ProviderReviewValidationRecord | null;
  finalization: ProviderFinalizationRecord | null;
  stop: ProviderReviewStopRecord | null;
  /** Sensitive server evidence for explicit capture-only recovery. Never log or send to UI. */
  pendingCapture: ProviderReviewResponseCapture | null;
  executionCompleted: boolean;
  automaticRetryAllowed: false;
};
export type ProviderApprovedRunnerResult = {
  generation: ProviderGenerationRunnerResult;
  review: ProviderReviewRunnerResult | null;
  executionCompleted: boolean;
  automaticRetryAllowed: false;
};

class ReviewContinuation {
  readonly dispatch: ProviderReviewDispatchIdentity;
  readonly result: ProviderReviewRunnerResult = {
    status: "last-confirmed",
    snapshot: null,
    replayed: false,
    recoveredStages: [],
    failure: null,
    transport: null,
    response: null,
    validation: null,
    finalization: null,
    stop: null,
    pendingCapture: null,
    executionCompleted: false,
    automaticRetryAllowed: false,
  };
  constructor(
    readonly store: ProviderApprovedRunnerStore,
    readonly scope: ReviewScope,
  ) {
    this.dispatch = scope.dispatch;
  }
  refresh() {
    const snapshot = this.store.providerGet(this.dispatch.generation.dispatch.runId);
    if (snapshot.run.runDigest !== this.dispatch.generation.dispatch.runDigest)
      throw Error("RUN_BINDING_CHANGED");
    this.result.snapshot = snapshot;
    return snapshot;
  }
  finish() {
    try {
      this.refresh();
    } catch {
      /* Preserve only the last successfully audited snapshot. */
    }
    return freezeProviderValue(this.result);
  }
  fail(stage: Stage, reason: string) {
    this.result.failure = { stage, reason };
    return this.finish();
  }
  writeOrLookup<T extends { state: "committed" }>(
    stage: Stage,
    write: () => { record: T },
    lookup: () => T | { state: "not-observed" },
  ): T | null {
    try {
      return write().record;
    } catch {
      try {
        const record = lookup();
        if (record.state === "committed") {
          this.result.recoveredStages.push(stage);
          return record;
        }
      } catch {
        /* Neither rollback nor permission to retry a send has been established. */
      }
      return null;
    }
  }
  unobservedStop(): ProviderReviewStopIdentity {
    return {
      dispatch: this.dispatch,
      stopRequestId: this.scope.nonces.unobservedStopRequestId,
      observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
    };
  }
  responseStop(response: ProviderReviewResponseRecord): ProviderReviewStopIdentity {
    return {
      dispatch: this.dispatch,
      stopRequestId: this.scope.nonces.responseStopRequestId,
      observation: {
        kind: "response",
        responseRequestId: response.responseRequestId,
        responseEventDigest: response.responseEventDigest,
      },
    };
  }
  stop(identity: ProviderReviewStopIdentity) {
    const record = this.writeOrLookup(
      "stop",
      () => this.store.providerRecordReviewStop(identity),
      () => this.store.providerReviewStopLookup(identity),
    );
    if (!record) return this.fail("stop", "persistence-unconfirmed");
    this.result.stop = record;
    this.result.status = "review-stopped";
    return this.finish();
  }
  persist(capture: ProviderReviewResponseCapture) {
    this.result.pendingCapture = capture;
    const response = this.writeOrLookup(
      "response",
      () => this.store.providerRecordReviewResponse(capture),
      () => this.store.providerReviewResponseLookup(capture),
    );
    if (!response) return this.fail("response", "persistence-unconfirmed");
    this.result.pendingCapture = null;
    this.result.response = response;
    return this.continueRecorded();
  }
  history() {
    this.result.replayed = true;
    try {
      const snapshot = this.refresh();
      if (
        snapshot.events.some(
          (row) => row.payload.kind === "response-received" && row.payload.phase === "review",
        )
      ) {
        const artifact = this.store.providerArtifact(
          this.dispatch.generation.dispatch.runId,
          "review-response",
        );
        const capture = captureReviewResponseInput({
          dispatch: this.dispatch,
          responseRequestId: this.scope.nonces.responseRequestId,
          response: JSON.parse(artifact.body.toString("utf8")).response,
        });
        const response = this.store.providerReviewResponseLookup(capture);
        if (response.state !== "committed") return this.fail("history", "response-unconfirmed");
        this.result.response = response;
      }
      return this.continueRecorded();
    } catch {
      return this.fail("history", "evidence-unconfirmed");
    }
  }
  continueRecorded(): ProviderReviewRunnerResult {
    try {
      const snapshot = this.refresh(),
        response = this.result.response;
      const stopped = snapshot.events.find(
        (row) => row.payload.kind === "execution-stopped" && row.payload.outcome !== "completed",
      );
      if (stopped) {
        const identity =
          stopped.revision === 8
            ? this.unobservedStop()
            : stopped.revision === 9 && response
              ? this.responseStop(response)
              : null;
        if (!identity) return this.fail("history", "stop-scope-changed");
        const record = this.store.providerReviewStopLookup(identity);
        if (record.state !== "committed") return this.fail("history", "stop-unconfirmed");
        this.result.stop = record;
        this.result.status = "review-stopped";
        return this.finish();
      }
      if (!response) return this.fail("dispatch", "outcome-unobserved");
      const identity: ProviderReviewValidationIdentity = {
        dispatch: this.dispatch,
        responseRequestId: response.responseRequestId,
        responseEventDigest: response.responseEventDigest,
        validationRequestId: this.scope.nonces.validationRequestId,
      };
      const previous = this.store.providerReviewValidationLookup(identity);
      if (previous.state === "committed") return this.finalize(previous);
      const prepared = this.store.providerPrepareReviewValidation(identity);
      if (prepared.status !== "prepared") {
        if (["usage-unknown", "budget-bound-breached", "output-invalid"].includes(prepared.reason))
          return this.stop(this.responseStop(response));
        return this.fail("validation", prepared.reason);
      }
      const record = this.writeOrLookup(
        "validation",
        () => this.store.providerRecordReviewValidation(identity),
        () => this.store.providerReviewValidationLookup(identity),
      );
      if (!record) return this.fail("validation", "persistence-unconfirmed");
      return this.finalize(record);
    } catch {
      return this.fail("history", "evidence-unconfirmed");
    }
  }
  finalize(validation: ProviderReviewValidationRecord): ProviderReviewRunnerResult {
    this.result.validation = validation;
    this.result.status = "review-validated"; // r9 never implies a persisted final result.
    const identity: ProviderFinalizationIdentity = {
      validation: {
        dispatch: this.dispatch,
        responseRequestId: validation.responseRequestId,
        responseEventDigest: validation.responseEventDigest,
        validationRequestId: validation.validationRequestId,
      },
      validationEventDigest: validation.validationEventDigest,
      finalizationRequestId: this.scope.nonces.finalizationRequestId,
    };
    try {
      let record = this.store.providerFinalizationLookup(identity);
      if (record.state !== "committed") {
        const prepared = this.store.providerPrepareFinalization(identity);
        if (prepared.status !== "prepared") return this.fail("finalization", prepared.reason);
        const confirmed = this.writeOrLookup(
          "finalization",
          () => this.store.providerRecordFinalization(identity),
          () => this.store.providerFinalizationLookup(identity),
        );
        if (!confirmed) return this.fail("finalization", "persistence-unconfirmed");
        record = confirmed;
      }
      this.result.finalization = record;
      this.result.status = "completed";
      this.result.executionCompleted = true;
      return this.finish();
    } catch {
      return this.fail("finalization", "evidence-unconfirmed");
    }
  }
}

async function runReview(
  store: ProviderApprovedRunnerStore,
  scope: ReviewScope,
  send: PlanQualityStore["providerSimulateReviewSdkDispatch"],
) {
  const run = new ReviewContinuation(store, scope);
  let sent;
  try {
    sent = await send(scope.dispatch);
  } catch {
    try {
      const found = store.providerReviewDispatchLookup(scope.dispatch);
      if (found.state === "committed") {
        run.result.recoveredStages.push("dispatch");
        return run.history();
      }
    } catch {
      /* An uncertain COMMIT never creates a new SDK owner. */
    }
    return run.fail("dispatch", "dispatch-unconfirmed");
  }
  if (!sent.newlyCommitted || sent.replayed || !sent.transport) return run.history();
  const { delivery, fetchStarted, finalCheckFailedAfterStart, refusal, observation } =
    sent.transport;
  run.result.transport = { delivery, fetchStarted, finalCheckFailedAfterStart, refusal };
  if (observation?.kind === "response-captured")
    return run.persist(
      captureReviewResponseInput({
        dispatch: scope.dispatch,
        responseRequestId: scope.nonces.responseRequestId,
        response: observation.response,
      }),
    );
  // Only the invocation owning a new dispatch may classify its local SDK result, never replay.
  return run.stop(run.unobservedStop());
}

/** Same original generation identity from approval, no new caller-supplied settings/phase IDs.
 * Internal continuation only: concrete stores supply already scoped operations and retain
 * authorization. No key, runtime or permission is created by this orchestration. */
export async function runQualityProviderApprovedContinuation(
  store: ProviderApprovedRunnerStore,
  raw: unknown,
  sendGeneration: PlanQualityStore["providerSimulateGenerationSdkDispatch"],
  sendReview: PlanQualityStore["providerSimulateReviewSdkDispatch"],
): Promise<ProviderApprovedRunnerResult> {
  const generation = await runQualityProviderGenerationContinuation(store, raw, sendGeneration);
  let review: ProviderReviewRunnerResult | null = null;
  if (generation.status === "generation-validated" && generation.validation) {
    const record = generation.validation;
    const scope = providerReviewRunnerScope({
      generation: {
        dispatch: record.dispatch,
        responseRequestId: record.responseRequestId,
        responseEventDigest: record.responseEventDigest,
        validationRequestId: record.validationRequestId,
      },
      validationEventDigest: record.validationEventDigest,
    });
    review = await runReview(store, scope, sendReview);
  }
  return freezeProviderValue({
    generation,
    review,
    executionCompleted: review?.executionCompleted === true,
    automaticRetryAllowed: false as const,
  });
}

/** Explicit retained-capture recovery only. Never calls either SDK, prepares dispatch or grants
 * approval. The caller must keep this sensitive evidence on the server, outside HTTP/UI input. */
export function recoverQualityProviderReviewCapture(
  store: ProviderApprovedRunnerStore,
  raw: unknown,
) {
  const capture = captureReviewResponseInput(raw);
  const scope = providerReviewRunnerScope({
    generation: capture.dispatch.generation,
    validationEventDigest: capture.dispatch.validationEventDigest,
  });
  const run = new ReviewContinuation(store, scope);
  if (
    capture.responseRequestId !== scope.nonces.responseRequestId ||
    capture.dispatch.preparedRequestId !== scope.dispatch.preparedRequestId ||
    capture.dispatch.dispatchRequestId !== scope.dispatch.dispatchRequestId
  )
    return run.fail("response", "recovery-nonce-conflict");
  run.result.replayed = true;
  return run.persist(capture);
}

/** Scoped simulation adapter; the shared continuation never turns archive reads into authority. */
export function providerApprovedSimulationPort(
  store: PlanQualityStore,
): ProviderApprovedRunnerStore {
  return Object.freeze({
    ...providerGenerationSimulationPort(store),
    providerReviewDispatchLookup: (value: unknown) => store.providerReviewDispatchLookup(value),
    providerReviewResponseLookup: (value: unknown) => store.providerReviewResponseLookup(value),
    providerReviewValidationLookup: (value: unknown) => store.providerReviewValidationLookup(value),
    providerReviewStopLookup: (value: unknown) => store.providerReviewStopLookup(value),
    providerFinalizationLookup: (value: unknown) => store.providerFinalizationLookup(value),
    providerPrepareReviewValidation: (value: unknown) =>
      store.providerPrepareReviewValidation(value),
    providerPrepareFinalization: (value: unknown) => store.providerPrepareFinalization(value),
    providerRecordReviewResponse: (value: unknown) => store.providerRecordReviewResponse(value),
    providerRecordReviewValidation: (value: unknown) => store.providerRecordReviewValidation(value),
    providerRecordReviewStop: (value: unknown) => store.providerRecordReviewStop(value),
    providerRecordFinalization: (value: unknown) => store.providerRecordFinalization(value),
  });
}

/** Existing constructor-gated synthetic entry point. */
export function runQualityProviderApprovedSimulation(store: PlanQualityStore, raw: unknown) {
  return runQualityProviderApprovedContinuation(
    providerApprovedSimulationPort(store),
    raw,
    (id) => store.providerSimulateGenerationSdkDispatch(id),
    (id) => store.providerSimulateReviewSdkDispatch(id),
  );
}
