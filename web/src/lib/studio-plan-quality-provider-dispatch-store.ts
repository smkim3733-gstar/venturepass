import "server-only";
import {
  providerProductionSelectionSchema,
  providerProductionInspectionInputSchema,
} from "./studio-plan-quality-provider-production-service-types";
import { projectAuditedProviderProductionStatus } from "./studio-plan-quality-provider-production-status";
import { providerInitialProductionIdentity } from "./studio-plan-quality-provider-production-identity";
import {
  runQualityProviderApprovedContinuation,
  recoverQualityProviderReviewCapture,
  type ProviderApprovedRunnerStore,
  type ProviderApprovedRunnerResult,
} from "./studio-plan-quality-provider-approved-runner";
import { recoverQualityProviderGenerationCapture } from "./studio-plan-quality-provider-generation-runner";
import {
  scopeProviderProductionOperation,
  type ProviderProductionOperation,
} from "./studio-plan-quality-provider-production-scope";
import {
  isProviderProductionExecution,
  inspectProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import {
  dispatchOwnedProviderSdkTest,
  type ProviderSdkTestNetwork,
  type ProviderOwnedSdkDispatchResult,
} from "./studio-plan-quality-provider-sdk-dispatch";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StudioError } from "./studio-http";
import {
  prepareProviderReviewStop,
  providerReviewStopIdentitySchema,
  type ProviderReviewStopIdentity,
  type ProviderReviewStopRecord,
  type ProviderReviewStopCommitResult,
} from "./studio-plan-quality-provider-review-stop";
import {
  prepareProviderFinalization,
  providerFinalizationIdentitySchema,
  type ProviderFinalizationIdentity,
  type ProviderFinalizationRecord,
  type ProviderFinalizationCommitResult,
} from "./studio-plan-quality-provider-finalization";
import {
  prepareProviderReviewValidation,
  providerReviewValidationIdentitySchema,
  type ProviderReviewValidationIdentity,
  type ProviderReviewValidationRecord,
  type ProviderReviewValidationCommitResult,
} from "./studio-plan-quality-provider-review-validation";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { inspectQualityDatabaseUsage } from "../../scripts/local-data-quality.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import { inspectVersionedProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import type { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  assessProviderUsage,
  freezeProviderValue,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createVersionedProviderExecutionEvent,
  versionedProviderExecutionOperationDigest,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  providerUsageRecognitionPayload,
  getProviderExecutionBudgetSnapshot,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  captureGenerationResponseInput,
  versionedGenerationResponseCommand,
  type ProviderGenerationResponseInput,
  type ProviderGenerationResponseRecord,
  type ProviderGenerationResponseResult,
} from "./studio-plan-quality-provider-generation-response";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderTransmissionReview } from "./studio-plan-quality-provider-transmission-review";
import {
  prepareProviderGenerationDispatch,
  providerGenerationDispatchIdentitySchema,
  type ProviderGenerationDispatchIdentity,
  type ProviderGenerationDispatchPlan,
  type VersionedProviderGenerationDispatchPlan,
} from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderObservationPrepared } from "./studio-provider-observation";
import {
  prepareProviderReviewResponse,
  captureReviewResponseInput,
  reviewResponseCommand,
  type ProviderReviewResponseCapture,
  type ProviderReviewResponseRecord,
  type ProviderReviewResponseCommitResult,
} from "./studio-plan-quality-provider-review-response";
import {
  prepareProviderReviewDispatch,
  providerReviewDispatchIdentitySchema,
  type ProviderReviewDispatchIdentity,
  type ProviderReviewDispatchPlan,
} from "./studio-plan-quality-provider-review-dispatch-plan";
import {
  prepareProviderGenerationValidation,
  providerGenerationValidationIdentitySchema,
  type ProviderGenerationValidationIdentity,
  type ProviderGenerationValidationRecord,
  type ProviderGenerationValidationCommitResult,
} from "./studio-plan-quality-provider-generation-validation";
import type { ProviderExecutionCommand } from "./studio-plan-quality-provider-execution-types";
import {
  prepareProviderGenerationStop,
  providerGenerationStopIdentitySchema,
  type ProviderGenerationStopIdentity,
  type ProviderGenerationStopRecord,
  type ProviderGenerationStopCommitResult,
} from "./studio-plan-quality-provider-generation-stop";

export type ProviderDispatchContext = {
  db: DatabaseSync;
  transaction: <T>(work: () => T, write?: boolean) => T;
  registry: (version: number) => CandidateRegistrySnapshot;
  capacity: (addedBytes: number) => void;
  get: ProviderApprovedRunnerStore["providerGet"];
  artifact: ProviderApprovedRunnerStore["providerArtifact"];
};
type Context = ProviderDispatchContext & {
  // Explicit server selection is currently connected only to the mock callback path.
  selection?: ReturnType<typeof createServerProviderPolicyContext>;
  synthetic: boolean;
  sdkTestNetwork?: ProviderSdkTestNetwork;
  productionRuntime?: ProviderProductionRuntime;
  /** Only installed by the trusted runtime/store factory, never a command or parent option. */
  productionExecution?: {
    assertCurrent: () => void;
    dispatch: (
      prepared: ProviderObservationPrepared,
      writer: (start: () => void) => void,
    ) => Promise<ProviderOwnedSdkDispatchResult>;
  };
};
/** No production adapter accepts this mock callback. It is available only on an explicitly
 * synthetic-enabled server store, never from a request body or application route. */
export type ProviderGenerationMockTransport = {
  provenance: "synthetic-test";
  send: (request: ProviderObservationPrepared) => Promise<void>;
};
export type ProviderGenerationDispatchRecord = ProviderGenerationDispatchIdentity & {
  state: "committed";
  preparedEventDigest: string;
  dispatchEventDigest: string;
  recordedAt: string;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
};
export type ProviderGenerationSimulationResult = {
  record: ProviderGenerationDispatchRecord;
  newlyCommitted: boolean;
  replayed: boolean;
  delivery: "already-recorded" | "not-sent" | "mock-send-returned" | "send-result-unobserved";
  responsePersisted: false;
  automaticRetryAllowed: false;
};
export type ProviderReviewMockTransport = ProviderGenerationMockTransport;
/** Historical evidence of persistence, never a sending capability. */
export type ProviderReviewDispatchRecord = ProviderReviewDispatchIdentity & {
  state: "committed";
  preparedInputDigest: string;
  dispatchInputDigest: string;
  preparedEventDigest: string;
  dispatchEventDigest: string;
  requestDigest: string;
  requestArtifactSha256: string;
  revision: 7;
  recordedAt: string;
  reviewPersisted: true;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderReviewSimulationResult = Omit<ProviderGenerationSimulationResult, "record"> & {
  record: ProviderReviewDispatchRecord;
};
export type ProviderSdkSimulationResult<Record> = {
  record: Record;
  newlyCommitted: boolean;
  replayed: boolean;
  transport: ProviderOwnedSdkDispatchResult | null;
  responsePersisted: false;
  automaticRetryAllowed: false;
};
const fail = (code: string, status = 409): never => {
  throw new StudioError(
    "AI 전송 기록과 실행 조건을 확인하지 못했습니다. 자동 재전송하지 않습니다.",
    status,
    `QUALITY_PROVIDER_DISPATCH_${code}`,
  );
};
const same = (a: unknown, b: unknown) => digest(a) === digest(b);

/** Native generation/review dispatch and separate response capture. The NEW dispatch plan stays
 * inside the invocation that observed COMMIT.
 * Neither a returned record nor lookup/replay can reconstruct ownership. The separate response
 * boundary preserves captured evidence without issuing another send. Real transport remains gated. */
export class ProviderGenerationDispatchStore {
  #productionScopes = new WeakMap<object, ProviderGenerationDispatchIdentity>();
  readonly #context: Context;
  constructor(context: Context) {
    if (
      context.productionExecution &&
      (context.synthetic ||
        context.sdkTestNetwork ||
        !isProviderProductionExecution(context.productionExecution, context.productionRuntime))
    )
      throw Error("PROVIDER_PRODUCTION_EXECUTION_INVALID");
    this.#context = Object.freeze(context);
  }
  #productionInput(
    permit: object | undefined,
    operation: ProviderProductionOperation,
    raw: unknown,
  ) {
    const original = permit && this.#productionScopes.get(permit);
    if (!original || !this.#context.productionExecution || this.#context.synthetic)
      return fail("PRODUCTION_SCOPE_REQUIRED");
    return scopeProviderProductionOperation(original, operation, raw);
  }
  /** Read-only identity resolution from the same native archive audit as execution. A later
   * writer must still recheck all current conditions; this read creates no send ownership. */
  resolveProductionIdentity(raw: unknown): ProviderGenerationDispatchIdentity {
    const selection = providerProductionSelectionSchema.parse(raw);
    return this.#context.transaction(() => {
      const before = this.inspect(),
        state = before.audit.reservationArchive.ledger;
      const snapshot = state.provider.snapshots.find((row) => row.run.id === selection.runId);
      const binding = before.audit.records.find((row) => row.runId === selection.runId);
      if (
        !snapshot ||
        !binding ||
        snapshot.archiveFormatVersion !== 3 ||
        snapshot.run.environment !== "production" ||
        snapshot.run.runDigest !== selection.runDigest ||
        binding.recordDigest !== selection.approvalBindingDigest ||
        snapshot.revision < 1
      )
        return fail("PRODUCTION_APPROVAL_REQUIRED");
      if (snapshot.revision === 1) {
        const identity = providerInitialProductionIdentity(selection);
        if (this.historical(before, identity)) return fail("PRODUCTION_SCOPE_CHANGED");
        return identity;
      }
      const receipts = state.provider.receipts.filter((row) => row.runId === selection.runId);
      const prepared = receipts.filter(
        (row) => row.kind === "provider-prepared" && row.runRevision === 2,
      );
      const dispatched = receipts.filter(
        (row) => row.kind === "provider-dispatch" && row.runRevision === 3,
      );
      if (snapshot.revision < 3 || prepared.length !== 1 || dispatched.length !== 1)
        return fail("PRODUCTION_SCOPE_CHANGED");
      const identity = freezeProviderValue(
        providerGenerationDispatchIdentitySchema.parse({
          ...selection,
          preparedRequestId: prepared[0].clientRequestId,
          dispatchRequestId: dispatched[0].clientRequestId,
        }),
      );
      if (!this.historical(before, identity)) return fail("PRODUCTION_SCOPE_CHANGED");
      return identity;
    });
  }
  /** One audited read, available without a production runtime. Never resolves a new nonce,
   * continues a run, prepares/records a phase or constructs an SDK. */
  productionStatus(raw: unknown) {
    const selection = providerProductionInspectionInputSchema.parse(raw);
    return this.#context.transaction(() => {
      const before = this.inspect();
      const snapshot = before.audit.reservationArchive.ledger.provider.snapshots.find(
        (row) => row.run.id === selection.runId,
      );
      const binding = before.audit.records.find((row) => row.runId === selection.runId);
      if (
        !snapshot ||
        !binding ||
        snapshot.archiveFormatVersion !== 3 ||
        snapshot.run.environment !== "production" ||
        snapshot.run.runDigest !== selection.runDigest ||
        snapshot.revision < 1
      )
        return fail("PRODUCTION_APPROVAL_REQUIRED");
      return projectAuditedProviderProductionStatus(
        { ...selection, approvalBindingDigest: binding.recordDigest },
        snapshot,
      );
    });
  }
  #openProductionScope(raw: unknown) {
    if (!this.#context.productionExecution || this.#context.synthetic)
      return fail("PRODUCTION_DISABLED");
    const identity = freezeProviderValue(providerGenerationDispatchIdentitySchema.parse(raw));
    this.#context.transaction(() => {
      const before = this.inspect(),
        snapshot = before.audit.reservationArchive.ledger.provider.snapshots.find(
          (row) => row.run.id === identity.runId,
        );
      const binding = before.audit.records.find(
        (row) =>
          row.runId === identity.runId && row.recordDigest === identity.approvalBindingDigest,
      );
      if (
        !snapshot ||
        !binding ||
        snapshot.run.environment !== "production" ||
        snapshot.archiveFormatVersion !== 3 ||
        snapshot.run.runDigest !== identity.runDigest ||
        snapshot.revision < 1
      )
        return fail("PRODUCTION_APPROVAL_REQUIRED");
      const history = this.historical(before, identity);
      if (snapshot.revision !== 1 && !history) return fail("PRODUCTION_SCOPE_CHANGED");
    });
    // No permit or mutable port is returned to the caller. Its lifetime is one server invocation.
    const permit = Object.freeze({});
    this.#productionScopes.set(permit, identity);
    const checkId = (id: string) => {
      if (id !== identity.runId) return fail("PRODUCTION_SCOPE_CHANGED");
    };
    const port: ProviderApprovedRunnerStore = {
      providerGet: (id, revision) => {
        checkId(id);
        return this.#context.get(id, revision);
      },
      providerArtifact: (id, key) => {
        checkId(id);
        return this.#context.artifact(id, key);
      },
      providerGenerationDispatchLookup: (value) => this.lookup(value),
      providerGenerationResponseLookup: (value) => this.responseLookup(value),
      providerGenerationValidationLookup: (value) => this.generationValidationLookup(value),
      providerGenerationStopLookup: (value) => this.generationStopLookup(value),
      providerPrepareGenerationValidation: (value) => this.prepareGenerationValidation(value),
      providerRecordGenerationResponse: (value) => this.recordResponse(value, permit),
      providerRecordGenerationValidation: (value) => this.recordGenerationValidation(value, permit),
      providerRecordGenerationStop: (value) => this.recordGenerationStop(value, permit),
      providerReviewDispatchLookup: (value) => this.reviewDispatchLookup(value),
      providerReviewResponseLookup: (value) => this.reviewResponseLookup(value),
      providerReviewValidationLookup: (value) => this.reviewValidationLookup(value),
      providerReviewStopLookup: (value) => this.reviewStopLookup(value),
      providerFinalizationLookup: (value) => this.finalizationLookup(value),
      providerPrepareReviewValidation: (value) => this.prepareReviewValidation(value),
      providerPrepareFinalization: (value) => this.prepareFinalization(value),
      providerRecordReviewResponse: (value) => this.recordReviewResponse(value, permit),
      providerRecordReviewValidation: (value) => this.recordReviewValidation(value, permit),
      providerRecordReviewStop: (value) => this.recordReviewStop(value, permit),
      providerRecordFinalization: (value) => this.recordFinalization(value, permit),
    };
    return { identity, permit, port };
  }
  async executeProduction(raw: unknown): Promise<ProviderApprovedRunnerResult> {
    const scope = this.#openProductionScope(raw);
    try {
      return await runQualityProviderApprovedContinuation(
        scope.port,
        scope.identity,
        (value) => this.#productionGeneration(value, scope.permit),
        (value) => this.#productionReview(value, scope.permit),
      );
    } finally {
      this.#productionScopes.delete(scope.permit);
    }
  }
  recoverProductionGeneration(raw: unknown) {
    const capture = captureGenerationResponseInput(raw),
      scope = this.#openProductionScope(capture.dispatch);
    try {
      const input = this.#productionInput(scope.permit, "generation-response", capture);
      return recoverQualityProviderGenerationCapture(scope.port, input);
    } finally {
      this.#productionScopes.delete(scope.permit);
    }
  }
  recoverProductionReview(raw: unknown) {
    const capture = captureReviewResponseInput(raw),
      scope = this.#openProductionScope(capture.dispatch.generation.dispatch);
    try {
      const input = this.#productionInput(scope.permit, "review-response", capture);
      return recoverQualityProviderReviewCapture(scope.port, input);
    } finally {
      this.#productionScopes.delete(scope.permit);
    }
  }
  async #productionGeneration(
    raw: unknown,
    permit: object,
  ): Promise<ProviderSdkSimulationResult<ProviderGenerationDispatchRecord>> {
    const identity = providerGenerationDispatchIdentitySchema.parse(
      this.#productionInput(permit, "generation-send", raw),
    );
    const execution = this.#context.productionExecution!;
    const committed = this.#commit(identity, execution.assertCurrent),
      plan = committed.plan;
    return {
      record: committed.record,
      newlyCommitted: plan !== null,
      replayed: plan === null,
      transport: plan
        ? await execution.dispatch(plan.request, (start) =>
            this.#sendWhileOwnedCurrent(identity, plan, start),
          )
        : null,
      responsePersisted: false,
      automaticRetryAllowed: false,
    };
  }
  async #productionReview(
    raw: unknown,
    permit: object,
  ): Promise<ProviderSdkSimulationResult<ProviderReviewDispatchRecord>> {
    const identity = providerReviewDispatchIdentitySchema.parse(
      this.#productionInput(permit, "review-send", raw),
    );
    const execution = this.#context.productionExecution!;
    const committed = this.#commitReview(identity, execution.assertCurrent),
      plan = committed.plan;
    return {
      record: committed.record,
      newlyCommitted: plan !== null,
      replayed: plan === null,
      transport: plan
        ? await execution.dispatch(plan.request, (start) =>
            this.#sendReviewWhileOwnedCurrent(identity, plan, start),
          )
        : null,
      responsePersisted: false,
      automaticRetryAllowed: false,
    };
  }
  /** Read-only snapshot, never new COMMIT ownership or permission to write/send.
   * A future production writer must rebuild the plan and perform its final checks under lock. */
  productionReadiness(raw: unknown) {
    const blocked = (reason: string) =>
      freezeProviderValue({
        status: "blocked" as const,
        reason,
        dispatchAllowed: false as const,
        recordingAllowed: false as const,
        budgetWriteAllowed: false as const,
      });
    const parsed = providerGenerationDispatchIdentitySchema.safeParse(raw);
    if (!parsed.success) return blocked("invalid-input");
    const identity = freezeProviderValue(parsed.data);
    const runtime = inspectProviderProductionRuntime(this.#context.productionRuntime);
    if (runtime.status !== "configured") return blocked("runtime-unavailable");
    return this.#context.transaction(() => {
      const before = this.inspect();
      const prepared = prepareProviderGenerationDispatch({
        identity,
        inspectedAt: new Date().toISOString(),
        configuration: getProviderConfigurationProposal(),
        archive: before.input,
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (inspectProviderProductionRuntime(this.#context.productionRuntime).status !== "configured")
        return blocked("runtime-unavailable");
      if (prepared.status !== "prepared") return blocked(prepared.reason);
      const plan = prepared.plan;
      return freezeProviderValue({
        status: "ready-for-writer-check" as const,
        identity,
        runtime,
        inspectedAt: plan.inspectedAt,
        expiresAt: plan.expiresAt,
        planDigest: plan.planDigest,
        basis: plan.basis,
        request: plan.request.request,
        ownership: "new-commit-owner-required" as const,
        dispatchAllowed: false as const,
        recordingAllowed: false as const,
        budgetWriteAllowed: false as const,
      });
    });
  }
  /** Dedicated constructor-configured synthetic SDK path. No transport, key, model or
   * capability can be supplied in the command. Historical reads never create a driver. */
  async simulateSdk(
    raw: unknown,
  ): Promise<ProviderSdkSimulationResult<ProviderGenerationDispatchRecord>> {
    if (!this.#context.synthetic || !this.#context.sdkTestNetwork)
      return fail("SDK_SIMULATION_DISABLED");
    const identity = freezeProviderValue(providerGenerationDispatchIdentitySchema.parse(raw));
    const committed = this.#commit(identity);
    const plan = committed.plan;
    return {
      record: committed.record,
      newlyCommitted: plan !== null,
      replayed: plan === null,
      transport: plan
        ? await dispatchOwnedProviderSdkTest(plan.request, this.#context.sdkTestNetwork, (start) =>
            this.#sendWhileOwnedCurrent(identity, plan, start),
          )
        : null,
      responsePersisted: false,
      automaticRetryAllowed: false,
    };
  }
  async simulateReviewSdk(
    raw: unknown,
  ): Promise<ProviderSdkSimulationResult<ProviderReviewDispatchRecord>> {
    if (!this.#context.synthetic || !this.#context.sdkTestNetwork)
      return fail("REVIEW_SDK_SIMULATION_DISABLED");
    const identity = freezeProviderValue(providerReviewDispatchIdentitySchema.parse(raw));
    const committed = this.#commitReview(identity);
    const plan = committed.plan;
    return {
      record: committed.record,
      newlyCommitted: plan !== null,
      replayed: plan === null,
      transport: plan
        ? await dispatchOwnedProviderSdkTest(plan.request, this.#context.sdkTestNetwork, (start) =>
            this.#sendReviewWhileOwnedCurrent(identity, plan, start),
          )
        : null,
      responsePersisted: false,
      automaticRetryAllowed: false,
    };
  }
  private inspect() {
    try {
      const usage = inspectQualityDatabaseUsage(this.#context.db);
      const input = {
        archive: {
          ledger: readLedgerDatabaseInput(this.#context.db, this.#context.registry),
          ...readProviderReservationDatabaseRows(this.#context.db),
        },
        ...readProviderTransmissionApprovalDatabaseRows(this.#context.db),
      };
      const audit = inspectVersionedProviderTransmissionApprovalArchive(input);
      const additionalUsedBytes =
        usage.usedBytes -
        audit.reservationArchive.ledger.usedBytes -
        audit.reservationArchive.usedBytes -
        audit.usedBytes;
      if (!Number.isSafeInteger(additionalUsedBytes) || additionalUsedBytes < 0)
        throw new Error("Invalid capacity");
      return { input, audit, additionalUsedBytes };
    } catch {
      return fail("STORAGE_CORRUPT");
    }
  }
  private historical(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderGenerationDispatchIdentity,
  ): ProviderGenerationDispatchRecord | null {
    const state = before.audit.reservationArchive.ledger;
    const ids = [identity.preparedRequestId, identity.dispatchRequestId];
    if (ids[0] === ids[1]) return fail("NONCE_CONFLICT");
    const occupied = [
      ...state.provider.receipts.map((row) => row.clientRequestId),
      ...state.legacy.receipts.map((row) => row.clientRequestId),
      ...state.policy.records.map((row) => row.clientRequestId),
      ...(before.input.archive.ledger.otherNonces ?? []),
    ];
    if (!ids.some((id) => occupied.includes(id))) return null;
    const prepared = state.provider.receipts.find((row) => row.clientRequestId === ids[0]);
    const dispatch = state.provider.receipts.find((row) => row.clientRequestId === ids[1]);
    const binding = before.audit.records.find((row) => row.runId === identity.runId);
    const snapshot = state.provider.snapshots.find((row) => row.run.id === identity.runId);
    if (
      !prepared ||
      !dispatch ||
      !binding ||
      !snapshot ||
      (snapshot.archiveFormatVersion !== 3 && snapshot.archiveFormatVersion !== 5) ||
      binding.recordDigest !== identity.approvalBindingDigest ||
      snapshot.run.runDigest !== identity.runDigest ||
      prepared.kind !== "provider-prepared" ||
      dispatch.kind !== "provider-dispatch" ||
      prepared.runId !== identity.runId ||
      dispatch.runId !== identity.runId ||
      prepared.runRevision !== 2 ||
      dispatch.runRevision !== 3
    )
      return fail("NONCE_CONFLICT");
    const pe = snapshot.events[1],
      de = snapshot.events[2];
    if (
      pe?.payload.kind !== "request-prepared" ||
      pe.payload.phase !== "generation" ||
      de?.payload.kind !== "dispatch-intent" ||
      de.payload.phase !== "generation" ||
      pe.eventDigest !== prepared.operationDigest ||
      de.eventDigest !== dispatch.operationDigest ||
      pe.recordedAt !== de.recordedAt ||
      de.payload.approvalEventDigest !== binding.approvalEventDigest
    )
      return fail("NONCE_CONFLICT");
    return freezeProviderValue({
      ...identity,
      state: "committed",
      preparedEventDigest: pe.eventDigest,
      dispatchEventDigest: de.eventDigest,
      recordedAt: de.recordedAt,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
    });
  }
  lookup(raw: unknown) {
    const identity = providerGenerationDispatchIdentitySchema.parse(raw);
    return this.#context.transaction(
      () => this.historical(this.inspect(), identity) ?? { state: "not-observed" as const },
    );
  }
  private responseBasis(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    input: ProviderGenerationResponseInput,
  ) {
    if (!this.historical(before, input.dispatch)) return fail("RESPONSE_DISPATCH_REQUIRED");
    const state = before.audit.reservationArchive.ledger;
    const snapshot = state.provider.snapshots.find((row) => row.run.id === input.dispatch.runId);
    if (
      !snapshot ||
      (snapshot.archiveFormatVersion !== 3 && snapshot.archiveFormatVersion !== 5) ||
      snapshot.run.environment !== "production"
    )
      return fail("RESPONSE_DISPATCH_REQUIRED");
    return { state, snapshot };
  }
  private responseHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    input: ProviderGenerationResponseInput,
  ): ProviderGenerationResponseRecord | null {
    const { state, snapshot } = this.responseBasis(before, input);
    const receipt = state.provider.receipts.find(
      (row) => row.clientRequestId === input.responseRequestId,
    );
    const response = snapshot.events.find(
      (row) => row.payload.kind === "response-received" && row.payload.phase === "generation",
    );
    const occupied =
      state.legacy.receipts.some((row) => row.clientRequestId === input.responseRequestId) ||
      state.policy.records.some((row) => row.clientRequestId === input.responseRequestId) ||
      (before.input.archive.ledger.otherNonces ?? []).includes(input.responseRequestId);
    if (!receipt && !response && !occupied) return null;
    if (
      occupied ||
      !receipt ||
      !response ||
      response.payload.kind !== "response-received" ||
      receipt.kind !== "provider-response" ||
      receipt.runId !== snapshot.run.id ||
      receipt.runRevision !== response.revision ||
      receipt.operationDigest !== response.eventDigest
    )
      return fail("RESPONSE_CONFLICT");
    const command = versionedGenerationResponseCommand(input, snapshot, response.revision - 1);
    if (
      receipt.inputDigest !==
      (snapshot.archiveFormatVersion === 5
        ? versionedProviderExecutionOperationDigest
        : providerExecutionOperationDigest)(snapshot.run.id, command)
    )
      return fail("RESPONSE_CONFLICT");
    return freezeProviderValue({
      state: "committed",
      dispatch: input.dispatch,
      responseRequestId: input.responseRequestId,
      inputDigest: receipt.inputDigest,
      responseEventDigest: response.eventDigest,
      responseArtifactSha256: response.payload.artifactSha256,
      revision: response.revision,
      recordedAt: response.recordedAt,
      usageAssessment: response.payload.usageAssessment,
      usageBudgetEventDigest: response.payload.usageBudgetEventDigest,
      responsePersisted: true,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
    });
  }
  responseLookup(raw: unknown) {
    const input = captureGenerationResponseInput(raw);
    return this.#context.transaction(
      () => this.responseHistory(this.inspect(), input) ?? { state: "not-observed" as const },
    );
  }
  prepareReviewResponse(capture: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderReviewResponse({
        capture,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  prepareFinalization(identity: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderFinalization({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  private finalizationHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderFinalizationIdentity,
  ): ProviderFinalizationRecord | null {
    const validation = this.reviewValidationHistory(before, identity.validation);
    if (!validation) return fail("FINALIZATION_VALIDATION_REQUIRED");
    if (validation.validationEventDigest !== identity.validationEventDigest)
      return fail("FINALIZATION_VALIDATION_CONFLICT");
    const state = before.audit.reservationArchive.ledger,
      id = identity.validation.dispatch.generation.dispatch.runId,
      snapshot = state.provider.snapshots.find((row) => row.run.id === id),
      receipt = state.provider.receipts.find(
        (row) => row.clientRequestId === identity.finalizationRequestId,
      ),
      event = snapshot?.events.find(
        (row) => row.payload.kind === "execution-stopped" && row.payload.outcome === "completed",
      ),
      artifact = state.provider.artifacts.find(
        (row) => row.runId === id && row.key === "final-result",
      ),
      occupied =
        [...state.legacy.receipts, ...state.policy.records].some(
          (row) => row.clientRequestId === identity.finalizationRequestId,
        ) ||
        (before.input.archive.ledger.otherNonces ?? []).includes(identity.finalizationRequestId);
    // A different failure terminal event is not a completed request. New writes will be
    // refused by the planner, while lookup accurately reports no completion for this nonce.
    if (!receipt && !event && !artifact && !occupied) return null;
    if (
      occupied ||
      !receipt ||
      !event ||
      !artifact ||
      !snapshot ||
      snapshot.archiveFormatVersion !== 3 ||
      snapshot.run.environment !== "production" ||
      !snapshot.terminal ||
      snapshot.state !== "completed" ||
      snapshot.revision !== 10 ||
      event.payload.kind !== "execution-stopped" ||
      event.payload.outcome !== "completed" ||
      event.revision !== 10 ||
      event.previousEventDigest !== identity.validationEventDigest ||
      event.payload.failureCode !== null ||
      event.payload.releasedBudgetEventDigests.length !== 0 ||
      event.payload.finalArtifactSha256 !== artifact.sha256 ||
      receipt.kind !== "provider-finish" ||
      receipt.runId !== id ||
      receipt.runRevision !== 10 ||
      receipt.operationDigest !== event.eventDigest
    )
      return fail("FINALIZATION_CONFLICT");
    const command: ProviderExecutionCommand<"execution-stopped"> = {
      clientRequestId: identity.finalizationRequestId,
      expectedRevision: 9,
      artifact,
      payload: {
        kind: "execution-stopped",
        outcome: "completed",
        failureCode: null,
        finalArtifactSha256: artifact.sha256,
      },
    };
    if (receipt.inputDigest !== providerExecutionOperationDigest(id, command))
      return fail("FINALIZATION_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        ...identity,
        state: "committed" as const,
        inputDigest: receipt.inputDigest,
        completionEventDigest: event.eventDigest,
        finalArtifactSha256: artifact.sha256,
        finalArtifactSizeBytes: artifact.sizeBytes,
        generationArtifactSha256: validation.generationArtifactSha256,
        reviewArtifactSha256: validation.validatedArtifactSha256,
        revision: 10 as const,
        recordedAt: event.recordedAt,
        completionPersisted: true as const,
        finalResultPersisted: true as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  finalizationLookup(raw: unknown) {
    const identity = freezeProviderValue(providerFinalizationIdentitySchema.parse(raw));
    return this.#context.transaction(
      () =>
        this.finalizationHistory(this.inspect(), identity) ?? { state: "not-observed" as const },
    );
  }
  /** Synthetic-only atomic completion. Historical recovery always precedes today's plan,
   * including after an uncertain COMMIT; no cost event, send or final-body regeneration. */
  recordFinalization(raw: unknown, permit?: object): ProviderFinalizationCommitResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("FINALIZATION_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "finalization", raw);
    }
    const identity = freezeProviderValue(providerFinalizationIdentitySchema.parse(raw));
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.finalizationHistory(before, identity);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const prepared = prepareProviderFinalization({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `FINALIZATION_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { artifact, event, receipt } = prepared.plan.rows;
      this.#context.capacity(0);
      this.#context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(
          artifact.runId,
          artifact.key,
          Buffer.from(artifact.body, "utf8"),
          artifact.sha256,
          artifact.sizeBytes,
        );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.finalizationHistory(this.inspect(), identity);
      if (!record || record.completionEventDigest !== event.eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  prepareReviewValidation(identity: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderReviewValidation({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  private reviewValidationHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderReviewValidationIdentity,
  ): ProviderReviewValidationRecord | null {
    if (!this.reviewHistory(before, identity.dispatch))
      return fail("REVIEW_VALIDATION_DISPATCH_REQUIRED");
    const state = before.audit.reservationArchive.ledger,
      id = identity.dispatch.generation.dispatch.runId,
      snapshot = state.provider.snapshots.find((row) => row.run.id === id),
      response = snapshot?.events.find(
        (row) => row.payload.kind === "response-received" && row.payload.phase === "review",
      ),
      responseReceipt = state.provider.receipts.find(
        (row) => row.clientRequestId === identity.responseRequestId,
      );
    if (
      !snapshot ||
      snapshot.archiveFormatVersion !== 3 ||
      snapshot.run.environment !== "production" ||
      response?.payload.kind !== "response-received" ||
      ![8, 9].includes(response.revision) ||
      response.eventDigest !== identity.responseEventDigest ||
      !responseReceipt ||
      responseReceipt.kind !== "provider-response" ||
      responseReceipt.runId !== id ||
      responseReceipt.runRevision !== response.revision ||
      responseReceipt.operationDigest !== response.eventDigest
    )
      return fail("REVIEW_VALIDATION_RESPONSE_CONFLICT");
    const receipt = state.provider.receipts.find(
        (row) => row.clientRequestId === identity.validationRequestId,
      ),
      event = snapshot.events.find(
        (row) => row.payload.kind === "domain-validated" && row.payload.phase === "review",
      ),
      artifact = state.provider.artifacts.find(
        (row) => row.runId === id && row.key === "review-validated",
      ),
      occupied =
        [...state.legacy.receipts, ...state.policy.records].some(
          (row) => row.clientRequestId === identity.validationRequestId,
        ) || (before.input.archive.ledger.otherNonces ?? []).includes(identity.validationRequestId);
    if (!receipt && !event && !artifact && !occupied) return null;
    if (
      occupied ||
      !receipt ||
      !event ||
      !artifact ||
      event.payload.kind !== "domain-validated" ||
      response.revision !== 8 ||
      event.revision !== 9 ||
      event.previousEventDigest !== response.eventDigest ||
      event.payload.responseEventDigest !== response.eventDigest ||
      event.payload.requestDigest !== response.payload.requestDigest ||
      event.payload.artifactSha256 !== artifact.sha256 ||
      receipt.kind !== "provider-validated" ||
      receipt.runId !== id ||
      receipt.runRevision !== 9 ||
      receipt.operationDigest !== event.eventDigest
    )
      return fail("REVIEW_VALIDATION_CONFLICT");
    const initial = state.provider.artifacts.find(
      (row) => row.runId === id && row.key === "generation-validated",
    );
    if (!initial) return fail("REVIEW_VALIDATION_CONFLICT");
    // The full audit binds all stored response/validation bytes to original native commands.
    // Recover r9 from that evidence even after completion; never run today's domain/finalizer.
    const command: ProviderExecutionCommand<"domain-validated"> = {
      clientRequestId: identity.validationRequestId,
      expectedRevision: 8,
      artifact,
      payload: event.payload,
    };
    if (receipt.inputDigest !== providerExecutionOperationDigest(id, command))
      return fail("REVIEW_VALIDATION_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        ...identity,
        state: "committed" as const,
        inputDigest: receipt.inputDigest,
        generationArtifactSha256: initial.sha256,
        responseArtifactSha256: response.payload.artifactSha256,
        validationEventDigest: event.eventDigest,
        validatedArtifactSha256: artifact.sha256,
        outputDigest: event.payload.outputDigest,
        revision: 9 as const,
        recordedAt: event.recordedAt,
        validationPersisted: true as const,
        finalResultPersisted: false as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  reviewValidationLookup(raw: unknown) {
    const identity = freezeProviderValue(providerReviewValidationIdentitySchema.parse(raw));
    return this.#context.transaction(
      () =>
        this.reviewValidationHistory(this.inspect(), identity) ?? {
          state: "not-observed" as const,
        },
    );
  }
  /** Synthetic-only r9 write. An uncertain COMMIT is recovered by the same identity, without
   * revalidation, finalization, budget recognition or another send. */
  recordReviewValidation(raw: unknown, permit?: object): ProviderReviewValidationCommitResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("REVIEW_VALIDATION_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "review-validation", raw);
    }
    const identity = freezeProviderValue(providerReviewValidationIdentitySchema.parse(raw));
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.reviewValidationHistory(before, identity);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const prepared = prepareProviderReviewValidation({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `REVIEW_VALIDATION_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { artifact, event, receipt } = prepared.plan.rows;
      this.#context.capacity(0);
      this.#context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(
          artifact.runId,
          artifact.key,
          Buffer.from(artifact.body, "utf8"),
          artifact.sha256,
          artifact.sizeBytes,
        );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.reviewValidationHistory(this.inspect(), identity);
      if (!record || record.validationEventDigest !== event.eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  private reviewResponseHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    capture: ProviderReviewResponseCapture,
  ): ProviderReviewResponseRecord | null {
    if (!this.reviewHistory(before, capture.dispatch))
      return fail("REVIEW_RESPONSE_DISPATCH_REQUIRED");
    const state = before.audit.reservationArchive.ledger,
      id = capture.dispatch.generation.dispatch.runId,
      snapshot = state.provider.snapshots.find((row) => row.run.id === id);
    if (
      !snapshot ||
      snapshot.archiveFormatVersion !== 3 ||
      snapshot.run.environment !== "production"
    )
      return fail("REVIEW_RESPONSE_DISPATCH_REQUIRED");
    const receipt = state.provider.receipts.find(
        (row) => row.clientRequestId === capture.responseRequestId,
      ),
      response = snapshot.events.find(
        (row) => row.payload.kind === "response-received" && row.payload.phase === "review",
      ),
      artifact = state.provider.artifacts.find(
        (row) => row.runId === id && row.key === "review-response",
      );
    const occupied =
      [...state.legacy.receipts, ...state.policy.records].some(
        (row) => row.clientRequestId === capture.responseRequestId,
      ) || (before.input.archive.ledger.otherNonces ?? []).includes(capture.responseRequestId);
    if (!receipt && !response && !artifact && !occupied) return null;
    if (
      occupied ||
      !receipt ||
      !response ||
      !artifact ||
      response.payload.kind !== "response-received" ||
      receipt.kind !== "provider-response" ||
      receipt.runId !== id ||
      receipt.runRevision !== response.revision ||
      receipt.operationDigest !== response.eventDigest ||
      ![8, 9].includes(response.revision)
    )
      return fail("REVIEW_RESPONSE_CONFLICT");
    // Historical recovery uses the original prefix revision, including after a late capture or
    // subsequent terminal/validation events. No current plan, clock, policy or configuration.
    const command = reviewResponseCommand(capture, snapshot, response.revision - 1);
    if (
      receipt.inputDigest !== providerExecutionOperationDigest(id, command) ||
      !same(artifact, command.artifact) ||
      response.payload.artifactSha256 !== artifact.sha256
    )
      return fail("REVIEW_RESPONSE_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        state: "committed" as const,
        dispatch: capture.dispatch,
        responseRequestId: capture.responseRequestId,
        inputDigest: receipt.inputDigest,
        responseEventDigest: response.eventDigest,
        responseArtifactSha256: artifact.sha256,
        revision: response.revision,
        recordedAt: response.recordedAt,
        late: response.revision === 9,
        usageAssessment: response.payload.usageAssessment,
        usageBudgetEventDigest: response.payload.usageBudgetEventDigest,
        responsePersisted: true as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  reviewResponseLookup(raw: unknown) {
    const capture = captureReviewResponseInput(raw);
    return this.#context.transaction(
      () =>
        this.reviewResponseHistory(this.inspect(), capture) ?? { state: "not-observed" as const },
    );
  }
  recordReviewResponse(raw: unknown, permit?: object): ProviderReviewResponseCommitResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("REVIEW_RESPONSE_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "review-response", raw);
    }
    // Capture before acquiring the transaction so caller-owned SDK objects cannot change the
    // persisted bytes during planning. Neither this boundary nor its recovery sends anything.
    const capture = captureReviewResponseInput(raw);
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.reviewResponseHistory(before, capture);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const prepared = prepareProviderReviewResponse({
        capture,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `REVIEW_RESPONSE_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { artifact, usageEvent, event, receipt } = prepared.plan.rows;
      this.#context.capacity(0);
      this.#context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(
          artifact.runId,
          artifact.key,
          Buffer.from(artifact.body, "utf8"),
          artifact.sha256,
          artifact.sizeBytes,
        );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      if (usageEvent)
        insert(
          "quality_actual_budget_events",
          { scope_id: usageEvent.scopeId, revision: usageEvent.revision },
          usageEvent,
        );
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.reviewResponseHistory(this.inspect(), capture);
      if (!record || record.responseEventDigest !== event.eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  prepareReviewDispatch(identity: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderReviewDispatch({
        identity,
        archive: before.input,
        configuration: getProviderConfigurationProposal(),
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  prepareGenerationValidation(identity: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderGenerationValidation({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  prepareReviewStop(identity: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderReviewStop({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  private reviewStopHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderReviewStopIdentity,
  ): ProviderReviewStopRecord | null {
    if (!this.reviewHistory(before, identity.dispatch))
      return fail("REVIEW_STOP_DISPATCH_REQUIRED");
    const state = before.audit.reservationArchive.ledger,
      id = identity.dispatch.generation.dispatch.runId,
      snapshot = state.provider.snapshots.find((row) => row.run.id === id);
    if (
      !snapshot ||
      snapshot.archiveFormatVersion !== 3 ||
      snapshot.run.environment !== "production"
    )
      return fail("REVIEW_STOP_DISPATCH_REQUIRED");
    const observation = identity.observation,
      expectedRevision = observation.kind === "unobserved" ? 8 : 9;
    if (observation.kind === "response") {
      const response = snapshot.events[7],
        receipt = state.provider.receipts.find(
          (row) => row.clientRequestId === observation.responseRequestId,
        );
      if (
        response?.payload.kind !== "response-received" ||
        response.payload.phase !== "review" ||
        response.eventDigest !== observation.responseEventDigest ||
        !receipt ||
        receipt.kind !== "provider-response" ||
        receipt.runId !== id ||
        receipt.runRevision !== 8 ||
        receipt.operationDigest !== response.eventDigest
      )
        return fail("REVIEW_STOP_OBSERVATION_CONFLICT");
    }
    const event = snapshot.events.find((row) => row.payload.kind === "execution-stopped"),
      receipt = state.provider.receipts.find(
        (row) => row.clientRequestId === identity.stopRequestId,
      ),
      occupied =
        state.legacy.receipts.some((row) => row.clientRequestId === identity.stopRequestId) ||
        state.policy.records.some((row) => row.clientRequestId === identity.stopRequestId) ||
        (before.input.archive.ledger.otherNonces ?? []).includes(identity.stopRequestId);
    if (!event && !receipt && !occupied) return null;
    if (
      occupied ||
      !event ||
      event.payload.kind !== "execution-stopped" ||
      event.revision !== expectedRevision ||
      !receipt ||
      receipt.kind !== "provider-finish" ||
      receipt.runId !== id ||
      receipt.runRevision !== expectedRevision ||
      receipt.operationDigest !== event.eventDigest ||
      receipt.recordedAt !== event.recordedAt ||
      receipt.budgetRevision !== event.budgetRevision ||
      receipt.scopeId !== snapshot.run.preparation.budget.scopeId ||
      event.payload.finalArtifactSha256 !== null ||
      event.payload.releasedBudgetEventDigests.length !== 0
    )
      return fail("REVIEW_STOP_CONFLICT");
    const payload = event.payload,
      outcome = payload.outcome;
    if (
      (observation.kind === "unobserved" &&
        (outcome !== "result-unobserved" || payload.failureCode !== "INTERRUPTED")) ||
      (observation.kind === "response" &&
        !(
          (outcome === "needs-cost-review" && payload.failureCode === "COST_UNSETTLED") ||
          (outcome === "bound-breached" && payload.failureCode === "BOUND_BREACHED") ||
          (outcome === "output-invalid" && payload.failureCode === "OUTPUT_INVALID")
        )) ||
      outcome === "completed" ||
      outcome === "before-dispatch"
    )
      return fail("REVIEW_STOP_CONFLICT");
    // Only reconstruct the original command and budget prefix. Never reclassify using current code.
    const command: ProviderExecutionCommand<"execution-stopped"> = {
      clientRequestId: identity.stopRequestId,
      expectedRevision: expectedRevision - 1,
      payload: {
        kind: "execution-stopped",
        outcome,
        failureCode: payload.failureCode,
        finalArtifactSha256: null,
      },
    };
    if (receipt.inputDigest !== providerExecutionOperationDigest(id, command))
      return fail("REVIEW_STOP_CONFLICT");
    const budget = getProviderExecutionBudgetSnapshot(
        state.provider.budgetEvents.filter(
          (row) => row.scopeId === receipt.scopeId && row.revision <= event.budgetRevision,
        ),
        receipt.scopeId,
      ),
      own = budget.reservations.find((row) => row.runId === id),
      generation = own?.phases.find((row) => row.phase === "generation"),
      review = own?.phases.find((row) => row.phase === "review");
    if (!generation || !review || !generation.settled || generation.heldUnits !== "0")
      return fail("REVIEW_STOP_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        ...identity,
        state: "committed" as const,
        inputDigest: receipt.inputDigest,
        stopEventDigest: event.eventDigest,
        revision: expectedRevision,
        budgetRevision: budget.revision,
        budgetHeadDigest: budget.headDigest,
        outcome,
        recordedAt: event.recordedAt,
        generationHeldUnitsAtStop: generation.heldUnits,
        reviewHeldUnitsAtStop: review.heldUnits,
        recognizedUnitsAtStop: budget.recognizedUnits,
        stopPersisted: true as const,
        finalResultPersisted: false as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  reviewStopLookup(raw: unknown) {
    const identity = freezeProviderValue(
      structuredClone(providerReviewStopIdentitySchema.parse(raw)),
    );
    return this.#context.transaction(
      () => this.reviewStopHistory(this.inspect(), identity) ?? { state: "not-observed" as const },
    );
  }
  /** Synthetic-only atomic stop; cannot cancel an already dispatched remote request. */
  recordReviewStop(raw: unknown, permit?: object): ProviderReviewStopCommitResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("REVIEW_STOP_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "review-stop", raw);
    }
    const identity = freezeProviderValue(
      structuredClone(providerReviewStopIdentitySchema.parse(raw)),
    );
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.reviewStopHistory(before, identity);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const prepared = prepareProviderReviewStop({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `REVIEW_STOP_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { event, receipt } = prepared.plan.rows;
      this.#context.capacity(0);
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.reviewStopHistory(this.inspect(), identity);
      if (
        !record ||
        record.stopEventDigest !== event.eventDigest ||
        record.inputDigest !== receipt.inputDigest
      )
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  prepareGenerationStop(identity: unknown) {
    return this.#context.transaction(() => {
      const before = this.inspect();
      return prepareProviderGenerationStop({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
    });
  }
  private stopHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderGenerationStopIdentity,
  ): ProviderGenerationStopRecord | null {
    if (!this.historical(before, identity.dispatch)) return fail("STOP_DISPATCH_REQUIRED");
    const state = before.audit.reservationArchive.ledger,
      snapshot = state.provider.snapshots.find((row) => row.run.id === identity.dispatch.runId);
    if (
      !snapshot ||
      snapshot.archiveFormatVersion !== 3 ||
      snapshot.run.environment !== "production"
    )
      return fail("STOP_DISPATCH_REQUIRED");
    const observation = identity.observation,
      expectedRevision = observation.kind === "unobserved" ? 4 : 5;
    if (observation.kind === "response") {
      const response = snapshot.events[3],
        receipt = state.provider.receipts.find(
          (row) => row.clientRequestId === observation.responseRequestId,
        );
      if (
        response?.payload.kind !== "response-received" ||
        response.payload.phase !== "generation" ||
        response.eventDigest !== observation.responseEventDigest ||
        !receipt ||
        receipt.kind !== "provider-response" ||
        receipt.runId !== snapshot.run.id ||
        receipt.runRevision !== 4 ||
        receipt.operationDigest !== response.eventDigest
      )
        return fail("STOP_OBSERVATION_CONFLICT");
    }
    const event = snapshot.events.find((row) => row.payload.kind === "execution-stopped"),
      receipt = state.provider.receipts.find(
        (row) => row.clientRequestId === identity.stopRequestId,
      ),
      occupied =
        state.legacy.receipts.some((row) => row.clientRequestId === identity.stopRequestId) ||
        state.policy.records.some((row) => row.clientRequestId === identity.stopRequestId) ||
        (before.input.archive.ledger.otherNonces ?? []).includes(identity.stopRequestId);
    if (!event && !receipt && !occupied) return null;
    if (
      occupied ||
      !event ||
      event.payload.kind !== "execution-stopped" ||
      event.revision !== expectedRevision ||
      !receipt ||
      receipt.kind !== "provider-finish" ||
      receipt.runId !== snapshot.run.id ||
      receipt.runRevision !== expectedRevision ||
      receipt.operationDigest !== event.eventDigest ||
      receipt.recordedAt !== event.recordedAt ||
      receipt.budgetRevision !== event.budgetRevision ||
      event.payload.finalArtifactSha256 !== null ||
      event.payload.releasedBudgetEventDigests.length !== 1
    )
      return fail("STOP_CONFLICT");
    const payload = event.payload,
      outcome = payload.outcome;
    if (
      (observation.kind === "unobserved" &&
        (outcome !== "result-unobserved" || payload.failureCode !== "INTERRUPTED")) ||
      (observation.kind === "response" &&
        !(
          (outcome === "needs-cost-review" && payload.failureCode === "COST_UNSETTLED") ||
          (outcome === "bound-breached" && payload.failureCode === "BOUND_BREACHED") ||
          (outcome === "output-invalid" && payload.failureCode === "OUTPUT_INVALID")
        )) ||
      outcome === "completed" ||
      outcome === "before-dispatch"
    )
      return fail("STOP_CONFLICT");
    const release = state.provider.budgetEvents.find(
      (row) => row.eventDigest === payload.releasedBudgetEventDigests[0],
    );
    if (
      !release ||
      release.payload.kind !== "release-phase" ||
      release.payload.phase !== "review" ||
      release.payload.reason !== "not-dispatched" ||
      release.payload.runId !== snapshot.run.id ||
      release.payload.reservationDigest !== snapshot.run.reservationDigest ||
      release.eventId !== identity.stopRequestId ||
      release.revision !== event.budgetRevision ||
      release.recordedAt !== event.recordedAt ||
      release.scopeId !== receipt.scopeId ||
      release.scopeId !== snapshot.run.preparation.budget.scopeId
    )
      return fail("STOP_CONFLICT");
    // Rebuild only the original native command, never today's classification or late-response state.
    const command: ProviderExecutionCommand<"execution-stopped"> = {
      clientRequestId: identity.stopRequestId,
      expectedRevision: expectedRevision - 1,
      payload: {
        kind: "execution-stopped",
        outcome,
        failureCode: payload.failureCode,
        finalArtifactSha256: null,
      },
    };
    if (receipt.inputDigest !== providerExecutionOperationDigest(snapshot.run.id, command))
      return fail("STOP_CONFLICT");
    const budget = getProviderExecutionBudgetSnapshot(
        state.provider.budgetEvents.filter(
          (row) => row.scopeId === release.scopeId && row.revision <= release.revision,
        ),
        release.scopeId,
      ),
      generation = budget.reservations
        .find((row) => row.runId === snapshot.run.id)
        ?.phases.find((row) => row.phase === "generation");
    if (!generation) return fail("STOP_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        ...identity,
        state: "committed" as const,
        inputDigest: receipt.inputDigest,
        stopEventDigest: event.eventDigest,
        releaseEventDigest: release.eventDigest,
        revision: expectedRevision,
        budgetRevision: release.revision,
        outcome,
        recordedAt: event.recordedAt,
        generationHeldUnitsAtStop: generation.heldUnits,
        recognizedUnitsAtStop: budget.recognizedUnits,
        reviewReleasedUnits: release.payload.releasedUnits,
        stopPersisted: true as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  generationStopLookup(raw: unknown) {
    const identity = providerGenerationStopIdentitySchema.parse(raw);
    return this.#context.transaction(
      () => this.stopHistory(this.inspect(), identity) ?? { state: "not-observed" as const },
    );
  }
  /** Synthetic-only atomic stop. Cannot abort a provider request already in flight. */
  recordGenerationStop(raw: unknown, permit?: object): ProviderGenerationStopCommitResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("STOP_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "generation-stop", raw);
    }
    const identity = providerGenerationStopIdentitySchema.parse(raw);
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.stopHistory(before, identity);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const prepared = prepareProviderGenerationStop({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `STOP_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { budgetEvent, event, receipt } = prepared.plan.rows;
      this.#context.capacity(0);
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert(
        "quality_actual_budget_events",
        { scope_id: budgetEvent.scopeId, revision: budgetEvent.revision },
        budgetEvent,
      );
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.stopHistory(this.inspect(), identity);
      if (
        !record ||
        record.stopEventDigest !== event.eventDigest ||
        record.releaseEventDigest !== budgetEvent.eventDigest
      )
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  private validationHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderGenerationValidationIdentity,
  ): ProviderGenerationValidationRecord | null {
    if (!this.historical(before, identity.dispatch)) return fail("VALIDATION_DISPATCH_REQUIRED");
    const state = before.audit.reservationArchive.ledger;
    const snapshot = state.provider.snapshots.find((row) => row.run.id === identity.dispatch.runId);
    const response = snapshot?.events[3];
    const responseReceipt = state.provider.receipts.find(
      (row) => row.clientRequestId === identity.responseRequestId,
    );
    if (
      !snapshot ||
      snapshot.archiveFormatVersion !== 3 ||
      snapshot.run.environment !== "production" ||
      response?.payload.kind !== "response-received" ||
      response.payload.phase !== "generation" ||
      response.eventDigest !== identity.responseEventDigest ||
      !responseReceipt ||
      responseReceipt.kind !== "provider-response" ||
      responseReceipt.runId !== snapshot.run.id ||
      responseReceipt.runRevision !== 4 ||
      responseReceipt.operationDigest !== response.eventDigest
    )
      return fail("VALIDATION_RESPONSE_CONFLICT");
    const receipt = state.provider.receipts.find(
      (row) => row.clientRequestId === identity.validationRequestId,
    );
    const event = snapshot.events.find(
      (row) => row.payload.kind === "domain-validated" && row.payload.phase === "generation",
    );
    const occupied =
      state.legacy.receipts.some((row) => row.clientRequestId === identity.validationRequestId) ||
      state.policy.records.some((row) => row.clientRequestId === identity.validationRequestId) ||
      (before.input.archive.ledger.otherNonces ?? []).includes(identity.validationRequestId);
    if (!receipt && !event && !occupied) return null;
    if (
      occupied ||
      !receipt ||
      !event ||
      event.payload.kind !== "domain-validated" ||
      event.revision !== 5 ||
      event.payload.responseEventDigest !== response.eventDigest ||
      receipt.kind !== "provider-validated" ||
      receipt.runId !== snapshot.run.id ||
      receipt.runRevision !== 5 ||
      receipt.operationDigest !== event.eventDigest
    )
      return fail("VALIDATION_CONFLICT");
    const artifact = state.provider.artifacts.find(
      (row) => row.runId === snapshot.run.id && row.key === "generation-validated",
    );
    if (!artifact || artifact.sha256 !== event.payload.artifactSha256)
      return fail("VALIDATION_CONFLICT");
    // Reconstruct the original native command from audited, frozen evidence. Replay must not
    // invoke today's domain validator, review builder, configuration, clock or budget decision.
    const command: ProviderExecutionCommand<"domain-validated"> = {
      clientRequestId: identity.validationRequestId,
      expectedRevision: 4,
      artifact,
      payload: event.payload,
    };
    if (receipt.inputDigest !== providerExecutionOperationDigest(snapshot.run.id, command))
      return fail("VALIDATION_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        ...identity,
        state: "committed" as const,
        inputDigest: receipt.inputDigest,
        responseArtifactSha256: response.payload.artifactSha256,
        validationEventDigest: event.eventDigest,
        validatedArtifactSha256: artifact.sha256,
        outputDigest: event.payload.outputDigest,
        revision: 5 as const,
        recordedAt: event.recordedAt,
        validationPersisted: true as const,
        reviewPrepared: false as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  generationValidationLookup(raw: unknown) {
    const identity = providerGenerationValidationIdentitySchema.parse(raw);
    return this.#context.transaction(
      () => this.validationHistory(this.inspect(), identity) ?? { state: "not-observed" as const },
    );
  }
  private reviewHistory(
    before: ReturnType<ProviderGenerationDispatchStore["inspect"]>,
    identity: ProviderReviewDispatchIdentity,
  ): ProviderReviewDispatchRecord | null {
    const validation = this.validationHistory(before, identity.generation);
    if (!validation || validation.validationEventDigest !== identity.validationEventDigest)
      return fail("REVIEW_VALIDATION_REQUIRED");
    const state = before.audit.reservationArchive.ledger,
      id = identity.generation.dispatch.runId;
    const snapshot = state.provider.snapshots.find((row) => row.run.id === id);
    if (!snapshot || snapshot.archiveFormatVersion !== 3) return fail("REVIEW_VALIDATION_REQUIRED");
    const ids = [identity.preparedRequestId, identity.dispatchRequestId];
    if (ids[0] === ids[1]) return fail("REVIEW_CONFLICT");
    const occupied = [...state.provider.receipts, ...state.legacy.receipts, ...state.policy.records]
      .map((row) => row.clientRequestId)
      .concat(before.input.archive.ledger.otherNonces ?? []);
    const pe = snapshot.events.find(
      (row) => row.payload.kind === "request-prepared" && row.payload.phase === "review",
    );
    const de = snapshot.events.find(
      (row) => row.payload.kind === "dispatch-intent" && row.payload.phase === "review",
    );
    const artifact = state.provider.artifacts.find(
      (row) => row.runId === id && row.key === "review-request",
    );
    if (!pe && !de && !artifact && !ids.some((nonce) => occupied.includes(nonce))) return null;
    const pr = state.provider.receipts.find((row) => row.clientRequestId === ids[0]);
    const dr = state.provider.receipts.find((row) => row.clientRequestId === ids[1]);
    if (
      !pe ||
      !de ||
      !artifact ||
      !pr ||
      !dr ||
      pe.payload.kind !== "request-prepared" ||
      de.payload.kind !== "dispatch-intent" ||
      pe.revision !== 6 ||
      de.revision !== 7 ||
      pe.recordedAt !== de.recordedAt ||
      pr.kind !== "provider-prepared" ||
      dr.kind !== "provider-dispatch" ||
      pr.runId !== id ||
      dr.runId !== id ||
      pr.runRevision !== 6 ||
      dr.runRevision !== 7 ||
      pr.operationDigest !== pe.eventDigest ||
      dr.operationDigest !== de.eventDigest ||
      pe.payload.artifactSha256 !== artifact.sha256 ||
      de.payload.preparedEventDigest !== pe.eventDigest ||
      !same(pe.payload.derivedFrom, {
        generationEventDigest: validation.validationEventDigest,
        artifactSha256: validation.validatedArtifactSha256,
        outputDigest: validation.outputDigest,
      })
    )
      return fail("REVIEW_CONFLICT");
    // Reconstruct original native commands from audited rows, without today's planner/clock/config.
    const prepared: ProviderExecutionCommand<"request-prepared"> = {
      clientRequestId: ids[0],
      expectedRevision: 5,
      artifact,
      payload: pe.payload,
    };
    const dispatch: ProviderExecutionCommand<"dispatch-intent"> = {
      clientRequestId: ids[1],
      expectedRevision: 6,
      payload: de.payload,
    };
    if (
      pr.inputDigest !== providerExecutionOperationDigest(id, prepared) ||
      dr.inputDigest !== providerExecutionOperationDigest(id, dispatch)
    )
      return fail("REVIEW_CONFLICT");
    return freezeProviderValue(
      structuredClone({
        ...identity,
        state: "committed" as const,
        preparedInputDigest: pr.inputDigest,
        dispatchInputDigest: dr.inputDigest,
        preparedEventDigest: pe.eventDigest,
        dispatchEventDigest: de.eventDigest,
        requestDigest: pe.payload.requestDigest,
        requestArtifactSha256: artifact.sha256,
        revision: 7 as const,
        recordedAt: de.recordedAt,
        reviewPersisted: true as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
        automaticRetryAllowed: false as const,
      }),
    );
  }
  reviewDispatchLookup(raw: unknown) {
    const identity = providerReviewDispatchIdentitySchema.parse(raw);
    return this.#context.transaction(
      () => this.reviewHistory(this.inspect(), identity) ?? { state: "not-observed" as const },
    );
  }
  #commitReview(identity: ProviderReviewDispatchIdentity, checkNew?: () => void) {
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.reviewHistory(before, identity);
      if (previous) return { record: previous, plan: null };
      checkNew?.();
      const prepared = prepareProviderReviewDispatch({
        identity,
        archive: before.input,
        configuration: getProviderConfigurationProposal(),
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `REVIEW_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const plan = prepared.plan,
        artifact = plan.rows.artifact;
      this.#context.capacity(0); // All five rows consume the original native storage reservation.
      this.#context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(
          artifact.runId,
          artifact.key,
          Buffer.from(artifact.body, "utf8"),
          artifact.sha256,
          artifact.sizeBytes,
        );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      for (const [index, event] of plan.rows.events.entries()) {
        insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
        const receipt = plan.rows.receipts[index];
        insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      }
      const record = this.reviewHistory(this.inspect(), identity);
      if (!record || record.dispatchEventDigest !== plan.rows.events[1].eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, plan };
    }, true);
  }
  #sendReviewWhileOwnedCurrent(
    identity: ProviderReviewDispatchIdentity,
    plan: ProviderReviewDispatchPlan,
    start: () => void,
  ) {
    this.#context.transaction(() => {
      const before = this.inspect(),
        history = this.reviewHistory(before, identity),
        id = identity.generation.dispatch.runId;
      const state = before.audit.reservationArchive.ledger;
      const snapshot = state.provider.snapshots.find((row) => row.run.id === id);
      const artifact = state.provider.artifacts.find(
        (row) => row.runId === id && row.key === "review-request",
      );
      if (
        !history ||
        history.dispatchEventDigest !== plan.rows.events[1].eventDigest ||
        !snapshot ||
        snapshot.archiveFormatVersion !== 3 ||
        snapshot.terminal ||
        snapshot.revision !== 7 ||
        snapshot.state !== "dispatching" ||
        snapshot.events.length !== 7 ||
        !same(snapshot.events.slice(5), plan.rows.events) ||
        !same(artifact, plan.rows.artifact)
      )
        return fail("REVIEW_OWNER_CHANGED");
      const inspectedAt = new Date().toISOString(),
        now = Date.parse(inspectedAt);
      if (now < Date.parse(plan.inspectedAt) || now >= Date.parse(plan.expiresAt))
        return fail("REVIEW_SCOPE_EXPIRED");
      const current = createProviderTransmissionReview({
        selection: { runId: id, runDigest: identity.generation.dispatch.runDigest },
        inspectedAt,
        configuration: getProviderConfigurationProposal(),
        archive: before.input.archive,
      });
      if (current.status !== "review") return fail("REVIEW_SCOPE_CHANGED");
      const review = current.review;
      const binding = before.audit.records.find(
        (row) => row.recordDigest === identity.generation.dispatch.approvalBindingDigest,
      );
      // Generation is already settled. Review alone must retain its entire original hold.
      if (
        !binding ||
        !review.facts.policyUnchanged ||
        !review.facts.budgetCompatible ||
        !review.facts.budgetWithinBound ||
        !review.reservation.generationSettled ||
        review.reservation.generationHeldUnits !== "0" ||
        review.reservation.reviewSettled ||
        review.reservation.reviewHeldUnits !== review.reservation.reviewUnits ||
        review.configurationDigest !== plan.basis.configurationDigest ||
        review.reservation.bindingDigest !== binding.approvedReview.reservation.bindingDigest ||
        !same(review.manifest, binding.approvedReview.manifest) ||
        !same(review.request, binding.approvedReview.request) ||
        !same(review.retention, binding.approvedReview.retention) ||
        now >= Date.parse(binding.approvedReview.expiresAt) ||
        history.requestArtifactSha256 !== plan.request.request.artifactSha256 ||
        history.requestDigest !== plan.request.request.requestDigest ||
        artifact?.body !== plan.request.rawBody ||
        JSON.stringify(plan.request.body) !== plan.request.rawBody
      )
        return fail("REVIEW_SCOPE_CHANGED");
      this.#context.capacity(0);
      const sendingAt = Date.now();
      if (
        sendingAt < now ||
        sendingAt >= Date.parse(plan.expiresAt) ||
        sendingAt >= Date.parse(review.expiresAt)
      )
        return fail("REVIEW_SCOPE_EXPIRED");
      start(); // Reserve DELETE/WAL writer slot through initiation, never await under this lock.
    }, true);
  }
  async simulateReview(
    raw: unknown,
    transport: ProviderReviewMockTransport,
  ): Promise<ProviderReviewSimulationResult> {
    if (
      !this.#context.synthetic ||
      !transport ||
      transport.provenance !== "synthetic-test" ||
      typeof transport.send !== "function" ||
      Object.keys(transport).sort().join(",") !== "provenance,send"
    )
      return fail("REVIEW_SIMULATION_DISABLED");
    const send = transport.send,
      identity = providerReviewDispatchIdentitySchema.parse(raw);
    // Only this invocation observing a NEW successful COMMIT retains the local plan.
    const committed = this.#commitReview(identity);
    const result = (
      delivery: ProviderReviewSimulationResult["delivery"],
    ): ProviderReviewSimulationResult => ({
      record: committed.record,
      newlyCommitted: committed.plan !== null,
      replayed: committed.plan === null,
      delivery,
      responsePersisted: false,
      automaticRetryAllowed: false,
    });
    if (!committed.plan) return result("already-recorded");
    let started = false,
      completion: Promise<void> | null = null;
    try {
      this.#sendReviewWhileOwnedCurrent(identity, committed.plan, () => {
        started = true;
        completion = Promise.resolve(send(committed.plan!.request));
        void completion.catch(() => undefined);
      });
    } catch {
      return result(started ? "send-result-unobserved" : "not-sent");
    }
    try {
      await completion;
      return result("mock-send-returned");
    } catch {
      return result("send-result-unobserved");
    }
  }
  /** Synthetic-only atomic validation. Successful persistence never prepares or sends review. */
  recordGenerationValidation(
    raw: unknown,
    permit?: object,
  ): ProviderGenerationValidationCommitResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("VALIDATION_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "generation-validation", raw);
    }
    const identity = providerGenerationValidationIdentitySchema.parse(raw);
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.validationHistory(before, identity);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const prepared = prepareProviderGenerationValidation({
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      });
      if (prepared.status !== "prepared")
        return fail(
          `VALIDATION_${prepared.reason.replaceAll("-", "_").toUpperCase()}`,
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const { artifact, event, receipt } = prepared.plan.rows;
      this.#context.capacity(0); // Consumes only the previously reserved native artifact/row slots.
      this.#context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(
          artifact.runId,
          artifact.key,
          Buffer.from(artifact.body, "utf8"),
          artifact.sha256,
          artifact.sizeBytes,
        );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.validationHistory(this.inspect(), identity);
      if (!record || record.validationEventDigest !== event.eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  /** Separate from sending: an uncertain commit is recovered with this exact captured response.
   * No current configuration/expiry check may discard evidence of an already initiated request.
   * For now only explicit synthetic-enabled stores can write; no HTTP or SDK adapter exposes it. */
  recordResponse(raw: unknown, permit?: object): ProviderGenerationResponseResult {
    if (!this.#context.synthetic) {
      if (!permit) return fail("RESPONSE_RECORDING_DISABLED");
      raw = this.#productionInput(permit, "generation-response", raw);
    }
    const input = captureGenerationResponseInput(raw);
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.responseHistory(before, input);
      if (previous) return { record: previous, newlyCommitted: false, replayed: true };
      const { state, snapshot } = this.responseBasis(before, input);
      const last = snapshot.events.at(-1);
      const late =
        snapshot.revision === 4 &&
        last?.payload.kind === "execution-stopped" &&
        last.payload.outcome === "result-unobserved";
      if (!late && (snapshot.revision !== 3 || snapshot.state !== "dispatching"))
        return fail("RESPONSE_PREFIX_CHANGED");
      const approval = snapshot.events[0];
      if (approval.payload.kind !== "transmission-approved") return fail("STORAGE_CORRUPT");
      const command = versionedGenerationResponseCommand(input, snapshot, snapshot.revision);
      const assessment = assessProviderUsage({
        response: input.response,
        policy: approval.payload.manifest.executionContract.usagePolicy,
        financialBasis: snapshot.run.preparation.financialBasis,
        phase: "generation",
      });
      const budget = state.provider.budgets.find(
        (row) => row.scopeId === snapshot.run.preparation.budget.scopeId,
      );
      if (!budget || !budget.currency || budget.unitScale === null) return fail("STORAGE_CORRUPT");
      const recognition = providerUsageRecognitionPayload(
        snapshot.run,
        "generation",
        command.payload.dispatchEventDigest,
        command.artifact!.sha256,
        assessment,
      );
      const recordedAt = new Date().toISOString();
      const usageEvent = recognition
        ? createProviderExecutionBudgetEvent({
            schemaVersion: 2,
            scopeId: budget.scopeId,
            environment: snapshot.run.environment,
            provenance: snapshot.run.approval.provenance,
            revision: budget.revision + 1,
            previousDigest: budget.headDigest,
            eventId: input.responseRequestId,
            recordedAt,
            currency: budget.currency,
            unitScale: budget.unitScale,
            payload: recognition,
          })
        : null;
      const eventInput = {
        schemaVersion: 2 as const,
        runId: snapshot.run.id,
        revision: snapshot.revision + 1,
        budgetRevision: usageEvent?.revision ?? budget.revision,
        previousEventDigest: last!.eventDigest,
        recordedAt,
        payload: {
          ...command.payload,
          usageAssessment: assessment,
          usageBudgetEventDigest: usageEvent?.eventDigest ?? null,
        },
      };
      const event =
        snapshot.archiveFormatVersion === 5
          ? createVersionedProviderExecutionEvent({ ...eventInput, executionContractVersion: 2 })
          : createProviderExecutionEvent({ ...eventInput, executionContractVersion: 1 });
      const receipt = createProviderExecutionReceipt({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        kind: "provider-response",
        clientRequestId: input.responseRequestId,
        inputDigest: (snapshot.archiveFormatVersion === 5
          ? versionedProviderExecutionOperationDigest
          : providerExecutionOperationDigest)(snapshot.run.id, command),
        runId: snapshot.run.id,
        runRevision: event.revision,
        budgetRevision: event.budgetRevision,
        operationDigest: event.eventDigest,
        recordedAt,
      });
      const artifact = command.artifact!;
      this.#context.capacity(0); // Native storage and event slots were reserved before dispatch.
      this.#context.db
        .prepare(
          "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
        )
        .run(
          artifact.runId,
          artifact.key,
          Buffer.from(artifact.body, "utf8"),
          artifact.sha256,
          artifact.sizeBytes,
        );
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      if (usageEvent)
        insert(
          "quality_actual_budget_events",
          { scope_id: usageEvent.scopeId, revision: usageEvent.revision },
          usageEvent,
        );
      insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
      insert("quality_actual_requests", { nonce: receipt.clientRequestId }, receipt);
      const record = this.responseHistory(this.inspect(), input);
      if (!record || record.responseEventDigest !== event.eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, newlyCommitted: true, replayed: false };
    }, true);
  }
  #commit(
    identity: ProviderGenerationDispatchIdentity,
    checkNew?: () => void,
    mockVersioned = false,
  ) {
    return this.#context.transaction(() => {
      const before = this.inspect(),
        previous = this.historical(before, identity);
      if (previous) return { record: previous, plan: null };
      checkNew?.();
      const current = {
        identity,
        archive: before.input,
        inspectedAt: new Date().toISOString(),
        additionalUsedBytes: before.additionalUsedBytes,
      };
      const prepared = this.#context.selection
        ? this.#context.selection.prepareGenerationDispatch(current)
        : prepareProviderGenerationDispatch({
            ...current,
            configuration: getProviderConfigurationProposal(),
          });
      if (prepared.status !== "prepared")
        return fail(
          prepared.reason.replaceAll("-", "_").toUpperCase(),
          prepared.reason === "capacity-exceeded" ? 413 : 409,
        );
      const plan = prepared.plan;
      // Versioned SDK ownership/continuation is not yet connected. Only the explicit
      // synthetic callback path can commit a new v2 dispatch in this unit.
      if (plan.planVersion === 2 && (!mockVersioned || !this.#context.synthetic))
        return fail("NATIVE_VERSION_UNSUPPORTED");
      this.#context.capacity(0); // All four rows consume already reserved native storage/slots.
      const insert = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
        const columns = [...Object.keys(keys), "body", "body_hash"];
        this.#context.db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(keys), JSON.stringify(value), digest(value));
      };
      for (const [index, event] of plan.rows.events.entries()) {
        insert("quality_actual_events", { run_id: event.runId, revision: event.revision }, event);
        insert(
          "quality_actual_requests",
          { nonce: plan.rows.receipts[index].clientRequestId },
          plan.rows.receipts[index],
        );
      }
      const record = this.historical(this.inspect(), identity);
      if (!record || record.dispatchEventDigest !== plan.rows.events[1].eventDigest)
        return fail("STORAGE_CORRUPT");
      this.#context.capacity(0);
      return { record, plan };
    }, true);
  }
  #sendWhileOwnedCurrent(
    identity: ProviderGenerationDispatchIdentity,
    plan: ProviderGenerationDispatchPlan | VersionedProviderGenerationDispatchPlan,
    start: () => void,
  ) {
    this.#context.transaction(() => {
      const before = this.inspect(),
        history = this.historical(before, identity);
      const snapshot = before.audit.reservationArchive.ledger.provider.snapshots.find(
        (row) => row.run.id === identity.runId,
      );
      if (
        !history ||
        history.dispatchEventDigest !== plan.rows.events[1].eventDigest ||
        !snapshot ||
        snapshot.archiveFormatVersion !== (plan.planVersion === 2 ? 5 : 3) ||
        snapshot.revision !== 3 ||
        snapshot.state !== "dispatching" ||
        snapshot.events.length !== 3 ||
        !same(snapshot.events.slice(1), plan.rows.events)
      )
        return fail("OWNER_CHANGED");
      const inspectedAt = new Date().toISOString(),
        now = Date.parse(inspectedAt);
      if (now < Date.parse(plan.inspectedAt) || now >= Date.parse(plan.expiresAt))
        return fail("SCOPE_EXPIRED");
      const current = {
        selection: { runId: identity.runId, runDigest: identity.runDigest },
        inspectedAt,
        archive: before.input.archive,
      };
      const result = this.#context.selection
        ? this.#context.selection.transmissionReview(current)
        : createProviderTransmissionReview({
            ...current,
            configuration: getProviderConfigurationProposal(),
          });
      if (result.status !== "review") return fail("SCOPE_CHANGED");
      const review = result.review,
        binding = before.audit.records.find(
          (row) => row.recordDigest === identity.approvalBindingDigest,
        );
      if (
        !binding ||
        !review.facts.policyUnchanged ||
        !review.facts.reservationIntact ||
        !review.facts.budgetCompatible ||
        !review.facts.budgetWithinBound ||
        review.configurationDigest !== plan.basis.configurationDigest ||
        !same(review.manifest, binding.approvedReview.manifest) ||
        !same(review.request, binding.approvedReview.request) ||
        !same(review.request.generation.body, plan.request.body) ||
        review.request.generation.sha256 !== plan.request.request.artifactSha256 ||
        JSON.stringify(review.request.generation.body) !== plan.request.rawBody
      )
        return fail("SCOPE_CHANGED");
      this.#context.capacity(0);
      // Auditing itself can cross the deadline. Sample the clock again immediately before send.
      const sendingAt = Date.now();
      if (sendingAt < now || sendingAt >= Date.parse(plan.expiresAt)) return fail("SCOPE_EXPIRED");
      // Reserve the writer slot even though this final transaction adds no rows. This closes
      // the check/initiation gap in both DELETE and WAL journaling. Never await under lock.
      start();
    }, true);
  }
  async simulate(
    raw: unknown,
    transport: ProviderGenerationMockTransport,
  ): Promise<ProviderGenerationSimulationResult> {
    if (
      !this.#context.synthetic ||
      !transport ||
      transport.provenance !== "synthetic-test" ||
      typeof transport.send !== "function" ||
      Object.keys(transport).sort().join(",") !== "provenance,send"
    )
      return fail("SIMULATION_DISABLED");
    const send = transport.send,
      identity = providerGenerationDispatchIdentitySchema.parse(raw);
    // A thrown COMMIT (even if SQLite committed) cannot escape with a plan or reach send.
    const committed = this.#commit(identity, undefined, true);
    const result = (
      delivery: ProviderGenerationSimulationResult["delivery"],
    ): ProviderGenerationSimulationResult => ({
      record: committed.record,
      newlyCommitted: committed.plan !== null,
      replayed: committed.plan === null,
      delivery,
      responsePersisted: false,
      automaticRetryAllowed: false,
    });
    if (!committed.plan) return result("already-recorded");
    let started = false;
    let completion: Promise<void> | null = null;
    try {
      this.#sendWhileOwnedCurrent(identity, committed.plan, () => {
        started = true;
        completion = Promise.resolve(send(committed.plan!.request));
        // A read COMMIT may fail after initiation. Keep rejection observed even in that branch.
        void completion.catch(() => undefined);
      });
    } catch {
      return result(started ? "send-result-unobserved" : "not-sent");
    }
    // The lock has been released before waiting. Ownership never leaves this invocation.
    try {
      await completion;
      return result("mock-send-returned");
    } catch {
      return result("send-result-unobserved");
    }
  }
}
