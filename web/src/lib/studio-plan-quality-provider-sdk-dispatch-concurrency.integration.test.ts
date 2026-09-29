/** Real child processes and installed SDK; every network is a local synthetic function. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External IO forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { reviewDispatchStoreFixture } from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import type { ProviderSdkSimulationResult } from "./studio-plan-quality-provider-dispatch-store";

const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type WorkerInput = {
  pauseSdkPreparation?: boolean;
  crashBeforeDispatchCommit?: boolean;
  crashAfterDispatchCommit?: boolean;
  crashAfterDispatchSend?: boolean;
};
type Result = {
  ok: boolean;
  result?: ProviderSdkSimulationResult<unknown>;
  code?: string;
  crashed?: number;
  transportCalls: number;
};
describe.each(["generation", "review"] as const)("%s SDK dispatch process ownership", (phase) => {
  let directory: string, store: PlanQualityStore;
  let identity: ProviderGenerationDispatchIdentity | ProviderReviewDispatchIdentity;
  const children: ChildProcess[] = [];
  const parentNetwork = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "completed", output: [] }),
  );
  const execute = () =>
    phase === "generation"
      ? store.providerSimulateGenerationSdkDispatch(identity)
      : store.providerSimulateReviewSdkDispatch(identity);
  const markers = () => {
    const file = join(directory, "mock-sdk-fetches.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
  };
  beforeEach(async () => {
    parentNetwork.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(actualTestNow);
    vi.stubGlobal("fetch", forbidden);
    directory = mkdtempSync(join(tmpdir(), "venture-sdk-dispatch-race-"));
    writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
    store = new PlanQualityStore(directory, {
      providerEnvironment: "synthetic-test",
      providerSdkTestNetwork: { provenance: "synthetic-test", fetch: parentNetwork },
    });
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    identity =
      phase === "generation"
        ? generationDispatchStoreFixture(store)
        : await reviewDispatchStoreFixture(store);
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
    expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
      "synthetic company sentinel",
    );
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel.startsWith("venture-sdk-dispatch-race-") || rel.includes(".."))
      throw Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }, 15000);
  function worker(extra: WorkerInput = {}) {
    const file = join(directory, `sdk-input-${randomUUID()}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        operation: `provider-${phase}-sdk-dispatch`,
        directory,
        clock: new Date().toISOString(),
        request: identity,
        ...extra,
      }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^OPENAI_|^VENTURE_DATA_DIR$/i.test(key)) delete env[key];
    const child = fork(workerPath, [file], { execArgv: [], env, windowsHide: true, silent: true });
    children.push(child);
    let stderr = "",
      received = false;
    child.stderr?.on("data", (data) => {
      stderr = (stderr + String(data)).slice(-1500);
    });
    let readyYes!: () => void,
      readyNo!: (e: Error) => void,
      preparingYes!: () => void,
      resultYes!: (v: Result) => void,
      resultNo!: (e: Error) => void;
    const ready = new Promise<void>((yes, no) => {
      readyYes = yes;
      readyNo = no;
    });
    const preparing = new Promise<void>((yes) => {
      preparingYes = yes;
    });
    const result = new Promise<Result>((yes, no) => {
      resultYes = yes;
      resultNo = no;
    });
    void ready.catch(() => undefined);
    void result.catch(() => undefined);
    const timer = setTimeout(() => {
      const error = Error(`SDK worker timeout: ${stderr}`);
      readyNo(error);
      resultNo(error);
      child.kill();
    }, 40000);
    child.on("message", (message) => {
      const data = message as Result & { kind: string };
      if (data.kind === "ready") readyYes();
      if (data.kind === "preparing") preparingYes();
      if (data.kind === "result") {
        received = true;
        resultYes(data);
      }
    });
    const exited = new Promise<void>((done) =>
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (
          (extra.crashBeforeDispatchCommit && code === 76) ||
          (extra.crashAfterDispatchCommit && code === 75) ||
          (extra.crashAfterDispatchSend && code === 78)
        ) {
          received = true;
          resultYes({ ok: true, crashed: code!, transportCalls: code === 78 ? 1 : 0 });
        }
        if (!received) {
          const error = Error(`SDK worker exited ${code}: ${stderr}`);
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
    return { ready, preparing, result, exited, go: () => child.send({ kind: "continue" }) };
  }
  it("allows only the newly committed process to enter fetch when identical commands race", async () => {
    const a = worker(),
      b = worker();
    await Promise.all([a.ready, b.ready]);
    a.go();
    b.go();
    const results = await Promise.all([a.result, b.result]);
    await Promise.all([a.exited, b.exited]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.result?.newlyCommitted)).toHaveLength(1);
    expect(results.filter((r) => r.result?.transport?.fetchStarted)).toHaveLength(1);
    expect(markers()).toHaveLength(1);
    expect(await execute()).toMatchObject({ replayed: true, transport: null });
    expect(parentNetwork).not.toHaveBeenCalled();
  }, 45000);
  it("rejects policy replaced by another process connection during SDK preparation", async () => {
    const w = worker({ pauseSdkPreparation: true });
    await w.ready;
    w.go();
    await Promise.race([
      w.preparing,
      w.result.then((r) => {
        throw Error(`Early SDK result ${JSON.stringify(r)}`);
      }),
    ]);
    adoptReservationTestPolicy(store);
    w.go();
    expect(await w.result).toMatchObject({
      ok: true,
      transportCalls: 0,
      result: {
        newlyCommitted: true,
        transport: { delivery: "not-sent", refusal: "current-check-rejected" },
      },
    });
    await w.exited;
    expect(markers()).toHaveLength(0);
  }, 45000);
  it("refuses a contended final writer lock without starting fetch or allowing a replay send", async () => {
    const w = worker({ pauseSdkPreparation: true });
    await w.ready;
    w.go();
    await Promise.race([
      w.preparing,
      w.result.then((r) => {
        throw Error(`Early SDK result ${JSON.stringify(r)}`);
      }),
    ]);
    const lock = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      lock.exec("BEGIN IMMEDIATE");
      w.go();
      expect(await w.result).toMatchObject({
        ok: true,
        transportCalls: 0,
        result: { transport: { delivery: "not-sent", fetchStarted: false } },
      });
    } finally {
      if (lock.isTransaction) lock.exec("ROLLBACK");
      lock.close();
    }
    await w.exited;
    expect(markers()).toHaveLength(0);
    expect(await execute()).toMatchObject({ replayed: true, transport: null });
    expect(parentNetwork).not.toHaveBeenCalled();
  }, 45000);
  it.each(["before-commit", "after-commit", "after-fetch"] as const)(
    "does not recover sending ownership after process death at %s",
    async (point) => {
      const w = worker({
        crashBeforeDispatchCommit: point === "before-commit",
        crashAfterDispatchCommit: point === "after-commit",
        crashAfterDispatchSend: point === "after-fetch",
      });
      await w.ready;
      w.go();
      expect((await w.result).crashed).toBe(
        point === "before-commit" ? 76 : point === "after-commit" ? 75 : 78,
      );
      await w.exited;
      expect(markers()).toHaveLength(point === "after-fetch" ? 1 : 0);
      const retry = await execute();
      expect(retry.newlyCommitted).toBe(point === "before-commit");
      expect(parentNetwork).toHaveBeenCalledTimes(point === "before-commit" ? 1 : 0);
      if (point !== "before-commit") expect(retry.transport).toBeNull();
    },
    45000,
  );
});
