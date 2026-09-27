import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Forbidden external IO");
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
import * as engine from "./studio-engine";
import {
  runQualityActualSimulation,
  type QualityActualSimulationOptions,
} from "./studio-plan-quality-actual-runner";
import {
  actualTestNow,
  actualTestPlan,
  actualTestPreparation,
  actualTestResponse,
} from "./studio-plan-quality-actual-test-helpers";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import type { ActualLedgerStart } from "./studio-plan-quality-actual-ledger-types";
import type { EngineExecutionTransportRequest } from "./studio-engine-execution-types";

let directory: string, store: PlanQualityStore, start: ActualLedgerStart;
let options: QualityActualSimulationOptions;
let send: ReturnType<typeof vi.fn<(value: EngineExecutionTransportRequest) => Promise<unknown>>>;
let measure: ReturnType<
  typeof vi.fn<(value: EngineExecutionTransportRequest) => number | Promise<number>>
>;
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  directory = mkdtempSync(join(tmpdir(), "venturepass-actual-runner-"));
  writeFileSync(join(directory, "studio.sqlite"), "customer sentinel");
  store = new PlanQualityStore(directory, { actualEnvironment: "synthetic-test" });
  const registry = store.candidateRegistryRegister({
    clientRequestId: randomUUID(),
    expectedVersion: 0,
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  const budget = store.actualBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
  }).budget;
  const preparation = actualTestPreparation(registry, {
    capUnits: budget.capUnits,
    heldUnits: budget.heldUnits,
    ledgerDigest: budget.headDigest!,
  });
  start = {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    expectedActualRunCount: 0,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      acknowledgedSyntheticOnly: true,
      approvedAt: actualTestNow,
    },
  };
  const plan = actualTestPlan(registry);
  send = vi.fn(async ({ request }: EngineExecutionTransportRequest) =>
    actualTestResponse(request.phase === "generation" ? plan : { findings: [] }),
  );
  measure = vi.fn(({ request }: EngineExecutionTransportRequest) =>
    request.phase === "generation" ? 10 : 20,
  );
  options = {
    transport: {
      provenance: "synthetic-test",
      model: preparation.model!,
      contractDigest: preparation.engine.contractDigest,
      send,
    },
    tokenAdapter: {
      provenance: "synthetic-test",
      model: preparation.model!,
      contractDigest: preparation.engine.contractDigest,
      evidenceDigest: digest(preparation.evidence.tokens),
      tokenizerId: preparation.evidence.tokens!.tokenizerId,
      tokenizerVersion: preparation.evidence.tokens!.tokenizerVersion,
      measure,
    },
  };
}, 15000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("customer sentinel");
  vi.restoreAllMocks();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-actual-runner-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
}, 15000);

describe("synthetic cost-ledger observed-engine runner", () => {
  it("durably connects exact requests, two responses, original validation and final output", async () => {
    const result = await runQualityActualSimulation(store, start, options);
    expect(result).toMatchObject({
      replayed: false,
      recordingStatus: "complete",
      failureCode: null,
      snapshot: { state: "completed", actualAiCalls: 0, costState: "settled" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledTimes(2);
    const id = result.snapshot.run.id;
    expect(result.snapshot.events.map((event) => event.payload.kind)).toEqual([
      "request-prepared",
      "dispatch-intent",
      "response-received",
      "domain-validated",
      "request-prepared",
      "dispatch-intent",
      "response-received",
      "domain-validated",
      "execution-stopped",
    ]);
    expect(result.snapshot.artifacts).toHaveLength(7);
    const generation = JSON.parse(store.actualArtifact(id, "generation-validated").body.toString());
    const review = JSON.parse(store.actualArtifact(id, "review-request").body.toString());
    expect(JSON.parse(review.input[1].content).draft).toEqual(generation.content);
    expect(store.actualArtifact(id, "generation-request").body.toString()).toBe(
      JSON.stringify(send.mock.calls[0][0].body),
    );
    expect(store.actualArtifact(id, "review-request").body.toString()).toBe(
      JSON.stringify(send.mock.calls[1][0].body),
    );
    expect(store.actualBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUsageUnits: "4" });
    const archive = store.actualDownload(id, result.snapshot.revision).body;
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.actualDownload(id, result.snapshot.revision).body).toBe(archive);
    expect(store.actualArtifact(id, "final-result").body.length).toBeGreaterThan(0);
  });
  it("permits only the caller that commits start; concurrent and historical replays invoke no adapters", async () => {
    const [first, second] = await Promise.all([
      runQualityActualSimulation(store, start, options),
      runQualityActualSimulation(store, start, options),
    ]);
    expect(first.recordingStatus).toBe("complete");
    expect(second.replayed).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    const again = await runQualityActualSimulation(store, start, options);
    expect(again.replayed).toBe(true);
    expect(again.snapshot.state).toBe("completed");
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.actualList().executions).toHaveLength(1);
  });
  it("does not resume a start previously committed outside this invocation", async () => {
    store.actualStart(start);
    expect((await runQualityActualSimulation(store, start, options)).replayed).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
  });
  it("redacts a failed start and never invokes the engine or adapters", async () => {
    vi.spyOn(store, "actualStart").mockImplementation(() => {
      throw new Error("secret customer raw provider text");
    });
    await expect(runQualityActualSimulation(store, start, options)).rejects.toMatchObject({
      code: "QUALITY_ACTUAL_START_FAILED",
    });
    expect(send).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
  });
  it.each(["evidenceDigest", "model", "tokenizerVersion", "contractDigest"] as const)(
    "rejects a changed token adapter %s without sending",
    async (key) => {
      options.tokenAdapter[key] = "changed";
      const result = await runQualityActualSimulation(store, start, options);
      expect(result.snapshot.state).toBe("stopped-before-dispatch");
      expect(send).not.toHaveBeenCalled();
      expect(store.actualBudgetGet().heldUnits).toBe("0");
    },
  );
  it.each(["generation", "review"] as const)(
    "blocks a measured %s request above its pinned token bound",
    async (phase) => {
      measure.mockImplementation((value) => (value.request.phase === phase ? 21 : 10));
      const result = await runQualityActualSimulation(store, start, options);
      expect(send).toHaveBeenCalledTimes(phase === "generation" ? 0 : 1);
      expect(result.recordingStatus).toBe("stopped");
      expect(store.actualBudgetGet().heldUnits).toBe("0");
    },
  );
  it.each([
    "actualRecordPrepared",
    "actualRecordDispatch",
    "actualRecordResponse",
    "actualRecordValidated",
  ] as const)("preserves the last durable stage when %s fails", async (method) => {
    vi.spyOn(store, method).mockImplementation(() => {
      throw new Error("private raw failure");
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).toHaveBeenCalledTimes(
      ["actualRecordPrepared", "actualRecordDispatch"].includes(method) ? 0 : 1,
    );
    expect(result.recordingStatus).toBe("stopped");
    if (method === "actualRecordResponse") {
      expect(result.snapshot.state).toBe("result-unobserved");
      expect(store.actualBudgetGet()).toMatchObject({ heldUnits: "2", recognizedUsageUnits: "0" });
    }
    if (method === "actualRecordValidated") {
      expect(result.snapshot.state).toBe("stopped-output-invalid");
      expect(store.actualBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUsageUnits: "2" });
      expect(result.snapshot.artifacts.some((item) => item.key === "generation-response")).toBe(
        true,
      );
    }
    expect(JSON.stringify(result)).not.toContain("private raw failure");
  });
  it("does not send after dispatch commits but its return is lost", async () => {
    const original = store.actualRecordDispatch.bind(store);
    vi.spyOn(store, "actualRecordDispatch").mockImplementation((...args) => {
      original(...args);
      throw new Error("result lost");
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).not.toHaveBeenCalled();
    expect(result.snapshot.state).toBe("result-unobserved");
    expect(store.actualBudgetGet().heldUnits).toBe("2");
  });
  it("rechecks evidence expiry after dispatch commits and before calling transport", async () => {
    const original = store.actualRecordDispatch.bind(store);
    vi.spyOn(store, "actualRecordDispatch").mockImplementation((...args) => {
      const result = original(...args);
      vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
      return result;
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).not.toHaveBeenCalled();
    expect(result.snapshot.state).toBe("result-unobserved");
    expect(store.actualBudgetGet().heldUnits).toBe("2");
  });
  it("returns only confirmed records when even failure recording is unavailable", async () => {
    vi.spyOn(store, "actualRecordFinish").mockImplementation(() => {
      throw new Error("disk offline");
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.recordingStatus).toBe("last-confirmed");
    expect(result.snapshot.state).toBe("domain-validated");
    expect(result.snapshot.artifacts.some((item) => item.key === "final-result")).toBe(false);
    expect(store.actualGet(result.snapshot.run.id).snapshotDigest).toBe(
      result.snapshot.snapshotDigest,
    );
  });
  it.each(["missing", "model", "excess", "invalid-output"])(
    "retains response and recognized cost with %s while blocking review",
    async (kind) => {
      const plan = actualTestPlan(store.candidateRegistryGet(1));
      send.mockImplementation(async () =>
        actualTestResponse(kind === "invalid-output" ? { ...plan, sections: [] } : plan, {
          missingUsage: kind === "missing",
          model: kind === "model" ? "wrong-model" : undefined,
          inputTokens: kind === "excess" ? 12000000 : 1,
        }),
      );
      const result = await runQualityActualSimulation(store, start, options);
      expect(send).toHaveBeenCalledTimes(1);
      expect(result.snapshot.artifacts.some((item) => item.key === "generation-response")).toBe(
        true,
      );
      expect(result.snapshot.state).toBe(
        kind === "excess"
          ? "stopped-bound-breached"
          : kind === "invalid-output"
            ? "stopped-output-invalid"
            : "stopped-needs-cost-review",
      );
      expect(store.actualBudgetGet().recognizedUsageUnits).toBe(
        kind === "excess" ? "13" : kind === "invalid-output" ? "2" : "0",
      );
    },
  );
  it("checks current engine after asynchronous token work before dispatch", async () => {
    const contract = engine.getPlanExecutionContract();
    measure.mockImplementation(() => {
      vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
        ...contract,
        contractDigest: "a".repeat(64),
      });
      return 10;
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).not.toHaveBeenCalled();
    expect(result.snapshot.state).toBe("stopped-before-dispatch");
  });
  it("preserves a late response after another caller stops the original dispatch without validating or reviewing", async () => {
    const plan = actualTestPlan(store.candidateRegistryGet(1));
    send.mockImplementation(async () => {
      const current = store.actualList().executions[0];
      store.actualStop(current.run.id, {
        clientRequestId: randomUUID(),
        expectedRevision: current.revision,
        payload: {
          kind: "execution-stopped",
          outcome: "result-unobserved",
          failureCode: "INTERRUPTED",
          finalArtifactSha256: null,
        },
      });
      return actualTestResponse(plan);
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      recordingStatus: "last-confirmed",
      failureCode: "LATE_RESPONSE_RECORDED",
      snapshot: { state: "response-received" },
    });
    expect(
      result.snapshot.events.filter((item) => item.payload.kind === "domain-validated"),
    ).toHaveLength(0);
    expect(result.snapshot.artifacts.some((item) => item.key === "generation-response")).toBe(true);
    expect(store.actualBudgetGet()).toMatchObject({ recognizedUsageUnits: "2", heldUnits: "0" });
    expect(
      result.snapshot.events.filter((item) => item.payload.kind === "execution-stopped"),
    ).toHaveLength(1);
  });
  it("records response usage even when the current engine changes during transport", async () => {
    const contract = engine.getPlanExecutionContract(),
      plan = actualTestPlan(store.candidateRegistryGet(1));
    send.mockImplementation(async () => {
      vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
        ...contract,
        contractDigest: "a".repeat(64),
      });
      return actualTestResponse(plan);
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.snapshot.artifacts.some((item) => item.key === "generation-response")).toBe(true);
    expect(result.snapshot.events.some((item) => item.payload.kind === "domain-validated")).toBe(
      false,
    );
    expect(result.failureCode).toBe("INTERRUPTED");
    expect(store.actualBudgetGet()).toMatchObject({ recognizedUsageUnits: "2", heldUnits: "0" });
  });
  it("checks the current run after asynchronous token work without overwriting a newer stop", async () => {
    measure.mockImplementation(() => {
      const current = store.actualList().executions[0];
      store.actualRecordFinish(current.run.id, {
        clientRequestId: randomUUID(),
        expectedRevision: current.revision,
        payload: {
          kind: "execution-stopped",
          outcome: "before-dispatch",
          failureCode: "INTERRUPTED",
          finalArtifactSha256: null,
        },
      });
      return 10;
    });
    const result = await runQualityActualSimulation(store, start, options);
    expect(send).not.toHaveBeenCalled();
    expect(result.snapshot.events).toHaveLength(1);
    expect(result.snapshot.state).toBe("stopped-before-dispatch");
  });
});
