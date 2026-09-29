import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import {
  generationResponseFixture,
  appendUnobservedGenerationStop,
} from "./studio-plan-quality-provider-response-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { getProviderExecutionBudgetSnapshot } from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  captureGenerationResponseInput,
  type ProviderGenerationResponseInput,
} from "./studio-plan-quality-provider-generation-response";
import type {
  ProviderExecutionSnapshot,
  ProviderExecutionBudgetSnapshot,
} from "./studio-plan-quality-provider-execution-types";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
let root: string,
  directory: string,
  store: PlanQualityStore,
  db: DatabaseSync,
  input: ProviderGenerationResponseInput;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-response-store-"));
  directory = join(root, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  input = generationResponseFixture(generationDispatchStoreFixture(store));
  await store.providerSimulateGenerationDispatch(input.dispatch, {
    provenance: "synthetic-test",
    send,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 15000);
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-response-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const record = () => store.providerRecordGenerationResponse(input);
const snapshot = () => store.providerGet(input.dispatch.runId) as ProviderExecutionSnapshot;
const inspect = () => inspectQualityDatabase(db);
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
function reopen() {
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
}
function phase(name: "generation" | "review") {
  const state = snapshot();
  return getProviderExecutionBudgetSnapshot(
    state.budgetEvents,
    state.run.preparation.budget.scopeId,
  )
    .reservations.find((r) => r.runId === input.dispatch.runId)!
    .phases.find((p) => p.phase === name)!;
}

it("atomically preserves captured JSON and native recognition, consuming only the generation hold", () => {
  const before = inspect(),
    held = phase("generation"),
    review = phase("review"),
    capacity = usage();
  const saved = record();
  expect(saved).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      state: "committed",
      revision: 4,
      responsePersisted: true,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      usageAssessment: { status: "known" },
    },
  });
  expect(saved.record.usageBudgetEventDigest).toMatch(/^[a-f0-9]{64}$/);
  const response = JSON.parse(
    store.providerArtifact(input.dispatch.runId, "generation-response").body.toString("utf8"),
  );
  expect(response).toEqual({ captureKind: "sdk-response-json-v2", response: input.response });
  expect(phase("generation")).toMatchObject({
    settled: true,
    heldUnits: "0",
    recognizedUnits: saved.record.usageAssessment.units,
  });
  expect(
    BigInt(phase("generation").releasedUnits) + BigInt(saved.record.usageAssessment.units!),
  ).toBe(BigInt(held.heldUnits));
  expect(phase("review")).toEqual(review);
  expect(snapshot()).toMatchObject({
    revision: 4,
    state: "response-recorded",
    terminal: false,
    unsettled: true,
    actualAiCalls: null,
    dispatchIntentCount: 1,
    responseCount: 1,
    unobservedDispatchCount: 0,
    dispatchAllowed: false,
    canResume: false,
  });
  const after = inspect();
  expect(after).toEqual({
    ...before,
    digest: after.digest,
    actualEvents: before.actualEvents + 1,
    actualRequests: before.actualRequests + 1,
    actualArtifacts: before.actualArtifacts + 1,
    actualBudgetEvents: before.actualBudgetEvents + 1,
  });
  const nextCapacity = usage();
  expect(nextCapacity.usedBytes).toBeGreaterThan(capacity.usedBytes);
  expect(nextCapacity.usedBytes + nextCapacity.reservedBytes).toBe(
    capacity.usedBytes + capacity.reservedBytes,
  );
  expect(Object.isFrozen(saved.record.usageAssessment.normalized)).toBe(true);
});
it.each(["missing-usage", "missing-cache", "wrong-total", "wrong-model", "wrong-tier"])(
  "keeps every financial hold when usage is unknown: %s",
  (kind) => {
    if (kind === "missing-usage") delete input.response.usage;
    if (kind === "missing-cache")
      input.response.usage = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };
    if (kind === "wrong-total")
      input.response.usage = {
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 31,
        input_tokens_details: { cached_tokens: 5 },
      };
    if (kind === "wrong-model") input.response.model = "unexpected-model";
    if (kind === "wrong-tier") input.response.service_tier = "priority";
    const before = store.providerBudgetGet("production"),
      count = inspect().actualBudgetEvents;
    expect(record().record).toMatchObject({
      responsePersisted: true,
      usageBudgetEventDigest: null,
      usageAssessment: { status: "unknown", units: null },
    });
    expect(store.providerBudgetGet("production")).toEqual(before);
    expect(inspect().actualBudgetEvents).toBe(count);
    expect(snapshot()).toMatchObject({ responseCount: 1, unsettled: true });
  },
);
it.each([600000, 2000000])(
  "records a bound breach of %i output tokens without releasing the unsent review hold",
  (tokens) => {
    input.response.usage = {
      input_tokens: 20,
      output_tokens: tokens,
      total_tokens: 20 + tokens,
      input_tokens_details: { cached_tokens: 5 },
    };
    const review = phase("review"),
      saved = record();
    expect(saved.record.usageAssessment.status).toBe("known");
    expect(saved.record.usageAssessment.violations.length).toBeGreaterThan(0);
    expect(
      (store.providerBudgetGet("production") as ProviderExecutionBudgetSnapshot).boundBreached,
    ).toBe(true);
    expect(phase("review")).toEqual(review);
    expect(snapshot().dispatchAllowed).toBe(false);
    expect(snapshot().responseCount).toBe(1);
  },
);
it.each(["malformed", "missing", "incomplete"])(
  "preserves cost evidence even when output is %s, without domain validation",
  (kind) => {
    if (kind === "malformed") input.response.output = "not an output array";
    if (kind === "missing") delete input.response.output;
    if (kind === "incomplete") input.response.status = "incomplete";
    expect(record().record.usageAssessment.status).toBe("known");
    expect(snapshot().events.some((e) => e.payload.kind === "domain-validated")).toBe(false);
  },
);
it("accepts an already captured response after expiry, policy replacement and missing configuration", () => {
  adoptReservationTestPolicy(store, 0);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const config = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw new Error("configuration unavailable");
    });
  expect(record().record.usageAssessment.status).toBe("known");
  expect(config).not.toHaveBeenCalled();
});
it.each(["known", "unknown"])(
  "preserves a late %s response after a native result-unobserved stop without reopening execution",
  (kind) => {
    appendUnobservedGenerationStop(db, snapshot());
    expect(snapshot()).toMatchObject({
      revision: 4,
      state: "result-unobserved",
      terminal: true,
      unsettled: true,
    });
    const review = phase("review"),
      generation = phase("generation");
    if (kind === "unknown") delete input.response.usage;
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const saved = record();
    expect(saved.record.revision).toBe(5);
    expect(snapshot()).toMatchObject({
      state: "result-unobserved",
      terminal: true,
      responseCount: 1,
      unsettled: kind === "unknown",
      canResume: false,
    });
    expect(phase("review")).toEqual(review);
    if (kind === "unknown") expect(phase("generation")).toEqual(generation);
    else expect(phase("generation").heldUnits).toBe("0");
    expect(record()).toEqual({ record: saved.record, newlyCommitted: false, replayed: true });
  },
);
it("replays and looks up the original response after reopen without changing any rows or budget", async () => {
  const first = record(),
    before = inspect(),
    budget = store.providerBudgetGet("production");
  reopen();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw new Error("no current config");
  });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(store.providerGenerationResponseLookup(input)).toEqual(first.record);
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(
    await store.providerSimulateGenerationDispatch(input.dispatch, {
      provenance: "synthetic-test",
      send,
    }),
  ).toMatchObject({ delivery: "already-recorded" });
});
it.each(["nonce", "body", "usage", "response-id", "binding", "dispatch-nonce"])(
  "refuses conflicting %s without replacing the original response",
  (kind) => {
    record();
    const before = inspect();
    if (kind === "nonce") input.responseRequestId = randomUUID();
    if (kind === "body") input.response.output = ["different"];
    if (kind === "usage") input.response.usage = null;
    if (kind === "response-id") input.response.id = "different";
    if (kind === "binding") input.dispatch.approvalBindingDigest = "0".repeat(64);
    if (kind === "dispatch-nonce") input.dispatch.dispatchRequestId = randomUUID();
    expect(record).toThrow();
    expect(() => store.providerGenerationResponseLookup(input)).toThrow();
    expect(inspect()).toEqual(before);
  },
);
it("reports not-observed before saving and refuses a globally occupied nonce", () => {
  expect(store.providerGenerationResponseLookup(input)).toEqual({ state: "not-observed" });
  input.responseRequestId = input.dispatch.preparedRequestId;
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_RESPONSE_CONFLICT" }),
  );
  expect(inspect()).toEqual(before);
});
it.each(["metadata", "usageAssessment", "dispatchAllowed", "configuration"])(
  "rejects caller-supplied %s",
  (field) => {
    const before = inspect();
    expect(() => store.providerRecordGenerationResponse({ ...input, [field]: {} })).toThrow();
    expect(inspect()).toEqual(before);
  },
);
it("captures immutable selected SDK JSON without evaluating excluded SDK objects or getters", () => {
  const extra = {
    ...input,
    response: {
      ...input.response,
      client: { toJSON: forbidden },
      headers: { authorization: "synthetic-do-not-store" },
    },
  };
  const captured = captureGenerationResponseInput(extra);
  extra.response.output = [];
  expect(Object.isFrozen(captured.response.output)).toBe(true);
  store.providerRecordGenerationResponse(captured);
  const raw = store
    .providerArtifact(input.dispatch.runId, "generation-response")
    .body.toString("utf8");
  expect(raw).not.toContain("synthetic-do-not-store");
  expect(raw).toContain("synthetic unvalidated output");
  const accessor = { ...input, response: Object.defineProperty({}, "usage", { get: forbidden }) };
  expect(() => store.providerRecordGenerationResponse(accessor)).toThrow(
    "PROVIDER_RESPONSE_NOT_JSON",
  );
});
it("rejects oversized capture before writing and keeps unknown-cost hold", () => {
  input.response.output = ["한".repeat(2 * 1024 * 1024)];
  const before = inspect();
  expect(record).toThrow("PROVIDER_RESPONSE_TOO_LARGE");
  expect(inspect()).toEqual(before);
});
it.each([
  ["known", 1],
  ["known", 2],
  ["known", 3],
  ["known", 4],
  ["unknown", 1],
  ["unknown", 2],
  ["unknown", 3],
] as const)("rolls back %s response and settlement together after INSERT %i", (kind, point) => {
  if (kind === "unknown") delete input.response.usage;
  const before = inspect(),
    budget = store.providerBudgetGet("production"),
    prepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  const hook = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const stmt = prepare.call(this, sql);
    if (/^INSERT INTO quality_actual_(artifacts|budget_events|events|requests)\(/.test(sql)) {
      const run = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation((...args) => {
        const result = run(...args);
        if (++inserts === point) throw new Error("synthetic INSERT failure");
        return result;
      });
    }
    return stmt;
  });
  expect(record).toThrow();
  hook.mockRestore();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGenerationResponseLookup(input)).toEqual({ state: "not-observed" });
  expect(record().newlyCommitted).toBe(true);
});
it.each(["before", "after"])(
  "recovers exact response when COMMIT throws %s SQLite commits",
  (point) => {
    const exec = DatabaseSync.prototype.exec;
    let first = true;
    const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const target = first && sql === "COMMIT";
      if (target) first = false;
      if (target && point === "before") throw new Error("uncertain commit");
      const result = exec.call(this, sql);
      if (target && point === "after") throw new Error("uncertain commit");
      return result;
    });
    expect(record).toThrow();
    hook.mockRestore();
    reopen();
    expect(snapshot().revision).toBe(point === "before" ? 3 : 4);
    expect(phase("generation").settled).toBe(point === "after");
    expect(store.providerGenerationResponseLookup(input).state).toBe(
      point === "before" ? "not-observed" : "committed",
    );
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    expect(record().replayed).toBe(point === "after");
    expect(snapshot().responseCount).toBe(1);
  },
);
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("requires full v9 evidence when %s is corrupted", (table) => {
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.prepare(`DELETE FROM ${table}`).run();
  for (const trigger of triggers) db.exec(trigger.sql);
  expect(record).toThrow();
  expect(() => store.providerGenerationResponseLookup(input)).toThrow();
});
it("keeps default response writes and general native production execution closed", () => {
  store.close();
  store = new PlanQualityStore(directory);
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_RESPONSE_RECORDING_DISABLED" }),
  );
  expect(inspect()).toEqual(before);
  expect(store.providerGenerationResponseLookup(input)).toEqual({ state: "not-observed" });
});
it("restores raw response and exactly one cost recognition from a backup", async () => {
  const first = record(),
    budget = store.providerBudgetGet("production"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  expect(record()).toEqual({ record: first.record, newlyCommitted: false, replayed: true });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerGenerationResponseLookup(input)).toEqual(first.record);
}, 150000);
