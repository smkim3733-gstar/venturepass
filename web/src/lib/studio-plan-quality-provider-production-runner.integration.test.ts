import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Company/external access forbidden");
  }),
);
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
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
import { providerReviewRunnerScope } from "./studio-plan-quality-provider-approved-runner";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as engine from "./studio-engine";

let directory: string, store: PlanQualityStore, identity: ProviderGenerationDispatchIdentity;
let runtime: ProviderProductionRuntime;
let generationRaw: ReturnType<typeof generationResponseFixture>["response"],
  reviewRaw: typeof generationRaw;
const key = "sk-synthetic-production-runner-test-only";
const network = vi.fn<typeof fetch>();
const file = () => join(directory, "quality-evaluation", "quality.sqlite");
const response = (raw: typeof generationRaw) =>
  Response.json(raw, { headers: { "x-request-id": "synthetic-request" } });
const execute = (command: unknown = identity) => store.providerRunApprovedProduction(command);
function reopen(mode: "production" | "default" | "synthetic" = "production") {
  store.close();
  store = new PlanQualityStore(
    directory,
    mode === "production"
      ? { providerProductionRuntime: runtime }
      : mode === "synthetic"
        ? { providerEnvironment: "synthetic-test" }
        : {},
  );
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubGlobal("fetch", network);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  network.mockReset();
  network.mockImplementation(async () =>
    response(network.mock.calls.length === 1 ? generationRaw : reviewRaw),
  );
  directory = mkdtempSync(join(tmpdir(), "venture-production-runner-"));
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
  reopen();
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  revokeProviderProductionRuntime(runtime);
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-production-runner-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

it.each(["DELETE", "WAL"])(
  "completes under %s writer ownership using fixed server credentials, then replays without a send",
  async (journal) => {
    const db = new DatabaseSync(file());
    try {
      db.exec(`PRAGMA journal_mode=${journal}; PRAGMA busy_timeout=0`);
      network.mockImplementation(async (url, init) => {
        const phase = network.mock.calls.length === 1 ? "generation" : "review";
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
        expect(new Headers(init?.headers).get("x-stainless-retry-count")).toBe("0");
        expect(init?.redirect).toBe("error");
        expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
        const row = db
          .prepare("SELECT payload FROM quality_actual_artifacts WHERE run_id=? AND artifact_key=?")
          .get(identity.runId, `${phase}-request`);
        expect(init?.body).toBe(Buffer.from(row!.payload as Uint8Array).toString("utf8"));
        return response(phase === "generation" ? generationRaw : reviewRaw);
      });
      // Runtime captures its network. Unapproved endpoint/project overrides are never commands.
      // Credential/directory drift now revokes future sends (covered by server lifetime tests).
      vi.stubEnv("OPENAI_BASE_URL", "https://attacker.invalid/v1");
      vi.stubEnv("OPENAI_PROJECT_ID", "unapproved-project");
      vi.stubGlobal("fetch", forbidden);
      const first = await execute();
      expect(first).toMatchObject({
        executionCompleted: true,
        generation: { status: "generation-validated" },
        review: { status: "completed", finalization: { revision: 10 }, pendingCapture: null },
      });
      expect(JSON.stringify(first)).not.toContain(key);
      expect(network).toHaveBeenCalledTimes(2);
      const budget = store.providerBudgetGet("production"),
        bytes = readFileSync(file());
      revokeProviderProductionRuntime(runtime);
      vi.setSystemTime("2035-01-01T00:00:00Z");
      const contract = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(forbidden);
      expect(await execute()).toMatchObject({
        executionCompleted: true,
        review: { replayed: true, finalization: first.review!.finalization },
      });
      expect(contract).not.toHaveBeenCalled();
      expect(store.providerBudgetGet("production")).toEqual(budget);
      expect(readFileSync(file())).toEqual(bytes);
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  },
  25000,
);

it("keeps default/synthetic entry points and generic recording disabled; fabricated permits do not open phase writes", async () => {
  const bytes = readFileSync(file());
  for (const mode of ["default", "synthetic"] as const) {
    reopen(mode);
    await expect(execute()).rejects.toThrow();
  }
  reopen();
  await expect(store.providerSimulateGenerationSdkDispatch(identity)).rejects.toThrow();
  expect(() => store.providerRecordGenerationResponse(null)).toThrow();
  const internal = (
    store as unknown as { providerGenerationDispatch: ProviderGenerationDispatchStore }
  ).providerGenerationDispatch;
  for (const method of [
    "recordResponse",
    "recordGenerationValidation",
    "recordGenerationStop",
    "recordReviewResponse",
    "recordReviewValidation",
    "recordReviewStop",
    "recordFinalization",
  ] as const)
    expect(() => internal[method](null, {})).toThrow();
  expect(internal).not.toHaveProperty("openProductionScope");
  expect(internal).not.toHaveProperty("context");
  expect(internal).not.toHaveProperty("commit");
  expect(internal).not.toHaveProperty("commitReview");
  expect(internal).not.toHaveProperty("sendWhileOwnedCurrent");
  expect(JSON.stringify(internal)).toBe("{}");
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).not.toHaveBeenCalled();
});

it("rejects command authority/credential/identity substitutions without touching DB or network", async () => {
  const bytes = readFileSync(file());
  for (const field of [
    "runtime",
    "fetch",
    "apiKey",
    "model",
    "baseURL",
    "inspectedAt",
    "authority",
  ])
    await expect(execute({ ...identity, [field]: "injected" })).rejects.toThrow();
  await expect(execute({ ...identity, approvalBindingDigest: "0".repeat(64) })).rejects.toThrow();
  await expect(execute({ ...identity, runId: randomUUID() })).rejects.toThrow();
  expect(readFileSync(file())).toEqual(bytes);
  expect(network).not.toHaveBeenCalled();
});

it.each(["revoked", "expiry", "policy", "configuration"])(
  "preserves r1 and its hold when %s blocks a new dispatch",
  async (change) => {
    if (change === "policy") {
      adoptReservationTestPolicy(store);
    }
    const budget = store.providerBudgetGet("production"),
      bytes = readFileSync(file());
    if (change === "revoked") revokeProviderProductionRuntime(runtime);
    if (change === "expiry") vi.setSystemTime("2035-01-01T00:00:00Z");
    if (change === "configuration")
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
    expect(await execute()).toMatchObject({
      executionCompleted: false,
      generation: { status: "last-confirmed", snapshot: { revision: 1 }, stop: null },
    });
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(readFileSync(file())).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
  },
);

it("blocks revocation during SDK preparation before the owned network starts", async () => {
  const pending = execute();
  revokeProviderProductionRuntime(runtime);
  const result = await pending;
  expect(result).toMatchObject({
    executionCompleted: false,
    generation: {
      status: "generation-stopped",
      transport: { fetchStarted: false },
      stop: { state: "committed" },
    },
  });
  expect(network).not.toHaveBeenCalled();
  expect(store.providerGet(identity.runId).revision).toBe(4);
});

it("records an already-arrived generation after revocation, preserves r5 review hold, then continues with a new runtime", async () => {
  network.mockImplementation(async () => {
    revokeProviderProductionRuntime(runtime);
    return response(generationRaw);
  });
  const result = await execute();
  expect(result).toMatchObject({
    generation: { status: "generation-validated", pendingCapture: null },
    review: { status: "last-confirmed", snapshot: { revision: 5 }, stop: null },
    executionCompleted: false,
  });
  const budget = store.providerBudgetGet("production");
  expect(await execute()).toMatchObject({ review: { status: "last-confirmed", stop: null } });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(network).toHaveBeenCalledTimes(1);
  runtime = createProviderProductionRuntime();
  reopen();
  network.mockImplementation(async () => response(reviewRaw));
  expect(await execute()).toMatchObject({ executionCompleted: true });
  expect(network).toHaveBeenCalledTimes(2);
}, 25000);

it.each(["generation", "review"])(
  "a concurrent %s replay neither stops nor resends the in-flight owner",
  async (phase) => {
    let started!: () => void, finish!: (value: Response) => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    network.mockImplementation(async () => {
      const current = network.mock.calls.length === 1 ? "generation" : "review";
      if (current === phase) {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return response(generationRaw);
    });
    const pending = execute();
    await began;
    const db = new DatabaseSync(file());
    try {
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; COMMIT");
    } finally {
      db.close();
    }
    const bytes = readFileSync(file());
    const repeat = await execute();
    expect(repeat.executionCompleted).toBe(false);
    expect(phase === "generation" ? repeat.generation.stop : repeat.review?.stop).toBeNull();
    expect(readFileSync(file())).toEqual(bytes);
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
    finish(response(phase === "generation" ? generationRaw : reviewRaw));
    if (phase === "generation") network.mockImplementation(async () => response(reviewRaw));
    expect(await pending).toMatchObject({ executionCompleted: true });
    expect(network).toHaveBeenCalledTimes(2);
  },
  25000,
);

it.each(["generation", "review"])(
  "preserves a %s response when the final read COMMIT acknowledgement is lost",
  async (phase) => {
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      const done = original.call(this, sql);
      if (
        sql === "COMMIT" &&
        !injected &&
        network.mock.calls.length === (phase === "generation" ? 1 : 2)
      ) {
        const revision = this.prepare(
          "SELECT MAX(revision) AS revision FROM quality_actual_events WHERE run_id=?",
        ).get(identity.runId)?.revision;
        if (revision === (phase === "generation" ? 3 : 7)) {
          injected = true;
          throw Error("synthetic lost read acknowledgement");
        }
      }
      return done;
    });
    const result = await execute();
    expect(injected).toBe(true);
    expect(result.executionCompleted).toBe(true);
    expect(
      phase === "generation" ? result.generation.transport : result.review!.transport,
    ).toMatchObject({ finalCheckFailedAfterStart: true, delivery: "response-captured" });
    expect(network).toHaveBeenCalledTimes(2);
  },
  25000,
);

it.each([4, 8, 9, 10])(
  "recovers a lost write acknowledgement at r%i without another provider call",
  async (target) => {
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      const done = original.call(this, sql);
      if (sql === "COMMIT" && !injected) {
        const revision = this.prepare(
          "SELECT MAX(revision) AS revision FROM quality_actual_events WHERE run_id=?",
        ).get(identity.runId)?.revision;
        if (revision === target) {
          injected = true;
          throw Error("synthetic lost write acknowledgement");
        }
      }
      return done;
    });
    expect(await execute()).toMatchObject({ executionCompleted: true });
    expect(injected).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
  },
  25000,
);

it.each([3, 7])(
  "does not acquire a new send owner when the r%i intent COMMIT acknowledgement is lost",
  async (target) => {
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      const done = original.call(this, sql);
      if (sql === "COMMIT" && !injected) {
        const revision = this.prepare(
          "SELECT MAX(revision) AS revision FROM quality_actual_events WHERE run_id=?",
        ).get(identity.runId)?.revision;
        if (revision === target) {
          injected = true;
          throw Error("synthetic lost intent acknowledgement");
        }
      }
      return done;
    });
    const first = await execute();
    expect(injected).toBe(true);
    expect(first.executionCompleted).toBe(false);
    expect(target === 3 ? first.generation : first.review).toMatchObject({
      status: "last-confirmed",
      snapshot: { revision: target },
      stop: null,
      transport: null,
    });
    expect(network).toHaveBeenCalledTimes(target === 3 ? 0 : 1);
    const budget = store.providerBudgetGet("production"),
      bytes = readFileSync(file());
    const repeat = await execute();
    expect(repeat.executionCompleted).toBe(false);
    expect(target === 3 ? repeat.generation.stop : repeat.review?.stop).toBeNull();
    expect(network).toHaveBeenCalledTimes(target === 3 ? 0 : 1);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(readFileSync(file())).toEqual(bytes);
  },
  25000,
);

it.each(["generation", "review"])(
  "retains and recovers the same %s capture after failed persistence and rejects another nonce",
  async (phase) => {
    const method = phase === "generation" ? "recordResponse" : "recordReviewResponse";
    const fault = vi
      .spyOn(ProviderGenerationDispatchStore.prototype, method)
      .mockImplementation(() => {
        throw Error("synthetic storage unavailable");
      });
    const result = await execute();
    const capture =
      phase === "generation" ? result.generation.pendingCapture : result.review?.pendingCapture;
    expect(capture).toBeTruthy();
    expect(result.executionCompleted).toBe(false);
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
    const bytes = readFileSync(file());
    const recover = (raw: unknown) =>
      phase === "generation"
        ? store.providerRecoverProductionGenerationCapture(raw)
        : store.providerRecoverProductionReviewCapture(raw);
    expect(() => recover({ ...capture, responseRequestId: randomUUID() })).toThrow();
    expect(readFileSync(file())).toEqual(bytes);
    fault.mockRestore();
    reopen();
    revokeProviderProductionRuntime(runtime);
    const recovered = recover(capture);
    expect(recovered.pendingCapture).toBeNull();
    expect(recovered.status).toBe(phase === "generation" ? "generation-validated" : "completed");
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
  },
  25000,
);

it.each(["generation", "review"])(
  "captures unknown %s usage before the scoped stop and never releases sent cost",
  async (phase) => {
    delete (phase === "generation" ? generationRaw : reviewRaw).usage;
    const result = await execute();
    const stopped = phase === "generation" ? result.generation : result.review!;
    expect(stopped).toMatchObject({
      response: { responsePersisted: true },
      pendingCapture: null,
      stop: { state: "committed" },
    });
    expect(result.executionCompleted).toBe(false);
    expect(stopped.stop?.outcome).toBe("needs-cost-review");
    expect(stopped.response?.usageBudgetEventDigest).toBeNull();
    expect(
      BigInt(
        phase === "generation"
          ? result.generation.stop!.generationHeldUnitsAtStop
          : result.review!.stop!.reviewHeldUnitsAtStop,
      ),
    ).toBeGreaterThan(BigInt(0));
    expect(network).toHaveBeenCalledTimes(phase === "generation" ? 1 : 2);
  },
  25000,
);

it("rejects recovery for a different original dispatch or review phase scope", async () => {
  const n = providerGenerationRunnerNonces(identity);
  const capture = {
    dispatch: identity,
    responseRequestId: n.responseRequestId,
    response: generationRaw,
  };
  expect(() =>
    store.providerRecoverProductionGenerationCapture({
      ...capture,
      dispatch: { ...identity, approvalBindingDigest: "0".repeat(64) },
    }),
  ).toThrow();
  const scope = providerReviewRunnerScope({
    generation: {
      dispatch: identity,
      responseRequestId: n.responseRequestId,
      responseEventDigest: "a".repeat(64),
      validationRequestId: n.validationRequestId,
    },
    validationEventDigest: "b".repeat(64),
  });
  expect(() =>
    store.providerRecoverProductionReviewCapture({
      dispatch: { ...scope.dispatch, preparedRequestId: randomUUID() },
      responseRequestId: scope.nonces.responseRequestId,
      response: reviewRaw,
    }),
  ).toThrow();
  expect(store.providerGet(identity.runId).revision).toBe(1);
  expect(network).not.toHaveBeenCalled();
});
