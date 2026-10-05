import { DatabaseSync } from "node:sqlite";
import { inspectQualitySuppliedRows } from "../../scripts/local-data-quality.mjs";
import { inspectQualitySchema } from "../../scripts/local-data-quality-schema.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import {
  publicComparisonPrefixRowsSchema,
  type PublicComparisonPrefix,
} from "./studio-public-claim-comparison-budget";
export function readPublicComparisonPrefix(db: DatabaseSync): PublicComparisonPrefix {
  const rows = publicComparisonPrefixRowsSchema.parse({
    schema: inspectQualitySchema(db).schema,
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
      readProviderReservationDatabaseRows(db),
    ),
    transmissionRows: (({ bindingRows, coverageRows }) => ({ bindingRows, coverageRows }))(
      readProviderTransmissionApprovalDatabaseRows(db),
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
  const reservationRows = readProviderReservationDatabaseRows(db);
  const transmissionRows = readProviderTransmissionApprovalDatabaseRows(db);
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
    databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
    environment: "production",
    scopeId: "candidate-quality-provider-v2-live",
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
