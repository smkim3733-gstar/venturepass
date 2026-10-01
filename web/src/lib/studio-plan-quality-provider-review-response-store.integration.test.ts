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
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as planner from "./studio-plan-quality-provider-review-response";
import * as configuration from "./studio-plan-quality-provider-configuration";

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
  capture: planner.ProviderReviewResponseCapture;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-review-response-read-"));
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
  if (!rel.startsWith("venture-review-response-read-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const id = () => capture.dispatch.generation.dispatch.runId;
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
it("prepares frozen response/settlement rows while preserving all DB rows, raw bytes, reservations and original request", () => {
  const before = inspectQualityDatabase(db),
    bytes = usage(),
    budget = store.providerBudgetGet("production"),
    request = store.providerArtifact(id(), "review-request"),
    result = store.providerPrepareReviewResponse(capture);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") return;
  expect(result.plan.resultingState).toMatchObject({ revision: 8, terminal: false });
  expect(Object.isFrozen(result.plan.rows.event)).toBe(true);
  expect(result.plan.capacity.previousExposureBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
  expect(result.plan.capacity.totalExposureBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
  expect(store.providerPrepareReviewResponse(capture)).toEqual(result);
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(usage()).toEqual(bytes);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id(), "review-request")).toEqual(request);
  expect(() => store.providerArtifact(id(), "review-response")).toThrow();
  expect(store.providerGet(id())).toMatchObject({
    revision: 7,
    state: "dispatching",
    responseCount: 1,
    dispatchIntentCount: 2,
  });
});
it("allows read-only capture planning on a default store after reopening without enabling writes", () => {
  const before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  expect(store.providerPrepareReviewResponse(capture)).toMatchObject({
    status: "prepared",
    plan: {
      responsePersisted: false,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
    },
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("ignores expired/current configuration and policy replacement when preserving an already obtained response", () => {
  const first = store.providerPrepareReviewResponse(capture),
    policy = policyAdoptionFixture(store, 0);
  store.providerPolicyAdopt(policy.command, policy.review);
  const before = inspectQualityDatabase(db);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const config = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw Error("Current config unavailable");
    });
  const next = store.providerPrepareReviewResponse(capture);
  expect(next.status).toBe("prepared");
  if (first.status === "prepared" && next.status === "prepared") {
    expect(next.plan.usageAssessment).toEqual(first.plan.usageAssessment);
    expect(next.plan.command).toEqual(first.plan.command);
  }
  expect(config).not.toHaveBeenCalled();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([false, true])("plans late r9 with terminal state preserved, unknown=%s", (unknown) => {
  appendReviewUnobservedStop(db, store.providerGet(id()) as ProviderExecutionSnapshot);
  if (unknown) delete capture.response.usage;
  const before = inspectQualityDatabase(db),
    budget = store.providerBudgetGet("production");
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const result = store.providerPrepareReviewResponse(capture);
  expect(result).toMatchObject({
    status: "prepared",
    plan: {
      late: true,
      resultingState: {
        revision: 9,
        terminal: true,
        state: "result-unobserved",
      },
    },
  });
  if (result.status === "prepared" && unknown)
    expect(result.plan.budget.after).toEqual(result.plan.budget.before);
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGet(id())).toMatchObject({ revision: 8, terminal: true });
});
it("keeps audited raw usage and response planning within the same read transaction", () => {
  const before = inspectQualityDatabase(db),
    original = planner.prepareVersionedProviderReviewResponse;
  const hook = vi.spyOn(planner, "prepareVersionedProviderReviewResponse").mockImplementation((input) => {
    expect(input.additionalUsedBytes).toBeGreaterThan(0);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE synthetic_response_read_probe(value TEXT)");
      expect(() => db.exec("COMMIT")).toThrow(/locked/);
    } finally {
      db.exec("ROLLBACK");
    }
    return original(input);
  });
  expect(store.providerPrepareReviewResponse(capture).status).toBe("prepared");
  expect(hook).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("refuses reused nonce and wrong dispatch without consuming any response slot", () => {
  const before = inspectQualityDatabase(db);
  expect(
    store.providerPrepareReviewResponse({
      ...capture,
      responseRequestId: capture.dispatch.dispatchRequestId,
    }),
  ).toMatchObject({ status: "refused", reason: "nonce-conflict" });
  expect(
    store.providerPrepareReviewResponse({
      ...capture,
      dispatch: { ...capture.dispatch, dispatchRequestId: randomUUID() },
    }),
  ).toMatchObject({ status: "refused", reason: "bindings-changed" });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("refuses corrupted %s before preparing capture", (table) => {
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  const hook = vi.spyOn(planner, "prepareVersionedProviderReviewResponse");
  expect(() => store.providerPrepareReviewResponse(capture)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
