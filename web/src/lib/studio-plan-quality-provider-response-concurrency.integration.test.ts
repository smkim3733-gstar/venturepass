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
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import type { ProviderGenerationResponseResult } from "./studio-plan-quality-provider-generation-response";
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
  inputResponse: ReturnType<typeof generationResponseFixture>;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderGenerationResponseResult;
  code?: string;
  transportCalls: number;
  crashed?: number;
};
type Input = {
  operation?: string;
  request?: unknown;
  review?: unknown;
  crashAfterResponseInsert?: number;
  crashBeforeResponseCommit?: boolean;
  crashAfterResponseCommit?: boolean;
};
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-response-race-"));
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
  if (!rel.startsWith("venture-response-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: Input) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      operation: "provider-generation-response",
      request: inputResponse,
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
    const error = new Error(`Response worker timeout: ${stderr}`);
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
        (input.crashAfterResponseCommit && code === 85) ||
        (input.crashBeforeResponseCommit && code === 86) ||
        (input.crashAfterResponseInsert && code === 87)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: 0, crashed: code! });
      }
      if (!received) {
        const error = new Error(`Response worker exited ${code}: ${stderr}`);
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
it("two processes preserve one response and recognize cost exactly once", async () => {
  const before = store.providerBudgetGet("production"),
    results = await race([{}, {}]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((r) => r.result?.replayed)).toHaveLength(1);
  expect(results[0].result?.record).toEqual(results[1].result?.record);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  expect(store.providerBudgetGet("production").revision).toBe(before.revision + 1);
  expect(store.providerGet(inputResponse.dispatch.runId)).toMatchObject({
    revision: 4,
    responseCount: 1,
    dispatchIntentCount: 1,
  });
}, 45000);
it.each(["nonce", "body"])(
  "rejects competing response %s without overwriting or double charging",
  async (kind) => {
    const other = structuredClone(inputResponse);
    if (kind === "nonce") other.responseRequestId = randomUUID();
    else other.response.output = ["different response"];
    const before = store.providerBudgetGet("production"),
      results = await race([{}, { request: other }]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.code).toBe("QUALITY_PROVIDER_DISPATCH_RESPONSE_CONFLICT");
    expect(store.providerBudgetGet("production").revision).toBe(before.revision + 1);
    expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  },
  45000,
);
it("preserves the response when racing a policy replacement", async () => {
  const policy = policyAdoptionFixture(store, 0);
  const results = await race([
    {},
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results[0].ok).toBe(true);
  // The replacement may lose its budget CAS when settlement commits first; response must not.
  expect(store.providerGenerationResponseLookup(inputResponse).state).toBe("committed");
  expect((await race([{}]))[0].result?.replayed).toBe(true);
  expect(store.providerGet(inputResponse.dispatch.runId)).toMatchObject({
    responseCount: 1,
    dispatchIntentCount: 1,
  });
}, 45000);
it.each([1, 2, 3, 4, "before", "after"] as const)(
  "recovers after process death at %s without duplicate settlement or sending",
  async (point) => {
    const before = store.providerBudgetGet("production"),
      persisted = point === "after";
    const crashed = await race([
      {
        crashAfterResponseInsert: typeof point === "number" ? point : undefined,
        crashBeforeResponseCommit: point === "before",
        crashAfterResponseCommit: persisted,
      },
    ]);
    expect(crashed[0].crashed).toBe(typeof point === "number" ? 87 : persisted ? 85 : 86);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerGet(inputResponse.dispatch.runId).revision).toBe(persisted ? 4 : 3);
    expect(store.providerBudgetGet("production").revision).toBe(
      before.revision + (persisted ? 1 : 0),
    );
    expect(store.providerGenerationResponseLookup(inputResponse).state).toBe(
      persisted ? "committed" : "not-observed",
    );
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const retry = await race([{}]);
    expect(retry[0].ok).toBe(true);
    expect(retry[0].result?.replayed).toBe(persisted);
    expect(retry[0].transportCalls).toBe(0);
    expect(store.providerBudgetGet("production").revision).toBe(before.revision + 1);
    expect(store.providerGet(inputResponse.dispatch.runId)).toMatchObject({
      responseCount: 1,
      dispatchIntentCount: 1,
    });
  },
  45000,
);
it("unknown usage survives process restart and concurrent duplicate capture with all holds intact", async () => {
  delete inputResponse.response.usage;
  const before = store.providerBudgetGet("production"),
    results = await race([{}, {}]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
  expect(results[0].result?.record.usageBudgetEventDigest).toBeNull();
  expect(store.providerBudgetGet("production")).toEqual(before);
}, 45000);
