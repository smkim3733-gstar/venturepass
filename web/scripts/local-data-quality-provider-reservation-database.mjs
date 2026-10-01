import {
  decodeVersionedProviderReservationBindingRows,
  providerReservationArchiveLimits as limits,
} from "./local-data-quality-provider-reservation-binding.mjs";
import { providerDigest as digest } from "./local-data-quality-provider.mjs";
import { DataToolError, fail } from "./local-data-files.mjs";

/** Bounded raw-row decoder only. Caller must audit schema and the complete archive in one transaction. */
export function readProviderReservationDatabaseRows(db) {
  const count = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM quality_provider_reservation_bindings) AS bindings,
    (SELECT COUNT(*) FROM quality_provider_reservation_coverage) AS coverage,
    (SELECT COALESCE(MAX(length(CAST(body AS BLOB))),0) FROM quality_provider_reservation_bindings) AS bindingBytes,
    (SELECT COALESCE(MAX(length(CAST(body AS BLOB))),0) FROM quality_provider_reservation_coverage) AS coverageBytes`,
    )
    .get();
  if (Number(count.bindings) > limits.records) fail("QUALITY_DATABASE_LIMIT");
  if (Number(count.coverage) !== 1) fail("QUALITY_DATABASE_INVALID");
  if (
    Number(count.bindingBytes) > limits.recordBytes ||
    Number(count.coverageBytes) > limits.coverageBytes
  )
    fail("QUALITY_DATABASE_INVALID");
  const bindingRows = db
    .prepare(
      "SELECT rowid AS storage_order,run_id,nonce,body,body_hash FROM quality_provider_reservation_bindings ORDER BY rowid",
    )
    .all();
  const coverageRows = db
    .prepare("SELECT id,body,body_hash FROM quality_provider_reservation_coverage ORDER BY id")
    .all();
  try {
    const bindings = decodeVersionedProviderReservationBindingRows(bindingRows),
      row = coverageRows[0];
    if (
      row.id !== 1 ||
      typeof row.body !== "string" ||
      Buffer.byteLength(row.body) > limits.coverageBytes
    )
      fail("QUALITY_DATABASE_INVALID");
    const coverage = JSON.parse(row.body);
    if (row.body_hash !== digest(coverage)) fail("QUALITY_DATABASE_INVALID");
    return {
      records: bindings.records,
      coverage,
      usedBytes: bindings.usedBytes + Buffer.byteLength(row.body),
      bindingRows,
      coverageRows,
    };
  } catch {
    throw new DataToolError("QUALITY_DATABASE_INVALID");
  }
}
