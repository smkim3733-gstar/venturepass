import { DatabaseSync } from "node:sqlite";
import { seedPolicyTestBudget } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  reserveTransmissionTestRun,
  transmissionStoreFixture,
} from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
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
import type { ProviderTransmissionApprovalCommit } from "./studio-plan-quality-provider-transmission-approval-store";
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
let directory: string, store: PlanQualityStore, selection: { runId: string; runDigest: string };
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("../../scripts/test-quality-actual-worker.mjs", import.meta.url),
);
type Result = {
  ok: boolean;
  result?: ProviderTransmissionApprovalCommit;
  code?: string;
  transportCalls: number;
  crashed?: "before" | "after" | "insert";
};
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-transmission-race-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory);
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  try {
    db.function("quality_storage_contract", () => "quality-v9");
    seedPolicyTestBudget(db, "30000000");
  } finally {
    db.close();
  }
  selection = reserveTransmissionTestRun(store);
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
  if (!rel.startsWith("venture-transmission-race-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
}, 15000);
function worker(input: {
  operation: string;
  request: unknown;
  review?: unknown;
  crashAfterApprovalCommit?: boolean;
  crashBeforeApprovalCommit?: boolean;
  crashAfterApprovalInsert?: string;
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
    const error = new Error(`Transmission worker timeout: ${stderr}`);
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
        (input.crashAfterApprovalCommit && code === 75) ||
        (input.crashBeforeApprovalCommit && code === 76) ||
        (input.crashAfterApprovalInsert && code === 77)
      ) {
        received = true;
        resultYes({
          ok: true,
          transportCalls: 0,
          crashed: code === 75 ? "after" : code === 76 ? "before" : "insert",
        });
      }
      if (!received) {
        const error = new Error(`Transmission worker exited ${code}: ${stderr}`);
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
const request = (input: ReturnType<typeof transmissionStoreFixture>) => ({
  operation: "provider-transmission-approve",
  request: input.command,
  review: input.review,
});
it("commits one approval and replays the identical simultaneous command", async () => {
  const input = transmissionStoreFixture(store, selection),
    results = await race([request(input), request(input)]);
  expect(results.every((value) => value.ok)).toBe(true);
  expect(results.filter((value) => value.result?.newlyCommitted)).toHaveLength(1);
  expect(results.filter((value) => value.result?.replayed)).toHaveLength(1);
  expect(results[0].result!.record).toEqual(results[1].result!.record);
  expect(store.providerGet(selection.runId)).toMatchObject({
    state: "approved",
    revision: 1,
    dispatchIntentCount: 0,
  });
  expect(store.providerBudgetGet("production").revision).toBe(2);
}, 45000);
it("rejects a different nonce using the same stale run without a partial approval", async () => {
  const first = transmissionStoreFixture(store, selection),
    second = transmissionStoreFixture(store, selection),
    results = await race([request(first), request(second)]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toBe(
    "QUALITY_PROVIDER_TRANSMISSION_REVIEW_NOT_CURRENT",
  );
  expect(store.providerGet(selection.runId).revision).toBe(1);
  expect(store.providerBudgetGet("production").revision).toBe(2);
}, 45000);
it("compares full commands for competing reviews even with the same native input identity", async () => {
  const first = transmissionStoreFixture(store, selection);
  vi.setSystemTime(new Date(Date.parse(actualTestNow) + 1000));
  const second = transmissionStoreFixture(store, selection);
  first.command.approval.approvedAt = second.command.approval.approvedAt;
  second.command.clientRequestId = first.command.clientRequestId;
  expect(first.command.approvedReviewDigest).not.toBe(second.command.approvedReviewDigest);
  const results = await race([request(first), request(second)]);
  expect(results.filter((value) => value.ok)).toHaveLength(1);
  expect(results.find((value) => !value.ok)?.code).toBe(
    "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT",
  );
  expect(store.providerGet(selection.runId).revision).toBe(1);
}, 45000);
it.each(["policy", "reservation"] as const)(
  "serializes a shared nonce with simultaneous %s",
  async (kind) => {
    adoptReservationTestPolicy(store, 1);
    const approval = transmissionStoreFixture(store, selection),
      other =
        kind === "policy" ? policyAdoptionFixture(store, 1) : reservationStoreFixture(store, 1);
    other.command.clientRequestId = approval.command.clientRequestId;
    const results = await race([
      request(approval),
      {
        operation: kind === "policy" ? "policy-adopt" : "provider-reserve",
        request: other.command,
        review: other.review,
      },
    ]);
    expect(results.filter((value) => value.ok)).toHaveLength(1);
    expect(results.find((value) => !value.ok)?.code).toMatch(/NONCE_CONFLICT/);
    const winnerIsApproval = results[0].ok;
    expect(store.providerGet(selection.runId).revision).toBe(winnerIsApproval ? 1 : 0);
    expect(store.providerTransmissionApprovalLookup(approval.command.clientRequestId).state).toBe(
      winnerIsApproval ? "committed" : "not-observed",
    );
  },
  45000,
);
it.each(["policy", "reservation"] as const)(
  "rechecks current approval evidence against a simultaneous %s write",
  async (kind) => {
    adoptReservationTestPolicy(store, 1);
    const approval = transmissionStoreFixture(store, selection),
      other =
        kind === "policy" ? policyAdoptionFixture(store, 1) : reservationStoreFixture(store, 1);
    const results = await race([
      request(approval),
      {
        operation: kind === "policy" ? "policy-adopt" : "provider-reserve",
        request: other.command,
        review: other.review,
      },
    ]);
    // Policy review can stay current when only an approval event changes (no budget mutation).
    // If policy/reservation wins first, the old approval MUST fail its whole-archive CAS.
    expect(results.some((value) => value.ok)).toBe(true);
    if (!results[0].ok)
      expect(results[0].code).toBe("QUALITY_PROVIDER_TRANSMISSION_REVIEW_NOT_CURRENT");
    if (!results[1].ok) expect(results[1].code).toMatch(/REVIEW_NOT_CURRENT/);
    expect(store.providerGet(selection.runId).revision).toBe(results[0].ok ? 1 : 0);
    expect(store.providerBudgetGet("production").revision).toBe(
      kind === "reservation" && results[1].ok ? 3 : 2,
    );
  },
  45000,
);
it.each([
  "quality_actual_events",
  "quality_actual_requests",
  "quality_provider_transmission_bindings",
  "before",
  "after",
])(
  "recovers after actual process exit at %s",
  async (phase) => {
    const input = transmissionStoreFixture(store, selection),
      budget = store.providerBudgetGet("production");
    const results = await race([
      {
        ...request(input),
        crashBeforeApprovalCommit: phase === "before",
        crashAfterApprovalCommit: phase === "after",
        crashAfterApprovalInsert: phase.startsWith("quality_") ? phase : undefined,
      },
    ]);
    expect(results[0].crashed).toBe(phase === "before" || phase === "after" ? phase : "insert");
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.providerGet(selection.runId).revision).toBe(phase === "after" ? 1 : 0);
    expect(store.providerTransmissionApprovalLookup(input.command.clientRequestId).state).toBe(
      phase === "after" ? "committed" : "not-observed",
    );
    if (phase === "after") vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const recovered = store.providerApproveTransmission(
      input.command,
      phase === "after" ? null : input.review,
    );
    expect(recovered).toMatchObject({
      newlyCommitted: phase !== "after",
      replayed: phase === "after",
      dispatchAllowed: false,
      budgetWriteAllowed: false,
    });
    expect(store.providerGet(selection.runId).revision).toBe(1);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
  45000,
);
