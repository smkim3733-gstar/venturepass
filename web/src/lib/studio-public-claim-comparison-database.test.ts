import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { publicComparisonNativeFixture } from "./studio-public-claim-comparison-native-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  inspectQualitySchema,
  qualityV9TableSql,
} from "../../scripts/local-data-quality-schema.mjs";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import {
  createPublicComparisonCoverage,
  type PublicComparisonPrefix,
  type PublicComparisonCoverage,
} from "./studio-public-claim-comparison-budget";
import {
  migratePublicComparisonDatabaseV10,
  inspectPublicComparisonDatabase,
  publicComparisonV10InsertGates,
} from "./studio-public-claim-comparison-database";
import * as configuration from "./studio-plan-quality-provider-configuration";

vi.mock("server-only", () => ({}));
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("forbidden external/customer access");
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
let root: string,
  source: string,
  prefix: PublicComparisonPrefix,
  coverage: PublicComparisonCoverage;
const selection = {
  databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
  environment: "production" as const,
  scopeId: "candidate-quality-provider-v2-live" as const,
};
const open: DatabaseSync[] = [];
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-comparison-database-"));
  const store = new PlanQualityStore(join(root, "base"), { providerEnvironment: "synthetic-test" });
  try {
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(store);
    store.providerRecordFinalization(f.identity);
  } finally {
    store.close();
  }
  source = join(root, "base", "quality-evaluation", "quality.sqlite");
  const db = new DatabaseSync(source);
  try {
    prefix = readPublicComparisonPrefix(db);
    coverage = createPublicComparisonCoverage(prefix);
  } finally {
    db.close();
  }
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
}, 30000);
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (root) {
    const r = relative(resolve(tmpdir()), resolve(root));
    if (!r.startsWith("venture-comparison-database-") || r.includes(".."))
      throw Error("unsafe cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function database() {
  const file = join(root, randomUUID() + ".sqlite");
  copyFileSync(source, file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100");
  open.push(db);
  return { db, file };
}
function migrated() {
  const f = database();
  migratePublicComparisonDatabaseV10(f.db, selection, coverage);
  return f;
}
function snapshot(db: DatabaseSync) {
  return Object.fromEntries(
    Object.keys(qualityV9TableSql).map((table) => [
      table,
      db.prepare(`SELECT rowid AS original_order,* FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}
function complete() {
  const f = publicComparisonNativeFixture(prefix, coverage),
    d = f.dispatch(),
    c = f.capture(d);
  f.comparison(c.sha256);
  f.settle(d, c.sha256);
  f.finish();
  return f;
}
type Fixture = ReturnType<typeof complete>;
/** Fixture seeding deliberately bypasses closed INSERT gates, then reinstates the exact schema.
 * This is raw synthetic SQL, never a production execution writer. */
function seed(db: DatabaseSync, f: Fixture) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const key of Object.keys(publicComparisonV10InsertGates)) db.exec(`DROP TRIGGER ${key}`);
    const json = (v: unknown) => [JSON.stringify(v), digest(v)];
    for (const v of f.a.records.runs)
      db.prepare("INSERT INTO quality_actual_runs(id,body,body_hash) VALUES(?,?,?)").run(
        v.id,
        ...json(v),
      );
    for (const v of f.a.records.events)
      db.prepare(
        "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
      ).run(v.runId, v.revision, ...json(v));
    for (const v of f.a.records.receipts)
      db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
        v.clientRequestId,
        ...json(v),
      );
    for (const v of f.a.financial.events)
      db.prepare(
        "INSERT INTO quality_actual_budget_events(scope_id,revision,body,body_hash) VALUES(?,?,?,?)",
      ).run(v.scopeId, v.revision, ...json(v));
    for (const v of f.a.records.artifacts)
      db.prepare(
        "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
      ).run(v.runId, v.key, Buffer.from(v.body), v.sha256, v.sizeBytes);
    for (const sql of Object.values(publicComparisonV10InsertGates)) db.exec(sql);
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
function modify(db: DatabaseSync, table: string, action: "update" | "delete", work: () => void) {
  const name = table + "_no_" + action;
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec("BEGIN");
  db.exec(`DROP TRIGGER ${name}`);
  work();
  db.exec(sql);
  db.exec("COMMIT");
}
it("explicit migration preserves every legacy row byte/order, default new stores remain v9", () => {
  const { db } = database(),
    before = snapshot(db);
  const result = migratePublicComparisonDatabaseV10(db, selection, coverage);
  expect(result.status).toBe("migrated");
  expect(snapshot(db)).toEqual(before);
  expect(result.inspection.archive.runs).toEqual([]);
  expect(Object.values(result.inspection.archive.authority).every((v) => v === false)).toBe(true);
  expect(result.inspection.fileIdentityVerified).toBe(false);
  expect(migratePublicComparisonDatabaseV10(db, selection, coverage).status).toBe("already-v10");
  expect(snapshot(db)).toEqual(before);
  const old = new DatabaseSync(source);
  try {
    expect(inspectQualitySchema(old).version).toBe(9);
  } finally {
    old.close();
  }
});
it("reopens v10 readonly and reads native rows without parallel budget receipt ownership", () => {
  const { db, file } = migrated(),
    f = complete();
  seed(db, f);
  const before = snapshot(db),
    r = inspectPublicComparisonDatabase(db, selection);
  expect(r.archive.runs[0].finalized).toBe(true);
  expect(r.archive.heldUnits).toBe("0");
  expect(r.archive.nativeReceipts).toHaveLength(f.a.records.receipts.length);
  expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_requests").get()!.n).toBe(
    prefix.rows.actualRows.receipts.length + f.a.records.receipts.length,
  );
  expect(snapshot(db)).toEqual(before);
  const reopened = new DatabaseSync(file, { readOnly: true });
  try {
    expect(inspectPublicComparisonDatabase(reopened, selection)).toEqual(r);
  } finally {
    reopened.close();
  }
});
it("reads dispatch unknown and late capture while keeping cost holds distinct from comparison validity", () => {
  const { db } = migrated(),
    f = publicComparisonNativeFixture(prefix, coverage),
    d = f.dispatch();
  f.event({
    kind: "dispatch-unknown",
    dispatchEventDigest: d.eventDigest,
    reason: "restart-unknown",
  });
  seed(db, f);
  const r = inspectPublicComparisonDatabase(db, selection);
  expect(r.archive.heldUnits).toBe("1000");
  expect(r.archive.capacity.comparisonHeldBytes).toBeGreaterThan(0);
  expect(r.archive.authority.providerExecutionObserved).toBe(false);
});
it("reads cancellation/finalization and releases only remaining storage reservation", () => {
  const { db } = migrated(),
    f = publicComparisonNativeFixture(prefix, coverage);
  f.cancel();
  f.finish();
  seed(db, f);
  const r = inspectPublicComparisonDatabase(db, selection);
  expect(r.archive.capacity.comparisonHeldBytes).toBe(0);
  expect(r.archive.heldUnits).toBe("0");
});
it.each(["before-ddl", "after-ddl", "before-commit"])(
  "rolls back %s injected migration failure and safely retries",
  (phase) => {
    const { db } = database(),
      before = snapshot(db),
      schema = inspectQualitySchema(db).schema,
      exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (
        (phase === "before-ddl" && sql.startsWith("CREATE TABLE quality_provider_purpose")) ||
        (phase === "before-commit" && sql === "COMMIT")
      )
        throw Error("injected");
      const result = exec(sql);
      if (phase === "after-ddl" && sql.startsWith("CREATE TABLE quality_provider_purpose"))
        throw Error("injected");
      return result;
    });
    try {
      expect(() => migratePublicComparisonDatabaseV10(db, selection, coverage)).toThrow("injected");
    } finally {
      spy.mockRestore();
    }
    expect(db.isTransaction).toBe(false);
    expect(snapshot(db)).toEqual(before);
    expect(inspectQualitySchema(db).schema).toEqual(schema);
    expect(migratePublicComparisonDatabaseV10(db, selection, coverage).status).toBe("migrated");
  },
);
it("unknown return after successful COMMIT is recovered as already-v10 with no duplicate rows", () => {
  const { db } = database(),
    exec = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT") throw Error("commit-observation-lost");
    return r;
  });
  try {
    expect(() => migratePublicComparisonDatabaseV10(db, selection, coverage)).toThrow(
      "commit-observation-lost",
    );
  } finally {
    spy.mockRestore();
  }
  expect(db.isTransaction).toBe(false);
  expect(migratePublicComparisonDatabaseV10(db, selection, coverage).status).toBe("already-v10");
});
it("rejects stale coverage before any DDL and does not rewrite prefix whitespace", () => {
  const { db } = database();
  const row = prefix.rows.actualRows.runs[0];
  modify(db, "quality_actual_runs", "update", () =>
    db.prepare("UPDATE quality_actual_runs SET body=? WHERE id=?").run(" " + row.body, row.id),
  );
  const before = snapshot(db);
  expect(() => migratePublicComparisonDatabaseV10(db, selection, coverage)).toThrow();
  expect(inspectQualitySchema(db).version).toBe(9);
  expect(snapshot(db)).toEqual(before);
});
it.each(["databaseInstanceId", "environment", "scopeId"] as const)(
  "rejects different selected %s on reopen and replay",
  (field) => {
    const { db } = migrated();
    const selected = {
      ...selection,
      [field]:
        field === "databaseInstanceId"
          ? randomUUID()
          : field === "environment"
            ? "synthetic-test"
            : "candidate-quality-provider-v2-synthetic",
    };
    expect(() => inspectPublicComparisonDatabase(db, selected)).toThrow();
    expect(() => migratePublicComparisonDatabaseV10(db, selected, coverage)).toThrow();
  },
);
it("rejects different coverage on migration replay", () => {
  const { db } = migrated();
  expect(() =>
    migratePublicComparisonDatabaseV10(db, selection, {
      ...coverage,
      coverageDigest: "0".repeat(64),
    }),
  ).toThrow();
});
it("does not report caller-owned uncommitted rows or migrate nested transactions", () => {
  const { db } = database();
  db.exec("BEGIN");
  expect(() => migratePublicComparisonDatabaseV10(db, selection, coverage)).toThrow(
    "TRANSACTION_ACTIVE",
  );
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow("TRANSACTION_ACTIVE");
  expect(db.isTransaction).toBe(true);
  db.exec("ROLLBACK");
});
it("leaves existing v9 general inspector and constructor fail closed on v10", () => {
  const { db } = migrated();
  expect(() => inspectQualityDatabase(db)).toThrow();
  expect(() => inspectQualitySchema(db)).toThrow();
});
it.each(Object.keys(qualityV9TableSql))(
  "blocks old and future unimplemented writer on %s",
  (table) => {
    const { db } = migrated();
    db.function("quality_storage_contract", () => "quality-v9");
    const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((v) => String(v.name));
    const values = columns.map((k) => row?.[k] ?? (k === "revision" || k === "id" ? 1 : "invalid"));
    expect(() =>
      db
        .prepare(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        )
        .run(...values),
    ).toThrow("comparison writer unavailable");
  },
);
it("stale v9 connection also hits new gates, including without a registered SQL function", () => {
  const { db, file } = database(),
    old = new DatabaseSync(file);
  try {
    old.function("quality_storage_contract", () => "quality-v9");
    migratePublicComparisonDatabaseV10(db, selection, coverage);
    expect(() =>
      old
        .prepare("INSERT INTO quality_actual_runs VALUES(?,?,?)")
        .run(randomUUID(), "{}", "0".repeat(64)),
    ).toThrow("comparison writer unavailable");
  } finally {
    old.close();
  }
});
it.each(["missing-gate", "extra-table", "changed-gate"])("rejects %s schema drift", (kind) => {
  const { db } = migrated();
  const name = Object.keys(publicComparisonV10InsertGates)[0];
  db.exec(kind === "extra-table" ? "CREATE TABLE stray(id TEXT)" : `DROP TRIGGER ${name}`);
  if (kind === "changed-gate")
    db.exec(publicComparisonV10InsertGates[name].replace("unavailable", "permitted"));
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
});
it.each([
  "prefix-body",
  "prefix-artifact",
  "cutover",
  "native-body",
  "native-key",
  "native-artifact",
  "receipt-projection",
])("rejects %s corruption with restored structural triggers", (kind) => {
  const { db } = migrated(),
    f = complete();
  seed(db, f);
  if (kind === "prefix-body") {
    const row = prefix.rows.actualRows.runs[0];
    modify(db, "quality_actual_runs", "update", () =>
      db.prepare("UPDATE quality_actual_runs SET body=? WHERE id=?").run(row.body + " ", row.id),
    );
  }
  if (kind === "prefix-artifact") {
    const row = prefix.rows.actualRows.artifacts[0];
    modify(db, "quality_actual_artifacts", "update", () =>
      db
        .prepare("UPDATE quality_actual_artifacts SET payload=? WHERE run_id=? AND artifact_key=?")
        .run(Buffer.from("{}"), row.run_id, row.artifact_key),
    );
  }
  if (kind === "cutover")
    modify(db, "quality_provider_purpose_coverage", "update", () =>
      db.exec("UPDATE quality_provider_purpose_coverage SET body_hash='" + "0".repeat(64) + "'"),
    );
  if (kind === "native-body")
    modify(db, "quality_actual_runs", "update", () =>
      db
        .prepare("UPDATE quality_actual_runs SET body_hash=? WHERE id=?")
        .run("0".repeat(64), f.run.id),
    );
  if (kind === "native-key")
    modify(db, "quality_actual_events", "update", () =>
      db
        .prepare("UPDATE quality_actual_events SET revision=31 WHERE run_id=? AND revision=1")
        .run(f.run.id),
    );
  if (kind === "native-artifact")
    modify(db, "quality_actual_artifacts", "update", () =>
      db
        .prepare(
          "UPDATE quality_actual_artifacts SET payload=? WHERE run_id=? AND artifact_key='comparison-context'",
        )
        .run(Buffer.from([0xff]), f.run.id),
    );
  if (kind === "receipt-projection") {
    const r = f.a.records.receipts[0],
      v = { ...r, budgetOperationDigest: null };
    modify(db, "quality_actual_requests", "update", () =>
      db
        .prepare("UPDATE quality_actual_requests SET body=?,body_hash=? WHERE nonce=?")
        .run(JSON.stringify(v), digest(v), r.clientRequestId),
    );
  }
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
});
it("rejects an invalid original claim request even with valid SQL body hash", () => {
  const { db } = migrated(),
    f = complete();
  f.a.records.runs[0].command.model = "wrong";
  seed(db, f);
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
});
it("does not accept v9 rows appended as a native suffix", () => {
  const { db } = migrated();
  const row = prefix.rows.actualRows.runs[0],
    id = randomUUID(),
    value = { ...JSON.parse(row.body), id };
  db.exec("DROP TRIGGER quality_actual_runs_v10_writer");
  db.prepare("INSERT INTO quality_actual_runs VALUES(?,?,?)").run(
    id,
    JSON.stringify(value),
    digest(value),
  );
  db.exec(publicComparisonV10InsertGates.quality_actual_runs_v10_writer);
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
});
it("does not overwrite existing coverage or release authority on idempotent reads", () => {
  const { db } = migrated(),
    before = snapshot(db),
    r = inspectPublicComparisonDatabase(db, selection);
  r.archive.authority.dispatchAllowed = false;
  expect(inspectPublicComparisonDatabase(db, selection)).toEqual(r);
  expect(snapshot(db)).toEqual(before);
  expect(() => db.exec("DELETE FROM quality_provider_purpose_coverage")).toThrow("immutable");
  expect(() => db.exec("UPDATE quality_provider_purpose_coverage SET body='{}'")).toThrow(
    "immutable",
  );
});

it("keeps noncanonical native row bytes and counts their storage overhead", () => {
  const { db } = migrated(),
    f = complete();
  seed(db, f);
  const row = db.prepare("SELECT body FROM quality_actual_runs WHERE id=?").get(f.run.id)!;
  modify(db, "quality_actual_runs", "update", () =>
    db
      .prepare("UPDATE quality_actual_runs SET body=? WHERE id=?")
      .run(" ".repeat(1000) + row.body, f.run.id),
  );
  const before = snapshot(db),
    r = inspectPublicComparisonDatabase(db, selection);
  expect(r.nativeRawOverheadBytes).toBe(1000);
  expect(snapshot(db)).toEqual(before);
});
it("blocks concurrent explicit migration and leaves the lock owner's transaction untouched", () => {
  const { db, file } = database(),
    owner = new DatabaseSync(file);
  try {
    owner.exec("BEGIN IMMEDIATE");
    expect(() => migratePublicComparisonDatabaseV10(db, selection, coverage)).toThrow();
    expect(owner.isTransaction).toBe(true);
    expect(db.isTransaction).toBe(false);
    owner.exec("ROLLBACK");
    expect(migratePublicComparisonDatabaseV10(db, selection, coverage).status).toBe("migrated");
  } finally {
    if (owner.isTransaction) owner.exec("ROLLBACK");
    owner.close();
  }
});
it("rejects oversized SQL body before decoding it", () => {
  const { db } = migrated(),
    f = complete();
  seed(db, f);
  modify(db, "quality_actual_runs", "update", () =>
    db
      .prepare("UPDATE quality_actual_runs SET body=CAST(zeroblob(?) AS TEXT) WHERE id=?")
      .run(8 * 1024 * 1024 + 1, f.run.id),
  );
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow("DATABASE_LIMIT");
});
it("rejects an incomplete frozen key inventory even if its wrapper hashes are recomputed", () => {
  const { db } = migrated();
  const row = db.prepare("SELECT body FROM quality_provider_purpose_coverage").get()!,
    value = JSON.parse(row.body as string);
  value.originalActualKeys.runs = [];
  const { cutoverDigest: removed, ...payload } = value;
  expect(removed).toBeTruthy();
  value.cutoverDigest = digest(payload);
  modify(db, "quality_provider_purpose_coverage", "update", () =>
    db
      .prepare("UPDATE quality_provider_purpose_coverage SET body=?,body_hash=?")
      .run(JSON.stringify(value), digest(value)),
  );
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
});
it("rejects missing frozen rows even when table and trigger SQL remain exact", () => {
  const { db } = migrated(),
    row = prefix.rows.actualRows.receipts[0];
  db.exec("PRAGMA foreign_keys=OFF");
  modify(db, "quality_actual_requests", "delete", () =>
    db.prepare("DELETE FROM quality_actual_requests WHERE nonce=?").run(row.nonce),
  );
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
});
it("reads a late captured response after unknown dispatch from a reopened connection", () => {
  const { db, file } = migrated(),
    f = publicComparisonNativeFixture(prefix, coverage),
    d = f.dispatch();
  f.event({
    kind: "dispatch-unknown",
    dispatchEventDigest: d.eventDigest,
    reason: "transport-unknown",
  });
  const c = f.capture(d);
  f.comparison(c.sha256);
  f.settle(d, c.sha256);
  f.finish();
  seed(db, f);
  const other = new DatabaseSync(file, { readOnly: true });
  try {
    const r = inspectPublicComparisonDatabase(other, selection);
    expect(r.archive.runs[0].finalized).toBe(true);
    expect(r.archive.authority.transactionCommitVerified).toBe(false);
  } finally {
    other.close();
  }
});
it("rejects the legacy constructor on v10 without rewriting v10 DDL or rows", () => {
  const directory = join(root, randomUUID());
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  // Copy only the closed synthetic v9 fixture, not a customer or operational database.
  const file = join(directory, "quality-evaluation", "quality.sqlite");
  copyFileSync(source, file);
  const db = new DatabaseSync(file);
  open.push(db);
  migratePublicComparisonDatabaseV10(db, selection, coverage);
  const before = snapshot(db),
    schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  expect(
    () => new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" }),
  ).toThrow();
  expect(snapshot(db)).toEqual(before);
  expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
});
