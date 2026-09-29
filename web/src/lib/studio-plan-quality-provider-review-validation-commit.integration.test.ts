import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  reviewDispatchStoreFixture,
  appendReviewUnobservedStop,
} from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import { appendReviewTerminalFixture } from "./studio-plan-quality-provider-review-validation-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderReviewValidationIdentity } from "./studio-plan-quality-provider-review-validation";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import * as planner from "./studio-plan-quality-provider-review-validation";

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
let root: string,
  directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  raw: ReturnType<typeof reviewResponseCapture>,
  identity: ProviderReviewValidationIdentity;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-review-validation-commit-"));
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
  raw = reviewResponseCapture(await reviewDispatchStoreFixture(store));
  setReviewValidationOutput(raw.response);
  await store.providerSimulateReviewDispatch(raw.dispatch, { provenance: "synthetic-test", send });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-review-validation-commit-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function saveResponse() {
  const saved = store.providerRecordReviewResponse(raw).record;
  identity = {
    dispatch: raw.dispatch,
    responseRequestId: raw.responseRequestId,
    responseEventDigest: saved.responseEventDigest,
    validationRequestId: randomUUID(),
  };
}
const record = () => store.providerRecordReviewValidation(identity);
const lookup = () => store.providerReviewValidationLookup(identity);
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
/** Native terminal fixture only; never an application stop API. */
function appendCapturedStop() {
  appendReviewTerminalFixture(
    db,
    store.providerGet(raw.dispatch.generation.dispatch.runId) as ProviderExecutionSnapshot,
  );
}
it("commits exactly three audited native rows, preserves all costs and holds, and never persists final results", () => {
  saveResponse();
  const before = inspect(),
    capacity = usage(),
    budget = store.providerBudgetGet("production"),
    response = store.providerArtifact(raw.dispatch.generation.dispatch.runId, "review-response"),
    planned = store.providerPrepareReviewValidation(identity);
  expect(planned.status).toBe("prepared");
  if (planned.status !== "prepared") return;
  expect(lookup()).toEqual({ state: "not-observed" });
  const saved = record();
  expect(saved).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      ...identity,
      state: "committed",
      revision: 9,
      validationPersisted: true,
      finalResultPersisted: false,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      inputDigest: planned.plan.rows.receipt.inputDigest,
      validationEventDigest: planned.plan.rows.event.eventDigest,
      validatedArtifactSha256: planned.plan.rows.artifact.sha256,
      outputDigest: planned.plan.command.payload.outputDigest,
      generationArtifactSha256: planned.plan.basis.generationArtifactSha256,
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
  expect(store.providerArtifact(raw.dispatch.generation.dispatch.runId, "review-response")).toEqual(
    response,
  );
  expect(
    store
      .providerArtifact(raw.dispatch.generation.dispatch.runId, "review-validated")
      .body.toString("utf8"),
  ).toBe(planned.plan.rows.artifact.body);
  expect(() =>
    store.providerArtifact(raw.dispatch.generation.dispatch.runId, "final-result"),
  ).toThrow();
  expect(store.providerGet(raw.dispatch.generation.dispatch.runId)).toMatchObject({
    revision: 9,
    state: "validated",
    terminal: false,
    unsettled: false,
    responseCount: 2,
    dispatchIntentCount: 2,
    canResume: false,
  });
  expect(Object.isFrozen(saved.record.dispatch)).toBe(true);
  expect(Object.isFrozen(saved.record.dispatch.generation.dispatch)).toBe(true);
  expect(saved.record).not.toHaveProperty("finalization");
  const next = usage();
  expect(next.usedBytes).toBeGreaterThan(capacity.usedBytes);
  expect(next.usedBytes + next.reservedBytes).toBe(capacity.usedBytes + capacity.reservedBytes);
});
it("replays exact original evidence after reopening, policy change, expiry and validator replacement", () => {
  saveResponse();
  const first = record();
  const policy = policyAdoptionFixture(store);
  store.providerPolicyAdopt(policy.command, policy.review);
  const before = inspect(),
    budget = store.providerBudgetGet("production");
  reopen();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spies = [
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
      throw Error("config unavailable");
    }),
    vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
      throw Error("validator changed");
    }),
    vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(() => {
      throw Error("validator changed");
    }),
    vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
      throw Error("finalizer changed");
    }),
    vi.spyOn(planner, "prepareProviderReviewValidation").mockImplementation(() => {
      throw Error("no current planner in history");
    }),
  ];
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("allows a first offline validation after expiry without consulting current configuration", () => {
  saveResponse();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spy = vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw Error("config unavailable");
  });
  expect(record()).toMatchObject({
    newlyCommitted: true,
    record: { finalResultPersisted: false, dispatchAllowed: false },
  });
  expect(spy).not.toHaveBeenCalled();
});
it("recovers original r9 evidence after native r10 completion without running the current finalizer or writing again", () => {
  saveResponse();
  const preview = store.providerPrepareReviewValidation(identity);
  if (preview.status !== "prepared") throw Error(preview.reason);
  const first = record();
  appendReviewTerminalFixture(
    db,
    store.providerGet(raw.dispatch.generation.dispatch.runId) as ProviderExecutionSnapshot,
    preview.plan.finalization.rawBody,
  );
  const before = inspect(),
    final = store.providerArtifact(raw.dispatch.generation.dispatch.runId, "final-result");
  reopen();
  const hook = vi.spyOn(planner, "prepareProviderReviewValidation").mockImplementation(() => {
    throw Error("no current plan");
  });
  const finalize = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("no current finalizer");
  });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  expect(store.providerGet(raw.dispatch.generation.dispatch.runId)).toMatchObject({
    revision: 10,
    state: "completed",
    terminal: true,
  });
  expect(store.providerArtifact(raw.dispatch.generation.dispatch.runId, "final-result")).toEqual(
    final,
  );
  expect(inspect()).toEqual(before);
  expect(hook).not.toHaveBeenCalled();
  expect(finalize).not.toHaveBeenCalled();
});
it("captures nested identity before BEGIN IMMEDIATE so caller mutation cannot change the request", () => {
  saveResponse();
  const original = structuredClone(identity),
    exec = DatabaseSync.prototype.exec;
  let changed = false;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (!changed && sql === "BEGIN IMMEDIATE") {
      changed = true;
      identity.validationRequestId = randomUUID();
      identity.dispatch.generation.dispatch.runDigest = "0".repeat(64);
    }
    return exec.call(this, sql);
  });
  const saved = record();
  hook.mockRestore();
  expect(changed).toBe(true);
  expect(saved.record).toMatchObject(original);
  expect(store.providerReviewValidationLookup(original)).toEqual(saved.record);
  expect(lookup).toThrow();
});
it.each(["before", "after"])(
  "preserves a terminal event %s validation without reopening or releasing twice",
  (point) => {
    saveResponse();
    const first = point === "after" ? record() : null;
    appendCapturedStop();
    const before = inspect(),
      budget = store.providerBudgetGet("production");
    reopen();
    if (first) {
      expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
      expect(lookup()).toEqual(first.record);
    } else {
      expect(record).toThrow(
        expect.objectContaining({
          code: "QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_EXECUTION_STOPPED",
        }),
      );
      expect(lookup()).toEqual({ state: "not-observed" });
    }
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGet(raw.dispatch.generation.dispatch.runId)).toMatchObject({
      terminal: true,
      state: "output-invalid",
      canResume: false,
    });
  },
);
it.each(["DELETE", "WAL"])(
  "holds an immediate writer lock through domain validation in %s mode",
  (mode) => {
    saveResponse();
    db.exec(`PRAGMA journal_mode=${mode}`);
    const validate = engine.validateObservedPlanReview;
    const hook = vi.spyOn(engine, "validateObservedPlanReview").mockImplementation((...args) => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      return validate(...args);
    });
    expect(record().newlyCommitted).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  },
);
it.each([
  "validationRequestId",
  "responseRequestId",
  "responseEventDigest",
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
])("rejects a different original identity %s on lookup and replay", (path) => {
  saveResponse();
  record();
  const before = inspect();
  const parts = path.split(".");
  let value = identity as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) value = value[key] as Record<string, unknown>;
  const key = parts.at(-1)!;
  value[key] = key.endsWith("Digest") ? "0".repeat(64) : randomUUID();
  expect(record).toThrow();
  expect(lookup).toThrow();
  expect(inspect()).toEqual(before);
});
it.each(["generation", "policy", "registration"])(
  "refuses an occupied %s nonce before the first validation",
  (kind) => {
    saveResponse();
    identity.validationRequestId =
      kind === "generation"
        ? raw.responseRequestId
        : (db
            .prepare(
              kind === "policy"
                ? "SELECT nonce FROM quality_provider_policies LIMIT 1"
                : "SELECT nonce FROM quality_candidate_requests LIMIT 1",
            )
            .get()!.nonce as string);
    const before = inspect();
    expect(record).toThrow();
    expect(lookup).toThrow();
    expect(inspect()).toEqual(before);
  },
);
it.each(["output", "usage", "bound", "contract", "internal", "finalization"])(
  "does not store a validation or release holds for %s failure",
  (kind) => {
    if (kind === "output") raw.response.output = [];
    if (kind === "usage") delete raw.response.usage;
    if (kind === "bound")
      raw.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    saveResponse();
    if (kind === "contract") {
      const original = engine.getPlanExecutionContract();
      vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
        ...original,
        contractDigest: "0".repeat(64),
      });
    }
    if (kind === "internal")
      vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(() => {
        throw Error("internal validator error");
      });
    if (kind === "finalization")
      vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
        throw Error("internal finalization error");
      });
    const before = inspect(),
      budget = store.providerBudgetGet("production");
    expect(record).toThrow(
      expect.objectContaining({
        code:
          "QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_" +
          {
            output: "OUTPUT_INVALID",
            usage: "USAGE_UNKNOWN",
            bound: "BUDGET_BOUND_BREACHED",
            contract: "VALIDATION_CONTRACT_CHANGED",
            internal: "VALIDATION_UNAVAILABLE",
            finalization: "FINALIZATION_UNAVAILABLE",
          }[kind],
      }),
    );
    expect(lookup()).toEqual({ state: "not-observed" });
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
);
it("cannot validate a late response to reopen a terminal run", () => {
  appendReviewUnobservedStop(
    db,
    store.providerGet(raw.dispatch.generation.dispatch.runId) as ProviderExecutionSnapshot,
  );
  saveResponse();
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_EXECUTION_STOPPED",
    }),
  );
  expect(lookup()).toEqual({ state: "not-observed" });
  expect(inspect()).toEqual(before);
  expect(store.providerGet(raw.dispatch.generation.dispatch.runId)).toMatchObject({
    terminal: true,
    state: "result-unobserved",
  });
});
it.each(["plan", "output", "configuration", "dispatchAllowed", "review"])(
  "rejects caller supplied %s before any SQL",
  (field) => {
    saveResponse();
    const before = inspect(),
      hook = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(() => store.providerRecordReviewValidation({ ...identity, [field]: {} })).toThrow();
    expect(hook).not.toHaveBeenCalled();
    hook.mockRestore();
    expect(inspect()).toEqual(before);
  },
);
it.each([1, 2, 3])("rolls all three rows back on INSERT %i failure", (point) => {
  saveResponse();
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
        if (++inserts === point) throw Error("synthetic insert failure");
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
it.each(["before", "after"])("recovers after COMMIT throws %s SQLite commit", (point) => {
  saveResponse();
  const budget = store.providerBudgetGet("production"),
    exec = DatabaseSync.prototype.exec;
  let first = true;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const target = first && sql === "COMMIT";
    if (target) first = false;
    if (target && point === "before") throw Error("synthetic uncertain commit");
    const result = exec.call(this, sql);
    if (target && point === "after") throw Error("synthetic uncertain commit");
    return result;
  });
  expect(record).toThrow();
  hook.mockRestore();
  reopen();
  expect(store.providerGet(raw.dispatch.generation.dispatch.runId).revision).toBe(
    point === "after" ? 9 : 8,
  );
  expect(lookup().state).toBe(point === "after" ? "committed" : "not-observed");
  expect(record().replayed).toBe(point === "after");
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
  "quality_actual_artifacts",
])("rejects damaged %s even during historical recovery", (table) => {
  saveResponse();
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
it("keeps default writes closed but allows audited historical lookup", () => {
  saveResponse();
  const first = record();
  store.close();
  store = new PlanQualityStore(directory);
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_RECORDING_DISABLED",
    }),
  );
  expect(lookup()).toEqual(first.record);
  expect(inspect()).toEqual(before);
});
it("restores the same validation from backup without rebuilding or writing final results", async () => {
  saveResponse();
  const first = record(),
    budget = store.providerBudgetGet("production"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(lookup()).toEqual(first.record);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(() =>
    store.providerArtifact(raw.dispatch.generation.dispatch.runId, "final-result"),
  ).toThrow();
}, 150000);
