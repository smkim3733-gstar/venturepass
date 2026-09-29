import type { CandidateRegistrySnapshot } from "../src/lib/studio-plan-quality-candidate-registry-types";
import type {
  ActualLedgerRun,
  ActualLedgerRunEvent,
  ActualLedgerBudgetEvent,
  ActualLedgerArtifact,
  ActualLedgerReceipt,
} from "../src/lib/studio-plan-quality-actual-ledger-types";
import type {
  ProviderRun,
  ProviderRunEvent,
  ProviderBudgetEvent,
  ProviderArtifact,
  ProviderReceipt,
} from "../src/lib/studio-plan-quality-provider-types";
import type { inspectActualLedger } from "./local-data-quality-actual.mjs";
import type { inspectProviderLedger } from "./local-data-quality-provider.mjs";
import type { inspectProviderPolicyLedger } from "./local-data-quality-provider-policy.mjs";
export function inspectQualityLedgers(input: {
  runs: unknown[];
  events: unknown[];
  artifacts: unknown[];
  budgetEvents: unknown[];
  receipts: unknown[];
  registries: CandidateRegistrySnapshot[];
  otherNonces?: string[];
  policies?: unknown[];
}): {
  legacy: ReturnType<typeof inspectActualLedger> & {
    runs: ActualLedgerRun[];
    events: ActualLedgerRunEvent[];
    budgetEvents: ActualLedgerBudgetEvent[];
    artifacts: ActualLedgerArtifact[];
    receipts: ActualLedgerReceipt[];
  };
  provider: ReturnType<typeof inspectProviderLedger> & {
    runs: ProviderRun[];
    events: ProviderRunEvent[];
    budgetEvents: ProviderBudgetEvent[];
    artifacts: ProviderArtifact[];
    receipts: ProviderReceipt[];
  };
  reservedBytes: number;
  policy: ReturnType<typeof inspectProviderPolicyLedger>;
  reservedBudgetEventSlots: number;
  reservedReceiptSlots: number;
  usedBytes: number;
  globalRunCount: number;
};
