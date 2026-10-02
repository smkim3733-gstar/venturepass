/** Real installed SDK, injected synthetic fetch and isolated SQLite. No actual credential/network. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External IO forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import {
  createVersionedProviderProductionRuntime,
  createProviderProductionRuntime,
  revokeProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import * as server from "./studio-plan-quality-provider-production-server";
import { ProviderProductionExecutionService } from "./studio-plan-quality-provider-production-service";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as engine from "./studio-engine";
import {
  backupQualityData,
  restoreQualityData,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
let seedRoot: string, seed: Buffer, oldId: string, oldExport: string;
let generation: ProviderGenerationDispatchIdentity, root: string, directory: string;
let store: PlanQualityStore;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const network = vi.fn<typeof fetch>();
const dbPath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
const key = "sk-synthetic-version-production-test-only";
let runtime: ProviderProductionRuntime;
const execute = () => store.providerRunApprovedProduction(generation);
const selection = () => ({
  runId: generation.runId,
  runDigest: generation.runDigest,
  approvalBindingDigest: generation.approvalBindingDigest,
});
function reopen(version: typeof v1 | typeof v2 | "default" = v2) {
  store.close();
  revokeProviderProductionRuntime(runtime);
  runtime =
    version === "default"
      ? createProviderProductionRuntime()
      : createVersionedProviderProductionRuntime(version);
  store = new PlanQualityStore(directory, { providerProductionRuntime: runtime });
}
const snapshot = () => {
  const value = store.providerArchiveGet(generation.runId);
  if (value.archiveFormatVersion !== 5) throw Error("Expected v2 execution snapshot");
  return value;
};
const response = (raw: typeof generationRaw) =>
  Response.json(raw, { headers: { "x-request-id": "synthetic-sdk" } });
function cleanup(p: string) {
  const rel = relative(resolve(tmpdir()), resolve(p));
  if (!rel.startsWith("venture-version-production-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(p, { recursive: true, force: true });
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-production-seed-"));
  let s = new PlanQualityStore(seedRoot, { providerEnvironment: "synthetic-test" });
  try {
    s.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: s.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const legacy = await finalizationStoreFixture(s);
    s.providerRecordFinalization(legacy.identity);
    const oldFinal = legacy.identity;
    oldId = oldFinal.validation.dispatch.generation.dispatch.runId;
    oldExport = s.providerDownload(oldId, 10).body;
    s.close();
    vi.stubEnv("OPENAI_API_KEY", key);
    vi.stubEnv("VENTURE_DATA_DIR", seedRoot);
    runtime = createVersionedProviderProductionRuntime(v2);
    s = new PlanQualityStore(seedRoot, { providerProductionRuntime: runtime });
    vi.setSystemTime("2026-09-27T03:32:00.000Z");
    const registry = s.candidateRegistryGet(1),
      candidateId = registry.entries[1].candidateId;
    const { result, expectedPolicyHead } = s.providerPolicyReview(1, candidateId);
    if (result.status !== "review") throw Error(result.reason);
    s.providerPolicyAdopt(
      providerPolicyAdoptionCommandSchema.parse({
        commandVersion: 1,
        kind: "adopt-provider-policy",
        clientRequestId: randomUUID(),
        version: 1,
        versionDigest: registry.versionDigest,
        candidateId,
        expectedPolicyHead,
        approvedReviewDigest: result.review.reviewDigest,
        budgetAction: "keep-existing-budget",
        initialBudgetRequestId: null,
        approval: {
          noticeVersion: 1,
          acknowledgedPolicy: true,
          acknowledgedBudgetAction: true,
          reservationAndTransmission: "separate-approval-required",
          approvedAt: new Date().toISOString(),
        },
      }),
      result.review,
    );
    const r = reservationStoreFixture(s, 1),
      reserved = s.providerReserve(r.command, r.review);
    vi.setSystemTime("2026-09-27T03:33:00.000Z");
    const a = transmissionStoreFixture(s, reserved.record),
      approved = s.providerApproveTransmission(a.command, a.review).record;
    generation = {
      runId: approved.runId,
      runDigest: approved.runDigest,
      approvalBindingDigest: approved.recordDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    };
  } finally {
    s.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    revokeProviderProductionRuntime(runtime);
  }
  seed = readFileSync(dbPath(seedRoot));
}, 30000);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-version-production-"));
  directory = join(root, "data");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(dbPath(directory), seed);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubEnv("VENTURE_DATA_DIR", directory);
  vi.stubGlobal("fetch", network);
  runtime = createVersionedProviderProductionRuntime(v2);
  store = new PlanQualityStore(directory, { providerProductionRuntime: runtime });
  generationRaw = generationResponseFixture(generation).response;
  generationRaw.output = [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify(actualTestPlan(store.candidateRegistryGet(1), 1)),
        },
      ],
    },
  ];
  reviewRaw = { ...generationResponseFixture(generation).response, id: "synthetic-review" };
  setReviewValidationOutput(reviewRaw);
  network.mockReset();
  network.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return response(body.text.format.name.includes("review") ? reviewRaw : generationRaw);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  server.retireProviderProductionServer();
  if (server.inspectProviderProductionServer().retainedCaptures)
    server.recoverProviderProductionSelection(selection());
  expect(server.retireProviderProductionServer().retainedCaptures).toBe(0);
  store.close();
  revokeProviderProductionRuntime(runtime);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(forbidden).not.toHaveBeenCalled();
  cleanup(root);
});
afterAll(() => cleanup(seedRoot));

it.each(["DELETE", "WAL"])(
  "executes selected v2 through production owner under %s and preserves completed history",
  async (journal) => {
    const db = new DatabaseSync(dbPath(directory));
    let dbOpen = true;
    try {
      db.exec(`PRAGMA journal_mode=${journal}; PRAGMA busy_timeout=0`);
      network.mockImplementation(async (url, init) => {
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
        expect(new Headers(init?.headers).get("x-stainless-retry-count")).toBe("0");
        expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
        const phase = network.mock.calls.length === 1 ? "generation" : "review";
        const row = db
          .prepare("SELECT payload FROM quality_actual_artifacts WHERE run_id=? AND artifact_key=?")
          .get(generation.runId, `${phase}-request`);
        expect(init?.body).toBe(Buffer.from(row!.payload as Uint8Array).toString());
        return response(phase === "generation" ? generationRaw : reviewRaw);
      });
      expect(store.providerProductionGenerationReadiness(generation).status).toBe(
        "ready-for-writer-check",
      );
      const result = await execute();
      expect(result).toMatchObject({
        executionCompleted: true,
        review: { finalization: { revision: 10 }, pendingCapture: null },
      });
      expect(snapshot().state).toBe("completed");
      expect(network).toHaveBeenCalledTimes(2);
      expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
      expect(
        store.providerProductionStatus({
          runId: generation.runId,
          runDigest: generation.runDigest,
        }),
      ).toMatchObject({ status: "completed", lastAuditedRevision: 10 });
      expect(() => store.providerGet(generation.runId)).toThrow(
        expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
      );
      const budget = store.providerBudgetGet("production");
      db.close();
      dbOpen = false;
      reopen(v1);
      const bytes = readFileSync(dbPath(directory));
      vi.setSystemTime("2035-01-01T00:00:00Z");
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
      vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(forbidden);
      expect((await execute()).executionCompleted).toBe(true);
      expect(store.providerBudgetGet("production")).toEqual(budget);
      expect(readFileSync(dbPath(directory))).toEqual(bytes);
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      if (dbOpen) db.close();
    }
  },
  45000,
);

it.each(["default", v1] as const)(
  "does not authorize stored v2 with %s runtime",
  async (version) => {
    reopen(version);
    const bytes = readFileSync(dbPath(directory));
    if (version === "default") await expect(execute()).rejects.toThrow();
    else expect((await execute()).executionCompleted).toBe(false);
    expect(readFileSync(dbPath(directory))).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
  },
);

it("rejects caller configuration, fake runtime, synthetic options and direct writes before any send", async () => {
  const nonexistent = join(root, "never-created");
  expect(
    () =>
      new PlanQualityStore(nonexistent, {
        providerProductionRuntime: runtime,
        providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
      }),
  ).toThrow("PROVIDER_PRODUCTION_VERSION_SELECTION_UNSUPPORTED");
  expect(
    () => new PlanQualityStore(nonexistent, { providerProductionRuntime: { ...runtime } }),
  ).toThrow("PROVIDER_PRODUCTION_RUNTIME_UNAVAILABLE");
  expect(
    () =>
      new PlanQualityStore(nonexistent, {
        providerProductionRuntime: runtime,
        providerEnvironment: "synthetic-test",
      }),
  ).toThrow("PROVIDER_PRODUCTION_RUNTIME_TEST_MIXED");
  expect(() => store.providerRecordGenerationResponse(null)).toThrow();
  await expect(store.providerSimulateGenerationSdkDispatch(generation)).rejects.toThrow();
  await expect(
    store.providerRunApprovedProduction({ ...generation, version: v2 }),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});

it.each(["generation", "review"] as const)(
  "retains %s capture in service owner and recovers once after credential expiry",
  async (phase) => {
    const service = new ProviderProductionExecutionService(store);
    const method = phase === "generation" ? "recordResponse" : "recordReviewResponse";
    const spy = vi
      .spyOn(ProviderGenerationDispatchStore.prototype, method)
      .mockImplementation(() => {
        throw Error("synthetic storage failure");
      });
    const result = await service.execute(selection());
    expect(result.executionCompleted).toBe(false);
    expect(service.retention()).toMatchObject({ retainedCaptures: 1, activeExecutions: 0 });
    expect(snapshot().revision).toBe(phase === "generation" ? 3 : 7);
    spy.mockRestore();
    const count = network.mock.calls.length;
    vi.setSystemTime("2035-01-01T00:00:00Z");
    revokeProviderProductionRuntime(runtime);
    service.recover(selection());
    expect(service.retention().retainedCaptures).toBe(0);
    expect(snapshot().revision).toBe(phase === "generation" ? 5 : 10);
    const budget = store.providerBudgetGet("production");
    service.recover(selection());
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(network).toHaveBeenCalledTimes(count);
  },
  30000,
);

it.each(["generation", "review"] as const)(
  "stops unobserved %s with no retry and preserves its hold",
  async (phase) => {
    network.mockImplementation(async (_url, init) => {
      const review = JSON.parse(String(init?.body)).text.format.name.includes("review");
      if (review === (phase === "review")) throw Error("synthetic network failure");
      return response(generationRaw);
    });
    const result = await execute();
    expect((phase === "generation" ? result.generation : result.review)?.stop?.outcome).toBe(
      "result-unobserved",
    );
    expect(snapshot().unsettled).toBe(true);
    const count = network.mock.calls.length,
      budget = store.providerBudgetGet("production");
    await execute();
    expect(network).toHaveBeenCalledTimes(count);
    expect(count).toBe(phase === "generation" ? 1 : 2);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
  30000,
);

it("preserves the same budget and raw bytes through completed production-path backup and restore", async () => {
  expect((await execute()).executionCompleted).toBe(true);
  const exported = store.providerDownload(generation.runId, 10).body,
    budget = store.providerBudgetGet("production");
  const backup = join(root, "backup.zip"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  await restoreQualityData(backup, restored);
  const restoredDb = new DatabaseSync(dbPath(restored), { readOnly: true });
  try {
    expect(inspectQualityDatabase(restoredDb)).toBeDefined();
  } finally {
    restoredDb.close();
  }
  const restoredStore = new PlanQualityStore(restored);
  try {
    expect(restoredStore.providerDownload(generation.runId, 10).body).toBe(exported);
    expect(restoredStore.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(restoredStore.providerBudgetGet("production")).toEqual(budget);
  } finally {
    restoredStore.close();
  }
  expect(network).toHaveBeenCalledTimes(2);
}, 60000);

it("installs v2 only at the server composition root and exposes safe completed status", async () => {
  for (const args of [[], [undefined], ["plan-observation-v3"], [v2, {}]]) {
    expect(() =>
      Reflect.apply(server.installVersionedProviderProductionServer, null, args),
    ).toThrow("PROVIDER_PRODUCTION_SERVER_INSTALL_FORBIDDEN");
  }
  expect(server.installVersionedProviderProductionServer(v2)).toMatchObject({
    status: "ready",
    retainedCaptures: 0,
  });
  expect(network).not.toHaveBeenCalled();
  expect(() => server.installProviderProductionServer()).toThrow(
    "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
  );
  const result = await server.executeProviderProductionSelection(selection());
  expect(result).toMatchObject({ executionCompleted: true, lastAuditedRevision: 10 });
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain("output_text");
  expect(network).toHaveBeenCalledTimes(2);
}, 30000);

it("retains the installed v2 owner through retirement until capture recovery", async () => {
  server.installVersionedProviderProductionServer(v2);
  const fault = vi
    .spyOn(ProviderGenerationDispatchStore.prototype, "recordResponse")
    .mockImplementation(() => {
      throw Error("storage failure");
    });
  expect((await server.executeProviderProductionSelection(selection())).status).toBe(
    "capture-recovery-required",
  );
  expect(server.retireProviderProductionServer()).toMatchObject({
    status: "draining",
    retainedCaptures: 1,
  });
  expect(() => server.installVersionedProviderProductionServer(v1)).toThrow(
    "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
  );
  fault.mockRestore();
  vi.setSystemTime("2035-01-01T00:00:00Z");
  expect(server.recoverProviderProductionSelection(selection())).toMatchObject({
    lastAuditedRevision: 5,
    executionCompleted: false,
  });
  expect(server.inspectProviderProductionServer()).toMatchObject({
    status: "closed",
    retainedCaptures: 0,
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 30000);

it("keeps duplicate original invocation from acquiring the in-flight send owner", async () => {
  let start!: () => void, finish!: (r: Response) => void;
  const began = new Promise<void>((r) => {
    start = r;
  });
  network.mockImplementationOnce(() => {
    start();
    return new Promise((r) => {
      finish = r;
    });
  });
  const owner = execute();
  await began;
  const loader = vi
    .spyOn(ProviderGenerationDispatchStore.prototype, "loadValidationPlanning")
    .mockRejectedValue(Error("Current loader unavailable"));
  try {
    const second = await execute();
    expect(loader).not.toHaveBeenCalled();
    expect(second.executionCompleted).toBe(false);
    expect(second.generation.pendingCapture).toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
  } finally {
    loader.mockRestore();
    finish(response(generationRaw));
  }
  expect((await owner).executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
}, 30000);
