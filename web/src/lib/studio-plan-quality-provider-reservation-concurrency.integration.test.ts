/** Native child processes with synthetic approvals, isolated data and no provider credentials. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import type { ProviderReservationCommit } from "./studio-plan-quality-provider-reservation-store";
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
  ok: boolean;
  result?: ProviderReservationCommit;
  code?: string;
  transportCalls: number;
  crashed?: "before" | "after";
};
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-reservation-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory);
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  adoptReservationTestPolicy(store);
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
  if (!rel.startsWith("venture-reservation-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: {
  operation: string;
  request: unknown;
  review?: unknown;
  crashAfterReservationCommit?: boolean;
  crashBeforeReservationCommit?: boolean;
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
  let readyYes!: () => void,
    readyNo!: (error: Error) => void,
    resultYes!: (result: Result) => void,
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
    const error = new Error(`Reservation worker timeout: ${stderr}`);
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
        (input.crashAfterReservationCommit && code === 75) ||
        (input.crashBeforeReservationCommit && code === 76)
      ) {
        received = true;
        resultYes({ ok: true, transportCalls: 0, crashed: code === 75 ? "after" : "before" });
      }
      if (!received) {
        const error = new Error(`Reservation worker exited ${code}: ${stderr}`);
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
const request = (input: ReturnType<typeof reservationStoreFixture>) => ({
  operation: "provider-reserve",
  request: input.command,
  review: input.review,
});
it("commits one reservation and replays the identical simultaneous command", async () => {
  const input = reservationStoreFixture(store),
    results = await race([request(input), request(input)]);
  expect(results.every((value) => value.ok)).toBe(true);
  expect(results.filter((value) => value.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((value) => value.result?.replayed)).toHaveLength(1);
  expect(results[0].result!.record).toEqual(results[1].result!.record);
  expect(store.providerList().executions).toHaveLength(1);
  expect(store.providerBudgetGet("production").revision).toBe(2);
}, 45000);
it("allows one new command per observed ledger and rejects the other without a partial run", async () => {
  const first = reservationStoreFixture(store),
    second = reservationStoreFixture(store);
  const results = await race([request(first), request(second)]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toBe(
    "QUALITY_PROVIDER_RESERVATION_REVIEW_NOT_CURRENT",
  );
  expect(store.providerList().executions).toHaveLength(1);
  expect(store.providerBudgetGet("production").revision).toBe(2);
}, 45000);
it("rejects a different command using the winning nonce", async () => {
  const first = reservationStoreFixture(store),
    second = structuredClone(first);
  second.command.approval.approvedAt = "2026-09-27T03:00:00.001Z";
  // Both contenders must be independently valid; their approvals differ but remain within review time.
  vi.setSystemTime("2026-09-27T03:00:00.002Z");
  const results = await race([request(first), request(second)]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toBe(
    "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT",
  );
  expect(store.providerList().executions).toHaveLength(1);
}, 45000);
it("coordinates the global nonce with a simultaneous policy adoption", async () => {
  const reservation = reservationStoreFixture(store),
    policy = policyAdoptionFixture(store, 1);
  policy.command.clientRequestId = reservation.command.clientRequestId;
  const results = await race([
    request(reservation),
    { operation: "policy-adopt", request: policy.command, review: policy.review },
  ]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toMatch(/NONCE_CONFLICT/);
  expect(store.providerList().executions.length + store.providerPolicyHead().revision).toBe(2);
}, 45000);
it.each(["before", "after"] as const)(
  "recovers after an actual process exit %s commit",
  async (phase) => {
    const input = reservationStoreFixture(store);
    const results = await race([
      {
        ...request(input),
        crashBeforeReservationCommit: phase === "before",
        crashAfterReservationCommit: phase === "after",
      },
    ]);
    expect(results[0].crashed).toBe(phase);
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.providerList().executions).toHaveLength(phase === "before" ? 0 : 1);
    expect(store.providerReservationLookup(input.command.clientRequestId).state).toBe(
      phase === "before" ? "not-observed" : "committed",
    );
    if (phase === "after") vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const recovered = store.providerReserve(
      input.command,
      phase === "after" ? undefined : input.review,
    );
    expect(recovered).toMatchObject({
      newlyCommitted: phase === "before",
      replayed: phase === "after",
    });
    expect(store.providerList().executions).toHaveLength(1);
    expect(store.providerBudgetGet("production").revision).toBe(2);
  },
  45000,
);
