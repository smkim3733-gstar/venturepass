import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw new Error("Provider forbidden");
    }
  },
}));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPreparation } from "./studio-plan-quality-actual-test-helpers";
import type { ActualLedgerStart } from "./studio-plan-quality-actual-ledger-types";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";

import { providerExecutionTestApproval } from "./studio-plan-quality-provider-execution-test-helpers";

type WorkerResult = {
  kind: "result";
  ok: boolean;
  result?: {
    newlyCommitted?: boolean;
    replayed: boolean;
    snapshot: { run: { id: string }; state: string };
    recordingStatus?: string;
  };
  code?: string;
  transportCalls: number;
  crashedAfterCommit?: boolean;
};
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
let directory: string, store: PlanQualityStore;
const children: ChildProcess[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  directory = mkdtempSync(join(tmpdir(), "venturepass-actual-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "company sentinel");
  store = new PlanQualityStore(directory, {
    actualEnvironment: "synthetic-test",
    providerEnvironment: "synthetic-test",
  });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
}, 15000);
afterEach(() => {
  vi.useRealTimers();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  store.close();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("company sentinel");
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-actual-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
}, 15000);
function configure(capUnits = "4") {
  store.actualBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits },
  });
}
function startInput(index = 0): ActualLedgerStart {
  const budget = store.actualBudgetGet();
  const preparation = actualTestPreparation(store.candidateRegistryGet(1), {
    candidateIndex: index,
    preparedAt: new Date().toISOString(),
    capUnits: (BigInt(budget.capUnits) - BigInt(budget.recognizedUsageUnits)).toString(),
    heldUnits: budget.heldUnits,
    ledgerDigest: budget.headDigest!,
  });
  return {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    expectedActualRunCount: 0,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      acknowledgedSyntheticOnly: true,
      approvedAt: preparation.preparedAt,
    },
  };
}
function worker(input: unknown) {
  const file = join(directory, `worker-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ ...(input as object), clock: new Date().toISOString() }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^OPENAI_|^VENTURE_DATA_DIR$/i.test(key)) delete env[key];
  const child = fork(workerPath, [file], { execArgv: [], env, windowsHide: true, silent: true });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (part) => {
    stderr += String(part);
  });
  let resolveReady!: () => void,
    resolveResult!: (v: WorkerResult) => void,
    rejectReady!: (e: Error) => void,
    rejectResult!: (e: Error) => void;
  const ready = new Promise<void>((yes, no) => {
    resolveReady = yes;
    rejectReady = no;
  });
  const result = new Promise<WorkerResult>((yes, no) => {
    resolveResult = yes;
    rejectResult = no;
  });
  // Attach a handler immediately so a startup error cannot become an unhandled rejection.
  void result.catch(() => undefined);
  let received = false;
  let resolveTransport!: () => void;
  const transport = new Promise<void>((yes) => {
    resolveTransport = yes;
  });
  const timer = setTimeout(() => {
    const error = new Error(`Synthetic worker timeout: ${stderr.slice(-500)}`);
    rejectReady(error);
    rejectResult(error);
    child.kill();
  }, 25000);
  child.on("message", (message) => {
    const value = message as { kind: string };
    if (value.kind === "ready") resolveReady();
    if (value.kind === "transport") resolveTransport();
    if (value.kind === "result") {
      received = true;
      resolveResult(message as WorkerResult);
    }
  });
  const exited = new Promise<void>((yes) =>
    child.once("exit", (code) => {
      clearTimeout(timer);
      if ((input as { crashAfterDispatch?: boolean }).crashAfterDispatch && code === 75) {
        received = true;
        resolveResult({ kind: "result", ok: true, transportCalls: 0, crashedAfterCommit: true });
      }
      if (!received) {
        const error = new Error(`Synthetic worker exited: ${stderr.slice(-500)}`);
        rejectReady(error);
        rejectResult(error);
      }
      yes();
    }),
  );
  child.once("error", (error) => {
    clearTimeout(timer);
    rejectReady(error);
    rejectResult(error);
  });
  return {
    ready,
    result,
    exited,
    transport,
    go: () => child.send({ kind: "go" }),
    resume: () => child.send({ kind: "continue" }),
  };
}
async function race(inputs: unknown[]) {
  const racers = inputs.map(worker);
  await Promise.all(racers.map((item) => item.ready));
  racers.forEach((item) => item.go());
  const result = await Promise.all(racers.map((item) => item.result));
  await Promise.all(racers.map((item) => item.exited));
  return result;
}
describe("provider v2 separate-process reservation", () => {
  it("commits one identical reservation and replays the other process without transport", async () => {
    providerTestConfigure(store);
    const request = providerTestStartInput(store);
    const results = await race([
      { directory, operation: "provider-start", request },
      { directory, operation: "provider-start", request },
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(results.filter((item) => item.result?.newlyCommitted)).toHaveLength(1);
    expect(results.filter((item) => item.result?.replayed)).toHaveLength(1);
    expect(results.reduce((sum, item) => sum + item.transportCalls, 0)).toBe(0);
    expect(store.providerBudgetGet().heldUnits).toBe("4");
    expect(store.providerList().executions).toHaveLength(1);
  }, 40000);
  it("reserves the final available budget only once across different candidates", async () => {
    providerTestConfigure(store, "4");
    const results = await race([
      { directory, operation: "provider-start", request: providerTestStartInput(store, 0) },
      { directory, operation: "provider-start", request: providerTestStartInput(store, 1) },
    ]);
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(results.filter((item) => !item.ok)).toHaveLength(1);
    expect(results.reduce((sum, item) => sum + item.transportCalls, 0)).toBe(0);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "4", availableUnits: "0" });
    expect(store.providerList().executions).toHaveLength(1);
  }, 40000);
  it("releases once when two processes cancel the same reservation", async () => {
    providerTestConfigure(store);
    const started = store.providerStart(providerTestStartInput(store));
    const runId = started.snapshot.run.id;
    const original = store.providerDownload(runId, 0).body;
    const request = { clientRequestId: randomUUID(), expectedRevision: 0, reason: "test-cleanup" };
    const results = await race([
      { directory, operation: "provider-cancel", runId, request },
      { directory, operation: "provider-cancel", runId, request },
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(results.filter((item) => item.result?.newlyCommitted)).toHaveLength(1);
    expect(results.filter((item) => item.result?.replayed)).toHaveLength(1);
    expect(results.reduce((sum, item) => sum + item.transportCalls, 0)).toBe(0);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", availableUnits: "100" });
    expect(store.providerGet(runId).events).toHaveLength(1);
    expect(store.providerDownload(runId, 0).body).toBe(original);
  }, 40000);
  it("keeps nonce ownership global when legacy and v2 callers race", async () => {
    configure();
    providerTestConfigure(store);
    const legacy = startInput(),
      provider = providerTestStartInput(store);
    provider.clientRequestId = legacy.clientRequestId;
    const results = await race([
      { directory, operation: "start", request: legacy },
      { directory, operation: "provider-start", request: provider },
    ]);
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(results.filter((item) => !item.ok)).toHaveLength(1);
    expect(results.reduce((sum, item) => sum + item.transportCalls, 0)).toBe(0);
    expect(store.actualList().executions.length + store.providerList().executions.length).toBe(1);
    expect(
      BigInt(store.actualBudgetGet().heldUnits) + BigInt(store.providerBudgetGet().heldUnits),
    ).toBe(BigInt(4));
  }, 40000);
});

describe("actual ledger separate-process reservation", () => {
  it("commits only one of two candidates racing for the last complete reservation", async () => {
    configure();
    const first = startInput(0),
      second = startInput(1);
    const results = await race([
      { directory, operation: "start", request: first },
      { directory, operation: "start", request: second },
    ]);
    expect(results.filter((item) => item.ok)).toHaveLength(1);
    expect(results.filter((item) => !item.ok)).toHaveLength(1);
    expect(results.reduce((sum, item) => sum + item.transportCalls, 0)).toBe(0);
    const budget = store.actualBudgetGet();
    expect(budget.heldUnits).toBe("4");
    expect(budget.availableUnits).toBe("0");
    expect(budget.recognizedUsageUnits).toBe("0");
    expect(store.actualList().executions).toHaveLength(1);
  }, 40000);
  it("replays one identical start in two processes without a second reservation", async () => {
    configure();
    const input = startInput();
    const results = await race([
      { directory, operation: "start", request: input },
      { directory, operation: "start", request: input },
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(results.filter((item) => item.result?.newlyCommitted)).toHaveLength(1);
    expect(results.filter((item) => item.result?.replayed)).toHaveLength(1);
    expect(new Set(results.map((item) => item.result?.snapshot.run.id)).size).toBe(1);
    expect(store.actualBudgetGet().heldUnits).toBe("4");
    expect(store.actualLookup(input.clientRequestId)).not.toHaveProperty("newlyCommitted");
  }, 40000);
});

function preparedDispatch() {
  configure();
  const started = store.actualStart(startInput());
  const runId = started.snapshot.run.id;
  const prep = started.snapshot.run.preparation;
  const artifact = store.actualArtifact(runId, "generation-request");
  const budget = store.actualBudgetGet();
  const prepared = store.actualRecordPrepared(runId, {
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    payload: {
      kind: "request-prepared",
      phase: "generation",
      requestDigest: prep.requestEvidence!.generation.requestDigest,
      artifactSha256: artifact.sha256,
      inputTokenUpperBound: 10,
      derivedFrom: null,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
  });
  return {
    runId,
    request: {
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      payload: {
        kind: "dispatch-intent" as const,
        phase: "generation" as const,
        requestDigest: prep.requestEvidence!.generation.requestDigest,
        preparedEventDigest: prepared.snapshot.events[0].eventDigest,
        artifactSha256: artifact.sha256,
        budgetRevision: budget.revision,
        budgetDigest: budget.headDigest!,
      },
    },
  };
}

describe("actual ledger separate-process dispatch ownership", () => {
  it("gives only the first committing process one simulated transport call", async () => {
    const { runId, request } = preparedDispatch();
    const results = await race([
      { directory, operation: "dispatch", runId, request },
      { directory, operation: "dispatch", runId, request },
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(results.filter((item) => item.result?.newlyCommitted)).toHaveLength(1);
    expect(results.filter((item) => item.result?.replayed)).toHaveLength(1);
    expect(results.reduce((sum, item) => sum + item.transportCalls, 0)).toBe(1);
    expect(
      store.actualGet(runId).events.filter((event) => event.payload.kind === "dispatch-intent"),
    ).toHaveLength(1);
    expect(store.actualLookup(request.clientRequestId)).not.toHaveProperty("newlyCommitted");
  }, 40000);
  it("keeps a committed but unsent dispatch unknown without granting a replay transmission", async () => {
    const { runId, request } = preparedDispatch();
    const [first] = await race([
      { directory, operation: "dispatch", runId, request, omitTransport: true },
    ]);
    expect(first.ok).toBe(true);
    expect(first.result?.newlyCommitted).toBe(true);
    expect(first.transportCalls).toBe(0);
    const [replay] = await race([{ directory, operation: "dispatch", runId, request }]);
    expect(replay.ok).toBe(true);
    expect(replay.result?.replayed).toBe(true);
    expect(replay.transportCalls).toBe(0);
    expect(store.actualGet(runId).state).toBe("dispatch-intent");
    expect(store.actualBudgetGet().heldUnits).toBe("4");
  }, 40000);
});

describe("C1 engine and ledger across separate processes", () => {
  it("runs two engine phases only once for racing callers sharing a start nonce", async () => {
    configure();
    const request = startInput();
    const results = await race([
      { directory, operation: "runner", request },
      { directory, operation: "runner", request },
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.result?.replayed)).toHaveLength(1);
    expect(results.reduce((sum, result) => sum + result.transportCalls, 0)).toBe(2);
    const snapshots = store.actualList().executions;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      state: "completed",
      revision: 9,
      costState: "settled",
      actualAiCalls: 0,
    });
    expect(store.actualBudgetGet()).toMatchObject({ recognizedUsageUnits: "4", heldUnits: "0" });
  }, 40000);
  it("replays without transport while the first process waits for its generation response", async () => {
    configure();
    const request = startInput();
    const original = worker({ directory, operation: "runner", request, holdGeneration: true });
    await original.ready;
    original.go();
    await original.transport;
    const [replay] = await race([{ directory, operation: "runner", request }]);
    expect(replay.ok).toBe(true);
    expect(replay.result?.replayed).toBe(true);
    expect(replay.transportCalls).toBe(0);
    expect(store.actualList().executions[0].state).toBe("dispatch-intent");
    expect(store.actualBudgetGet().heldUnits).toBe("4");
    original.resume();
    const completed = await original.result;
    await original.exited;
    expect(completed.ok).toBe(true);
    expect(completed.transportCalls).toBe(2);
    expect(store.actualList().executions[0].state).toBe("completed");
  }, 40000);
  it("preserves an actual process exit after dispatch commit and never reissues transport", async () => {
    configure();
    const request = startInput();
    const [crashed] = await race([
      { directory, operation: "runner", request, crashAfterDispatch: true },
    ]);
    expect(crashed.crashedAfterCommit).toBe(true);
    expect(store.actualList().executions[0].state).toBe("dispatch-intent");
    const [reopened] = await race([{ directory, operation: "runner", request }]);
    expect(reopened.ok).toBe(true);
    expect(reopened.result?.replayed).toBe(true);
    expect(reopened.transportCalls).toBe(0);
    expect(store.actualBudgetGet().heldUnits).toBe("4");
    expect(store.actualList().executions[0].events).toHaveLength(2);
  }, 40000);
  it("keeps an unobserved generation after reopen without repeating either engine phase", async () => {
    configure();
    const request = startInput();
    const [first] = await race([{ directory, operation: "runner", request, failGeneration: true }]);
    expect(first.ok).toBe(true);
    expect(first.transportCalls).toBe(1);
    expect(store.actualList().executions[0].state).toBe("result-unobserved");
    const [second] = await race([{ directory, operation: "runner", request }]);
    expect(second.ok).toBe(true);
    expect(second.transportCalls).toBe(0);
    expect(second.result?.replayed).toBe(true);
    expect(store.actualBudgetGet().heldUnits).toBe("2");
  }, 40000);
});

describe("v2 approved engine across separate processes", () => {
  function reserved() {
    providerTestConfigure(store);
    const runId = store.providerStart(providerTestStartInput(store)).snapshot.run.id;
    return { runId, request: providerExecutionTestApproval(store, runId) };
  }
  it("gives one approval caller exactly two injected transport calls", async () => {
    const { runId, request } = reserved();
    const results = await race([
      { directory, operation: "provider-runner", runId, request },
      { directory, operation: "provider-runner", runId, request },
    ]);
    expect(
      results.every((row) => row.ok),
      JSON.stringify(
        results.map((row) => ({ ok: row.ok, code: row.code, transportCalls: row.transportCalls })),
      ),
    ).toBe(true);
    expect(results.filter((row) => row.result?.replayed)).toHaveLength(1);
    expect(results.reduce((sum, row) => sum + row.transportCalls, 0)).toBe(2);
    expect(store.providerGet(runId)).toMatchObject({
      state: "completed",
      revision: 10,
      actualAiCalls: 0,
    });
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUnits: "4" });
  }, 40000);
  it("keeps committed dispatch unknown after process exit and replays without transport", async () => {
    const { runId, request } = reserved();
    const [crashed] = await race([
      { directory, operation: "provider-runner", runId, request, crashAfterDispatch: true },
    ]);
    expect(crashed.crashedAfterCommit, JSON.stringify(crashed)).toBe(true);
    expect(store.providerGet(runId)).toMatchObject({ state: "dispatching", revision: 3 });
    const [reopened] = await race([{ directory, operation: "provider-runner", runId, request }]);
    expect(reopened).toMatchObject({ ok: true, transportCalls: 0, result: { replayed: true } });
    expect(store.providerBudgetGet().heldUnits).toBe("4");
  }, 40000);
  it("does not issue a replay while original transport is awaiting response", async () => {
    const { runId, request } = reserved(),
      original = worker({
        directory,
        operation: "provider-runner",
        runId,
        request,
        holdGeneration: true,
      });
    await original.ready;
    original.go();
    await Promise.race([
      original.transport,
      original.result.then((value) => {
        throw new Error(
          JSON.stringify({ ok: value.ok, code: value.code, transportCalls: value.transportCalls }),
        );
      }),
    ]);
    const [replay] = await race([{ directory, operation: "provider-runner", runId, request }]);
    expect(replay).toMatchObject({ ok: true, transportCalls: 0, result: { replayed: true } });
    expect(store.providerGet(runId).state).toBe("dispatching");
    original.resume();
    const completed = await original.result;
    await original.exited;
    expect(completed).toMatchObject({ ok: true, transportCalls: 2 });
    expect(store.providerGet(runId).state).toBe("completed");
  }, 40000);
});
