import type { CandidateRegistrySnapshot } from "../src/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderPolicyAdoptionRecord } from "../src/lib/studio-plan-quality-provider-policy-adoption-types";
import type { inspectProviderLedger } from "./local-data-quality-provider.mjs";
export const providerPolicyArchiveLimits: { records: number; recordBytes: number };
export function decodeProviderPolicyRows(rows: unknown[]): {
  records: ProviderPolicyAdoptionRecord[];
  usedBytes: number;
};
export function validateProviderPolicyAdoptionRecord(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  budgetEvents: unknown[],
): ProviderPolicyAdoptionRecord;
export function inspectProviderPolicyLedger(input: {
  records: unknown[];
  registries: CandidateRegistrySnapshot[];
  provider: Omit<Parameters<typeof inspectProviderLedger>[0], "registries">;
  otherNonces?: string[];
}): {
  revision: number;
  headDigest: string | null;
  records: ProviderPolicyAdoptionRecord[];
  nonces: string[];
  usedBytes: number;
  provider: ReturnType<typeof inspectProviderLedger>;
};

import type { VersionedProviderPolicyAdoptionRecord } from "../src/lib/studio-plan-quality-provider-policy-adoption-types";
type StoredPolicyRecord = ProviderPolicyAdoptionRecord | VersionedProviderPolicyAdoptionRecord;
export function decodeVersionedProviderPolicyRows(rows: unknown[]): {
  records: StoredPolicyRecord[];
  usedBytes: number;
};
export function validateVersionedProviderPolicyAdoptionRecord(
  raw: unknown,
  registry: CandidateRegistrySnapshot,
  budgetEvents: unknown[],
): StoredPolicyRecord;
export function inspectVersionedProviderPolicyLedger(
  input: Parameters<typeof inspectProviderPolicyLedger>[0],
): Omit<ReturnType<typeof inspectProviderPolicyLedger>, "records"> & {
  records: StoredPolicyRecord[];
};
