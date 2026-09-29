/** Separate native processes, synthetic records and no credentials or transport. */
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
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import type { ProviderPolicyAdoptionCommit } from "./studio-plan-quality-provider-policy-adoption-store";

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
let directory: string, store: PlanQualityStore;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  kind: "result";
  ok: boolean;
  result?: ProviderPolicyAdoptionCommit;
  code?: string;
  transportCalls: number;
  crashedAfterCommit?: boolean;
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-policy-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
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
  if (!rel.startsWith("venture-policy-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: {
  operation: string;
  request: unknown;
  review?: unknown;
  crashAfterPolicyCommit?: boolean;
}) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ ...input, directory, clock: new Date().toISOString() }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^OPENAI_|^VENTURE_DATA_DIR$/i.test(key)) delete env[key];
  const child = fork(workerPath, [file], { execArgv: [], env, windowsHide: true, silent: true });
  children.push(child);
  let stderr = "",
    received = false;
  child.stderr?.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-1000);
  });
  let readyYes!: () => void, readyNo!: (error: Error) => void;
  let resultYes!: (value: Result) => void, resultNo!: (error: Error) => void;
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
    const error = new Error(`Policy test worker timed out: ${stderr}`);
    readyNo(error);
    resultNo(error);
    child.kill();
  }, 30000);
  child.on("message", (message) => {
    const value = message as Result | { kind: "ready" };
    if (value.kind === "ready") readyYes();
    if (value.kind === "result") {
      received = true;
      resultYes(value);
    }
  });
  const exited = new Promise<void>((done) =>
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (input.crashAfterPolicyCommit && code === 75) {
        received = true;
        resultYes({ kind: "result", ok: true, transportCalls: 0, crashedAfterCommit: true });
      }
      if (!received) {
        const error = new Error(`Policy test worker exited ${code}: ${stderr}`);
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
async function race(inputs: Parameters<typeof worker>[0][]) {
  const workers = inputs.map(worker);
  await Promise.all(workers.map((value) => value.ready));
  workers.forEach((value) => value.go());
  const results = await Promise.all(workers.map((value) => value.result));
  await Promise.all(workers.map((value) => value.exited));
  expect(results.every((value) => value.transportCalls === 0)).toBe(true);
  return results;
}
const request = (input: ReturnType<typeof policyAdoptionFixture>) => ({
  operation: "policy-adopt",
  request: input.command,
  review: input.review,
});

it("commits once and replays an identical simultaneous request from a second process", async () => {
  const input = policyAdoptionFixture(store);
  const results = await race([request(input), request(input)]);
  expect(results.every((value) => value.ok)).toBe(true);
  expect(results.filter((value) => value.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((value) => value.result?.replayed)).toHaveLength(1);
  expect(results[0].result!.record).toEqual(results[1].result!.record);
  expect(store.providerPolicyHead().revision).toBe(1);
  expect(store.providerBudgetGet("production").revision).toBe(1);
}, 45000);
it("allows exactly one different request for the same policy and initial budget head", async () => {
  const results = await race([
    request(policyAdoptionFixture(store)),
    request(policyAdoptionFixture(store, 1)),
  ]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toBe(
    "QUALITY_PROVIDER_POLICY_POLICY_HEAD_CHANGED",
  );
  expect(store.providerPolicyHead().revision).toBe(1);
  expect(store.providerBudgetGet("production").revision).toBe(1);
}, 45000);
it("rejects a different command reusing the winning policy nonce", async () => {
  const first = policyAdoptionFixture(store),
    other = policyAdoptionFixture(store, 1);
  other.command.clientRequestId = first.command.clientRequestId;
  const results = await race([request(first), request(other)]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toBe("QUALITY_PROVIDER_POLICY_NONCE_CONFLICT");
  expect(store.providerPolicyHead().revision).toBe(1);
}, 45000);
it("coordinates the global nonce with a concurrent synthetic provider reservation", async () => {
  providerTestConfigure(store);
  const input = policyAdoptionFixture(store),
    reservation = providerTestStartInput(store);
  reservation.clientRequestId = input.command.clientRequestId;
  const results = await race([
    request(input),
    { operation: "provider-start", request: reservation },
  ]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toMatch(/NONCE_CONFLICT/);
  expect(store.providerPolicyHead().revision + store.providerList().executions.length).toBe(1);
}, 45000);
it("recovers an acknowledged command after a real process exits immediately after commit", async () => {
  const input = policyAdoptionFixture(store);
  const result = await race([{ ...request(input), crashAfterPolicyCommit: true }]);
  expect(result[0].crashedAfterCommit).toBe(true);
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const observed = store.providerPolicyLookup(input.command.clientRequestId);
  expect(observed.state).toBe("committed");
  const replayed = store.providerPolicyAdopt(input.command, undefined);
  expect(replayed).toMatchObject({ newlyCommitted: false, replayed: true });
  if (observed.state === "committed") expect(replayed.record).toEqual(observed.record);
  expect(store.providerPolicyHead().revision).toBe(1);
  expect(store.providerBudgetGet("production").revision).toBe(1);
}, 45000);
