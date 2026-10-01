import type {
  ProviderReservationBinding,
  ProviderReservationCoverage,
} from "../src/lib/studio-plan-quality-provider-reservation-archive-types";
import type { inspectQualityLedgers } from "./local-data-quality-ledgers.mjs";
type Ledger = Parameters<typeof inspectQualityLedgers>[0];
export const providerReservationArchiveLimits: {
  records: number;
  recordBytes: number;
  coverageBytes: number;
  totalBytes: number;
};
export function decodeProviderReservationBindingRows(rows: unknown[]): {
  records: ProviderReservationBinding[];
  usedBytes: number;
};
export function validateProviderReservationBinding(
  raw: unknown,
  ledger: Ledger,
): ProviderReservationBinding;
export function createProviderReservationMigrationCoverage(
  ledger: Ledger,
): ProviderReservationCoverage;
export function inspectProviderReservationArchive(input: {
  ledger: Ledger;
  coverage: unknown;
  records: unknown[];
}): {
  records: ProviderReservationBinding[];
  coverage: ProviderReservationCoverage;
  usedBytes: number;
  ledger: ReturnType<typeof inspectQualityLedgers>;
};

import type { StoredProviderReservationBinding } from "../src/lib/studio-plan-quality-provider-reservation-archive-types";
export function decodeVersionedProviderReservationBindingRows(rows: unknown[]): {
  records: StoredProviderReservationBinding[];
  usedBytes: number;
};
export function validateVersionedProviderReservationBinding(
  raw: unknown,
  ledger: Ledger,
): StoredProviderReservationBinding;
export function inspectVersionedProviderReservationArchive(
  input: Parameters<typeof inspectProviderReservationArchive>[0],
): Omit<ReturnType<typeof inspectProviderReservationArchive>, "records"> & {
  records: StoredProviderReservationBinding[];
};
