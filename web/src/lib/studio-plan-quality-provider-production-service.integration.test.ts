import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External/customer access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import { ProviderProductionExecutionService } from "./studio-plan-quality-provider-production-service";
import {
  providerProductionViewSchema,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";
import { projectProviderProductionView } from "./studio-plan-quality-provider-production-view";
import { providerInitialProductionIdentity } from "./studio-plan-quality-provider-production-identity";
import {
  createProviderProductionRuntime,
  revokeProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";

let directory: string, store: PlanQualityStore, identity: ProviderGenerationDispatchIdentity;
let runtime: ProviderProductionRuntime, service: ProviderProductionExecutionService;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const key = "sk-synthetic-production-service-test-only";
const secret = "PRIVATE_CAPTURE_OR_SDK_ERROR_DO_NOT_RETURN";
const network = vi.fn<typeof fetch>();
const file = () => join(directory, "quality-evaluation", "quality.sqlite");
const selection = () => ({
  runId: identity.runId,
  runDigest: identity.runDigest,
  approvalBindingDigest: identity.approvalBindingDigest,
});
const response = (raw: typeof generationRaw) => Response.json(raw);
function reopen(production = true) {
  store.close();
  store = new PlanQualityStore(directory, production ? { providerProductionRuntime: runtime } : {});
  service = new ProviderProductionExecutionService(store);
}
function safe(view: ProviderProductionView) {
  expect(providerProductionViewSchema.safeParse(view).success).toBe(true);
  const serialized = JSON.stringify(view);
  for (const text of [
    key,
    secret,
    "pendingCapture",
    "snapshot",
    "preparedRequestId",
    "dispatchRequestId",
    "output_text",
    "api.openai.com",
    "finalArtifact",
    "requestDigest",
  ])
    expect(serialized).not.toContain(text);
  expect(view.automaticRetryAllowed).toBe(false);
  return view;
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubGlobal("fetch", network);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  network.mockReset();
  network.mockImplementation(async () =>
    response(network.mock.calls.length === 1 ? generationRaw : reviewRaw),
  );
  directory = mkdtempSync(join(tmpdir(), "venture-production-service-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  identity = generationDispatchStoreFixture(store);
  generationRaw = generationResponseFixture(identity).response;
  generationRaw.output = [
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
  reviewRaw = { ...generationResponseFixture(identity).response, id: "synthetic-review-response" };
  setReviewValidationOutput(reviewRaw);
  runtime = createProviderProductionRuntime();
  reopen();
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  revokeProviderProductionRuntime(runtime);
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-production-service-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("resolves a stable initial identity read-only, keeps the default store closed and rejects browser nonce/config substitutions", async () => {
  const bytes = readFileSync(file()),
    expected = providerInitialProductionIdentity(selection());
  expect(store.providerResolveProductionIdentity(selection())).toEqual(expected);
  expect(store.providerResolveProductionIdentity(selection())).toEqual(expected);
  expect(readFileSync(file())).toEqual(bytes);
  const execute = vi.spyOn(store, "providerRunApprovedProduction");
  for (const field of [
    "preparedRequestId",
    "dispatchRequestId",
    "apiKey",
    "response",
    "runtime",
    "model",
    "fetch",
    "expectedRevision",
  ])
    expect(safe(await service.execute({ ...selection(), [field]: secret })).reason).toBe(
      "invalid-selection",
    );
  expect(execute).not.toHaveBeenCalled();
  expect(safe(await service.execute({ ...selection(), runDigest: "0".repeat(64) })).reason).toBe(
    "execution-unavailable",
  );
  expect(() =>
    store.providerResolveProductionIdentity({
      ...selection(),
      approvalBindingDigest: "0".repeat(64),
    }),
  ).toThrow();
  expect(() =>
    store.providerResolveProductionIdentity({ ...selection(), runId: randomUUID() }),
  ).toThrow();
  reopen(false);
  expect(store.providerResolveProductionIdentity(selection())).toEqual(expected);
  expect(safe(await service.execute(selection())).reason).toBe("execution-unavailable");
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).not.toHaveBeenCalled();
}, 25000);

it("rejects an occupied initial nonce without replacing it or changing any approval/budget", () => {
  const expected = providerInitialProductionIdentity(selection());
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.providerBudgetConfigure({
    clientRequestId: expected.preparedRequestId,
    expectedRevision: 0,
    policy: {
      environment: "synthetic-test",
      provenance: "synthetic-test",
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
    },
  });
  const bytes = readFileSync(file());
  expect(() => store.providerResolveProductionIdentity(selection())).toThrow();
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).not.toHaveBeenCalled();
}, 25000);

it("uses persisted arbitrary original nonces after completion, even after runtime revocation and expiry", async () => {
  expect(await store.providerRunApprovedProduction(identity)).toMatchObject({
    executionCompleted: true,
  });
  expect(store.providerResolveProductionIdentity(selection())).toEqual(identity);
  expect(providerInitialProductionIdentity(selection())).not.toEqual(identity);
  const bytes = readFileSync(file());
  revokeProviderProductionRuntime(runtime);
  vi.setSystemTime("2035-01-01T00:00:00Z");
  const replay = safe(await service.execute(selection()));
  expect(replay).toMatchObject({
    status: "completed",
    executionCompleted: true,
    generation: { lastConfirmed: "validated" },
    review: { lastConfirmed: "completed" },
    lastAuditedRevision: 10,
  });
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("runs a new selection through the service and requires confirmed finalization rather than an r10 snapshot or status string", async () => {
  const execute = vi.spyOn(store, "providerRunApprovedProduction");
  expect(safe(await service.execute(selection()))).toMatchObject({
    status: "completed",
    executionCompleted: true,
  });
  const internal = await execute.mock.results[0].value;
  expect(internal.review.finalization).toBeTruthy();
  const incomplete = {
    ...internal,
    review: {
      ...internal.review,
      finalization: null,
      failure: { stage: "finalization", reason: secret },
    },
  };
  expect(safe(projectProviderProductionView(selection(), incomplete))).toMatchObject({
    status: "last-confirmed",
    executionCompleted: false,
    lastAuditedRevision: 10,
    review: { lastConfirmed: "validated", failureStage: "finalization" },
  });
  expect(() =>
    projectProviderProductionView({ ...selection(), runId: randomUUID() }, internal),
  ).toThrow();
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it.each(["generation", "review"])(
  "keeps failed %s persistence private, recovers the identical capture without SDK or automatic review start",
  async (phase) => {
    const method = phase === "generation" ? "recordResponse" : "recordReviewResponse";
    const fault = vi
      .spyOn(ProviderGenerationDispatchStore.prototype, method)
      .mockImplementation(() => {
        throw Error(secret);
      });
    const first = safe(await service.execute(selection()));
    expect(first).toMatchObject({
      status: "capture-recovery-required",
      recovery: "server-capture",
      executionCompleted: false,
    });
    expect(first[phase === "generation" ? "generation" : "review"]?.response).toBe(
      "captured-not-confirmed",
    );
    const bytes = readFileSync(file()),
      calls = phase === "generation" ? 1 : 2;
    expect(safe(await service.execute(selection()))).toEqual(first);
    expect(safe(service.recover({ ...selection(), response: secret })).reason).toBe(
      "invalid-selection",
    );
    const recoverMethod =
      phase === "generation"
        ? "providerRecoverProductionGenerationCapture"
        : "providerRecoverProductionReviewCapture";
    const recoveryFailure = vi.spyOn(store, recoverMethod).mockImplementation(() => {
      throw Error(secret);
    });
    expect(safe(service.recover(selection()))).toMatchObject({
      status: "capture-recovery-required",
      reason: "capture-recovery-unconfirmed",
    });
    recoveryFailure.mockRestore();
    fault.mockRestore();
    expect(readFileSync(file())).toEqual(bytes);
    revokeProviderProductionRuntime(runtime);
    const recovered = safe(service.recover(selection()));
    expect(recovered).toMatchObject({
      status: phase === "generation" ? "last-confirmed" : "completed",
      executionCompleted: phase === "review",
    });
    if (phase === "generation")
      expect(recovered).toMatchObject({ generation: { lastConfirmed: "validated" }, review: null });
    expect(safe(service.recover(selection())).reason).toBe("capture-not-retained");
    expect(network).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(service)).toBe("{}");
  },
  25000,
);

it("preserves the dispatch hold after process memory loss; a new service never resends lost capture", async () => {
  const fault = vi
    .spyOn(ProviderGenerationDispatchStore.prototype, "recordResponse")
    .mockImplementation(() => {
      throw Error(secret);
    });
  expect(safe(await service.execute(selection())).status).toBe("capture-recovery-required");
  fault.mockRestore();
  const budget = store.providerBudgetGet("production"),
    bytes = readFileSync(file());
  reopen();
  expect(safe(service.recover(selection())).reason).toBe("capture-not-retained");
  expect(safe(await service.execute(selection()))).toMatchObject({
    status: "last-confirmed",
    generation: { lastConfirmed: "dispatch-recorded", response: "unobserved", stopOutcome: null },
    lastAuditedBudget: "unsettled",
    recovery: "reconcile-before-continuing",
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);

it.each([3, 7])(
  "reuses the original r%i COMMIT after ACK loss and leaves unobserved ownership/holds untouched",
  async (target) => {
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      const result = original.call(this, sql);
      if (
        sql === "COMMIT" &&
        !injected &&
        this.prepare(
          "SELECT MAX(revision) AS revision FROM quality_actual_events WHERE run_id=?",
        ).get(identity.runId)?.revision === target
      ) {
        injected = true;
        throw Error(secret);
      }
      return result;
    });
    const first = safe(await service.execute(selection()));
    expect(injected).toBe(true);
    expect(first).toMatchObject({
      status: "last-confirmed",
      executionCompleted: false,
      lastAuditedRevision: target,
      recovery: "reconcile-before-continuing",
    });
    const originalIdentity = store.providerResolveProductionIdentity(selection());
    const bytes = readFileSync(file()),
      budget = store.providerBudgetGet("production");
    expect(safe(await service.execute(selection()))).toEqual(first);
    expect(store.providerResolveProductionIdentity(selection())).toEqual(originalIdentity);
    expect(readFileSync(file())).toEqual(bytes);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(network).toHaveBeenCalledTimes(target === 3 ? 0 : 1);
  },
  25000,
);

it("a busy service and another service cannot steal an in-flight owner's send or stop it", async () => {
  let started!: () => void, finish!: (response: Response) => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  network.mockImplementation(async () => {
    if (network.mock.calls.length !== 1) return response(reviewRaw);
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const owner = service.execute(selection());
  await began;
  try {
    const bytes = readFileSync(file());
    expect(safe(await service.execute(selection())).reason).toBe("execution-in-progress");
    const other = new ProviderProductionExecutionService(store);
    expect(safe(await other.execute(selection()))).toMatchObject({
      status: "last-confirmed",
      generation: { lastConfirmed: "dispatch-recorded", stopOutcome: null },
    });
    expect(readFileSync(file())).toEqual(bytes);
    expect(network).toHaveBeenCalledTimes(1);
  } finally {
    finish(response(generationRaw));
  }
  expect(safe(await owner).status).toBe("completed");
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("does not call the network or alter r1 when the runtime has been revoked", async () => {
  const bytes = readFileSync(file());
  revokeProviderProductionRuntime(runtime);
  expect(safe(await service.execute(selection()))).toMatchObject({
    status: "last-confirmed",
    generation: { lastConfirmed: "approved", response: "not-observed" },
    executionCompleted: false,
  });
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).not.toHaveBeenCalled();
});

it("exposes a confirmed cost-review stop while preserving unsettled usage", async () => {
  generationRaw.usage = null;
  const result = safe(await service.execute(selection()));
  expect(result).toMatchObject({
    status: "stopped",
    generation: {
      lastConfirmed: "stopped",
      response: "recorded",
      stopOutcome: "needs-cost-review",
    },
    lastAuditedBudget: "unsettled",
    recovery: "reconcile-before-continuing",
    executionCompleted: false,
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);
