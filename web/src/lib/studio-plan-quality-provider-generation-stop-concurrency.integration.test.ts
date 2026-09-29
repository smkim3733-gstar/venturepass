/** Actual child processes, isolated synthetic DB, mock-send marker only; no SDK/network. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import type { ProviderGenerationStopCommitResult } from "./studio-plan-quality-provider-generation-stop";
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
let identity: import("./studio-plan-quality-provider-generation-stop").ProviderGenerationStopIdentity;
let directory: string,
  store: PlanQualityStore,
  inputResponse: ReturnType<typeof generationResponseFixture>;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderGenerationStopCommitResult;
  code?: string;
  transportCalls: number;
  crashed?: number;
};
type Input = {
  operation?: string;
  request?: unknown;
  review?: unknown;
  crashAfterStopInsert?: number;
  crashBeforeStopCommit?: boolean;
  crashAfterStopCommit?: boolean;
};
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-stop-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  inputResponse = generationResponseFixture(generationDispatchStoreFixture(store));
  await store.providerSimulateGenerationDispatch(inputResponse.dispatch, {
    provenance: "synthetic-test",
    send: async () => undefined,
  });
  inputResponse.response.output = [
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
  identity = {
    dispatch: inputResponse.dispatch,
    stopRequestId: randomUUID(),
    observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
}, 15000);
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill();
      await stopped;
    }
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-stop-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: Input) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      operation: "provider-generation-stop",
      request: identity,
      ...input,
      directory,
      clock: new Date().toISOString(),
    }),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^OPENAI_|^VENTURE_DATA_DIR$/i.test(key)) delete env[key];
  const child = fork(workerPath, [file], { execArgv: [], env, windowsHide: true, silent: true });
  children.push(child);
  let stderr = "",
    received = false;
  child.stderr?.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-1000);
  });
  let readyYes!: () => void,
    readyNo!: (error: Error) => void,
    resultYes!: (value: Result) => void,
    resultNo!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => {
    readyYes = yes;
    readyNo = no;
  });
  const result = new Promise<Result>((yes, no) => {
    resultYes = yes;
    resultNo = no;
  });
  void ready.catch(() => undefined);
  void result.catch(() => undefined);
  const timer = setTimeout(() => {
    const error = new Error(`Stop worker timeout: ${stderr}`);
    readyNo(error);
    resultNo(error);
    child.kill();
  }, 30000);
  child.on("message", (message) => {
    const value = message as Result & { kind: string };
    if (value.kind === "ready") readyYes();
    if (value.kind === "result") {
      received = true;
      resultYes(value);
    }
  });
  const exited = new Promise<void>((done) =>
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (
        (input.crashAfterStopCommit && code === 105) ||
        (input.crashBeforeStopCommit && code === 106) ||
        (input.crashAfterStopInsert && code === 107)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: 0, crashed: code! });
      }
      if (!received) {
        const error = new Error(`Stop worker exited ${code}: ${stderr}`);
        readyNo(error);
        resultNo(error);
      }
      done();
    }),
  );
  child.once("error", (error) => {
    clearTimeout(timer);
    readyNo(error);
    resultNo(error);
  });
  return { ready, result, exited, go: () => child.send({ kind: "go" }) };
}
async function race(inputs: Input[]) {
  const workers = inputs.map(worker);
  await Promise.all(workers.map((w) => w.ready));
  workers.forEach((w) => w.go());
  const results = await Promise.all(workers.map((w) => w.result));
  await Promise.all(workers.map((w) => w.exited));
  return results;
}
function capture(invalid = false) {
  if (invalid) inputResponse.response.output = [];
  const response = store.providerRecordGenerationResponse(inputResponse).record;
  identity.observation = {
    kind: "response",
    responseRequestId: inputResponse.responseRequestId,
    responseEventDigest: response.responseEventDigest,
  };
}
it("two processes stop once and return identical release evidence", async () => {
  const results = await race([{}, {}]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((r) => r.result?.replayed)).toHaveLength(1);
  expect(results[0].result?.record).toEqual(results[1].result?.record);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  expect(store.providerGet(identity.dispatch.runId)).toMatchObject({
    revision: 4,
    state: "result-unobserved",
    terminal: true,
    responseCount: 0,
    dispatchIntentCount: 1,
  });
  const budget = store.providerBudgetGet("production");
  expect((await race([{}]))[0].result?.replayed).toBe(true);
  expect(store.providerBudgetGet("production")).toEqual(budget);
}, 45000);
it("rejects the losing stop nonce and preserves exactly one terminal result", async () => {
  const other = { ...identity, stopRequestId: randomUUID() },
    results = await race([{}, { request: other }]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.code).toBe("QUALITY_PROVIDER_DISPATCH_STOP_CONFLICT");
  const winner = results[0].ok ? identity : other;
  expect(store.providerGenerationStopLookup(winner).state).toBe("committed");
  expect(store.providerGet(identity.dispatch.runId).revision).toBe(4);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("serializes policy replacement and stop without discarding historical evidence", async () => {
  const policy = policyAdoptionFixture(store, 0);
  const results = await race([
    {},
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results[0].ok).toBe(true);
  // Releasing review changes the budget head. A policy review from before that release is stale.
  if (!results[1].ok) expect(results[1].code).toBe("QUALITY_PROVIDER_POLICY_REVIEW_NOT_CURRENT");
  const historical = store.providerGenerationStopLookup(identity),
    budget = store.providerBudgetGet("production");
  expect((await race([{}]))[0].result?.record).toEqual(historical);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it.each(["stop-first", "policy-first"])(
  "preserves the budget-head policy check in %s order",
  async (order) => {
    const policy = policyAdoptionFixture(store, 0),
      adoption = { operation: "policy-adopt", request: policy.command, review: policy.review };
    const initialHead = store.providerPolicyHead();
    const first = (await race([order === "stop-first" ? {} : adoption]))[0];
    expect(first.ok).toBe(true);
    const second = (await race([order === "stop-first" ? adoption : {}]))[0];
    if (order === "stop-first") {
      expect(second).toMatchObject({
        ok: false,
        code: "QUALITY_PROVIDER_POLICY_REVIEW_NOT_CURRENT",
      });
      expect(store.providerPolicyHead()).toEqual(initialHead);
    } else {
      expect(second.ok).toBe(true);
      expect(store.providerPolicyHead().revision).toBe(initialHead.revision + 1);
    }
    const budget = store.providerBudgetGet("production"),
      history = store.providerGenerationStopLookup(identity);
    expect(history.state).toBe("committed");
    expect(store.providerRecordGenerationStop(identity).record).toEqual(history);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect([first, second].every((r) => r.transportCalls === 0)).toBe(true);
  },
  45000,
);
it("serializes response arrival with an unobserved stop without losing the response", async () => {
  const results = await race([
    {},
    { operation: "provider-generation-response", request: inputResponse },
  ]);
  expect(results[1].ok).toBe(true);
  const snapshot = store.providerGet(identity.dispatch.runId);
  expect(snapshot).toMatchObject({ responseCount: 1, dispatchIntentCount: 1 });
  if (results[0].ok) {
    expect(snapshot).toMatchObject({ revision: 5, state: "result-unobserved", terminal: true });
    expect(store.providerGenerationStopLookup(identity)).toEqual(results[0].result?.record);
  } else {
    expect(results[0].code).toBe("QUALITY_PROVIDER_DISPATCH_STOP_OBSERVATION_CHANGED");
    expect(snapshot).toMatchObject({ revision: 4, state: "response-recorded", terminal: false });
    expect(store.providerGenerationStopLookup(identity)).toEqual({ state: "not-observed" });
  }
  expect(store.providerGenerationResponseLookup(inputResponse).state).toBe("committed");
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("replays the same stop while another process stores the late response", async () => {
  const first = store.providerRecordGenerationStop(identity).record;
  const results = await race([
    {},
    { operation: "provider-generation-response", request: inputResponse },
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results[0].result).toEqual({ record: first, replayed: true, newlyCommitted: false });
  expect(store.providerGenerationStopLookup(identity)).toEqual(first);
  expect(store.providerGet(identity.dispatch.runId)).toMatchObject({
    revision: 5,
    state: "result-unobserved",
    terminal: true,
    responseCount: 1,
  });
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it.each([false, true])(
  "allows only the evidence-compatible winner when validation races a stop, invalid=%s",
  async (invalid) => {
    capture(invalid);
    if (identity.observation.kind !== "response") throw Error("Response required");
    const validation = {
      dispatch: identity.dispatch,
      responseRequestId: identity.observation.responseRequestId,
      responseEventDigest: identity.observation.responseEventDigest,
      validationRequestId: randomUUID(),
    };
    const results = await race([
      {},
      { operation: "provider-generation-validation", request: validation },
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results[0].ok).toBe(invalid);
    expect(results[1].ok).toBe(!invalid);
    expect(store.providerGet(identity.dispatch.runId)).toMatchObject({
      revision: 5,
      state: invalid ? "output-invalid" : "validated",
      terminal: invalid,
      responseCount: 1,
      dispatchIntentCount: 1,
    });
    if (invalid) expect(store.providerGenerationStopLookup(identity).state).toBe("committed");
    else expect(store.providerGenerationValidationLookup(validation).state).toBe("committed");
    expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  },
  45000,
);
it.each([1, 2, 3, "before", "after"] as const)(
  "recovers exactly one release after process death at stop %s",
  async (point) => {
    const before = store.providerBudgetGet("production"),
      persisted = point === "after";
    const crashed = await race([
      {
        crashAfterStopInsert: typeof point === "number" ? point : undefined,
        crashBeforeStopCommit: point === "before",
        crashAfterStopCommit: persisted,
      },
    ]);
    expect(crashed[0].crashed).toBe(typeof point === "number" ? 107 : persisted ? 105 : 106);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerGet(identity.dispatch.runId).revision).toBe(persisted ? 4 : 3);
    expect(store.providerGenerationStopLookup(identity).state).toBe(
      persisted ? "committed" : "not-observed",
    );
    if (!persisted) expect(store.providerBudgetGet("production")).toEqual(before);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const retry = await race([{}]);
    expect(retry[0].ok).toBe(true);
    expect(retry[0].result?.replayed).toBe(persisted);
    const first = retry[0].result!.record;
    store.providerRecordGenerationResponse(inputResponse);
    const budget = store.providerBudgetGet("production");
    expect(store.providerRecordGenerationStop(identity).record).toEqual(first);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGet(identity.dispatch.runId)).toMatchObject({
      revision: 5,
      state: "result-unobserved",
      terminal: true,
      responseCount: 1,
      dispatchIntentCount: 1,
    });
    expect(retry[0].transportCalls).toBe(0);
  },
  45000,
);
