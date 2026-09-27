import type { ProviderContextReservationBasis } from "./studio-plan-quality-provider-reservation";
import type { EnginePlanReviewTemplate } from "./studio-engine-request-preparation";
import type {
  EngineExecutionContract,
  EngineExecutionTransportRequest,
} from "./studio-engine-execution-types";

export type ProviderEnvironment = "synthetic-test" | "production";
export type ProviderScope =
  "candidate-quality-provider-v2-synthetic" | "candidate-quality-provider-v2-live";
export type ProviderRequestBody = EngineExecutionTransportRequest["body"] & {
  service_tier: "default";
  truncation: "disabled";
  background: false;
  stream: false;
};
export type ProviderContract = {
  schemaVersion: 2;
  engineVersion: "plan-provider-reservation-v2";
  baseContract: EngineExecutionContract;
  requestOptions: {
    service_tier: "default";
    truncation: "disabled";
    background: false;
    stream: false;
  };
  omittedFields: ["previous_response_id", "conversation", "tools", "context_management"];
  maxCalls: 2;
  maxRetries: 0;
  maxOutputTokens: 16000;
  contractDigest: string;
};
export type ProviderRetentionNotice = {
  policyVersion: string;
  notice: string;
  sourceUrl: string;
  documentDigest: string;
  reviewedAt: string;
  validUntil: string;
};
export type ProviderPreparation = {
  schemaVersion: 2;
  kind: "provider-execution-preparation";
  environment: ProviderEnvironment;
  preparedAt: string;
  expiresAt: string;
  scope: {
    version: number;
    versionDigest: string;
    candidateId: string;
    sourceDigest: string;
    candidateDigest: string;
    modelInputDigest: string;
  };
  model: string;
  contract: ProviderContract;
  generation: {
    body: ProviderRequestBody;
    requestDigest: string;
    sha256: string;
    inputChars: number;
  };
  reviewTemplate: Omit<
    EnginePlanReviewTemplate,
    "schemaVersion" | "contractDigest" | "templateDigest"
  > & {
    schemaVersion: 2;
    contractDigest: string;
    requestOptions: ProviderContract["requestOptions"];
    templateDigest: string;
  };
  financialBasis: ProviderContextReservationBasis;
  financialBasisDigest: string;
  budget: {
    scopeId: ProviderScope;
    revision: number;
    headDigest: string;
    currency: string;
    unitScale: number;
    capUnits: string;
    heldUnits: string;
    recognizedUnits: string;
  };
  retention: ProviderRetentionNotice;
  retentionDigest: string;
  permissions: { dispatchAllowed: false; tokenFitVerified: false; accountAccessVerified: false };
  preparationDigest: string;
};
export type ProviderApproval = {
  provenance: "synthetic-test" | "explicit-user";
  approvedPreparationDigest: string;
  approvedAt: string;
  expiresAt: string;
  acknowledgedReservationOnly: true;
  acknowledgedFinancialBasisNotTokenFit: true;
  acknowledgedRetention: true;
  acknowledgedNoAutomaticRetry: true;
};
export type ProviderStart = {
  clientRequestId: string;
  expectedBudgetRevision: number;
  expectedBudgetDigest: string;
  expectedScopeRunCount: number;
  expectedGlobalRunCount: number;
  preparation: ProviderPreparation;
  approval: ProviderApproval;
};
export type ProviderPolicy = {
  environment: ProviderEnvironment;
  provenance: "synthetic-test" | "explicit-user";
  currency: string;
  unitScale: number;
  capUnits: string;
};
export type ProviderBudgetPayload =
  | { kind: "configure"; capUnits: string }
  | {
      kind: "reserve-run";
      runId: string;
      preparationDigest: string;
      generationUnits: string;
      reviewUnits: string;
    }
  | {
      kind: "release-run";
      runId: string;
      reservationDigest: string;
      generationUnits: string;
      reviewUnits: string;
      reason: "cancelled-before-dispatch";
    };
export type ProviderReservationBudgetEvent = {
  schemaVersion: 2;
  scopeId: ProviderScope;
  environment: ProviderEnvironment;
  provenance: "synthetic-test" | "explicit-user";
  revision: number;
  previousDigest: string | null;
  eventId: string;
  recordedAt: string;
  currency: string;
  unitScale: number;
  payload: ProviderBudgetPayload;
  eventDigest: string;
};
export type ProviderRun = {
  schemaVersion: 2;
  archiveFormatVersion: 2;
  id: string;
  clientRequestId: string;
  inputDigest: string;
  recordedAt: string;
  environment: ProviderEnvironment;
  executionKind: "provider-contract-simulation" | "provider-ai-execution";
  observedTransport: "none";
  actualAiCalls: 0;
  preparation: ProviderPreparation;
  approval: ProviderApproval;
  expectedBudgetRevision: number;
  expectedBudgetDigest: string;
  expectedScopeRunCount: number;
  expectedGlobalRunCount: number;
  reservedBudgetRevision: number;
  reservationDigest: string;
  storageReservationBytes: 33554432;
  reservedSlots: { events: 32; budgetEvents: 16; receipts: 64 };
  runDigest: string;
};
export type ProviderReservationRunEvent = {
  schemaVersion: 2;
  runId: string;
  revision: 1;
  budgetRevision: number;
  previousEventDigest: null;
  recordedAt: string;
  payload: {
    kind: "cancelled-before-dispatch";
    reason: "user-cancelled" | "test-cleanup" | "scope-expired";
    releaseBudgetEventDigest: string;
  };
  eventDigest: string;
};
export type ProviderReservationArtifact = {
  runId: string;
  key: "generation-request";
  body: string;
  sha256: string;
  sizeBytes: number;
};
export type ProviderReservationReceipt = {
  schemaVersion: 2;
  scopeId: ProviderScope;
  kind: "provider-budget-configure" | "provider-start" | "provider-cancel";
  clientRequestId: string;
  inputDigest: string;
  runId: string | null;
  runRevision: 0 | 1 | null;
  budgetRevision: number;
  operationDigest: string;
  recordedAt: string;
};
export type ProviderCancel = {
  clientRequestId: string;
  expectedRevision: 0;
  reason: ProviderReservationRunEvent["payload"]["reason"];
};
export type ProviderReservationBudgetSnapshot = {
  scopeId: ProviderScope;
  environment: ProviderEnvironment;
  revision: number;
  headDigest: string | null;
  currency: string | null;
  unitScale: number | null;
  capUnits: string;
  heldUnits: string;
  recognizedUnits: "0";
  availableUnits: string;
  reservations: Array<{
    runId: string;
    reservationDigest: string;
    generationUnits: string;
    reviewUnits: string;
    heldUnits: string;
    released: boolean;
  }>;
};
export type ProviderReservationSnapshot = {
  schemaVersion: 2;
  archiveFormatVersion: 2;
  run: ProviderRun;
  revision: 0 | 1;
  events: ProviderReservationRunEvent[];
  artifacts: Array<Omit<ProviderReservationArtifact, "body">>;
  // A later reserved run can pin earlier settled execution events in its scope prefix.
  budgetEvents: ProviderBudgetEvent[];
  state: "reserved" | "cancelled-before-dispatch";
  actualAiCalls: 0;
  dispatchAllowed: false;
  canResume: false;
  storage: {
    usedBytes: number;
    heldBytes: number;
    remainingEventSlots: number;
    remainingBudgetEventSlots: number;
    remainingReceiptSlots: number;
  };
  snapshotDigest: string;
};
export type ProviderBudgetEvent =
  | ProviderReservationBudgetEvent
  | import("./studio-plan-quality-provider-execution-types").ProviderExecutionBudgetEvent;
export type ProviderRunEvent =
  | ProviderReservationRunEvent
  | import("./studio-plan-quality-provider-execution-types").ProviderExecutionEvent;
export type ProviderArtifact =
  | ProviderReservationArtifact
  | import("./studio-plan-quality-provider-execution-types").ProviderExecutionArtifact;
export type ProviderReceipt =
  | ProviderReservationReceipt
  | import("./studio-plan-quality-provider-execution-types").ProviderExecutionReceipt;
export type ProviderBudgetSnapshot =
  | ProviderReservationBudgetSnapshot
  | import("./studio-plan-quality-provider-execution-types").ProviderExecutionBudgetSnapshot;
export type ProviderSnapshot =
  | ProviderReservationSnapshot
  | import("./studio-plan-quality-provider-execution-types").ProviderExecutionSnapshot;
export {
  providerPreparationSchema,
  providerApprovalSchema,
  providerStartSchema,
  providerPolicySchema,
  providerBudgetEventSchema,
  providerRunSchema,
  providerRunEventSchema,
  providerReceiptSchema,
  providerArtifactSchema,
  providerCancelSchema,
} from "../../scripts/local-data-quality-provider.mjs";
