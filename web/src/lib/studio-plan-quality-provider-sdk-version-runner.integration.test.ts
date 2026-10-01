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
  providerGenerationSimulationPort,
  recoverQualityProviderGenerationCapture,
  runQualityProviderGenerationSimulation,
} from "./studio-plan-quality-provider-generation-runner";
import {
  providerApprovedSimulationPort,
  recoverQualityProviderReviewCapture,
  runQualityProviderApprovedSimulation,
} from "./studio-plan-quality-provider-approved-runner";
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
const options = (version: typeof v1 | typeof v2 = v2) => ({
  providerEnvironment: "synthetic-test" as const,
  providerPolicySelection: { version, configuration: readFixedProviderConfiguration()! },
  providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: network },
});
const execute = (s = store) => runQualityProviderApprovedSimulation(s, generation);
const snapshot = () => {
  const value = store.providerArchiveGet(generation.runId);
  if (value.archiveFormatVersion !== 5) throw Error("Expected v2 execution snapshot");
  return value;
};
const response = (raw: typeof generationRaw) =>
  Response.json(raw, { headers: { "x-request-id": "synthetic-sdk" } });
function cleanup(p: string) {
  const rel = relative(resolve(tmpdir()), resolve(p));
  if (!rel.startsWith("venture-version-sdk-") || rel.includes("..")) throw Error("Unsafe cleanup");
  rmSync(p, { recursive: true, force: true });
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-sdk-seed-"));
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
    s = new PlanQualityStore(seedRoot, {
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    });
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
  }
  seed = readFileSync(dbPath(seedRoot));
}, 30000);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-version-sdk-"));
  directory = join(root, "data");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(dbPath(directory), seed);
  store = new PlanQualityStore(directory, options());
  await store.providerLoadValidationPlanning();
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
  store.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(forbidden).not.toHaveBeenCalled();
  cleanup(root);
});
afterAll(() => cleanup(seedRoot));

it("runs v2 through both installed SDK calls and r10, preserving v1 history and exact request bytes", async () => {
  const result = await execute();
  expect(result).toMatchObject({
    executionCompleted: true,
    generation: { status: "generation-validated", pendingCapture: null },
    review: {
      status: "completed",
      snapshot: { archiveFormatVersion: 5, revision: 10 },
      pendingCapture: null,
    },
  });
  expect(network).toHaveBeenCalledTimes(2);
  for (const [i, key] of ["generation-request", "review-request"].entries()) {
    const init = network.mock.calls[i][1]!;
    expect(init.body).toBe(store.providerArtifact(generation.runId, key).body.toString());
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer synthetic-provider-sdk-test-only",
    );
    expect(new Headers(init.headers).get("x-stainless-retry-count")).toBe("0");
  }
  expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
  expect(() => store.providerGet(generation.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  const budget = store.providerBudgetGet("production"),
    exported = store.providerDownload(generation.runId, 10).body;
  store.close();
  store = new PlanQualityStore(directory, options(v1));
  vi.setSystemTime("2035-01-01T00:00:00Z");
  const loader = vi
    .spyOn(store, "providerLoadValidationPlanning")
    .mockRejectedValue(Error("No current loader"));
  const validator = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(() => {
    throw Error("No current finalizer");
  });
  const repeat = await execute();
  expect(repeat.executionCompleted).toBe(true);
  expect(repeat.review!.finalization).toEqual(result.review!.finalization);
  expect(store.providerDownload(generation.runId, 10).body).toBe(exported);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(loader).not.toHaveBeenCalled();
  expect(validator).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(2);
}, 30000);

it.each(["generation", "review"] as const)(
  "keeps the %s in-flight owner during concurrent replay",
  async (phase) => {
    if (phase === "review")
      expect((await runQualityProviderGenerationSimulation(store, generation)).status).toBe(
        "generation-validated",
      );
    const previous = network.mock.calls.length;
    let started!: () => void, finish!: (r: Response) => void;
    const start = new Promise<void>((r) => {
      started = r;
    });
    network.mockImplementationOnce(() => {
      started();
      return new Promise<Response>((r) => {
        finish = r;
      });
    });
    const owner = execute();
    await start;
    const other = new PlanQualityStore(directory, options());
    try {
      const repeat = await execute(other);
      expect(repeat.executionCompleted).toBe(false);
      expect(snapshot().revision).toBe(phase === "generation" ? 3 : 7);
      expect(snapshot().terminal).toBe(false);
      expect(network).toHaveBeenCalledTimes(previous + 1);
    } finally {
      other.close();
      finish(response(phase === "generation" ? generationRaw : reviewRaw));
    }
    expect((await owner).executionCompleted).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
  },
  30000,
);

it.each(["generation", "review"] as const)(
  "retains %s capture on persistence failure and recovers without resending",
  async (phase) => {
    const spy =
      phase === "generation"
        ? vi.spyOn(store, "providerRecordGenerationResponse").mockImplementation(() => {
            throw Error("Interrupted storage");
          })
        : vi.spyOn(store, "providerRecordReviewResponse").mockImplementation(() => {
            throw Error("Interrupted storage");
          });
    const first = await execute();
    const pending =
      phase === "generation" ? first.generation.pendingCapture : first.review!.pendingCapture;
    expect(pending).not.toBeNull();
    expect(snapshot().revision).toBe(phase === "generation" ? 3 : 7);
    spy.mockRestore();
    if (phase === "generation") {
      const recovered = recoverQualityProviderGenerationCapture(
        providerGenerationSimulationPort(store),
        pending,
      );
      expect(recovered.status).toBe("generation-validated");
    } else {
      vi.setSystemTime("2035-01-01T00:00:00Z");
      const recovered = recoverQualityProviderReviewCapture(
        providerApprovedSimulationPort(store),
        pending,
      );
      expect(recovered.status).toBe("completed");
    }
    const count = network.mock.calls.length;
    expect((await execute()).executionCompleted).toBe(true);
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? count + 1 : count);
    expect(network).toHaveBeenCalledTimes(2);
  },
  30000,
);

it.each(["generation", "review"] as const)(
  "stops unobserved %s once and accepts a late capture for the original dispatch without reopening",
  async (phase) => {
    if (phase === "review") await runQualityProviderGenerationSimulation(store, generation);
    network.mockImplementationOnce(async () => {
      throw Error("synthetic network failure");
    });
    const first = await execute();
    const stopped = phase === "generation" ? first.generation : first.review!;
    expect(stopped.stop?.outcome).toBe("result-unobserved");
    const calls = network.mock.calls.length;
    const original = stopped.stop;
    const { providerGenerationRunnerNonces } =
      await import("./studio-plan-quality-provider-generation-runner");
    const { providerReviewRunnerScope } =
      await import("./studio-plan-quality-provider-approved-runner");
    const capture =
      phase === "generation"
        ? {
            dispatch: generation,
            responseRequestId: providerGenerationRunnerNonces(generation).responseRequestId,
            response: generationRaw,
          }
        : (() => {
            const g = first.generation.validation!;
            const scope = providerReviewRunnerScope({
              generation: {
                dispatch: g.dispatch,
                responseRequestId: g.responseRequestId,
                responseEventDigest: g.responseEventDigest,
                validationRequestId: g.validationRequestId,
              },
              validationEventDigest: g.validationEventDigest,
            });
            return {
              dispatch: scope.dispatch,
              responseRequestId: scope.nonces.responseRequestId,
              response: reviewRaw,
            };
          })();
    vi.setSystemTime("2035-01-01T00:00:00Z");
    const recovered =
      phase === "generation"
        ? recoverQualityProviderGenerationCapture(providerGenerationSimulationPort(store), capture)
        : recoverQualityProviderReviewCapture(providerApprovedSimulationPort(store), capture);
    expect(recovered.stop).toEqual(original);
    expect(snapshot().terminal).toBe(true);
    const budget = store.providerBudgetGet("production");
    await execute();
    expect(network).toHaveBeenCalledTimes(calls);
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
  30000,
);

it.each(["generation", "review"] as const)(
  "preserves unknown usage and stops %s without an automatic retry",
  async (phase) => {
    delete (phase === "generation" ? generationRaw : reviewRaw).usage;
    const result = await execute(),
      stopped = phase === "generation" ? result.generation : result.review!;
    expect(stopped.stop?.outcome).toBe("needs-cost-review");
    expect(
      BigInt(
        phase === "generation"
          ? result.generation.stop!.generationHeldUnitsAtStop
          : result.review!.stop!.reviewHeldUnitsAtStop,
      ),
    ).toBeGreaterThan(BigInt(0));
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
    await execute();
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
  },
  30000,
);

it.each(["generation", "review"] as const)(
  "stores invalid %s output before its terminal classification",
  async (phase) => {
    (phase === "generation" ? generationRaw : reviewRaw).output = [];
    const result = await execute(),
      stopped = phase === "generation" ? result.generation : result.review!;
    expect(stopped.stop?.outcome).toBe("output-invalid");
    expect(stopped.response?.responsePersisted).toBe(true);
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
  },
  30000,
);

it.each(["before", "after"] as const)(
  "does not create a network owner when generation COMMIT fails %s acknowledgement",
  async (timing) => {
    const originalPrepare = DatabaseSync.prototype.prepare,
      originalExec = DatabaseSync.prototype.exec;
    let armed = false,
      interruptions = 0;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const stmt = originalPrepare.call(this, sql);
      if (sql.startsWith("INSERT INTO quality_actual_events(")) {
        const run = stmt.run.bind(stmt);
        vi.spyOn(stmt, "run").mockImplementation((...args) => {
          const v = run(...args);
          if (args[1] === 3) armed = true;
          return v;
        });
      }
      return stmt;
    });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "COMMIT" && armed) {
        armed = false;
        interruptions++;
        if (timing === "after") originalExec.call(this, sql);
        throw Error("lost acknowledgement");
      }
      return originalExec.call(this, sql);
    });
    expect((await execute()).executionCompleted).toBe(false);
    prepare.mockRestore();
    exec.mockRestore();
    expect(interruptions).toBe(1);
    expect(network).not.toHaveBeenCalled();
    expect(snapshot().revision).toBe(timing === "before" ? 1 : 3);
    if (timing === "after") {
      await execute();
      expect(network).not.toHaveBeenCalled();
    }
  },
  20000,
);

it("preserves a captured SDK response if final writer acknowledgement fails after initiation", async () => {
  const original = DatabaseSync.prototype.exec;
  let failed = false;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const v = original.call(this, sql);
    if (sql === "COMMIT" && network.mock.calls.length === 1 && !failed) {
      failed = true;
      throw Error("lost writer ack");
    }
    return v;
  });
  const result = await execute();
  spy.mockRestore();
  expect(failed).toBe(true);
  expect(result.generation.transport?.finalCheckFailedAfterStart).toBe(true);
  expect(result.executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
}, 30000);

it.each(["version", "configuration", "tokenEvidence", "dispatchAllowed"])(
  "rejects %s command injection before SDK/DB write",
  async (key) => {
    await expect(
      store.providerSimulateGenerationSdkDispatch({ ...generation, [key]: true }),
    ).rejects.toThrow();
    expect(snapshot().revision).toBe(1);
    expect(network).not.toHaveBeenCalled();
  },
);
it("rejects server version mismatch before SDK/DB write", async () => {
  store.close();
  store = new PlanQualityStore(directory, options(v1));
  await store.providerLoadValidationPlanning();
  expect((await execute()).executionCompleted).toBe(false);
  expect(snapshot().revision).toBe(1);
  expect(network).not.toHaveBeenCalled();
}, 15000);
it("keeps default getter and production permission closed, with no ambient network fallback", async () => {
  store.close();
  store = new PlanQualityStore(directory);
  expect(() => store.providerSimulationGet(generation.runId)).toThrow();
  expect(() => store.providerGet(generation.runId)).toThrow();
  await expect(store.providerSimulateGenerationSdkDispatch(generation)).rejects.toThrow();
  expect(snapshot().revision).toBe(1);
  expect(network).not.toHaveBeenCalled();
});
it("exports and restores mixed v1/v2 SDK completion with the same budget and exact bytes", async () => {
  expect((await execute()).executionCompleted).toBe(true);
  const exported = store.providerDownload(generation.runId, 10).body,
    budget = store.providerBudgetGet("production");
  const archive = join(root, "backup.zip"),
    restored = join(root, "restored");
  const db = new DatabaseSync(dbPath(directory), { readOnly: true });
  const usage = inspectQualityDatabase(db);
  db.close();
  await backupQualityData(directory, archive);
  mkdirSync(restored);
  restoreQualityData(archive, restored);
  const restoredStore = new PlanQualityStore(restored, options());
  try {
    expect(restoredStore.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(restoredStore.providerDownload(generation.runId, 10).body).toBe(exported);
    expect(restoredStore.providerBudgetGet("production")).toEqual(budget);
    const restoredDb = new DatabaseSync(dbPath(restored), { readOnly: true });
    expect(inspectQualityDatabase(restoredDb)).toEqual(usage);
    restoredDb.close();
    vi.setSystemTime("2035-01-01T00:00:00Z");
    expect((await execute(restoredStore)).executionCompleted).toBe(true);
  } finally {
    restoredStore.close();
  }
  expect(network).toHaveBeenCalledTimes(2);
}, 60000);
