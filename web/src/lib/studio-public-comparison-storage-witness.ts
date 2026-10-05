import "server-only";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { safePath, nativePaths, samePath, within } from "../../scripts/local-data-files.mjs";
import {
  acquireJournalLease,
  readJournalJson,
  writeJournalJson,
} from "../../scripts/local-journal-io.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { publicComparisonV11Columns } from "./studio-public-claim-comparison-database-v11-schema";
import type { PublicComparisonDatabaseSelection } from "./studio-public-claim-comparison-database";
import type { ComparisonReservationState } from "./studio-public-claim-comparison-reservation";
import {
  comparisonCompanyBinding,
  type ComparisonCompanyGuard,
} from "./studio-public-comparison-company-guard";
import {
  comparisonStorageFail as fail,
  checkComparisonDatabasePath,
  requireComparisonDatabaseHandle,
  comparisonFileIdentity,
  comparisonRootIdentity,
} from "./studio-public-comparison-file-identity";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ dev: z.string(), ino: z.string(), birthtimeNs: z.string() }).strict();
const pathsSchema = z
  .object({
    dataRoot: z.string(),
    qualityFile: z.string(),
    studioFile: z.string(),
    controlDirectory: z.string(),
  })
  .strict();
const tableSchema = z.enum([
  "quality_actual_runs",
  "quality_actual_events",
  "quality_actual_artifacts",
  "quality_actual_budget_events",
  "quality_actual_requests",
  "quality_provider_reservation_bindings",
]);
type Table = z.infer<typeof tableSchema>;
const keyCounts: Record<Table, number> = {
  quality_actual_runs: 1,
  quality_actual_events: 2,
  quality_actual_artifacts: 2,
  quality_actual_budget_events: 2,
  quality_actual_requests: 1,
  quality_provider_reservation_bindings: 1,
};
const rowSchema = z
  .object({
    table: tableSchema,
    keys: z
      .array(z.union([z.string().max(200), z.number().int().nonnegative().safe()]))
      .min(1)
      .max(2),
    digest: hash,
  })
  .strict();
export type ComparisonWitnessRow = z.infer<typeof rowSchema>;
const checkpointSchema = z
  .object({
    rawRowsDigest: hash,
    inventoryDigest: hash,
    archiveDigest: hash,
    coverageDigest: hash,
    cutoverDigest: hash,
    budgetRevision: z.number().int().nonnegative(),
    budgetHead: hash.nullable(),
  })
  .strict();
export type ComparisonWitnessCheckpoint = z.infer<typeof checkpointSchema>;
const bindingSchema = z
  .object({
    type: z.literal("binding"),
    paths: pathsSchema,
    rootIdentity: identity,
    qualityIdentity: identity,
    studioIdentity: identity,
    controlIdentity: identity,
    journalIdentity: identity,
    selection: z
      .object({
        databaseInstanceId: z.string().uuid(),
        environment: z.enum(["production", "synthetic-test"]),
        scopeId: z.string().max(200),
      })
      .strict(),
  })
  .strict();
const anchorSchema = z.object({ type: z.literal("anchor"), checkpoint: checkpointSchema }).strict();
const intentSchema = z
  .object({
    type: z.literal("intent"),
    operation: z.enum(["reserve", "cancel"]),
    nonce: z.string().uuid(),
    commandDigest: hash,
    runId: z.string().uuid(),
    before: checkpointSchema,
    expectedArchiveDigest: hash,
    rows: z.array(rowSchema).min(6).max(7),
  })
  .strict();
const ackSchema = z
  .object({
    type: z.literal("ack"),
    intentDigest: hash,
    receiptDigest: hash,
    checkpoint: checkpointSchema,
  })
  .strict();
const payloadSchema = z.discriminatedUnion("type", [
  bindingSchema,
  anchorSchema,
  intentSchema,
  ackSchema,
]);
const entrySchema = z
  .object({
    kind: z.literal("public-comparison-storage-witness"),
    recordVersion: z.literal(1),
    sequence: z.number().int().nonnegative().max(127),
    previousDigest: hash.nullable(),
    payload: payloadSchema,
    entryDigest: hash,
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
type Intent = z.infer<typeof intentSchema>;
export type ComparisonStorageSession = Readonly<{ kind: "comparison-storage-session" }>;
type Owned = {
  db: DatabaseSync;
  paths: z.infer<typeof pathsSchema>;
  selection: PublicComparisonDatabaseSelection;
  rootIdentity: z.infer<typeof identity>;
  qualityIdentity: z.infer<typeof identity>;
  active: boolean;
};
const sessions = new WeakMap<ComparisonStorageSession, Owned>();
const leases = new WeakMap<ComparisonStorageSession, ReturnType<typeof acquireJournalLease>>();
function own(token: ComparisonStorageSession) {
  const s = sessions.get(token);
  if (!s) fail("STORAGE_SESSION_INVALID");
  return s;
}
function directories(s: Owned) {
  return [s.paths.controlDirectory, join(s.paths.dataRoot, "comparison-storage-witness")];
}
function pathCheck(s: Owned) {
  checkComparisonDatabasePath(s.paths.dataRoot, s.paths.qualityFile);
  requireComparisonDatabaseHandle(s.db, s.paths.qualityFile);
  if (
    digest(s.rootIdentity) !== digest(comparisonRootIdentity(s.paths.dataRoot)) ||
    digest(s.qualityIdentity) !== digest(comparisonFileIdentity(s.paths.qualityFile))
  )
    fail("DATABASE_CHANGED");
}
export function openComparisonStorageSession(
  raw: unknown,
  selection: PublicComparisonDatabaseSelection,
): ComparisonStorageSession {
  assertPublicComparisonDataOnly(raw, 8192);
  assertPublicComparisonDataOnly(selection, 8192);
  const p = pathsSchema.parse(raw);
  for (const v of Object.values(p))
    if (!isAbsolute(v) || !samePath(resolve(v), v)) fail("STORAGE_PATH_INVALID");
  const paths = pathsSchema.parse(
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, resolve(v)])),
  );
  if (
    !within(paths.qualityFile, paths.dataRoot) ||
    !within(paths.studioFile, paths.dataRoot) ||
    samePath(paths.qualityFile, paths.studioFile) ||
    within(paths.controlDirectory, paths.dataRoot) ||
    within(paths.dataRoot, paths.controlDirectory) ||
    !samePath(dirname(paths.controlDirectory), dirname(paths.dataRoot))
  )
    fail("STORAGE_PATH_INVALID");
  checkComparisonDatabasePath(paths.dataRoot, paths.qualityFile);
  const rootIdentity = comparisonRootIdentity(paths.dataRoot),
    qualityIdentity = comparisonFileIdentity(paths.qualityFile);
  const db = new DatabaseSync(paths.qualityFile);
  try {
    const token = Object.freeze({ kind: "comparison-storage-session" as const });
    const s = {
      db,
      paths,
      selection: structuredClone(selection),
      rootIdentity,
      qualityIdentity,
      active: false,
    };
    pathCheck(s);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
    sessions.set(token, s);
    return token;
  } catch (e) {
    db.close();
    throw e;
  }
}
export function closeComparisonStorageSession(token: ComparisonStorageSession) {
  const s = own(token);
  if (s.active || s.db.isTransaction) fail("STORAGE_SESSION_BUSY");
  s.db.close();
  sessions.delete(token);
}
/** Internal composition receives a connection, never accepts a claimed path for an arbitrary handle. */
export function beginComparisonStorageSession(token: ComparisonStorageSession) {
  const s = own(token);
  if (s.active || s.db.isTransaction) fail("STORAGE_SESSION_BUSY");
  pathCheck(s);
  const lease = acquireJournalLease(s.paths.controlDirectory + ".lock", fail);
  leases.set(token, lease);
  s.active = true;
  return { db: s.db, selection: structuredClone(s.selection) };
}
export function endComparisonStorageSession(token: ComparisonStorageSession) {
  const s = own(token),
    lease = leases.get(token);
  if (!lease) fail("STORAGE_SESSION_INVALID");
  // Never remove a lease if an unconfirmed SQL transaction remains open.
  if (s.db.isTransaction) fail("STORAGE_RECOVERY_REQUIRED");
  lease.close();
  leases.delete(token);
  s.active = false;
}
function guard(token: ComparisonStorageSession) {
  const s = own(token),
    lease = leases.get(token);
  if (!s.active || !lease) fail("STORAGE_SESSION_INVALID");
  lease.guard();
  pathCheck(s);
  return s;
}
function entries(token: ComparisonStorageSession) {
  const s = guard(token),
    dirs = directories(s);
  for (const dir of dirs) safePath(dir, "directory");
  nativePaths(dirs);
  const names = dirs.map((dir) => readdirSync(dir).sort());
  if (!names[0].length || names[0].length > 128 || digest(names[0]) !== digest(names[1]))
    fail("WITNESS_PARTIAL");
  const result: Entry[] = [];
  let size = 0;
  for (let i = 0; i < names[0].length; i++) {
    const name = String(i).padStart(3, "0") + ".json";
    if (names[0][i] !== name) fail("WITNESS_INVALID");
    const a = entrySchema.parse(readJournalJson(join(dirs[0], name), 32768, fail));
    const b = entrySchema.parse(readJournalJson(join(dirs[1], name), 32768, fail));
    if (digest(a) !== digest(b)) fail("WITNESS_PARTIAL");
    size += Buffer.byteLength(JSON.stringify(a) + "\n");
    const { entryDigest, ...body } = a;
    if (
      a.sequence !== i ||
      a.previousDigest !== (result.at(-1)?.entryDigest ?? null) ||
      digest(body) !== entryDigest ||
      size > 4 * 1024 * 1024
    )
      fail("WITNESS_INVALID");
    result.push(a);
  }
  const binding = result[0].payload;
  if (
    binding.type !== "binding" ||
    result[1]?.payload.type !== "anchor" ||
    digest(binding.paths) !== digest(s.paths) ||
    digest(binding.selection) !== digest(s.selection) ||
    digest(binding.rootIdentity) !== digest(s.rootIdentity) ||
    digest(binding.qualityIdentity) !== digest(s.qualityIdentity) ||
    digest(binding.controlIdentity) !== digest(comparisonRootIdentity(dirs[0])) ||
    digest(binding.journalIdentity) !== digest(comparisonRootIdentity(dirs[1]))
  )
    fail("WITNESS_BINDING_CHANGED");
  for (let i = 2; i < result.length; i++) {
    const v = result[i].payload;
    if (i % 2 === 0 ? v.type !== "intent" : v.type !== "ack") fail("WITNESS_INVALID");
    if (v.type === "intent") {
      const prev = result[i - 1].payload;
      if (prev.type !== "anchor" && prev.type !== "ack") fail("WITNESS_INVALID");
      if (
        digest(v.before) !== digest(prev.checkpoint) ||
        v.rows.length !== (v.operation === "reserve" ? 7 : 6) ||
        v.rows.some((r) => r.keys.length !== keyCounts[r.table]) ||
        new Set(v.rows.map((r) => digest([r.table, r.keys]))).size !== v.rows.length
      )
        fail("WITNESS_INVALID");
    }
    if (v.type === "ack") {
      const intent = result[i - 1].payload;
      if (
        intent.type !== "intent" ||
        v.intentDigest !== result[i - 1].entryDigest ||
        v.checkpoint.archiveDigest !== intent.expectedArchiveDigest ||
        v.checkpoint.coverageDigest !== intent.before.coverageDigest ||
        v.checkpoint.cutoverDigest !== intent.before.cutoverDigest
      )
        fail("WITNESS_INVALID");
      const r = s.db
        .prepare("SELECT body FROM quality_actual_requests WHERE nonce=?")
        .get(intent.nonce);
      if (!r || typeof r.body !== "string" || digest(JSON.parse(r.body)) !== v.receiptDigest)
        fail("WITNESS_DATABASE_CHANGED");
    }
  }
  return result;
}
function append(
  token: ComparisonStorageSession,
  prior: Entry[],
  payload: z.infer<typeof payloadSchema>,
) {
  const s = guard(token);
  if (prior.length >= 128) fail("WITNESS_LIMIT");
  const body = {
    kind: "public-comparison-storage-witness" as const,
    recordVersion: 1 as const,
    sequence: prior.length,
    previousDigest: prior.at(-1)?.entryDigest ?? null,
    payload: payloadSchema.parse(payload),
  };
  const entry = entrySchema.parse({ ...body, entryDigest: digest(body) });
  const name = String(prior.length).padStart(3, "0") + ".json";
  // External control first, then DB-side witness. A half pair stays blocked.
  for (const dir of directories(s)) writeJournalJson(join(dir, name), entry, 32768, fail);
  return [...prior, entry];
}
function encode(value: unknown) {
  return JSON.stringify(value, (_k, v) =>
    v instanceof Uint8Array ? { blob: Buffer.from(v).toString("base64") } : v,
  );
}
export function comparisonWitnessRow(table: Table, values: unknown[]): ComparisonWitnessRow {
  return rowSchema.parse({
    table,
    keys: values.slice(0, keyCounts[table]),
    digest: digest(
      JSON.stringify([
        table,
        ...values.map((v) =>
          v instanceof Uint8Array ? { blob: Buffer.from(v).toString("base64") } : v,
        ),
      ]),
    ),
  });
}
/** Called only after the bounded exact-schema inspector in the same SQL transaction. */
export function comparisonWitnessInventory(db: DatabaseSync, exclude: ComparisonWitnessRow[] = []) {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  const h = createHash("sha256").update(encode(schema));
  for (const row of schema.filter((r) => r.type === "table")) {
    const table = String(row.name);
    if (!/^[a-z_]+$/.test(table)) fail("WITNESS_INVALID");
    h.update(encode(table));
    for (const record of db
      .prepare("SELECT rowid AS original_order,* FROM " + table + " ORDER BY rowid")
      .iterate()) {
      const ref = exclude.find(
        (r) =>
          r.table === table &&
          r.keys.every((k, i) => record[publicComparisonV11Columns[r.table][i]] === k),
      );
      if (ref) {
        const values = publicComparisonV11Columns[ref.table].map((k) => record[k]);
        if (comparisonWitnessRow(ref.table, values).digest !== ref.digest)
          fail("WITNESS_ROWS_CHANGED");
      } else h.update(encode(record));
    }
  }
  return h.digest("hex");
}
function requireRows(db: DatabaseSync, intent: Intent) {
  for (const ref of intent.rows) {
    const cols = publicComparisonV11Columns[ref.table];
    const result = db
      .prepare(
        "SELECT " +
          cols.join(",") +
          " FROM " +
          ref.table +
          " WHERE " +
          cols
            .slice(0, keyCounts[ref.table])
            .map((k) => k + "=?")
            .join(" AND "),
      )
      .all(...ref.keys);
    if (
      result.length !== 1 ||
      comparisonWitnessRow(
        ref.table,
        cols.map((k) => result[0][k]),
      ).digest !== ref.digest
    )
      fail("WITNESS_ROWS_CHANGED");
  }
}
export function initializeComparisonWitness(
  token: ComparisonStorageSession,
  checkpoint: ComparisonWitnessCheckpoint,
  state: ComparisonReservationState,
  company: ComparisonCompanyGuard,
) {
  const s = guard(token);
  if (state.archive.records.runs.length || state.bindings.length) fail("WITNESS_NONEMPTY");
  const studio = comparisonCompanyBinding(company);
  if (!samePath(studio.root, s.paths.dataRoot) || !samePath(studio.file, s.paths.studioFile))
    fail("COMPANY_ROOT_MISMATCH");
  if (directories(s).some(existsSync)) fail("WITNESS_ALREADY_EXISTS");
  for (const dir of directories(s)) mkdirSync(dir, { mode: 0o700 });
  const bound = append(token, [], {
    type: "binding",
    paths: s.paths,
    rootIdentity: s.rootIdentity,
    qualityIdentity: s.qualityIdentity,
    studioIdentity: studio.identity,
    controlIdentity: comparisonRootIdentity(directories(s)[0]),
    journalIdentity: comparisonRootIdentity(directories(s)[1]),
    selection: s.selection,
  });
  append(token, bound, { type: "anchor", checkpoint });
  return {
    source: "local-comparison-storage-witness" as const,
    initialized: true,
    dispatchAllowed: false,
  };
}
export function checkComparisonWitness(
  token: ComparisonStorageSession,
  checkpoint: ComparisonWitnessCheckpoint,
) {
  const list = entries(token),
    last = list.at(-1)!.payload;
  if (
    (last.type !== "anchor" && last.type !== "ack") ||
    digest(last.checkpoint) !== digest(checkpoint)
  )
    fail("WITNESS_RECONCILIATION_REQUIRED");
  return list;
}
export function checkComparisonWitnessCompany(
  token: ComparisonStorageSession,
  company: ComparisonCompanyGuard,
) {
  const list = entries(token),
    first = list[0].payload,
    s = own(token),
    studio = comparisonCompanyBinding(company);
  if (
    first.type !== "binding" ||
    !samePath(studio.root, s.paths.dataRoot) ||
    !samePath(studio.file, s.paths.studioFile) ||
    digest(studio.identity) !== digest(first.studioIdentity)
  )
    fail("COMPANY_FILE_CHANGED");
}
export function recordComparisonWitnessIntent(
  token: ComparisonStorageSession,
  checkpoint: ComparisonWitnessCheckpoint,
  intent: Omit<Intent, "type" | "before">,
) {
  const prior = checkComparisonWitness(token, checkpoint);
  if (prior.length + 2 > 128) fail("WITNESS_LIMIT");
  append(token, prior, { type: "intent", before: checkpoint, ...intent });
}
export function acknowledgeComparisonWitness(
  token: ComparisonStorageSession,
  checkpoint: ComparisonWitnessCheckpoint,
  state: ComparisonReservationState,
  cancellations: { clientRequestId: string }[],
) {
  const list = entries(token),
    entry = list.at(-1)!,
    intent = entry.payload,
    s = own(token);
  if (intent.type !== "intent") fail("WITNESS_RECONCILIATION_REQUIRED");
  const command =
    intent.operation === "reserve"
      ? state.bindings.find((b) => b.clientRequestId === intent.nonce)?.command
      : cancellations.find((c) => c.clientRequestId === intent.nonce);
  const receipt = state.archive.records.receipts.find((r) => r.clientRequestId === intent.nonce);
  if (
    !command ||
    digest(command) !== intent.commandDigest ||
    !receipt ||
    receipt.runId !== intent.runId ||
    checkpoint.archiveDigest !== intent.expectedArchiveDigest ||
    checkpoint.coverageDigest !== intent.before.coverageDigest ||
    checkpoint.cutoverDigest !== intent.before.cutoverDigest
  )
    fail("WITNESS_RECONCILIATION_REQUIRED");
  requireRows(s.db, intent);
  if (comparisonWitnessInventory(s.db, intent.rows) !== intent.before.inventoryDigest)
    fail("WITNESS_DATABASE_CHANGED");
  append(token, list, {
    type: "ack",
    intentDigest: entry.entryDigest,
    receiptDigest: digest(receipt),
    checkpoint,
  });
  checkComparisonWitness(token, checkpoint);
  return {
    source: "local-comparison-witness-reconciliation" as const,
    repairedFilesOnly: true,
    dispatchAllowed: false,
  };
}

export function checkComparisonWitnessPending(
  token: ComparisonStorageSession,
  nonce: string,
  commandDigest: string,
) {
  const list = entries(token),
    last = list.at(-1)!.payload;
  if (last.type !== "intent" || last.nonce !== nonce || last.commandDigest !== commandDigest)
    fail("WITNESS_RECONCILIATION_REQUIRED");
}
