import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import { actualTestNow, actualTestPreparation } from "./studio-plan-quality-actual-test-helpers";
import type { ActualLedgerStart } from "./studio-plan-quality-actual-ledger-types";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";

let directory: string, store: PlanQualityStore;
const open = () =>
  new PlanQualityStore(directory, {
    actualEnvironment: "synthetic-test",
    providerEnvironment: "synthetic-test",
  });
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  directory = mkdtempSync(join(tmpdir(), "venturepass-provider-store-"));
  writeFileSync(join(directory, "studio.sqlite"), "COMPANY DATA MUST STAY CLOSED");
  store = open();
  store.candidateRegistryRegister({
    clientRequestId: randomUUID(),
    expectedVersion: 0,
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
}, 15000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
    "COMPANY DATA MUST STAY CLOSED",
  );
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const location = resolve(directory),
    rel = relative(resolve(tmpdir()), location);
  if (!rel.startsWith("venturepass-provider-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(location, { recursive: true, force: true });
}, 15000);
function legacyConfigure() {
  return store.actualBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
  });
}
function legacyInput(index = 0): ActualLedgerStart {
  const budget = store.actualBudgetGet(),
    preparation = actualTestPreparation(store.candidateRegistryGet(1), {
      candidateIndex: index,
      ledgerDigest: budget.headDigest!,
      capUnits: budget.capUnits,
      heldUnits: budget.heldUnits,
    });
  return {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    expectedActualRunCount: store.actualList().executions.length,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      acknowledgedSyntheticOnly: true,
      approvedAt: actualTestNow,
    },
  };
}
function db() {
  return new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
}
describe("provider v2 reservation storage", () => {
  it("atomically reserves exact request, approval and budget then cancels without transmission", () => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store),
      started = store.providerStart(input),
      id = started.snapshot.run.id;
    expect(started).toMatchObject({
      newlyCommitted: true,
      replayed: false,
      snapshot: { state: "reserved", actualAiCalls: 0, dispatchAllowed: false, canResume: false },
    });
    expect(store.providerBudgetGet()).toMatchObject({
      heldUnits: "4",
      availableUnits: "96",
      recognizedUnits: "0",
    });
    expect(store.providerArtifact(id).body.toString()).toBe(
      JSON.stringify(input.preparation.generation.body),
    );
    const bytes = store.providerDownload(id, 0).body;
    const cancelled = store.providerCancel(id, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "user-cancelled",
    });
    expect(cancelled.snapshot).toMatchObject({
      state: "cancelled-before-dispatch",
      storage: { heldBytes: 0, remainingBudgetEventSlots: 0, remainingReceiptSlots: 0 },
      dispatchAllowed: false,
    });
    expect(store.providerBudgetGet().heldUnits).toBe("0");
    expect(store.providerDownload(id, 0).body).toBe(bytes);
    expect(store.providerList().executions).toHaveLength(1);
    expect(store.actualList().executions).toHaveLength(0);
  });
  it("preserves v1 archives and numbering while interleaving v2 global counts", () => {
    legacyConfigure();
    providerTestConfigure(store);
    const old = store.actualStart(legacyInput()),
      oldBytes = store.actualDownload(old.snapshot.run.id, 0).body;
    const a = store.providerStart(providerTestStartInput(store));
    expect(a.snapshot.run.expectedGlobalRunCount).toBe(1);
    const before = store.providerDownload(a.snapshot.run.id, 0).body;
    store.providerCancel(a.snapshot.run.id, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "test-cleanup",
    });
    const old2 = store.actualStart(legacyInput(1));
    expect(old2.snapshot.run.expectedActualRunCount).toBe(1);
    const b = store.providerStart(providerTestStartInput(store, 1));
    expect(b.snapshot.run).toMatchObject({ expectedGlobalRunCount: 3, expectedScopeRunCount: 1 });
    expect(store.actualDownload(old.snapshot.run.id, 0).body).toBe(oldBytes);
    expect(store.providerDownload(a.snapshot.run.id, 0).body).toBe(before);
    expect(store.actualBudgetGet().heldUnits).toBe("8");
    expect(store.providerBudgetGet().heldUnits).toBe("4");
    expect(store.providerBudgetGet("production").revision).toBe(0);
    const connection = db();
    expect(inspectQualityDatabase(connection)).toMatchObject({ storageVersion: 6, actualRuns: 4 });
    connection.close();
    store.close();
    store = open();
    expect(store.actualDownload(old.snapshot.run.id, 0).body).toBe(oldBytes);
    expect(store.providerDownload(a.snapshot.run.id, 0).body).toBe(before);
  }, 20000);
  it("replays start and cancel after expiry with no new rows or capabilities", () => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store),
      start = store.providerStart(input);
    const cancel = {
      clientRequestId: randomUUID(),
      expectedRevision: 0 as const,
      reason: "user-cancelled" as const,
    };
    const result = store.providerCancel(start.snapshot.run.id, cancel),
      archive = store.providerDownload(start.snapshot.run.id, 1).body;
    vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    expect(store.providerStart(input)).toMatchObject({
      newlyCommitted: false,
      replayed: true,
      snapshot: { revision: 0, state: "reserved", dispatchAllowed: false },
    });
    expect(store.providerCancel(start.snapshot.run.id, cancel).snapshot.snapshotDigest).toBe(
      result.snapshot.snapshotDigest,
    );
    expect(store.providerDownload(start.snapshot.run.id, 1).body).toBe(archive);
  });
  it("allows cancellation after expiry but rejects new expired preparations", () => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store),
      start = store.providerStart(input),
      expired = providerTestStartInput(store, 1);
    vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    expect(() => store.providerStart(expired)).toThrow();
    expect(
      store.providerCancel(start.snapshot.run.id, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "scope-expired",
      }).snapshot.state,
    ).toBe("cancelled-before-dispatch");
  });
  it.each(["global", "scope", "budget"] as const)("rejects stale %s CAS atomically", (kind) => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store);
    if (kind === "global") input.expectedGlobalRunCount = 1;
    else if (kind === "scope") input.expectedScopeRunCount = 1;
    else input.expectedBudgetDigest = "f".repeat(64);
    const budget = store.providerBudgetGet();
    expect(() => store.providerStart(input)).toThrow();
    expect(store.providerList().executions).toHaveLength(0);
    expect(store.providerBudgetGet()).toEqual(budget);
  });
  it("rejects a changed acknowledgement under same nonce and a second cancellation", () => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store),
      start = store.providerStart(input);
    expect(() =>
      store.providerStart({
        ...input,
        approval: { ...input.approval, expiresAt: "2026-09-27T23:00:00.000Z" },
      }),
    ).toThrow(/요청 번호/);
    store.providerCancel(start.snapshot.run.id, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "user-cancelled",
    });
    expect(() =>
      store.providerCancel(start.snapshot.run.id, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "test-cleanup",
      }),
    ).toThrow(/이미 취소/);
  });
  it("blocks v1 and v2 nonce collisions in both directions", () => {
    const legacy = legacyConfigure(),
      provider = providerTestConfigure(store);
    const v2 = providerTestStartInput(store);
    v2.clientRequestId = legacy.receipt.clientRequestId;
    expect(() => store.providerStart(v2)).toThrow(/요청 번호/);
    const v1 = legacyInput();
    v1.clientRequestId = provider.receipt.clientRequestId;
    expect(() => store.actualStart(v1)).toThrow(/요청 번호/);
    expect(store.actualList().executions).toHaveLength(0);
    expect(store.providerList().executions).toHaveLength(0);
    expect(store.actualBudgetGet().heldUnits).toBe("0");
    expect(store.providerBudgetGet().heldUnits).toBe("0");
  });
  it("rolls back run, artifact, reservation and receipt if artifact storage fails", () => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store),
      before = store.providerBudgetGet();
    const connection = db();
    connection.exec(
      "CREATE TRIGGER injected_provider_failure BEFORE INSERT ON quality_actual_artifacts BEGIN SELECT RAISE(ABORT,'synthetic artifact failure'); END",
    );
    expect(() => store.providerStart(input)).toThrow();
    connection.exec("DROP TRIGGER injected_provider_failure");
    expect(connection.prepare("SELECT COUNT(*) AS n FROM quality_actual_runs").get()!.n).toBe(0);
    connection.close();
    expect(store.providerBudgetGet()).toEqual(before);
    expect(store.providerLookup(input.clientRequestId).state).toBe("not-observed");
  });
  it("enforces shared 32MiB reservations across legacy and v2 records", () => {
    legacyConfigure();
    providerTestConfigure(store);
    for (let i = 0; i < 4; i++) store.actualStart(legacyInput(i));
    for (let i = 0; i < 3; i++) store.providerStart(providerTestStartInput(store, i));
    const last = providerTestStartInput(store, 3),
      before = store.providerBudgetGet();
    expect(() => store.providerStart(last)).toThrow(/용량/);
    expect(store.providerBudgetGet()).toEqual(before);
    const first = store.providerList().executions[0];
    store.providerCancel(first.run.id, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "test-cleanup",
    });
    expect(store.providerStart(providerTestStartInput(store, 3)).snapshot.state).toBe("reserved");
  }, 25000);
  it("default storage remains read-only for v2 mutations and never upgrades v1 dispatch", () => {
    providerTestConfigure(store);
    const input = providerTestStartInput(store),
      start = store.providerStart(input),
      archive = store.providerDownload(start.snapshot.run.id, 0).body;
    expect(() =>
      store.actualRecordFinish(start.snapshot.run.id, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        payload: {
          kind: "execution-stopped",
          outcome: "before-dispatch",
          failureCode: "INTERRUPTED",
          finalArtifactSha256: null,
        },
      }),
    ).toThrow();
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.providerDownload(start.snapshot.run.id, 0).body).toBe(archive);
    expect(() => store.providerStart(input)).toThrow(/아직 연결/);
    expect(() =>
      store.providerCancel(start.snapshot.run.id, {
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        reason: "user-cancelled",
      }),
    ).toThrow(/아직 연결/);
    expect(() =>
      store.providerBudgetConfigure({
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        policy: {
          environment: "production",
          provenance: "explicit-user",
          currency: "USD",
          unitScale: 6,
          capUnits: "10",
        },
      }),
    ).toThrow(/아직 연결/);
  });
});
