import "server-only";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  inspectQualitySchema,
  inspectQualitySchemaRows,
  qualityV9TableSql,
  qualityV9WriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  readPublicComparisonRows,
  decodePublicComparisonPrefix,
} from "./studio-public-claim-comparison-database-rows";
import {
  inspectPublicComparisonCoverage,
  inspectPublicComparisonNativeArchive,
  publicComparisonPrefixRowsSchema,
  publicComparisonBudgetEventSchema,
  type PublicComparisonPrefix,
  type PublicComparisonCoverage,
} from "./studio-public-claim-comparison-budget";
import { publicComparisonNativeRecordsSchema } from "./studio-public-claim-comparison-native";

import { publicComparisonV11InsertGates } from "./studio-public-claim-comparison-database-v11-schema";
import { comparisonReservationBindingSchema } from "./studio-public-claim-comparison-reservation";

import { publicComparisonV12InsertGates } from "./studio-public-claim-comparison-database-v12-schema";
import { comparisonTransmissionBindingSchema } from "./studio-public-claim-comparison-transmission-types";
const MiB = 1024 * 1024;
const table = "quality_provider_purpose_coverage";
const coverageSql = `CREATE TABLE ${table} (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, body_hash TEXT NOT NULL)`;
/** This read/migration version opens no execution writer, even to a v10 caller. */
export const publicComparisonV10InsertGates = Object.fromEntries(
  [...Object.keys(qualityV9TableSql), table].map((name) => [
    `${name}_v10_writer`,
    `CREATE TRIGGER ${name}_v10_writer BEFORE INSERT ON ${name} BEGIN SELECT RAISE(ABORT,'comparison writer unavailable'); END`,
  ]),
);
const immutableSql = Object.fromEntries(
  ["update", "delete"].map((action) => [
    `${table}_no_${action}`,
    `CREATE TRIGGER ${table}_no_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END`,
  ]),
);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const selectionSchema = z
  .object({
    databaseInstanceId: z.string().uuid(),
    environment: z.enum(["production", "synthetic-test"]),
    scopeId: z.enum([
      "candidate-quality-provider-v2-live",
      "candidate-quality-provider-v2-synthetic",
    ]),
  })
  .strict();
export type PublicComparisonDatabaseSelection = z.infer<typeof selectionSchema>;
type Rows = PublicComparisonPrefix["rows"];
const groups = ["budget", "runs", "runOrder", "events", "artifacts", "receipts"] as const;
type Group = (typeof groups)[number];
function rowKey(group: Group, row: Record<string, unknown>) {
  switch (group) {
    case "budget":
      return JSON.stringify([row.scope_id, row.revision]);
    case "runs":
      return JSON.stringify([row.id]);
    case "runOrder":
      return JSON.stringify([row.storage_order, row.id]);
    case "events":
      return JSON.stringify([row.run_id, row.revision]);
    case "artifacts":
      return JSON.stringify([row.run_id, row.artifact_key]);
    case "receipts":
      return JSON.stringify([row.nonce]);
  }
}
const inventorySchema = z
  .object({
    budget: z.array(z.string().max(300)).max(1000),
    runs: z.array(z.string().max(300)).max(20),
    runOrder: z.array(z.string().max(300)).max(20),
    events: z.array(z.string().max(300)).max(640),
    artifacts: z.array(z.string().max(300)).max(140),
    receipts: z.array(z.string().max(300)).max(1000),
  })
  .strict();
const cutoverSchema = z
  .object({
    schemaVersion: z.literal(3),
    storageVersion: z.literal(10),
    purpose: z.literal("compare-public-claim"),
    selection: selectionSchema,
    originalSchema: publicComparisonPrefixRowsSchema.shape.schema,
    originalActualKeys: inventorySchema,
    coverage: z.unknown(),
    cutoverDigest: hash,
  })
  .strict();
function fail(code = "PUBLIC_COMPARISON_DATABASE_INVALID"): never {
  throw Error(code);
}
function schemaRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}
function expectedSchema(original: Rows["schema"], version: 10 | 11 | 12) {
  const rows = original.filter((row) => !Object.hasOwn(qualityV9WriterTriggerSql, row.name));
  rows.push({ type: "table", name: table, tbl_name: table, sql: coverageSql });
  for (const [name, sql] of Object.entries({
    ...immutableSql,
    ...(version === 10
      ? publicComparisonV10InsertGates
      : version === 11
        ? publicComparisonV11InsertGates
        : publicComparisonV12InsertGates),
  })) {
    rows.push({
      type: "trigger",
      name,
      tbl_name: name.replace(/_no_(update|delete)$|_v(10|11|12)_writer$/g, ""),
      sql,
    });
  }
  return rows.sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
function checkPhysical(db: DatabaseSync) {
  if (!db.isTransaction) fail("PUBLIC_COMPARISON_TRANSACTION_REQUIRED");
  const pages = Number(db.prepare("PRAGMA page_count").get()!.page_count);
  const size = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  if (!Number.isSafeInteger(pages * size) || pages * size > 256 * MiB)
    fail("PUBLIC_COMPARISON_DATABASE_LIMIT");
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    fail();
}
function readCutover(db: DatabaseSync, version: 10 | 11 | 12 = 10) {
  const found = schemaRows(db);
  const row = found.find((v) => v.name === table);
  if (!row || row.type !== "table" || row.sql !== coverageSql)
    fail("PUBLIC_COMPARISON_SCHEMA_UNSUPPORTED");
  const counts = db
    .prepare(`SELECT COUNT(*) AS n, MAX(length(CAST(body AS BLOB))) AS bytes FROM ${table}`)
    .get()!;
  if (counts.n !== 1 || typeof counts.bytes !== "number" || counts.bytes > 2 * MiB) fail();
  const record = db.prepare(`SELECT id,body,body_hash FROM ${table}`).get()!;
  if (record.id !== 1 || typeof record.body !== "string") fail();
  const cutover = cutoverSchema.parse(JSON.parse(record.body));
  if (JSON.stringify(cutover) !== record.body || digest(cutover) !== record.body_hash) fail();
  const { cutoverDigest, ...payload } = cutover;
  if (
    digest(payload) !== cutoverDigest ||
    inspectQualitySchemaRows(cutover.originalSchema).version !== 9
  )
    fail();
  if (digest(found) !== digest(expectedSchema(cutover.originalSchema, version)))
    fail("PUBLIC_COMPARISON_SCHEMA_UNSUPPORTED");
  return { cutover, cutoverBytes: Buffer.byteLength(record.body) };
}
function splitActual(all: Rows["actualRows"], inventory: z.infer<typeof inventorySchema>) {
  const past = {} as Rows["actualRows"],
    next = {} as Rows["actualRows"];
  for (const group of groups) {
    const keys = new Set(inventory[group]);
    if (keys.size !== inventory[group].length) fail();
    const oldRows = all[group].filter((row) => keys.has(rowKey(group, row)));
    if (
      JSON.stringify(oldRows.map((row) => rowKey(group, row))) !== JSON.stringify(inventory[group])
    )
      fail();
    // No reordering, revision rewriting, or fabricated legacy envelopes.
    Object.assign(past, { [group]: oldRows });
    Object.assign(next, { [group]: all[group].filter((row) => !keys.has(rowKey(group, row))) });
  }
  if (
    past.runOrder.length &&
    next.runOrder.some((row) => row.storage_order <= past.runOrder.at(-1)!.storage_order)
  )
    fail();
  return { past, next };
}
function decodeBody(row: { body: string; body_hash: string }, maximum: number): unknown {
  if (Buffer.byteLength(row.body) > maximum) fail("PUBLIC_COMPARISON_DATABASE_LIMIT");
  const value: unknown = JSON.parse(row.body);
  if (digest(value) !== row.body_hash) fail();
  return value;
}
function decodeNative(rows: Rows["actualRows"]) {
  const unorderedRuns = rows.runs.map((row) => {
    const value = publicComparisonNativeRecordsSchema.shape.runs.element.parse(
      decodeBody(row, 2 * MiB),
    );
    if (value.id !== row.id) fail();
    return value;
  });
  const runs = rows.runOrder.map((row) => {
    const run = unorderedRuns.find((v) => v.id === row.id);
    if (!run) fail();
    return run;
  });
  if (
    new Set(runs.map((v) => v.id)).size !== unorderedRuns.length ||
    runs.length !== unorderedRuns.length
  )
    fail();
  const events = rows.events.map((row) => {
    const value = publicComparisonNativeRecordsSchema.shape.events.element.parse(
      decodeBody(row, 32 * 1024),
    );
    if (value.runId !== row.run_id || value.revision !== row.revision) fail();
    return value;
  });
  const receipts = rows.receipts.map((row) => {
    const value = publicComparisonNativeRecordsSchema.shape.receipts.element.parse(
      decodeBody(row, 4096),
    );
    if (value.clientRequestId !== row.nonce) fail();
    return value;
  });
  const artifacts = rows.artifacts.map((row) => {
    if (
      row.payload.byteLength !== row.size_bytes ||
      createHash("sha256").update(row.payload).digest("hex") !== row.sha256
    )
      fail();
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(row.payload);
    return {
      runId: row.run_id,
      key: row.artifact_key,
      body,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
    };
  });
  const budget = rows.budget.map((row) => {
    const value = publicComparisonBudgetEventSchema.parse(decodeBody(row, 32 * 1024));
    if (value.scopeId !== row.scope_id || value.revision !== row.revision) fail();
    return value;
  });
  // A native receipt is the only nonce owner. These values are an in-memory projection.
  const financialReceipts = budget.map((event) => {
    const matching = receipts.filter((r) => r.budgetOperationDigest === event.eventDigest);
    if (matching.length !== 1) fail();
    const r = matching[0];
    return {
      schemaVersion: 3 as const,
      purpose: "compare-public-claim" as const,
      scopeId: event.scopeId,
      clientRequestId: r.clientRequestId,
      runId: r.runId,
      inputDigest: r.inputDigest,
      budgetRevision: event.revision,
      operationDigest: event.eventDigest,
      recordedAt: r.recordedAt,
    };
  });
  return {
    records: publicComparisonNativeRecordsSchema.parse({ runs, events, receipts, artifacts }),
    financial: { events: budget, receipts: financialReceipts },
  };
}
/** Internal snapshot reader. Caller must own the transaction; version remains explicit. */
export function readPublicComparisonDatabaseSnapshot(
  db: DatabaseSync,
  expectedSelection: PublicComparisonDatabaseSelection,
  version: 10 | 11 | 12,
) {
  checkPhysical(db);
  const { cutover, cutoverBytes } = readCutover(db, version);
  if (digest(cutover.selection) !== digest(selectionSchema.parse(expectedSelection)))
    fail("PUBLIC_COMPARISON_IDENTITY_MISMATCH");
  const rows = readPublicComparisonRows(db, cutover.originalSchema, version >= 11, version === 12);
  const rawRowsDigest = createHash("sha256")
    .update(
      JSON.stringify(
        {
          rows,
          coverageRow: db
            .prepare("SELECT id,body,body_hash FROM quality_provider_purpose_coverage ORDER BY id")
            .all(),
          schema: schemaRows(db),
        },
        (_key, value) =>
          value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : value,
      ),
    )
    .digest("hex");
  const { past, next } = splitActual(rows.actualRows, cutover.originalActualKeys);
  const bindingRows =
    version >= 11
      ? rows.reservationRows.bindingRows.filter((row) => JSON.parse(row.body).recordVersion === 3)
      : [];
  const legacyBindings = rows.reservationRows.bindingRows.filter(
    (row) => !bindingRows.includes(row),
  );
  if (
    legacyBindings.length &&
    bindingRows.some((row) => row.storage_order <= legacyBindings.at(-1)!.storage_order)
  )
    fail();
  const bindings = bindingRows.map((row) => {
    const binding = comparisonReservationBindingSchema.parse(decodeBody(row, 64 * 1024));
    if (row.run_id !== binding.runId || row.nonce !== binding.clientRequestId) fail();
    return binding;
  });
  const transmissionRows =
    version === 12
      ? rows.transmissionRows.bindingRows.filter((r) => JSON.parse(r.body).recordVersion === 3)
      : [];
  const legacyTransmissions = rows.transmissionRows.bindingRows.filter(
    (r) => !transmissionRows.includes(r),
  );
  if (
    legacyTransmissions.length &&
    transmissionRows.some((r) => r.storage_order <= legacyTransmissions.at(-1)!.storage_order)
  )
    fail();
  const transmissionBindings = transmissionRows.map((row) => {
    const b = comparisonTransmissionBindingSchema.parse(decodeBody(row, 64 * 1024));
    if (row.run_id !== b.runId || row.nonce !== b.clientRequestId) fail();
    return b;
  });
  const prefix = decodePublicComparisonPrefix(
    {
      ...rows,
      actualRows: past,
      reservationRows: { ...rows.reservationRows, bindingRows: legacyBindings },
      transmissionRows: { ...rows.transmissionRows, bindingRows: legacyTransmissions },
    },
    cutover.selection,
  );
  const coverage = inspectPublicComparisonCoverage(prefix, cutover.coverage);
  const archive = decodeNative(next);
  const overhead = (list: { body: string }[]) =>
    list.reduce(
      (sum, row) =>
        sum +
        Math.max(
          0,
          Buffer.byteLength(row.body) - Buffer.byteLength(JSON.stringify(JSON.parse(row.body))),
        ),
      0,
    );
  const nativeRawOverheadBytes = overhead(
    [next.runs, next.events, next.receipts, next.budget].flat(),
  );
  const bindingRawOverheadBytes = overhead(bindingRows);
  return {
    cutover,
    cutoverBytes,
    prefix,
    coverage,
    archive,
    bindings,
    nativeRawOverheadBytes,
    bindingRawOverheadBytes,
    transmissionBindings,
    transmissionRawOverheadBytes: overhead(transmissionRows),
    rawRowsDigest,
  };
}
function inspectInTransaction(
  db: DatabaseSync,
  expectedSelection: PublicComparisonDatabaseSelection,
) {
  const { cutover, cutoverBytes, prefix, coverage, archive, nativeRawOverheadBytes } =
    readPublicComparisonDatabaseSnapshot(db, expectedSelection, 10);
  const inspected = inspectPublicComparisonNativeArchive(prefix, coverage, archive);
  // The pure audit already counts the proposal. Count the larger SQL cutover envelope once.
  const extraBytes =
    Math.max(0, cutoverBytes - inspected.capacity.coverageBytes) + nativeRawOverheadBytes;
  if (
    inspected.capacity.prefixUsedBytes +
      inspected.capacity.coverageBytes +
      inspected.capacity.comparisonUsedBytes +
      inspected.capacity.comparisonHeldBytes +
      extraBytes >
    256 * MiB
  )
    fail("PUBLIC_COMPARISON_DATABASE_LIMIT");
  return {
    source: "local-comparison-database-read" as const,
    storageVersion: 10 as const,
    cutoverDigest: cutover.cutoverDigest,
    cutoverBytes,
    nativeRawOverheadBytes,
    archive: inspected,
    // DB structure and transaction reads do not authenticate a restored file or past execution.
    fileIdentityVerified: false as const,
    dispatchAllowed: false as const,
  };
}
/** Caller supplies an already-open, explicitly selected DB. No path/config/SDK/company I/O.
 * A separate read transaction prevents reporting caller-owned uncommitted rows as persisted. */
export function inspectPublicComparisonDatabase(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
) {
  if (db.isTransaction) fail("PUBLIC_COMPARISON_TRANSACTION_ACTIVE");
  db.exec("BEGIN");
  try {
    const result = inspectInTransaction(db, selection);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
/** Explicit v9-only cutover, not called by PlanQualityStore. All execution inserts remain closed.
 * Expected coverage is produced before this call; stale/changed bytes abort before DDL. */
export function migratePublicComparisonDatabaseV10(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  expectedCoverage: PublicComparisonCoverage,
) {
  if (db.isTransaction) fail("PUBLIC_COMPARISON_TRANSACTION_ACTIVE");
  const selected = selectionSchema.parse(selection);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (schemaRows(db).some((row) => row.name === table)) {
      const inspection = inspectInTransaction(db, selected);
      const { cutover } = readCutover(db);
      if (digest(cutover.coverage) !== digest(expectedCoverage))
        fail("PUBLIC_COMPARISON_COVERAGE_MISMATCH");
      db.exec("COMMIT");
      return { status: "already-v10" as const, inspection };
    }
    checkPhysical(db);
    if (inspectQualitySchema(db).version !== 9) fail("PUBLIC_COMPARISON_SCHEMA_UNSUPPORTED");
    inspectQualityDatabase(db, { inTransaction: true });
    const rows = readPublicComparisonRows(db, inspectQualitySchema(db).schema);
    const prefix = decodePublicComparisonPrefix(rows, selected);
    const coverage = inspectPublicComparisonCoverage(prefix, expectedCoverage);
    const originalActualKeys = inventorySchema.parse(
      Object.fromEntries(
        groups.map((group) => [group, rows.actualRows[group].map((row) => rowKey(group, row))]),
      ),
    );
    const payload = {
      schemaVersion: 3 as const,
      storageVersion: 10 as const,
      purpose: "compare-public-claim" as const,
      selection: selected,
      originalSchema: rows.schema,
      originalActualKeys,
      coverage,
    };
    const cutover = cutoverSchema.parse({ ...payload, cutoverDigest: digest(payload) });
    const body = JSON.stringify(cutover);
    if (Buffer.byteLength(body) > 2 * MiB) fail("PUBLIC_COMPARISON_DATABASE_LIMIT");
    db.exec(coverageSql);
    db.prepare(`INSERT INTO ${table}(id,body,body_hash) VALUES(1,?,?)`).run(body, digest(cutover));
    for (const name of Object.keys(qualityV9WriterTriggerSql)) db.exec(`DROP TRIGGER ${name}`);
    for (const sql of Object.values({ ...immutableSql, ...publicComparisonV10InsertGates }))
      db.exec(sql);
    const inspection = inspectInTransaction(db, selected);
    db.exec("COMMIT");
    return { status: "migrated" as const, inspection };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
