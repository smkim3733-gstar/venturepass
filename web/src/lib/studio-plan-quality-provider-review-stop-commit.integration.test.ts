import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { reviewStopStoreFixture } from "./studio-plan-quality-provider-review-stop-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderReviewStopIdentity } from "./studio-plan-quality-provider-review-stop";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import * as planner from "./studio-plan-quality-provider-review-stop";
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
let root: string,
  directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  identity: ProviderReviewStopIdentity,
  capture: Awaited<ReturnType<typeof reviewStopStoreFixture>>["capture"];
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-review-stop-commit-"));
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
  const f = await reviewStopStoreFixture(store);
  identity = f.identity;
  capture = f.capture;
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-review-stop-commit-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const id = () => identity.dispatch.generation.dispatch.runId;
const record = () => store.providerRecordReviewStop(identity);
const lookup = () => store.providerReviewStopLookup(identity);
const inspect = () => inspectQualityDatabase(db);
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
function reopen() {
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
}
function observe(kind: "valid" | "unknown" | "bound" | "invalid" = "invalid") {
  if (kind === "unknown") delete capture.response.usage;
  if (kind === "bound")
    capture.response.usage = {
      input_tokens: 20,
      output_tokens: 600000,
      total_tokens: 600020,
      input_tokens_details: { cached_tokens: 5 },
    };
  if (kind === "invalid") capture.response.output = [];
  const response = store.providerRecordReviewResponse(capture).record;
  identity.observation = {
    kind: "response",
    responseRequestId: capture.responseRequestId,
    responseEventDigest: response.responseEventDigest,
  };
  return {
    dispatch: identity.dispatch,
    responseRequestId: capture.responseRequestId,
    responseEventDigest: response.responseEventDigest,
    validationRequestId: randomUUID(),
  };
}
it.each(["unobserved", "unknown", "bound", "invalid"] as const)(
  "commits exactly two stop rows for %s without changing costs or evidence",
  (kind) => {
    if (kind !== "unobserved") observe(kind);
    const before = inspect(),
      bytes = usage(),
      budget = store.providerBudgetGet("production"),
      generation = store.providerArtifact(id(), "generation-validated"),
      planned = store.providerPrepareReviewStop(identity);
    if (planned.status !== "prepared") throw Error(planned.reason);
    expect(lookup()).toEqual({ state: "not-observed" });
    const saved = record(),
      after = inspect();
    expect(saved).toMatchObject({
      newlyCommitted: true,
      replayed: false,
      record: {
        ...identity,
        state: "committed",
        revision: kind === "unobserved" ? 8 : 9,
        inputDigest: planned.plan.rows.receipt.inputDigest,
        stopEventDigest: planned.plan.rows.event.eventDigest,
        budgetRevision: planned.plan.basis.budgetHead.revision,
        budgetHeadDigest: planned.plan.basis.budgetHead.headDigest,
        generationHeldUnitsAtStop: "0",
        reviewHeldUnitsAtStop: planned.plan.budget.reviewHeldUnits,
        recognizedUnitsAtStop: planned.plan.budget.recognizedUnits,
        stopPersisted: true,
        finalResultPersisted: false,
        dispatchAllowed: false,
        budgetWriteAllowed: false,
        automaticRetryAllowed: false,
      },
    });
    expect(after).toEqual({
      ...before,
      digest: after.digest,
      actualEvents: before.actualEvents + 1,
      actualRequests: before.actualRequests + 1,
    });
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerArtifact(id(), "generation-validated")).toEqual(generation);
    expect(store.providerGet(id())).toMatchObject({
      state: saved.record.outcome,
      terminal: true,
      canResume: false,
      dispatchIntentCount: 2,
      responseCount: kind === "unobserved" ? 1 : 2,
    });
    expect(Object.isFrozen(saved.record.dispatch.generation.dispatch)).toBe(true);
    expect(record()).toEqual({ record: saved.record, newlyCommitted: false, replayed: true });
    expect(lookup()).toEqual(saved.record);
    expect(inspect()).toEqual(after);
    const next = usage();
    expect(next.usedBytes).toBeGreaterThan(bytes.usedBytes);
    expect(next.reservedBytes).toBeLessThan(bytes.reservedBytes);
    expect(next.usedBytes + next.reservedBytes).toBe(planned.plan.capacity.totalExposureBytes);
  },
  10000,
);
it("recovers historical classification after restart, expiry, policy and current code changes", () => {
  observe();
  const first = record(),
    policy = policyAdoptionFixture(store);
  store.providerPolicyAdopt(policy.command, policy.review);
  const before = inspect(),
    budget = store.providerBudgetGet("production");
  reopen();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spies = [
    vi.spyOn(configuration, "getProviderConfigurationProposal"),
    vi.spyOn(engine, "getPlanExecutionContract"),
    vi.spyOn(engine, "validateObservedPlanReview"),
    vi.spyOn(engine, "finalizeObservedPlanReview"),
    vi.spyOn(planner, "prepareProviderReviewStop"),
  ];
  for (const spy of spies)
    spy.mockImplementation(() => {
      throw Error("No current classifier in recovery");
    });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("allows first offline stop after expiry and policy replacement", () => {
  observe();
  const policy = policyAdoptionFixture(store);
  store.providerPolicyAdopt(policy.command, policy.review);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const hook = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(forbidden);
  expect(record().newlyCommitted).toBe(true);
  expect(hook).not.toHaveBeenCalled();
});
it.each(["known", "unknown", "excess"])(
  "restores original stop costs after late %s capture",
  (kind) => {
    const first = record().record,
      budgetBefore = store.providerBudgetGet("production");
    if (kind === "unknown") delete capture.response.usage;
    if (kind === "excess")
      capture.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    const response = store.providerRecordReviewResponse(capture).record,
      budgetAfter = store.providerBudgetGet("production"),
      before = inspect();
    reopen();
    expect(lookup()).toEqual(first);
    expect(record().record).toEqual(first);
    expect(inspect()).toEqual(before);
    expect(store.providerGet(id())).toMatchObject({
      revision: 9,
      terminal: true,
      state: "result-unobserved",
      responseCount: 2,
    });
    expect(store.providerReviewResponseLookup(capture)).toEqual(response);
    if (kind === "unknown") expect(budgetAfter).toEqual(budgetBefore);
    else expect(budgetAfter).not.toEqual(budgetBefore);
    expect(BigInt(first.reviewHeldUnitsAtStop)).toBeGreaterThan(BigInt(0));
    expect(store.providerBudgetGet("production")).toEqual(budgetAfter);
  },
);
it("copies and freezes nested identity before BEGIN IMMEDIATE", () => {
  const original = structuredClone(identity),
    exec = DatabaseSync.prototype.exec;
  let changed = false;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!changed && sql === "BEGIN IMMEDIATE") {
      changed = true;
      identity.stopRequestId = randomUUID();
      identity.dispatch.generation.dispatch.runDigest = "0".repeat(64);
    }
    return exec.call(this, sql);
  });
  const saved = record();
  hook.mockRestore();
  expect(changed).toBe(true);
  expect(saved.record).toMatchObject(original);
  expect(store.providerReviewStopLookup(original)).toEqual(saved.record);
  expect(lookup).toThrow();
});
it.each(["DELETE", "WAL"])("holds writer ownership through classification in %s mode", (mode) => {
  observe();
  db.exec(`PRAGMA journal_mode=${mode}`);
  const prepare = planner.prepareProviderReviewStop;
  const hook = vi.spyOn(planner, "prepareProviderReviewStop").mockImplementation((input) => {
    expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    return prepare(input);
  });
  expect(record().newlyCommitted).toBe(true);
  expect(hook).toHaveBeenCalledOnce();
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
});
it("rejects all fourteen changed historical identity fields", () => {
  observe();
  record();
  const before = inspect();
  for (const path of [
    "stopRequestId",
    "observation.responseRequestId",
    "observation.responseEventDigest",
    "dispatch.preparedRequestId",
    "dispatch.dispatchRequestId",
    "dispatch.validationEventDigest",
    "dispatch.generation.responseRequestId",
    "dispatch.generation.responseEventDigest",
    "dispatch.generation.validationRequestId",
    "dispatch.generation.dispatch.runId",
    "dispatch.generation.dispatch.runDigest",
    "dispatch.generation.dispatch.approvalBindingDigest",
    "dispatch.generation.dispatch.preparedRequestId",
    "dispatch.generation.dispatch.dispatchRequestId",
  ]) {
    const changed = structuredClone(identity),
      parts = path.split(".");
    let value = changed as unknown as Record<string, unknown>;
    for (const key of parts.slice(0, -1)) value = value[key] as Record<string, unknown>;
    const key = parts.at(-1)!;
    value[key] = key.endsWith("Digest") ? "0".repeat(64) : randomUUID();
    expect(() => store.providerRecordReviewStop(changed), path).toThrow();
    expect(() => store.providerReviewStopLookup(changed), path).toThrow();
  }
  expect(() =>
    store.providerReviewStopLookup({
      ...identity,
      observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
    }),
  ).toThrow();
  expect(inspect()).toEqual(before);
}, 20000);
it("refuses occupied native, policy and registration nonces", () => {
  const before = inspect();
  for (const nonce of [
    identity.dispatch.dispatchRequestId,
    db.prepare("SELECT nonce FROM quality_provider_policies LIMIT 1").get()!.nonce,
    db.prepare("SELECT nonce FROM quality_candidate_requests LIMIT 1").get()!.nonce,
  ]) {
    const changed = { ...identity, stopRequestId: nonce };
    expect(() => store.providerRecordReviewStop(changed)).toThrow();
    expect(() => store.providerReviewStopLookup(changed)).toThrow();
  }
  expect(inspect()).toEqual(before);
});
it("does not convert stale unobserved intent, valid review or validated/completed review into failure", () => {
  const stale = structuredClone(identity),
    validation = observe("valid"),
    before = inspect();
  expect(() => store.providerRecordReviewStop(stale)).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_OBSERVATION_CHANGED" }),
  );
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_REVIEW_VALID" }),
  );
  expect(inspect()).toEqual(before);
  const reviewed = store.providerRecordReviewValidation(validation).record;
  expect(record).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_REVIEW_PREFIX_CHANGED",
    }),
  );
  store.providerRecordFinalization({
    validation,
    validationEventDigest: reviewed.validationEventDigest,
    finalizationRequestId: randomUUID(),
  });
  const completed = inspect();
  expect(record).toThrow();
  expect(lookup).toThrow();
  expect(inspect()).toEqual(completed);
  expect(store.providerGet(id()).state).toBe("completed");
}, 10000);
it.each(["contract", "validator", "finalizer"])(
  "preserves rows and holds on %s failure",
  (kind) => {
    observe("valid");
    const before = inspect(),
      budget = store.providerBudgetGet("production");
    if (kind === "contract")
      vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
        ...engine.getPlanExecutionContract(),
        contractDigest: "0".repeat(64),
      });
    if (kind === "validator")
      vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(() => {
        throw Error("Internal validator");
      });
    if (kind === "finalizer")
      vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
        throw Error("Internal finalizer");
      });
    expect(record).toThrow(
      expect.objectContaining({
        code:
          "QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_" +
          {
            contract: "VALIDATION_CONTRACT_CHANGED",
            validator: "VALIDATION_UNAVAILABLE",
            finalizer: "FINALIZATION_UNAVAILABLE",
          }[kind],
      }),
    );
    expect(lookup()).toEqual({ state: "not-observed" });
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
);
it("rejects supplied outcome, body, plan and authority before SQL", () => {
  const hook = vi.spyOn(DatabaseSync.prototype, "exec");
  for (const field of [
    "outcome",
    "failureCode",
    "releasedUnits",
    "plan",
    "body",
    "configuration",
    "dispatchAllowed",
  ])
    expect(() => store.providerRecordReviewStop({ ...identity, [field]: {} })).toThrow();
  expect(() =>
    store.providerRecordReviewStop({ ...identity, observation: { kind: "unobserved" } }),
  ).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
it.each([1, 2])("rolls back stop INSERT %s and permits a clean retry", (point) => {
  const before = inspect(),
    budget = store.providerBudgetGet("production"),
    prepare = DatabaseSync.prototype.prepare;
  let count = 0;
  const hook = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (/^INSERT INTO quality_actual_(events|requests)\(/.test(sql)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => {
        const result = run(...args);
        if (++count === point) throw Error("Synthetic INSERT failure");
        return result;
      });
    }
    return statement;
  });
  expect(record).toThrow(/Synthetic INSERT failure/);
  hook.mockRestore();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(lookup()).toEqual({ state: "not-observed" });
  expect(record().newlyCommitted).toBe(true);
});
it.each(["before", "after"])("recovers correctly when COMMIT throws %s persistence", (point) => {
  const budget = store.providerBudgetGet("production"),
    exec = DatabaseSync.prototype.exec;
  let first = true;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const target = sql === "COMMIT" && first;
    if (target) first = false;
    if (target && point === "before") throw Error("Synthetic before commit");
    const result = exec.call(this, sql);
    if (target && point === "after") throw Error("Synthetic uncertain commit");
    return result;
  });
  expect(record).toThrow();
  hook.mockRestore();
  reopen();
  expect(store.providerGet(id()).revision).toBe(point === "after" ? 8 : 7);
  expect(lookup().state).toBe(point === "after" ? "committed" : "not-observed");
  expect(record().replayed).toBe(point === "after");
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
  "quality_actual_artifacts",
])("refuses corrupt %s during recovery", (table) => {
  record();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  expect(record).toThrow();
  expect(lookup).toThrow();
});
it("keeps default-store writes closed and historical reads available", () => {
  const first = record();
  store.close();
  store = new PlanQualityStore(directory);
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_RECORDING_DISABLED" }),
  );
  expect(lookup()).toEqual(first.record);
  expect(inspect()).toEqual(before);
});
it("restores original stop and late cost evidence from backup", async () => {
  const first = record();
  store.providerRecordReviewResponse(capture);
  const budget = store.providerBudgetGet("production"),
    response = store.providerArtifact(id(), "review-response"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  const hook = vi.spyOn(planner, "prepareProviderReviewStop").mockImplementation(() => {
    throw Error("No reclassification");
  });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id(), "review-response")).toEqual(response);
  expect(hook).not.toHaveBeenCalled();
}, 150000);
