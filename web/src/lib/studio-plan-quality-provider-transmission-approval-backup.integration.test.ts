/** Only temporary production-shaped synthetic data; no user database or provider calls. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  backupQualityData,
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  migrateQualitySchemaV8,
  migrateQualitySchemaV9,
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
  qualityV9TableSql,
  qualityV9WriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { PlanQualityStore } from "./studio-plan-quality-store";
import {
  inspectLedgerDatabase,
  readLedgerDatabaseInput,
} from "./studio-plan-quality-ledger-database";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";
import {
  fixture,
  prepared,
  withRows,
  registry,
  refresh,
  config,
} from "./studio-plan-quality-provider-reservation-test-helpers";
import {
  transmissionCommandFor,
  transmissionReview,
} from "./studio-plan-quality-provider-transmission-test-helpers";
import {
  prepareProviderTransmissionApproval,
  type ProviderTransmissionWritePlan,
} from "./studio-plan-quality-provider-transmission-plan";
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
  root = mkdtempSync(join(tmpdir(), "venture-transmission-v9-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-transmission-v9-") || rel.includes(".."))
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
    const v = migrateQualitySchemaV9(db);
    db.exec("COMMIT");
    return v;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function raw(db: DatabaseSync) {
  const schema = inspectQualitySchema(db, { allowEmpty: true });
  return {
    schema,
    rows: schema.tables.map((table: string) => [
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
function boundFixture(file?: string) {
  const db = connection(file),
    input = fixture();
  input.current.ledger.otherNonces = [registry.clientRequestId];
  refresh(input);
  const reservation = prepared(input);
  withRows(input, reservation);
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateQualitySchemaV8(db);
    seed(db, input.current.ledger);
    insertBodies(
      db,
      "quality_provider_reservation_bindings",
      "run_id,nonce",
      [reservation.rows.binding],
      (r) => [String(r.runId), String(r.clientRequestId)],
    );
    inspectQualityDatabase(db, { inTransaction: true });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { db, reservation };
}
function approval(db: DatabaseSync) {
  const ledger = readLedgerDatabaseInput(db, () => registry),
    rows = readProviderReservationDatabaseRows(db);
  const archive = { ledger, coverage: rows.coverage, records: rows.records };
  const current = {
    selection: { runId: rows.records[0].runId, runDigest: rows.records[0].runDigest },
    archive,
    configuration: config(),
    inspectedAt: "2026-09-27T03:33:00.000Z",
  };
  const review = transmissionReview(current),
    command = transmissionCommandFor(review);
  const result = prepareProviderTransmissionApproval({
    command,
    review,
    current: { ...current, inspectedAt: "2026-09-27T03:34:00.000Z" },
    additionalUsedBytes: 0,
  });
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function insertApproval(
  db: DatabaseSync,
  plan: ProviderTransmissionWritePlan,
  binding: boolean,
  audit = true,
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    insertBodies(db, "quality_actual_events", "run_id,revision", [plan.rows.event], (r) => [
      String(r.runId),
      Number(r.revision),
    ]);
    insertBodies(db, "quality_actual_requests", "nonce", [plan.rows.receipt], (r) => [
      String(r.clientRequestId),
    ]);
    if (binding)
      insertBodies(
        db,
        "quality_provider_transmission_bindings",
        "run_id,nonce",
        [plan.rows.binding],
        (r) => [String(r.runId), String(r.clientRequestId)],
      );
    if (audit) inspectQualityDatabase(db, { inTransaction: true });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function tamper(
  db: DatabaseSync,
  table: string,
  action: "update" | "delete",
  sql: string,
  args: SQLInputValue[] = [],
) {
  const name = `${table}_no_${action}`,
    trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.exec(trigger);
  }
}
function source() {
  const directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  return { directory, file: join(directory, "quality-evaluation", "quality.sqlite") };
}
it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
  "migrates exact v%i atomically, retaining all previous definitions and row bytes",
  (version) => {
    const db = connection();
    if (version >= 4 && version <= 7)
      [
        migrateQualitySchemaV4,
        migrateQualitySchemaV5,
        migrateQualitySchemaV6,
        migrateQualitySchemaV7,
      ][version - 4](db);
    else if (version === 8) {
      db.exec("BEGIN IMMEDIATE");
      migrateQualitySchemaV8(db);
      db.exec("COMMIT");
    } else if (version)
      for (const [table, sql] of Object.entries(qualityLegacyTableSql).slice(
        0,
        version === 1 ? 3 : version === 2 ? 5 : 8,
      )) {
        db.exec(sql);
        for (const action of ["update", "delete"])
          db.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
      }
    const before = raw(db);
    expect(() => migrateQualitySchemaV9(db)).toThrow("QUALITY_TRANSACTION_REQUIRED");
    db.exec("BEGIN IMMEDIATE");
    migrateQualitySchemaV9(db);
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(raw(db)).toEqual(before);
    expect(migrate(db).version).toBe(9);
    const after = raw(db);
    expect(after.schema.tables).toHaveLength(18);
    expect(after.schema.schema).toHaveLength(72);
    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
    migrate(db);
    expect(raw(db)).toEqual(after);
    expect(inspectQualityDatabase(db)).toMatchObject({
      storageVersion: 9,
      providerTransmissionBindings: 0,
      providerTransmissionCoverage: 1,
    });
  },
);
it.each([false, true])(
  "freezes exact pre-migration approval events, existing approval=%s",
  (approved) => {
    const { db } = boundFixture(),
      plan = approval(db);
    if (approved) insertApproval(db, plan, false);
    const before = raw(db);
    migrate(db);
    expect(raw(db).rows.slice(0, 16)).toEqual(before.rows);
    const coverage = readProviderTransmissionApprovalDatabaseRows(db).coverage;
    expect(coverage.cutoverProviderEvents[0].eventCount).toBe(approved ? 1 : 0);
    expect(coverage.legacyProductionApprovals).toHaveLength(approved ? 1 : 0);
    const once = raw(db);
    migrate(db);
    expect(raw(db)).toEqual(once);
    if (!approved) {
      expect(() => insertApproval(db, plan, false)).toThrow();
      expect(raw(db)).toEqual(once);
      insertApproval(db, plan, true);
      expect(inspectQualityDatabase(db).providerTransmissionBindings).toBe(1);
    }
  },
);
it.each(["candidate-receipt", "reservation-binding", "native-hash"])(
  "refuses to grandfather corrupt %s",
  (kind) => {
    const { db } = boundFixture();
    if (kind === "native-hash")
      tamper(db, "quality_actual_runs", "update", "UPDATE quality_actual_runs SET body_hash=?", [
        "0".repeat(64),
      ]);
    else {
      const table =
        kind === "candidate-receipt"
          ? "quality_candidate_requests"
          : "quality_provider_reservation_bindings";
      tamper(db, table, "delete", `DELETE FROM ${table}`);
    }
    const before = raw(db);
    expect(() => migrate(db)).toThrow();
    expect(raw(db)).toEqual(before);
  },
);
it("rolls back tables, triggers and both migration markers if approval coverage insertion fails", () => {
  const db = connection();
  migrateQualitySchemaV7(db);
  const before = raw(db),
    prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO quality_provider_transmission_coverage"))
      vi.spyOn(statement, "run").mockImplementation(() => {
        throw new Error("Synthetic coverage failure");
      });
    return statement;
  });
  expect(() => migrate(db)).toThrow("Synthetic coverage failure");
  spy.mockRestore();
  expect(raw(db)).toEqual(before);
  expect(migrate(db).version).toBe(9);
});
it("blocks a prepared v8 writer and every old-writer insertion, keeping new rows immutable", () => {
  const file = join(root, "old.sqlite"),
    old = connection(file),
    modern = connection(file);
  old.exec("BEGIN IMMEDIATE");
  migrateQualitySchemaV8(old);
  old.exec("COMMIT");
  const pending = old.prepare("INSERT INTO quality_actual_requests VALUES(?,?,?)");
  migrate(modern);
  expect(() => pending.run(randomUUID(), "{}", "hash")).toThrow("unsupported writer");
  for (const table of Object.keys(qualityV9TableSql))
    expect(() => old.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow("unsupported writer");
  expect(() => migrateQualitySchemaV8(old)).toThrow("QUALITY_TRANSACTION_REQUIRED");
  for (const table of [
    "quality_provider_transmission_bindings",
    "quality_provider_transmission_coverage",
  ]) {
    // Coverage contains a row; insert one binding before testing its row-level guards below.
    if (table.endsWith("coverage")) {
      expect(() => modern.exec(`UPDATE ${table} SET body='{}'`)).toThrow("immutable");
      expect(() => modern.exec(`DELETE FROM ${table}`)).toThrow("immutable");
    }
  }
});
it.each(["missing", "mixed"])("rejects %s schema objects instead of repairing them", (kind) => {
  const db = connection();
  migrate(db);
  if (kind === "missing") db.exec("DROP TRIGGER quality_provider_transmission_bindings_v9_writer");
  else db.exec(qualityV9WriterTriggerSql.quality_runs_v9_writer.replaceAll("v9", "v8"));
  expect(() => migrate(db)).toThrow("QUALITY_SCHEMA_UNSUPPORTED");
});
it.each([
  "coverage-missing",
  "binding-missing",
  "coverage-hash",
  "coverage-prefix",
  "binding-hash",
  "binding-nonce",
  "binding-order",
  "binding-resealed",
  "coverage-oversize",
  "binding-oversize",
])("rejects %s in app reads, migration and backup inspection", (kind) => {
  const { directory, file } = source(),
    { db } = boundFixture(file),
    plan = approval(db);
  migrate(db);
  insertApproval(db, plan, true);
  const store = new PlanQualityStore(directory);
  stores.push(store);
  const c = "quality_provider_transmission_coverage",
    b = "quality_provider_transmission_bindings";
  if (kind.endsWith("missing")) {
    const table = kind.startsWith("coverage") ? c : b;
    tamper(db, table, "delete", `DELETE FROM ${table}`);
  } else if (kind.endsWith("hash")) {
    const table = kind.startsWith("coverage") ? c : b;
    tamper(db, table, "update", `UPDATE ${table} SET body_hash=?`, ["0".repeat(64)]);
  } else if (kind === "coverage-prefix") {
    const value = readProviderTransmissionApprovalDatabaseRows(db).coverage;
    value.cutoverProviderEvents[0].eventCount = 1;
    value.coverageDigest = digest(
      Object.fromEntries(Object.entries(value).filter(([k]) => k !== "coverageDigest")),
    );
    tamper(db, c, "update", `UPDATE ${c} SET body=?,body_hash=?`, [
      JSON.stringify(value),
      digest(value),
    ]);
  } else if (kind === "binding-resealed") {
    const value = plan.rows.binding;
    value.command.expectedRun.snapshotDigest = "0".repeat(64);
    value.commandDigest = digest(value.command);
    value.recordDigest = digest(
      Object.fromEntries(Object.entries(value).filter(([k]) => k !== "recordDigest")),
    );
    tamper(db, b, "update", `UPDATE ${b} SET body=?,body_hash=?`, [
      JSON.stringify(value),
      digest(value),
    ]);
  } else if (kind === "binding-nonce") {
    db.exec("PRAGMA foreign_keys=OFF");
    tamper(db, b, "update", `UPDATE ${b} SET nonce=?`, [randomUUID()]);
  } else if (kind === "binding-order") tamper(db, b, "update", `UPDATE ${b} SET rowid=0`);
  else {
    const table = kind.startsWith("coverage") ? c : b;
    tamper(db, table, "update", `UPDATE ${table} SET body=?`, [
      " ".repeat(kind.startsWith("coverage") ? 16385 : 131073),
    ]);
  }
  const before = raw(db);
  expect(() => inspectQualityDatabase(db)).toThrow();
  expect(() => inspectLedgerDatabase(db, () => registry)).toThrow();
  expect(() => migrate(db)).toThrow();
  expect(raw(db)).toEqual(before);
  expect(() => store.list()).toThrow();
  expect(() => store.candidateRegistryList()).toThrow();
  expect(() => new PlanQualityStore(directory)).toThrow();
});
it("never regenerates missing coverage on an empty current schema", () => {
  const db = connection();
  migrate(db);
  tamper(
    db,
    "quality_provider_transmission_coverage",
    "delete",
    "DELETE FROM quality_provider_transmission_coverage",
  );
  const before = raw(db);
  expect(() => migrate(db)).toThrow("QUALITY_DATABASE_INVALID");
  expect(raw(db)).toEqual(before);
});
it("accounts for raw binding/coverage whitespace and all older tables against the shared budget", () => {
  const { directory, file } = source(),
    { db } = boundFixture(file),
    plan = approval(db);
  migrate(db);
  insertApproval(db, plan, true);
  const store = new PlanQualityStore(directory);
  stores.push(store);
  const before = readProviderTransmissionApprovalDatabaseRows(db);
  for (const table of [
    "quality_provider_transmission_bindings",
    "quality_provider_transmission_coverage",
  ]) {
    expect(() => db.exec(`UPDATE ${table} SET body='{}'`)).toThrow("immutable");
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow("immutable");
    tamper(db, table, "update", `UPDATE ${table} SET body=body || ?`, [" ".repeat(500)]);
  }
  expect(readProviderTransmissionApprovalDatabaseRows(db).usedBytes).toBe(before.usedBytes + 1000);
  db.exec("BEGIN");
  const usage = inspectQualityDatabaseUsage(db);
  db.exec("COMMIT");
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
  expect(usage.usedBytes).toBe(total);
  const maximum = planQualityStoreLimits.totalBytes;
  try {
    Object.assign(planQualityStoreLimits, { totalBytes: total + usage.reservedBytes });
    expect(() => store.list()).not.toThrow();
    Object.assign(planQualityStoreLimits, { totalBytes: total + usage.reservedBytes - 1 });
    expect(() => store.list()).toThrow(/보관 용량/);
  } finally {
    Object.assign(planQualityStoreLimits, { totalBytes: maximum });
  }
});
it.each([false, true])(
  "round-trips v9 frozen approvals with legacy=%s after evidence expiry",
  async (legacy) => {
    const { directory, file } = source(),
      { db } = boundFixture(file),
      plan = approval(db),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    mkdirSync(restored);
    const sentinel = "SYNTHETIC COMPANY SENTINEL";
    writeFileSync(join(directory, "studio.sqlite"), sentinel);
    writeFileSync(join(restored, "studio.sqlite"), sentinel);
    if (legacy) insertApproval(db, plan, false);
    migrate(db);
    if (!legacy) insertApproval(db, plan, true);
    const before = raw(db),
      snapshot = inspectQualityDatabase(db),
      bytes = readFileSync(file);
    await backupQualityData(directory, backup);
    expect(verifyQualityBackup(backup).manifest).toMatchObject({
      version: 9,
      providerTransmissionBindings: legacy ? 0 : 1,
      providerTransmissionCoverage: 1,
    });
    const forbiddenRoot = join(root, "forbidden-cli-data");
    const verified = spawnSync(
      process.execPath,
      [resolve("scripts/local-data.mjs"), "quality-verify", "--source", backup],
      {
        windowsHide: true,
        timeout: 60000,
        encoding: "utf8",
        maxBuffer: 4096,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          VENTURE_DATA_DIR: forbiddenRoot,
          OPENAI_API_KEY: sentinel,
        },
      },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout + verified.stderr).not.toContain(root);
    expect(verified.stdout + verified.stderr).not.toContain(sentinel);
    expect(existsSync(forbiddenRoot)).toBe(false);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      action: "quality-verify",
      providerTransmissionBindings: legacy ? 0 : 1,
      providerTransmissionCoverage: 1,
      companyDataChanged: false,
      switched: false,
    });
    restoreQualityData(backup, restored);
    const copy = connection(join(restored, "quality-evaluation", "quality.sqlite"));
    expect(raw(copy)).toEqual(before);
    expect(inspectQualityDatabase(copy)).toEqual(snapshot);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const store = new PlanQualityStore(restored);
    stores.push(store);
    expect(store.providerGet(plan.rows.binding.runId).state).toBe("approved");
    const nonce = plan.rows.binding.clientRequestId;
    if (legacy) {
      expect(store.providerTransmissionApprovalLookup(nonce)).toEqual({ state: "not-observed" });
      expect(() => store.providerApproveTransmission(plan.rows.binding.command, null)).toThrowError(
        expect.objectContaining({ code: "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT" }),
      );
    } else {
      expect(store.providerApproveTransmission(plan.rows.binding.command, null)).toMatchObject({
        record: plan.rows.binding,
        newlyCommitted: false,
        replayed: true,
        dispatchAllowed: false,
        budgetWriteAllowed: false,
      });
    }
    expect(raw(copy)).toEqual(before);
    expect(readFileSync(file)).toEqual(bytes);
    expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
  },
  150000,
);
it("restores a v8 approved archive unchanged, then captures its exact event boundary on app open", async () => {
  const { directory, file } = source(),
    { db } = boundFixture(file),
    plan = approval(db),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  insertApproval(db, plan, false);
  const before = raw(db);
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 8 });
  restoreQualityData(backup, restored);
  const copy = connection(join(restored, "quality-evaluation", "quality.sqlite"));
  expect(raw(copy)).toEqual(before);
  const store = new PlanQualityStore(restored);
  stores.push(store);
  expect(raw(copy).rows.slice(0, 16)).toEqual(before.rows);
  expect(
    readProviderTransmissionApprovalDatabaseRows(copy).coverage.legacyProductionApprovals[0]
      .approvalEventDigest,
  ).toBe(plan.rows.event.eventDigest);
}, 150000);
it.each(["providerTransmissionBindings", "providerTransmissionCoverage"])(
  "rejects a resealed backup with changed %s",
  async (field) => {
    const { directory, file } = source(),
      { db } = boundFixture(file),
      plan = approval(db),
      backup = join(root, "backup");
    migrate(db);
    insertApproval(db, plan, true);
    await backupQualityData(directory, backup);
    const filePath = join(backup, "quality-backup-manifest.json"),
      value = JSON.parse(readFileSync(filePath, "utf8"));
    value[field] = 0;
    const body = JSON.stringify(value);
    writeFileSync(filePath, body);
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
it("cannot publish a backup marker if a new approval binding is absent", async () => {
  const { directory, file } = source(),
    { db } = boundFixture(file),
    plan = approval(db),
    backup = join(root, "backup");
  migrate(db);
  insertApproval(db, plan, false, false);
  await expect(backupQualityData(directory, backup)).rejects.toThrow();
  expect(existsSync(join(backup, "COMPLETE.json"))).toBe(false);
}, 150000);
