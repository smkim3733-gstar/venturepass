/** Synthetic fixture conversion only. Production never downgrades schemas or removes policy rows. */
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import {
  inspectQualitySchema,
  assertQualityLegacyLedgerRows,
  qualityLegacyTableSql,
  qualityTableSql,
  qualityWriterTriggerSql,
  qualityV5WriterTriggerSql,
  qualityV6WriterTriggerSql,
  qualityV7WriterTriggerSql,
  qualityV8WriterTriggerSql,
  qualityV9WriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";

/** Fail at the actual INSERT boundary without adding an unsupported schema object. */
export function failQualityReceiptInsert(
  table: "quality_requests" | "quality_actual_requests" | "quality_candidate_requests",
) {
  const prepare = DatabaseSync.prototype.prepare;
  const failure = vi.fn(() => {
    throw new Error("synthetic receipt insertion failure");
  });
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (new RegExp(`^INSERT INTO ${table}\\b`, "i").test(sql.trim()))
      vi.spyOn(statement, "run").mockImplementation(failure);
    return statement;
  });
  return failure;
}

export function freezePolicyFreeSchema(db: DatabaseSync, target: 1 | 2 | 3 | 4 | 5 | 6) {
  const before = inspectQualitySchema(db);
  if (before.version === target) return;
  if (before.version <= target) throw new Error("Unexpected historical fixture schema");
  const tables =
    target >= 4
      ? Object.keys(qualityTableSql)
      : Object.keys(qualityLegacyTableSql).slice(0, target === 1 ? 3 : target === 2 ? 5 : 8);
  const removed = before.tables.filter((table) => !tables.includes(table));
  for (const table of removed) {
    // The empty v8 migration marker is fixture metadata, not a historical run exemption.
    if (
      table === "quality_provider_reservation_coverage" ||
      table === "quality_provider_transmission_coverage"
    ) {
      const rows = db.prepare(`SELECT body FROM ${table}`).all();
      if (rows.length !== 1 || typeof rows[0].body !== "string")
        throw new Error("Invalid coverage fixture");
      const coverage = JSON.parse(rows[0].body);
      if (
        coverage.cutoverGlobalRunCount !== 0 ||
        (table === "quality_provider_reservation_coverage"
          ? coverage.legacyProductionRuns.length !== 0
          : coverage.cutoverProviderEvents.length !== 0 ||
            coverage.legacyProductionApprovals.length !== 0)
      )
        throw new Error("Cannot discard historical coverage");
      continue;
    }
    if (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n !== 0)
      throw new Error("Cannot discard fixture records");
  }
  if (before.actual) assertQualityLegacyLedgerRows(db, target);
  const gates = (version: number) =>
    version === 9
      ? qualityV9WriterTriggerSql
      : version === 8
        ? qualityV8WriterTriggerSql
        : version === 7
          ? qualityV7WriterTriggerSql
          : version === 6
            ? qualityV6WriterTriggerSql
            : version === 5
              ? qualityV5WriterTriggerSql
              : version === 4
                ? qualityWriterTriggerSql
                : {};
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of Object.keys(gates(before.version))) db.exec(`DROP TRIGGER ${name}`);
    for (const table of removed.toReversed()) db.exec(`DROP TABLE ${table}`);
    for (const sql of Object.values(gates(target))) db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.function("quality_storage_contract", { deterministic: true }, () => `quality-v${target}`);
  if (inspectQualitySchema(db).version !== target) throw new Error("Invalid historical fixture");
}
