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
import type { ProviderGenerationValidationIdentity } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderExecutionSnapshot } from "./studio-plan-quality-provider-execution-types";
import * as configuration from "./studio-plan-quality-provider-configuration";

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
  directory = mkdtempSync(join(tmpdir(), "venture-generation-validation-"));
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
  if (!rel.startsWith("venture-generation-validation-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function save(): ProviderGenerationValidationIdentity {
  const saved = store.providerRecordGenerationResponse(raw).record;
  return {
    dispatch: raw.dispatch,
    responseRequestId: raw.responseRequestId,
    responseEventDigest: saved.responseEventDigest,
    validationRequestId: randomUUID(),
  };
}
it("returns an immutable plan under the parent's read transaction without any row, budget, or response mutation", () => {
  const identity = save(),
    before = inspectQualityDatabase(db),
    budget = store.providerBudgetGet("production"),
    response = store.providerArtifact(raw.dispatch.runId, "generation-response");
  const result = store.providerPrepareGenerationValidation(identity);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") return;
  expect(result.plan.rows.event.revision).toBe(5);
  expect(Object.isFrozen(result.plan.review.body)).toBe(true);
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(raw.dispatch.runId, "generation-response")).toEqual(response);
  expect(store.providerGet(raw.dispatch.runId)).toMatchObject({
    revision: 4,
    state: "response-recorded",
    responseCount: 1,
  });
  expect(store.providerPrepareGenerationValidation(identity)).toEqual(result);
});
it("supports offline read-only preparation on the default store after reopening and expiry", () => {
  const identity = save(),
    before = inspectQualityDatabase(db);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const spy = vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw new Error("No current configuration");
  });
  expect(store.providerPrepareGenerationValidation(identity).status).toBe("prepared");
  expect(spy).not.toHaveBeenCalled();
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each(["usage", "bound", "output"])(
  "returns a blocked preparation for %s without altering stored evidence",
  (kind) => {
    if (kind === "usage") delete raw.response.usage;
    if (kind === "bound")
      raw.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "output") raw.response.output = [];
    const identity = save(),
      before = inspectQualityDatabase(db);
    expect(store.providerPrepareGenerationValidation(identity)).toMatchObject({
      status: "refused",
      reason:
        kind === "usage"
          ? "usage-unknown"
          : kind === "bound"
            ? "budget-bound-breached"
            : "output-invalid",
      plan: null,
    });
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("requires a preserved response before deriving review", () => {
  const before = inspectQualityDatabase(db);
  expect(
    store.providerPrepareGenerationValidation({
      dispatch: raw.dispatch,
      responseRequestId: raw.responseRequestId,
      responseEventDigest: "0".repeat(64),
      validationRequestId: randomUUID(),
    }),
  ).toMatchObject({ status: "refused", reason: "generation-response-required" });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("does not reopen a stopped run even after its late response was preserved", () => {
  appendUnobservedGenerationStop(
    db,
    store.providerGet(raw.dispatch.runId) as ProviderExecutionSnapshot,
  );
  const identity = save(),
    before = inspectQualityDatabase(db);
  expect(store.providerPrepareGenerationValidation(identity)).toMatchObject({
    status: "refused",
    reason: "execution-stopped",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("audits the original approval binding before reading generation output", () => {
  const identity = save(),
    name = "quality_provider_transmission_bindings_no_delete";
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  db.exec("DELETE FROM quality_provider_transmission_bindings");
  db.exec(sql);
  expect(() => store.providerPrepareGenerationValidation(identity)).toThrow();
});
