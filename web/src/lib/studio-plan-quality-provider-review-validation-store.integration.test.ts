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
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderReviewResponseCapture } from "./studio-plan-quality-provider-review-response";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as planner from "./studio-plan-quality-provider-review-validation";
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
  directory = mkdtempSync(join(tmpdir(), "venture-review-validation-read-"));
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
  if (!rel.startsWith("venture-review-validation-read-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const id = () => capture.dispatch.generation.dispatch.runId;
function save(): planner.ProviderReviewValidationIdentity {
  const saved = store.providerRecordReviewResponse(capture).record;
  return {
    dispatch: capture.dispatch,
    responseRequestId: capture.responseRequestId,
    responseEventDigest: saved.responseEventDigest,
    validationRequestId: randomUUID(),
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
it("reads a frozen r9 plan and final preview while preserving every row, raw byte, response and settled budget", () => {
  const identity = save(),
    before = inspectQualityDatabase(db),
    bytes = usage(),
    budget = store.providerBudgetGet("production"),
    raw = store.providerArtifact(id(), "review-response");
  const result = store.providerPrepareReviewValidation(identity);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") return;
  expect(result.plan.rows.event.revision).toBe(9);
  expect(result.plan.finalization.status).toBe("derived-not-finalized");
  expect(Object.isFrozen(result.plan.finalization.body)).toBe(true);
  expect(result.plan.capacity.previousExposureBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
  expect(result.plan.capacity.totalExposureBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
  expect(store.providerPrepareReviewValidation(identity)).toEqual(result);
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id(), "review-response")).toEqual(raw);
  expect(store.providerGet(id())).toMatchObject({
    revision: 8,
    state: "response-recorded",
    terminal: false,
    responseCount: 2,
  });
});
it("prepares offline on the default store after reopening, expiry and replacement policy without fresh configuration", () => {
  const identity = save(),
    first = store.providerPrepareReviewValidation(identity),
    policy = policyAdoptionFixture(store, 0);
  store.providerPolicyAdopt(policy.command, policy.review);
  const before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const config = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw Error("No current configuration");
    });
  const result = store.providerPrepareReviewValidation(identity);
  expect(result.status).toBe("prepared");
  if (first.status === "prepared" && result.status === "prepared") {
    expect(result.plan.command).toEqual(first.plan.command);
    expect(result.plan.finalization.body).toEqual(first.plan.finalization.body);
    expect(result.plan.basis.archiveDigest).not.toBe(first.plan.basis.archiveDigest);
  }
  expect(config).not.toHaveBeenCalled();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each(["usage", "bound", "output"])("blocks %s without altering persisted evidence", (kind) => {
  if (kind === "usage") delete capture.response.usage;
  if (kind === "bound")
    capture.response.usage = {
      input_tokens: 20,
      output_tokens: 600000,
      total_tokens: 600020,
      input_tokens_details: { cached_tokens: 5 },
    };
  if (kind === "output") capture.response.output = [];
  const identity = save(),
    before = inspectQualityDatabase(db);
  expect(store.providerPrepareReviewValidation(identity)).toMatchObject({
    status: "refused",
    reason:
      kind === "usage"
        ? "usage-unknown"
        : kind === "bound"
          ? "budget-bound-breached"
          : "output-invalid",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("never resumes a terminal late r9 response after cost settlement", () => {
  appendReviewUnobservedStop(db, store.providerGet(id()) as ProviderExecutionSnapshot);
  const identity = save(),
    before = inspectQualityDatabase(db);
  expect(store.providerPrepareReviewValidation(identity)).toMatchObject({
    status: "refused",
    reason: "execution-stopped",
  });
  expect(store.providerGet(id())).toMatchObject({
    revision: 9,
    state: "result-unobserved",
    terminal: true,
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("keeps raw accounting, archive inspection and validation within the same parent read transaction", () => {
  const identity = save(),
    before = inspectQualityDatabase(db),
    original = planner.prepareProviderReviewValidation;
  const hook = vi.spyOn(planner, "prepareProviderReviewValidation").mockImplementation((input) => {
    expect(input.additionalUsedBytes).toBeGreaterThan(0);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE synthetic_review_validation_probe(value TEXT)");
      expect(() => db.exec("COMMIT")).toThrow(/locked/);
    } finally {
      db.exec("ROLLBACK");
    }
    return original(input);
  });
  expect(store.providerPrepareReviewValidation(identity).status).toBe("prepared");
  expect(hook).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("refuses stale response identity and global nonce reuse without consuming validation or completion slots", () => {
  const identity = save(),
    before = inspectQualityDatabase(db);
  expect(
    store.providerPrepareReviewValidation({ ...identity, responseRequestId: randomUUID() }),
  ).toMatchObject({ status: "refused", reason: "bindings-changed" });
  expect(
    store.providerPrepareReviewValidation({
      ...identity,
      validationRequestId: identity.responseRequestId,
    }),
  ).toMatchObject({ status: "refused", reason: "nonce-conflict" });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("reports incompatible validator separately from invalid output without state changes", () => {
  const identity = save(),
    before = inspectQualityDatabase(db),
    contract = engine.getPlanExecutionContract();
  vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
    ...contract,
    contractDigest: "0".repeat(64),
  });
  expect(store.providerPrepareReviewValidation(identity)).toMatchObject({
    status: "refused",
    reason: "validation-contract-changed",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("rejects corrupted %s before preparing validation", (table) => {
  const identity = save(),
    triggers = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
      .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  const hook = vi.spyOn(planner, "prepareProviderReviewValidation");
  expect(() => store.providerPrepareReviewValidation(identity)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
