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
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import type { ProviderFinalizationCommitResult } from "./studio-plan-quality-provider-finalization";
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
let identity: import("./studio-plan-quality-provider-finalization").ProviderFinalizationIdentity;
let directory: string,
  store: PlanQualityStore,
  inputResponse: ReturnType<typeof reviewResponseCapture>;
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderFinalizationCommitResult;
  code?: string;
  transportCalls: number;
  crashed?: number;
};
type Input = {
  operation?: string;
  request?: unknown;
  review?: unknown;
  crashAfterFinalizationInsert?: number;
  crashBeforeFinalizationCommit?: boolean;
  crashAfterFinalizationCommit?: boolean;
};
beforeEach(async () => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-finalization-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const fixture = await finalizationStoreFixture(store);
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
  if (!rel.startsWith("venture-finalization-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: Input) {
  const file = join(directory, `input-${randomUUID()}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      operation: "provider-finalization",
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
    const error = new Error(`Finalization worker timeout: ${stderr}`);
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
        (input.crashAfterFinalizationCommit && code === 115) ||
        (input.crashBeforeFinalizationCommit && code === 116) ||
        (input.crashAfterFinalizationInsert && code === 117)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: 0, crashed: code! });
      }
      if (!received) {
        const error = new Error(`Finalization worker exited ${code}: ${stderr}`);
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
it("two processes commit one completion and return the same original final evidence", async () => {
  const before = store.providerBudgetGet("production"),
    results = await race([{}, {}]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((r) => r.result?.replayed)).toHaveLength(1);
  expect(results[0].result?.record).toEqual(results[1].result?.record);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  expect(store.providerBudgetGet("production")).toEqual(before);
  const id = identity.validation.dispatch.generation.dispatch.runId;
  expect(store.providerGet(id)).toMatchObject({
    revision: 10,
    state: "completed",
    terminal: true,
    responseCount: 2,
    dispatchIntentCount: 2,
  });
  expect(store.providerArtifact(id, "final-result").sha256).toBe(
    results[0].result!.record.finalArtifactSha256,
  );
}, 45000);
it("rejects the losing completion nonce while preserving the winner and original validation", async () => {
  const other = { ...identity, finalizationRequestId: randomUUID() },
    budget = store.providerBudgetGet("production"),
    results = await race([{}, { request: other }]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)?.code).toBe("QUALITY_PROVIDER_DISPATCH_FINALIZATION_CONFLICT");
  expect(store.providerFinalizationLookup(results[0].ok ? identity : other).state).toBe(
    "committed",
  );
  expect(store.providerReviewValidationLookup(identity.validation).state).toBe("committed");
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it("serializes completion with policy replacement without new dispatch rights", async () => {
  const policy = policyAdoptionFixture(store, 0),
    budget = store.providerBudgetGet("production");
  const results = await race([
    {},
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  expect(store.providerFinalizationLookup(identity)).toMatchObject({
    state: "committed",
    finalResultPersisted: true,
    dispatchAllowed: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect((await race([{}]))[0].result?.replayed).toBe(true);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
}, 45000);
it.each(["validation", "response"])(
  "serializes %s replay and completion without rewriting evidence or cost",
  async (kind) => {
    const id = identity.validation.dispatch.generation.dispatch.runId,
      budget = store.providerBudgetGet("production"),
      raw = store.providerArtifact(id, "review-response"),
      validated = store.providerArtifact(id, "review-validated");
    const results = await race([
      {},
      {
        operation:
          kind === "validation" ? "provider-review-validation" : "provider-review-response",
        request: kind === "validation" ? identity.validation : inputResponse,
      },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerArtifact(id, "review-response")).toEqual(raw);
    expect(store.providerArtifact(id, "review-validated")).toEqual(validated);
    expect(store.providerGet(id)).toMatchObject({ revision: 10, state: "completed" });
    expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  },
  45000,
);
it.each([1, 2, 3, "before", "after"] as const)(
  "recovers exactly once after actual process death at completion %s",
  async (point) => {
    const budget = store.providerBudgetGet("production"),
      persisted = point === "after",
      id = identity.validation.dispatch.generation.dispatch.runId,
      planned = store.providerPrepareFinalization(identity);
    if (planned.status !== "prepared") throw Error(planned.reason);
    const crashed = await race([
      {
        crashAfterFinalizationInsert: typeof point === "number" ? point : undefined,
        crashBeforeFinalizationCommit: point === "before",
        crashAfterFinalizationCommit: persisted,
      },
    ]);
    expect(crashed[0].crashed).toBe(typeof point === "number" ? 117 : persisted ? 115 : 116);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerGet(id).revision).toBe(persisted ? 10 : 9);
    expect(store.providerFinalizationLookup(identity).state).toBe(
      persisted ? "committed" : "not-observed",
    );
    expect(store.providerBudgetGet("production")).toEqual(budget);
    if (!persisted) expect(() => store.providerArtifact(id, "final-result")).toThrow();
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const retry = await race([{}]);
    expect(retry[0].ok).toBe(true);
    expect(retry[0].result?.replayed).toBe(persisted);
    expect(retry[0].transportCalls).toBe(0);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(store.providerGet(id)).toMatchObject({
      revision: 10,
      state: "completed",
      terminal: true,
      responseCount: 2,
      dispatchIntentCount: 2,
    });
    expect(store.providerArtifact(id, "final-result").body.toString("utf8")).toBe(
      planned.plan.rows.artifact.body,
    );
  },
  45000,
);
it("chooses exactly one terminal event when completion races a native failure fixture", async () => {
  const id = identity.validation.dispatch.generation.dispatch.runId,
    budget = store.providerBudgetGet("production");
  const results = await race([
    {},
    { operation: "provider-review-captured-stop-fixture", request: identity.validation },
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  const snapshot = store.providerGet(id);
  expect(snapshot).toMatchObject({ revision: 10, terminal: true });
  if (results[0].ok) {
    expect(snapshot.state).toBe("completed");
    expect(store.providerFinalizationLookup(identity).state).toBe("committed");
    expect((await race([{}]))[0].result?.replayed).toBe(true);
  } else {
    expect(results[0].code).toBe("QUALITY_PROVIDER_DISPATCH_FINALIZATION_EXECUTION_STOPPED");
    expect(snapshot.state).toBe("output-invalid");
    expect(store.providerFinalizationLookup(identity).state).toBe("not-observed");
    expect(() => store.providerArtifact(id, "final-result")).toThrow();
  }
  expect(store.providerBudgetGet("production")).toEqual(budget);
}, 45000);
it("blocks both completion workers after a separate process has committed failure", async () => {
  const budget = store.providerBudgetGet("production");
  expect(
    (
      await race([
        { operation: "provider-review-captured-stop-fixture", request: identity.validation },
      ])
    )[0].ok,
  ).toBe(true);
  const results = await race([{}, {}]);
  expect(
    results.every(
      (r) => !r.ok && r.code === "QUALITY_PROVIDER_DISPATCH_FINALIZATION_EXECUTION_STOPPED",
    ),
  ).toBe(true);
  expect(results.every((r) => r.transportCalls === 0)).toBe(true);
  expect(store.providerGet(identity.validation.dispatch.generation.dispatch.runId)).toMatchObject({
    revision: 10,
    state: "output-invalid",
    terminal: true,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
}, 45000);
