import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { inspectQualitySuppliedRows } from "../../scripts/local-data-quality.mjs";
import {
  readProviderReservationDatabaseRows,
  readProviderReservationRawDatabaseRows,
  decodeProviderReservationDatabaseRows,
} from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import {
  readProviderTransmissionApprovalDatabaseRows,
  readProviderTransmissionApprovalRawDatabaseRows,
  decodeProviderTransmissionApprovalDatabaseRows,
} from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import {
  publicComparisonPrefixRowsSchema,
  type PublicComparisonPrefix,
} from "./studio-public-claim-comparison-budget";

const limits: Record<string, number> = {
  quality_runs: 20,
  quality_revisions: 4000,
  quality_requests: 4020,
  quality_candidate_versions: 20,
  quality_candidate_requests: 20,
  quality_execution_runs: 20,
  quality_execution_events: 140,
  quality_execution_requests: 20,
  quality_provider_policies: 100,
  quality_provider_reservation_bindings: 20,
  quality_provider_reservation_coverage: 1,
  quality_provider_transmission_bindings: 20,
  quality_provider_transmission_coverage: 1,
  quality_actual_runs: 20,
  quality_actual_events: 640,
  quality_actual_budget_events: 1000,
  quality_actual_requests: 1000,
  quality_actual_artifacts: 140,
};
/** Caller owns a read transaction and exact schema audit. Bound counts/bytes before allocation. */
export function readPublicComparisonRows(
  db: DatabaseSync,
  schema: PublicComparisonPrefix["rows"]["schema"],
  rawReservationBindings = false,
  rawTransmissionBindings = false,
) {
  let total = 0;
  for (const [table, cap] of Object.entries(limits)) {
    const column = table === "quality_actual_artifacts" ? "payload" : "CAST(body AS BLOB)";
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(length(${column})),0) AS bytes, COALESCE(MAX(length(${column})),0) AS largest FROM ${table}`,
      )
      .get()!;
    if (
      typeof row.n !== "number" ||
      row.n > cap ||
      typeof row.bytes !== "number" ||
      typeof row.largest !== "number" ||
      row.largest > 8 * 1024 * 1024
    )
      throw Error("PUBLIC_COMPARISON_DATABASE_LIMIT");
    total += row.bytes;
  }
  if (!Number.isSafeInteger(total) || total > 256 * 1024 * 1024)
    throw Error("PUBLIC_COMPARISON_DATABASE_LIMIT");
  const rows = publicComparisonPrefixRowsSchema.parse({
    schema,
    runRows: db.prepare("SELECT id,body,body_hash FROM quality_runs ORDER BY id").all(),
    revisionRows: db
      .prepare(
        "SELECT run_id,revision,body,body_hash FROM quality_revisions ORDER BY run_id,revision",
      )
      .all(),
    receiptRows: db
      .prepare("SELECT nonce,body,body_hash FROM quality_requests ORDER BY nonce")
      .all(),
    candidateRows: db
      .prepare(
        "SELECT set_id,version,body,body_hash FROM quality_candidate_versions ORDER BY set_id,version",
      )
      .all(),
    candidateReceipts: db
      .prepare("SELECT nonce,body,body_hash FROM quality_candidate_requests ORDER BY nonce")
      .all(),
    executionRows: db
      .prepare("SELECT id,body,body_hash FROM quality_execution_runs ORDER BY id")
      .all(),
    executionEvents: db
      .prepare(
        "SELECT run_id,revision,body,body_hash FROM quality_execution_events ORDER BY run_id,revision",
      )
      .all(),
    executionReceipts: db
      .prepare("SELECT nonce,body,body_hash FROM quality_execution_requests ORDER BY nonce")
      .all(),
    policyRows: db
      .prepare(
        "SELECT rowid AS storage_order,scope_id,revision,nonce,body,body_hash FROM quality_provider_policies ORDER BY rowid",
      )
      .all(),
    reservationRows: (({ bindingRows, coverageRows }) => ({ bindingRows, coverageRows }))(
      rawReservationBindings
        ? readProviderReservationRawDatabaseRows(db)
        : readProviderReservationDatabaseRows(db),
    ),
    transmissionRows: (({ bindingRows, coverageRows }) => ({ bindingRows, coverageRows }))(
      rawTransmissionBindings
        ? readProviderTransmissionApprovalRawDatabaseRows(db)
        : readProviderTransmissionApprovalDatabaseRows(db),
    ),
    actualRows: {
      budget: db
        .prepare(
          "SELECT scope_id,revision,body,body_hash FROM quality_actual_budget_events ORDER BY scope_id,revision",
        )
        .all(),
      runs: db.prepare("SELECT id,body,body_hash FROM quality_actual_runs ORDER BY id").all(),
      runOrder: db
        .prepare("SELECT rowid AS storage_order,id FROM quality_actual_runs ORDER BY rowid")
        .all(),
      events: db
        .prepare(
          "SELECT run_id,revision,body,body_hash FROM quality_actual_events ORDER BY run_id,revision",
        )
        .all(),
      artifacts: db
        .prepare(
          "SELECT run_id,artifact_key,payload,sha256,size_bytes FROM quality_actual_artifacts ORDER BY run_id,artifact_key",
        )
        .all(),
      receipts: db
        .prepare("SELECT nonce,body,body_hash FROM quality_actual_requests ORDER BY nonce")
        .all(),
    },
  });
  return rows;
}
export function decodePublicComparisonPrefix(
  rows: PublicComparisonPrefix["rows"],
  selection: Pick<PublicComparisonPrefix, "databaseInstanceId" | "environment" | "scopeId">,
): PublicComparisonPrefix {
  const reservationRows = decodeProviderReservationDatabaseRows(
    rows.reservationRows.bindingRows,
    rows.reservationRows.coverageRows,
  );
  const transmissionRows = decodeProviderTransmissionApprovalDatabaseRows(
    rows.transmissionRows.bindingRows,
    rows.transmissionRows.coverageRows,
  );
  const audited = inspectQualitySuppliedRows({
    ...rows,
    reservationRows,
    transmissionRows,
    storageVersion: 9,
    candidates: true,
    executions: true,
    actual: true,
    policies: true,
    reservations: true,
    transmissions: true,
    providerPrefix: null,
    operational: false,
  });
  return {
    storageVersion: 9,
    ...selection,
    rows,
    decoded: {
      ledger: audited.ledger,
      reservationCoverage: reservationRows.coverage,
      reservationRecords: reservationRows.records,
      transmissionCoverage: transmissionRows.coverage,
      transmissionRecords: transmissionRows.records,
    },
  };
}
