/** Actual child processes, isolated synthetic DB, mock-send marker only; no SDK/network. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { reviewStopStoreFixture } from "./studio-plan-quality-provider-review-stop-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import type { ProviderReviewStopCommitResult } from "./studio-plan-quality-provider-review-stop";
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
let identity: import("./studio-plan-quality-provider-review-stop").ProviderReviewStopIdentity;
let directory: string,
  store: PlanQualityStore,
  inputResponse: ReturnType<typeof reviewResponseCapture>;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderReviewStopCommitResult;
  code?: string;
  transportCalls: number;
  crashed?: number;
};
type Input = {
  operation?: string;
  request?: unknown;
  review?: unknown;
  crashAfterReviewStopInsert?: number;
  crashBeforeReviewStopCommit?: boolean;
  crashAfterReviewStopCommit?: boolean;
};
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-review-stop-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const fixture = await reviewStopStoreFixture(store);
  inputResponse = fixture.capture;
  identity = fixture.identity;
}, 20000);
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
  if (!rel.startsWith("venture-review-stop-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: Input) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      operation: "provider-review-stop",
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
    const error = new Error(`ReviewStop worker timeout: ${stderr}`);
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
        (input.crashAfterReviewStopCommit && code === 125) ||
        (input.crashBeforeReviewStopCommit && code === 126) ||
        (input.crashAfterReviewStopInsert && code === 127)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: 0, crashed: code! });
      }
      if (!received) {
        const error = new Error(`ReviewStop worker exited ${code}: ${stderr}`);
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
const id = () => identity.dispatch.generation.dispatch.runId;
function capture(invalid = false) {
  if (invalid) inputResponse.response.output = [];
  const response = store.providerRecordReviewResponse(inputResponse).record;
  identity.observation = {
    kind: "response",
    responseRequestId: inputResponse.responseRequestId,
    responseEventDigest: response.responseEventDigest,
  };
  return {
    dispatch: identity.dispatch,
    responseRequestId: inputResponse.responseRequestId,
    responseEventDigest: response.responseEventDigest,
    validationRequestId: randomUUID(),
  };
}
it.each([false, true])(
  "two processes store one stop and return identical evidence, observed=%s",
  async (observed) => {
    if (observed) capture(true);
    const budget = store.providerBudgetGet("production"),
      results = await race([{}, {}]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
    expect(results.filter((r) => r.result?.replayed)).toHaveLength(1);
    expect(results[0].result?.record).toEqual(results[1].result?.record);
    expect(results.every((r) => r.transportCalls === 0)).toBe(true);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGet(id())).toMatchObject({
      revision: observed ? 9 : 8,
      state: observed ? "output-invalid" : "result-unobserved",
      terminal: true,
      responseCount: observed ? 2 : 1,
      dispatchIntentCount: 2,
      canResume: false,
    });
    expect(store.providerReviewStopLookup(identity)).toEqual(results[0].result?.record);
  },
  45000,
);
it("rejects the losing stop nonce and keeps one terminal event", async () => {
  const other = { ...identity, stopRequestId: randomUUID() },
    budget = store.providerBudgetGet("production"),
    results = await race([{}, { request: other }]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.code).toBe("QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_CONFLICT");
  expect(store.providerReviewStopLookup(results[0].ok ? identity : other).state).toBe("committed");
  expect(store.providerGet(id()).revision).toBe(8);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("serializes policy replacement with a stop while preserving original budget and history", async () => {
  const policy = policyAdoptionFixture(store, 0),
    budget = store.providerBudgetGet("production");
  const results = await race([
    {},
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results[0].ok).toBe(true);
  if (!results[1].ok) expect(results[1].code).toBe("QUALITY_PROVIDER_POLICY_REVIEW_NOT_CURRENT");
  const history = store.providerReviewStopLookup(identity);
  expect((await race([{}]))[0].result?.record).toEqual(history);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("serializes arrival with unobserved stop without losing the review response", async () => {
  const results = await race([
    {},
    { operation: "provider-review-response", request: inputResponse },
  ]);
  expect(results[1].ok).toBe(true);
  const snapshot = store.providerGet(id());
  expect(snapshot).toMatchObject({ responseCount: 2, dispatchIntentCount: 2 });
  if (results[0].ok) {
    expect(snapshot).toMatchObject({ revision: 9, state: "result-unobserved", terminal: true });
    expect(store.providerReviewStopLookup(identity)).toEqual(results[0].result?.record);
  } else {
    expect(results[0].code).toBe("QUALITY_PROVIDER_DISPATCH_REVIEW_STOP_OBSERVATION_CHANGED");
    expect(snapshot).toMatchObject({ revision: 8, state: "response-recorded", terminal: false });
    expect(store.providerReviewStopLookup(identity)).toEqual({ state: "not-observed" });
  }
  expect(store.providerReviewResponseLookup(inputResponse).state).toBe("committed");
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("replays the original budget prefix while another process settles a late response", async () => {
  const first = store.providerRecordReviewStop(identity).record;
  const results = await race([
    {},
    { operation: "provider-review-response", request: inputResponse },
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results[0].result).toEqual({ record: first, newlyCommitted: false, replayed: true });
  expect(store.providerReviewStopLookup(identity)).toEqual(first);
  expect(store.providerGet(id())).toMatchObject({
    revision: 9,
    state: "result-unobserved",
    terminal: true,
    responseCount: 2,
  });
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it.each([false, true])(
  "permits only the evidence-compatible winner against review validation, invalid=%s",
  async (invalid) => {
    const validation = capture(invalid),
      budget = store.providerBudgetGet("production"),
      results = await race([{}, { operation: "provider-review-validation", request: validation }]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results[0].ok).toBe(invalid);
    expect(results[1].ok).toBe(!invalid);
    expect(store.providerGet(id())).toMatchObject({
      revision: 9,
      state: invalid ? "output-invalid" : "validated",
      terminal: invalid,
      responseCount: 2,
      dispatchIntentCount: 2,
    });
    if (invalid) expect(store.providerReviewStopLookup(identity).state).toBe("committed");
    else expect(store.providerReviewValidationLookup(validation).state).toBe("committed");
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  },
  45000,
);
it("cannot replace validated review with failure when finalization competes", async () => {
  const validation = capture(),
    saved = store.providerRecordReviewValidation(validation).record,
    finalization = {
      validation,
      validationEventDigest: saved.validationEventDigest,
      finalizationRequestId: randomUUID(),
    },
    budget = store.providerBudgetGet("production");
  const results = await race([{}, { operation: "provider-finalization", request: finalization }]);
  expect(results[0].ok).toBe(false);
  expect(results[1].ok).toBe(true);
  expect(store.providerGet(id())).toMatchObject({
    revision: 10,
    state: "completed",
    terminal: true,
  });
  expect(store.providerFinalizationLookup(finalization).state).toBe("committed");
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it.each([1, 2, "before", "after"] as const)(
  "recovers exactly one stop after process death at %s",
  async (point) => {
    const budget = store.providerBudgetGet("production"),
      persisted = point === "after";
    const crashed = await race([
      {
        crashAfterReviewStopInsert: typeof point === "number" ? point : undefined,
        crashBeforeReviewStopCommit: point === "before",
        crashAfterReviewStopCommit: persisted,
      },
    ]);
    expect(crashed[0].crashed).toBe(typeof point === "number" ? 127 : persisted ? 125 : 126);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerGet(id()).revision).toBe(persisted ? 8 : 7);
    expect(store.providerReviewStopLookup(identity).state).toBe(
      persisted ? "committed" : "not-observed",
    );
    expect(store.providerBudgetGet("production")).toEqual(budget);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const retry = await race([{}]);
    expect(retry[0].ok).toBe(true);
    expect(retry[0].result?.replayed).toBe(persisted);
    const first = retry[0].result!.record;
    store.providerRecordReviewResponse(inputResponse);
    const after = store.providerBudgetGet("production");
    expect(store.providerRecordReviewStop(identity).record).toEqual(first);
    expect(store.providerBudgetGet("production")).toEqual(after);
    expect(store.providerGet(id())).toMatchObject({
      revision: 9,
      state: "result-unobserved",
      terminal: true,
      responseCount: 2,
      dispatchIntentCount: 2,
    });
    expect(retry[0].transportCalls).toBe(0);
  },
  45000,
);
