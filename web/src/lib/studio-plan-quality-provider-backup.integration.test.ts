import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  backupQualityData,
  inspectQualityDatabase,
  restoreQualityData,
  verifyQualityBackup,
} from "../../scripts/local-data-quality.mjs";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPreparation } from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import {
  inspectQualitySchema as inspectSchema,
  migrateQualitySchemaV4,
  migrateQualitySchemaV5,
  qualityLegacyTableSql,
  qualityTableSql,
  qualityImmutableTriggerSql,
  qualityWriterTriggerSql,
  qualityV5WriterTriggerSql,
  qualityV6WriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";
import {
  createProviderBudgetEvent,
  createProviderReceipt,
  providerBudgetScope,
  providerDigest,
  providerPolicyDigestInput,
} from "../../scripts/local-data-quality-provider.mjs";

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
beforeAll(() => {
  vi.stubGlobal("fetch", forbidden);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

type SchemaInspection = {
  version: number;
  tables: string[];
  schema: Array<{ name: string; type: string; tbl_name: string; sql: string }>;
};
const inspectQualitySchema = (db: DatabaseSync): SchemaInspection => inspectSchema(db);
const databases: DatabaseSync[] = [];
const directories: string[] = [];
function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}
function legacy(db: DatabaseSync, version: 1 | 2 | 3 | 4) {
  if (version === 4) {
    migrateQualitySchemaV4(db);
    return;
  }
  const count = version === 1 ? 3 : version === 2 ? 5 : 8;
  for (const [table, sql] of Object.entries(qualityLegacyTableSql).slice(0, count)) {
    db.exec(sql);
    for (const action of ["update", "delete"])
      db.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
  }
}
const storedRows = (db: DatabaseSync) => ({
  runs: db.prepare("SELECT id,body,body_hash FROM quality_actual_runs ORDER BY id").all(),
  artifacts: db
    .prepare(
      "SELECT run_id,artifact_key,payload,sha256,size_bytes FROM quality_actual_artifacts ORDER BY run_id,artifact_key",
    )
    .all(),
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel.startsWith("venture-provider-backup-") || rel.includes(".."))
      throw new Error("Unsafe synthetic fixture cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("mixed v1/v2 ledger backup", () => {
  let seedDirectory: string, seedBytes: Buffer;
  let firstLegacyId: string, secondLegacyId: string, cancelledId: string, reservedId: string;
  let legacyArchive: string,
    cancelledPrefix: string,
    cancelledArchive: string,
    reservedArchive: string;
  const sentinel = "SYNTHETIC_COMPANY_DATABASE_MUST_REMAIN_UNOPENED";
  beforeAll(() => {
    seedDirectory = mkdtempSync(join(tmpdir(), "venture-provider-backup-seed-"));
    writeFileSync(join(seedDirectory, "studio.sqlite"), sentinel);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(actualTestNow);
    const store = new PlanQualityStore(seedDirectory, {
      actualEnvironment: "synthetic-test",
      providerEnvironment: "synthetic-test",
    });
    try {
      const registry = store.candidateRegistryRegister({
        clientRequestId: randomUUID(),
        expectedVersion: 0,
        sourceDigest: store.candidateRegistryList().source.sourceDigest,
        acknowledgedCandidateStatus: true,
      }).snapshot;
      store.actualBudgetConfigure({
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
      });
      const startLegacy = (index: number) => {
        const budget = store.actualBudgetGet();
        const preparation = actualTestPreparation(registry, {
          candidateIndex: index,
          ledgerDigest: budget.headDigest!,
          capUnits: budget.capUnits,
          heldUnits: budget.heldUnits,
        });
        return store.actualStart({
          clientRequestId: randomUUID(),
          expectedBudgetRevision: budget.revision,
          expectedBudgetDigest: budget.headDigest!,
          expectedActualRunCount: store.actualList().executions.length,
          preparation,
          approval: {
            provenance: "synthetic-test",
            acknowledgedSyntheticOnly: true,
            approvedAt: actualTestNow,
            approvedPreparationDigest: preparation.preparationDigest,
          },
        }).snapshot;
      };
      firstLegacyId = startLegacy(0).run.id;
      legacyArchive = store.actualDownload(firstLegacyId, 0).body;
      providerTestConfigure(store);
      cancelledId = store.providerStart(providerTestStartInput(store, 0)).snapshot.run.id;
      cancelledPrefix = store.providerDownload(cancelledId, 0).body;
      store.providerCancel(cancelledId, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "test-cleanup",
      });
      cancelledArchive = store.providerDownload(cancelledId, 1).body;
      secondLegacyId = startLegacy(1).run.id;
      reservedId = store.providerStart(providerTestStartInput(store, 1)).snapshot.run.id;
      reservedArchive = store.providerDownload(reservedId, 0).body;
      expect(store.actualDownload(firstLegacyId, 0).body).toBe(legacyArchive);
      expect(store.providerDownload(cancelledId, 0).body).toBe(cancelledPrefix);
    } finally {
      store.close();
      vi.useRealTimers();
    }
    // Freeze this suite's copy as v5; app-default writer upgrades must not erase legacy coverage.
    const fixture = new DatabaseSync(join(seedDirectory, "quality-evaluation", "quality.sqlite"));
    try {
      if (inspectQualitySchema(fixture).version === 6) {
        for (const name of Object.keys(qualityV6WriterTriggerSql))
          fixture.exec(`DROP TRIGGER ${name}`);
        for (const sql of Object.values(qualityV5WriterTriggerSql)) fixture.exec(sql);
      }
    } finally {
      fixture.close();
    }
    seedBytes = readFileSync(join(seedDirectory, "quality-evaluation", "quality.sqlite"));
  }, 30000);
  afterAll(() => {
    expect(readFileSync(join(seedDirectory, "studio.sqlite"), "utf8")).toBe(sentinel);
    const rel = relative(resolve(tmpdir()), resolve(seedDirectory));
    if (!rel.startsWith("venture-provider-backup-seed-") || rel.includes(".."))
      throw new Error("Unsafe cleanup");
    rmSync(seedDirectory, { recursive: true, force: true });
  });
  function copy() {
    const root = mkdtempSync(join(tmpdir(), "venture-provider-backup-"));
    directories.push(root);
    mkdirSync(join(root, "quality-evaluation"));
    writeFileSync(join(root, "quality-evaluation", "quality.sqlite"), seedBytes);
    writeFileSync(join(root, "studio.sqlite"), sentinel);
    return root;
  }
  function inspect(root: string) {
    const db = new DatabaseSync(join(root, "quality-evaluation", "quality.sqlite"), {
      readOnly: true,
    });
    try {
      return inspectQualityDatabase(db);
    } finally {
      db.close();
    }
  }
  function edit(root: string, work: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(join(root, "quality-evaluation", "quality.sqlite"));
    try {
      db.function("quality_storage_contract", () => "quality-v5");
      work(db);
    } finally {
      db.close();
    }
  }
  it("validates interleaved v1/v2 counts and rejects changed insertion history without altering JSON", () => {
    const root = copy();
    expect(inspect(root)).toMatchObject({
      storageVersion: 5,
      actualRuns: 4,
      actualEvents: 1,
      actualArtifacts: 4,
    });
    const before = new PlanQualityStore(root);
    try {
      expect(before.providerGet(cancelledId).run.expectedGlobalRunCount).toBe(1);
      expect(before.providerGet(reservedId).run.expectedGlobalRunCount).toBe(3);
      expect(before.actualGet(secondLegacyId).run.expectedActualRunCount).toBe(1);
    } finally {
      before.close();
    }
    edit(root, (db) => {
      db.exec("DROP TRIGGER quality_actual_runs_no_update");
      db.prepare("UPDATE quality_actual_runs SET rowid=999 WHERE id=?").run(cancelledId);
      db.exec(qualityImmutableTriggerSql.quality_actual_runs_no_update);
    });
    expect(() => inspect(root)).toThrow(/QUALITY_DATABASE_INVALID/);
  });
  it("rejects supported-schema storage downgraded to v4 while provider records remain", () => {
    const root = copy();
    edit(root, (db) => {
      for (const name of Object.keys(qualityV5WriterTriggerSql)) db.exec(`DROP TRIGGER ${name}`);
      for (const sql of Object.values(qualityWriterTriggerSql)) db.exec(sql);
    });
    expect(() => inspect(root)).toThrow(/QUALITY_DATABASE_INVALID/);
  });
  it("rejects unsupported future dispatch events instead of treating them as a reservation", () => {
    const root = copy();
    edit(root, (db) => {
      const event = {
        schemaVersion: 2,
        runId: reservedId,
        revision: 1,
        budgetRevision: 4,
        previousEventDigest: null,
        recordedAt: actualTestNow,
        payload: { kind: "dispatch-intent" },
      };
      const body = { ...event, eventDigest: providerDigest(event) };
      db.prepare("INSERT INTO quality_actual_events VALUES (?,?,?,?)").run(
        reservedId,
        1,
        JSON.stringify(body),
        providerDigest(body),
      );
    });
    expect(() => inspect(root)).toThrow(/QUALITY_DATABASE_INVALID/);
  });
  it("preserves historical v1/v2 exports through one v5 backup/restore without opening company data", async () => {
    const source = copy(),
      parent = mkdtempSync(join(tmpdir(), "venture-provider-backup-"));
    directories.push(parent);
    const destination = join(parent, "restored"),
      backup = join(parent, "archive");
    mkdirSync(destination);
    writeFileSync(join(destination, "studio.sqlite"), sentinel);
    const { storageVersion, digest: ignored, ...counts } = inspect(source);
    void ignored;
    expect(storageVersion).toBe(5);
    expect(await backupQualityData(source, backup)).toEqual(counts);
    expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 5, ...counts });
    expect(restoreQualityData(backup, destination)).toEqual(counts);
    expect(readFileSync(join(source, "quality-evaluation", "quality.sqlite"))).toEqual(seedBytes);
    expect(readFileSync(join(destination, "quality-evaluation", "quality.sqlite"))).toEqual(
      readFileSync(join(backup, "quality.sqlite")),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2030-01-01T00:00:00.000Z");
    const restored = new PlanQualityStore(destination);
    try {
      expect(restored.actualDownload(firstLegacyId, 0).body).toBe(legacyArchive);
      expect(restored.providerDownload(cancelledId, 0).body).toBe(cancelledPrefix);
      expect(restored.providerDownload(cancelledId, 1).body).toBe(cancelledArchive);
      expect(restored.providerDownload(reservedId, 0).body).toBe(reservedArchive);
      expect(restored.actualBudgetGet().heldUnits).toBe("8");
      expect(restored.providerBudgetGet().heldUnits).toBe("4");
      expect(restored.providerGet(reservedId)).toMatchObject({
        dispatchAllowed: false,
        actualAiCalls: 0,
        canResume: false,
      });
    } finally {
      restored.close();
      vi.useRealTimers();
    }
    for (const root of [source, destination])
      expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(sentinel);
  }, 150000);
});

describe("quality storage v5 migration boundaries", () => {
  it.each([1, 2, 3, 4, 5] as const)(
    "reads empty v%i without a writer capability or implicit migration",
    (version) => {
      const db = database();
      if (version === 5) migrateQualitySchemaV5(db);
      else legacy(db, version);
      db.function("quality_storage_contract", () => "read-only-test");
      const before = inspectQualitySchema(db);
      expect(inspectQualityDatabase(db)).toMatchObject({
        storageVersion: version,
        runs: 0,
        revisions: 0,
        requests: 0,
      });
      expect(inspectQualitySchema(db)).toEqual(before);
    },
  );
  it.each([1, 2, 3, 4] as const)(
    "migrates exact v%i to thirteen tables and thirty-nine triggers",
    (version) => {
      const db = database();
      legacy(db, version);
      db.exec("BEGIN IMMEDIATE");
      const result: SchemaInspection = migrateQualitySchemaV5(db);
      db.exec("COMMIT");
      expect(result.version).toBe(5);
      expect(result.tables).toHaveLength(13);
      expect(result.schema.filter((item) => item.type === "trigger")).toHaveLength(39);
      expect(result.schema.filter((item) => item.type === "table")).toHaveLength(13);
      expect(result.schema.some((item) => item.name.endsWith("_v4_writer"))).toBe(false);
      expect(migrateQualitySchemaV5(db)).toEqual(result);
    },
  );

  it("retains raw v1 JSON, hashes and BLOB bytes while replacing writer gates", () => {
    const db = database();
    migrateQualitySchemaV4(db);
    const body = '{ "schemaVersion": 1, "synthetic": "보존" }\n';
    const payload = Buffer.from('{ "generation": "원문", "order": [2,1] }\n');
    db.prepare("INSERT INTO quality_actual_runs(id,body,body_hash) VALUES(?,?,?)").run(
      "synthetic-row",
      body,
      "original-body-hash",
    );
    db.prepare(
      "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
    ).run("synthetic-row", "generation-request", payload, "original-raw-hash", payload.length);
    const before = storedRows(db);
    const immutable = inspectQualitySchema(db).schema.filter((row) =>
      /_no_(update|delete)$/.test(row.name),
    );
    migrateQualitySchemaV5(db);
    expect(storedRows(db)).toEqual(before);
    expect(
      inspectQualitySchema(db).schema.filter((row) => /_no_(update|delete)$/.test(row.name)),
    ).toEqual(immutable);
  });

  it("rolls back the whole gate migration without rewriting existing rows", () => {
    const db = database();
    migrateQualitySchemaV4(db);
    const before = inspectQualitySchema(db);
    db.exec("BEGIN IMMEDIATE");
    migrateQualitySchemaV5(db);
    db.exec("ROLLBACK");
    expect(inspectQualitySchema(db)).toEqual(before);
    // Callback registration is connection-local, so reopening the known v4 writer restores it.
    migrateQualitySchemaV4(db);
    expect(() => db.exec("INSERT INTO quality_runs VALUES ('legacy','{}','hash')")).not.toThrow();
  });

  it("blocks older and missing callbacks on all thirteen tables", () => {
    const db = database();
    migrateQualitySchemaV5(db);
    db.function("quality_storage_contract", () => "quality-v4");
    for (const table of Object.keys(qualityTableSql))
      expect(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow(/unsupported writer/);
    db.function("quality_storage_contract", () => null);
    for (const table of Object.keys(qualityTableSql))
      expect(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow(/unsupported writer/);
  });

  it("refuses v4 downgrade without replacing the active v5 connection callback", () => {
    const db = database();
    migrateQualitySchemaV5(db);
    const before = inspectQualitySchema(db);
    expect(() => migrateQualitySchemaV4(db)).toThrow(/QUALITY_SCHEMA_UNSUPPORTED/);
    expect(inspectQualitySchema(db)).toEqual(before);
    expect(() => db.exec("INSERT INTO quality_runs VALUES ('new','{}','hash')")).not.toThrow();
  });

  it("blocks an already-open v4 writer and a callback-free connection after committed migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "venture-provider-backup-"));
    directories.push(directory);
    const file = join(directory, "quality.sqlite");
    const old = new DatabaseSync(file);
    databases.push(old);
    migrateQualitySchemaV4(old);
    const prepared = old.prepare("INSERT INTO quality_actual_runs VALUES (?,?,?)");
    const modern = new DatabaseSync(file);
    databases.push(modern);
    modern.exec("BEGIN IMMEDIATE");
    migrateQualitySchemaV5(modern);
    modern.exec("COMMIT");
    expect(() => prepared.run("old-process", "{}", "hash")).toThrow(/unsupported writer/);
    const unconfigured = new DatabaseSync(file);
    databases.push(unconfigured);
    expect(() =>
      unconfigured.exec("INSERT INTO quality_actual_runs VALUES ('raw','{}','hash')"),
    ).toThrow(/quality_storage_contract/);
    expect(modern.prepare("SELECT COUNT(*) AS count FROM quality_actual_runs").get()?.count).toBe(
      0,
    );
  });

  it("rejects valid v2 policy-only rows under v4 even when there are no provider runs", () => {
    const db = database();
    migrateQualitySchemaV4(db);
    const clientRequestId = randomUUID();
    const policy = {
      environment: "synthetic-test" as const,
      provenance: "synthetic-test" as const,
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
    };
    const event = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId: providerBudgetScope("synthetic-test"),
      environment: policy.environment,
      provenance: policy.provenance,
      currency: policy.currency,
      unitScale: policy.unitScale,
      revision: 1,
      previousDigest: null,
      eventId: clientRequestId,
      recordedAt: "2026-09-27T03:00:00.000Z",
      payload: { kind: "configure", capUnits: policy.capUnits },
    });
    const receipt = createProviderReceipt({
      schemaVersion: 2,
      scopeId: event.scopeId,
      kind: "provider-budget-configure",
      clientRequestId,
      inputDigest: providerDigest(
        providerPolicyDigestInput({ clientRequestId, expectedRevision: 0, policy }),
      ),
      runId: null,
      runRevision: null,
      budgetRevision: 1,
      operationDigest: event.eventDigest,
      recordedAt: event.recordedAt,
    });
    db.prepare("INSERT INTO quality_actual_budget_events VALUES (?,?,?,?)").run(
      event.scopeId,
      1,
      JSON.stringify(event),
      providerDigest(event),
    );
    db.prepare("INSERT INTO quality_actual_requests VALUES (?,?,?)").run(
      clientRequestId,
      JSON.stringify(receipt),
      providerDigest(receipt),
    );
    expect(() => inspectQualityDatabase(db)).toThrow(/QUALITY_DATABASE_INVALID/);
    const before = inspectQualitySchema(db);
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateQualitySchemaV5(db)).toThrow(/QUALITY_DATABASE_INVALID/);
    db.exec("ROLLBACK");
    expect(inspectQualitySchema(db)).toEqual(before);
    const modern = database();
    migrateQualitySchemaV5(modern);
    modern
      .prepare("INSERT INTO quality_actual_budget_events VALUES (?,?,?,?)")
      .run(event.scopeId, 1, JSON.stringify(event), providerDigest(event));
    modern
      .prepare("INSERT INTO quality_actual_requests VALUES (?,?,?)")
      .run(clientRequestId, JSON.stringify(receipt), providerDigest(receipt));
    expect(inspectQualityDatabase(modern)).toMatchObject({
      storageVersion: 5,
      actualRuns: 0,
      actualBudgetEvents: 1,
      actualRequests: 1,
    });
  });

  it.each([
    ["future run", "quality_actual_runs", '{"schemaVersion":2}'],
    ["missing run version", "quality_actual_runs", "{}"],
    ["invalid JSON", "quality_actual_requests", "{"],
    ["array envelope", "quality_actual_requests", "[]"],
    ["oversized receipt", "quality_actual_requests", JSON.stringify({ padding: "x".repeat(4097) })],
  ])("refuses v4 migration for %s before touching gates", (_label, table, body) => {
    const db = database();
    migrateQualitySchemaV4(db);
    const before = inspectQualitySchema(db);
    db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`).run(randomUUID(), body, "synthetic-hash");
    expect(() => migrateQualitySchemaV5(db)).toThrow(/QUALITY_DATABASE_INVALID/);
    expect(inspectQualitySchema(db)).toEqual(before);
  });

  it.each(["mixed", "missing", "wrong-literal"] as const)(
    "rejects %s writer schemas instead of repairing them",
    (kind) => {
      const db = database();
      migrateQualitySchemaV5(db);
      if (kind === "mixed") db.exec(qualityWriterTriggerSql.quality_runs_v4_writer);
      else {
        db.exec("DROP TRIGGER quality_actual_runs_v5_writer");
        if (kind === "wrong-literal")
          db.exec(
            qualityV5WriterTriggerSql.quality_actual_runs_v5_writer.replace(
              "'quality-v5'",
              "'QUALITY-V5'",
            ),
          );
      }
      const before = db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all();
      expect(() => migrateQualitySchemaV5(db)).toThrow(/QUALITY_SCHEMA_UNSUPPORTED/);
      expect(db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    },
  );
});
