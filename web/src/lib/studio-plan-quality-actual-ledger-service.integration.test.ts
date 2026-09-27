import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPreparation } from "./studio-plan-quality-actual-test-helpers";
import type { ActualLedgerStart } from "./studio-plan-quality-actual-ledger-types";

const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("Forbidden provider or customer IO");
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => {
    state.opened();
    return state.store!;
  },
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: state.forbidden,
  StudioStore: state.forbidden,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.forbidden();
    }
  },
}));
import * as overviewRoute from "@/app/api/studio/quality/actual-ledger/route";
import { GET as get } from "@/app/api/studio/quality/actual-ledger/runs/[runId]/route";
import { GET as revision } from "@/app/api/studio/quality/actual-ledger/runs/[runId]/revisions/[revision]/route";
import { GET as download } from "@/app/api/studio/quality/actual-ledger/runs/[runId]/revisions/[revision]/download/route";
import { GET as artifact } from "@/app/api/studio/quality/actual-ledger/runs/[runId]/artifacts/[artifactKey]/route";
import { GET as lookup } from "@/app/api/studio/quality/actual-ledger/requests/[clientRequestId]/route";
import { POST as prepare } from "@/app/api/studio/quality/actual-preparation/route";
import { qualityActualLedgerRoute } from "./studio-plan-quality-actual-ledger-service";

let directory: string, store: PlanQualityStore, input: ActualLedgerStart, runId: string;
const base = "http://127.0.0.1:3000/api/studio/quality/actual-ledger";
const request = (suffix = "", init?: RequestInit) => new Request(base + suffix, init);
const context = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  directory = mkdtempSync(join(tmpdir(), "venturepass-actual-api-"));
  writeFileSync(join(directory, "studio.sqlite"), "company unchanged");
  store = new PlanQualityStore(directory, { actualEnvironment: "synthetic-test" });
  const registry = store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  }).snapshot;
  store.actualBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
  });
  const budget = store.actualBudgetGet();
  const preparation = actualTestPreparation(registry, {
    preparedAt: new Date().toISOString(),
    capUnits: budget.capUnits,
    heldUnits: budget.heldUnits,
    ledgerDigest: budget.headDigest!,
  });
  input = {
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
  runId = store.actualStart(input).snapshot.run.id;
  store.close();
  // Reads use the default production store. Persisted synthetic evidence grants no write capability.
  store = new PlanQualityStore(directory);
  state.store = store;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", state.forbidden);
}, 15000);
afterEach(() => {
  vi.useRealTimers();
  store.close();
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("company unchanged");
  vi.unstubAllGlobals();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venturepass-actual-api-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});

describe("local read-only actual ledger routes", () => {
  it("shows synthetic evidence and never reconstructs a dispatch grant", async () => {
    const response = await overviewRoute.GET(request());
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.actualExecutionEnabled).toBe(false);
    expect(body.budget.heldUnits).toBe("4");
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0].run.executionKind).toBe("actual-ledger-simulation");
    expect(body.executions[0].actualAiCalls).toBe(0);
    const current = await (await get(request(), context({ runId }))).json();
    const old = await (await revision(request(), context({ runId, revision: "0" }))).json();
    expect(current).toEqual(old);
    expect(current).not.toHaveProperty("newlyCommitted");
    const receipt = await (
      await lookup(request(), context({ clientRequestId: input.clientRequestId }))
    ).json();
    expect(receipt.state).toBe("committed");
    expect(receipt).not.toHaveProperty("newlyCommitted");
    expect(
      await (await lookup(request(), context({ clientRequestId: randomUUID() }))).json(),
    ).toEqual({ state: "not-observed" });
  });
  it("downloads exact stored request bytes and deterministic historical archives", async () => {
    const stored = store.actualArtifact(runId, "generation-request");
    const response = await artifact(
      request(),
      context({ runId, artifactKey: "generation-request" }),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(stored.body);
    expect(response.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const first = await (await download(request(), context({ runId, revision: "0" }))).text();
    store.close();
    store = new PlanQualityStore(directory);
    state.store = store;
    const second = await (await download(request(), context({ runId, revision: "0" }))).text();
    expect(second).toBe(first);
    expect(JSON.parse(first).kind).toBe("actual-ledger-simulation-archive");
    expect(store.actualBudgetGet().heldUnits).toBe("4");
  });
  it.each([
    ["external host", "", { headers: { host: "example.invalid" } }, 403],
    ["cross origin", "", { headers: { origin: "https://example.invalid" } }, 403],
    ["query", "?approve=true", {}, 400],
    ["write method", "", { method: "POST" }, 405],
  ] as const)("rejects %s before opening storage", async (_label, suffix, init, status) => {
    const response = await qualityActualLedgerRoute(request(suffix, init), "overview");
    expect(response.status).toBe(status);
    expect(state.opened).not.toHaveBeenCalled();
    expect(overviewRoute).not.toHaveProperty("POST");
  });
  it.each(["-1", "01", "33", "1.5"])("rejects invalid revision %s", async (value) => {
    const response = await revision(request(), context({ runId, revision: value }));
    expect(response.status).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
  });
  it("rejects unknown artifact keys and missing records without path access", async () => {
    expect(
      (await artifact(request(), context({ runId, artifactKey: "../../studio.sqlite" }))).status,
    ).toBe(400);
    expect(state.opened).not.toHaveBeenCalled();
    expect((await get(request(), context({ runId: randomUUID() }))).status).toBe(404);
  });
  it("blocks every actual mutation on the default store, including nonce replay", () => {
    const calls = [
      () => store.actualStart(input),
      () =>
        store.actualBudgetConfigure({
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "100" },
        }),
      () => store.actualRecordPrepared(runId, {} as never),
      () => store.actualRecordDispatch(runId, {} as never),
      () => store.actualRecordResponse(runId, {} as never),
      () => store.actualRecordValidated(runId, {} as never),
      () => store.actualRecordFinish(runId, {} as never),
      () => store.actualStop(runId, {} as never),
    ];
    for (const call of calls)
      expect(call).toThrow(expect.objectContaining({ code: "ACTUAL_EXECUTION_DISABLED" }));
    expect(store.actualGet(runId).revision).toBe(0);
  });
  it("keeps A production inspection unconfigured despite a persisted synthetic budget", async () => {
    const scope = input.preparation.scope;
    const body = {
      version: scope.version,
      versionDigest: scope.versionDigest,
      candidateId: scope.candidateId,
      model: input.preparation.model,
    };
    const make = (value: unknown) =>
      new Request("http://127.0.0.1:3000/api/studio/quality/actual-preparation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const response = await prepare(make(body));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.environment).toBe("production");
    expect(result.evidence).toEqual({ price: null, tokens: null, budget: null });
    expect(result.costs).toBeNull();
    expect(
      (
        await prepare(
          make({ ...body, approval: input.approval, budget: input.preparation.evidence.budget }),
        )
      ).status,
    ).toBe(400);
    expect(store.actualGet(runId).revision).toBe(0);
  });
});
