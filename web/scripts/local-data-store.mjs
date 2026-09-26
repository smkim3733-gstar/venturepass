import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fail, limits, nativePaths, readPrefixSafe, safePath } from "./local-data-files.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const columns = {
  studio_cases: ["id", "revision", "evidence_revision", "body"],
  venture_accounts: ["case_id", "encrypted_payload", "masked_login_id", "revision", "updated_at"],
  venture_workflows: ["case_id", "revision", "body", "updated_at"],
};
export function inspectDatabasePaths(root) {
  const file = path.join(root, "studio.sqlite");
  safePath(root, "directory");
  const identity = safePath(file);
  const paths = [file];
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = file + suffix;
    try {
      lstatSync(sidecar);
      safePath(sidecar);
      paths.push(sidecar);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  nativePaths(paths);
  return identity;
}
export function openReadOnly(root) {
  const file = path.join(root, "studio.sqlite");
  inspectDatabasePaths(root);
  const header = readPrefixSafe(file, 100);
  if (header.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000")
    fail("DATABASE_INVALID");
  if (header[18] === 2 || header[19] === 2) {
    // A readonly WAL connection can otherwise create these files. Require the live
    // application's existing safe sidecars; never initialize them for a closed DB.
    for (const suffix of ["-wal", "-shm"]) {
      try {
        safePath(file + suffix);
      } catch (error) {
        if (error.code === "ENOENT") fail("SOURCE_WAL_NOT_READY");
        throw error;
      }
    }
  } else if (header[18] !== 1 || header[19] !== 1) fail("DATABASE_INVALID");
  const database = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
  return database;
}
/** Physical/relational checks only; app-level Zod validation is a separate restoration step. */
export function inspectDatabase(database) {
  database.exec("BEGIN");
  try {
    const count = database.prepare("PRAGMA page_count").get().page_count;
    const size = database.prepare("PRAGMA page_size").get().page_size;
    if (!Number.isSafeInteger(count) || count * size > limits.dbBytes) fail("DATABASE_LIMIT");
    if (
      database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      database.prepare("PRAGMA foreign_key_check").all().length
    )
      fail("DATABASE_INVALID");
    const schema = database
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    if (
      schema.length !== 3 ||
      schema.some((item) => item.type !== "table" || !Object.hasOwn(columns, item.name))
    )
      fail("DATABASE_SCHEMA_UNSUPPORTED");
    for (const [table, names] of Object.entries(columns)) {
      const actual = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (JSON.stringify(actual) !== JSON.stringify(names)) fail("DATABASE_SCHEMA_UNSUPPORTED");
    }
    const hash = createHash("sha256");
    hash.update(JSON.stringify(schema));
    const cases = new Set();
    const originals = [];
    let accounts = 0;
    let workflows = 0;
    for (const row of database
      .prepare("SELECT id,revision,evidence_revision,body FROM studio_cases ORDER BY id")
      .iterate()) {
      if (
        !uuid.test(row.id) ||
        [...cases].some((id) => id.toLowerCase() === row.id.toLowerCase()) ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        !Number.isSafeInteger(row.evidence_revision) ||
        row.evidence_revision < 0 ||
        row.evidence_revision > row.revision ||
        typeof row.body !== "string" ||
        Buffer.byteLength(row.body) > limits.caseBytes
      )
        fail("DATABASE_INVALID");
      cases.add(row.id);
      if (cases.size > limits.companies) fail("COMPANY_LIMIT");
      hash.update(JSON.stringify(row));
      let record;
      try {
        record = JSON.parse(row.body);
      } catch {
        fail("DATABASE_INVALID");
      }
      if (
        record.id !== row.id ||
        record.revision !== row.revision ||
        !Array.isArray(record.sources) ||
        record.sources.length > 40 ||
        !Array.isArray(record.plans) ||
        !Array.isArray(record.tasks)
      )
        fail("DATABASE_INVALID");
      if (record.sourceIntakes !== undefined) {
        if (
          !Array.isArray(record.sourceIntakes) ||
          record.sourceIntakes.length > 100 ||
          record.sourceIntakes.some(
            (item) => !item || typeof item !== "object" || typeof item.phase !== "string",
          )
        )
          fail("DATABASE_INVALID");
        // A crash may leave the owned file written before its source row is
        // finalized. Let the app reconcile that checkpoint before taking a
        // backup; otherwise the original inventory would be ambiguous.
        if (record.sourceIntakes.some((item) => item.phase === "storing_original"))
          fail("SOURCE_INTAKE_RECOVERY_REQUIRED");
      }
      const sourceIds = new Set();
      for (const source of record.sources) {
        if (
          !source ||
          !uuid.test(source.id) ||
          [...sourceIds].some((id) => id.toLowerCase() === source.id.toLowerCase()) ||
          !(source.originalName === null || typeof source.originalName === "string")
        )
          fail("DATABASE_INVALID");
        sourceIds.add(source.id);
        if (source.originalName !== null) {
          if (!source.originalName) fail("DATABASE_INVALID");
          originals.push(`originals/${row.id}/${source.id}.bin`);
          if (originals.length > limits.originals) fail("ORIGINAL_LIMIT");
        }
      }
    }
    for (const table of ["venture_accounts", "venture_workflows"]) {
      for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY case_id`).iterate()) {
        if (
          !cases.has(row.case_id) ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 1 ||
          typeof row.updated_at !== "string"
        )
          fail("DATABASE_INVALID");
        if (table === "venture_accounts") {
          accounts++;
          if (
            row.encrypted_payload !== null &&
            (!(row.encrypted_payload instanceof Uint8Array) || row.encrypted_payload.length > 32768)
          )
            fail("DATABASE_INVALID");
          if ((row.encrypted_payload === null) !== (row.masked_login_id === null))
            fail("DATABASE_INVALID");
        } else {
          workflows++;
          if (typeof row.body !== "string" || Buffer.byteLength(row.body) > limits.caseBytes)
            fail("DATABASE_INVALID");
        }
        hash.update(
          JSON.stringify(row, (_key, value) =>
            value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
          ),
        );
      }
    }
    database.exec("COMMIT");
    return {
      digest: hash.digest("hex"),
      companies: cases.size,
      accounts,
      workflows,
      originals: originals.sort(),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
export function inspectDirectory(root) {
  const before = inspectDatabasePaths(root);
  const database = openReadOnly(root);
  try {
    const result = inspectDatabase(database);
    const after = inspectDatabasePaths(root);
    if (before.dev !== after.dev || before.ino !== after.ino) fail("DATABASE_CHANGED");
    return result;
  } finally {
    database.close();
  }
}
