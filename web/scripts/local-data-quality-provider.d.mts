import type { z } from "zod";
export * from "./local-data-quality-provider-execution.mjs";
export {
  providerRunSchema as providerReservationRunSchema,
  providerBudgetEventSchema as providerReservationBudgetEventSchema,
  providerRunEventSchema as providerReservationRunEventSchema,
  providerReceiptSchema as providerReservationReceiptSchema,
  providerArtifactSchema as providerReservationArtifactSchema,
  validateProviderRunLedger as validateProviderReservationRunLedger,
  validateProviderBudgetLedger as validateProviderReservationBudgetLedger,
} from "./local-data-quality-provider-reservation-ledger.mjs";
import type { CandidateRegistrySnapshot } from "../src/lib/studio-plan-quality-candidate-registry-types";
import type {
  ProviderPreparation,
  VersionedProviderStart,
  VersionedProviderRun,
  StoredProviderRun,
  StoredProviderRunEvent,
  StoredProviderSnapshot,
  VersionedProviderPreparation,
  ProviderRequestBody,
  ProviderApproval,
  ProviderStart,
  ProviderPolicy,
  ProviderBudgetEvent,
  ProviderRun,
  ProviderRunEvent,
  ProviderReceipt,
  ProviderArtifact,
  ProviderCancel,
  ProviderEnvironment,
  ProviderScope,
  ProviderBudgetSnapshot,
  ProviderSnapshot,
} from "../src/lib/studio-plan-quality-provider-types";
export const providerPreparationSchema: z.ZodType<ProviderPreparation>;
export const providerRequestBodySchema: z.ZodType<ProviderRequestBody>;
export const providerApprovalSchema: z.ZodType<ProviderApproval>;
export const providerStartSchema: z.ZodType<ProviderStart>;
export const providerPolicySchema: z.ZodType<ProviderPolicy>;
export const providerBudgetEventSchema: z.ZodType<ProviderBudgetEvent>;
export const providerRunSchema: z.ZodType<ProviderRun>;
export const providerRunEventSchema: z.ZodType<ProviderRunEvent>;
export const providerReceiptSchema: z.ZodType<ProviderReceipt>;
export const providerArtifactSchema: z.ZodType<ProviderArtifact>;
export const providerCancelSchema: z.ZodType<ProviderCancel>;
export function providerDigest(value: unknown): string;
export function providerWireDigest(value: unknown): string;
export function providerRawDigest(value: string | Uint8Array): string;
export function providerBudgetScope(environment: ProviderEnvironment): ProviderScope;
export function providerStartDigestInput(input: ProviderStart): unknown;
export function providerCancelDigestInput(runId: string, input: ProviderCancel): unknown;
export function providerPolicyDigestInput(input: {
  clientRequestId: string;
  expectedRevision: number;
  policy: ProviderPolicy;
}): unknown;
export function validateProviderPreparation(
  value: unknown,
  registry: CandidateRegistrySnapshot,
): ProviderPreparation;
export function createProviderBudgetEvent(
  input: Omit<ProviderBudgetEvent, "eventDigest">,
): ProviderBudgetEvent;
export function createProviderRunEvent(
  input: Omit<ProviderRunEvent, "eventDigest">,
): ProviderRunEvent;
export function createProviderReceipt(input: ProviderReceipt): ProviderReceipt;
export function createProviderArtifact(input: { runId: string; body: string }): ProviderArtifact;
export function createProviderRun(input: {
  input: ProviderStart;
  id: string;
  recordedAt: string;
  reservation: ProviderBudgetEvent;
}): ProviderRun;
export function validateProviderBudgetLedger(
  events: ProviderBudgetEvent[],
  scopeId: ProviderScope,
): ProviderBudgetSnapshot;
export function validateProviderRunLedger(input: {
  run: ProviderRun;
  events: ProviderRunEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  registry: CandidateRegistrySnapshot;
}): ProviderSnapshot;
export function inspectProviderLedger(input: {
  runs: ProviderRun[];
  events: ProviderRunEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  registries: CandidateRegistrySnapshot[];
  otherNonces?: string[];
}): {
  budgets: ProviderBudgetSnapshot[];
  snapshots: ProviderSnapshot[];
  reservedBytes: number;
  reservedBudgetEventSlots: number;
  reservedReceiptSlots: number;
  usedBytes: number;
};

export const versionedProviderPreparationSchema: z.ZodType<VersionedProviderPreparation>;
export function validateVersionedProviderPreparation(
  value: unknown,
  registry: CandidateRegistrySnapshot,
): VersionedProviderPreparation;
export function validateVersionedProviderRequestEvidence(
  value: unknown,
  registry: CandidateRegistrySnapshot,
): Pick<
  VersionedProviderPreparation,
  "scope" | "model" | "contract" | "generation" | "reviewTemplate"
>;

/** Explicit format3 helpers. Old schemas/functions above still reject the new native format. */
export const versionedProviderStartSchema: z.ZodType<VersionedProviderStart>;
export const versionedProviderRunSchema: z.ZodType<VersionedProviderRun>;
export function versionedProviderStartDigestInput(input: VersionedProviderStart): unknown;
export function createVersionedProviderRun(input: {
  input: VersionedProviderStart;
  id: string;
  recordedAt: string;
  reservation: ProviderBudgetEvent;
}): VersionedProviderRun;
export function validateVersionedProviderRunLedger(input: {
  run: StoredProviderRun;
  events: StoredProviderRunEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  registry: CandidateRegistrySnapshot;
}): StoredProviderSnapshot;
export function inspectVersionedProviderLedger(input: {
  runs: StoredProviderRun[];
  events: StoredProviderRunEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  registries: CandidateRegistrySnapshot[];
  otherNonces?: string[];
}): Omit<ReturnType<typeof inspectProviderLedger>, "snapshots"> & {
  snapshots: StoredProviderSnapshot[];
};
