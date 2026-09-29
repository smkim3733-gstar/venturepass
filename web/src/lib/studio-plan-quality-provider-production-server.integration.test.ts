import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External/customer access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore, getPlanQualityStore } from "./studio-plan-quality-store";
import { ProviderGenerationDispatchStore } from "./studio-plan-quality-provider-dispatch-store";
import * as initialServer from "./studio-plan-quality-provider-production-server";
import {
  providerProductionViewSchema,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";

let server = initialServer;
let directory: string, identity: ProviderGenerationDispatchIdentity;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const key = "sk-synthetic-production-server-test-only";
const secret = "PRIVATE_CAPTURE_OR_ERROR_DO_NOT_RETURN";
const network = vi.fn<typeof fetch>();
const selection = () => ({
  runId: identity.runId,
  runDigest: identity.runDigest,
  approvalBindingDigest: identity.approvalBindingDigest,
});
const file = () => join(directory, "quality-evaluation", "quality.sqlite");
function safe(view: ProviderProductionView) {
  expect(providerProductionViewSchema.safeParse(view).success).toBe(true);
  for (const text of [
    key,
    secret,
    directory,
    "pendingCapture",
    "output_text",
    "dispatchRequestId",
    "preparedRequestId",
    "api.openai.com",
  ])
    expect(JSON.stringify(view)).not.toContain(text);
  return view;
}
function readStatus() {
  const read = new PlanQualityStore(directory);
  try {
    return read.providerProductionStatus({ runId: identity.runId, runDigest: identity.runDigest });
  } finally {
    read.close();
  }
}
function install() {
  expect(server.installProviderProductionServer()).toEqual({
    status: "ready",
    activeExecutions: 0,
    retainedCaptures: 0,
  });
  expect(network).not.toHaveBeenCalled();
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
  directory = mkdtempSync(join(tmpdir(), "venture-production-server-"));
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
  if (!rel.startsWith("venture-production-server-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it("stays uninstalled despite a key/approved run and permits only explicit server installation", async () => {
  expect(server.inspectProviderProductionServer().status).toBe("not-installed");
  const bytes = readFileSync(file());
  expect(safe(await server.executeProviderProductionSelection(selection())).reason).toBe(
    "execution-unavailable",
  );
  expect(safe(server.recoverProviderProductionSelection(selection())).reason).toBe(
    "execution-unavailable",
  );
  expect(() =>
    (server.installProviderProductionServer as (...args: unknown[]) => unknown)({
      runtime: secret,
    }),
  ).toThrow("PROVIDER_PRODUCTION_SERVER_INSTALL_FORBIDDEN");
  expect(readFileSync(file())).toEqual(bytes);
  install();
  expect(readFileSync(file())).toEqual(bytes);
  expect(() => server.installProviderProductionServer()).toThrow(
    "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
  );
  for (const field of [
    "preparedRequestId",
    "dispatchRequestId",
    "runtime",
    "apiKey",
    "response",
    "signal",
    "directory",
  ])
    expect(
      safe(await server.executeProviderProductionSelection({ ...selection(), [field]: secret }))
        .reason,
    ).toBe("invalid-selection");
  expect(network).not.toHaveBeenCalled();
});

it("reuses one installed service through completion/replay and closes only on explicit retirement", async () => {
  install();
  expect(
    safe(await server.executeProviderProductionSelection(selection())).executionCompleted,
  ).toBe(true);
  const bytes = readFileSync(file());
  expect(
    safe(await server.executeProviderProductionSelection(selection())).executionCompleted,
  ).toBe(true);
  expect(readFileSync(file())).toEqual(bytes);
  expect(server.inspectProviderProductionServer()).toEqual({
    status: "ready",
    activeExecutions: 0,
    retainedCaptures: 0,
  });
  expect(network).toHaveBeenCalledTimes(2);
  expect(server.retireProviderProductionServer().status).toBe("closed");
  expect(safe(await server.executeProviderProductionSelection(selection())).reason).toBe(
    "execution-unavailable",
  );
  expect(readStatus().executionCompleted).toBe(true);
}, 25000);

it("drains an active owner without closing its DB or cancelling its observed response", async () => {
  install();
  let started!: () => void, finish!: (response: Response) => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  network.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const owner = server.executeProviderProductionSelection(selection());
  await began;
  try {
    expect(server.inspectProviderProductionServer()).toEqual({
      status: "ready",
      activeExecutions: 1,
      retainedCaptures: 0,
    });
    expect(safe(await server.executeProviderProductionSelection(selection())).reason).toBe(
      "execution-in-progress",
    );
    expect(server.retireProviderProductionServer()).toEqual({
      status: "draining",
      activeExecutions: 1,
      retainedCaptures: 0,
    });
    expect(() => server.installProviderProductionServer()).toThrow(
      "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
    );
    expect(readStatus().generation?.response).toBe("unobserved");
  } finally {
    finish(Response.json(generationRaw));
  }
  expect(safe(await owner)).toMatchObject({
    executionCompleted: false,
    generation: { lastConfirmed: "validated", response: "recorded" },
    lastAuditedRevision: 5,
  });
  expect(server.inspectProviderProductionServer().status).toBe("closed");
  expect(readStatus().lastAuditedRevision).toBe(5);
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);

it.each(["generation", "review"])(
  "pins failed %s capture through retirement/recovery failures and releases only after persistence",
  async (phase) => {
    install();
    const fault = vi
      .spyOn(
        ProviderGenerationDispatchStore.prototype,
        phase === "generation" ? "recordResponse" : "recordReviewResponse",
      )
      .mockImplementation(() => {
        throw Error(secret);
      });
    expect(safe(await server.executeProviderProductionSelection(selection())).status).toBe(
      "capture-recovery-required",
    );
    const calls = phase === "generation" ? 1 : 2,
      bytes = readFileSync(file());
    expect(server.retireProviderProductionServer()).toEqual({
      status: "draining",
      activeExecutions: 0,
      retainedCaptures: 1,
    });
    expect(() => server.installProviderProductionServer()).toThrow(
      "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
    );
    expect(safe(server.recoverProviderProductionSelection(selection())).status).toBe(
      "capture-recovery-required",
    );
    expect(readFileSync(file())).toEqual(bytes);
    expect(server.inspectProviderProductionServer().retainedCaptures).toBe(1);
    fault.mockRestore();
    expect(safe(server.recoverProviderProductionSelection(selection()))).toMatchObject({
      executionCompleted: phase === "review",
      lastAuditedRevision: phase === "generation" ? 5 : 10,
    });
    expect(server.inspectProviderProductionServer()).toEqual({
      status: "closed",
      activeExecutions: 0,
      retainedCaptures: 0,
    });
    expect(readStatus().lastAuditedRevision).toBe(phase === "generation" ? 5 : 10);
    expect(network).toHaveBeenCalledTimes(calls);
  },
  25000,
);

it("revokes on key rotation between generation and review but still persists the observed response", async () => {
  install();
  network.mockImplementation(async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-rotated-production-key");
    return Response.json(generationRaw);
  });
  expect(safe(await server.executeProviderProductionSelection(selection()))).toMatchObject({
    executionCompleted: false,
    generation: { lastConfirmed: "validated", response: "recorded" },
    lastAuditedRevision: 5,
  });
  expect(server.inspectProviderProductionServer().status).toBe("closed");
  vi.stubEnv("OPENAI_API_KEY", key);
  expect(safe(await server.executeProviderProductionSelection(selection())).reason).toBe(
    "execution-unavailable",
  );
  expect(readStatus().lastAuditedRevision).toBe(5);
  expect(network).toHaveBeenCalledTimes(1);
}, 25000);

it("a default read-cache directory switch cannot close the execution DB or redirect its late capture", async () => {
  const readA = getPlanQualityStore();
  expect(
    readA.providerProductionStatus({ runId: identity.runId, runDigest: identity.runDigest })
      .lastAuditedRevision,
  ).toBe(1);
  install();
  let readB: PlanQualityStore | undefined;
  network.mockImplementation(async () => {
    vi.stubEnv("VENTURE_DATA_DIR", join(directory, "changed-directory"));
    readB = getPlanQualityStore(); // Closes readA, never the owner's separate DB.
    return Response.json(generationRaw);
  });
  try {
    expect(safe(await server.executeProviderProductionSelection(selection()))).toMatchObject({
      generation: { response: "recorded", lastConfirmed: "validated" },
      lastAuditedRevision: 5,
      executionCompleted: false,
    });
    expect(server.inspectProviderProductionServer().status).toBe("closed");
    expect(readStatus().lastAuditedRevision).toBe(5);
    expect(readB!.providerList()).toEqual({ executions: [] });
    expect(network).toHaveBeenCalledTimes(1);
  } finally {
    readB?.close();
  }
}, 25000);

it("a failed DB close keeps replacement blocked until a later retirement confirms closure", () => {
  install();
  const close = vi.spyOn(PlanQualityStore.prototype, "close").mockImplementation(() => {
    throw Error(secret);
  });
  expect(server.retireProviderProductionServer().status).toBe("draining");
  expect(() => server.installProviderProductionServer()).toThrow(
    "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
  );
  close.mockRestore();
  expect(server.retireProviderProductionServer().status).toBe("closed");
  expect(server.installProviderProductionServer().status).toBe("ready");
  expect(network).not.toHaveBeenCalled();
});

// Last: module reset intentionally replaces module identities; retained captures must keep
// their old authentic runtime/store closures, while stale exports cannot start any new send.
it("module reload drains an in-flight request and preserves its late failed capture for recovery", async () => {
  install();
  const fault = vi
    .spyOn(ProviderGenerationDispatchStore.prototype, "recordResponse")
    .mockImplementation(() => {
      throw Error(secret);
    });
  let started!: () => void, finish!: (response: Response) => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  network.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const owner = server.executeProviderProductionSelection(selection());
  await began;
  const stale = server;
  try {
    vi.resetModules();
    server = await import("./studio-plan-quality-provider-production-server");
    expect(server.inspectProviderProductionServer()).toEqual({
      status: "draining",
      activeExecutions: 1,
      retainedCaptures: 0,
    });
  } finally {
    finish(Response.json(generationRaw));
  }
  expect(safe(await owner).status).toBe("capture-recovery-required");
  expect(server.inspectProviderProductionServer()).toEqual({
    status: "draining",
    activeExecutions: 0,
    retainedCaptures: 1,
  });
  expect(() => server.installProviderProductionServer()).toThrow(
    "PROVIDER_PRODUCTION_SERVER_ALREADY_INSTALLED",
  );
  expect(() => stale.installProviderProductionServer()).toThrow(
    "PROVIDER_PRODUCTION_SERVER_INSTALL_FORBIDDEN",
  );
  expect(safe(await stale.executeProviderProductionSelection(selection())).reason).toBe(
    "execution-unavailable",
  );
  fault.mockRestore();
  expect(safe(server.recoverProviderProductionSelection(selection()))).toMatchObject({
    generation: { response: "recorded", lastConfirmed: "validated" },
    lastAuditedRevision: 5,
    executionCompleted: false,
  });
  expect(server.inspectProviderProductionServer().status).toBe("closed");
  expect(readStatus().lastAuditedRevision).toBe(5);
  expect(network).toHaveBeenCalledTimes(1);
}, 30000);
