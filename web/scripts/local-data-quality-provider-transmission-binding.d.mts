import type {
  ProviderTransmissionApprovalBinding,
  StoredProviderTransmissionApprovalBinding,
  ProviderTransmissionApprovalCoverage,
} from "../src/lib/studio-plan-quality-provider-transmission-approval-types";
import type { inspectVersionedProviderReservationArchive } from "./local-data-quality-provider-reservation-binding.mjs";
type Archive = Parameters<typeof inspectVersionedProviderReservationArchive>[0];
export const providerTransmissionApprovalArchiveLimits: {
  records: number;
  recordBytes: number;
  coverageBytes: number;
  totalBytes: number;
};
export function decodeProviderTransmissionApprovalBindingRows(rows: unknown[]): {
  records: ProviderTransmissionApprovalBinding[];
  usedBytes: number;
};
export function validateProviderTransmissionApprovalBinding(
  raw: unknown,
  archive: Archive,
): ProviderTransmissionApprovalBinding;
export function decodeVersionedProviderTransmissionApprovalBindingRows(rows: unknown[]): {
  records: StoredProviderTransmissionApprovalBinding[];
  usedBytes: number;
};
export function validateVersionedProviderTransmissionApprovalBinding(
  raw: unknown,
  archive: Archive,
): StoredProviderTransmissionApprovalBinding;
export function inspectVersionedProviderTransmissionApprovalArchive(
  input: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0],
): Omit<ReturnType<typeof inspectProviderTransmissionApprovalArchive>, "records"> & {
  records: StoredProviderTransmissionApprovalBinding[];
};
export function createProviderTransmissionApprovalMigrationCoverage(
  archive: Archive,
): ProviderTransmissionApprovalCoverage;
export function inspectProviderTransmissionApprovalArchive(input: {
  archive: Archive;
  coverage: unknown;
  records: unknown[];
}): {
  records: ProviderTransmissionApprovalBinding[];
  coverage: ProviderTransmissionApprovalCoverage;
  usedBytes: number;
  reservationArchive: ReturnType<typeof inspectVersionedProviderReservationArchive>;
};
