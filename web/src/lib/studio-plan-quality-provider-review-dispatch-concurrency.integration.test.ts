/** Actual child processes, isolated synthetic DB, mock-send marker only; no SDK/network. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { reviewDispatchStoreFixture } from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import type { ProviderReviewSimulationResult } from "./studio-plan-quality-provider-dispatch-store";
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
let directory: string, store: PlanQualityStore, identity: ProviderReviewDispatchIdentity;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderReviewSimulationResult;
  code?: string;
  transportCalls: number;
  crashed?: number;
};
type Input = {
  operation?: string;
  request?: unknown;
  review?: unknown;
  crashAfterDispatchInsert?: number;
  crashBeforeDispatchCommit?: boolean;
  crashAfterDispatchCommit?: boolean;
  crashAfterDispatchSend?: boolean;
  loseDispatchResponse?: boolean;
};
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-review-dispatch-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  identity = await reviewDispatchStoreFixture(store);
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
  if (!rel.startsWith("venture-review-dispatch-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: Input) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      operation: "provider-review-dispatch",
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
    const error = new Error(`Dispatch worker timeout: ${stderr}`);
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
        (input.crashAfterDispatchCommit && code === 75) ||
        (input.crashBeforeDispatchCommit && code === 76) ||
        (input.crashAfterDispatchInsert && code === 77) ||
        (input.crashAfterDispatchSend && code === 78)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: code === 78 ? 1 : 0, crashed: code! });
      }
      if (!received) {
        const error = new Error(`Dispatch worker exited ${code}: ${stderr}`);
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
function sends() {
  const file = join(directory, "mock-sends.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}
it("two processes with the same identity produce one owner and one historical replay", async () => {
  const budget = store.providerBudgetGet("production"),
    results = await race([{}, {}]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((r) => r.result?.replayed)).toHaveLength(1);
  expect(results.reduce((n, r) => n + r.transportCalls, 0)).toBe(1);
  expect(sends()).toHaveLength(1);
  expect(store.providerGet(identity.generation.dispatch.runId)).toMatchObject({
    revision: 7,
    dispatchIntentCount: 2,
    responseCount: 1,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
}, 45000);
it("different nonces racing for the same approved run cannot create a second owner", async () => {
  const second = { ...identity, preparedRequestId: randomUUID(), dispatchRequestId: randomUUID() };
  const results = await race([{}, { request: second }]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.code).toBe("QUALITY_PROVIDER_DISPATCH_REVIEW_CONFLICT");
  expect(sends()).toHaveLength(1);
}, 45000);
it("serializes against policy replacement without sending under a superseded reference", async () => {
  const policy = policyAdoptionFixture(store, 0);
  const results = await race([
    {},
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results[1].ok).toBe(true);
  if (!results[0].ok)
    expect(results[0].code).toBe("QUALITY_PROVIDER_DISPATCH_REVIEW_POLICY_OR_BUDGET_BLOCKED");
  expect(sends().length).toBeLessThanOrEqual(1);
  const next = await race([{}]);
  expect(next[0].transportCalls).toBe(0);
  expect(sends().length).toBe(results[0].transportCalls);
}, 45000);
it.each([1, 2, 3, 4, 5, "before", "after", "sent"] as const)(
  "recovers after actual process exit at %s without duplicating a committed send",
  async (phase) => {
    const budget = store.providerBudgetGet("production"),
      persisted = phase === "after" || phase === "sent";
    const crashed = await race([
      {
        crashAfterDispatchInsert: typeof phase === "number" ? phase : undefined,
        crashBeforeDispatchCommit: phase === "before",
        crashAfterDispatchCommit: phase === "after",
        crashAfterDispatchSend: phase === "sent",
      },
    ]);
    expect(crashed[0].crashed).toBe(
      typeof phase === "number" ? 77 : phase === "before" ? 76 : phase === "after" ? 75 : 78,
    );
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerGet(identity.generation.dispatch.runId).revision).toBe(persisted ? 7 : 5);
    expect(store.providerReviewDispatchLookup(identity).state).toBe(
      persisted ? "committed" : "not-observed",
    );
    if (persisted) vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const retry = await race([{}]);
    expect(retry[0].ok).toBe(true);
    expect(retry[0].transportCalls).toBe(persisted ? 0 : 1);
    expect(sends()).toHaveLength(phase === "after" ? 0 : 1);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
  45000,
);
it("mock response loss stays held and cannot send again in a newly started process", async () => {
  const first = await race([{ loseDispatchResponse: true }]);
  expect(first[0].result?.delivery).toBe("send-result-unobserved");
  expect((await race([{}]))[0].result?.delivery).toBe("already-recorded");
  expect(sends()).toHaveLength(1);
  expect(store.providerGet(identity.generation.dispatch.runId)).toMatchObject({
    unobservedDispatchCount: 1,
    responseCount: 1,
  });
}, 45000);
