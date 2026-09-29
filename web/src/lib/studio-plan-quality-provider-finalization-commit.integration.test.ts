import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  reviewValidationStoreFixture,
  appendReviewTerminalFixture,
} from "./studio-plan-quality-provider-review-validation-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderFinalizationIdentity } from "./studio-plan-quality-provider-finalization";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import * as planner from "./studio-plan-quality-provider-finalization";
import { reviewValidationFindings } from "./studio-plan-quality-provider-review-validation-test-helpers";

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
  identity: ProviderFinalizationIdentity;
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-finalization-commit-"));
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
  const fixture = await reviewValidationStoreFixture(store);
  identity = {
    validation: fixture.identity,
    validationEventDigest: "0".repeat(64),
    finalizationRequestId: randomUUID(),
  };
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 25000);
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-finalization-commit-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function saveValidation() {
  const saved = store.providerRecordReviewValidation(identity.validation).record;
  identity.validationEventDigest = saved.validationEventDigest;
  return saved;
}
const id = () => identity.validation.dispatch.generation.dispatch.runId;
const record = () => store.providerRecordFinalization(identity);
const lookup = () => store.providerFinalizationLookup(identity);
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
it("commits exactly three native rows, preserves raw evidence/costs, and releases only reserved storage", () => {
  const validation = saveValidation(),
    before = inspect(),
    capacity = usage(),
    budget = store.providerBudgetGet("production"),
    response = store.providerArtifact(id(), "review-response"),
    reviewed = store.providerArtifact(id(), "review-validated"),
    planned = store.providerPrepareFinalization(identity);
  if (planned.status !== "prepared") throw Error(planned.reason);
  expect(lookup()).toEqual({ state: "not-observed" });
  const saved = record();
  expect(saved).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      ...identity,
      state: "committed",
      revision: 10,
      completionPersisted: true,
      finalResultPersisted: true,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      inputDigest: planned.plan.rows.receipt.inputDigest,
      completionEventDigest: planned.plan.rows.event.eventDigest,
      finalArtifactSha256: planned.plan.rows.artifact.sha256,
      finalArtifactSizeBytes: planned.plan.rows.artifact.sizeBytes,
      generationArtifactSha256: planned.plan.basis.generationArtifactSha256,
      reviewArtifactSha256: reviewed.sha256,
    },
  });
  const after = inspect();
  expect(after).toEqual({
    ...before,
    digest: after.digest,
    actualArtifacts: before.actualArtifacts + 1,
    actualEvents: before.actualEvents + 1,
    actualRequests: before.actualRequests + 1,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id(), "review-response")).toEqual(response);
  expect(store.providerArtifact(id(), "review-validated")).toEqual(reviewed);
  expect(store.providerArtifact(id(), "final-result").body.toString("utf8")).toBe(
    planned.plan.rows.artifact.body,
  );
  expect(store.providerGet(id())).toMatchObject({
    revision: 10,
    state: "completed",
    terminal: true,
    unsettled: false,
    responseCount: 2,
    dispatchIntentCount: 2,
    canResume: false,
  });
  expect(store.providerReviewValidationLookup(identity.validation)).toEqual(validation);
  expect(Object.isFrozen(saved.record.validation.dispatch.generation.dispatch)).toBe(true);
  expect(saved.record).not.toHaveProperty("body");
  expect(lookup()).toEqual(saved.record);
  const next = usage();
  expect(next.usedBytes).toBeGreaterThan(capacity.usedBytes);
  expect(next.reservedBytes).toBeLessThan(capacity.reservedBytes);
  expect(next.usedBytes + next.reservedBytes).toBe(planned.plan.capacity.totalExposureBytes);
}, 10000);
it("recovers the exact original final body and receipt after reopening, policy replacement, expiry and changed current code", () => {
  saveValidation();
  const first = record(),
    final = store.providerArtifact(id(), "final-result"),
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
    vi.spyOn(planner, "prepareProviderFinalization"),
  ];
  for (const spy of spies)
    spy.mockImplementation(() => {
      throw Error("No current code in historical recovery");
    });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  expect(store.providerArtifact(id(), "final-result")).toEqual(final);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("allows first offline completion after expiry and policy replacement without fresh configuration", () => {
  saveValidation();
  const policy = policyAdoptionFixture(store);
  store.providerPolicyAdopt(policy.command, policy.review);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spy = vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw Error("No config");
  });
  expect(record()).toMatchObject({
    newlyCommitted: true,
    record: { completionPersisted: true, dispatchAllowed: false },
  });
  expect(spy).not.toHaveBeenCalled();
});
it("captures all nested identity fields before BEGIN IMMEDIATE", () => {
  saveValidation();
  const original = structuredClone(identity),
    exec = DatabaseSync.prototype.exec;
  let changed = false;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!changed && sql === "BEGIN IMMEDIATE") {
      changed = true;
      identity.finalizationRequestId = randomUUID();
      identity.validation.dispatch.generation.dispatch.runDigest = "0".repeat(64);
    }
    return exec.call(this, sql);
  });
  const saved = record();
  hook.mockRestore();
  expect(changed).toBe(true);
  expect(saved.record).toMatchObject(original);
  expect(store.providerFinalizationLookup(original)).toEqual(saved.record);
  expect(lookup).toThrow();
});
it("does not complete before stored review validation exists", () => {
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_FINALIZATION_VALIDATION_REQUIRED" }),
  );
  expect(lookup).toThrow();
  expect(inspect()).toEqual(before);
});
it("never replaces a failed terminal run with completion or releases costs again", () => {
  saveValidation();
  appendReviewTerminalFixture(db, store.providerGet(id()) as ProviderExecutionSnapshot);
  const before = inspect(),
    budget = store.providerBudgetGet("production");
  reopen();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_FINALIZATION_EXECUTION_STOPPED" }),
  );
  expect(lookup()).toEqual({ state: "not-observed" });
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGet(id())).toMatchObject({
    revision: 10,
    terminal: true,
    state: "output-invalid",
    canResume: false,
  });
});
it.each(["DELETE", "WAL"])(
  "holds an immediate writer lock through final derivation in %s mode",
  (mode) => {
    saveValidation();
    db.exec(`PRAGMA journal_mode=${mode}`);
    const finalize = engine.finalizeObservedPlanReview;
    const hook = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      return finalize(...args);
    });
    expect(record().newlyCommitted).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  },
);
it("rejects all sixteen changed identity fields on historical lookup and replay", () => {
  saveValidation();
  record();
  const before = inspect();
  for (const path of [
    "finalizationRequestId",
    "validationEventDigest",
    "validation.validationRequestId",
    "validation.responseRequestId",
    "validation.responseEventDigest",
    "validation.dispatch.preparedRequestId",
    "validation.dispatch.dispatchRequestId",
    "validation.dispatch.validationEventDigest",
    "validation.dispatch.generation.responseRequestId",
    "validation.dispatch.generation.responseEventDigest",
    "validation.dispatch.generation.validationRequestId",
    "validation.dispatch.generation.dispatch.runId",
    "validation.dispatch.generation.dispatch.runDigest",
    "validation.dispatch.generation.dispatch.approvalBindingDigest",
    "validation.dispatch.generation.dispatch.preparedRequestId",
    "validation.dispatch.generation.dispatch.dispatchRequestId",
  ]) {
    const changed = structuredClone(identity),
      parts = path.split(".");
    let value = changed as unknown as Record<string, unknown>;
    for (const key of parts.slice(0, -1)) value = value[key] as Record<string, unknown>;
    const key = parts.at(-1)!;
    value[key] = key.endsWith("Digest") ? "0".repeat(64) : randomUUID();
    expect(() => store.providerRecordFinalization(changed), path).toThrow();
    expect(() => store.providerFinalizationLookup(changed), path).toThrow();
  }
  expect(inspect()).toEqual(before);
}, 20000);
it("refuses native, policy and registration nonces before first completion", () => {
  saveValidation();
  const before = inspect();
  for (const nonce of [
    identity.validation.validationRequestId,
    db.prepare("SELECT nonce FROM quality_provider_policies LIMIT 1").get()!.nonce,
    db.prepare("SELECT nonce FROM quality_candidate_requests LIMIT 1").get()!.nonce,
  ]) {
    const changed = { ...identity, finalizationRequestId: nonce };
    expect(() => store.providerRecordFinalization(changed)).toThrow();
    expect(() => store.providerFinalizationLookup(changed)).toThrow();
  }
  expect(inspect()).toEqual(before);
});
it.each(["contract", "internal-contract", "finalizer", "changed-content", "size"])(
  "leaves valid r9 and all costs intact on %s failure",
  (kind) => {
    saveValidation();
    if (kind === "contract")
      vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
        ...engine.getPlanExecutionContract(),
        contractDigest: "0".repeat(64),
      });
    if (kind === "internal-contract")
      vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
        throw Error("Internal contract failure");
      });
    if (kind === "finalizer")
      vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
        throw Error("Internal finalizer failure");
      });
    if (kind === "changed-content" || kind === "size") {
      const original = engine.finalizeObservedPlanReview;
      vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
        const value = original(...args);
        if (kind === "changed-content") value.content.title += " modified";
        else value.review.push({ ...reviewValidationFindings[0], id: "x".repeat(4 * 1024 * 1024) });
        return value;
      });
    }
    const before = inspect(),
      budget = store.providerBudgetGet("production");
    expect(record).toThrow(
      expect.objectContaining({
        code:
          "QUALITY_PROVIDER_DISPATCH_FINALIZATION_" +
          {
            contract: "VALIDATION_CONTRACT_CHANGED",
            "internal-contract": "VALIDATION_UNAVAILABLE",
            finalizer: "FINALIZATION_UNAVAILABLE",
            "changed-content": "FINALIZATION_UNAVAILABLE",
            size: "FINAL_RESULT_TOO_LARGE",
          }[kind],
      }),
    );
    expect(lookup()).toEqual({ state: "not-observed" });
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
);
it("rejects injected body, plan or authority fields before any SQL", () => {
  saveValidation();
  const before = inspect(),
    hook = vi.spyOn(DatabaseSync.prototype, "exec");
  for (const field of ["plan", "body", "configuration", "dispatchAllowed", "transport"])
    expect(() => store.providerRecordFinalization({ ...identity, [field]: {} })).toThrow();
  expect(() =>
    store.providerRecordFinalization({
      ...identity,
      validation: { ...identity.validation, body: {} },
    }),
  ).toThrow();
  expect(hook).not.toHaveBeenCalled();
  hook.mockRestore();
  expect(inspect()).toEqual(before);
});
it.each([1, 2, 3])("rolls every completion row back on INSERT %i failure", (point) => {
  saveValidation();
  const before = inspect(),
    budget = store.providerBudgetGet("production"),
    prepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  const hook = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (/^INSERT INTO quality_actual_(artifacts|events|requests)\(/.test(sql)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => {
        const result = run(...args);
        if (++inserts === point) throw Error("Synthetic insert failure");
        return result;
      });
    }
    return statement;
  });
  expect(record).toThrow();
  hook.mockRestore();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(lookup()).toEqual({ state: "not-observed" });
  expect(record().newlyCommitted).toBe(true);
});
it.each(["before", "after"])("recovers when COMMIT throws %s SQLite commit", (point) => {
  saveValidation();
  const budget = store.providerBudgetGet("production"),
    exec = DatabaseSync.prototype.exec;
  let first = true;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const target = first && sql === "COMMIT";
    if (target) first = false;
    if (target && point === "before") throw Error("Synthetic uncertain commit");
    const result = exec.call(this, sql);
    if (target && point === "after") throw Error("Synthetic uncertain commit");
    return result;
  });
  expect(record).toThrow();
  hook.mockRestore();
  reopen();
  expect(store.providerGet(id()).revision).toBe(point === "after" ? 10 : 9);
  expect(lookup().state).toBe(point === "after" ? "committed" : "not-observed");
  expect(record().replayed).toBe(point === "after");
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
  "quality_actual_artifacts",
])("rejects damaged %s on historical recovery", (table) => {
  saveValidation();
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
it("keeps default writes closed while restoring the audited completion and final body", () => {
  saveValidation();
  const first = record(),
    final = store.providerArtifact(id(), "final-result");
  store.close();
  store = new PlanQualityStore(directory);
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_FINALIZATION_RECORDING_DISABLED" }),
  );
  expect(lookup()).toEqual(first.record);
  expect(store.providerArtifact(id(), "final-result")).toEqual(final);
  expect(inspect()).toEqual(before);
});
it("restores completion, original body and all cost evidence from backup without running today's finalizer", async () => {
  saveValidation();
  const first = record(),
    final = store.providerArtifact(id(), "final-result"),
    budget = store.providerBudgetGet("production"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  const hook = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("Do not rebuild");
  });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id(), "final-result")).toEqual(final);
  expect(hook).not.toHaveBeenCalled();
}, 150000);
