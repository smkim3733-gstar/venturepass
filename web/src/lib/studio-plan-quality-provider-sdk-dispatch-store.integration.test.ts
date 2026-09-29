import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { reviewDispatchStoreFixture } from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import * as configuration from "./studio-plan-quality-provider-configuration";

describe.each(["generation", "review"] as const)(
  "%s owned SDK dispatch with temporary SQLite",
  (phase) => {
    let directory: string, store: PlanQualityStore, db: DatabaseSync;
    let identity: ProviderGenerationDispatchIdentity | ProviderReviewDispatchIdentity;
    const network = vi.fn<typeof fetch>();
    const options = () => ({
      providerEnvironment: "synthetic-test" as const,
      providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: network },
    });
    const gen = () =>
      phase === "generation"
        ? (identity as ProviderGenerationDispatchIdentity)
        : (identity as ProviderReviewDispatchIdentity).generation.dispatch;
    const execute = (raw: unknown = identity) =>
      phase === "generation"
        ? store.providerSimulateGenerationSdkDispatch(raw)
        : store.providerSimulateReviewSdkDispatch(raw);
    const response = () =>
      Response.json(generationResponseFixture(gen()).response, {
        headers: { "x-request-id": "synthetic-request" },
      });
    beforeEach(async () => {
      network.mockReset();
      network.mockImplementation(async () => response());
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(actualTestNow);
      vi.stubGlobal("fetch", forbidden);
      directory = mkdtempSync(join(tmpdir(), "venture-sdk-dispatch-store-"));
      writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
      store = new PlanQualityStore(directory, options());
      store.candidateRegistryRegister({
        expectedVersion: 0,
        clientRequestId: randomUUID(),
        sourceDigest: store.candidateRegistryList().source.sourceDigest,
        acknowledgedCandidateStatus: true,
      });
      identity =
        phase === "generation"
          ? generationDispatchStoreFixture(store)
          : await reviewDispatchStoreFixture(store);
      db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
      db.function("quality_storage_contract", () => "quality-v9");
    }, 20000);
    afterEach(() => {
      vi.restoreAllMocks();
      db.close();
      store.close();
      expect(forbidden).not.toHaveBeenCalled();
      expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(
        "synthetic company sentinel",
      );
      vi.useRealTimers();
      vi.unstubAllGlobals();
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (!rel.startsWith("venture-sdk-dispatch-store-") || rel.includes(".."))
        throw Error("Unsafe cleanup");
      rmSync(directory, { recursive: true, force: true });
    });
    function atCommit(number: number, callback: () => void, before = false) {
      const original = DatabaseSync.prototype.exec;
      let count = 0;
      return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        const target = sql === "COMMIT" && ++count === number;
        if (target && before) callback();
        const result = original.call(this, sql);
        if (target && !before) callback();
        return result;
      });
    }
    it.each(["DELETE", "WAL"])(
      "holds the %s writer through real SDK fetch initiation but releases before waiting; replay never sends",
      async (journal) => {
        db.exec(`PRAGMA journal_mode=${journal}; PRAGMA busy_timeout=0`);
        const budget = store.providerBudgetGet("production");
        let started!: () => void, complete!: (value: Response) => void;
        const began = new Promise<void>((resolve) => {
          started = resolve;
        });
        network.mockImplementation((_url, init) => {
          started();
          // Read committed evidence through the independent connection; reentering a
          // parent store method here would incorrectly open a nested transaction.
          const artifact = db
            .prepare(
              "SELECT payload FROM quality_actual_artifacts WHERE run_id=? AND artifact_key=?",
            )
            .get(gen().runId, phase === "generation" ? "generation-request" : "review-request");
          expect(Buffer.from(artifact!.payload as Uint8Array).toString("utf8")).toBe(init?.body);
          expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
          return new Promise((resolve) => {
            complete = resolve;
          });
        });
        const pending = execute();
        expect(network).not.toHaveBeenCalled();
        await began;
        db.exec("BEGIN IMMEDIATE");
        db.exec("COMMIT");
        complete(response());
        const first = await pending;
        expect(first).toMatchObject({
          newlyCommitted: true,
          replayed: false,
          responsePersisted: false,
          transport: {
            fetchStarted: true,
            delivery: "response-captured",
            finalCheckFailedAfterStart: false,
          },
        });
        expect(store.providerBudgetGet("production")).toEqual(budget);
        expect(store.providerGet(gen().runId).revision).toBe(phase === "generation" ? 3 : 7);
        db.close();
        store.close();
        store = new PlanQualityStore(directory, options());
        db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
        db.function("quality_storage_contract", () => "quality-v9");
        expect(await execute()).toMatchObject({
          record: first.record,
          newlyCommitted: false,
          replayed: true,
          transport: null,
        });
        expect(network).toHaveBeenCalledTimes(1);
      },
      15000,
    );
    it("clones identity before COMMIT and preserves it through asynchronous SDK preparation", async () => {
      const original = structuredClone(identity),
        pending = execute();
      identity.preparedRequestId = randomUUID();
      const first = await pending;
      expect(first).toMatchObject({
        record: original,
        transport: { delivery: "response-captured" },
      });
      expect(await execute(original)).toMatchObject({ replayed: true, transport: null });
      expect(network).toHaveBeenCalledTimes(1);
    });
    it.each(["expiry", "configuration", "policy"])(
      "rechecks %s changed during SDK preparation, after the durable dispatch intent",
      async (change) => {
        const pending = execute();
        if (change === "expiry") vi.setSystemTime("2035-01-01T00:00:00.000Z");
        if (change === "configuration")
          vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(null);
        if (change === "policy") adoptReservationTestPolicy(store);
        expect(await pending).toMatchObject({
          newlyCommitted: true,
          transport: {
            delivery: "not-sent",
            fetchStarted: false,
            refusal: "current-check-rejected",
          },
        });
        expect(await execute()).toMatchObject({ replayed: true, transport: null });
        expect(network).not.toHaveBeenCalled();
        expect(store.providerGet(gen().runId).revision).toBe(phase === "generation" ? 3 : 7);
      },
      15000,
    );
    it("rejects expiration reached during the final locked audit", async () => {
      const pending = execute(),
        get = configuration.getProviderConfigurationProposal;
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
        const result = get();
        vi.setSystemTime("2035-01-01T00:00:00.000Z");
        return result;
      });
      expect(await pending).toMatchObject({
        transport: { delivery: "not-sent", fetchStarted: false },
      });
      expect(network).not.toHaveBeenCalled();
    });
    it.each(["before", "after"])(
      "does not send after an uncertain initial COMMIT failure %s SQLite",
      async (when) => {
        const hook = atCommit(
          1,
          () => {
            throw Error("synthetic commit failure");
          },
          when === "before",
        );
        await expect(execute()).rejects.toThrow();
        hook.mockRestore();
        expect(network).not.toHaveBeenCalled();
        const retry = await execute();
        expect(retry.newlyCommitted).toBe(when === "before");
        expect(network).toHaveBeenCalledTimes(when === "before" ? 1 : 0);
      },
    );
    it.each(["before", "after"])(
      "retains response after final read COMMIT fails %s SQLite and can persist it separately",
      async (when) => {
        const hook = atCommit(
          2,
          () => {
            throw Error("synthetic final commit failure");
          },
          when === "before",
        );
        const result = await execute();
        hook.mockRestore();
        expect(result).toMatchObject({
          transport: {
            fetchStarted: true,
            finalCheckFailedAfterStart: true,
            delivery: "response-captured",
            observation: { kind: "response-captured" },
          },
          responsePersisted: false,
        });
        const observation = result.transport?.observation;
        if (observation?.kind !== "response-captured") throw Error("Missing raw observation");
        const saved =
          phase === "generation"
            ? store.providerRecordGenerationResponse({
                ...generationResponseFixture(gen()),
                response: observation.response,
              })
            : store.providerRecordReviewResponse({
                ...reviewResponseCapture(identity as ProviderReviewDispatchIdentity),
                response: observation.response,
              });
        expect(saved.newlyCommitted).toBe(true);
        expect(store.providerGet(gen().runId).revision).toBe(phase === "generation" ? 4 : 8);
        expect(await execute()).toMatchObject({ replayed: true, transport: null });
        expect(network).toHaveBeenCalledTimes(1);
      },
      15000,
    );
    it("preserves dispatch intent and all holds after an unobserved network result", async () => {
      const before = store.providerBudgetGet("production");
      network.mockRejectedValue(new TypeError("synthetic network failure"));
      expect(await execute()).toMatchObject({
        transport: {
          delivery: "send-result-unobserved",
          observation: {
            kind: "result-unobserved",
            reason: "connection",
            automaticRetryAllowed: false,
          },
        },
      });
      expect(store.providerBudgetGet("production")).toEqual(before);
      expect(await execute()).toMatchObject({ replayed: true, transport: null });
      expect(network).toHaveBeenCalledTimes(1);
    });
    it("rejects command transport/credential/options injection before any rows change", async () => {
      const before = inspectQualityDatabase(db);
      for (const key of [
        "apiKey",
        "model",
        "baseURL",
        "fetch",
        "maxRetries",
        "transport",
        "dispatchAllowed",
      ])
        await expect(execute({ ...identity, [key]: "injected" })).rejects.toThrow();
      expect(inspectQualityDatabase(db)).toEqual(before);
      expect(network).not.toHaveBeenCalled();
    });
    it("keeps default stores and synthetic stores without explicit SDK test networking closed", async () => {
      const before = inspectQualityDatabase(db);
      store.close();
      store = new PlanQualityStore(directory);
      await expect(execute()).rejects.toMatchObject({
        code: expect.stringContaining("SDK_SIMULATION_DISABLED"),
      });
      store.close();
      store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
      await expect(execute()).rejects.toMatchObject({
        code: expect.stringContaining("SDK_SIMULATION_DISABLED"),
      });
      expect(
        () =>
          new PlanQualityStore(directory, {
            providerSdkTestNetwork: options().providerSdkTestNetwork,
          }),
      ).toThrow("TEST_NETWORK_DISABLED");
      expect(inspectQualityDatabase(db)).toEqual(before);
      expect(network).not.toHaveBeenCalled();
    });
  },
);
