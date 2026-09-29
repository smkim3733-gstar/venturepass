import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import {
  providerGenerationRunnerNonces,
  runQualityProviderGenerationSimulation,
} from "./studio-plan-quality-provider-generation-runner";
import {
  providerReviewRunnerScope,
  recoverQualityProviderReviewCapture,
  runQualityProviderApprovedSimulation,
} from "./studio-plan-quality-provider-approved-runner";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as engine from "./studio-engine";

let directory: string, store: PlanQualityStore, identity: ProviderGenerationDispatchIdentity;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const network = vi.fn<typeof fetch>();
const options = () => ({
  providerEnvironment: "synthetic-test" as const,
  providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: network },
});
const response = (raw = reviewRaw) =>
  Response.json(raw, { headers: { "x-request-id": "synthetic-request" } });
const execute = (command: unknown = identity) =>
  runQualityProviderApprovedSimulation(store, command);
async function primeGeneration() {
  const result = await runQualityProviderGenerationSimulation(store, identity);
  if (!result.validation) throw Error("Expected synthetic generation r5");
  const r = result.validation;
  return providerReviewRunnerScope({
    generation: {
      dispatch: r.dispatch,
      responseRequestId: r.responseRequestId,
      responseEventDigest: r.responseEventDigest,
      validationRequestId: r.validationRequestId,
    },
    validationEventDigest: r.validationEventDigest,
  });
}
function reviewCapture(scope: Awaited<ReturnType<typeof primeGeneration>>) {
  return {
    dispatch: scope.dispatch,
    responseRequestId: scope.nonces.responseRequestId,
    response: reviewRaw,
  };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  network.mockReset();
  network.mockImplementation(async () =>
    response(network.mock.calls.length === 1 ? generationRaw : reviewRaw),
  );
  directory = mkdtempSync(join(tmpdir(), "venture-approved-runner-"));
  store = new PlanQualityStore(directory, options());
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
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
  const path = relative(resolve(tmpdir()), resolve(directory));
  if (!path.startsWith("venture-approved-runner-") || path.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("runs two owned SDK calls through r10 and reopens the original completion without today's validator or finalizer", async () => {
  const first = await execute();
  expect(first).toMatchObject({
    generation: { status: "generation-validated", executionCompleted: false },
    review: {
      status: "completed",
      response: { responsePersisted: true },
      validation: { revision: 9, finalResultPersisted: false },
      finalization: { revision: 10, completionPersisted: true },
      snapshot: { revision: 10, state: "completed" },
      pendingCapture: null,
    },
    executionCompleted: true,
    automaticRetryAllowed: false,
  });
  expect(first.review!.response!.usageBudgetEventDigest).toBeTruthy();
  expect(network).toHaveBeenCalledTimes(2);
  const budget = store.providerBudgetGet("production"),
    artifact = store.providerArtifact(identity.runId, "final-result");
  store.close();
  store = new PlanQualityStore(directory, options());
  vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
  const contract = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
    throw Error("Historical contract must not run");
  });
  const finalize = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("Historical finalizer must not run");
  });
  const repeat = await execute();
  expect(repeat).toMatchObject({
    generation: { status: "generation-validated", validation: first.generation.validation },
    review: { status: "completed", replayed: true, finalization: first.review!.finalization },
    executionCompleted: true,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerArtifact(identity.runId, "final-result")).toEqual(artifact);
  expect(contract).not.toHaveBeenCalled();
  expect(finalize).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it.each([
  ["unknown", "needs-cost-review"],
  ["bound", "bound-breached"],
  ["invalid", "output-invalid"],
] as const)(
  "stores the %s review and its cost before stopping without releasing either dispatched phase",
  async (kind, outcome) => {
    if (kind === "unknown") delete reviewRaw.usage;
    if (kind === "bound")
      reviewRaw.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "invalid") reviewRaw.output = [];
    const first = await execute();
    expect(first).toMatchObject({
      executionCompleted: false,
      review: {
        status: "review-stopped",
        snapshot: { revision: 9, terminal: true },
        response: { responsePersisted: true },
        validation: null,
        finalization: null,
        stop: { outcome, revision: 9 },
      },
    });
    if (kind === "unknown") {
      expect(first.review!.response!.usageBudgetEventDigest).toBeNull();
      expect(BigInt(first.review!.stop!.reviewHeldUnitsAtStop)).toBeGreaterThan(BigInt(0));
    } else expect(first.review!.response!.usageBudgetEventDigest).toBeTruthy();
    expect(first.review!.stop!.generationHeldUnitsAtStop).toBe("0");
    const contract = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
      throw Error("No reclassification");
    });
    const repeat = await execute();
    expect(repeat.generation.status).toBe("generation-validated");
    expect(repeat.review!.stop).toEqual(first.review!.stop);
    expect(repeat.review!.response).toEqual(first.review!.response);
    expect(contract).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(2);
  },
  25000,
);

it("does not start review when generation stops", async () => {
  generationRaw.output = [];
  expect(await execute()).toMatchObject({
    generation: { status: "generation-stopped" },
    review: null,
    executionCompleted: false,
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 15000);

it("preserves r5 reservations when approval expires before review; no unsupported stop is invented", async () => {
  await primeGeneration();
  const budget = store.providerBudgetGet("production");
  vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
  expect(await execute()).toMatchObject({
    generation: { status: "generation-validated" },
    review: {
      status: "last-confirmed",
      snapshot: { revision: 5 },
      stop: null,
      failure: { stage: "dispatch" },
    },
    executionCompleted: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it("preserves the r7 owner during concurrent replay instead of stopping or resending", async () => {
  await primeGeneration();
  let begin!: () => void, finish!: (value: Response) => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  network.mockImplementation(() => {
    begin();
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const owner = execute();
  await started;
  const budget = store.providerBudgetGet("production");
  expect(await execute()).toMatchObject({
    review: {
      status: "last-confirmed",
      replayed: true,
      snapshot: { revision: 7 },
      failure: { reason: "outcome-unobserved" },
      stop: null,
    },
    executionCompleted: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  finish(response());
  expect((await owner).executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("captures a late review after a local network failure without reopening the original stop", async () => {
  const scope = await primeGeneration();
  network.mockRejectedValue(Error("synthetic network loss"));
  const first = await execute();
  expect(first).toMatchObject({
    review: {
      status: "review-stopped",
      snapshot: { revision: 8 },
      stop: { outcome: "result-unobserved" },
      transport: { fetchStarted: true, delivery: "send-result-unobserved" },
      response: null,
    },
    executionCompleted: false,
  });
  expect(BigInt(first.review!.stop!.reviewHeldUnitsAtStop)).toBeGreaterThan(BigInt(0));
  const recovered = recoverQualityProviderReviewCapture(store, reviewCapture(scope));
  expect(recovered).toMatchObject({
    status: "review-stopped",
    snapshot: { revision: 9, terminal: true },
    response: { responsePersisted: true, late: true },
    stop: first.review!.stop,
    validation: null,
    finalization: null,
    executionCompleted: false,
  });
  expect(recovered.response!.usageBudgetEventDigest).toBeTruthy();
  expect((await execute()).review!.stop).toEqual(first.review!.stop);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

function failReviewCommit(number: number) {
  const method = store.providerSimulateReviewSdkDispatch.bind(store);
  vi.spyOn(store, "providerSimulateReviewSdkDispatch").mockImplementation(async (input) => {
    const original = DatabaseSync.prototype.exec;
    let count = 0;
    const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const value = original.call(this, sql);
      if (sql === "COMMIT" && ++count === number)
        throw Error("synthetic COMMIT acknowledgement loss");
      return value;
    });
    try {
      return await method(input);
    } finally {
      hook.mockRestore();
    }
  });
}
it("keeps a review observation even when the final writer acknowledgement fails after fetch starts", async () => {
  failReviewCommit(2);
  expect(await execute()).toMatchObject({
    review: {
      transport: { finalCheckFailedAfterStart: true },
      response: { responsePersisted: true },
      finalization: { revision: 10 },
    },
    executionCompleted: true,
  });
  expect(network).toHaveBeenCalledTimes(2);
}, 20000);

it.each(["dispatch", "response", "validation", "finalization", "stop"] as const)(
  "recovers %s acknowledgement loss with the original review nonce",
  async (stage) => {
    if (stage === "dispatch") failReviewCommit(1);
    else {
      if (stage === "stop") reviewRaw.output = [];
      const method =
        stage === "response"
          ? "providerRecordReviewResponse"
          : stage === "validation"
            ? "providerRecordReviewValidation"
            : stage === "finalization"
              ? "providerRecordFinalization"
              : "providerRecordReviewStop";
      const original = store[method].bind(store);
      vi.spyOn(store, method).mockImplementation((input: unknown) => {
        original(input);
        throw Error("acknowledgement lost");
      });
    }
    const result = await execute();
    expect(result.review!.recoveredStages).toContain(stage);
    expect(result.review!.status).toBe(
      stage === "dispatch" ? "last-confirmed" : stage === "stop" ? "review-stopped" : "completed",
    );
    expect(result.executionCompleted).toBe(stage !== "dispatch" && stage !== "stop");
    expect(network).toHaveBeenCalledTimes(stage === "dispatch" ? 1 : 2);
    if (stage === "dispatch")
      expect(result.review).toMatchObject({ snapshot: { revision: 7 }, stop: null });
  },
  22000,
);

it.each([false, true])(
  "retains the exact raw capture when response committed=%s but both persistence return and lookup fail",
  async (committed) => {
    const scope = await primeGeneration();
    const original = store.providerRecordReviewResponse.bind(store);
    const write = vi.spyOn(store, "providerRecordReviewResponse").mockImplementation((input) => {
      if (committed) original(input);
      throw Error("storage unavailable");
    });
    const read = vi.spyOn(store, "providerReviewResponseLookup").mockImplementation(() => {
      throw Error("lookup unavailable");
    });
    const result = await execute();
    expect(result).toMatchObject({
      review: {
        status: "last-confirmed",
        response: null,
        validation: null,
        finalization: null,
        pendingCapture: reviewCapture(scope),
        failure: { stage: "response", reason: "persistence-unconfirmed" },
      },
      executionCompleted: false,
    });
    expect(Object.isFrozen(result.review!.pendingCapture!.response)).toBe(true);
    write.mockRestore();
    read.mockRestore();
    store.close();
    store = new PlanQualityStore(directory, options());
    expect(recoverQualityProviderReviewCapture(store, result.review!.pendingCapture)).toMatchObject(
      { status: "completed", pendingCapture: null, executionCompleted: true },
    );
    expect(network).toHaveBeenCalledTimes(2);
  },
  25000,
);

it.each(["validation", "finalization", "stop"] as const)(
  "preserves the last confirmed revision when %s fails before commit",
  async (stage) => {
    if (stage === "stop") reviewRaw.output = [];
    const method =
      stage === "validation"
        ? "providerRecordReviewValidation"
        : stage === "finalization"
          ? "providerRecordFinalization"
          : "providerRecordReviewStop";
    const blocked = vi.spyOn(store, method).mockImplementation(() => {
      throw Error("before commit");
    });
    const first = await execute();
    expect(first).toMatchObject({
      review: {
        status: stage === "finalization" ? "review-validated" : "last-confirmed",
        snapshot: { revision: stage === "finalization" ? 9 : 8, terminal: false },
        response: { responsePersisted: true },
        finalization: null,
        stop: null,
        failure: { stage, reason: "persistence-unconfirmed" },
      },
      executionCompleted: false,
    });
    blocked.mockRestore();
    const repeat = await execute();
    expect(repeat.review!.status).toBe(stage === "stop" ? "review-stopped" : "completed");
    expect(network).toHaveBeenCalledTimes(2);
  },
  25000,
);

it("keeps r9 separate from completion when finalization commits but its confirmation cannot be recovered", async () => {
  const original = store.providerRecordFinalization.bind(store);
  const write = vi.spyOn(store, "providerRecordFinalization").mockImplementation((input) => {
    original(input);
    throw Error("acknowledgement lost");
  });
  const lookup = store.providerFinalizationLookup.bind(store);
  let reads = 0;
  const read = vi.spyOn(store, "providerFinalizationLookup").mockImplementation((input) => {
    if (++reads > 1) throw Error("lookup unavailable");
    return lookup(input);
  });
  const first = await execute();
  expect(first).toMatchObject({
    review: {
      status: "review-validated",
      validation: { revision: 9 },
      finalization: null,
      snapshot: { revision: 10 },
      failure: { stage: "finalization", reason: "persistence-unconfirmed" },
    },
    executionCompleted: false,
  });
  write.mockRestore();
  read.mockRestore();
  const finalize = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("Do not regenerate historical final output");
  });
  expect((await execute()).executionCompleted).toBe(true);
  expect(finalize).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("preserves r8 captured costs on validation contract change after sending review", async () => {
  await primeGeneration();
  const base = engine.getPlanExecutionContract();
  network.mockImplementation(async () => {
    vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
      ...base,
      contractDigest: "a".repeat(64),
    });
    return response();
  });
  const result = await execute();
  expect(result).toMatchObject({
    review: {
      status: "last-confirmed",
      snapshot: { revision: 8, terminal: false },
      response: { responsePersisted: true },
      stop: null,
      failure: { stage: "validation", reason: "validation-contract-changed" },
    },
    executionCompleted: false,
  });
  expect(result.review!.response!.usageBudgetEventDigest).toBeTruthy();
  expect(network).toHaveBeenCalledTimes(2);
}, 20000);

it("does not turn an internal finalizer error into invalid model output or a completion", async () => {
  await primeGeneration();
  vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("synthetic internal error");
  });
  const result = await execute();
  expect(result).toMatchObject({
    review: {
      status: "last-confirmed",
      snapshot: { revision: 8, terminal: false },
      response: { responsePersisted: true },
      stop: null,
      validation: null,
      finalization: null,
      failure: { stage: "validation", reason: "finalization-unavailable" },
    },
    executionCompleted: false,
  });
  expect(network).toHaveBeenCalledTimes(2);
}, 20000);

it("preserves raw response and holds on a globally occupied review response nonce", async () => {
  const scope = await primeGeneration();
  store.providerBudgetConfigure({
    clientRequestId: scope.nonces.responseRequestId,
    expectedRevision: 0,
    policy: {
      environment: "synthetic-test",
      provenance: "synthetic-test",
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
    },
  });
  const result = await execute();
  expect(result).toMatchObject({
    review: {
      status: "last-confirmed",
      snapshot: { revision: 7 },
      response: null,
      stop: null,
      pendingCapture: reviewCapture(scope),
      failure: { stage: "response" },
    },
    executionCompleted: false,
  });
  const budget = store.providerBudgetGet("production");
  expect((await execute()).review!.status).toBe("last-confirmed");
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("rejects changed capture, phase IDs and command overrides without replacing persisted evidence", async () => {
  const scope = await primeGeneration();
  const first = await execute(),
    budget = store.providerBudgetGet("production");
  const changed = { ...reviewCapture(scope), response: { ...reviewRaw, id: "another-response" } };
  expect(recoverQualityProviderReviewCapture(store, changed)).toMatchObject({
    status: "last-confirmed",
    pendingCapture: changed,
    failure: { stage: "response" },
    executionCompleted: false,
  });
  expect(
    recoverQualityProviderReviewCapture(store, {
      ...reviewCapture(scope),
      responseRequestId: randomUUID(),
    }),
  ).toMatchObject({ failure: { reason: "recovery-nonce-conflict" } });
  expect(
    recoverQualityProviderReviewCapture(store, {
      ...reviewCapture(scope),
      dispatch: { ...scope.dispatch, dispatchRequestId: randomUUID() },
    }),
  ).toMatchObject({ failure: { reason: "recovery-nonce-conflict" } });
  for (const extra of [
    { model: "other" },
    { fetch: network },
    { finalizationRequestId: randomUUID() },
  ])
    await expect(execute({ ...identity, ...extra })).rejects.toThrow();
  expect(store.providerGet(identity.runId)).toEqual(first.review!.snapshot);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("does not adopt a finalization saved with another request nonce", async () => {
  const blocked = vi.spyOn(store, "providerRecordFinalization").mockImplementation(() => {
    throw Error("hold at r9");
  });
  const first = await execute();
  blocked.mockRestore();
  const v = first.review!.validation!;
  store.providerRecordFinalization({
    validation: {
      dispatch: v.dispatch,
      responseRequestId: v.responseRequestId,
      responseEventDigest: v.responseEventDigest,
      validationRequestId: v.validationRequestId,
    },
    validationEventDigest: v.validationEventDigest,
    finalizationRequestId: randomUUID(),
  });
  const snapshot = store.providerGet(identity.runId);
  expect(await execute()).toMatchObject({
    review: {
      status: "review-validated",
      finalization: null,
      failure: { stage: "finalization", reason: "evidence-unconfirmed" },
    },
    executionCompleted: false,
  });
  expect(store.providerGet(identity.runId)).toEqual(snapshot);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it("keeps production review writes closed and derives stable, separate server stage nonces", async () => {
  const scope = await primeGeneration();
  const g = scope.dispatch.generation;
  const command = { generation: g, validationEventDigest: scope.dispatch.validationEventDigest };
  expect(providerReviewRunnerScope(Object.fromEntries(Object.entries(command).reverse()))).toEqual(
    scope,
  );
  const nonces = [
    scope.dispatch.preparedRequestId,
    scope.dispatch.dispatchRequestId,
    ...Object.values(scope.nonces),
    ...Object.values(providerGenerationRunnerNonces(identity)),
  ];
  expect(new Set(nonces).size).toBe(11);
  expect(() =>
    providerReviewRunnerScope({
      ...command,
      generation: { ...g, responseRequestId: randomUUID() },
    }),
  ).toThrow("GENERATION_NONCE_CONFLICT");
  store.close();
  store = new PlanQualityStore(directory);
  const before = store.providerGet(identity.runId),
    budget = store.providerBudgetGet("production");
  expect(await execute()).toMatchObject({
    review: { status: "last-confirmed", snapshot: { revision: 5 }, failure: { stage: "dispatch" } },
    executionCompleted: false,
  });
  expect(store.providerGet(identity.runId)).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);
