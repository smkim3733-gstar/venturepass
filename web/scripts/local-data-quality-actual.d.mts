import type { z } from "zod";
import type { CandidateRegistrySnapshot } from "../src/lib/studio-plan-quality-candidate-registry-types";
import type {
  ActualLedgerArtifact,
  ActualLedgerBudgetEvent,
  ActualLedgerBudgetPayload,
  ActualLedgerBudgetSnapshot,
  ActualLedgerReceipt,
  ActualLedgerRun,
  ActualLedgerRunEvent,
  ActualLedgerSnapshot,
} from "../src/lib/studio-plan-quality-actual-ledger-types";
import type {
  EngineExecutionResponse,
  EngineExecutionOutput,
  EngineExecutionTransportRequest,
} from "../src/lib/studio-engine-execution-types";
export const actualArchiveJsonSchemas: Record<string, unknown>;
export const actualArchiveSchemas: Record<string, z.ZodType>;
export function actualCanonicalDigest(value: unknown): string;
export function actualRawDigest(value: string | Uint8Array): string;
export function actualLedgerOperationDigest(input: {
  kind: ActualLedgerReceipt["kind"];
  clientRequestId: string;
  runId: string;
  expectedRevision: number;
  payload: unknown;
  artifact?: ActualLedgerArtifact;
}): string;
export function actualLedgerPolicyRequestDigest(
  event: ActualLedgerBudgetEvent,
  clientRequestId: string,
): string;
export function validateActualArtifact(value: unknown): ActualLedgerArtifact;
export function validateActualBudgetLedger(values: unknown[]): ActualLedgerBudgetSnapshot;
export function calculateActualUsage(input: {
  run: ActualLedgerRun;
  phase: "generation" | "review";
  metadata: EngineExecutionResponse;
  artifact: ActualLedgerArtifact;
}): Extract<ActualLedgerBudgetPayload, { kind: "recognize-usage" }> | null;
export function deriveActualReviewRequest(
  run: ActualLedgerRun,
  output: EngineExecutionOutput,
): EngineExecutionTransportRequest["body"];
export function validateActualRunLedger(input: {
  run: ActualLedgerRun;
  events: ActualLedgerRunEvent[];
  artifacts: ActualLedgerArtifact[];
  budgetEvents: ActualLedgerBudgetEvent[];
  receipts?: ActualLedgerReceipt[];
  registry: CandidateRegistrySnapshot;
}): ActualLedgerSnapshot;
export function inspectActualLedger(input: {
  runs: ActualLedgerRun[];
  events: ActualLedgerRunEvent[];
  artifacts: ActualLedgerArtifact[];
  budgetEvents: ActualLedgerBudgetEvent[];
  receipts: ActualLedgerReceipt[];
  registries: CandidateRegistrySnapshot[];
  otherNonces?: string[];
}): {
  budget: ActualLedgerBudgetSnapshot;
  snapshots: ActualLedgerSnapshot[];
  reservedBytes: number;
  reservedBudgetEventSlots: number;
  reservedReceiptSlots: number;
  usedBytes: number;
};
