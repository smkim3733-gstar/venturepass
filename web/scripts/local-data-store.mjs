import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fail, limits, nativePaths, readPrefixSafe, safePath } from "./local-data-files.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const columns = {
  studio_cases: ["id", "revision", "evidence_revision", "body"],
  venture_accounts: ["case_id", "encrypted_payload", "masked_login_id", "revision", "updated_at"],
  venture_workflows: ["case_id", "revision", "body", "updated_at"],
};
const preparedTable = "studio_prepared_packages";
const preparedSql =
  "CREATE TABLE studio_prepared_packages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES studio_cases(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0), client_request_id TEXT NOT NULL, request_digest TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, archive BLOB NOT NULL, UNIQUE(case_id, version), UNIQUE(case_id, client_request_id))";
const preparedColumns = [
  "id",
  "case_id",
  "version",
  "client_request_id",
  "request_digest",
  "body",
  "body_sha256",
  "archive",
];
const preparedLimits = { count: 20, metadata: 2 * 1024 * 1024, zip: 28 * 1024 * 1024 };
const hashString = z.string().regex(/^[a-f0-9]{64}$/);
const uuidString = z.string().regex(uuid);
const revisionNumber = z.number().int().nonnegative().safe();
const sourceIdsSchema = z
  .array(uuidString)
  .max(10)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length);
const requestSchema = z
  .object({
    revision: revisionNumber,
    planId: uuidString,
    sourceIds: sourceIdsSchema,
    clientRequestId: uuidString,
  })
  .strict();
// This envelope verifies historical bindings and bytes, not current application
// eligibility or review rules. Full app-schema validation remains an app concern.
const preparedEnvelope = z
  .object({
    id: uuidString,
    version: z.number().int().min(1).max(preparedLimits.count),
    caseId: uuidString,
    caseRevision: revisionNumber,
    clientRequestId: uuidString,
    requestDigest: hashString,
    input: requestSchema,
    createdAt: z.string().datetime(),
    scope: z.literal("local-preparation-only"),
    company: z
      .object({ profile: z.record(z.string(), z.unknown()), snapshotSha256: hashString })
      .strict(),
    plan: z
      .object({
        id: uuidString,
        version: z.number().int().positive(),
        content: z.record(z.string(), z.unknown()),
        contentSha256: hashString,
        review: z.array(z.unknown()),
        confirmedAt: z.string().nullable(),
      })
      .passthrough(),
    sourceIds: sourceIdsSchema,
    sources: z
      .array(
        z
          .object({
            source: z.object({ id: uuidString, originalName: z.string().min(1) }).passthrough(),
            sourceSha256: hashString,
            textSha256: hashString,
            originalSha256: hashString,
            originalSizeBytes: z
              .number()
              .int()
              .min(1)
              .max(12 * 1024 * 1024),
          })
          .strict(),
      )
      .max(10),
    review: z
      .object({
        storedFindings: z.array(z.unknown()),
        currentRuleFindings: z.array(z.unknown()),
        confirmedAt: z.string().nullable(),
        unconfirmedSectionKeys: z.array(z.string()).max(20),
        currentEvidence: z.boolean(),
        latestPlanVersion: z.boolean(),
        draft: z.boolean(),
        draftReasons: z.array(z.string().max(100)),
      })
      .strict(),
    zip: z
      .object({
        fileName: z.literal("venturepass-preparation-package.zip"),
        sha256: hashString,
        sizeBytes: z.number().int().min(1).max(preparedLimits.zip),
      })
      .strict(),
  })
  .strict();
const sha = (value) => createHash("sha256").update(value).digest("hex");
const normalizeSql = (sql) =>
  sql
    .replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "")
    .replace(/\s+/g, "")
    .replace(/;$/, "")
    .toLowerCase();
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const sameJson = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function inspectPreparedRows(database, cases, revisions, hash) {
  const count = database.prepare(`SELECT COUNT(*) AS count FROM ${preparedTable}`).get().count;
  if (!Number.isSafeInteger(count) || count > cases.size * preparedLimits.count)
    fail("DATABASE_INVALID");
  const ids = new Set(),
    nonces = new Set(),
    versions = new Map();
  for (const row of database
    .prepare(`SELECT * FROM ${preparedTable} ORDER BY case_id,version`)
    .iterate()) {
    if (
      !cases.has(row.case_id) ||
      !uuid.test(row.id) ||
      !uuid.test(row.client_request_id) ||
      typeof row.body !== "string" ||
      Buffer.byteLength(row.body) > preparedLimits.metadata ||
      !/^[a-f0-9]{64}$/.test(row.body_sha256) ||
      sha(row.body) !== row.body_sha256 ||
      !(row.archive instanceof Uint8Array) ||
      row.archive.length > preparedLimits.zip
    )
      fail("DATABASE_INVALID");
    let record;
    try {
      record = preparedEnvelope.parse(JSON.parse(row.body));
    } catch {
      fail("DATABASE_INVALID");
    }
    const nextVersion = (versions.get(row.case_id) ?? 0) + 1;
    const nonce = `${row.case_id.toLowerCase()}:${row.client_request_id.toLowerCase()}`;
    if (
      ids.has(row.id.toLowerCase()) ||
      nonces.has(nonce) ||
      row.version !== nextVersion ||
      record.id !== row.id ||
      record.caseId !== row.case_id ||
      record.version !== row.version ||
      record.caseRevision > revisions.get(row.case_id) ||
      record.caseRevision !== record.input.revision ||
      record.clientRequestId !== row.client_request_id ||
      record.input.clientRequestId !== row.client_request_id ||
      record.requestDigest !== row.request_digest ||
      sha(JSON.stringify(record.input)) !== row.request_digest ||
      record.input.planId !== record.plan.id ||
      sha(JSON.stringify(record.plan.content)) !== record.plan.contentSha256 ||
      !sameJson(record.sourceIds, record.input.sourceIds) ||
      record.sources.length !== record.sourceIds.length ||
      record.sources.some(
        (item, i) => item.source.id !== record.sourceIds[i] || Object.hasOwn(item.source, "text"),
      ) ||
      record.sources.reduce((total, item) => total + item.originalSizeBytes, 0) >
        24 * 1024 * 1024 ||
      !sameJson(record.review.storedFindings, record.plan.review) ||
      record.review.confirmedAt !== record.plan.confirmedAt ||
      record.zip.sizeBytes !== row.archive.length ||
      record.zip.sha256 !== sha(row.archive)
    )
      fail("DATABASE_INVALID");
    ids.add(row.id.toLowerCase());
    nonces.add(nonce);
    versions.set(row.case_id, row.version);
    // Hash BLOB bytes without base64/JSON expansion. The scalar row includes its
    // boundaries; the same deterministic sequence is checked before/after copy.
    const { archive, ...metadata } = row;
    hash.update(JSON.stringify(metadata));
    hash.update(archive);
  }
}
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
    const prepared = schema.find((item) => item.name === preparedTable);
    if (
      schema.length !== (prepared ? 4 : 3) ||
      schema.some(
        (item) =>
          item.type !== "table" ||
          (!Object.hasOwn(columns, item.name) && item.name !== preparedTable),
      ) ||
      (prepared &&
        (prepared.tbl_name !== preparedTable ||
          normalizeSql(prepared.sql) !== normalizeSql(preparedSql)))
    )
      fail("DATABASE_SCHEMA_UNSUPPORTED");
    for (const [table, names] of Object.entries(
      prepared ? { ...columns, [preparedTable]: preparedColumns } : columns,
    )) {
      const actual = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      if (JSON.stringify(actual) !== JSON.stringify(names)) fail("DATABASE_SCHEMA_UNSUPPORTED");
    }
    const hash = createHash("sha256");
    hash.update(JSON.stringify(schema));
    const cases = new Set();
    const revisions = new Map();
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
      revisions.set(row.id, row.revision);
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
    if (prepared) inspectPreparedRows(database, cases, revisions, hash);
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
