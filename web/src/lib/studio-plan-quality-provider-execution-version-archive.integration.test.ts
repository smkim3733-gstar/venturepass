/** Isolated synthetic SQLite archives. SQL fixture insertion is test-only, never a runtime writer. */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("No supplier or customer IO");
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
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import {
  complete,
  prepare,
  dispatch,
  receive,
  finish,
  snapshot,
  type Fixture,
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import * as core from "../../scripts/local-data-quality-provider.mjs";
import {
  backupQualityData,
  verifyQualityBackup,
  restoreQualityData,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";
import type {
  ProviderReceipt,
  ProviderArtifact,
  ProviderBudgetEvent,
} from "./studio-plan-quality-provider-types";
import type { VersionedProviderExecutionEvent } from "./studio-plan-quality-provider-execution-types";

const sentinel = "SYNTHETIC COMPANY DATABASE - DO NOT OPEN",
  v2 = "plan-observation-v2";
let seedRoot: string,
  seedBytes: Buffer,
  oldId: string,
  id: string,
  oldExport: string,
  approvedExport: string,
  reservedExport: string;
let baselineRecognized: string;
let originalHistory: NonNullable<ReturnType<PlanQualityStore["inspectCompletedProviderHistory"]>>;
let originalApproval: ReturnType<PlanQualityStore["providerApproveTransmission"]>;
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
const databasePath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
function cleanup(path: string) {
  const rel = relative(resolve(tmpdir()), resolve(path));
  if (!rel.startsWith("venture-execution-version-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
}
function rows(connection: DatabaseSync) {
  return connection
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [
      name,
      connection.prepare("SELECT rowid,* FROM " + name + " ORDER BY rowid").all(),
    ]);
}
function stale() {
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("No current configuration");
  });
  vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
    throw Error("No current prompt");
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  seedRoot = mkdtempSync(join(tmpdir(), "venture-execution-version-seed-"));
  writeFileSync(join(seedRoot, "studio.sqlite"), sentinel);
  let seeded = new PlanQualityStore(seedRoot, { providerEnvironment: "synthetic-test" });
  try {
    seeded.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: seeded.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const legacy = await finalizationStoreFixture(seeded);
    seeded.providerRecordFinalization(legacy.identity);
    oldId = legacy.identity.validation.dispatch.generation.dispatch.runId;
    oldExport = seeded.providerDownload(oldId, 10).body;
    baselineRecognized = seeded.providerBudgetGet("production").recognizedUnits;
    originalHistory = seeded.inspectCompletedProviderHistory({ runId: oldId, budgetRevision: seeded.providerBudgetGet("production").revision })!;
    seeded.close();
    seeded = new PlanQualityStore(seedRoot, {
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    });
    vi.setSystemTime("2026-09-27T03:32:00.000Z");
    const registry = seeded.candidateRegistryGet(1),
      candidateId = registry.entries[1].candidateId;
    const { result, expectedPolicyHead } = seeded.providerPolicyReview(1, candidateId);
    if (result.status !== "review") throw Error(result.reason);
    seeded.providerPolicyAdopt(
      providerPolicyAdoptionCommandSchema.parse({
        commandVersion: 1,
        kind: "adopt-provider-policy",
        clientRequestId: randomUUID(),
        version: 1,
        versionDigest: registry.versionDigest,
        candidateId,
        expectedPolicyHead,
        approvedReviewDigest: result.review.reviewDigest,
        budgetAction: "keep-existing-budget",
        initialBudgetRequestId: null,
        approval: {
          noticeVersion: 1,
          acknowledgedPolicy: true,
          acknowledgedBudgetAction: true,
          reservationAndTransmission: "separate-approval-required",
          approvedAt: new Date().toISOString(),
        },
      }),
      result.review,
    );
    const r = reservationStoreFixture(seeded, 1),
      reserved = seeded.providerReserve(r.command, r.review);
    id = reserved.record.runId;
    reservedExport = seeded.providerDownload(id, 0).body;
    vi.setSystemTime("2026-09-27T03:33:00.000Z");
    const a = transmissionStoreFixture(seeded, reserved.record);
    originalApproval = seeded.providerApproveTransmission(a.command, a.review);
    approvedExport = seeded.providerDownload(id, 1).body;
  } finally {
    seeded.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  seedBytes = readFileSync(databasePath(seedRoot));
}, 40000);

afterAll(() => {
  if (seedRoot) cleanup(seedRoot);
});
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-execution-version-read-"));
  directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  writeFileSync(databasePath(directory), seedBytes);
  store = new PlanQualityStore(directory);
  db = new DatabaseSync(databasePath(directory));
  db.function("quality_storage_contract", () => "quality-v9");
});
afterEach(() => {
  db?.close();
  store?.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (root) cleanup(root);
});

function append(outcome: "completed" | "unknown" | "unobserved" = "completed") {
  db.exec("BEGIN");
  let data: Fixture["data"];
  try {
    const ledger = readLedgerDatabaseInput(db, (v) => store.candidateRegistryGet(v)),
      run = core.versionedProviderRunSchema.parse(
        ledger.runs.find((r) => (r as { id: string }).id === id),
      );
    data = {
      run,
      events: ledger.events.filter(
        (e) => (e as { runId: string }).runId === id,
      ) as VersionedProviderExecutionEvent[],
      artifacts: ledger.artifacts.filter(
        (a) => (a as { runId: string }).runId === id,
      ) as ProviderArtifact[],
      budgetEvents: ledger.budgetEvents.filter(
        (e) => (e as { scopeId: string }).scopeId === run.preparation.budget.scopeId,
      ) as ProviderBudgetEvent[],
      receipts: ledger.receipts.filter(
        (r) => (r as { runId: string }).runId === id,
      ) as ProviderReceipt[],
      registry: store.candidateRegistryGet(run.preparation.scope.version),
    };
  } finally {
    db.exec("ROLLBACK");
  }
  const f: Fixture = { data, preparation: data.run.preparation, registry: data.registry },
    budgetRevision = data.budgetEvents.at(-1)!.revision;
  if (outcome === "completed") complete(f);
  else {
    prepare(f, "generation");
    dispatch(f, "generation");
    if (outcome === "unknown")
      receive(f, "generation", (raw) => {
        delete raw.usage;
      });
    finish(f, outcome === "unknown" ? "needs-cost-review" : "result-unobserved");
  }
  const expected = snapshot(f); // Reject bad fixture before any SQL insertion.
  db.exec("BEGIN IMMEDIATE");
  try {
    const put = (table: string, keys: Record<string, SQLInputValue>, value: unknown) => {
      const cols = [...Object.keys(keys), "body", "body_hash"];
      db.prepare(
        "INSERT INTO " +
          table +
          "(" +
          cols.join(",") +
          ") VALUES(" +
          cols.map(() => "?").join(",") +
          ")",
      ).run(
        ...Object.values(keys),
        JSON.stringify(value, null, 2) + String.fromCharCode(10),
        core.providerDigest(value),
      );
    };
    for (const a of data.artifacts.filter((a) => a.key !== "generation-request"))
      db.prepare(
        "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
      ).run(a.runId, a.key, Buffer.from(a.body), a.sha256, a.sizeBytes);
    for (const e of data.budgetEvents.filter((e) => e.revision > budgetRevision))
      put("quality_actual_budget_events", { scope_id: e.scopeId, revision: e.revision }, e);
    for (const e of data.events.filter((e) => e.revision > 1))
      put("quality_actual_events", { run_id: e.runId, revision: e.revision }, e);
    for (const r of data.receipts.filter((r) => r.runRevision! > 1))
      put("quality_actual_requests", { nonce: r.clientRequestId }, r);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { f, expected };
}

it("reads every revision and original artifact of a complete v2 run while preserving v1 and approval bytes", () => {
  const { f, expected } = append(),
    before = rows(db);
  stale();
  expect(store.providerArchiveGet(id)).toEqual(expected);
  expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
  expect(store.providerDownload(id, 0).body).toBe(reservedExport);
  expect(store.providerDownload(id, 1).body).toBe(approvedExport);
  for (let revision = 0; revision <= 10; revision++) {
    const value = store.providerArchiveGet(id, revision),
      archive = JSON.parse(store.providerDownload(id, revision).body);
    expect(value.revision).toBe(revision);
    expect(archive.events).toHaveLength(revision);
    expect(value.artifacts.map((a) => a.key).sort()).toEqual(
      archive.artifacts.map((a: { key: string }) => a.key).sort(),
    );
    if (revision < 4)
      expect(value.artifacts.some((a) => a.key === "generation-response")).toBe(false);
    if (revision < 8) expect(value.artifacts.some((a) => a.key === "review-response")).toBe(false);
    if (revision < 10) expect(value.artifacts.some((a) => a.key === "final-result")).toBe(false);
  }
  for (const a of f.data.artifacts)
    expect(store.providerArtifact(id, a.key).body).toEqual(Buffer.from(a.body));
  for (const r of f.data.receipts)
    expect(store.providerLookup(r.clientRequestId)).toEqual({ state: "committed", receipt: r });
  const exported = store.providerDownload(id, 10).body,
    rawEvent = String(
      db.prepare("SELECT body FROM quality_actual_events WHERE run_id=? AND revision=4").get(id)!
        .body,
    );
  expect(exported).toContain(rawEvent);
  expect(JSON.parse(exported)).toMatchObject({
    archiveFormatVersion: 5,
    kind: "provider-execution-archive",
    run: { archiveFormatVersion: 3 },
  });
  expect(store.providerBudgetGet("production")).toMatchObject({
    capUnits: "15000000",
    heldUnits: "0",
    recognizedUnits: (BigInt(baselineRecognized) + BigInt(350)).toString(),
  });
  expect(() => store.providerGet(id)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(rows(db)).toEqual(before);
}, 20000);

it("backs up and restores mixed full executions with identical raw rows, exports, budget and original approval nonce", async () => {
  const { expected } = append(),
    before = rows(db),
    audit = inspectQualityDatabase(db),
    budget = store.providerBudgetGet("production"),
    exported = store.providerDownload(id, 10).body;
  const backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  writeFileSync(join(restored, "studio.sqlite"), sentinel);
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({
    version: 9,
    actualRuns: 2,
    actualEvents: 20,
    providerPolicies: 2,
  });
  restoreQualityData(backup, restored);
  stale();
  const reopened = new PlanQualityStore(restored),
    connection = new DatabaseSync(databasePath(restored));
  try {
    expect(rows(connection)).toEqual(before);
    expect(inspectQualityDatabase(connection)).toEqual(audit);
    expect(reopened.providerArchiveGet(id)).toEqual(expected);
    expect(reopened.providerBudgetGet("production")).toEqual(budget);
    expect(reopened.providerDownload(id, 10).body).toBe(exported);
    expect(reopened.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(reopened.providerApproveTransmission(originalApproval.record.command, null)).toEqual({
      ...originalApproval,
      newlyCommitted: false,
      replayed: true,
    });
    expect(rows(connection)).toEqual(before);
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
    expect(
      connection
        .prepare("SELECT COUNT(*) AS n FROM quality_actual_budget_events WHERE revision=1")
        .get()!.n,
    ).toBe(1);
  } finally {
    connection.close();
    reopened.close();
  }
}, 25000);

it.each(["unknown", "unobserved"] as const)(
  "preserves %s costs and holds through cold backup restore without permitting resume",
  async (outcome) => {
    const { expected } = append(outcome),
      budget = store.providerBudgetGet("production"),
      backup = join(root, "backup"),
      restored = join(root, "restored");
    mkdirSync(restored);
    writeFileSync(join(restored, "studio.sqlite"), sentinel);
    expect(expected).toMatchObject({
      unsettled: true,
      canResume: false,
      dispatchAllowed: false,
      dispatchIntentCount: 1,
    });
    expect(BigInt(budget.heldUnits)).toBeGreaterThan(BigInt(0));
    await backupQualityData(directory, backup);
    restoreQualityData(backup, restored);
    stale();
    const reopened = new PlanQualityStore(restored);
    try {
      expect(reopened.providerArchiveGet(id)).toEqual(expected);
      expect(reopened.providerBudgetGet("production")).toEqual(budget);
      expect(() => reopened.providerGet(id)).toThrow(
        expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
      );
    } finally {
      reopened.close();
    }
  },
  20000,
);

function tamper(table: string, action: "update" | "delete", work: () => void) {
  const name = table + "_no_" + action,
    sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql);
  db.exec("DROP TRIGGER " + name);
  try {
    work();
  } finally {
    db.exec(sql);
  }
}
it.each([
  "missing-response",
  "artifact-bytes",
  "event-version",
  "receipt-digest",
  "budget-amount",
  "missing-binding",
  "registration",
] as const)(
  "refuses %s corruption across archive, nonce, export and backup, even for an early prefix",
  async (kind) => {
    append();
    if (kind === "missing-response")
      tamper("quality_actual_artifacts", "delete", () => {
        db.prepare(
          "DELETE FROM quality_actual_artifacts WHERE run_id=? AND artifact_key='review-response'",
        ).run(id);
      });
    if (kind === "artifact-bytes")
      tamper("quality_actual_artifacts", "update", () => {
        const body = Buffer.from("{}");
        db.prepare(
          "UPDATE quality_actual_artifacts SET payload=?,size_bytes=?,sha256=? WHERE run_id=? AND artifact_key='generation-response'",
        ).run(body, body.length, createHash("sha256").update(body).digest("hex"), id);
      });
    if (kind === "event-version")
      tamper("quality_actual_events", "update", () => {
        const row = db
            .prepare("SELECT body FROM quality_actual_events WHERE run_id=? AND revision=6")
            .get(id)!,
          e = JSON.parse(String(row.body));
        e.executionContractVersion = 1;
        const { eventDigest: _, ...input } = e;
        void _;
        e.eventDigest = core.providerDigest(input);
        db.prepare(
          "UPDATE quality_actual_events SET body=?,body_hash=? WHERE run_id=? AND revision=6",
        ).run(JSON.stringify(e), core.providerDigest(e), id);
      });
    if (kind === "receipt-digest")
      tamper("quality_actual_requests", "update", () => {
        const r = JSON.parse(
          String(
            db
              .prepare(
                "SELECT body FROM quality_actual_requests WHERE json_extract(body,'$.runId')=? AND json_extract(body,'$.runRevision')=10",
              )
              .get(id)!.body,
          ),
        );
        r.inputDigest = "a".repeat(64);
        db.prepare("UPDATE quality_actual_requests SET body=?,body_hash=? WHERE nonce=?").run(
          JSON.stringify(r),
          core.providerDigest(r),
          r.clientRequestId,
        );
      });
    if (kind === "budget-amount")
      tamper("quality_actual_budget_events", "update", () => {
        const r = JSON.parse(
          String(
            db
              .prepare(
                "SELECT body FROM quality_actual_budget_events WHERE json_extract(body,'$.payload.runId')=? AND json_extract(body,'$.payload.kind')='recognize-usage' ORDER BY revision LIMIT 1",
              )
              .get(id)!.body,
          ),
        );
        r.payload.recognizedUnits = "0";
        const { eventDigest: _, ...input } = r;
        void _;
        r.eventDigest = core.providerDigest(input);
        db.prepare(
          "UPDATE quality_actual_budget_events SET body=?,body_hash=? WHERE scope_id=? AND revision=?",
        ).run(JSON.stringify(r), core.providerDigest(r), r.scopeId, r.revision);
      });
    if (kind === "missing-binding")
      tamper("quality_provider_transmission_bindings", "delete", () => {
        db.prepare("DELETE FROM quality_provider_transmission_bindings WHERE run_id=?").run(id);
      });
    if (kind === "registration")
      tamper("quality_candidate_versions", "update", () => {
        db.prepare("UPDATE quality_candidate_versions SET body_hash=?").run("a".repeat(64));
      });
    const before = rows(db);
    expect(() => store.providerArchiveGet(id, 0)).toThrow();
    expect(() => store.providerDownload(oldId, 10)).toThrow();
    expect(() => store.providerArtifact(id, "generation-request")).toThrow();
    expect(() => store.providerLookup(originalApproval.record.clientRequestId)).toThrow();
    expect(() => inspectQualityDatabase(db)).toThrow();
    const backup = join(root, "corrupt-backup");
    await expect(backupQualityData(directory, backup)).rejects.toThrow();
    expect(rows(db)).toEqual(before);
    expect(existsSync(join(backup, "manifest.json"))).toBe(false);
  },
  20000,
);

it("audits the mixed full database in a fresh Node reader without current time, configuration or network", () => {
  append();
  const expected = inspectQualityDatabase(db),
    url = pathToFileURL(resolve("scripts/local-data-quality.mjs")).href;
  const script =
    "import {DatabaseSync} from 'node:sqlite'; const core=await import(" +
    JSON.stringify(url) +
    "); Date.now=()=>{throw Error('clock')};globalThis.fetch=()=>{throw Error('network')};const db=new DatabaseSync(process.argv[1],{readOnly:true});try{process.stdout.write(JSON.stringify(core.inspectQualityDatabase(db)))}finally{db.close()}";
  expect(
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", script, databasePath(directory)],
        { encoding: "utf8" },
      ),
    ),
  ).toEqual(expected);
}, 15000);

it.each(["completed", "unknown", "unobserved"] as const)(
  "preserves the original completed DB prefix after v2 %s execution", outcome => {
    append(outcome);
    const proof = store.inspectCompletedProviderHistory({
      runId: oldId, budgetRevision: originalHistory.checkpoint.budgetRevision,
    })!;
    expect({ ...proof, current: originalHistory.current, currentBudget: originalHistory.currentBudget }).toEqual(originalHistory);
    expect(proof.current.digest).not.toBe(originalHistory.current.digest);
    expect(proof.currentBudget.capUnits).toBe(originalHistory.currentBudget.capUnits);
  }, 20000);
