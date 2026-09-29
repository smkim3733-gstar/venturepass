import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { inspectQualityLedgers } from "../../scripts/local-data-quality-ledgers.mjs";
import { actualCanonicalDigest } from "../../scripts/local-data-quality-actual.mjs";
import { inspectQualitySchema } from "../../scripts/local-data-quality-schema.mjs";
import { decodeProviderPolicyRows } from "../../scripts/local-data-quality-provider-policy.mjs";
import { inspectProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { StudioError } from "./studio-http";

const corrupt = (): never => {
  throw new StudioError(
    "비용 원장의 무결성을 확인하지 못했습니다.",
    409,
    "QUALITY_ACTUAL_STORAGE_CORRUPT",
  );
};
/** Parent owns the SQLite transaction and path guard. No file/credential access. */
export function inspectLedgerDatabase(
  db: DatabaseSync,
  registry: (version: number) => CandidateRegistrySnapshot,
) {
  try {
    const ledger = readLedgerDatabaseInput(db, registry);
    const schema = inspectQualitySchema(db);
    if (schema.transmissions)
      return inspectProviderTransmissionApprovalArchive({
        archive: { ledger, ...readProviderReservationDatabaseRows(db) },
        ...readProviderTransmissionApprovalDatabaseRows(db),
      }).reservationArchive.ledger;
    if (schema.reservations)
      return inspectProviderReservationArchive({
        ledger,
        ...readProviderReservationDatabaseRows(db),
      }).ledger;
    return inspectQualityLedgers(ledger);
  } catch {
    return corrupt();
  }
}

/** Decode a single caller-owned snapshot, preserving immutable run order and stable array order.
 * This is not a complete audit: consumers must run inspectQualityLedgers (and full DB inspection
 * where required) inside the same transaction before trusting or returning these rows.
 */
export function readLedgerDatabaseInput(
  db: DatabaseSync,
  registry: (version: number) => CandidateRegistrySnapshot,
  additionalVersions: readonly number[] = [],
): Parameters<typeof inspectQualityLedgers>[0] {
  try {
    const hasPolicies = inspectQualitySchema(db).policies;
    if (
      hasPolicies &&
      Number(db.prepare("SELECT COUNT(*) AS n FROM quality_provider_policies").get()!.n) > 100
    )
      corrupt();
    const policyRows = hasPolicies
      ? db
          .prepare(
            "SELECT rowid AS storage_order,scope_id,revision,nonce,body,body_hash FROM quality_provider_policies ORDER BY rowid",
          )
          .all()
      : [];
    const { records: policies } = decodeProviderPolicyRows(policyRows);
    const specs = [
      ["quality_actual_runs", 20],
      ["quality_actual_events", 640],
      ["quality_actual_budget_events", 1000],
      ["quality_actual_requests", 1000],
      ["quality_actual_artifacts", 140],
    ] as const;
    for (const [table, max] of specs)
      if (Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n) > max) corrupt();
    const decode = (row: Record<string, unknown>, max: number) => {
      if (typeof row.body !== "string" || Buffer.byteLength(row.body) > max) return corrupt();
      const value = JSON.parse(row.body);
      if (actualCanonicalDigest(value) !== row.body_hash) return corrupt();
      return value;
    };
    const runs = db
      .prepare("SELECT rowid AS storage_order,* FROM quality_actual_runs ORDER BY rowid")
      .all()
      .map((row) => {
        const value = decode(row, 2 * 1024 * 1024);
        if (
          row.id !== value.id ||
          !Number.isSafeInteger(row.storage_order) ||
          Number(row.storage_order) <= 0
        )
          corrupt();
        return value;
      });
    const events = db
      .prepare("SELECT * FROM quality_actual_events ORDER BY run_id,revision")
      .all()
      .map((row) => {
        const value = decode(row, 32 * 1024);
        if (row.run_id !== value.runId || row.revision !== value.revision) corrupt();
        return value;
      });
    const budgetEvents = db
      .prepare("SELECT * FROM quality_actual_budget_events ORDER BY scope_id,revision")
      .all()
      .map((row) => {
        const value = decode(row, 32 * 1024);
        if (row.scope_id !== value.scopeId || row.revision !== value.revision) corrupt();
        return value;
      });
    const receipts = db
      .prepare("SELECT * FROM quality_actual_requests ORDER BY nonce")
      .all()
      .map((row) => {
        const value = decode(row, 4096);
        if (row.nonce !== value.clientRequestId) corrupt();
        return value;
      });
    const artifacts = db
      .prepare("SELECT * FROM quality_actual_artifacts ORDER BY run_id,artifact_key")
      .all()
      .map((row) => {
        if (
          !(row.payload instanceof Uint8Array) ||
          row.payload.byteLength !== row.size_bytes ||
          row.payload.byteLength > 8 * 1024 * 1024 ||
          createHash("sha256").update(row.payload).digest("hex") !== row.sha256
        )
          corrupt();
        const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          row.payload as Uint8Array,
        );
        JSON.parse(body);
        return {
          runId: row.run_id,
          key: row.artifact_key,
          body,
          sha256: row.sha256,
          sizeBytes: row.size_bytes,
        };
      });
    const otherNonces = db
      .prepare(
        "SELECT nonce FROM quality_requests UNION ALL SELECT nonce FROM quality_candidate_requests UNION ALL SELECT nonce FROM quality_execution_requests ORDER BY nonce",
      )
      .all()
      .map((row) => String(row.nonce));
    const versions = [
      ...new Set<number>([
        ...runs.map((run) => run.preparation.scope.version),
        ...policies.map((record) => record.command.version),
        ...additionalVersions,
      ]),
    ].sort((a, b) => a - b);
    return {
      runs,
      events,
      budgetEvents,
      receipts,
      artifacts,
      registries: versions.map(registry),
      otherNonces,
      policies,
    };
  } catch {
    return corrupt();
  }
}
