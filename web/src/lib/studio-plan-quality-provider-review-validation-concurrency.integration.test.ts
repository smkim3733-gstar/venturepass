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
import { reviewValidationStoreFixture } from "./studio-plan-quality-provider-review-validation-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import type { ProviderReviewValidationCommitResult } from "./studio-plan-quality-provider-review-validation";
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
let identity: import("./studio-plan-quality-provider-review-validation").ProviderReviewValidationIdentity;
let directory: string,
  store: PlanQualityStore,
  inputResponse: ReturnType<typeof reviewResponseCapture>;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderReviewValidationCommitResult;
  code?: string;
  transportCalls: number;
  crashed?: number;
};
type Input = {
  operation?: string;
  request?: unknown;
  review?: unknown;
  crashAfterValidationInsert?: number;
  crashBeforeValidationCommit?: boolean;
  crashAfterValidationCommit?: boolean;
};
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-review-validation-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const fixture = await reviewValidationStoreFixture(store);
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
  if (!rel.startsWith("venture-review-validation-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: Input) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      operation: "provider-review-validation",
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
    const error = new Error(`Validation worker timeout: ${stderr}`);
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
        (input.crashAfterValidationCommit && code === 95) ||
        (input.crashBeforeValidationCommit && code === 96) ||
        (input.crashAfterValidationInsert && code === 97)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: 0, crashed: code! });
      }
      if (!received) {
        const error = new Error(`Validation worker exited ${code}: ${stderr}`);
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
it("two processes persist one validation and return identical historical evidence", async () => {
  const before = store.providerBudgetGet("production"),
    results = await race([{}, {}]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((r) => r.result?.replayed)).toHaveLength(1);
  expect(results[0].result?.record).toEqual(results[1].result?.record);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  expect(store.providerBudgetGet("production")).toEqual(before);
  expect(store.providerGet(identity.dispatch.generation.dispatch.runId)).toMatchObject({
    revision: 9,
    state: "validated",
    responseCount: 2,
    dispatchIntentCount: 2,
  });
  expect(() =>
    store.providerArtifact(identity.dispatch.generation.dispatch.runId, "final-result"),
  ).toThrow();
}, 45000);
it("rejects a competing validation nonce while keeping the winner and original response", async () => {
  const other = { ...identity, validationRequestId: randomUUID() },
    budget = store.providerBudgetGet("production"),
    results = await race([{}, { request: other }]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.code).toBe(
    "QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_CONFLICT",
  );
  const winner = results[0].ok ? identity : other;
  expect(store.providerReviewValidationLookup(winner).state).toBe("committed");
  expect(store.providerReviewResponseLookup(inputResponse).state).toBe("committed");
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("serializes validation against policy replacement without granting new dispatch rights", async () => {
  const policy = policyAdoptionFixture(store, 0),
    budget = store.providerBudgetGet("production");
  const results = await race([
    {},
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(store.providerReviewValidationLookup(identity)).toMatchObject({
    state: "committed",
    dispatchAllowed: false,
    finalResultPersisted: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect((await race([{}]))[0].result?.replayed).toBe(true);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("serializes a response replay and validation without rewriting raw evidence or recognizing cost again", async () => {
  const budget = store.providerBudgetGet("production"),
    raw = store.providerArtifact(identity.dispatch.generation.dispatch.runId, "review-response");
  const results = await race([
    {},
    { operation: "provider-review-response", request: inputResponse },
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(
    store.providerArtifact(identity.dispatch.generation.dispatch.runId, "review-response"),
  ).toEqual(raw);
  expect(store.providerGet(identity.dispatch.generation.dispatch.runId).revision).toBe(9);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it.each([1, 2, 3, "before", "after"] as const)(
  "recovers exactly once after process death at validation %s",
  async (point) => {
    const before = store.providerBudgetGet("production"),
      persisted = point === "after";
    const crashed = await race([
      {
        crashAfterValidationInsert: typeof point === "number" ? point : undefined,
        crashBeforeValidationCommit: point === "before",
        crashAfterValidationCommit: persisted,
      },
    ]);
    expect(crashed[0].crashed).toBe(typeof point === "number" ? 97 : persisted ? 95 : 96);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerGet(identity.dispatch.generation.dispatch.runId).revision).toBe(
      persisted ? 9 : 8,
    );
    expect(store.providerReviewValidationLookup(identity).state).toBe(
      persisted ? "committed" : "not-observed",
    );
    expect(store.providerBudgetGet("production")).toEqual(before);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const retry = await race([{}]);
    expect(retry[0].ok).toBe(true);
    expect(retry[0].result?.replayed).toBe(persisted);
    expect(retry[0].transportCalls).toBe(0);
    expect(store.providerBudgetGet("production")).toEqual(before);
    expect(store.providerGet(identity.dispatch.generation.dispatch.runId)).toMatchObject({
      revision: 9,
      responseCount: 2,
      dispatchIntentCount: 2,
    });
    expect(() =>
      store.providerArtifact(identity.dispatch.generation.dispatch.runId, "final-result"),
    ).toThrow();
  },
  45000,
);
it("serializes review validation against a captured-output terminal fixture and never reopens it", async () => {
  const id = identity.dispatch.generation.dispatch.runId,
    budget = store.providerBudgetGet("production");
  const results = await race([{}, { operation: "provider-review-captured-stop-fixture" }]);
  expect(results.some((r) => r.ok)).toBe(true);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  const snapshot = store.providerGet(id);
  if (results[0].ok) {
    expect(snapshot.revision).toBe(results[1].ok ? 10 : 9);
    expect(store.providerReviewValidationLookup(identity).state).toBe("committed");
    const next = await race([{}]);
    expect(next[0].result?.replayed).toBe(true);
    if (!results[1].ok) expect(results[1].code).toBe("ERR_SQLITE_ERROR");
  } else {
    expect(results[0].code).toBe("QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_EXECUTION_STOPPED");
    expect(snapshot).toMatchObject({ revision: 9, state: "output-invalid", terminal: true });
    expect(store.providerReviewValidationLookup(identity).state).toBe("not-observed");
  }
  expect(store.providerBudgetGet("production")).toEqual(budget);
}, 45000);
it("rejects both validation processes after a separate process has committed the terminal event", async () => {
  const budget = store.providerBudgetGet("production");
  const stopped = await race([{ operation: "provider-review-captured-stop-fixture" }]);
  expect(stopped[0].ok).toBe(true);
  const results = await race([{}, {}]);
  expect(
    results.every(
      (r) => !r.ok && r.code === "QUALITY_PROVIDER_DISPATCH_REVIEW_VALIDATION_EXECUTION_STOPPED",
    ),
  ).toBe(true);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  expect(store.providerGet(identity.dispatch.generation.dispatch.runId)).toMatchObject({
    revision: 9,
    state: "output-invalid",
    terminal: true,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
}, 45000);
