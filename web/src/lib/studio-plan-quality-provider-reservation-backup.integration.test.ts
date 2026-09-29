/** Production-shaped fixtures only, isolated from user files and all external transports. */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  backupQualityData,
  inspectQualityDatabase,
  migrateQualitySchemaV8,
  restoreQualityData,
  verifyQualityBackup,
} from "../../scripts/local-data-quality.mjs";
import {
  inspectQualitySchema,
  migrateQualitySchemaV4,
  migrateQualitySchemaV5,
  migrateQualitySchemaV6,
  migrateQualitySchemaV7,
  qualityLegacyTableSql,
  qualityImmutableTriggerSql,
  qualityV8TableSql,
  qualityV9TableSql,
  qualityV8WriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { inspectLedgerDatabase } from "./studio-plan-quality-ledger-database";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";
import {
  fixture,
  prepared,
  withRows,
  registry,
  refresh,
} from "./studio-plan-quality-provider-reservation-test-helpers";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
const databases: DatabaseSync[] = [],
  stores: PlanQualityStore[] = [];
let root: string;
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-reservation-v8-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-reservation-v8-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function connection(file = ":memory:") {
  const db = new DatabaseSync(file);
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
function migrate(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = migrateQualitySchemaV8(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function raw(db: DatabaseSync) {
  const schema = inspectQualitySchema(db, { allowEmpty: true });
  return {
    schema,
    rows: schema.tables.map((table) => [
      table,
      db.prepare(`SELECT rowid AS storage_order,* FROM ${table} ORDER BY rowid`).all(),
    ]),
  };
}
function insertBodies(
  db: DatabaseSync,
  table: string,
  columns: string,
  rows: unknown[],
  index: (r: Record<string, unknown>) => SQLInputValue[],
) {
  for (const value of rows) {
    const values = [
      ...index(value as Record<string, unknown>),
      JSON.stringify(value),
      digest(value),
    ];
    db.prepare(
      `INSERT INTO ${table}(${columns},body,body_hash) VALUES(${values.map(() => "?").join(",")})`,
    ).run(...values);
  }
}
function seed(db: DatabaseSync, ledger: ReturnType<typeof fixture>["current"]["ledger"]) {
  const receipt = {
    kind: "register-candidate-set",
    setId: registry.setId,
    version: registry.version,
    clientRequestId: registry.clientRequestId,
    versionDigest: registry.versionDigest,
    inputDigest: digest({
      kind: "register-candidate-set",
      setId: registry.setId,
      input: {
        expectedVersion: 0,
        clientRequestId: registry.clientRequestId,
        sourceDigest: registry.sourceDigest,
        acknowledgedCandidateStatus: true,
      },
    }),
  };
  insertBodies(db, "quality_candidate_versions", "set_id,version", [registry], (r) => [
    String(r.setId),
    Number(r.version),
  ]);
  insertBodies(db, "quality_candidate_requests", "nonce", [receipt], (r) => [
    String(r.clientRequestId),
  ]);
  insertBodies(
    db,
    "quality_provider_policies",
    "scope_id,revision,nonce",
    ledger.policies!,
    (r) => [String(r.scopeId), Number(r.revision), String(r.clientRequestId)],
  );
  insertBodies(
    db,
    "quality_actual_budget_events",
    "scope_id,revision",
    ledger.budgetEvents,
    (r) => [String(r.scopeId), Number(r.revision)],
  );
  insertBodies(db, "quality_actual_runs", "id", ledger.runs, (r) => [String(r.id)]);
  insertBodies(db, "quality_actual_events", "run_id,revision", ledger.events, (r) => [
    String(r.runId),
    Number(r.revision),
  ]);
  insertBodies(db, "quality_actual_requests", "nonce", ledger.receipts, (r) => [
    String(r.clientRequestId),
  ]);
  for (const item of ledger.artifacts) {
    const row = item as {
      runId: string;
      key: string;
      body: string;
      sha256: string;
      sizeBytes: number;
    };
    db.prepare("INSERT INTO quality_actual_artifacts VALUES(?,?,?,?,?)").run(
      row.runId,
      row.key,
      Buffer.from(row.body),
      row.sha256,
      row.sizeBytes,
    );
  }
}
function boundFixture(file?: string, legacy = false) {
  const db = connection(file),
    input = fixture();
  input.current.ledger.otherNonces = [registry.clientRequestId];
  refresh(input);
  const plan = prepared(input);
  withRows(input, plan);
  migrateQualitySchemaV7(db);
  if (!legacy) migrate(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    seed(db, input.current.ledger);
    if (!legacy)
      insertBodies(
        db,
        "quality_provider_reservation_bindings",
        "run_id,nonce",
        [plan.rows.binding],
        (r) => [String(r.runId), String(r.clientRequestId)],
      );
    inspectQualityDatabase(db, { inTransaction: true });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { db, input, plan };
}
function tamper(
  db: DatabaseSync,
  table: string,
  action: "delete" | "update",
  sql: string,
  values: SQLInputValue[] = [],
) {
  const name = `${table}_no_${action}`,
    trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.exec(trigger);
  }
}

it.each([0, 1, 2, 3, 4, 5, 6, 7])(
  "migrates exact v%i once and preserves the previous schema on rollback",
  (version) => {
    const db = connection();
    if (version >= 4)
      [
        migrateQualitySchemaV4,
        migrateQualitySchemaV5,
        migrateQualitySchemaV6,
        migrateQualitySchemaV7,
      ][version - 4](db);
    else if (version)
      for (const [table, sql] of Object.entries(qualityLegacyTableSql).slice(
        0,
        version === 1 ? 3 : version === 2 ? 5 : 8,
      )) {
        db.exec(sql);
        for (const action of ["update", "delete"])
          db.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
      }
    const before = raw(db);
    expect(() => migrateQualitySchemaV8(db)).toThrow("QUALITY_TRANSACTION_REQUIRED");
    db.exec("BEGIN IMMEDIATE");
    migrateQualitySchemaV8(db);
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(raw(db)).toEqual(before);
    expect(migrate(db).version).toBe(8);
    const current = raw(db);
    migrate(db);
    expect(raw(db)).toEqual(current);
    expect(inspectQualityDatabase(db)).toMatchObject({
      storageVersion: 8,
      providerReservationBindings: 0,
      providerReservationCoverage: 1,
    });
  },
);
it("captures only the audited legacy production prefix without rewriting original bytes", () => {
  const { db, plan } = boundFixture(undefined, true),
    before = raw(db);
  migrate(db);
  const after = raw(db);
  expect(after.rows.slice(0, 14)).toEqual(before.rows);
  expect(readProviderReservationDatabaseRows(db).coverage).toMatchObject({
    cutoverGlobalRunCount: 1,
    legacyProductionRuns: [{ runId: plan.rows.run.id, runDigest: plan.rows.run.runDigest }],
  });
  const once = raw(db);
  migrate(db);
  expect(raw(db)).toEqual(once);
});
it.each(["candidate-receipt", "native-hash"])(
  "refuses to grandfather corrupted %s records",
  (kind) => {
    const { db } = boundFixture(undefined, true);
    if (kind === "candidate-receipt")
      tamper(db, "quality_candidate_requests", "delete", "DELETE FROM quality_candidate_requests");
    else
      tamper(db, "quality_actual_runs", "update", "UPDATE quality_actual_runs SET body_hash=?", [
        "0".repeat(64),
      ]);
    const before = raw(db);
    expect(() => migrate(db)).toThrow();
    expect(raw(db)).toEqual(before);
  },
);
it("rolls all tables, gates and coverage back when coverage insertion fails", () => {
  const { db } = boundFixture(undefined, true),
    before = raw(db),
    prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO quality_provider_reservation_coverage"))
      vi.spyOn(statement, "run").mockImplementation(() => {
        throw new Error("Synthetic insert failure");
      });
    return statement;
  });
  expect(() => migrate(db)).toThrow("Synthetic insert failure");
  spy.mockRestore();
  expect(raw(db)).toEqual(before);
  expect(migrate(db).version).toBe(8);
});
it("blocks every v7 writer, including a prepared statement opened before migration", () => {
  const file = join(root, "old.sqlite"),
    old = connection(file),
    modern = connection(file);
  migrateQualitySchemaV7(old);
  const pending = old.prepare("INSERT INTO quality_actual_requests VALUES(?,?,?)");
  migrate(modern);
  expect(() => pending.run(randomUUID(), "{}", "hash")).toThrow("unsupported writer");
  for (const table of Object.keys(qualityV8TableSql))
    expect(() => old.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow("unsupported writer");
});
it("makes binding and coverage immutable and binds one existing native nonce without duplicating ownership", () => {
  const { db } = boundFixture();
  for (const table of [
    "quality_provider_reservation_bindings",
    "quality_provider_reservation_coverage",
  ]) {
    expect(() => db.exec(`UPDATE ${table} SET body='{}'`)).toThrow("immutable");
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow("immutable");
  }
  expect(inspectQualityDatabase(db)).toMatchObject({
    providerReservationBindings: 1,
    actualRuns: 1,
    actualRequests: 2,
  });
});
it.each([
  "coverage-missing",
  "binding-missing",
  "coverage-hash",
  "coverage-prefix",
  "binding-nonce",
  "binding-hash",
  "binding-order",
  "coverage-oversize",
  "binding-oversize",
])("rejects %s on migration, ordinary reads and backup inspection", (kind) => {
  const directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  const { db } = boundFixture(join(directory, "quality-evaluation", "quality.sqlite"));
  const store = new PlanQualityStore(directory);
  stores.push(store);
  const c = "quality_provider_reservation_coverage",
    b = "quality_provider_reservation_bindings";
  if (kind === "coverage-missing") tamper(db, c, "delete", `DELETE FROM ${c}`);
  else if (kind === "binding-missing") tamper(db, b, "delete", `DELETE FROM ${b}`);
  else if (kind === "coverage-hash")
    tamper(db, c, "update", `UPDATE ${c} SET body_hash=?`, ["0".repeat(64)]);
  else if (kind === "coverage-prefix") {
    const coverage = readProviderReservationDatabaseRows(db).coverage;
    coverage.cutoverGlobalRunCount = 1;
    coverage.coverageDigest = digest(
      Object.fromEntries(Object.entries(coverage).filter(([key]) => key !== "coverageDigest")),
    );
    tamper(db, c, "update", `UPDATE ${c} SET body=?,body_hash=?`, [
      JSON.stringify(coverage),
      digest(coverage),
    ]);
  } else if (kind === "binding-nonce") {
    db.exec("PRAGMA foreign_keys=OFF");
    tamper(db, b, "update", `UPDATE ${b} SET nonce=?`, [randomUUID()]);
  } else if (kind === "binding-hash")
    tamper(db, b, "update", `UPDATE ${b} SET body_hash=?`, ["0".repeat(64)]);
  else if (kind === "binding-order") tamper(db, b, "update", `UPDATE ${b} SET rowid=0`);
  else {
    const table = kind === "coverage-oversize" ? c : b;
    tamper(db, table, "update", `UPDATE ${table} SET body=?`, [
      " ".repeat(kind === "coverage-oversize" ? 8193 : 65537),
    ]);
  }
  const before = raw(db);
  expect(() => inspectQualityDatabase(db)).toThrow();
  expect(() => migrate(db)).toThrow();
  expect(raw(db)).toEqual(before);
  expect(() => store.list()).toThrow();
  expect(() => store.candidateRegistryList()).toThrow();
  expect(() => new PlanQualityStore(directory)).toThrow();
});
it("does not recreate missing coverage on an empty v8 database", () => {
  const db = connection();
  migrate(db);
  tamper(
    db,
    "quality_provider_reservation_coverage",
    "delete",
    "DELETE FROM quality_provider_reservation_coverage",
  );
  const before = raw(db);
  expect(() => migrate(db)).toThrow("QUALITY_DATABASE_INVALID");
  expect(raw(db)).toEqual(before);
});
it.each(["missing", "mixed"])("refuses %s v8 schema objects instead of repairing them", (kind) => {
  const db = connection();
  migrate(db);
  if (kind === "missing") db.exec("DROP TRIGGER quality_provider_reservation_bindings_v8_writer");
  else db.exec(qualityV8WriterTriggerSql.quality_runs_v8_writer.replaceAll("v8", "v9"));
  expect(() => migrate(db)).toThrow("QUALITY_SCHEMA_UNSUPPORTED");
});
it("accounts for original binding and coverage whitespace in the shared app storage budget", () => {
  const directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  const { db } = boundFixture(join(directory, "quality-evaluation", "quality.sqlite"));
  const b = "quality_provider_reservation_bindings",
    c = "quality_provider_reservation_coverage";
  const before = readProviderReservationDatabaseRows(db);
  tamper(db, b, "update", `UPDATE ${b} SET body=body || ?`, [" ".repeat(500)]);
  tamper(db, c, "update", `UPDATE ${c} SET body=body || ?`, [" ".repeat(500)]);
  expect(readProviderReservationDatabaseRows(db).usedBytes).toBe(before.usedBytes + 1000);
  const store = new PlanQualityStore(directory);
  stores.push(store);
  const total = Object.keys(qualityV9TableSql).reduce(
    (sum, table) =>
      sum +
      Number(
        db
          .prepare(
            `SELECT COALESCE(SUM(length(CAST(${table === "quality_actual_artifacts" ? "payload" : "body"} AS BLOB))),0) AS n FROM ${table}`,
          )
          .get()!.n,
      ),
    0,
  );
  // Include held storage slots by taking the native audit result, not a duplicate formula.
  const reservedBytes = inspectLedgerDatabase(db, () => registry).reservedBytes;
  const original = planQualityStoreLimits.totalBytes;
  try {
    Object.assign(planQualityStoreLimits, { totalBytes: total + reservedBytes - 1 });
    expect(() => store.list()).toThrow(/보관 용량/);
  } finally {
    Object.assign(planQualityStoreLimits, { totalBytes: original });
  }
});
it.each([false, true])(
  "round-trips %s legacy coverage and native bytes through v8 backup/restore",
  async (legacy) => {
    const directory = join(root, "source"),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
    mkdirSync(restored);
    const sentinel = "UNCHANGED SYNTHETIC COMPANY DATABASE";
    writeFileSync(join(directory, "studio.sqlite"), sentinel);
    writeFileSync(join(restored, "studio.sqlite"), sentinel);
    const { db } = boundFixture(join(directory, "quality-evaluation", "quality.sqlite"), legacy);
    migrate(db);
    const before = raw(db),
      snapshot = inspectQualityDatabase(db),
      bytes = readFileSync(join(directory, "quality-evaluation", "quality.sqlite"));
    await backupQualityData(directory, backup);
    expect(verifyQualityBackup(backup).manifest).toMatchObject({
      version: 8,
      providerReservationBindings: legacy ? 0 : 1,
      providerReservationCoverage: 1,
    });
    expect(restoreQualityData(backup, restored)).toMatchObject({
      providerReservationBindings: legacy ? 0 : 1,
      providerReservationCoverage: 1,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const copy = connection(join(restored, "quality-evaluation", "quality.sqlite"));
    expect(inspectQualityDatabase(copy)).toEqual(snapshot);
    expect(raw(copy)).toEqual(before);
    const store = new PlanQualityStore(restored);
    stores.push(store);
    expect(inspectQualityDatabase(copy).storageVersion).toBe(9);
    expect(raw(copy).rows.slice(0, 16)).toEqual(before.rows);
    expect(readFileSync(join(directory, "quality-evaluation", "quality.sqlite"))).toEqual(bytes);
    expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
    expect(store.candidateRegistryGet(1).versionDigest).toBe(registry.versionDigest);
  },
  150000,
);
it.each(["providerReservationBindings", "providerReservationCoverage"])(
  "rejects a resealed manifest with a changed %s count",
  async (field) => {
    const directory = join(root, "source"),
      backup = join(root, "backup");
    mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
    boundFixture(join(directory, "quality-evaluation", "quality.sqlite"));
    await backupQualityData(directory, backup);
    const file = join(backup, "quality-backup-manifest.json"),
      manifest = JSON.parse(readFileSync(file, "utf8"));
    manifest[field] = 0;
    const body = JSON.stringify(manifest);
    writeFileSync(file, body);
    writeFileSync(
      join(backup, "COMPLETE.json"),
      JSON.stringify({
        format: "venturepass-quality-backup-complete",
        manifestSha256: createHash("sha256").update(body).digest("hex"),
      }),
    );
    expect(() => verifyQualityBackup(backup)).toThrow();
  },
  150000,
);
it("restores a frozen v7 production backup unchanged before the app explicitly migrates it", async () => {
  const directory = join(root, "source"),
    backup = join(root, "v7-backup"),
    restored = join(root, "restored");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  mkdirSync(restored);
  const { db, plan } = boundFixture(join(directory, "quality-evaluation", "quality.sqlite"), true);
  const original = raw(db),
    snapshot = inspectQualityDatabase(db);
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 7 });
  restoreQualityData(backup, restored);
  const copy = connection(join(restored, "quality-evaluation", "quality.sqlite"));
  expect(raw(copy)).toEqual(original);
  expect(inspectQualityDatabase(copy)).toEqual(snapshot);
  const store = new PlanQualityStore(restored);
  stores.push(store);
  expect(readProviderReservationDatabaseRows(copy).coverage.legacyProductionRuns).toEqual([
    { runId: plan.rows.run.id, runDigest: plan.rows.run.runDigest },
  ]);
  expect(raw(copy).rows.slice(0, 14)).toEqual(original.rows);
  expect(inspectQualityDatabase(copy).storageVersion).toBe(9);
}, 150000);
it("does not publish a backup completion marker for missing bindings", async () => {
  const directory = join(root, "source"),
    backup = join(root, "invalid-backup");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  const { db } = boundFixture(join(directory, "quality-evaluation", "quality.sqlite"));
  tamper(
    db,
    "quality_provider_reservation_bindings",
    "delete",
    "DELETE FROM quality_provider_reservation_bindings",
  );
  await expect(backupQualityData(directory, backup)).rejects.toThrow();
  expect(existsSync(join(backup, "COMPLETE.json"))).toBe(false);
}, 150000);
