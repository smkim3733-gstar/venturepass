import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as planner from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderGenerationMockTransport } from "./studio-plan-quality-provider-dispatch-store";
import type { ProviderObservationPrepared } from "./studio-provider-observation";

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
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
let identity: planner.ProviderGenerationDispatchIdentity;
const send = vi.fn<(request: ProviderObservationPrepared) => Promise<void>>(async () => undefined);
const transport = (): ProviderGenerationMockTransport => ({ provenance: "synthetic-test", send });
beforeEach(() => {
  forbidden.mockClear();
  send.mockReset();
  send.mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-dispatch-store-"));
  directory = join(root, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  identity = generationDispatchStoreFixture(store);
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 15000);
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-dispatch-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const execute = () => store.providerSimulateGenerationDispatch(identity, transport());
const snapshot = () => inspectQualityDatabase(db);
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
function reOpen() {
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
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
it("commits all four rows before one immutable exact mock request, preserving holds and other records", async () => {
  const before = snapshot(),
    budget = store.providerBudgetGet("production"),
    artifact = store.providerArtifact(identity.runId);
  send.mockImplementation(async (value) => {
    // Separate connection observes COMMITTED r3, not the first writer's uncommitted rows.
    expect(snapshot().actualEvents).toBe(3);
    expect(Object.isFrozen(value.body.input)).toBe(true);
    expect(value.rawBody).toBe(artifact.body.toString("utf8"));
    expect(JSON.stringify(value.body)).toBe(value.rawBody);
  });
  const result = await execute();
  expect(result).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    delivery: "mock-send-returned",
    responsePersisted: false,
    automaticRetryAllowed: false,
    record: { ...identity, state: "committed", dispatchAllowed: false, budgetWriteAllowed: false },
  });
  expect(send).toHaveBeenCalledTimes(1);
  const after = snapshot();
  expect(after).toEqual({
    ...before,
    digest: after.digest,
    actualEvents: before.actualEvents + 2,
    actualRequests: before.actualRequests + 2,
  });
  expect(after.digest).not.toBe(before.digest);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGet(identity.runId)).toMatchObject({
    state: "dispatching",
    revision: 3,
    dispatchIntentCount: 1,
    responseCount: 0,
    unobservedDispatchCount: 1,
    actualAiCalls: null,
  });
  expect(store.providerGenerationDispatchLookup(identity)).toEqual(result.record);
});
it("replays historical identity after expiry/configuration failure and reopening without sending again", async () => {
  const first = await execute();
  reOpen();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw new Error("No current config");
  });
  expect(store.providerGenerationDispatchLookup(identity)).toEqual(first.record);
  expect(await execute()).toMatchObject({
    record: first.record,
    newlyCommitted: false,
    replayed: true,
    delivery: "already-recorded",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("cannot create a second owner while the first mock response is pending", async () => {
  let finish!: () => void;
  send.mockImplementation(
    () =>
      new Promise<void>((yes) => {
        finish = yes;
      }),
  );
  const first = execute();
  expect(send).toHaveBeenCalledTimes(1);
  // The send promise is pending, but the final synchronous guard transaction is already closed.
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
  expect(await execute()).toMatchObject({ delivery: "already-recorded" });
  finish();
  await first;
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["DELETE", "WAL"])(
  "holds the writer slot through initiation in %s mode, then releases it before awaiting",
  async (mode) => {
    db.exec(`PRAGMA journal_mode=${mode}; PRAGMA busy_timeout=1`);
    let blocked = false;
    send.mockImplementation(async () => {
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
      } catch {
        blocked = true;
      }
    });
    expect(await execute()).toMatchObject({ delivery: "mock-send-returned" });
    expect(blocked).toBe(true);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  },
);
it.each(["reject", "throw"])(
  "retains committed unknown dispatch when mock send %s fails; retries never send",
  async (kind) => {
    send.mockImplementation(() => {
      if (kind === "throw") throw new Error("synthetic synchronous failure");
      return Promise.reject(new Error("synthetic lost response"));
    });
    const before = store.providerBudgetGet("production");
    expect(await execute()).toMatchObject({
      delivery: "send-result-unobserved",
      newlyCommitted: true,
    });
    reOpen();
    expect(await execute()).toMatchObject({ delivery: "already-recorded" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet("production")).toEqual(before);
  },
);
it.each([1, 2, 3, 4])(
  "rolls back all rows after INSERT %i failure and permits one later clean attempt",
  async (point) => {
    const before = snapshot(),
      prepare = DatabaseSync.prototype.prepare;
    let inserts = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const stmt = prepare.call(this, sql);
      if (/^INSERT INTO quality_actual_(events|requests)\(/.test(sql)) {
        const run = stmt.run.bind(stmt);
        vi.spyOn(stmt, "run").mockImplementation((...args) => {
          const result = run(...args);
          if (++inserts === point) throw new Error("synthetic insert interruption");
          return result;
        });
      }
      return stmt;
    });
    await expect(execute()).rejects.toThrow();
    spy.mockRestore();
    expect(snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
    expect(store.providerGenerationDispatchLookup(identity).state).toBe("not-observed");
    expect(await execute()).toMatchObject({ delivery: "mock-send-returned", newlyCommitted: true });
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it.each(["before", "after"])(
  "never sends if the write COMMIT throws %s it commits",
  async (phase) => {
    const hook = atCommit(
      1,
      () => {
        throw new Error("uncertain commit");
      },
      phase === "before",
    );
    await expect(execute()).rejects.toThrow();
    hook.mockRestore();
    expect(send).not.toHaveBeenCalled();
    reOpen();
    expect(store.providerGet(identity.runId).revision).toBe(phase === "before" ? 1 : 3);
    const result = await execute();
    expect(result.delivery).toBe(phase === "before" ? "mock-send-returned" : "already-recorded");
    expect(send).toHaveBeenCalledTimes(phase === "before" ? 1 : 0);
  },
);
it.each(["before", "after"])(
  "holds unknown state if final read COMMIT fails %s after initiation",
  async (phase) => {
    const hook = atCommit(
      2,
      () => {
        throw new Error("read completion uncertain");
      },
      phase === "before",
    );
    expect(await execute()).toMatchObject({ delivery: "send-result-unobserved" });
    hook.mockRestore();
    expect(await execute()).toMatchObject({ delivery: "already-recorded" });
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it.each(["expires", "configuration"])(
  "does not send when %s changes immediately after the known write commit",
  async (kind) => {
    const get = configuration.getProviderConfigurationProposal;
    if (kind === "configuration")
      vi.spyOn(configuration, "getProviderConfigurationProposal")
        .mockImplementationOnce(get)
        .mockReturnValue(null);
    else atCommit(1, () => vi.setSystemTime("2035-01-01T00:00:00.000Z"));
    expect(await execute()).toMatchObject({ delivery: "not-sent", newlyCommitted: true });
    expect(send).not.toHaveBeenCalled();
    expect(await execute()).toMatchObject({ delivery: "already-recorded" });
    expect(store.providerGet(identity.runId).revision).toBe(3);
  },
);
it("default store cannot run a mock transport or weaken native production writes", async () => {
  store.close();
  store = new PlanQualityStore(directory);
  const before = snapshot();
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_SIMULATION_DISABLED",
  });
  expect(snapshot()).toEqual(before);
  expect(send).not.toHaveBeenCalled();
});
it("does not send when the deadline passes during final evidence reconstruction", async () => {
  const get = configuration.getProviderConfigurationProposal;
  let calls = 0;
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    if (++calls === 2) vi.setSystemTime("2035-01-01T00:00:00.000Z");
    return get();
  });
  expect(await execute()).toMatchObject({ delivery: "not-sent" });
  expect(send).not.toHaveBeenCalled();
  expect(await execute()).toMatchObject({ delivery: "already-recorded" });
});
it("keeps existing native production write gates closed even on the mock-enabled store", async () => {
  await execute();
  expect(() =>
    store.providerRecordFinish(identity.runId, {
      clientRequestId: randomUUID(),
      expectedRevision: 3,
      payload: {
        kind: "execution-stopped",
        outcome: "result-unobserved",
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
      },
    }),
  ).toThrow(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
  expect(store.providerGet(identity.runId).revision).toBe(3);
});
it("rechecks policy replacement after the known commit before starting any mock send", async () => {
  const hook = atCommit(1, () => adoptReservationTestPolicy(store, 0));
  expect(await execute()).toMatchObject({ delivery: "not-sent" });
  hook.mockRestore();
  expect(send).not.toHaveBeenCalled();
  expect(await execute()).toMatchObject({ delivery: "already-recorded" });
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("blocks lookup and new work after missing %s", async (table) => {
  const name = `${table}_no_delete`,
    sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  db.exec(`DELETE FROM ${table}`);
  db.exec(sql);
  await expect(execute()).rejects.toThrow();
  expect(() => store.providerGenerationDispatchLookup(identity)).toThrow();
  expect(send).not.toHaveBeenCalled();
});
it.each(["model", "baseURL", "dispatchAllowed"])(
  "rejects transport override field %s before storing anything",
  async (key) => {
    const before = snapshot();
    await expect(
      store.providerSimulateGenerationDispatch(identity, { ...transport(), [key]: "bad" }),
    ).rejects.toMatchObject({ code: "QUALITY_PROVIDER_DISPATCH_SIMULATION_DISABLED" });
    expect(snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  },
);
it.each([
  "runId",
  "runDigest",
  "approvalBindingDigest",
  "preparedRequestId",
  "dispatchRequestId",
] as const)("rejects historical identity conflict in %s", async (key) => {
  await execute();
  identity[key] = key.endsWith("Id") ? randomUUID() : "a".repeat(64);
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_NONCE_CONFLICT",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("cannot replace a committed generation with new nonces", async () => {
  await execute();
  identity.preparedRequestId = randomUUID();
  identity.dispatchRequestId = randomUUID();
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_FIRST_GENERATION_REQUIRED",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("rejects a superseded candidate policy before creating any dispatch rows", async () => {
  adoptReservationTestPolicy(store, 0);
  const before = snapshot();
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_POLICY_OR_BUDGET_BLOCKED",
  });
  expect(snapshot()).toEqual(before);
  expect(send).not.toHaveBeenCalled();
});
it("counts parent raw bytes outside ALL native/v8/v9 records and keeps total reserved exposure", async () => {
  const original = planner.prepareProviderGenerationDispatch;
  const spy = vi.spyOn(planner, "prepareProviderGenerationDispatch").mockImplementation((input) => {
    expect(input.additionalUsedBytes).toBeGreaterThan(0);
    return original(input);
  });
  const before = usage();
  await execute();
  const after = usage();
  expect(spy).toHaveBeenCalledOnce();
  expect(after.usedBytes).toBeGreaterThan(before.usedBytes);
  expect(after.usedBytes + after.reservedBytes).toBe(before.usedBytes + before.reservedBytes);
});
it("restored backup preserves history without a new sending owner", async () => {
  const first = await execute();
  const backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  await restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  expect(await execute()).toMatchObject({ record: first.record, delivery: "already-recorded" });
  expect(send).toHaveBeenCalledTimes(1);
}, 150000);
