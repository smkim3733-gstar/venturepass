import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
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
  identity: ProviderReviewDispatchIdentity;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-review-dispatch-read-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const raw = generationResponseFixture(generationDispatchStoreFixture(store));
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
  const response = store.providerRecordGenerationResponse(raw).record;
  const generation = {
    dispatch: raw.dispatch,
    responseRequestId: raw.responseRequestId,
    responseEventDigest: response.responseEventDigest,
    validationRequestId: randomUUID(),
  };
  const validation = store.providerRecordGenerationValidation(generation).record;
  identity = {
    generation,
    validationEventDigest: validation.validationEventDigest,
    preparedRequestId: randomUUID(),
    dispatchRequestId: randomUUID(),
  };
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
  if (!rel.startsWith("venture-review-dispatch-read-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function readUsage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
it("returns a frozen r6/r7 plan while preserving every row, raw byte, budget and stored artifact", () => {
  const before = inspectQualityDatabase(db),
    usage = readUsage(),
    budget = store.providerBudgetGet("production"),
    id = identity.generation.dispatch.runId,
    output = store.providerArtifact(id, "generation-validated");
  const result = store.providerPrepareReviewDispatch(identity);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") return;
  expect(result.plan.request.request.phase).toBe("review");
  expect(Object.isFrozen(result.plan.request.body)).toBe(true);
  expect(store.providerPrepareReviewDispatch(identity)).toEqual(result);
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(readUsage()).toEqual(usage);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(id, "generation-validated")).toEqual(output);
  expect(() => store.providerArtifact(id, "review-request")).toThrow();
  expect(store.providerGet(id)).toMatchObject({
    revision: 5,
    state: "validated",
    dispatchIntentCount: 1,
  });
  expect(result.plan.capacity.totalExposureBytes).toBe(usage.usedBytes + usage.reservedBytes);
});
it("permits read-only preparation on a default store after reopening without granting any write/send", () => {
  const before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  expect(store.providerPrepareReviewDispatch(identity)).toMatchObject({
    status: "prepared",
    plan: { dispatchAllowed: false, budgetWriteAllowed: false, automaticRetryAllowed: false },
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("rejects expired original approval instead of renewing it from a fresh review", () => {
  const before = inspectQualityDatabase(db);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  expect(store.providerPrepareReviewDispatch(identity)).toMatchObject({
    status: "refused",
    reason: "approval-expired-or-future",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("rechecks missing server configuration without writing", () => {
  const before = inspectQualityDatabase(db);
  const spy = vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
  expect(store.providerPrepareReviewDispatch(identity)).toMatchObject({
    status: "refused",
    reason: "current-evidence-unavailable",
  });
  expect(spy).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("does not classify a configuration exception as successful preparation", () => {
  const before = inspectQualityDatabase(db);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw Error("configuration unavailable");
  });
  expect(() => store.providerPrepareReviewDispatch(identity)).toThrow("configuration unavailable");
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([0, 1])(
  "rechecks policy adoption for candidate %i using the current shared head",
  (index) => {
    const first = store.providerPrepareReviewDispatch(identity);
    const policy = policyAdoptionFixture(store, index);
    store.providerPolicyAdopt(policy.command, policy.review);
    const before = inspectQualityDatabase(db),
      next = store.providerPrepareReviewDispatch(identity);
    if (index === 0)
      expect(next).toMatchObject({ status: "refused", reason: "policy-or-budget-blocked" });
    else {
      expect(next.status).toBe("prepared");
      if (next.status === "prepared" && first.status === "prepared") {
        expect(next.plan.basis.policyHead.revision).toBe(first.plan.basis.policyHead.revision + 1);
        expect(next.plan.request).toEqual(first.plan.request);
      }
    }
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("keeps the audited DB and current configuration inside one read transaction", () => {
  const before = inspectQualityDatabase(db),
    original = configuration.getProviderConfigurationProposal;
  const hook = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE synthetic_review_read_probe(value TEXT)");
        expect(() => db.exec("COMMIT")).toThrow(/locked/);
      } finally {
        db.exec("ROLLBACK");
      }
      return original();
    });
  expect(store.providerPrepareReviewDispatch(identity).status).toBe("prepared");
  expect(hook).toHaveBeenCalledOnce();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("refuses damaged %s before deriving a request", (table) => {
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  expect(() => store.providerPrepareReviewDispatch(identity)).toThrow();
});
