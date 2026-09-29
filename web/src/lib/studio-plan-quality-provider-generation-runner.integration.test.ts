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
import {
  providerGenerationRunnerNonces,
  recoverQualityProviderGenerationCapture,
  runQualityProviderGenerationSimulation,
} from "./studio-plan-quality-provider-generation-runner";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as engine from "./studio-engine";

let directory: string, store: PlanQualityStore, identity: ProviderGenerationDispatchIdentity;
let raw: ReturnType<typeof generationResponseFixture>["response"];
const network = vi.fn<typeof fetch>();
const options = () => ({
  providerEnvironment: "synthetic-test" as const,
  providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: network },
});
const response = () => Response.json(raw, { headers: { "x-request-id": "synthetic-request" } });
const execute = (command: unknown = identity) =>
  runQualityProviderGenerationSimulation(store, command);
const capture = () => ({
  dispatch: identity,
  responseRequestId: providerGenerationRunnerNonces(identity).responseRequestId,
  response: raw,
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  network.mockReset();
  network.mockImplementation(async () => response());
  directory = mkdtempSync(join(tmpdir(), "venture-generation-runner-"));
  store = new PlanQualityStore(directory, options());
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  identity = generationDispatchStoreFixture(store);
  raw = generationResponseFixture(identity).response;
  raw.output = [
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
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(forbidden).not.toHaveBeenCalled();
  const path = relative(resolve(tmpdir()), resolve(directory));
  if (!path.startsWith("venture-generation-runner-") || path.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("settles the captured generation before validating r5; restart replays original evidence without today's validator", async () => {
  const initial = await execute();
  expect(initial).toMatchObject({
    status: "generation-validated",
    snapshot: { revision: 5, terminal: false },
    response: { responsePersisted: true, usageAssessment: { status: "known" } },
    validation: { revision: 5 },
    pendingCapture: null,
    failure: null,
    executionCompleted: false,
    reviewStarted: false,
    automaticRetryAllowed: false,
  });
  expect(initial.response?.usageBudgetEventDigest).toBeTruthy();
  expect(network).toHaveBeenCalledTimes(1);
  const budget = store.providerBudgetGet("production");
  store.close();
  store = new PlanQualityStore(directory, options());
  vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
  const validate = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
    throw Error("Changed validator must not run");
  });
  const repeat = await execute();
  expect(repeat).toMatchObject({
    status: "generation-validated",
    replayed: true,
    validation: initial.validation,
    response: initial.response,
  });
  expect(repeat.snapshot).toEqual(initial.snapshot);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(validate).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it.each([
  ["unknown", "needs-cost-review"],
  ["bound", "bound-breached"],
  ["invalid", "output-invalid"],
] as const)(
  "persists %s evidence and cost before the corresponding stop",
  async (kind, outcome) => {
    if (kind === "unknown") delete raw.usage;
    if (kind === "bound")
      raw.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "invalid") raw.output = [];
    const result = await execute();
    expect(result).toMatchObject({
      status: "generation-stopped",
      snapshot: { revision: 5, terminal: true },
      response: { responsePersisted: true },
      stop: { outcome, revision: 5 },
      validation: null,
      pendingCapture: null,
    });
    if (kind === "unknown") {
      expect(result.response?.usageBudgetEventDigest).toBeNull();
      expect(BigInt(result.stop!.generationHeldUnitsAtStop)).toBeGreaterThan(BigInt(0));
    } else expect(result.response?.usageBudgetEventDigest).toBeTruthy();
    expect(BigInt(result.stop!.reviewReleasedUnits)).toBeGreaterThan(BigInt(0));
    const validate = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
      throw Error("Historical stop cannot be reclassified");
    });
    const repeat = await execute();
    expect(repeat.stop).toEqual(result.stop);
    expect(repeat.response).toEqual(result.response);
    expect(validate).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
  },
  20000,
);

it("preserves the unobserved generation hold on network failure and settles a late capture without changing the historical stop", async () => {
  network.mockRejectedValue(Error("synthetic connection loss"));
  const first = await execute();
  expect(first).toMatchObject({
    status: "generation-stopped",
    snapshot: { revision: 4 },
    stop: { outcome: "result-unobserved" },
    transport: { fetchStarted: true, delivery: "send-result-unobserved" },
    response: null,
  });
  expect(BigInt(first.stop!.generationHeldUnitsAtStop)).toBeGreaterThan(BigInt(0));
  const recovered = recoverQualityProviderGenerationCapture(store, capture());
  expect(recovered).toMatchObject({
    status: "generation-stopped",
    snapshot: { revision: 5, terminal: true },
    response: { responsePersisted: true },
    stop: first.stop,
    validation: null,
  });
  expect(recovered.response?.usageBudgetEventDigest).toBeTruthy();
  const repeat = await execute();
  expect(repeat.stop).toEqual(first.stop);
  expect(repeat.response).toEqual(recovered.response);
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it("does not stop or resend a concurrent historical r3 while the owning request is in flight", async () => {
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
  const repeat = await execute();
  expect(repeat).toMatchObject({
    status: "last-confirmed",
    replayed: true,
    snapshot: { revision: 3 },
    stop: null,
    failure: { reason: "outcome-unobserved" },
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  finish(response());
  expect((await owner).status).toBe("generation-validated");
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it("retains the response even when the final read COMMIT fails after SDK fetch starts", async () => {
  const original = DatabaseSync.prototype.exec;
  let count = 0;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    const value = original.call(this, sql);
    if (sql === "COMMIT" && ++count === 2)
      throw Error("synthetic final COMMIT acknowledgement loss");
    return value;
  });
  expect(await execute()).toMatchObject({
    status: "generation-validated",
    transport: { finalCheckFailedAfterStart: true },
    response: { responsePersisted: true },
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it.each(["dispatch", "response", "validation", "stop"] as const)(
  "recovers %s acknowledgement loss using the exact original nonce",
  async (stage) => {
    if (stage === "dispatch") {
      const original = DatabaseSync.prototype.exec;
      let first = true;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        const value = original.call(this, sql);
        if (sql === "COMMIT" && first) {
          first = false;
          throw Error("acknowledgement lost");
        }
        return value;
      });
    } else if (stage === "response") {
      const original = store.providerRecordGenerationResponse.bind(store);
      vi.spyOn(store, "providerRecordGenerationResponse").mockImplementation((input) => {
        original(input);
        throw Error("acknowledgement lost");
      });
    } else if (stage === "validation") {
      const original = store.providerRecordGenerationValidation.bind(store);
      vi.spyOn(store, "providerRecordGenerationValidation").mockImplementation((input) => {
        original(input);
        throw Error("acknowledgement lost");
      });
    } else {
      raw.output = [];
      const original = store.providerRecordGenerationStop.bind(store);
      vi.spyOn(store, "providerRecordGenerationStop").mockImplementation((input) => {
        original(input);
        throw Error("acknowledgement lost");
      });
    }
    const result = await execute();
    expect(result.recoveredStages).toContain(stage);
    expect(result.status).toBe(
      stage === "dispatch"
        ? "last-confirmed"
        : stage === "stop"
          ? "generation-stopped"
          : "generation-validated",
    );
    expect(network).toHaveBeenCalledTimes(stage === "dispatch" ? 0 : 1);
    if (stage === "dispatch")
      expect(result).toMatchObject({ snapshot: { revision: 3 }, stop: null });
  },
  20000,
);

it.each([false, true])(
  "retains the exact raw capture when persistence %s and lookup both fail; recovery never invokes SDK",
  async (committed) => {
    const original = store.providerRecordGenerationResponse.bind(store);
    const write = vi
      .spyOn(store, "providerRecordGenerationResponse")
      .mockImplementation((input) => {
        if (committed) original(input);
        throw Error("storage unavailable");
      });
    const read = vi.spyOn(store, "providerGenerationResponseLookup").mockImplementation(() => {
      throw Error("lookup unavailable");
    });
    const result = await execute();
    expect(result).toMatchObject({
      status: "last-confirmed",
      failure: { stage: "response", reason: "persistence-unconfirmed" },
      response: null,
      validation: null,
      stop: null,
      pendingCapture: capture(),
    });
    expect(Object.isFrozen(result.pendingCapture?.response)).toBe(true);
    write.mockRestore();
    read.mockRestore();
    store.close();
    store = new PlanQualityStore(directory, options());
    const recovered = recoverQualityProviderGenerationCapture(store, result.pendingCapture);
    expect(recovered).toMatchObject({
      status: "generation-validated",
      pendingCapture: null,
      response: { responsePersisted: true },
    });
    expect(network).toHaveBeenCalledTimes(1);
  },
  20000,
);

it("rejects a different raw response or recovery nonce without replacing the original capture or sending", async () => {
  const first = await execute();
  const budget = store.providerBudgetGet("production");
  const changed = capture();
  changed.response = { ...raw, id: "different-response" };
  expect(recoverQualityProviderGenerationCapture(store, changed)).toMatchObject({
    status: "last-confirmed",
    failure: { stage: "response" },
    pendingCapture: changed,
  });
  expect(
    recoverQualityProviderGenerationCapture(store, {
      ...capture(),
      responseRequestId: randomUUID(),
    }),
  ).toMatchObject({ failure: { reason: "recovery-nonce-conflict" } });
  expect(store.providerGet(identity.runId)).toEqual(first.snapshot);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it("keeps r4 evidence and all remaining holds when the current validation contract changes", async () => {
  const base = engine.getPlanExecutionContract();
  vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
    ...base,
    contractDigest: "a".repeat(64),
  });
  const result = await execute();
  expect(result).toMatchObject({
    status: "last-confirmed",
    snapshot: { revision: 4, terminal: false },
    response: { responsePersisted: true },
    stop: null,
    failure: { stage: "validation", reason: "validation-contract-changed" },
  });
  expect(result.response?.usageBudgetEventDigest).toBeTruthy();
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it.each(["validation", "stop"] as const)(
  "does not invent a terminal state when %s persistence fails before commit",
  async (stage) => {
    const method =
      stage === "validation"
        ? "providerRecordGenerationValidation"
        : "providerRecordGenerationStop";
    if (stage === "stop") raw.output = [];
    const blocked = vi.spyOn(store, method).mockImplementation(() => {
      throw Error("before commit");
    });
    const result = await execute();
    expect(result).toMatchObject({
      status: "last-confirmed",
      snapshot: { revision: 4, terminal: false },
      response: { responsePersisted: true },
      stop: null,
      validation: null,
      failure: { stage, reason: "persistence-unconfirmed" },
    });
    blocked.mockRestore();
    const repeat = await execute();
    expect(repeat.status).toBe(
      stage === "validation" ? "generation-validated" : "generation-stopped",
    );
    expect(network).toHaveBeenCalledTimes(1);
  },
  20000,
);

it("preserves r1 and its reservations on expired approval; execution commands cannot carry overrides", async () => {
  const budget = store.providerBudgetGet("production");
  for (const override of [
    { fetch: network },
    { model: "another-model" },
    { responseRequestId: randomUUID() },
  ])
    await expect(execute({ ...identity, ...override })).rejects.toThrow();
  vi.setSystemTime(new Date("2035-01-01T00:00:00Z"));
  expect(await execute()).toMatchObject({
    status: "last-confirmed",
    snapshot: { revision: 1 },
    stop: null,
    failure: { stage: "dispatch" },
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).not.toHaveBeenCalled();
}, 15000);

it("keeps the default production gate closed", async () => {
  const before = store.providerGet(identity.runId);
  store.close();
  store = new PlanQualityStore(directory);
  expect(await execute()).toMatchObject({
    status: "last-confirmed",
    snapshot: before,
    failure: { stage: "dispatch" },
  });
  expect(network).not.toHaveBeenCalled();
});

it("preserves a captured response when its server nonce is occupied by another operation", async () => {
  const nonce = providerGenerationRunnerNonces(identity).responseRequestId;
  store.providerBudgetConfigure({
    clientRequestId: nonce,
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
    status: "last-confirmed",
    snapshot: { revision: 3 },
    pendingCapture: { responseRequestId: nonce, response: raw },
    failure: { stage: "response", reason: "persistence-unconfirmed" },
    validation: null,
    stop: null,
  });
  expect(network).toHaveBeenCalledTimes(1);
  const budget = store.providerBudgetGet("production");
  expect((await execute()).status).toBe("last-confirmed");
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(1);
}, 20000);

it.each(["response", "validation"] as const)(
  "does not adopt a historical %s recorded under another stage nonce",
  async (stage) => {
    await store.providerSimulateGenerationDispatch(identity, {
      provenance: "synthetic-test",
      send: async () => undefined,
    });
    const input = capture();
    if (stage === "response") input.responseRequestId = randomUUID();
    const record = store.providerRecordGenerationResponse(input).record;
    if (stage === "validation")
      store.providerRecordGenerationValidation({
        dispatch: identity,
        responseRequestId: input.responseRequestId,
        responseEventDigest: record.responseEventDigest,
        validationRequestId: randomUUID(),
      });
    const before = store.providerGet(identity.runId);
    const budget = store.providerBudgetGet("production");
    expect(await execute()).toMatchObject({
      status: "last-confirmed",
      failure: { stage: "history", reason: "evidence-unconfirmed" },
      validation: null,
      stop: null,
    });
    expect(store.providerGet(identity.runId)).toEqual(before);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(network).not.toHaveBeenCalled();
  },
  20000,
);

it("uses stable distinct server nonces for the full original identity independent of object key order", () => {
  const nonces = providerGenerationRunnerNonces(identity);
  expect(new Set(Object.values(nonces)).size).toBe(4);
  for (const value of Object.values(nonces))
    expect(value).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(
    providerGenerationRunnerNonces(Object.fromEntries(Object.entries(identity).reverse())),
  ).toEqual(nonces);
  for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
    const value = key.endsWith("Digest") ? "f".repeat(64) : randomUUID();
    expect(providerGenerationRunnerNonces({ ...identity, [key]: value })).not.toEqual(nonces);
  }
});
