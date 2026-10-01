/** Isolated mock callbacks and SQLite writes; never an operational provider invocation. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External IO forbidden");
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
import {
  createProviderProductionRuntime,
  revokeProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderObservationPrepared } from "./studio-provider-observation";
import {
  backupQualityData,
  restoreQualityData,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";

const v2 = "plan-observation-v2",
  sentinel = "synthetic customer sentinel";
let seedRoot: string, seedBytes: Buffer, oldId: string, oldExport: string;
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
let identity: ProviderGenerationDispatchIdentity,
  seededIdentity: ProviderGenerationDispatchIdentity;
let selectedConfiguration: NonNullable<ReturnType<typeof readFixedProviderConfiguration>>;
const databasePath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
const send = vi.fn<(request: ProviderObservationPrepared) => Promise<void>>(async () => undefined);
function cleanup(path: string) {
  const rel = relative(resolve(tmpdir()), resolve(path));
  if (!rel.startsWith("venture-version-dispatch-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
}
function open(
  version: "plan-observation-v1" | typeof v2 | null = v2,
  sdk = false,
  synthetic = true,
) {
  return new PlanQualityStore(directory, {
    ...(synthetic ? { providerEnvironment: "synthetic-test" as const } : {}),
    ...(version
      ? { providerPolicySelection: { version, configuration: selectedConfiguration } }
      : {}),
    ...(sdk
      ? { providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: forbidden } }
      : {}),
  });
}
const execute = (s = store) =>
  s.providerSimulateGenerationDispatch(identity, { provenance: "synthetic-test", send });
const snapshot = () => store.providerArchiveGet(identity.runId);
function reopen(
  version: "plan-observation-v1" | typeof v2 | null = v2,
  sdk = false,
  synthetic = true,
) {
  store.close();
  store = open(version, sdk, synthetic);
}
function failInsert(point: number, response = false) {
  const prepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  return vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const stmt = prepare.call(this, sql);
    if (
      (response
        ? /^INSERT INTO quality_actual_(artifacts|budget_events|events|requests)\(/
        : /^INSERT INTO quality_actual_(events|requests)\(/
      ).test(sql)
    ) {
      const run = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation((...args) => {
        const value = run(...args);
        if (++inserts === point) throw Error("synthetic insert interruption");
        return value;
      });
    }
    return stmt;
  });
}
function atCommit(number: number, callback: () => void, before = false) {
  const exec = DatabaseSync.prototype.exec;
  let commits = 0;
  return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const target = sql === "COMMIT" && ++commits === number;
    if (target && before) callback();
    const result = exec.call(this, sql);
    if (target && !before) callback();
    return result;
  });
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-dispatch-seed-"));
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
    vi.setSystemTime("2026-09-27T03:33:00.000Z");
    const a = transmissionStoreFixture(seeded, reserved.record),
      approved = seeded.providerApproveTransmission(a.command, a.review).record;
    seededIdentity = {
      runId: approved.runId,
      runDigest: approved.runDigest,
      approvalBindingDigest: approved.recordDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    };
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
  send.mockReset();
  send.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-version-dispatch-test-"));
  directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  writeFileSync(databasePath(directory), seedBytes);
  identity = structuredClone(seededIdentity);
  selectedConfiguration = readFixedProviderConfiguration()!;
  store = open();
  db = new DatabaseSync(databasePath(directory));
  db.function("quality_storage_contract", () => "quality-v9");
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  store?.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (root) cleanup(root);
});
it("commits exact v2 request before one immutable callback and preserves a response in the same cumulative budget", async () => {
  const beforeBudget = store.providerBudgetGet("production"),
    approved = store.providerDownload(identity.runId, 1).body;
  const prepared = snapshot().run.preparation;
  send.mockImplementation(async (request) => {
    expect(inspectQualityDatabase(db).actualEvents).toBeGreaterThan(3);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM quality_actual_events WHERE run_id=?")
        .get(identity.runId)!.n,
    ).toBe(3);
    expect(request.rawBody).toBe(JSON.stringify(prepared.generation.body));
    expect(Object.isFrozen(request.body)).toBe(true);
  });
  expect(await execute()).toMatchObject({
    delivery: "mock-send-returned",
    newlyCommitted: true,
    automaticRetryAllowed: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(beforeBudget);
  const captured = generationResponseFixture(identity),
    saved = store.providerRecordGenerationResponse(captured);
  expect(saved).toMatchObject({
    newlyCommitted: true,
    record: { revision: 4, responsePersisted: true, dispatchAllowed: false },
  });
  expect(snapshot()).toMatchObject({
    archiveFormatVersion: 5,
    revision: 4,
    dispatchAllowed: false,
  });
  expect(store.providerGenerationResponseLookup(captured)).toEqual(saved.record);
  expect(BigInt(store.providerBudgetGet("production").recognizedUnits)).toBeGreaterThan(
    BigInt(beforeBudget.recognizedUnits),
  );
  expect(store.providerBudgetGet("production").capUnits).toBe(beforeBudget.capUnits);
  expect(store.providerDownload(identity.runId, 1).body).toBe(approved);
  expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
  expect(() => store.providerGet(identity.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([null, "plan-observation-v1"] as const)(
  "rejects a new v2 dispatch with server selection %s before writes",
  async (version) => {
    reopen(version);
    const before = inspectQualityDatabase(db);
    await expect(execute()).rejects.toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  },
);
it("copies fixed server configuration and does not consult ambient configuration for a selected dispatch", async () => {
  Object.assign(selectedConfiguration, { invalidMutation: true });
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("ambient configuration forbidden");
  });
  expect(await execute()).toMatchObject({ delivery: "mock-send-returned" });
});
it.each([1, 2, 3, 4])("rolls back dispatch insert %i with no callback", async (point) => {
  const before = inspectQualityDatabase(db),
    hook = failInsert(point);
  await expect(execute()).rejects.toThrow("synthetic insert interruption");
  hook.mockRestore();
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(send).not.toHaveBeenCalled();
  expect(store.providerGenerationDispatchLookup(identity)).toEqual({ state: "not-observed" });
  expect(await execute()).toMatchObject({ newlyCommitted: true });
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["before", "after"])(
  "recovers uncertain dispatch COMMIT %s without resending committed requests",
  async (phase) => {
    const hook = atCommit(
      1,
      () => {
        throw Error("uncertain commit");
      },
      phase === "before",
    );
    await expect(execute()).rejects.toThrow(
      phase === "before" ? "uncertain commit" : "cannot rollback - no transaction is active",
    );
    hook.mockRestore();
    expect(send).not.toHaveBeenCalled();
    reopen();
    expect(snapshot().revision).toBe(phase === "before" ? 1 : 3);
    expect((await execute()).delivery).toBe(
      phase === "before" ? "mock-send-returned" : "already-recorded",
    );
    expect(send).toHaveBeenCalledTimes(phase === "before" ? 1 : 0);
  },
);
it("checks expiry again after commit and recovers the original nonce before current selection or clock", async () => {
  const hook = atCommit(1, () => vi.setSystemTime("2035-01-01T00:00:00.000Z"));
  expect(await execute()).toMatchObject({ delivery: "not-sent", newlyCommitted: true });
  hook.mockRestore();
  reopen(null);
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("no current evidence");
  });
  expect(await execute()).toMatchObject({ delivery: "already-recorded", replayed: true });
  expect(send).not.toHaveBeenCalled();
  await expect(
    store.providerSimulateGenerationDispatch(
      { ...identity, dispatchRequestId: randomUUID() },
      { provenance: "synthetic-test", send },
    ),
  ).rejects.toThrow(expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_NONCE_CONFLICT" }));
});
it.each(["DELETE", "WAL"])(
  "retains a single owner across two connections in %s and releases the lock before waiting",
  async (journal) => {
    db.exec("PRAGMA journal_mode=" + journal + "; PRAGMA busy_timeout=0");
    const other = open();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    send.mockImplementation(() => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      return completion;
    });
    const first = execute();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      expect(await execute(other)).toMatchObject({ delivery: "already-recorded", replayed: true });
      release();
      expect(await first).toMatchObject({ delivery: "mock-send-returned" });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
      other.close();
    }
  },
);
it("does not retry an unobserved mock delivery", async () => {
  send.mockRejectedValue(Error("connection lost"));
  expect(await execute()).toMatchObject({ delivery: "send-result-unobserved" });
  expect(await execute()).toMatchObject({ delivery: "already-recorded" });
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([1, 2, 3, 4])(
  "rolls back response insert %i then preserves the same capture without another send",
  async (point) => {
    await execute();
    const capture = generationResponseFixture(identity),
      before = inspectQualityDatabase(db),
      budget = store.providerBudgetGet("production");
    const hook = failInsert(point, true);
    expect(() => store.providerRecordGenerationResponse(capture)).toThrow(
      "synthetic insert interruption",
    );
    hook.mockRestore();
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGenerationResponseLookup(capture)).toEqual({ state: "not-observed" });
    expect(store.providerRecordGenerationResponse(capture)).toMatchObject({ newlyCommitted: true });
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it.each(["before", "after"])(
  "recovers captured response COMMIT %s with one usage recognition",
  async (phase) => {
    await execute();
    const capture = generationResponseFixture(identity);
    const hook = atCommit(
      1,
      () => {
        throw Error("response commit unknown");
      },
      phase === "before",
    );
    expect(() => store.providerRecordGenerationResponse(capture)).toThrow();
    hook.mockRestore();
    reopen(null);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const result = store.providerRecordGenerationResponse(capture),
      budget = store.providerBudgetGet("production");
    expect(result.replayed).toBe(phase === "after");
    expect(store.providerRecordGenerationResponse(capture)).toMatchObject({
      replayed: true,
      record: result.record,
    });
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(send).toHaveBeenCalledTimes(1);
    const altered = structuredClone(capture);
    altered.response.id = "different-capture";
    expect(() => store.providerRecordGenerationResponse(altered)).toThrow(
      expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_RESPONSE_CONFLICT" }),
    );
  },
);
it("keeps the full unresolved hold when usage is absent", async () => {
  await execute();
  const budget = store.providerBudgetGet("production"),
    capture = generationResponseFixture(identity);
  delete capture.response.usage;
  expect(store.providerRecordGenerationResponse(capture).record.usageBudgetEventDigest).toBeNull();
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("blocks the v2 SDK path before commit and keeps non-synthetic response writes closed", async () => {
  reopen(v2, true);
  const before = inspectQualityDatabase(db);
  await expect(store.providerSimulateGenerationSdkDispatch(identity)).rejects.toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  await execute();
  const capture = generationResponseFixture(identity);
  reopen(v2, false, false);
  expect(() => store.providerRecordGenerationResponse(capture)).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_RESPONSE_RECORDING_DISABLED" }),
  );
});
it.each(["version", "tokenEvidence", "configuration"])(
  "rejects caller authority injection %s",
  async (key) => {
    const before = inspectQualityDatabase(db);
    await expect(
      store.providerSimulateGenerationDispatch(
        { ...identity, [key]: v2 },
        { provenance: "synthetic-test", send },
      ),
    ).rejects.toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  },
);
it("audits the whole database before historical nonce recovery", async () => {
  await execute();
  const capture = generationResponseFixture(identity);
  store.providerRecordGenerationResponse(capture);
  // Isolated corruption fixture only; restore trigger SQL before auditing.
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='quality_actual_requests'",
    )
    .all();
  for (const trigger of triggers) db.exec('DROP TRIGGER "' + trigger.name + '"');
  db.prepare("UPDATE quality_actual_requests SET body_hash=? WHERE nonce=?").run(
    "0".repeat(64),
    capture.responseRequestId,
  );
  for (const trigger of triggers) db.exec(String(trigger.sql));
  expect(() => store.providerGenerationDispatchLookup(identity)).toThrow(
    expect.objectContaining({ code: "QUALITY_ACTUAL_STORAGE_CORRUPT" }),
  );
  await expect(execute()).rejects.toThrow(
    expect.objectContaining({ code: "QUALITY_ACTUAL_STORAGE_CORRUPT" }),
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it("backs up and restores mixed v1 completion plus v2 writer-produced response and original recovery bytes", async () => {
  await execute();
  const capture = generationResponseFixture(identity),
    saved = store.providerRecordGenerationResponse(capture).record;
  const exported = store.providerDownload(identity.runId, 4).body,
    budget = store.providerBudgetGet("production");
  const backup = join(root, "backup"),
    target = join(root, "restored");
  mkdirSync(target);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, target);
  const restored = new PlanQualityStore(target, { providerEnvironment: "synthetic-test" });
  try {
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    expect(restored.providerDownload(identity.runId, 4).body).toBe(exported);
    expect(restored.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(restored.providerBudgetGet("production")).toEqual(budget);
    expect(restored.providerGenerationResponseLookup(capture)).toEqual(saved);
    expect(restored.providerRecordGenerationResponse(capture)).toMatchObject({
      replayed: true,
      record: saved,
    });
    expect(await execute(restored)).toMatchObject({ delivery: "already-recorded" });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    restored.close();
  }
}, 30000);

it("keeps the production factory contract and refuses v2 live execution", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-version-gate-only");
  vi.stubEnv("VENTURE_DATA_DIR", directory);
  const runtime = createProviderProductionRuntime();
  try {
    store.close();
    store = new PlanQualityStore(directory, {
      providerProductionRuntime: runtime,
    });
    const before = inspectQualityDatabase(db);
    await expect(store.providerRunApprovedProduction(identity)).rejects.toThrow(
      expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_PRODUCTION_APPROVAL_REQUIRED" }),
    );
    expect(inspectQualityDatabase(db)).toEqual(before);
  } finally {
    revokeProviderProductionRuntime(runtime);
    vi.unstubAllEnvs();
  }
});

it.each(["plan-observation-v1", "plan-observation-v2"] as const)(
  "refuses unsupported live server selection %s before database creation rather than silently using v1",
  (version) => {
    vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-version-selection-only");
    vi.stubEnv("VENTURE_DATA_DIR", directory);
    const runtime = createProviderProductionRuntime(),
      target = join(root, "never-created");
    const before = inspectQualityDatabase(db);
    try {
      expect(
        () =>
          new PlanQualityStore(target, {
            providerProductionRuntime: runtime,
            providerPolicySelection: { version, configuration: selectedConfiguration },
          }),
      ).toThrow("PROVIDER_PRODUCTION_VERSION_SELECTION_UNSUPPORTED");
      expect(existsSync(target)).toBe(false);
      expect(inspectQualityDatabase(db)).toEqual(before);
    } finally {
      revokeProviderProductionRuntime(runtime);
      vi.unstubAllEnvs();
    }
  },
);
