import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("Real external access forbidden");
  }),
);
vi.mock("openai", () => ({ default: forbidden }));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  createProviderProductionRuntime,
  revokeProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import * as configuration from "./studio-plan-quality-provider-configuration";

let directory: string, store: PlanQualityStore | undefined, runtime: ProviderProductionRuntime;
const key = "sk-synthetic-production-readiness-test-only";
const dbFile = () => join(directory, "quality-evaluation", "quality.sqlite");
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", key);
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  directory = mkdtempSync(join(tmpdir(), "venture-production-readiness-"));
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  runtime = createProviderProductionRuntime();
});
afterEach(() => {
  vi.restoreAllMocks();
  store?.close();
  store = undefined;
  revokeProviderProductionRuntime(runtime);
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-production-readiness-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
it.each(["fake", "clone", "revoked", "null"])(
  "rejects %s runtime before creating a database",
  (kind) => {
    let value: unknown = kind === "clone" ? { ...runtime } : kind === "null" ? null : {};
    if (kind === "revoked") {
      value = runtime;
      revokeProviderProductionRuntime(runtime);
    }
    expect(
      () =>
        new PlanQualityStore(directory, {
          providerProductionRuntime: value as ProviderProductionRuntime,
        }),
    ).toThrow("PROVIDER_PRODUCTION_RUNTIME_UNAVAILABLE");
    expect(existsSync(dbFile())).toBe(false);
  },
);
it.each(["actual", "provider", "network"])(
  "rejects mixing production runtime with %s test authority before DB creation",
  (kind) => {
    const mixed =
      kind === "actual"
        ? { actualEnvironment: "synthetic-test" as const }
        : kind === "provider"
          ? { providerEnvironment: "synthetic-test" as const }
          : { providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: forbidden } };
    expect(
      () => new PlanQualityStore(directory, { ...mixed, providerProductionRuntime: runtime }),
    ).toThrow("PROVIDER_PRODUCTION_RUNTIME_TEST_MIXED");
    expect(existsSync(dbFile())).toBe(false);
  },
);
describe("audited production readiness from synthetic approvals in a temporary DB", () => {
  let identity: ProviderGenerationDispatchIdentity;
  beforeEach(() => {
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    identity = generationDispatchStoreFixture(store);
  }, 20000);
  function reopen(withRuntime = true) {
    store!.close();
    store = undefined;
    store = new PlanQualityStore(
      directory,
      withRuntime ? { providerProductionRuntime: runtime } : {},
    );
    return store;
  }
  it("uses one read transaction, returns only bound metadata and keeps the run/budget/DB untouched", () => {
    const current = reopen();
    const budget = current.providerBudgetGet("production"),
      snapshot = current.providerGet(identity.runId);
    const bytes = readFileSync(dbFile());
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const ready = current.providerProductionGenerationReadiness(identity);
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    exec.mockRestore();
    expect(ready).toMatchObject({
      status: "ready-for-writer-check",
      identity,
      basis: { revision: 1, approvalBindingDigest: identity.approvalBindingDigest },
      dispatchAllowed: false,
      recordingAllowed: false,
      budgetWriteAllowed: false,
      ownership: "new-commit-owner-required",
      runtime: { credentialAuthenticated: false },
    });
    expect(Object.isFrozen(ready)).toBe(true);
    for (const field of ["rows", "commands", "rawBody", "apiKey", "plan"])
      expect(ready).not.toHaveProperty(field);
    expect(JSON.stringify(ready)).not.toContain(key);
    expect(current.providerGet(identity.runId)).toEqual(snapshot);
    expect(current.providerBudgetGet("production")).toEqual(budget);
    expect(readFileSync(dbFile())).toEqual(bytes);
  });
  it("does not auto-enable a default or synthetic store from an environment key", () => {
    expect(store!.providerProductionGenerationReadiness(identity)).toMatchObject({
      status: "blocked",
      reason: "runtime-unavailable",
    });
    const current = reopen(false),
      bytes = readFileSync(dbFile());
    expect(current.providerProductionGenerationReadiness(identity)).toMatchObject({
      reason: "runtime-unavailable",
      dispatchAllowed: false,
    });
    expect(readFileSync(dbFile())).toEqual(bytes);
  });
  it("honors revocation after construction and during the current evidence inspection", () => {
    const current = reopen(),
      bytes = readFileSync(dbFile());
    const original = configuration.getProviderConfigurationProposal;
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
      revokeProviderProductionRuntime(runtime);
      return original();
    });
    expect(current.providerProductionGenerationReadiness(identity)).toMatchObject({
      reason: "runtime-unavailable",
    });
    expect(current.providerProductionGenerationReadiness(identity)).toMatchObject({
      reason: "runtime-unavailable",
    });
    expect(readFileSync(dbFile())).toEqual(bytes);
  });
  it("rejects command overrides, original approval substitutions and nonce collisions without changes", () => {
    const current = reopen(),
      bytes = readFileSync(dbFile());
    for (const override of [
      "apiKey",
      "model",
      "fetch",
      "baseURL",
      "runtime",
      "configuration",
      "inspectedAt",
      "authority",
    ]) {
      expect(
        current.providerProductionGenerationReadiness({ ...identity, [override]: "injected" }),
      ).toMatchObject({ reason: "invalid-input" });
    }
    expect(
      current.providerProductionGenerationReadiness({
        ...identity,
        approvalBindingDigest: "0".repeat(64),
      }),
    ).toMatchObject({ reason: "approval-binding-required" });
    expect(
      current.providerProductionGenerationReadiness({ ...identity, runDigest: "0".repeat(64) }),
    ).toMatchObject({ reason: "selection-changed" });
    expect(
      current.providerProductionGenerationReadiness({
        ...identity,
        preparedRequestId: identity.dispatchRequestId,
      }),
    ).toMatchObject({ reason: "nonce-conflict" });
    expect(readFileSync(dbFile())).toEqual(bytes);
  });
  it.each(["expiry", "configuration", "policy"])(
    "blocks changed %s and preserves the original hold",
    (change) => {
      if (change === "policy") adoptReservationTestPolicy(store!);
      const current = reopen(),
        budget = current.providerBudgetGet("production"),
        bytes = readFileSync(dbFile());
      if (change === "expiry") vi.setSystemTime("2035-01-01T00:00:00.000Z");
      if (change === "configuration")
        vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
      expect(current.providerProductionGenerationReadiness(identity)).toMatchObject({
        status: "blocked",
        dispatchAllowed: false,
        recordingAllowed: false,
      });
      expect(current.providerBudgetGet("production")).toEqual(budget);
      expect(current.providerGet(identity.runId).revision).toBe(1);
      expect(readFileSync(dbFile())).toEqual(bytes);
    },
  );
  it("never turns historical r3 into a new owner or a stop/resend after expiry", async () => {
    await store!.providerSimulateGenerationDispatch(identity, {
      provenance: "synthetic-test",
      send: async () => undefined,
    });
    const current = reopen(),
      budget = current.providerBudgetGet("production"),
      bytes = readFileSync(dbFile());
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    expect(current.providerProductionGenerationReadiness(identity)).toMatchObject({
      reason: "first-generation-required",
      dispatchAllowed: false,
    });
    expect(
      current.providerProductionGenerationReadiness({
        ...identity,
        preparedRequestId: randomUUID(),
        dispatchRequestId: randomUUID(),
      }),
    ).toMatchObject({ reason: "first-generation-required" });
    expect(current.providerGet(identity.runId).revision).toBe(3);
    expect(current.providerBudgetGet("production")).toEqual(budget);
    expect(readFileSync(dbFile())).toEqual(bytes);
  }, 15000);
  it("keeps both SDK simulation and every phase recording gate closed for a configured runtime", async () => {
    const current = reopen(),
      bytes = readFileSync(dbFile());
    await expect(current.providerSimulateGenerationSdkDispatch(identity)).rejects.toThrow();
    await expect(current.providerSimulateReviewSdkDispatch(identity)).rejects.toThrow();
    await expect(
      current.providerSimulateGenerationDispatch(identity, {
        provenance: "synthetic-test",
        send: forbidden,
      }),
    ).rejects.toThrow();
    const writes = [
      () => current.providerRecordGenerationResponse(null),
      () => current.providerRecordGenerationValidation(null),
      () => current.providerRecordGenerationStop(null),
      () => current.providerRecordReviewResponse(null),
      () => current.providerRecordReviewValidation(null),
      () => current.providerRecordReviewStop(null),
      () => current.providerRecordFinalization(null),
    ];
    for (const write of writes) expect(write).toThrow();
    expect(readFileSync(dbFile())).toEqual(bytes);
  });
  it("fails closed on corrupted native rows instead of returning stale readiness", () => {
    const current = reopen();
    const db = new DatabaseSync(dbFile());
    try {
      db.function("quality_storage_contract", () => "quality-v9");
      const trigger = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='quality_actual_events_no_update'",
        )
        .get();
      if (typeof trigger?.sql !== "string") throw Error("Missing immutable test fixture trigger");
      // Corrupt only this isolated fixture, then restore the exact schema so the audit must
      // detect bad row content rather than merely noticing the absent immutability guard.
      db.exec("DROP TRIGGER quality_actual_events_no_update");
      db.prepare("UPDATE quality_actual_events SET body_hash=? WHERE run_id=?").run(
        "0".repeat(64),
        identity.runId,
      );
      db.exec(trigger.sql);
    } finally {
      db.close();
    }
    const bytes = readFileSync(dbFile());
    expect(() => current.providerProductionGenerationReadiness(identity)).toThrow();
    expect(readFileSync(dbFile())).toEqual(bytes);
  });
});
