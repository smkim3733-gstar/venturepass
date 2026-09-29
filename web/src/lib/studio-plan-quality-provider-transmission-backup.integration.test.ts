import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  inspectQualitySchema,
  migrateQualitySchemaV4,
  migrateQualitySchemaV5,
  migrateQualitySchemaV6,
  qualityLegacyTableSql,
  qualityImmutableTriggerSql,
  qualityTableSql,
  qualityV5WriterTriggerSql,
  qualityV6WriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";
import {
  backupQualityData,
  inspectQualityDatabase,
  restoreQualityData,
  verifyQualityBackup,
} from "../../scripts/local-data-quality.mjs";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { freezePolicyFreeSchema } from "./studio-plan-quality-policy-storage-test-helpers";
import {
  actualTestNow,
  actualTestPlan,
  actualTestPreparation,
} from "./studio-plan-quality-actual-test-helpers";
import { runQualityProviderSimulation } from "./studio-plan-quality-provider-runner";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import {
  providerExecutionTestApproval,
  providerExecutionTestResponse,
} from "./studio-plan-quality-provider-execution-test-helpers";
import { createProviderExecutionArtifact } from "../../scripts/local-data-quality-provider-execution.mjs";
import { validateActualArtifact } from "../../scripts/local-data-quality-actual.mjs";
import {
  captureProviderResponse,
  providerResponseMetadata,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  createProviderBudgetEvent,
  createProviderReceipt,
  providerBudgetScope,
  providerDigest,
  providerPolicyDigestInput,
} from "../../scripts/local-data-quality-provider-reservation-ledger.mjs";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External AI forbidden");
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

const opened: DatabaseSync[] = [];
const temporary: string[] = [];
function cleanup(directory: string) {
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-v6-backup-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}
function database(version = 5) {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  if (version === 4) migrateQualitySchemaV4(db);
  else if (version === 5) migrateQualitySchemaV5(db);
  else if (version > 0) {
    const count = version === 1 ? 3 : version === 2 ? 5 : 8;
    for (const [name, sql] of Object.entries(qualityLegacyTableSql).slice(0, count)) {
      db.exec(sql);
      for (const action of ["update", "delete"])
        db.exec(qualityImmutableTriggerSql[`${name}_no_${action}`]);
    }
  }
  return db;
}
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  for (const db of opened.splice(0)) db.close();
  for (const directory of temporary.splice(0)) cleanup(directory);
});
function configure(db: DatabaseSync) {
  const clientRequestId = randomUUID(),
    recordedAt = "2026-09-27T03:00:00.000Z";
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
    revision: 1,
    previousDigest: null,
    eventId: clientRequestId,
    recordedAt,
    currency: policy.currency,
    unitScale: policy.unitScale,
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
    recordedAt,
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
}

describe("v6 backup writer and frozen reservation boundaries", () => {
  it.each([0, 1, 2, 3, 4, 5])(
    "migrates exact v%i with thirteen tables and thirty-nine triggers",
    (version) => {
      const db = database(version);
      db.exec("BEGIN IMMEDIATE");
      migrateQualitySchemaV6(db);
      db.exec("COMMIT");
      const result = inspectQualitySchema(db) as {
        version: number;
        tables: string[];
        schema: Array<{ name: string; type: string }>;
      };
      expect(result.version).toBe(6);
      expect(result.tables).toHaveLength(13);
      expect(result.schema.filter((v) => v.type === "trigger")).toHaveLength(39);
      expect(result.schema.filter((v) => /_v[45]_writer$/.test(v.name))).toHaveLength(0);
      expect(inspectQualityDatabase(db)).toMatchObject({ storageVersion: 6, actualRuns: 0 });
    },
  );
  it("preserves v5 policy JSON and immutable DDL, and rolls back gate replacement atomically", () => {
    const db = database();
    configure(db);
    const before = inspectQualitySchema(db);
    const budgets = db.prepare("SELECT * FROM quality_actual_budget_events").all();
    const receipts = db.prepare("SELECT * FROM quality_actual_requests").all();
    expect(inspectQualityDatabase(db)).toMatchObject({ storageVersion: 5, actualBudgetEvents: 1 });
    db.exec("BEGIN IMMEDIATE");
    migrateQualitySchemaV6(db);
    db.exec("ROLLBACK");
    expect(inspectQualitySchema(db)).toEqual(before);
    migrateQualitySchemaV6(db);
    expect(db.prepare("SELECT * FROM quality_actual_budget_events").all()).toEqual(budgets);
    expect(db.prepare("SELECT * FROM quality_actual_requests").all()).toEqual(receipts);
    expect(inspectQualityDatabase(db)).toMatchObject({ storageVersion: 6, actualBudgetEvents: 1 });
  });
  it.each(["quality-v4", "quality-v5", null])(
    "blocks obsolete %s connection writers on all thirteen tables",
    (callback) => {
      const db = database();
      migrateQualitySchemaV6(db);
      db.function("quality_storage_contract", () => callback);
      for (const table of Object.keys(qualityTableSql))
        expect(() => db.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow(/unsupported writer/);
    },
  );
  it("refuses old migration helpers without replacing the current connection capability", () => {
    const db = database();
    migrateQualitySchemaV6(db);
    const before = inspectQualitySchema(db);
    expect(() => migrateQualitySchemaV4(db)).toThrow(/QUALITY_SCHEMA_UNSUPPORTED/);
    expect(() => migrateQualitySchemaV5(db)).toThrow(/QUALITY_SCHEMA_UNSUPPORTED/);
    expect(inspectQualitySchema(db)).toEqual(before);
    expect(() =>
      db.exec("INSERT INTO quality_runs VALUES ('unchanged-capability','{}','hash')"),
    ).not.toThrow();
  });
  it.each(["mixed", "partial", "wrong-contract"])("rejects %s v6 gates without repairs", (kind) => {
    const db = database();
    migrateQualitySchemaV6(db);
    if (kind === "mixed") db.exec(qualityV5WriterTriggerSql.quality_runs_v5_writer);
    else {
      db.exec("DROP TRIGGER quality_actual_events_v6_writer");
      if (kind === "wrong-contract")
        db.exec(
          qualityV6WriterTriggerSql.quality_actual_events_v6_writer.replace(
            "'quality-v6'",
            "'quality-v5'",
          ),
        );
    }
    const before = db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all();
    expect(() => migrateQualitySchemaV6(db)).toThrow(/QUALITY_SCHEMA_UNSUPPORTED/);
    expect(db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all()).toEqual(before);
  });
  it.each([
    ["recognize-usage", "quality_actual_budget_events"],
    ["release-phase", "quality_actual_budget_events"],
    ["provider-transmission-approve", "quality_actual_requests"],
  ])("rejects newer %s records before v5 migration or backup", (kind, table) => {
    const db = database();
    const before = inspectQualitySchema(db),
      id = randomUUID();
    const value = { schemaVersion: 2, kind, payload: { kind }, runId: id, clientRequestId: id };
    if (table === "quality_actual_events")
      db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(
        id,
        1,
        JSON.stringify(value),
        providerDigest(value),
      );
    else if (table === "quality_actual_budget_events")
      db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(
        providerBudgetScope("synthetic-test"),
        1,
        JSON.stringify(value),
        providerDigest(value),
      );
    else
      db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`).run(
        id,
        JSON.stringify(value),
        providerDigest(value),
      );
    expect(() => inspectQualityDatabase(db)).toThrow(/QUALITY_DATABASE_INVALID/);
    expect(() => migrateQualitySchemaV6(db)).toThrow(/QUALITY_DATABASE_INVALID/);
    expect(inspectQualitySchema(db)).toEqual(before);
  });
});

describe("v6 recorded transmission backup", () => {
  const sentinel = "SYNTHETIC_COMPANY_DATA_UNTOUCHED";
  let seed: string, originalBytes: Buffer, reservationBytes: Buffer;
  let legacyId: string, cancelledId: string, knownId: string, unknownId: string;
  let legacyArchive: string,
    cancelledArchive: string,
    beforeApprovalArchive: string,
    dispatchArchive: string,
    knownArchive: string,
    unknownArchive: string;
  const newerRows: Record<string, Record<string, string | number | null | Uint8Array>> = {};
  beforeAll(() => {
    seed = mkdtempSync(join(tmpdir(), "venture-v6-backup-seed-"));
    writeFileSync(join(seed, "studio.sqlite"), sentinel);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(actualTestNow);
    const store = new PlanQualityStore(seed, {
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
      const budget = store.actualBudgetConfigure({
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
      }).budget;
      const preparation = actualTestPreparation(registry, {
        ledgerDigest: budget.headDigest!,
        capUnits: budget.capUnits,
        heldUnits: budget.heldUnits,
      });
      legacyId = store.actualStart({
        clientRequestId: randomUUID(),
        expectedBudgetRevision: budget.revision,
        expectedBudgetDigest: budget.headDigest!,
        expectedActualRunCount: 0,
        preparation,
        approval: {
          provenance: "synthetic-test",
          acknowledgedSyntheticOnly: true,
          approvedAt: actualTestNow,
          approvedPreparationDigest: preparation.preparationDigest,
        },
      }).snapshot.run.id;
      legacyArchive = store.actualDownload(legacyId, 0).body;
      providerTestConfigure(store);
      cancelledId = store.providerStart(providerTestStartInput(store, 0)).snapshot.run.id;
      store.providerCancel(cancelledId, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "test-cleanup",
      });
      cancelledArchive = store.providerDownload(cancelledId, 1).body;
      knownId = store.providerStart(providerTestStartInput(store, 1)).snapshot.run.id;
      beforeApprovalArchive = store.providerDownload(knownId, 0).body;
      reservationBytes = readFileSync(join(seed, "quality-evaluation", "quality.sqlite"));
      const dispatch = (id: string) => {
        let snapshot = store.providerRecordApprove(
          id,
          providerExecutionTestApproval(store, id),
        ).snapshot;
        const run = snapshot.run,
          approvalDigest = snapshot.events[0].eventDigest;
        let currentBudget = store.providerBudgetGet();
        snapshot = store.providerRecordPrepared(id, {
          clientRequestId: randomUUID(),
          expectedRevision: snapshot.revision,
          payload: {
            kind: "request-prepared",
            phase: "generation",
            requestDigest: run.preparation.generation.requestDigest,
            artifactSha256: run.preparation.generation.sha256,
            derivedFrom: null,
            budgetRevision: currentBudget.revision,
            budgetDigest: currentBudget.headDigest!,
          },
        }).snapshot;
        const preparedDigest = snapshot.events.at(-1)!.eventDigest;
        currentBudget = store.providerBudgetGet();
        return store.providerRecordDispatch(id, {
          clientRequestId: randomUUID(),
          expectedRevision: snapshot.revision,
          payload: {
            kind: "dispatch-intent",
            phase: "generation",
            requestDigest: run.preparation.generation.requestDigest,
            artifactSha256: run.preparation.generation.sha256,
            preparedEventDigest: preparedDigest,
            approvalEventDigest: approvalDigest,
            budgetRevision: currentBudget.revision,
            budgetDigest: currentBudget.headDigest!,
          },
        }).snapshot;
      };
      let current = dispatch(knownId);
      dispatchArchive = store.providerDownload(knownId, current.revision).body;
      const raw = captureProviderResponse(
        providerExecutionTestResponse({ invalidSyntheticPlan: true }),
      );
      const artifact = createProviderExecutionArtifact({
        runId: knownId,
        key: "generation-response",
        body: JSON.stringify({ captureKind: "sdk-response-json-v2", response: raw }),
      });
      current = store.providerRecordResponse(knownId, {
        clientRequestId: randomUUID(),
        expectedRevision: current.revision,
        artifact,
        payload: {
          kind: "response-received",
          phase: "generation",
          requestDigest: current.run.preparation.generation.requestDigest,
          dispatchEventDigest: current.events.at(-1)!.eventDigest,
          artifactSha256: artifact.sha256,
          metadata: providerResponseMetadata(raw, {
            configuredModel: current.run.preparation.model,
          }),
        },
      }).snapshot;
      current = store.providerRecordFinish(knownId, {
        clientRequestId: randomUUID(),
        expectedRevision: current.revision,
        payload: {
          kind: "execution-stopped",
          outcome: "output-invalid",
          failureCode: "OUTPUT_INVALID",
          finalArtifactSha256: null,
        },
      }).snapshot;
      knownArchive = store.providerDownload(knownId, current.revision).body;
      unknownId = store.providerStart(providerTestStartInput(store, 2)).snapshot.run.id;
      current = dispatch(unknownId);
      current = store.providerRecordFinish(unknownId, {
        clientRequestId: randomUUID(),
        expectedRevision: current.revision,
        payload: {
          kind: "execution-stopped",
          outcome: "result-unobserved",
          failureCode: "INTERRUPTED",
          finalArtifactSha256: null,
        },
      }).snapshot;
      unknownArchive = store.providerDownload(unknownId, current.revision).body;
      expect(store.actualDownload(legacyId, 0).body).toBe(legacyArchive);
      expect(store.providerDownload(cancelledId, 1).body).toBe(cancelledArchive);
      expect(store.providerDownload(knownId, 0).body).toBe(beforeApprovalArchive);
      expect(store.providerDownload(knownId, 3).body).toBe(dispatchArchive);
    } finally {
      store.close();
      vi.useRealTimers();
    }
    // Preserve explicit v6 archival coverage independently of the application's current writer.
    const historical = new DatabaseSync(join(seed, "quality-evaluation", "quality.sqlite"));
    try {
      freezePolicyFreeSchema(historical, 6);
    } finally {
      historical.close();
    }
    originalBytes = readFileSync(join(seed, "quality-evaluation", "quality.sqlite"));
    const db = new DatabaseSync(join(seed, "quality-evaluation", "quality.sqlite"), {
      readOnly: true,
    });
    try {
      newerRows.quality_actual_events = db
        .prepare("SELECT * FROM quality_actual_events WHERE run_id=? AND revision=1")
        .get(knownId)! as (typeof newerRows)[string];
      newerRows.quality_actual_requests = db
        .prepare(
          "SELECT * FROM quality_actual_requests WHERE json_extract(body,'$.kind')='provider-approve' AND json_extract(body,'$.runId')=?",
        )
        .get(knownId)! as (typeof newerRows)[string];
      newerRows.quality_actual_budget_events = db
        .prepare(
          "SELECT * FROM quality_actual_budget_events WHERE json_extract(body,'$.payload.kind')='recognize-usage' AND json_extract(body,'$.payload.runId')=?",
        )
        .get(knownId)! as (typeof newerRows)[string];
      newerRows.quality_actual_artifacts = db
        .prepare(
          "SELECT * FROM quality_actual_artifacts WHERE run_id=? AND artifact_key='generation-response'",
        )
        .get(knownId)! as (typeof newerRows)[string];
    } finally {
      db.close();
    }
  }, 45000);
  afterAll(() => {
    if (seed) {
      expect(readFileSync(join(seed, "studio.sqlite"), "utf8")).toBe(sentinel);
      cleanup(seed);
    }
  });
  function copy(bytes = originalBytes) {
    const root = mkdtempSync(join(tmpdir(), "venture-v6-backup-"));
    temporary.push(root);
    mkdirSync(join(root, "quality-evaluation"));
    writeFileSync(join(root, "quality-evaluation", "quality.sqlite"), bytes);
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
  function downgradeFixture(db: DatabaseSync) {
    freezePolicyFreeSchema(db, 5);
  }
  it.each([
    "quality_actual_events",
    "quality_actual_requests",
    "quality_actual_budget_events",
    "quality_actual_artifacts",
  ])(
    "rejects real new %s rows injected into an otherwise valid v5 reservation fixture",
    (table) => {
      const root = copy(reservationBytes),
        file = join(root, "quality-evaluation", "quality.sqlite");
      const db = new DatabaseSync(file);
      try {
        downgradeFixture(db);
        expect(inspectQualityDatabase(db)).toMatchObject({ storageVersion: 5 });
        const row = newerRows[table],
          keys = Object.keys(row);
        db.prepare(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
        ).run(...Object.values(row));
        expect(() => inspectQualityDatabase(db)).toThrow(/QUALITY_DATABASE_INVALID/);
        const before = inspectQualitySchema(db);
        db.exec("BEGIN IMMEDIATE");
        expect(() => migrateQualitySchemaV6(db)).toThrow(/QUALITY_DATABASE_INVALID/);
        db.exec("ROLLBACK");
        expect(inspectQualitySchema(db)).toEqual(before);
      } finally {
        db.close();
      }
    },
  );
  it("accepts a valid v2 final JSON between the old 2 MiB and new 4 MiB limits", async () => {
    const root = copy();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(actualTestNow);
    const store = new PlanQualityStore(root, {
      actualEnvironment: "synthetic-test",
      providerEnvironment: "synthetic-test",
    });
    const finish = store.providerRecordFinish.bind(store);
    const intercept = vi.spyOn(store, "providerRecordFinish").mockImplementation((id, input) => {
      if (!input.artifact || input.payload.outcome !== "completed") return finish(id, input);
      const artifact = createProviderExecutionArtifact({
        runId: id,
        key: "final-result",
        body: `${input.artifact.body}${" ".repeat(2 * 1024 * 1024)}`,
      });
      return finish(id, {
        ...input,
        artifact,
        payload: { ...input.payload, finalArtifactSha256: artifact.sha256 },
      });
    });
    try {
      const id = store.providerStart(providerTestStartInput(store, 3)).snapshot.run.id;
      const approval = providerExecutionTestApproval(store, id);
      const plan = actualTestPlan(store.candidateRegistryGet(1), 3);
      const send = vi.fn(async ({ request }: { request: { phase: string } }) =>
        providerExecutionTestResponse(request.phase === "generation" ? plan : { findings: [] }),
      );
      const result = await runQualityProviderSimulation(store, id, approval, {
        transport: {
          provenance: "synthetic-test",
          model: "synthetic-provider-model",
          contractDigest: approval.payload.manifest.executionContract.contractDigest,
          send,
        },
      });
      expect(result.snapshot.state).toBe("completed");
      expect(send).toHaveBeenCalledTimes(2);
      const artifact = store.providerArtifact(id, "final-result");
      expect(artifact.body.byteLength).toBeGreaterThan(2 * 1024 * 1024);
      expect(artifact.body.byteLength).toBeLessThan(4 * 1024 * 1024);
      expect(() =>
        validateActualArtifact({ ...artifact, body: artifact.body.toString("utf8") }),
      ).toThrow(/Actual artifact bytes mismatch/);
      expect(inspect(root)).toMatchObject({
        storageVersion: 9,
        actualArtifacts: 12,
        providerPolicies: 0,
      });
    } finally {
      intercept.mockRestore();
      store.close();
      vi.useRealTimers();
    }
  }, 30000);
  it("preserves old format 2 prefixes and new format 3 records in one v6 backup and restore", async () => {
    const source = copy(),
      parent = mkdtempSync(join(tmpdir(), "venture-v6-backup-"));
    temporary.push(parent);
    const backup = join(parent, "backup"),
      destination = join(parent, "restore");
    mkdirSync(destination);
    writeFileSync(join(destination, "studio.sqlite"), sentinel);
    const { storageVersion, digest: ignored, ...counts } = inspect(source);
    void ignored;
    expect(storageVersion).toBe(6);
    expect(await backupQualityData(source, backup)).toEqual(counts);
    expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 6, ...counts });
    expect(restoreQualityData(backup, destination)).toEqual(counts);
    expect(readFileSync(join(source, "quality-evaluation", "quality.sqlite"))).toEqual(
      originalBytes,
    );
    expect(readFileSync(join(destination, "quality-evaluation", "quality.sqlite"))).toEqual(
      readFileSync(join(backup, "quality.sqlite")),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2030-01-01T00:00:00.000Z");
    const restored = new PlanQualityStore(destination);
    try {
      expect(restored.actualDownload(legacyId, 0).body).toBe(legacyArchive);
      expect(restored.providerDownload(cancelledId, 1).body).toBe(cancelledArchive);
      expect(restored.providerDownload(knownId, 0).body).toBe(beforeApprovalArchive);
      expect(restored.providerDownload(knownId, 3).body).toBe(dispatchArchive);
      expect(restored.providerDownload(knownId, 5).body).toBe(knownArchive);
      expect(restored.providerDownload(unknownId, 4).body).toBe(unknownArchive);
      expect(restored.providerGet(knownId)).toMatchObject({
        state: "output-invalid",
        dispatchIntentCount: 1,
        responseCount: 1,
      });
      expect(restored.providerGet(unknownId)).toMatchObject({
        state: "result-unobserved",
        unobservedDispatchCount: 1,
        dispatchAllowed: false,
        canResume: false,
      });
      expect(restored.providerBudgetGet()).toMatchObject({ recognizedUnits: "2", heldUnits: "2" });
    } finally {
      restored.close();
      vi.useRealTimers();
    }
    for (const root of [source, destination])
      expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(sentinel);
  }, 150000);
});
