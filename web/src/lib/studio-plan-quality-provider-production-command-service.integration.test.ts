import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Customer/default-store access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: forbidden,
}));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import * as server from "./studio-plan-quality-provider-production-server";
import { providerProductionViewSchema } from "./studio-plan-quality-provider-production-service-types";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as executeRoute from "@/app/api/studio/quality/provider-execution/execute/route";
import * as recoverRoute from "@/app/api/studio/quality/provider-execution/recover/route";

let directory: string, identity: ProviderGenerationDispatchIdentity;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const key = "sk-synthetic-production-command-test-only",
  secret = "PRIVATE_COMMAND_CAPTURE_ERROR_DO_NOT_RETURN";
const network = vi.fn<typeof fetch>();
const selection = () => ({
  runId: identity.runId,
  runDigest: identity.runDigest,
  approvalBindingDigest: identity.approvalBindingDigest,
});
const file = () => join(directory, "quality-evaluation", "quality.sqlite");
const post = (action: "execute" | "recover", raw: unknown = selection(), init: RequestInit = {}) =>
  new Request(`http://127.0.0.1:3000/api/studio/quality/provider-execution/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(raw),
    ...init,
  });
async function safe(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store, private, max-age=0");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("retry-after")).toBeNull();
  const serialized = await response.text();
  for (const text of [
    key,
    secret,
    directory,
    "pendingCapture",
    "output_text",
    "dispatchRequestId",
    "preparedRequestId",
    "api.openai.com",
    "snapshot",
    "rawBody",
  ])
    expect(serialized).not.toContain(text);
  const view = providerProductionViewSchema.parse(JSON.parse(serialized));
  expect(view.selection).toEqual(selection());
  expect(view.automaticRetryAllowed).toBe(false);
  return view;
}
const execute = (request = post("execute"), status = 200) =>
  executeRoute.POST(request).then((response) => safe(response, status));
const recover = (status = 200) =>
  recoverRoute.POST(post("recover")).then((response) => safe(response, status));
function readStatus() {
  const read = new PlanQualityStore(directory);
  try {
    return read.providerProductionStatus({ runId: identity.runId, runDigest: identity.runDigest });
  } finally {
    read.close();
  }
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubGlobal("fetch", network);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  network.mockReset();
  network.mockImplementation(async () =>
    Response.json(network.mock.calls.length === 1 ? generationRaw : reviewRaw),
  );
  directory = mkdtempSync(join(tmpdir(), "venture-production-command-"));
  vi.stubEnv("VENTURE_DATA_DIR", directory);
  writeFileSync(join(directory, "studio.sqlite"), "synthetic sentinel");
  const seed = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  try {
    seed.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: seed.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    identity = generationDispatchStoreFixture(seed);
    generationRaw = generationResponseFixture(identity).response;
    generationRaw.output = [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(actualTestPlan(seed.candidateRegistryGet(1))),
          },
        ],
      },
    ];
    reviewRaw = {
      ...generationResponseFixture(identity).response,
      id: "synthetic-review-response",
    };
    setReviewValidationOutput(reviewRaw);
  } finally {
    seed.close();
  }
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  server.retireProviderProductionServer();
  if (server.inspectProviderProductionServer().retainedCaptures)
    server.recoverProviderProductionSelection(selection());
  expect(server.retireProviderProductionServer()).toMatchObject({
    activeExecutions: 0,
    retainedCaptures: 0,
  });
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-production-command-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("HTTP cannot activate the server using a present key/approval, and pre-dispatch abort leaves r1 unchanged", async () => {
  const bytes = readFileSync(file());
  expect((await execute(post("execute"), 503)).reason).toBe("execution-unavailable");
  expect((await recover(503)).reason).toBe("execution-unavailable");
  expect(server.inspectProviderProductionServer().status).toBe("not-installed");
  expect(readFileSync(file())).toEqual(bytes);
  server.installProviderProductionServer();
  const abort = new AbortController();
  abort.abort();
  const response = await executeRoute.POST(post("execute", selection(), { signal: abort.signal }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "REQUEST_ABORTED" });
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).not.toHaveBeenCalled();
});

it("executes an approved scope to confirmed completion and replays repeated POSTs without another SDK call", async () => {
  server.installProviderProductionServer();
  expect(await execute()).toMatchObject({
    status: "completed",
    executionCompleted: true,
    lastAuditedRevision: 10,
  });
  const bytes = readFileSync(file());
  expect(await execute()).toMatchObject({
    status: "completed",
    executionCompleted: true,
    lastAuditedRevision: 10,
  });
  expect((await recover(409)).reason).toBe("capture-not-retained");
  expect(readFileSync(file())).toEqual(bytes);
  expect(readStatus().executionCompleted).toBe(true);
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it.each(["generation", "review"])(
  "HTTP retains a failed %s capture and recovers it after retirement with no new send",
  async (phase) => {
    server.installProviderProductionServer();
    const fault = vi
      .spyOn(
        ProviderGenerationDispatchStore.prototype,
        phase === "generation" ? "recordResponse" : "recordReviewResponse",
      )
      .mockImplementation(() => {
        throw Error(secret);
      });
    const first = await execute();
    expect(first).toMatchObject({
      status: "capture-recovery-required",
      recovery: "server-capture",
      executionCompleted: false,
    });
    const bytes = readFileSync(file());
    expect(await execute()).toEqual(first);
    expect((await recover()).status).toBe("capture-recovery-required");
    expect(readFileSync(file())).toEqual(bytes);
    const wrong = await recoverRoute.POST(
      post("recover", { ...selection(), approvalBindingDigest: "c".repeat(64) }),
    );
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ reason: "capture-not-retained" });
    expect(server.inspectProviderProductionServer().retainedCaptures).toBe(1);
    server.retireProviderProductionServer();
    vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-rotated-command-key");
    vi.stubEnv("VENTURE_DATA_DIR", join(directory, "changed-directory"));
    expect((await execute(post("execute"), 503)).reason).toBe("execution-unavailable");
    fault.mockRestore();
    expect(await recover()).toMatchObject({
      executionCompleted: phase === "review",
      lastAuditedRevision: phase === "generation" ? 5 : 10,
    });
    expect(server.inspectProviderProductionServer().status).toBe("closed");
    expect(readStatus().lastAuditedRevision).toBe(phase === "generation" ? 5 : 10);
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
  },
  25000,
);

it("a disconnect after SDK start preserves the pending capture and duplicate requests cannot steal its ownership", async () => {
  server.installProviderProductionServer();
  const fault = vi
    .spyOn(ProviderGenerationDispatchStore.prototype, "recordResponse")
    .mockImplementation(() => {
      throw Error(secret);
    });
  let started!: () => void,
    finish!: (response: Response) => void,
    sdkSignal: AbortSignal | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  network.mockImplementation((_url, init) => {
    sdkSignal = init?.signal ?? undefined;
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const abort = new AbortController();
  const owner = execute(post("execute", selection(), { signal: abort.signal }));
  await began;
  try {
    abort.abort();
    expect(sdkSignal?.aborted).toBe(false);
    const bytes = readFileSync(file());
    expect((await execute(post("execute"), 409)).reason).toBe("execution-in-progress");
    expect((await recover(409)).reason).toBe("execution-in-progress");
    expect(readFileSync(file())).toEqual(bytes);
    expect(server.inspectProviderProductionServer().activeExecutions).toBe(1);
  } finally {
    finish(Response.json(generationRaw));
  }
  expect(await owner).toMatchObject({
    status: "capture-recovery-required",
    generation: { response: "captured-not-confirmed" },
    executionCompleted: false,
  });
  expect(server.inspectProviderProductionServer().retainedCaptures).toBe(1);
  fault.mockRestore();
  expect(await recover()).toMatchObject({
    status: "last-confirmed",
    generation: { lastConfirmed: "validated", response: "recorded" },
    review: null,
    lastAuditedRevision: 5,
    executionCompleted: false,
  });
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);

it.each([3, 7])(
  "r%i COMMIT ACK loss remains held through repeated execute/recover HTTP requests",
  async (target) => {
    server.installProviderProductionServer();
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
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
    const first = await execute();
    expect(injected).toBe(true);
    expect(first).toMatchObject({
      status: "last-confirmed",
      lastAuditedRevision: target,
      lastAuditedBudget: "unsettled",
      recovery: "reconcile-before-continuing",
      executionCompleted: false,
    });
    const bytes = readFileSync(file());
    expect(await execute()).toEqual(first);
    expect((await recover(409)).reason).toBe("capture-not-retained");
    expect(readFileSync(file())).toEqual(bytes);
    expect(network).toHaveBeenCalledTimes(target === 3 ? 0 : 1);
  },
  25000,
);
