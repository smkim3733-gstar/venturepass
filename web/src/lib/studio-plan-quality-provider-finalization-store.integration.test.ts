import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as planner from "./studio-plan-quality-provider-finalization";
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
  identity: planner.ProviderFinalizationIdentity;
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-finalization-read-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const fixture = await reviewValidationStoreFixture(store),
    saved = store.providerRecordReviewValidation(fixture.identity).record;
  identity = {
    validation: fixture.identity,
    validationEventDigest: saved.validationEventDigest,
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
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-finalization-read-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const id = () => identity.validation.dispatch.generation.dispatch.runId;
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
it("reads a frozen completed r10 proposal preserving every persisted row, raw artifact, budget and active r9", () => {
  const before = inspectQualityDatabase(db),
    bytes = usage(),
    budget = store.providerBudgetGet("production"),
    raw = store.providerArtifact(id(), "review-response"),
    result = store.providerPrepareFinalization(identity);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") return;
  expect(result.plan.rows.event).toMatchObject({ revision: 10, payload: { outcome: "completed" } });
  expect(result.plan.completionPersisted).toBe(false);
  expect(Object.isFrozen(result.plan.body.content)).toBe(true);
  expect(result.plan.capacity.additionalUsedBytes).toBeGreaterThan(0);
  expect(result.plan.capacity.previousExposureBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
  expect(result.plan.capacity.totalExposureBytes).toBeLessThan(
    bytes.usedBytes + bytes.reservedBytes,
  );
  expect(store.providerPrepareFinalization(identity)).toEqual(result);
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(usage()).toEqual(bytes);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id(), "review-response")).toEqual(raw);
  expect(() => store.providerArtifact(id(), "final-result")).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_ARTIFACT_NOT_FOUND" }),
  );
  expect(store.providerGet(id())).toMatchObject({
    revision: 9,
    state: "validated",
    terminal: false,
  });
});
it("prepares on the default store after reopening, expiry and replacement policy without current configuration", () => {
  const first = store.providerPrepareFinalization(identity),
    policy = policyAdoptionFixture(store, 0);
  store.providerPolicyAdopt(policy.command, policy.review);
  const before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const config = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw Error("No configuration");
    });
  const result = store.providerPrepareFinalization(identity);
  expect(result.status).toBe("prepared");
  if (first.status === "prepared" && result.status === "prepared") {
    expect(result.plan.command).toEqual(first.plan.command);
    expect(result.plan.body).toEqual(first.plan.body);
    expect(result.plan.basis.archiveDigest).not.toBe(first.plan.basis.archiveDigest);
  }
  expect(config).not.toHaveBeenCalled();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("keeps raw accounting, full inspection and preparation inside the same parent read transaction", () => {
  const before = inspectQualityDatabase(db),
    original = planner.prepareProviderFinalization;
  const hook = vi.spyOn(planner, "prepareProviderFinalization").mockImplementation((input) => {
    expect(input.additionalUsedBytes).toBeGreaterThan(0);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE synthetic_finalization_probe(value TEXT)");
      expect(() => db.exec("COMMIT")).toThrow(/locked/);
    } finally {
      db.exec("ROLLBACK");
    }
    return original(input);
  });
  expect(store.providerPrepareFinalization(identity).status).toBe("prepared");
  expect(hook).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("refuses stale validation identity and globally occupied nonce without consuming completion slots", () => {
  const before = inspectQualityDatabase(db);
  expect(
    store.providerPrepareFinalization({ ...identity, validationEventDigest: "f".repeat(64) }),
  ).toMatchObject({ status: "refused", reason: "bindings-changed" });
  expect(
    store.providerPrepareFinalization({
      ...identity,
      finalizationRequestId: identity.validation.validationRequestId,
    }),
  ).toMatchObject({ status: "refused", reason: "nonce-conflict" });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([false, true])(
  "refuses an already terminal r10 (completed=%s), preserving the historical validation",
  (completed) => {
    const result = store.providerPrepareFinalization(identity);
    if (result.status !== "prepared") throw Error(result.reason);
    appendReviewTerminalFixture(
      db,
      store.providerGet(id()) as ProviderExecutionSnapshot,
      completed ? result.plan.rows.artifact.body : undefined,
    );
    const before = inspectQualityDatabase(db);
    expect(store.providerPrepareFinalization(identity)).toMatchObject({
      status: "refused",
      reason: "execution-stopped",
    });
    expect(store.providerReviewValidationLookup(identity.validation)).toMatchObject({
      state: "committed",
      validationEventDigest: identity.validationEventDigest,
    });
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("reports contract changes and internal finalizer failures without mutating valid r9", () => {
  const before = inspectQualityDatabase(db),
    original = engine.getPlanExecutionContract();
  const hook = vi
    .spyOn(engine, "getPlanExecutionContract")
    .mockReturnValue({ ...original, contractDigest: "0".repeat(64) });
  expect(store.providerPrepareFinalization(identity)).toMatchObject({
    status: "refused",
    reason: "validation-contract-changed",
  });
  hook.mockRestore();
  vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("Internal error");
  });
  expect(store.providerPrepareFinalization(identity)).toMatchObject({
    status: "refused",
    reason: "finalization-unavailable",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("rejects corrupted %s before planning", (table) => {
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  const hook = vi.spyOn(planner, "prepareProviderFinalization");
  expect(() => store.providerPrepareFinalization(identity)).toThrow();
  expect(hook).not.toHaveBeenCalled();
});
