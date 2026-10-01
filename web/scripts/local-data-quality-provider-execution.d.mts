import type { z } from "zod";
import type {
  ProviderRun,
  VersionedProviderRun,
  VersionedProviderReservationSnapshot,
  ProviderScope,
  ProviderBudgetEvent,
  ProviderRunEvent,
  ProviderArtifact,
  ProviderReceipt,
  ProviderSnapshot,
} from "../src/lib/studio-plan-quality-provider-types";
import type {
  ProviderExecutionContract,
  VersionedProviderTransmissionApproval,
  VersionedProviderApprovalEvent,
  VersionedProviderApprovalCommand,
  VersionedProviderApprovalSnapshot,
  VersionedProviderExecutionContract,
  VersionedProviderTransmissionManifest,
  ProviderTransmissionManifest,
  ProviderExecutionEvent,
  ProviderExecutionBudgetEvent,
  ProviderExecutionReceipt,
  ProviderExecutionArtifact,
  ProviderExecutionPayload,
  ProviderExecutionCommand,
  ProviderExecutionSnapshot,
  ProviderExecutionBudgetSnapshot,
  ProviderExecutionOutput,
  ProviderPhase,
} from "../src/lib/studio-plan-quality-provider-execution-types";
import type {
  ProviderUsagePolicy,
  ProviderUsageAssessment,
  ProviderCapturedResponse,
} from "./local-data-quality-provider-usage.mjs";
import type { CandidateRegistrySnapshot } from "../src/lib/studio-plan-quality-candidate-registry-types";
import type { PlanContent, ReviewFinding } from "../src/lib/studio-schema";
export const providerExecutionLimits: Readonly<{
  requestBytes: 2097152;
  responseBytes: 4194304;
  validatedBytes: 2097152;
  finalBytes: 4194304;
  totalArtifactBytes: 20971520;
}>;
export const providerExecutionContractSchema: z.ZodType<ProviderExecutionContract>;
export const providerTransmissionManifestSchema: z.ZodType<ProviderTransmissionManifest>;
export const versionedProviderExecutionContractSchema: z.ZodType<VersionedProviderExecutionContract>;
export const versionedProviderTransmissionManifestSchema: z.ZodType<VersionedProviderTransmissionManifest>;
export const versionedProviderTransmissionApprovalSchema: z.ZodType<VersionedProviderTransmissionApproval>;
export const versionedProviderApprovalEventSchema: z.ZodType<VersionedProviderApprovalEvent>;
export const versionedProviderApprovalCommandSchema: z.ZodType<VersionedProviderApprovalCommand>;
export function createVersionedProviderApprovalEvent(
  input: Omit<VersionedProviderApprovalEvent, "eventDigest">,
): VersionedProviderApprovalEvent;
export function versionedProviderApprovalOperationDigest(
  runId: string,
  input: VersionedProviderApprovalCommand,
): string;
export function validateVersionedProviderApprovalLedger(input: {
  run: VersionedProviderRun;
  events: VersionedProviderApprovalEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  registry: CandidateRegistrySnapshot;
  startSnapshot: VersionedProviderReservationSnapshot;
}): VersionedProviderApprovalSnapshot;
export const providerExecutionPayloadSchema: z.ZodType<ProviderExecutionPayload>;
export const providerExecutionEventSchema: z.ZodType<ProviderExecutionEvent>;
export const providerExecutionBudgetEventSchema: z.ZodType<ProviderExecutionBudgetEvent>;
export const providerExecutionReceiptSchema: z.ZodType<ProviderExecutionReceipt>;
export const providerExecutionArtifactSchema: z.ZodType<ProviderExecutionArtifact>;
export const providerExecutionCommandSchema: z.ZodType<ProviderExecutionCommand>;
export function createProviderExecutionEvent(
  input: Omit<ProviderExecutionEvent, "eventDigest">,
): ProviderExecutionEvent;
export function createProviderExecutionBudgetEvent(
  input: Omit<ProviderExecutionBudgetEvent, "eventDigest">,
): ProviderExecutionBudgetEvent;
export function createProviderExecutionReceipt(
  input: ProviderExecutionReceipt,
): ProviderExecutionReceipt;
export function createProviderExecutionArtifact(input: {
  runId: string;
  key: ProviderExecutionArtifact["key"];
  body: string;
}): ProviderExecutionArtifact;
export function providerExecutionOperationDigest(
  runId: string,
  input: ProviderExecutionCommand,
): string;
export function createProviderTransmissionManifest(
  run: ProviderRun,
  usagePolicy: ProviderUsagePolicy,
): ProviderTransmissionManifest;
export function validateProviderExecutionManifest(
  run: ProviderRun,
  manifest: ProviderTransmissionManifest,
): ProviderTransmissionManifest;
export function createVersionedProviderTransmissionManifest(
  run: VersionedProviderRun,
  usagePolicy: ProviderUsagePolicy,
): VersionedProviderTransmissionManifest;
export function validateVersionedProviderExecutionManifest(
  run: VersionedProviderRun,
  manifest: VersionedProviderTransmissionManifest,
): VersionedProviderTransmissionManifest;
export function deriveProviderExecutionReviewRequest(
  run: ProviderRun,
  output: ProviderExecutionOutput,
): ProviderRun["preparation"]["generation"]["body"];
export function validateProviderExecutionOutput(
  phase: ProviderPhase,
  value: unknown,
  raw: ProviderCapturedResponse,
  run: ProviderRun,
  registry: CandidateRegistrySnapshot,
  generation?: ProviderExecutionOutput | null,
): ProviderExecutionOutput;
export function getProviderExecutionBudgetSnapshot(
  events: ProviderBudgetEvent[],
  scope: ProviderScope,
): ProviderExecutionBudgetSnapshot;
export function validateProviderExecutionFinalResult(
  value: unknown,
  contractDigest: string,
  generation: ProviderExecutionOutput,
  review: ProviderExecutionOutput,
): {
  content: PlanContent;
  review: ReviewFinding[];
  semanticReview: ReviewFinding[];
  contractDigest: string;
};
export function providerUsageRecognitionPayload(
  run: ProviderRun,
  phase: ProviderPhase,
  dispatchEventDigest: string,
  artifactSha256: string,
  assessment: ProviderUsageAssessment,
): Extract<ProviderExecutionBudgetEvent["payload"], { kind: "recognize-usage" }> | null;
export function validateProviderExecutionLedger(input: {
  run: ProviderRun;
  events: ProviderRunEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  registry: CandidateRegistrySnapshot;
  startSnapshot: ProviderSnapshot;
}): ProviderExecutionSnapshot;
