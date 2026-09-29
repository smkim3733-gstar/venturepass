/** Temporary synthetic databases only. These records are not real approval or payment evidence. */
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { getPlanExecutionContract } from "./studio-engine";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { prepareProviderPolicyAdoption } from "./studio-plan-quality-provider-policy-adoption";
import type { ProviderPolicyAdoptionWritePlan } from "./studio-plan-quality-provider-policy-adoption-types";
import { inspectLedgerDatabase } from "./studio-plan-quality-ledger-database";
import { freezePolicyFreeSchema } from "./studio-plan-quality-policy-storage-test-helpers";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";
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
import {
  backupQualityData,
  restoreQualityData,
  verifyQualityBackup,
  inspectQualityDatabase,
  migrateQualitySchemaV8,
} from "../../scripts/local-data-quality.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("No external IO");
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
let workspace: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
const sentinel = "PRESERVE SYNTHETIC COMPANY DATABASE";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  workspace = mkdtempSync(join(tmpdir(), "venture-policy-v7-"));
  directory = join(workspace, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory, {
    actualEnvironment: "synthetic-test",
    providerEnvironment: "synthetic-test",
  });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", { deterministic: true }, () => "quality-v9");
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  db.close();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(workspace));
  if (!rel.startsWith("venture-policy-v7-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(workspace, { recursive: true, force: true });
});
function state() {
  return inspectLedgerDatabase(db, (version) => store.candidateRegistryGet(version));
}
function plan(): ProviderPolicyAdoptionWritePlan {
  const currentState = state(),
    registry = store.candidateRegistryGet(1),
    events = currentState.provider.budgetEvents.filter(
      (e) => e.scopeId === "candidate-quality-provider-v2-live",
    ),
    current = {
      registry,
      candidateId: registry.entries[0].candidateId,
      inspectedAt: actualTestNow,
      configuration: getProviderConfigurationProposal(),
      budgetEvents: events,
      expectedBudgetHead: {
        revision: events.length,
        headDigest: events.at(-1)?.eventDigest ?? null,
      },
    };
  const review = createProviderPolicyReview(current);
  if (review.status !== "review") throw new Error(review.reason);
  const command = {
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: 1,
    versionDigest: registry.versionDigest,
    candidateId: current.candidateId,
    expectedPolicyHead: {
      revision: currentState.policy.revision,
      headDigest: currentState.policy.headDigest,
    },
    approvedReviewDigest: review.review.reviewDigest,
    budgetAction: events.length ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: events.length ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: actualTestNow,
    },
  };
  const result = prepareProviderPolicyAdoption({
    command,
    review: review.review,
    current,
    currentPolicyHead: command.expectedPolicyHead,
    usedRequestIds: [
      registry.clientRequestId,
      ...currentState.policy.nonces,
      ...currentState.provider.receipts.map((r) => r.clientRequestId),
    ],
  });
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function seed(p = plan(), failAfter = -1) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = p.record;
    db.prepare(
      "INSERT INTO quality_provider_policies(scope_id,revision,nonce,body,body_hash) VALUES(?,?,?,?,?)",
    ).run(r.scopeId, r.revision, r.clientRequestId, JSON.stringify(r), digest(r));
    if (failAfter === 1) throw new Error("Injected row failure");
    if (p.initialization) {
      const { event: e, receipt: receipt } = p.initialization;
      db.prepare("INSERT INTO quality_actual_budget_events VALUES(?,?,?,?)").run(
        e.scopeId,
        e.revision,
        JSON.stringify(e),
        digest(e),
      );
      if (failAfter === 2) throw new Error("Injected row failure");
      db.prepare("INSERT INTO quality_actual_requests VALUES(?,?,?)").run(
        receipt.clientRequestId,
        JSON.stringify(receipt),
        digest(receipt),
      );
      if (failAfter === 3) throw new Error("Injected row failure");
    }
    db.exec("COMMIT");
    return p;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function tamper(
  table: string,
  action: "update" | "delete",
  sql: string,
  args: Array<string | number> = [],
) {
  const key = `${table}_no_${action}`,
    trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(key)!.sql as string;
  db.exec(`DROP TRIGGER ${key}`);
  db.prepare(sql).run(...args);
  db.exec(trigger);
}
it("keeps prior definitions frozen and installs eighteen immutable v9 tables", () => {
  const schema = inspectQualitySchema(db);
  expect(schema).toMatchObject({ version: 9, policies: true, reservations: true });
  expect(schema.tables).toHaveLength(18);
  expect(schema.schema).toHaveLength(72);
  expect(() => migrateQualitySchemaV6(db)).toThrow("QUALITY_SCHEMA_UNSUPPORTED");
  expect(db.prepare("SELECT quality_storage_contract() AS v").get()!.v).toBe("quality-v9");
});
it.each([0, 1, 2, 3, 4, 5, 6])(
  "upgrades exact v%i tables without rewriting old rows and rolls schema changes back",
  (version) => {
    const old = new DatabaseSync(":memory:");
    try {
      if (version === 4) migrateQualitySchemaV4(old);
      else if (version === 5) migrateQualitySchemaV5(old);
      else if (version === 6) migrateQualitySchemaV6(old);
      else if (version)
        for (const [table, sql] of Object.entries(qualityLegacyTableSql).slice(
          0,
          version === 1 ? 3 : version === 2 ? 5 : 8,
        )) {
          old.exec(sql);
          for (const action of ["update", "delete"])
            old.exec(qualityImmutableTriggerSql[`${table}_no_${action}`]);
        }
      const before = inspectQualitySchema(old, { allowEmpty: true });
      if (version)
        old
          .prepare("INSERT INTO quality_runs VALUES(?,?,?)")
          .run("migration-sentinel", '{ "original": true }', "original-hash");
      const bytes = version ? old.prepare("SELECT * FROM quality_runs").all() : [];
      old.exec("BEGIN IMMEDIATE");
      migrateQualitySchemaV7(old);
      old.exec("ROLLBACK");
      expect(inspectQualitySchema(old, { allowEmpty: true })).toEqual(before);
      old.exec("BEGIN IMMEDIATE");
      migrateQualitySchemaV7(old);
      old.exec("COMMIT");
      expect(old.prepare("SELECT * FROM quality_runs").all()).toEqual(bytes);
      expect(inspectQualitySchema(old).version).toBe(7);
      migrateQualitySchemaV7(old);
      expect(old.prepare("SELECT * FROM quality_runs").all()).toEqual(bytes);
    } finally {
      old.close();
    }
  },
);
it("blocks an already open v6 writer after a separate v7 migration", () => {
  const file = join(directory, "old-writer.sqlite"),
    old = new DatabaseSync(file),
    modern = new DatabaseSync(file);
  try {
    migrateQualitySchemaV6(old);
    const statement = old.prepare("INSERT INTO quality_actual_requests VALUES(?,?,?)");
    modern.exec("BEGIN IMMEDIATE");
    migrateQualitySchemaV7(modern);
    modern.exec("COMMIT");
    expect(() => statement.run(randomUUID(), "{}", "hash")).toThrow("unsupported writer");
  } finally {
    old.close();
    modern.close();
  }
});
it("blocks every table for old or missing writer callbacks and disallows policy updates/deletion", () => {
  for (const contract of ["quality-v8", "quality-v7", "quality-v6", "quality-v5", null]) {
    const isolated = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      if (contract) isolated.function("quality_storage_contract", () => contract);
      for (const table of Object.keys(qualityV9TableSql))
        expect(() => isolated.exec(`INSERT INTO ${table} DEFAULT VALUES`)).toThrow(
          contract ? /unsupported writer/ : /quality_storage_contract/,
        );
    } finally {
      isolated.close();
    }
  }
  seed();
  expect(() => db.exec("UPDATE quality_provider_policies SET body='{}'")).toThrow("immutable");
  expect(() => db.exec("DELETE FROM quality_provider_policies")).toThrow("immutable");
});
it.each([1, 2, 3])(
  "rolls the policy and initialization rows back on failure after row %i",
  (count) => {
    const before = inspectQualityDatabase(db);
    expect(() => seed(plan(), count)).toThrow("Injected row failure");
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(state().policy.revision).toBe(0);
  },
);
it("backs up and restores policy records byte-for-byte while preserving legacy records and company data", async () => {
  const first = seed();
  const second = seed();
  expect(second.initialization).toBeNull();
  const before = inspectQualityDatabase(db),
    recordBytes = db.prepare("SELECT * FROM quality_provider_policies ORDER BY revision").all();
  expect(before).toMatchObject({
    storageVersion: 9,
    providerPolicies: 2,
    actualBudgetEvents: 1,
    actualRequests: 1,
  });
  const backup = join(workspace, "backup"),
    restored = join(workspace, "restore");
  mkdirSync(restored);
  writeFileSync(join(restored, "studio.sqlite"), sentinel);
  const original = readFileSync(join(directory, "quality-evaluation", "quality.sqlite"));
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 9, providerPolicies: 2 });
  const forbiddenRoot = join(workspace, "forbidden-root");
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
  expect(verified.error).toBeUndefined();
  expect(verified.status, verified.stdout + verified.stderr).toBe(0);
  expect(verified.stdout + verified.stderr).not.toContain(sentinel);
  expect(verified.stdout + verified.stderr).not.toContain(workspace);
  expect(existsSync(forbiddenRoot)).toBe(false);
  expect(JSON.parse(verified.stdout)).toMatchObject({
    ok: true,
    action: "quality-verify",
    providerPolicies: 2,
    actualBudgetEvents: 1,
    companyDataChanged: false,
    switched: false,
  });
  expect(restoreQualityData(backup, restored)).toMatchObject({ providerPolicies: 2 });
  expect(readFileSync(join(directory, "quality-evaluation", "quality.sqlite"))).toEqual(original);
  expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const reopened = new PlanQualityStore(restored),
    connection = new DatabaseSync(join(restored, "quality-evaluation", "quality.sqlite"));
  try {
    expect(
      connection.prepare("SELECT * FROM quality_provider_policies ORDER BY revision").all(),
    ).toEqual(recordBytes);
    expect(inspectQualityDatabase(connection)).toEqual(before);
    expect(reopened.providerReviewContext(1).budgetEvents[0].eventId).toBe(
      first.initialization!.event.eventId,
    );
  } finally {
    connection.close();
    reopened.close();
  }
}, 150000);
it("upgrades an existing v6 database while preserving candidate bytes and old schema coverage", () => {
  const prior = store.candidateRegistryDownload(1).body;
  store.close();
  freezePolicyFreeSchema(db, 6);
  const schema6 = inspectQualityDatabase(db);
  expect(schema6.storageVersion).toBe(6);
  store = new PlanQualityStore(directory);
  expect(store.candidateRegistryDownload(1).body).toBe(prior);
  expect(inspectQualityDatabase(db)).toMatchObject({ storageVersion: 9, providerPolicies: 0 });
});
it.each([
  "nonce",
  "body-hash",
  "resealed-proof",
  "missing-budget",
  "missing-receipt",
  "missing-predecessor",
  "oversized-body",
])("rejects %s in both application reads and backup inspection", (kind) => {
  const p = seed();
  if (kind === "missing-predecessor") seed();
  if (kind === "nonce")
    tamper(
      "quality_provider_policies",
      "update",
      "UPDATE quality_provider_policies SET nonce=? WHERE revision=1",
      [randomUUID()],
    );
  else if (kind === "body-hash")
    tamper(
      "quality_provider_policies",
      "update",
      "UPDATE quality_provider_policies SET body_hash=? WHERE revision=1",
      ["a".repeat(64)],
    );
  else if (kind === "resealed-proof") {
    p.record.reviewedProposal.financialBasis.costs.generation.inputUnits = "1";
    p.record.recordDigest = digest(
      Object.fromEntries(Object.entries(p.record).filter(([key]) => key !== "recordDigest")),
    );
    tamper(
      "quality_provider_policies",
      "update",
      "UPDATE quality_provider_policies SET body=?,body_hash=? WHERE revision=1",
      [JSON.stringify(p.record), digest(p.record)],
    );
  } else if (kind === "oversized-body")
    tamper(
      "quality_provider_policies",
      "update",
      "UPDATE quality_provider_policies SET body=? WHERE revision=1",
      [" ".repeat(2 * 1024 * 1024 + 1)],
    );
  else if (kind === "missing-budget")
    tamper("quality_actual_budget_events", "delete", "DELETE FROM quality_actual_budget_events");
  else if (kind === "missing-receipt")
    tamper("quality_actual_requests", "delete", "DELETE FROM quality_actual_requests");
  else
    tamper(
      "quality_provider_policies",
      "delete",
      "DELETE FROM quality_provider_policies WHERE revision=1",
    );
  expect(() => inspectQualityDatabase(db)).toThrow();
  expect(() => store.list()).toThrow();
  expect(() => store.candidateRegistryList()).toThrow();
});
it.each(["evaluation", "candidate", "execution", "legacy-budget", "provider-budget"])(
  "rejects policy nonce reuse in %s without committing any row",
  (kind) => {
    const nonce = seed().record.clientRequestId,
      before = inspectQualityDatabase(db);
    expect(() => {
      if (kind === "evaluation")
        store.create({
          clientRequestId: nonce,
          title: "synthetic",
          manifestDigest: store.list().manifestDigest,
        });
      else if (kind === "candidate")
        store.candidateRegistryRegister({
          clientRequestId: nonce,
          expectedVersion: 1,
          sourceDigest: store.candidateRegistryList().source.sourceDigest,
          acknowledgedCandidateStatus: true,
        });
      else if (kind === "execution") {
        const contract = getPlanExecutionContract(),
          registry = store.candidateRegistryGet(1);
        store.executionStart(
          {
            clientRequestId: nonce,
            acknowledgedMockOnly: true,
            preparation: store.executionPrepare(
              { version: 1, candidateId: registry.entries[0].candidateId },
              contract,
            ),
          },
          contract,
        );
      } else if (kind === "legacy-budget")
        store.actualBudgetConfigure({
          clientRequestId: nonce,
          expectedRevision: 0,
          policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
        });
      else
        store.providerBudgetConfigure({
          clientRequestId: nonce,
          expectedRevision: 0,
          policy: {
            environment: "synthetic-test",
            provenance: "synthetic-test",
            currency: "TST",
            unitScale: 6,
            capUnits: "100",
          },
        });
    }).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("counts raw policy bytes toward the shared storage cap before legacy writes", () => {
  seed();
  const total = Object.keys(qualityV9TableSql)
    .filter((t) => t !== "quality_actual_artifacts")
    .reduce(
      (n, t) =>
        n +
        Number(
          db.prepare(`SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS n FROM ${t}`).get()!.n,
        ),
      0,
    );
  const policyBytes = Number(
    db.prepare("SELECT SUM(length(CAST(body AS BLOB))) AS n FROM quality_provider_policies").get()!
      .n,
  );
  const original = planQualityStoreLimits.totalBytes;
  try {
    // A small temporary cap exercises real accounting without manufacturing 256 MiB of fixtures.
    Object.assign(planQualityStoreLimits, { totalBytes: total - Math.floor(policyBytes / 2) });
    expect(() => store.list()).toThrow(/보관 용량/);
  } finally {
    Object.assign(planQualityStoreLimits, { totalBytes: original });
  }
});
it("rejects changed policy counts in a resealed backup manifest", async () => {
  seed();
  const backup = join(workspace, "bad-manifest");
  await backupQualityData(directory, backup);
  const file = join(backup, "quality-backup-manifest.json"),
    manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.providerPolicies = 0;
  const body = JSON.stringify(manifest);
  writeFileSync(file, body);
  writeFileSync(
    join(backup, "COMPLETE.json"),
    JSON.stringify({
      format: "venturepass-quality-backup-complete",
      manifestSha256: createHash("sha256").update(body).digest("hex"),
    }),
  );
  expect(() => verifyQualityBackup(backup)).toThrow("QUALITY_DATABASE_CHANGED");
}, 150000);
it.each(["missing", "mixed"])("rejects %s v9 writer gates instead of repairing them", (kind) => {
  if (kind === "missing") db.exec("DROP TRIGGER quality_provider_policies_v9_writer");
  else db.exec(qualityV9WriterTriggerSql.quality_runs_v9_writer.replaceAll("v9", "v10"));
  db.exec("BEGIN IMMEDIATE");
  expect(() => migrateQualitySchemaV8(db)).toThrow("QUALITY_SCHEMA_UNSUPPORTED");
  db.exec("ROLLBACK");
  expect(() => inspectQualityDatabase(db)).toThrow("QUALITY_SCHEMA_UNSUPPORTED");
});
