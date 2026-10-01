import type { PlanContent, ReviewFinding } from "./studio-schema";
import type {
  ProviderRun,
  ProviderScope,
  ProviderEnvironment,
  ProviderPreparation,
  ProviderReservationArtifact,
  ProviderReservationBudgetEvent,
  ProviderReservationReceipt,
} from "./studio-plan-quality-provider-types";
import type {
  ProviderUsagePolicy,
  ProviderResponseMetadata,
  ProviderUsageAssessment,
} from "../../scripts/local-data-quality-provider-usage.mjs";

export type ProviderPhase = "generation" | "review";
export type ProviderExecutionArtifactKey =
  | "generation-request"
  | "generation-response"
  | "generation-validated"
  | "review-request"
  | "review-response"
  | "review-validated"
  | "final-result";
export type ProviderExecutionArtifact = Omit<ProviderReservationArtifact, "key"> & {
  key: ProviderExecutionArtifactKey;
};
export type ProviderExecutionContract = {
  version: 1;
  mode: "synthetic-test" | "provider";
  requestContractDigest: string;
  usagePolicy: ProviderUsagePolicy;
  usagePolicyDigest: string;
  responseSchemaVersion: 1;
  domainValidationVersion: 1;
  limits: {
    requestBytes: 2097152;
    responseBytes: 4194304;
    validatedBytes: 2097152;
    finalBytes: 4194304;
    totalArtifactBytes: 20971520;
  };
  maxCalls: 2;
  maxRetries: 0;
  contractDigest: string;
};
export type ProviderTransmissionManifest = {
  schemaVersion: 1;
  runDigest: string;
  preparationDigest: string;
  executionContract: ProviderExecutionContract;
  manifestDigest: string;
};
/** Explicit v2 manifest; not accepted by the frozen v1 approval/event schemas. */
export type VersionedProviderExecutionContract = Omit<ProviderExecutionContract, "version"> & {
  version: 2;
  engineVersion: "plan-observation-v2";
  nativeRunFormat: 3;
};
export type VersionedProviderTransmissionManifest = Omit<
  ProviderTransmissionManifest,
  "schemaVersion" | "executionContract"
> & {
  schemaVersion: 2;
  executionContract: VersionedProviderExecutionContract;
};
export type ProviderTransmissionApproval = {
  kind: "transmission-approved";
  manifest: ProviderTransmissionManifest;
  provenance: "explicit-user" | "synthetic-test";
  approvedAt: string;
  expiresAt: string;
  acknowledgedExternalTransmission: true;
  acknowledgedGenerationAndDerivedReview: true;
  acknowledgedRetentionNoticeDigest: string;
  acknowledgedFinancialReservationNotTokenFit: true;
  acknowledgedUnknownCostHoldAndNoRetry: true;
  budgetRevision: number;
  budgetDigest: string;
};
export type ProviderExecutionOutput =
  { kind: "plan"; content: PlanContent } | { kind: "review"; findings: ReviewFinding[] };
export type ProviderExecutionPayload =
  | ProviderTransmissionApproval
  | {
      kind: "request-prepared";
      phase: ProviderPhase;
      requestDigest: string;
      artifactSha256: string;
      derivedFrom: {
        generationEventDigest: string;
        artifactSha256: string;
        outputDigest: string;
      } | null;
      budgetRevision: number;
      budgetDigest: string;
    }
  | {
      kind: "dispatch-intent";
      phase: ProviderPhase;
      requestDigest: string;
      artifactSha256: string;
      preparedEventDigest: string;
      approvalEventDigest: string;
      budgetRevision: number;
      budgetDigest: string;
    }
  | {
      kind: "response-received";
      phase: ProviderPhase;
      requestDigest: string;
      dispatchEventDigest: string;
      artifactSha256: string;
      metadata: ProviderResponseMetadata;
      usageAssessment: ProviderUsageAssessment;
      usageBudgetEventDigest: string | null;
    }
  | {
      kind: "domain-validated";
      phase: ProviderPhase;
      requestDigest: string;
      responseEventDigest: string;
      artifactSha256: string;
      outputDigest: string;
    }
  | {
      kind: "execution-stopped";
      outcome:
        | "completed"
        | "before-dispatch"
        | "result-unobserved"
        | "needs-cost-review"
        | "output-invalid"
        | "bound-breached";
      failureCode:
        | "INTERRUPTED"
        | "STORAGE_FAILED"
        | "OUTPUT_INVALID"
        | "COST_UNSETTLED"
        | "BOUND_BREACHED"
        | null;
      finalArtifactSha256: string | null;
      releasedBudgetEventDigests: string[];
    };
export type ProviderExecutionEvent = {
  schemaVersion: 2;
  executionContractVersion: 1;
  runId: string;
  revision: number;
  budgetRevision: number;
  previousEventDigest: string | null;
  recordedAt: string;
  payload: ProviderExecutionPayload;
  eventDigest: string;
};
export type ProviderExecutionBudgetPayload =
  | {
      kind: "recognize-usage";
      runId: string;
      phase: ProviderPhase;
      reservationDigest: string;
      dispatchEventDigest: string;
      responseArtifactSha256: string;
      usageAssessmentDigest: string;
      recognizedUnits: string;
      consumedHeldUnits: string;
      releasedHeldUnits: string;
      boundExcessUnits: string;
      violations: string[];
    }
  | {
      kind: "release-phase";
      runId: string;
      phase: ProviderPhase;
      reservationDigest: string;
      releasedUnits: string;
      reason: "not-dispatched";
    };
export type ProviderExecutionBudgetEvent = Omit<ProviderReservationBudgetEvent, "payload"> & {
  payload: ProviderExecutionBudgetPayload;
};
export type ProviderExecutionReceipt = Omit<
  ProviderReservationReceipt,
  "kind" | "runId" | "runRevision"
> & {
  kind:
    | "provider-approve"
    | "provider-prepared"
    | "provider-dispatch"
    | "provider-response"
    | "provider-validated"
    | "provider-finish";
  runId: string;
  runRevision: number;
};
type CommandPayload =
  | Exclude<ProviderExecutionPayload, { kind: "response-received" } | { kind: "execution-stopped" }>
  | Omit<
      Extract<ProviderExecutionPayload, { kind: "response-received" }>,
      "usageAssessment" | "usageBudgetEventDigest"
    >
  | Omit<
      Extract<ProviderExecutionPayload, { kind: "execution-stopped" }>,
      "releasedBudgetEventDigests"
    >;
export type ProviderExecutionCommand<
  K extends ProviderExecutionPayload["kind"] = ProviderExecutionPayload["kind"],
> = K extends ProviderExecutionPayload["kind"]
  ? {
      clientRequestId: string;
      expectedRevision: number;
      payload: Extract<CommandPayload, { kind: K }>;
      artifact?: ProviderExecutionArtifact;
    }
  : never;
export type ProviderExecutionBudgetSnapshot = {
  scopeId: ProviderScope;
  environment: ProviderEnvironment;
  revision: number;
  headDigest: string | null;
  currency: string | null;
  unitScale: number | null;
  capUnits: string;
  heldUnits: string;
  recognizedUnits: string;
  availableUnits: string;
  deficitUnits: string;
  boundBreached: boolean;
  reservations: Array<{
    runId: string;
    reservationDigest: string;
    generationUnits: string;
    reviewUnits: string;
    heldUnits: string;
    released: boolean;
    phases: Array<{
      phase: ProviderPhase;
      reservedUnits: string;
      heldUnits: string;
      recognizedUnits: string;
      releasedUnits: string;
      settled: boolean;
    }>;
  }>;
};
export type ProviderExecutionSnapshot = {
  schemaVersion: 2;
  archiveFormatVersion: 3;
  run: ProviderRun;
  revision: number;
  events: ProviderExecutionEvent[];
  artifacts: Array<Omit<ProviderExecutionArtifact, "body">>;
  budgetEvents: Array<ProviderReservationBudgetEvent | ProviderExecutionBudgetEvent>;
  state:
    | "approved"
    | "prepared"
    | "dispatching"
    | "response-recorded"
    | "validated"
    | "completed"
    | "before-dispatch"
    | "result-unobserved"
    | "needs-cost-review"
    | "output-invalid"
    | "bound-breached";
  actualAiCalls: 0 | null;
  dispatchAllowed: false;
  canResume: false;
  terminal: boolean;
  unsettled: boolean;
  eligibleForNewCandidateRun: boolean;
  dispatchIntentCount: number;
  responseCount: number;
  unobservedDispatchCount: number;
  storage: {
    usedBytes: number;
    heldBytes: number;
    remainingEventSlots: number;
    remainingBudgetEventSlots: number;
    remainingReceiptSlots: number;
  };
  snapshotDigest: string;
};
export type ProviderExecutionPreparation = ProviderPreparation;
