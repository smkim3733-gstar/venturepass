import { fail } from "./local-data-files.mjs";
import * as providerSchemas from "./local-data-quality-provider-reservation-ledger.mjs";

export const qualityLegacyTableSql = {
  quality_runs:
    "CREATE TABLE quality_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
  quality_revisions:
    "CREATE TABLE quality_revisions (run_id TEXT NOT NULL REFERENCES quality_runs(id), revision INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(run_id,revision))",
  quality_requests:
    "CREATE TABLE quality_requests (nonce TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
  quality_candidate_versions:
    "CREATE TABLE quality_candidate_versions (set_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(set_id,version))",
  quality_candidate_requests:
    "CREATE TABLE quality_candidate_requests (nonce TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
  quality_execution_runs:
    "CREATE TABLE quality_execution_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
  quality_execution_events:
    "CREATE TABLE quality_execution_events (run_id TEXT NOT NULL REFERENCES quality_execution_runs(id), revision INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(run_id,revision))",
  quality_execution_requests:
    "CREATE TABLE quality_execution_requests (nonce TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
};
export const qualityActualTableSql = {
  quality_actual_budget_events:
    "CREATE TABLE quality_actual_budget_events (scope_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(scope_id,revision))",
  quality_actual_runs:
    "CREATE TABLE quality_actual_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
  quality_actual_events:
    "CREATE TABLE quality_actual_events (run_id TEXT NOT NULL REFERENCES quality_actual_runs(id), revision INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(run_id,revision))",
  quality_actual_artifacts:
    "CREATE TABLE quality_actual_artifacts (run_id TEXT NOT NULL REFERENCES quality_actual_runs(id), artifact_key TEXT NOT NULL, payload BLOB NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(run_id,artifact_key))",
  quality_actual_requests:
    "CREATE TABLE quality_actual_requests (nonce TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
};
export const qualityTableSql = { ...qualityLegacyTableSql, ...qualityActualTableSql };
export const qualityImmutableTriggerSql = Object.fromEntries(
  Object.keys(qualityTableSql).flatMap((table) =>
    ["update", "delete"].map((action) => [
      `${table}_no_${action}`,
      `CREATE TRIGGER ${table}_no_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END`,
    ]),
  ),
);
export const qualityWriterTriggerSql = Object.fromEntries(
  Object.keys(qualityLegacyTableSql).map((table) => [
    `${table}_v4_writer`,
    `CREATE TRIGGER ${table}_v4_writer BEFORE INSERT ON ${table} BEGIN SELECT CASE WHEN quality_storage_contract() IS NOT 'quality-v4' THEN RAISE(ABORT,'unsupported writer') END; END`,
  ]),
);
/** Version 5 also gates every actual-ledger table. The v4 declaration stays frozen. */
export const qualityV5WriterTriggerSql = Object.fromEntries(
  Object.keys(qualityTableSql).map((table) => [
    `${table}_v5_writer`,
    `CREATE TRIGGER ${table}_v5_writer BEFORE INSERT ON ${table} BEGIN SELECT CASE WHEN quality_storage_contract() IS NOT 'quality-v5' THEN RAISE(ABORT,'unsupported writer') END; END`,
  ]),
);
export const qualityV6WriterTriggerSql = Object.fromEntries(
  Object.keys(qualityTableSql).map((table) => [
    `${table}_v6_writer`,
    `CREATE TRIGGER ${table}_v6_writer BEFORE INSERT ON ${table} BEGIN SELECT CASE WHEN quality_storage_contract() IS NOT 'quality-v6' THEN RAISE(ABORT,'unsupported writer') END; END`,
  ]),
);
const normalized = (sql) =>
  typeof sql === "string"
    ? sql
        .split(/('(?:''|[^'])*')/g)
        .map((part, index) =>
          index % 2
            ? part
            : part
                .replace(/ IF NOT EXISTS /gi, " ")
                .replace(/\s+/g, "")
                .toLowerCase(),
        )
        .join("")
        .replace(/;$/, "")
    : "";

/** Exact known schema only; does not migrate, execute data writes, or open another database. */
export function inspectQualitySchema(db, { allowEmpty = false } = {}) {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  if (!schema.length) {
    if (!allowEmpty) fail("QUALITY_SCHEMA_UNSUPPORTED");
    return { version: 0, schema, tables: [], candidates: false, executions: false, actual: false };
  }
  const names = new Set(schema.map((row) => String(row.name)));
  const v6 = Object.keys(qualityV6WriterTriggerSql).some((key) => names.has(key));
  const v5 = Object.keys(qualityV5WriterTriggerSql).some((key) => names.has(key));
  const actual = [
    ...Object.keys(qualityActualTableSql),
    ...Object.keys(qualityWriterTriggerSql),
    ...Object.keys(qualityV5WriterTriggerSql),
    ...Object.keys(qualityV6WriterTriggerSql),
  ].some((key) => names.has(key));
  const execution = Object.keys(qualityLegacyTableSql)
    .slice(5)
    .some((key) => names.has(key));
  const candidate = Object.keys(qualityLegacyTableSql)
    .slice(3, 5)
    .some((key) => names.has(key));
  const version = v6 ? 6 : v5 ? 5 : actual ? 4 : execution ? 3 : candidate ? 2 : 1;
  const tables = Object.keys(qualityTableSql).slice(
    0,
    actual ? 13 : execution ? 8 : candidate ? 5 : 3,
  );
  const expected = new Map(tables.map((table) => [table, qualityTableSql[table]]));
  for (const table of tables)
    for (const action of ["update", "delete"]) {
      const key = `${table}_no_${action}`;
      expected.set(key, qualityImmutableTriggerSql[key]);
    }
  if (actual)
    for (const [key, sql] of Object.entries(
      v6 ? qualityV6WriterTriggerSql : v5 ? qualityV5WriterTriggerSql : qualityWriterTriggerSql,
    ))
      expected.set(key, sql);
  if (schema.length !== expected.size) fail("QUALITY_SCHEMA_UNSUPPORTED");
  for (const item of schema) {
    if (
      !expected.has(item.name) ||
      normalized(item.sql) !== normalized(expected.get(item.name)) ||
      item.type !== (tables.includes(item.name) ? "table" : "trigger")
    )
      fail("QUALITY_SCHEMA_UNSUPPORTED");
  }
  return { version, schema, tables, candidates: version >= 2, executions: version >= 3, actual };
}

/** Caller owns BEGIN IMMEDIATE/COMMIT. Partial/unknown legacy schemas are never repaired silently. */
export function migrateQualitySchemaV4(db) {
  const before = inspectQualitySchema(db, { allowEmpty: true });
  if (before.version > 4) fail("QUALITY_SCHEMA_UNSUPPORTED");
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v4");
  if (before.version === 4) return before;
  for (const [table, sql] of Object.entries(qualityTableSql)) {
    if (before.tables.includes(table)) continue;
    db.exec(sql);
    for (const action of ["update", "delete"])
      db.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
  }
  for (const sql of Object.values(qualityWriterTriggerSql)) db.exec(sql);
  return inspectQualitySchema(db);
}

/** A v4 writer could only create the frozen v1 envelopes. Never promote v2 rows by changing gates. */
function assertV4ActualEnvelopes(db) {
  for (const [table, countLimit, bodyLimit, isRun] of [
    ["quality_actual_runs", 20, 2 * 1024 * 1024, true],
    ["quality_actual_budget_events", 1000, 32 * 1024, false],
    ["quality_actual_events", 640, 32 * 1024, false],
    ["quality_actual_requests", 1000, 4096, false],
  ]) {
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    if (!Number.isSafeInteger(count) || count > countLimit) fail("QUALITY_DATABASE_LIMIT");
    for (const row of db.prepare(`SELECT body FROM ${table}`).iterate()) {
      if (typeof row.body !== "string" || Buffer.byteLength(row.body, "utf8") > bodyLimit)
        fail("QUALITY_DATABASE_INVALID");
      let value;
      try {
        value = JSON.parse(row.body);
      } catch {
        fail("QUALITY_DATABASE_INVALID");
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (isRun ? value.schemaVersion !== 1 : Object.hasOwn(value, "schemaVersion"))
      )
        fail("QUALITY_DATABASE_INVALID");
    }
  }
}

/**
 * Caller owns BEGIN IMMEDIATE/COMMIT. Only known writer gates change; stored rows,
 * immutable triggers and table definitions retain their original bytes.
 */
export function migrateQualitySchemaV5(db) {
  const before = inspectQualitySchema(db, { allowEmpty: true });
  if (before.version > 5) fail("QUALITY_SCHEMA_UNSUPPORTED");
  if (before.version === 4) assertV4ActualEnvelopes(db);
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v5");
  if (before.version === 5) return before;
  for (const [table, sql] of Object.entries(qualityTableSql)) {
    if (before.tables.includes(table)) continue;
    db.exec(sql);
    for (const action of ["update", "delete"])
      db.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
  }
  if (before.version === 4)
    for (const name of Object.keys(qualityWriterTriggerSql)) db.exec(`DROP TRIGGER ${name}`);
  for (const sql of Object.values(qualityV5WriterTriggerSql)) db.exec(sql);
  return inspectQualitySchema(db);
}

/** Frozen v5 only knows reservation/cancellation records; v1 rows keep their old owner. */
function assertV5ReservationEnvelopes(db) {
  const read = (table, maximum, bodyMaximum) => {
    const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    if (!Number.isSafeInteger(count) || count > maximum) fail("QUALITY_DATABASE_LIMIT");
    return db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => {
        if (typeof row.body !== "string" || Buffer.byteLength(row.body, "utf8") > bodyMaximum)
          fail("QUALITY_DATABASE_INVALID");
        let value;
        try {
          value = JSON.parse(row.body);
        } catch {
          fail("QUALITY_DATABASE_INVALID");
        }
        if (!value || typeof value !== "object" || Array.isArray(value))
          fail("QUALITY_DATABASE_INVALID");
        return { row, value };
      });
  };
  const owners = new Map();
  for (const { row, value } of read("quality_actual_runs", 20, 2 * 1024 * 1024)) {
    if (row.id !== value.id || owners.has(value.id) || ![1, 2].includes(value.schemaVersion))
      fail("QUALITY_DATABASE_INVALID");
    owners.set(value.id, value.schemaVersion);
    if (value.schemaVersion === 2 && !providerSchemas.providerRunSchema.safeParse(value).success)
      fail("QUALITY_DATABASE_INVALID");
  }
  for (const [table, maximum, schemaName] of [
    ["quality_actual_budget_events", 1000, "providerBudgetEventSchema"],
    ["quality_actual_events", 640, "providerRunEventSchema"],
    ["quality_actual_requests", 1000, "providerReceiptSchema"],
  ]) {
    for (const { value } of read(
      table,
      maximum,
      table === "quality_actual_requests" ? 4096 : 32 * 1024,
    )) {
      if (value.schemaVersion === 2) {
        if (!providerSchemas[schemaName].safeParse(value).success) fail("QUALITY_DATABASE_INVALID");
        const ownerId = value.runId ?? value.payload?.runId;
        if (ownerId && owners.get(ownerId) !== 2) fail("QUALITY_DATABASE_INVALID");
      } else {
        if (Object.hasOwn(value, "schemaVersion")) fail("QUALITY_DATABASE_INVALID");
        const ownerId = value.runId ?? value.payload?.runId;
        if (ownerId && owners.get(ownerId) !== 1) fail("QUALITY_DATABASE_INVALID");
      }
    }
  }
  if (
    Number(db.prepare("SELECT COUNT(*) AS count FROM quality_actual_artifacts").get().count) > 140
  )
    fail("QUALITY_DATABASE_LIMIT");
  for (const row of db
    .prepare("SELECT run_id,artifact_key FROM quality_actual_artifacts")
    .iterate()) {
    const owner = owners.get(row.run_id);
    if (!owner || (owner === 2 && row.artifact_key !== "generation-request"))
      fail("QUALITY_DATABASE_INVALID");
  }
}

/** Shared by migration and backup: storage versions never retroactively admit newer rows. */
export function assertQualityLegacyLedgerRows(db, version) {
  if (version === 4) assertV4ActualEnvelopes(db);
  if (version === 5) assertV5ReservationEnvelopes(db);
}

/** Caller owns BEGIN IMMEDIATE/COMMIT; no row, body, hash or original BLOB is rewritten. */
export function migrateQualitySchemaV6(db) {
  const before = inspectQualitySchema(db, { allowEmpty: true });
  assertQualityLegacyLedgerRows(db, before.version);
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v6");
  if (before.version === 6) return before;
  for (const [table, sql] of Object.entries(qualityTableSql)) {
    if (before.tables.includes(table)) continue;
    db.exec(sql);
    for (const action of ["update", "delete"])
      db.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
  }
  const oldGates =
    before.version === 4
      ? qualityWriterTriggerSql
      : before.version === 5
        ? qualityV5WriterTriggerSql
        : {};
  for (const name of Object.keys(oldGates)) db.exec(`DROP TRIGGER ${name}`);
  for (const sql of Object.values(qualityV6WriterTriggerSql)) db.exec(sql);
  return inspectQualitySchema(db);
}
