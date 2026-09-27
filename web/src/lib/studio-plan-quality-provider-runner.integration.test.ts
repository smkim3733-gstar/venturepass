import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import * as builder from "./studio-engine-request-preparation";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";
import {
  providerExecutionTestApproval,
  providerExecutionTestResponse,
} from "./studio-plan-quality-provider-execution-test-helpers";
import {
  runQualityProviderSimulation,
  type ProviderSimulationOptions,
} from "./studio-plan-quality-provider-runner";
import type { ProviderObservationPrepared } from "./studio-provider-observation";
import type { ProviderExecutionCommand } from "./studio-plan-quality-provider-execution-types";
let directory: string,
  store: PlanQualityStore,
  id: string,
  approval: ProviderExecutionCommand<"transmission-approved">,
  options: ProviderSimulationOptions;
let send: ReturnType<typeof vi.fn<(value: ProviderObservationPrepared) => Promise<unknown>>>;
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
  directory = mkdtempSync(join(tmpdir(), "venturepass-provider-runner-"));
  writeFileSync(join(directory, "studio.sqlite"), "customer sentinel");
  store = open();
  const registry = store.candidateRegistryRegister({
    clientRequestId: randomUUID(),
    expectedVersion: 0,
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  providerTestConfigure(store);
  id = store.providerStart(providerTestStartInput(store)).snapshot.run.id;
  approval = providerExecutionTestApproval(store, id);
  const plan = actualTestPlan(registry);
  send = vi.fn(async ({ request }) =>
    providerExecutionTestResponse(request.phase === "generation" ? plan : { findings: [] }),
  );
  options = {
    transport: {
      provenance: "synthetic-test",
      model: "synthetic-provider-model",
      contractDigest: approval.payload.manifest.executionContract.contractDigest,
      send,
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
  const path = resolve(directory),
    rel = relative(resolve(tmpdir()), path);
  if (!rel.startsWith("venturepass-provider-runner-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
}, 15000);
const run = () => runQualityProviderSimulation(store, id, approval, options);
describe("synthetic v2 approved execution runner", () => {
  it("persists two calls, exact original requests and final output while preserving reservation archive", async () => {
    const old = store.providerDownload(id, 0).body,
      result = await run();
    expect(result).toMatchObject({
      replayed: false,
      recordingStatus: "complete",
      failureCode: null,
      snapshot: {
        state: "completed",
        actualAiCalls: 0,
        terminal: true,
        unsettled: false,
        dispatchAllowed: false,
      },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.snapshot.artifacts).toHaveLength(7);
    expect(store.providerArtifact(id).body.toString()).toBe(send.mock.calls[0][0].rawBody);
    expect(store.providerArtifact(id, "review-request").body.toString()).toBe(
      send.mock.calls[1][0].rawBody,
    );
    const draft = JSON.parse(store.providerArtifact(id, "generation-validated").body.toString());
    const review = JSON.parse(store.providerArtifact(id, "review-request").body.toString());
    expect(JSON.parse(review.input[1].content).draft).toEqual(draft.content);
    expect(store.providerBudgetGet()).toMatchObject({
      heldUnits: "0",
      recognizedUnits: "4",
      availableUnits: "96",
    });
    expect(store.providerDownload(id, 0).body).toBe(old);
    const last = store.providerDownload(id, result.snapshot.revision).body;
    store.close();
    store = open();
    expect(store.providerDownload(id, result.snapshot.revision).body).toBe(last);
    expect(store.providerDownload(id, 0).body).toBe(old);
    expect(store.providerStart(providerTestStartInput(store)).snapshot.state).toBe("reserved");
  }, 20000);
  it("grants only the caller that commits approval; concurrent and reopened replay never dispatch", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.recordingStatus).toBe("complete");
    expect(b.replayed).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    store.close();
    store = open();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect((await run()).replayed).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  }, 20000);
  it("does not resume approval committed outside this invocation", async () => {
    store.providerRecordApprove(id, approval);
    expect((await run()).replayed).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(store.providerBudgetGet().heldUnits).toBe("4");
  });
  it("reservation-only, cancelled and default production stores cannot transmit", async () => {
    expect(store.providerGet(id).dispatchAllowed).toBe(false);
    store.providerCancel(id, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "user-cancelled",
    });
    await expect(run()).rejects.toMatchObject({ code: "QUALITY_PROVIDER_APPROVAL_FAILED" });
    store.close();
    store = new PlanQualityStore(directory);
    await expect(run()).rejects.toMatchObject({ code: "QUALITY_PROVIDER_APPROVAL_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["model", "contractDigest"] as const)(
    "rejects changed transport %s before dispatch",
    async (key) => {
      options.transport[key] = "changed";
      expect((await run()).snapshot.state).toBe("before-dispatch");
      expect(send).not.toHaveBeenCalled();
      expect(store.providerBudgetGet().heldUnits).toBe("0");
    },
  );
  it.each(["providerRecordPrepared", "providerRecordDispatch"] as const)(
    "fails %s without sending",
    async (key) => {
      vi.spyOn(store, key).mockImplementation(() => {
        throw new Error("write failed");
      });
      expect((await run()).snapshot.state).toBe("before-dispatch");
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("captures unknown response and preserves generation reservation without follow-up", async () => {
    send.mockImplementation(async () => providerExecutionTestResponse({}, { missingUsage: true }));
    const result = await run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.snapshot.state).toBe("needs-cost-review");
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "2", recognizedUnits: "0" });
    expect(store.providerArtifact(id, "generation-response").body.length).toBeGreaterThan(0);
    expect(() => store.providerStart(providerTestStartInput(store))).toThrow();
  });
  it.each(["model", "service_tier"] as const)("preserves ambiguous %s cost hold", async (key) => {
    send.mockImplementation(async () => ({
      ...providerExecutionTestResponse({}),
      [key]: "unapproved",
    }));
    expect((await run()).snapshot.state).toBe("needs-cost-review");
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet().heldUnits).toBe("2");
  });
  it("recognizes full excessive usage and blocks further dispatch", async () => {
    send.mockImplementation(async () =>
      providerExecutionTestResponse({}, { inputTokens: 200000000, outputTokens: 1 }),
    );
    const result = await run();
    expect(result.snapshot.state).toBe("bound-breached");
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet()).toMatchObject({
      heldUnits: "0",
      recognizedUnits: "201",
      deficitUnits: "101",
      boundBreached: true,
    });
  });
  it("keeps observed cost even when output validation fails", async () => {
    send.mockImplementation(async () => providerExecutionTestResponse({ invalid: true }));
    const result = await run();
    expect(result).toMatchObject({
      failureCode: "OUTPUT_INVALID",
      snapshot: { state: "output-invalid" },
    });
    expect(result.snapshot.events.at(-1)?.payload).toMatchObject({
      kind: "execution-stopped",
      failureCode: "OUTPUT_INVALID",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUnits: "2" });
  });
  it("records response storage failure as unknown and never retries", async () => {
    vi.spyOn(store, "providerRecordResponse").mockImplementation(() => {
      throw new Error("private raw not returned");
    });
    const result = await run();
    expect(result.snapshot.state).toBe("result-unobserved");
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "2", recognizedUnits: "0" });
    expect((await run()).replayed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("returns last confirmed prefix if both response record and budget read fail", async () => {
    vi.spyOn(store, "providerRecordResponse").mockImplementation(() => {
      vi.spyOn(store, "providerBudgetGet").mockImplementation(() => {
        throw new Error("budget read failed");
      });
      throw new Error("response write failed");
    });
    const result = await run();
    expect(result).toMatchObject({
      recordingStatus: "last-confirmed",
      failureCode: "RECORDING_UNCONFIRMED",
      snapshot: { state: "dispatching" },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("retains a late original response after unknown stop without domain validation or review", async () => {
    const response = providerExecutionTestResponse(actualTestPlan(store.candidateRegistryGet(1)));
    send.mockImplementation(async () => {
      store.providerRecordFinish(id, {
        clientRequestId: randomUUID(),
        expectedRevision: store.providerGet(id).revision,
        payload: {
          kind: "execution-stopped",
          outcome: "result-unobserved",
          failureCode: "INTERRUPTED",
          finalArtifactSha256: null,
        },
      });
      return response;
    });
    const result = await run();
    expect(result).toMatchObject({
      recordingStatus: "last-confirmed",
      failureCode: "LATE_RESPONSE_RECORDED",
      snapshot: { state: "result-unobserved" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUnits: "2" });
    expect(result.snapshot.events.some((v) => v.payload.kind === "domain-validated")).toBe(false);
  });
  it("preserves caller approval and captures response arriving after expiry without follow-up", async () => {
    const original = structuredClone(approval);
    const response = providerExecutionTestResponse(actualTestPlan(store.candidateRegistryGet(1)));
    send.mockImplementation(async () => {
      approval.payload.manifest.executionContract.contractDigest = "0".repeat(64);
      vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
      return response;
    });
    const result = await run();
    expect(result).toMatchObject({
      recordingStatus: "stopped",
      failureCode: "INTERRUPTED",
      snapshot: { state: "output-invalid" },
    });
    expect(result.snapshot.events.at(-1)?.payload).toMatchObject({
      kind: "execution-stopped",
      outcome: "output-invalid",
      failureCode: "INTERRUPTED",
    });
    expect(result.snapshot.events[0].payload).toEqual(original.payload);
    expect(
      JSON.parse(store.providerArtifact(id, "generation-response").body.toString("utf8")),
    ).toEqual({ captureKind: "sdk-response-json-v2", response });
    expect(result.snapshot.events.some((event) => event.payload.kind === "domain-validated")).toBe(
      false,
    );
    expect(
      result.snapshot.events.some(
        (event) => "phase" in event.payload && event.payload.phase === "review",
      ),
    ).toBe(false);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUnits: "2" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records cost when engine changes during response then blocks next phase", async () => {
    const contract = builder.getPlanExecutionContract();
    send.mockImplementation(async () => {
      vi.spyOn(builder, "getPlanExecutionContract").mockReturnValue({
        ...contract,
        contractDigest: "a".repeat(64),
      });
      return providerExecutionTestResponse(actualTestPlan(store.candidateRegistryGet(1)));
    });
    const result = await run();
    expect(result).toMatchObject({
      failureCode: "INTERRUPTED",
      snapshot: { state: "output-invalid" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUnits: "2" });
  });
  // This path durably records both phases, rereads both artifacts, then replays.
  // Windows filesystem flushes can exceed the default 5 s without a failed assertion.
  it(
    "keeps both original validated outputs if final record and fallback fail",
    async () => {
      vi.spyOn(store, "providerRecordFinish").mockImplementation(() => {
        throw new Error("final storage unavailable");
      });
      const result = await run();
      expect(result).toMatchObject({
        recordingStatus: "last-confirmed",
        failureCode: "RECORDING_UNCONFIRMED",
        snapshot: { state: "validated" },
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(store.providerArtifact(id, "generation-validated").body.length).toBeGreaterThan(0);
      expect(store.providerArtifact(id, "review-validated").body.length).toBeGreaterThan(0);
      expect(store.providerBudgetGet()).toMatchObject({ heldUnits: "0", recognizedUnits: "4" });
      expect((await run()).replayed).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    },
    process.platform === "win32" ? 15000 : 5000,
  );
});
