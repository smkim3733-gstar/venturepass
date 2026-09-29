import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  reviewDispatchStoreFixture,
  appendReviewUnobservedStop,
} from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import { providerDigest } from "../../scripts/local-data-quality-provider.mjs";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as planner from "./studio-plan-quality-provider-review-dispatch-plan";
import type { ProviderReviewMockTransport } from "./studio-plan-quality-provider-dispatch-store";
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
let identity: planner.ProviderReviewDispatchIdentity;
const send = vi.fn<(request: ProviderObservationPrepared) => Promise<void>>(async () => undefined);
const transport = (): ProviderReviewMockTransport => ({ provenance: "synthetic-test", send });
beforeEach(async () => {
  forbidden.mockClear();
  send.mockReset();
  send.mockResolvedValue(undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-review-dispatch-store-"));
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
  identity = await reviewDispatchStoreFixture(store);
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
  if (!rel.startsWith("venture-review-dispatch-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const execute = () => store.providerSimulateReviewDispatch(identity, transport());
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
it("commits all five rows before one immutable exact mock request, preserving holds and other records", async () => {
  const before = snapshot(),
    budget = store.providerBudgetGet("production"),
    planned = store.providerPrepareReviewDispatch(identity);
  if (planned.status !== "prepared") throw Error(planned.reason);
  const artifact = { body: Buffer.from(planned.plan.request.rawBody) };
  send.mockImplementation(async (value) => {
    // Separate connection observes COMMITTED r7, not the first writer's uncommitted rows.
    expect(snapshot().actualEvents).toBe(7);
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
    actualArtifacts: before.actualArtifacts + 1,
    actualEvents: before.actualEvents + 2,
    actualRequests: before.actualRequests + 2,
  });
  expect(after.digest).not.toBe(before.digest);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGet(identity.generation.dispatch.runId)).toMatchObject({
    state: "dispatching",
    revision: 7,
    dispatchIntentCount: 2,
    responseCount: 1,
    unobservedDispatchCount: 1,
    actualAiCalls: null,
  });
  expect(store.providerReviewDispatchLookup(identity)).toEqual(result.record);
  expect(result.record.preparedInputDigest).toBe(planned.plan.rows.receipts[0].inputDigest);
  expect(result.record.dispatchInputDigest).toBe(planned.plan.rows.receipts[1].inputDigest);
  expect(Object.isFrozen(result.record.generation.dispatch)).toBe(true);
  expect(Object.isFrozen(identity.generation.dispatch)).toBe(false);
});
it("replays historical identity after expiry/configuration failure and reopening without sending again", async () => {
  const first = await execute();
  reOpen();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw new Error("No current config");
  });
  const prepare = vi.spyOn(planner, "prepareProviderReviewDispatch").mockImplementation(() => {
    throw new Error("Historical replay must not replan");
  });
  expect(store.providerReviewDispatchLookup(identity)).toEqual(first.record);
  expect(await execute()).toMatchObject({
    record: first.record,
    newlyCommitted: false,
    replayed: true,
    delivery: "already-recorded",
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(prepare).not.toHaveBeenCalled();
});
it("preserves a terminal review between commit and send and never recovers new ownership", async () => {
  const budget = store.providerBudgetGet("production"),
    id = identity.generation.dispatch.runId;
  const hook = atCommit(1, () =>
    appendReviewUnobservedStop(db, store.providerGet(id) as ProviderExecutionSnapshot),
  );
  const first = await execute();
  hook.mockRestore();
  expect(first.delivery).toBe("not-sent");
  expect(send).not.toHaveBeenCalled();
  expect(store.providerGet(id)).toMatchObject({
    revision: 8,
    terminal: true,
    state: "result-unobserved",
  });
  expect(store.providerReviewDispatchLookup(identity)).toEqual(first.record);
  reOpen();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  expect(await execute()).toMatchObject({ record: first.record, delivery: "already-recorded" });
  expect(send).not.toHaveBeenCalled();
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it.each(["DELETE", "WAL"])(
  "holds the write slot while regenerating the review plan in %s mode",
  async (mode) => {
    db.exec(`PRAGMA journal_mode=${mode}; PRAGMA busy_timeout=1`);
    const original = planner.prepareProviderReviewDispatch;
    const hook = vi.spyOn(planner, "prepareProviderReviewDispatch").mockImplementation((input) => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      return original(input);
    });
    expect(await execute()).toMatchObject({ delivery: "mock-send-returned" });
    expect(hook).toHaveBeenCalledOnce();
  },
);
it.each(["preparedRequestId", "dispatchRequestId"] as const)(
  "rejects a global occupied %s without completing a partial request",
  async (key) => {
    const before = snapshot();
    const nonce = db.prepare("SELECT nonce FROM quality_candidate_requests LIMIT 1").get()!
      .nonce as string;
    identity[key] = nonce;
    await expect(execute()).rejects.toMatchObject({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_CONFLICT",
    });
    expect(() => store.providerReviewDispatchLookup(identity)).toThrow();
    expect(snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  },
);
it.each(["body", "model", "dispatchAllowed"])(
  "rejects caller supplied %s before any review write",
  async (field) => {
    const before = snapshot();
    await expect(
      store.providerSimulateReviewDispatch({ ...identity, [field]: "override" }, transport()),
    ).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  },
);
it("refuses native prepared-only history instead of assigning ownership to an incomplete past request", async () => {
  const result = store.providerPrepareReviewDispatch(identity);
  if (result.status !== "prepared") throw Error(result.reason);
  const { artifact, events, receipts } = result.plan.rows;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO quality_actual_artifacts(run_id,artifact_key,payload,sha256,size_bytes) VALUES(?,?,?,?,?)",
    ).run(
      artifact.runId,
      artifact.key,
      Buffer.from(artifact.body),
      artifact.sha256,
      artifact.sizeBytes,
    );
    db.prepare(
      "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
    ).run(artifact.runId, 6, JSON.stringify(events[0]), providerDigest(events[0]));
    db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
      receipts[0].clientRequestId,
      JSON.stringify(receipts[0]),
      providerDigest(receipts[0]),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const before = snapshot();
  expect(store.providerGet(artifact.runId).revision).toBe(6);
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_REVIEW_CONFLICT",
  });
  expect(() => store.providerReviewDispatchLookup(identity)).toThrow();
  expect(snapshot()).toEqual(before);
  expect(send).not.toHaveBeenCalled();
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
it.each([1, 2, 3, 4, 5])(
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
      if (/^INSERT INTO quality_actual_(artifacts|events|requests)\(/.test(sql)) {
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
    expect(store.providerReviewDispatchLookup(identity).state).toBe("not-observed");
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
    expect(store.providerGet(identity.generation.dispatch.runId).revision).toBe(
      phase === "before" ? 5 : 7,
    );
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
    expect(store.providerGet(identity.generation.dispatch.runId).revision).toBe(7);
  },
);
it("default store cannot run a mock transport or weaken native production writes", async () => {
  store.close();
  store = new PlanQualityStore(directory);
  const before = snapshot();
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_REVIEW_SIMULATION_DISABLED",
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
    store.providerRecordFinish(identity.generation.dispatch.runId, {
      clientRequestId: randomUUID(),
      expectedRevision: 7,
      payload: {
        kind: "execution-stopped",
        outcome: "result-unobserved",
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
      },
    }),
  ).toThrow(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
  expect(store.providerGet(identity.generation.dispatch.runId).revision).toBe(7);
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
  expect(() => store.providerReviewDispatchLookup(identity)).toThrow();
  expect(send).not.toHaveBeenCalled();
});
it.each(["model", "baseURL", "dispatchAllowed"])(
  "rejects transport override field %s before storing anything",
  async (key) => {
    const before = snapshot();
    await expect(
      store.providerSimulateReviewDispatch(identity, { ...transport(), [key]: "bad" }),
    ).rejects.toMatchObject({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_SIMULATION_DISABLED" });
    expect(snapshot()).toEqual(before);
    expect(send).not.toHaveBeenCalled();
  },
);
it.each([
  "generation.dispatch.runId",
  "generation.dispatch.runDigest",
  "generation.dispatch.approvalBindingDigest",
  "generation.dispatch.preparedRequestId",
  "generation.dispatch.dispatchRequestId",
  "generation.responseRequestId",
  "generation.responseEventDigest",
  "generation.validationRequestId",
  "validationEventDigest",
  "preparedRequestId",
  "dispatchRequestId",
])("rejects historical identity conflict in %s", async (key) => {
  await execute();
  const before = snapshot();
  const path = key.split(".");
  let target = identity as unknown as Record<string, unknown>;
  for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = path.at(-1)!;
  target[field] = field.endsWith("Digest") ? "a".repeat(64) : randomUUID();
  await expect(execute()).rejects.toThrow();
  expect(snapshot()).toEqual(before);
  expect(send).toHaveBeenCalledTimes(1);
});
it("cannot replace a committed review with new nonces", async () => {
  await execute();
  identity.preparedRequestId = randomUUID();
  identity.dispatchRequestId = randomUUID();
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_REVIEW_CONFLICT",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("rejects a superseded candidate policy before creating any dispatch rows", async () => {
  adoptReservationTestPolicy(store, 0);
  const before = snapshot();
  await expect(execute()).rejects.toMatchObject({
    code: "QUALITY_PROVIDER_DISPATCH_REVIEW_POLICY_OR_BUDGET_BLOCKED",
  });
  expect(snapshot()).toEqual(before);
  expect(send).not.toHaveBeenCalled();
});
it("counts parent raw bytes outside ALL native/v8/v9 records and keeps total reserved exposure", async () => {
  const original = planner.prepareProviderReviewDispatch;
  const spy = vi.spyOn(planner, "prepareProviderReviewDispatch").mockImplementation((input) => {
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
