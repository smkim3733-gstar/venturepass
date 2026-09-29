import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import {
  appendUnobservedGenerationStop,
  generationResponseFixture,
} from "./studio-plan-quality-provider-response-test-helpers";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import type { ProviderGenerationStopIdentity } from "./studio-plan-quality-provider-generation-stop";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";

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
let directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  raw: ReturnType<typeof generationResponseFixture>;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-generation-stop-"));
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
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-generation-stop-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function selection(observed = true): ProviderGenerationStopIdentity {
  if (!observed)
    return {
      dispatch: raw.dispatch,
      stopRequestId: randomUUID(),
      observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
    };
  const response = store.providerRecordGenerationResponse(raw).record;
  return {
    dispatch: raw.dispatch,
    stopRequestId: randomUUID(),
    observation: {
      kind: "response",
      responseRequestId: raw.responseRequestId,
      responseEventDigest: response.responseEventDigest,
    },
  };
}
it.each(["unobserved", "unknown", "bound", "invalid", "valid"] as const)(
  "reads %s stop evidence under one transaction without mutating any row or hold",
  (kind) => {
    if (kind === "unknown") delete raw.response.usage;
    if (kind === "bound")
      raw.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "invalid") raw.response.output = [];
    const identity = selection(kind !== "unobserved"),
      before = inspectQualityDatabase(db),
      budget = store.providerBudgetGet("production"),
      snapshot = store.providerGet(raw.dispatch.runId),
      hook = vi.spyOn(DatabaseSync.prototype, "exec");
    const result = store.providerPrepareGenerationStop(identity);
    expect(hook.mock.calls.map((row) => row[0])).toEqual(["BEGIN", "COMMIT"]);
    hook.mockRestore();
    if (kind === "valid")
      expect(result).toEqual({ status: "refused", reason: "generation-valid", plan: null });
    else {
      expect(result.status).toBe("prepared");
      if (result.status !== "prepared") return;
      expect(result.plan.rows.event.payload.kind).toBe("execution-stopped");
      expect(Object.isFrozen(result.plan.rows.budgetEvent)).toBe(true);
      expect(result.plan).toMatchObject({
        dispatchAllowed: false,
        budgetWriteAllowed: false,
        automaticRetryAllowed: false,
      });
    }
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGet(raw.dispatch.runId)).toEqual(snapshot);
    expect(store.providerPrepareGenerationStop(identity)).toEqual(result);
  },
);
it("allows default-store offline inspection after restart and expiry", () => {
  raw.response.output = [];
  const identity = selection(),
    before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spy = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(forbidden);
  expect(store.providerPrepareGenerationStop(identity).status).toBe("prepared");
  expect(spy).not.toHaveBeenCalled();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("preserves evidence and holds when domain validation unexpectedly throws", () => {
  const identity = selection(),
    before = inspectQualityDatabase(db),
    budget = store.providerBudgetGet("production");
  vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(() => {
    throw Error("synthetic internal validator failure");
  });
  expect(store.providerPrepareGenerationStop(identity)).toEqual({
    status: "refused",
    reason: "validation-unavailable",
    plan: null,
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("does not turn an unobserved intent into a captured-response stop after the response arrives", () => {
  const identity = selection(false);
  raw.response.output = [];
  selection();
  const before = inspectQualityDatabase(db);
  expect(store.providerPrepareGenerationStop(identity)).toMatchObject({
    status: "refused",
    reason: "observation-changed",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("does not reopen a terminal run after a late response was preserved", () => {
  appendUnobservedGenerationStop(
    db,
    store.providerGet(raw.dispatch.runId) as ProviderExecutionSnapshot,
  );
  const identity = selection(),
    before = inspectQualityDatabase(db);
  expect(store.providerPrepareGenerationStop(identity)).toMatchObject({
    status: "refused",
    reason: "generation-prefix-changed",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(store.providerGet(raw.dispatch.runId)).toMatchObject({
    terminal: true,
    state: "result-unobserved",
  });
});
it("keeps a coherent read snapshot through output classification", () => {
  const identity = selection(),
    before = inspectQualityDatabase(db),
    original = engine.validateObservedPlanDraft;
  const hook = vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation((...args) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE synthetic_stop_read_probe(value TEXT)");
      expect(() => db.exec("COMMIT")).toThrow(/locked/);
    } finally {
      db.exec("ROLLBACK");
    }
    return original(...args);
  });
  expect(store.providerPrepareGenerationStop(identity)).toMatchObject({
    status: "refused",
    reason: "generation-valid",
  });
  expect(hook).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("rejects damaged %s before proposing any release", (table) => {
  raw.response.output = [];
  const identity = selection();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  expect(() => store.providerPrepareGenerationStop(identity)).toThrow();
});
