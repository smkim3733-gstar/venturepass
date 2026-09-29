import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import {
  generationResponseFixture,
  appendUnobservedGenerationStop,
} from "./studio-plan-quality-provider-response-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import { getProviderExecutionBudgetSnapshot } from "../../scripts/local-data-quality-provider-execution.mjs";
import type { ProviderGenerationStopIdentity } from "./studio-plan-quality-provider-generation-stop";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";
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
  raw: ReturnType<typeof generationResponseFixture>,
  identity: ProviderGenerationStopIdentity;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-stop-commit-"));
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
  raw = generationResponseFixture(generationDispatchStoreFixture(store));
  raw.response.output = [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify(actualTestPlan(store.candidateRegistryGet(1))),
        },
      ],
    },
  ];
  await store.providerSimulateGenerationDispatch(raw.dispatch, {
    provenance: "synthetic-test",
    send,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 15000);
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
  if (!rel.startsWith("venture-stop-commit-") || rel.includes("..")) throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function select(kind: "unobserved" | "unknown" | "bound" | "invalid" | "valid" = "invalid") {
  identity = {
    dispatch: raw.dispatch,
    stopRequestId: randomUUID(),
    observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
  if (kind === "unobserved") return;
  if (kind === "invalid") raw.response.output = [];
  if (kind === "unknown") delete raw.response.usage;
  if (kind === "bound")
    raw.response.usage = {
      input_tokens: 20,
      output_tokens: 600000,
      total_tokens: 600020,
      input_tokens_details: { cached_tokens: 5 },
    };
  const response = store.providerRecordGenerationResponse(raw).record;
  identity.observation = {
    kind: "response",
    responseRequestId: raw.responseRequestId,
    responseEventDigest: response.responseEventDigest,
  };
}
const record = () => store.providerRecordGenerationStop(identity);
const lookup = () => store.providerGenerationStopLookup(identity);
const inspect = () => inspectQualityDatabase(db);
const snapshot = () => store.providerGet(raw.dispatch.runId) as ProviderExecutionSnapshot;
function own() {
  const s = snapshot();
  return getProviderExecutionBudgetSnapshot(
    s.budgetEvents,
    s.run.preparation.budget.scopeId,
  ).reservations.find((r) => r.runId === s.run.id)!;
}
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
it.each(["unobserved", "unknown", "bound", "invalid"] as const)(
  "atomically stops %s and releases only the undispatched review",
  (kind) => {
    select(kind);
    const before = inspect(),
      phase = own(),
      budget = store.providerBudgetGet("production"),
      bytes = usage(),
      plan = store.providerPrepareGenerationStop(identity);
    expect(plan.status).toBe("prepared");
    if (plan.status !== "prepared") return;
    expect(lookup()).toEqual({ state: "not-observed" });
    const transaction = vi.spyOn(DatabaseSync.prototype, "exec"),
      saved = record();
    expect(transaction.mock.calls.map((r) => r[0])).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    transaction.mockRestore();
    expect(saved).toMatchObject({
      newlyCommitted: true,
      replayed: false,
      record: {
        ...identity,
        state: "committed",
        stopPersisted: true,
        outcome: plan.plan.command.payload.outcome,
        stopEventDigest: plan.plan.rows.event.eventDigest,
        releaseEventDigest: plan.plan.rows.budgetEvent.eventDigest,
        dispatchAllowed: false,
        budgetWriteAllowed: false,
        automaticRetryAllowed: false,
      },
    });
    const after = inspect();
    expect(after).toEqual({
      ...before,
      digest: after.digest,
      actualBudgetEvents: before.actualBudgetEvents + 1,
      actualEvents: before.actualEvents + 1,
      actualRequests: before.actualRequests + 1,
    });
    expect(own().phases[0]).toEqual(phase.phases[0]);
    expect(own().phases[1]).toMatchObject({
      settled: true,
      heldUnits: "0",
      releasedUnits: phase.phases[1].heldUnits,
    });
    expect(store.providerBudgetGet("production").recognizedUnits).toBe(budget.recognizedUnits);
    expect(snapshot()).toMatchObject({
      state: saved.record.outcome,
      terminal: true,
      canResume: false,
      dispatchIntentCount: 1,
    });
    expect(Object.isFrozen(saved.record.observation)).toBe(true);
    expect(usage().usedBytes + usage().reservedBytes).toBeLessThanOrEqual(
      bytes.usedBytes + bytes.reservedBytes,
    );
    expect(record()).toEqual({ record: saved.record, newlyCommitted: false, replayed: true });
    expect(inspect()).toEqual(after);
  },
);
it.each(["unobserved", "unknown", "bound", "invalid"] as const)(
  "recovers %s historical evidence after reopening, policy change, expiry and validator failure",
  (kind) => {
    select(kind);
    const first = record();
    const policy = policyAdoptionFixture(store);
    store.providerPolicyAdopt(policy.command, policy.review);
    const before = inspect(),
      budget = store.providerBudgetGet("production");
    reopen();
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const spies = [
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden),
      vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(forbidden),
      vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden),
    ];
    expect(lookup()).toEqual(first.record);
    expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
);
it.each(["known", "unknown", "excess"])(
  "keeps the original stop identity and historical holds after a late %s response",
  (kind) => {
    select("unobserved");
    const first = record(),
      generation = own().phases[0];
    if (kind === "unknown") delete raw.response.usage;
    if (kind === "excess")
      raw.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    const response = store.providerRecordGenerationResponse(raw),
      before = inspect(),
      budget = store.providerBudgetGet("production");
    reopen();
    expect(lookup()).toEqual(first.record);
    expect(record().record).toEqual(first.record);
    expect(store.providerRecordGenerationResponse(raw).record).toEqual(response.record);
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(snapshot()).toMatchObject({
      revision: 5,
      terminal: true,
      state: "result-unobserved",
      responseCount: 1,
      canResume: false,
    });
    if (kind === "unknown") expect(own().phases[0]).toEqual(generation);
    else expect(own().phases[0]).toMatchObject({ settled: true, heldUnits: "0" });
    expect(own().phases[1].releasedUnits).toBe(first.record.reviewReleasedUnits);
    expect(first.record.generationHeldUnitsAtStop).toBe(generation.heldUnits);
    // A response-bound request cannot impersonate the r3 stop after late evidence appears.
    identity.observation = {
      kind: "response",
      responseRequestId: raw.responseRequestId,
      responseEventDigest: response.record.responseEventDigest,
    };
    expect(lookup).toThrow();
    expect(record).toThrow();
    expect(inspect()).toEqual(before);
  },
);
it.each(["DELETE", "WAL"])(
  "holds the immediate writer lock through stop classification in %s",
  (mode) => {
    raw.response.output = [{ type: "message", content: [{ type: "output_text", text: "{}" }] }];
    select("valid"); // Parseable JSON that reaches, and is rejected by, the domain validator.
    db.exec(`PRAGMA journal_mode=${mode}`);
    const original = engine.validateObservedPlanDraft,
      hook = vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation((...args) => {
        expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
        return original(...args);
      });
    expect(record().newlyCommitted).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  },
);
it.each([
  "stop-nonce",
  "observation",
  "response-nonce",
  "response-digest",
  "run",
  "run-digest",
  "approval",
  "prepared-nonce",
  "dispatch-nonce",
])("refuses changed %s on historical lookup and replay", (kind) => {
  select();
  record();
  const before = inspect();
  identity = structuredClone(identity);
  if (kind === "stop-nonce") identity.stopRequestId = randomUUID();
  if (kind === "observation")
    identity.observation = {
      kind: "unobserved",
      disposition: "stop-with-possible-in-flight-response",
    };
  if (identity.observation.kind === "response") {
    if (kind === "response-nonce") identity.observation.responseRequestId = randomUUID();
    if (kind === "response-digest") identity.observation.responseEventDigest = "0".repeat(64);
  }
  if (kind === "run") identity.dispatch.runId = randomUUID();
  if (kind === "run-digest") identity.dispatch.runDigest = "0".repeat(64);
  if (kind === "approval") identity.dispatch.approvalBindingDigest = "0".repeat(64);
  if (kind === "prepared-nonce") identity.dispatch.preparedRequestId = randomUUID();
  if (kind === "dispatch-nonce") identity.dispatch.dispatchRequestId = randomUUID();
  expect(lookup).toThrow();
  expect(record).toThrow();
  expect(inspect()).toEqual(before);
});
it.each(["generation", "policy", "registration"])(
  "refuses an occupied %s nonce before any stop",
  (kind) => {
    select();
    identity.stopRequestId =
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
it.each(["valid", "contract", "internal"])(
  "preserves all rows and holds for %s validation",
  (kind) => {
    select("valid");
    if (kind === "contract")
      vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
        ...engine.getPlanExecutionContract(),
        contractDigest: "0".repeat(64),
      });
    if (kind === "internal")
      vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(() => {
        throw Error("Internal validation failure");
      });
    const before = inspect(),
      budget = store.providerBudgetGet("production");
    expect(record).toThrow();
    expect(lookup()).toEqual({ state: "not-observed" });
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
);
it("refuses a stale unobserved stop when response capture wins", () => {
  select("unobserved");
  store.providerRecordGenerationResponse(raw);
  const before = inspect();
  expect(record).toThrow();
  expect(inspect()).toEqual(before);
  expect(snapshot().terminal).toBe(false);
});
it("refuses to stop a generation whose validation committed first", () => {
  select("valid");
  if (identity.observation.kind !== "response") throw Error("Expected response");
  store.providerRecordGenerationValidation({
    dispatch: identity.dispatch,
    responseRequestId: identity.observation.responseRequestId,
    responseEventDigest: identity.observation.responseEventDigest,
    validationRequestId: randomUUID(),
  });
  const before = inspect();
  expect(record).toThrow();
  expect(lookup()).toEqual({ state: "not-observed" });
  expect(inspect()).toEqual(before);
});
it.each(["outcome", "releasedUnits", "plan", "configuration", "dispatchAllowed"])(
  "refuses caller %s before SQL",
  (field) => {
    select();
    const hook = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(() => store.providerRecordGenerationStop({ ...identity, [field]: {} })).toThrow();
    expect(hook).not.toHaveBeenCalled();
  },
);
it.each([1, 2, 3])("rolls back release, stop and receipt after INSERT %s fails", (point) => {
  select();
  const before = inspect(),
    budget = store.providerBudgetGet("production"),
    prepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  const hook = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (/^INSERT INTO quality_actual_(budget_events|events|requests)\(/.test(sql)) {
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
it.each(["before", "after"])("recovers an uncertain %s COMMIT without releasing twice", (point) => {
  select();
  const before = inspect(),
    budget = store.providerBudgetGet("production"),
    exec = DatabaseSync.prototype.exec;
  let first = true;
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const target = first && sql === "COMMIT";
    if (target) first = false;
    if (target && point === "before") throw Error("Synthetic commit failure");
    const result = exec.call(this, sql);
    if (target && point === "after") throw Error("Synthetic commit failure");
    return result;
  });
  expect(record).toThrow();
  hook.mockRestore();
  reopen();
  expect(lookup().state).toBe(point === "after" ? "committed" : "not-observed");
  if (point === "before") {
    expect(inspect()).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  }
  expect(record().replayed).toBe(point === "after");
  const saved = inspect(),
    held = store.providerBudgetGet("production");
  expect(record().replayed).toBe(true);
  expect(inspect()).toEqual(saved);
  expect(store.providerBudgetGet("production")).toEqual(held);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
  "quality_actual_budget_events",
  "quality_actual_artifacts",
])("audits corrupt %s before lookup or replay", (table) => {
  select();
  record();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const t of triggers) db.exec(t.sql);
  expect(lookup).toThrow();
  expect(record).toThrow();
});
it("does not adopt a native-only stop whose release nonce belongs to a different command", () => {
  select("unobserved");
  appendUnobservedGenerationStop(db, snapshot());
  const receipt = db
    .prepare("SELECT body FROM quality_actual_requests")
    .all()
    .map((row) => JSON.parse(row.body as string) as { kind: string; clientRequestId: string })
    .find((row) => row.kind === "provider-finish");
  if (!receipt) throw Error("Stop receipt required");
  identity.stopRequestId = receipt.clientRequestId;
  const before = inspect(),
    budget = store.providerBudgetGet("production");
  expect(lookup).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_STOP_CONFLICT" }),
  );
  expect(record).toThrow();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("keeps default stop writes closed while allowing historical lookup", () => {
  select();
  const first = record();
  store.close();
  store = new PlanQualityStore(directory);
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_STOP_RECORDING_DISABLED" }),
  );
  expect(lookup()).toEqual(first.record);
  expect(inspect()).toEqual(before);
});
it("restores exact stop history and late-response costs from backup", async () => {
  select("unobserved");
  const first = record();
  store.providerRecordGenerationResponse(raw);
  const budget = store.providerBudgetGet("production"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  expect(lookup()).toEqual(first.record);
  expect(record().record).toEqual(first.record);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(snapshot()).toMatchObject({
    state: "result-unobserved",
    terminal: true,
    responseCount: 1,
  });
}, 30000);
