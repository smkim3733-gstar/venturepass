import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  opened: vi.fn(),
  forbidden: vi.fn(() => {
    throw Error("External/customer access forbidden");
  }),
}));
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
import { PlanQualityStore } from "./studio-plan-quality-store";
import { StudioError } from "./studio-http";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import {
  createProviderProductionRuntime,
  revokeProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import { providerGenerationRunnerNonces } from "./studio-plan-quality-provider-generation-runner";
import { providerProductionViewSchema } from "./studio-plan-quality-provider-production-service-types";
import { qualityProviderProductionStatusRoute } from "./studio-plan-quality-provider-production-status-service";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as route from "@/app/api/studio/quality/provider-execution/inspect/route";

let directory: string,
  store: PlanQualityStore,
  identity: ProviderGenerationDispatchIdentity,
  runtime: ProviderProductionRuntime;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const key = "sk-synthetic-production-status-test-only",
  secret = "PRIVATE_STATUS_EVIDENCE_DO_NOT_RETURN";
const network = vi.fn<typeof fetch>();
const file = () => join(directory, "quality-evaluation", "quality.sqlite");
const selection = () => ({ runId: identity.runId, runDigest: identity.runDigest });
const base = "http://127.0.0.1:3000/api/studio/quality/provider-execution/inspect";
const post = (body: unknown = selection(), init: RequestInit = {}) =>
  new Request(base, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(body),
    ...init,
  });
async function inspect(request = post()) {
  const bytes = readFileSync(file()),
    calls = network.mock.calls.length;
  const response = await route.POST(request);
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).toHaveBeenCalledTimes(calls);
  expect(response.headers.get("cache-control")).toBe("no-store, private, max-age=0");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  return response;
}
async function read() {
  const response = await inspect();
  expect(response.status).toBe(200);
  const view = providerProductionViewSchema.parse(await response.json());
  for (const text of [
    key,
    secret,
    "pendingCapture",
    "snapshot",
    "output_text",
    "preparedRequestId",
    "dispatchRequestId",
    "finalArtifact",
    "requestDigest",
  ])
    expect(JSON.stringify(view)).not.toContain(text);
  expect(view.selection).toEqual({
    ...selection(),
    approvalBindingDigest: identity.approvalBindingDigest,
  });
  expect(view.automaticRetryAllowed).toBe(false);
  return view;
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubGlobal("fetch", network);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  network.mockReset();
  state.opened.mockClear();
  network.mockImplementation(async () =>
    Response.json(network.mock.calls.length === 1 ? generationRaw : reviewRaw),
  );
  directory = mkdtempSync(join(tmpdir(), "venture-production-status-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  identity = generationDispatchStoreFixture(store);
  generationRaw = generationResponseFixture(identity).response;
  generationRaw.output = [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify(actualTestPlan(store.candidateRegistryGet(1))),
        },
      ],
    },
  ];
  reviewRaw = { ...generationResponseFixture(identity).response, id: "synthetic-review-response" };
  setReviewValidationOutput(reviewRaw);
  runtime = createProviderProductionRuntime();
  store.close();
  store = new PlanQualityStore(directory, { providerProductionRuntime: runtime });
  state.store = store;
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  revokeProviderProductionRuntime(runtime);
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-production-status-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it.each([1, 3, 4, 5, 7, 9, 10])(
  "reads audited r%i without invoking a runner, phase writer, current configuration or another provider call",
  async (target) => {
    if (target === 3 || target === 7) {
      const original = DatabaseSync.prototype.exec;
      let injected = false;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        const result = original.call(this, sql);
        if (
          sql === "COMMIT" &&
          !injected &&
          this.prepare(
            "SELECT MAX(revision) AS revision FROM quality_actual_events WHERE run_id=?",
          ).get(identity.runId)?.revision === target
        ) {
          injected = true;
          throw Error(secret);
        }
        return result;
      });
    }
    if (target === 4)
      vi.spyOn(
        ProviderGenerationDispatchStore.prototype,
        "recordGenerationValidation",
      ).mockImplementation(() => {
        throw Error(secret);
      });
    if (target === 5)
      network.mockImplementation(async () => {
        revokeProviderProductionRuntime(runtime);
        return Response.json(generationRaw);
      });
    if (target === 9)
      vi.spyOn(ProviderGenerationDispatchStore.prototype, "recordFinalization").mockImplementation(
        () => {
          throw Error(secret);
        },
      );
    if (target > 1) await store.providerRunApprovedProduction(identity);
    for (const method of [
      "providerRunApprovedProduction",
      "providerRecoverProductionGenerationCapture",
      "providerRecoverProductionReviewCapture",
      "providerResolveProductionIdentity",
      "providerGet",
    ] as const)
      vi.spyOn(store, method).mockImplementation(state.forbidden);
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(state.forbidden);
    revokeProviderProductionRuntime(runtime);
    vi.setSystemTime("2035-01-01T00:00:00Z");
    const view = await read();
    expect(view.lastAuditedRevision).toBe(target);
    expect(view.executionCompleted).toBe(target === 10);
    expect(view.generation?.lastConfirmed).toBe(
      target === 1
        ? "approved"
        : target === 3
          ? "dispatch-recorded"
          : target === 4
            ? "response-recorded"
            : "validated",
    );
    expect(view.review?.lastConfirmed ?? null).toBe(
      target === 7
        ? "dispatch-recorded"
        : target === 9
          ? "validated"
          : target === 10
            ? "completed"
            : null,
    );
    if (target === 3 || target === 7) expect(view.recovery).toBe("reconcile-before-continuing");
    expect(state.opened).toHaveBeenCalledTimes(1);
  },
  25000,
);

it("works on the default store with no key and exports only a dynamic Node read POST", async () => {
  expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
  expect(route).toMatchObject({ runtime: "nodejs", dynamic: "force-dynamic" });
  store.close();
  vi.stubEnv("OPENAI_API_KEY", "");
  store = new PlanQualityStore(directory);
  state.store = store;
  expect(await read()).toMatchObject({
    status: "last-confirmed",
    generation: { lastConfirmed: "approved" },
  });
  expect(network).not.toHaveBeenCalled();
});

it("reports persisted unobserved state while a response is only retained in server memory", async () => {
  vi.spyOn(ProviderGenerationDispatchStore.prototype, "recordResponse").mockImplementation(() => {
    throw Error(secret);
  });
  const run = await store.providerRunApprovedProduction(identity);
  expect(run.generation.pendingCapture).toBeTruthy();
  expect(await read()).toMatchObject({
    status: "last-confirmed",
    generation: { response: "unobserved", lastConfirmed: "dispatch-recorded" },
    lastAuditedBudget: "unsettled",
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);

it("reads an in-flight dispatch without sending, stopping, or waiting for its owner", async () => {
  let started!: () => void, finish!: (response: Response) => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  network.mockImplementation(async () => {
    if (network.mock.calls.length !== 1) return Response.json(reviewRaw);
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const owner = store.providerRunApprovedProduction(identity);
  await began;
  try {
    expect(await read()).toMatchObject({
      status: "last-confirmed",
      generation: { lastConfirmed: "dispatch-recorded", stopOutcome: null },
    });
    expect(network).toHaveBeenCalledTimes(1);
  } finally {
    finish(Response.json(generationRaw));
    await owner;
  }
  expect((await read()).executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it.each(["generation", "review"])(
  "exposes the audited %s cost-review stop and its unsettled reservation",
  async (phase) => {
    (phase === "generation" ? generationRaw : reviewRaw).usage = null;
    await store.providerRunApprovedProduction(identity);
    const view = await read();
    expect(view).toMatchObject({
      status: "stopped",
      lastAuditedBudget: "unsettled",
      recovery: "reconcile-before-continuing",
      executionCompleted: false,
    });
    expect(phase === "generation" ? view.generation : view.review).toMatchObject({
      lastConfirmed: "stopped",
      response: "recorded",
      stopOutcome: "needs-cost-review",
    });
  },
  25000,
);

it("does not revive a stopped execution when a late captured response is recorded", async () => {
  network.mockRejectedValue(Error(secret));
  await store.providerRunApprovedProduction(identity);
  expect(await read()).toMatchObject({
    status: "stopped",
    generation: { response: "unobserved", stopOutcome: "result-unobserved" },
    lastAuditedBudget: "unsettled",
  });
  revokeProviderProductionRuntime(runtime);
  store.providerRecoverProductionGenerationCapture({
    dispatch: identity,
    responseRequestId: providerGenerationRunnerNonces(identity).responseRequestId,
    response: generationRaw,
  });
  expect(await read()).toMatchObject({
    status: "stopped",
    generation: {
      response: "recorded",
      lastConfirmed: "stopped",
      stopOutcome: "result-unobserved",
    },
    lastAuditedBudget: "settled",
    executionCompleted: false,
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);

it("rejects HTTP method/origin/query/encoding/size/input violations before opening a store", async () => {
  const cases: Array<[Request, number]> = [
    [new Request(base), 405],
    [post(selection(), { headers: { "content-type": "text/plain" } }), 415],
    [
      post(selection(), {
        headers: { "content-type": "application/json", origin: "https://foreign.invalid" },
      }),
      403,
    ],
    [
      post(selection(), {
        headers: { "content-type": "application/json", "x-forwarded-host": "foreign.invalid" },
      }),
      403,
    ],
    [
      post(selection(), {
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      }),
      403,
    ],
    [new Request(base + "?runId=x", { method: "POST" }), 400],
    [post(selection(), { body: "{" }), 400],
    [post(selection(), { body: new Uint8Array([0xff]) }), 400],
    [
      post(selection(), {
        headers: { "content-type": "application/json", "content-length": "4097" },
      }),
      413,
    ],
    [post(selection(), { body: " ".repeat(4097) }), 413],
  ];
  for (const field of [
    "approvalBindingDigest",
    "apiKey",
    "response",
    "runtime",
    "model",
    "dispatchRequestId",
    "action",
  ])
    cases.push([post({ ...selection(), [field]: secret }), 400]);
  for (const [request, status] of cases) {
    const response = await qualityProviderProductionStatusRoute(request);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(secret);
  }
  expect(state.opened).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it("does not echo typed store failures or serialize extra output fields/mismatched selections", async () => {
  const original = store.providerProductionStatus(selection());
  const method = vi.spyOn(store, "providerProductionStatus");
  method.mockImplementation(() => {
    throw new StudioError(secret, 418, secret);
  });
  const failed = await inspect();
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain(secret);
  method.mockReturnValue({ ...original, pendingCapture: secret } as typeof original);
  expect((await inspect()).status).toBe(500);
  method.mockReturnValue({
    ...original,
    selection: { ...original.selection!, runId: randomUUID() },
  });
  expect((await inspect()).status).toBe(500);
  method.mockRestore();
  expect((await inspect(post({ ...selection(), runDigest: "0".repeat(64) }))).status).toBe(500);
  expect(network).not.toHaveBeenCalled();
});

it("rejects missing completion receipts even when a completed snapshot/event remains", async () => {
  const result = await store.providerRunApprovedProduction(identity);
  expect(result.executionCompleted).toBe(true);
  const db = new DatabaseSync(file());
  try {
    db.function("quality_storage_contract", () => "quality-v9");
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='quality_actual_requests_no_delete'",
      )
      .get();
    if (typeof trigger?.sql !== "string") throw Error("Missing fixture trigger");
    db.exec("DROP TRIGGER quality_actual_requests_no_delete");
    db.prepare("DELETE FROM quality_actual_requests WHERE nonce=?").run(
      result.review!.finalization!.finalizationRequestId,
    );
    db.exec(trigger.sql);
  } finally {
    db.close();
  }
  const response = await inspect();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("completed");
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);
