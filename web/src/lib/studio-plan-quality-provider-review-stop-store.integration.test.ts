import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderReviewResponseCapture } from "./studio-plan-quality-provider-review-response";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as planner from "./studio-plan-quality-provider-review-stop";
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
let directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  capture: ProviderReviewResponseCapture;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-review-stop-read-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const identity = await reviewDispatchStoreFixture(store);
  await store.providerSimulateReviewDispatch(identity, { provenance: "synthetic-test", send });
  capture = reviewResponseCapture(identity);
  setReviewValidationOutput(capture.response);
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
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-review-stop-read-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const id = () => capture.dispatch.generation.dispatch.runId;
function selection(observed = true): planner.ProviderReviewStopIdentity {
  return {
    dispatch: capture.dispatch,
    stopRequestId: randomUUID(),
    observation: observed
      ? {
          kind: "response",
          responseRequestId: capture.responseRequestId,
          responseEventDigest:
            store.providerRecordReviewResponse(capture).record.responseEventDigest,
        }
      : { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
}
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
it.each(["unobserved", "unknown", "bound", "invalid", "valid"] as const)(
  "reads %s stop evidence without changing rows, raw bytes or holds",
  (kind) => {
    if (kind === "unknown") delete capture.response.usage;
    if (kind === "bound")
      capture.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "invalid") capture.response.output = [];
    const identity = selection(kind !== "unobserved"),
      before = inspectQualityDatabase(db),
      bytes = usage(),
      budget = store.providerBudgetGet("production"),
      snapshot = store.providerGet(id()),
      hook = vi.spyOn(DatabaseSync.prototype, "exec");
    const result = store.providerPrepareReviewStop(identity);
    expect(hook.mock.calls.map((row) => row[0])).toEqual(["BEGIN", "COMMIT"]);
    hook.mockRestore();
    if (kind === "valid")
      expect(result).toEqual({ status: "refused", reason: "review-valid", plan: null });
    else {
      expect(result.status).toBe("prepared");
      if (result.status !== "prepared") throw Error(result.reason);
      expect(Object.keys(result.plan.rows).sort()).toEqual(["event", "receipt"]);
      expect(Object.isFrozen(result.plan.rows.event)).toBe(true);
      expect(result.plan.capacity.beforeExposureBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
      expect(result.plan).toMatchObject({
        stopPersisted: false,
        finalResultPersisted: false,
        dispatchAllowed: false,
        budgetWriteAllowed: false,
        automaticRetryAllowed: false,
      });
    }
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(usage()).toEqual(bytes);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGet(id())).toEqual(snapshot);
    expect(store.providerPrepareReviewStop(identity)).toEqual(result);
  },
);
it("allows offline default-store inspection after reopening and expiry", () => {
  capture.response.output = [];
  const identity = selection(),
    before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spy = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(forbidden);
  expect(store.providerPrepareReviewStop(identity).status).toBe("prepared");
  expect(spy).not.toHaveBeenCalled();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("preserves all evidence on an internal review validator failure", () => {
  const identity = selection(),
    before = inspectQualityDatabase(db),
    budget = store.providerBudgetGet("production");
  vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(() => {
    throw Error("synthetic internal validator failure");
  });
  expect(store.providerPrepareReviewStop(identity)).toEqual({
    status: "refused",
    reason: "validation-unavailable",
    plan: null,
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("does not replace stale unobserved intent with a captured-response stop", () => {
  const identity = selection(false);
  capture.response.output = [];
  selection();
  const before = inspectQualityDatabase(db);
  expect(store.providerPrepareReviewStop(identity)).toMatchObject({
    status: "refused",
    reason: "observation-changed",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each(["known", "unknown", "excess"])(
  "retains terminal state after real store captures late %s review",
  (kind) => {
    appendReviewUnobservedStop(db, store.providerGet(id()) as ProviderExecutionSnapshot);
    const budgetBefore = store.providerBudgetGet("production");
    if (kind === "unknown") delete capture.response.usage;
    if (kind === "excess")
      capture.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    const identity = selection(),
      before = inspectQualityDatabase(db);
    expect(store.providerPrepareReviewStop(identity)).toMatchObject({
      status: "refused",
      reason: "review-prefix-changed",
    });
    expect(store.providerGet(id())).toMatchObject({
      revision: 9,
      state: "result-unobserved",
      terminal: true,
      responseCount: 2,
      canResume: false,
    });
    const budgetAfter = store.providerBudgetGet("production");
    if (kind === "unknown") expect(budgetAfter).toEqual(budgetBefore);
    else expect(budgetAfter).not.toEqual(budgetBefore);
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("holds raw accounting and output classification in the same parent read transaction", () => {
  const identity = selection(),
    before = inspectQualityDatabase(db),
    original = planner.prepareProviderReviewStop;
  const hook = vi.spyOn(planner, "prepareProviderReviewStop").mockImplementation((input) => {
    expect(input.additionalUsedBytes).toBeGreaterThan(0);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE synthetic_review_stop_probe(value TEXT)");
      expect(() => db.exec("COMMIT")).toThrow(/locked/);
    } finally {
      db.exec("ROLLBACK");
    }
    return original(input);
  });
  expect(store.providerPrepareReviewStop(identity)).toMatchObject({
    status: "refused",
    reason: "review-valid",
  });
  expect(hook).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("rejects corrupted %s before planning", (table) => {
  const identity = selection(),
    triggers = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
      .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  const hook = vi.spyOn(planner, "prepareProviderReviewStop");
  expect(() => store.providerPrepareReviewStop(identity)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
