import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  reviewDispatchStoreFixture,
  appendReviewUnobservedStop,
} from "./studio-plan-quality-provider-review-dispatch-store-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import {
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  backupQualityData,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  getProviderExecutionBudgetSnapshot,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest } from "../../scripts/local-data-quality-provider.mjs";
import type {
  ProviderExecutionSnapshot,
  ProviderExecutionBudgetSnapshot,
  ProviderExecutionCommand,
} from "./studio-plan-quality-provider-execution-types";
import type { ProviderReviewResponseCapture } from "./studio-plan-quality-provider-review-response";
import * as planner from "./studio-plan-quality-provider-review-response";
import * as configuration from "./studio-plan-quality-provider-configuration";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External IO forbidden");
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
  input: ProviderReviewResponseCapture;
const send = vi.fn(async () => undefined);
beforeEach(async () => {
  forbidden.mockClear();
  send.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-review-response-commit-"));
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
  input = reviewResponseCapture(await reviewDispatchStoreFixture(store));
  await store.providerSimulateReviewDispatch(input.dispatch, {
    provenance: "synthetic-test",
    send,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 20000);
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
  if (!rel.startsWith("venture-review-response-commit-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const id = () => input.dispatch.generation.dispatch.runId;
const record = () => store.providerRecordReviewResponse(input);
const snapshot = () => store.providerGet(id()) as ProviderExecutionSnapshot;
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
  const s = snapshot();
  return getProviderExecutionBudgetSnapshot(s.budgetEvents, s.run.preparation.budget.scopeId)
    .reservations.find((row) => row.runId === id())!
    .phases.find((row) => row.phase === name)!;
}
it("atomically persists r8 capture and review settlement, preserves generation, and consumes reserved storage only", () => {
  const before = inspect(),
    generation = phase("generation"),
    hold = phase("review"),
    bytes = usage(),
    approved = snapshot().events[0],
    request = store.providerArtifact(id(), "review-request"),
    result = record();
  expect(result).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      revision: 8,
      late: false,
      responsePersisted: true,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      usageAssessment: { status: "known" },
    },
  });
  expect(JSON.parse(store.providerArtifact(id(), "review-response").body.toString("utf8"))).toEqual(
    { captureKind: "sdk-response-json-v2", response: input.response },
  );
  expect(phase("generation")).toEqual(generation);
  expect(phase("review")).toMatchObject({
    settled: true,
    heldUnits: "0",
    recognizedUnits: result.record.usageAssessment.units,
  });
  expect(BigInt(phase("review").releasedUnits) + BigInt(result.record.usageAssessment.units!)).toBe(
    BigInt(hold.heldUnits),
  );
  expect(snapshot()).toMatchObject({
    revision: 8,
    responseCount: 2,
    dispatchIntentCount: 2,
    terminal: false,
    unsettled: false,
    canResume: false,
  });
  expect(snapshot().events[0]).toEqual(approved);
  expect(store.providerArtifact(id(), "review-request")).toEqual(request);
  const after = inspect();
  expect(after).toEqual({
    ...before,
    digest: after.digest,
    actualEvents: before.actualEvents + 1,
    actualRequests: before.actualRequests + 1,
    actualArtifacts: before.actualArtifacts + 1,
    actualBudgetEvents: before.actualBudgetEvents + 1,
  });
  const next = usage();
  expect(next.usedBytes).toBeGreaterThan(bytes.usedBytes);
  expect(next.usedBytes + next.reservedBytes).toBe(bytes.usedBytes + bytes.reservedBytes);
  expect(Object.isFrozen(result.record.dispatch.generation.dispatch)).toBe(true);
  expect(Object.isFrozen(result.record.usageAssessment.normalized)).toBe(true);
});
it("keeps the full review hold for unknown usage and never guesses or resettles", () => {
  delete input.response.usage;
  const before = store.providerBudgetGet("production"),
    count = inspect().actualBudgetEvents;
  const result = record();
  expect(result.record).toMatchObject({
    usageAssessment: { status: "unknown", units: null },
    usageBudgetEventDigest: null,
  });
  expect(store.providerBudgetGet("production")).toEqual(before);
  expect(inspect().actualBudgetEvents).toBe(count);
  expect(record()).toEqual({ record: result.record, newlyCommitted: false, replayed: true });
});
it("preserves over-budget cost as fact even with malformed output", () => {
  input.response.usage = {
    input_tokens: 20,
    output_tokens: 2000000,
    total_tokens: 2000020,
    input_tokens_details: { cached_tokens: 5 },
  };
  input.response.output = "invalid output";
  const generation = phase("generation");
  const result = record();
  expect(result.record.usageAssessment).toMatchObject({ status: "known" });
  expect(result.record.usageAssessment.violations).toContain("RESERVATION_EXCEEDED");
  expect(store.providerBudgetGet("production")).toMatchObject({ boundBreached: true });
  expect(phase("generation")).toEqual(generation);
  expect(snapshot().events.filter((row) => row.payload.kind === "domain-validated")).toHaveLength(
    1,
  );
});
it("accepts an obtained response after expiry, current policy replacement and unavailable configuration", () => {
  adoptReservationTestPolicy(store, 0);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const config = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw Error("Unavailable");
    });
  expect(record().record.usageAssessment.status).toBe("known");
  expect(config).not.toHaveBeenCalled();
});
it.each(["known", "unknown", "excess"])(
  "records late %s response at r9 and retains terminal state through replay",
  (kind) => {
    appendReviewUnobservedStop(db, snapshot());
    const stopped = snapshot(),
      generation = phase("generation"),
      held = phase("review");
    if (kind === "unknown") delete input.response.usage;
    if (kind === "excess")
      input.response.usage = {
        input_tokens: 20,
        output_tokens: 2000000,
        total_tokens: 2000020,
        input_tokens_details: { cached_tokens: 5 },
      };
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const result = record();
    expect(result.record).toMatchObject({ revision: 9, late: true });
    expect(snapshot()).toMatchObject({
      revision: 9,
      state: "result-unobserved",
      terminal: true,
      responseCount: 2,
      canResume: false,
    });
    expect(snapshot().events[7]).toEqual(stopped.events[7]);
    expect(phase("generation")).toEqual(generation);
    if (kind === "unknown") expect(phase("review")).toEqual(held);
    else expect(phase("review").heldUnits).toBe("0");
    const before = inspect();
    reopen();
    expect(record()).toEqual({ record: result.record, newlyCommitted: false, replayed: true });
    expect(store.providerReviewResponseLookup(input)).toEqual(result.record);
    expect(inspect()).toEqual(before);
  },
);
it("historical replay/lookup precedes current planner, clock and configuration after reopen", async () => {
  const result = record();
  adoptReservationTestPolicy(store, 0);
  const before = inspect(),
    budget = store.providerBudgetGet("production");
  reopen();
  vi.spyOn(planner, "prepareVersionedProviderReviewResponse").mockImplementation(() => {
    throw Error("Do not plan historical response");
  });
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(() => {
    throw Error("No current configuration");
  });
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  expect(record()).toEqual({ record: result.record, newlyCommitted: false, replayed: true });
  expect(store.providerReviewResponseLookup(input)).toEqual(result.record);
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(
    await store.providerSimulateReviewDispatch(input.dispatch, {
      provenance: "synthetic-test",
      send,
    }),
  ).toMatchObject({ delivery: "already-recorded" });
});
it("historical r8 response remains identical after a later native terminal event", () => {
  const result = record(),
    s = snapshot(),
    budget = store.providerBudgetGet("production") as ProviderExecutionBudgetSnapshot;
  const command: ProviderExecutionCommand<"execution-stopped"> = {
    clientRequestId: randomUUID(),
    expectedRevision: 8,
    payload: {
      kind: "execution-stopped",
      outcome: "output-invalid",
      failureCode: "OUTPUT_INVALID",
      finalArtifactSha256: null,
    },
  };
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: id(),
    revision: 9,
    budgetRevision: budget.revision,
    previousEventDigest: s.events[7].eventDigest,
    recordedAt: new Date().toISOString(),
    payload: { ...command.payload, releasedBudgetEventDigests: [] },
  });
  const receipt = createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    kind: "provider-finish",
    clientRequestId: command.clientRequestId,
    inputDigest: providerExecutionOperationDigest(id(), command),
    runId: id(),
    runRevision: 9,
    budgetRevision: budget.revision,
    operationDigest: event.eventDigest,
    recordedAt: event.recordedAt,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
    ).run(id(), 9, JSON.stringify(event), providerDigest(event));
    db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
      receipt.clientRequestId,
      JSON.stringify(receipt),
      providerDigest(receipt),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const before = inspect();
  expect(record().record).toEqual(result.record);
  expect(inspect()).toEqual(before);
  expect(snapshot()).toMatchObject({ revision: 9, terminal: true });
});
it.each(["nonce", "output", "usage", "id", "raw-property-order"])(
  "refuses conflicting response %s without replacing original evidence",
  (kind) => {
    if (kind === "raw-property-order") input.response.output = [{ a: 1, b: 2 }];
    record();
    const before = inspect();
    if (kind === "nonce") input.responseRequestId = randomUUID();
    if (kind === "output") input.response.output = ["different"];
    if (kind === "usage") input.response.usage = null;
    if (kind === "id") input.response.id = "different";
    if (kind === "raw-property-order") input.response.output = [{ b: 2, a: 1 }];
    expect(record).toThrow(
      expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_RESPONSE_CONFLICT" }),
    );
    expect(() => store.providerReviewResponseLookup(input)).toThrow();
    expect(inspect()).toEqual(before);
  },
);
it.each([
  "preparedRequestId",
  "dispatchRequestId",
  "validationEventDigest",
  "generation.responseRequestId",
  "generation.responseEventDigest",
  "generation.validationRequestId",
  "generation.dispatch.runId",
  "generation.dispatch.runDigest",
  "generation.dispatch.approvalBindingDigest",
  "generation.dispatch.preparedRequestId",
  "generation.dispatch.dispatchRequestId",
])("requires exact historical identity: %s", (path) => {
  record();
  const before = inspect(),
    parts = path.split(".");
  let row = input.dispatch as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) row = row[key] as Record<string, unknown>;
  const key = parts.at(-1)!;
  row[key] = key.endsWith("Digest") ? "f".repeat(64) : randomUUID();
  expect(record).toThrow();
  expect(() => store.providerReviewResponseLookup(input)).toThrow();
  expect(inspect()).toEqual(before);
});
it("reports not-observed and rejects global nonce collisions without consuming a response slot", () => {
  expect(store.providerReviewResponseLookup(input)).toEqual({ state: "not-observed" });
  input.responseRequestId = input.dispatch.generation.validationRequestId;
  const before = inspect();
  expect(record).toThrow();
  expect(inspect()).toEqual(before);
});
it.each(["metadata", "usageAssessment", "configuration", "dispatchAllowed"])(
  "rejects caller-supplied %s",
  (field) => {
    const before = inspect();
    expect(() => store.providerRecordReviewResponse({ ...input, [field]: {} })).toThrow();
    expect(inspect()).toEqual(before);
  },
);
it("captures immutable selected bytes before BEGIN and never invokes SDK accessors/toJSON", () => {
  const original = structuredClone(input),
    exec = DatabaseSync.prototype.exec;
  Object.assign(input.response, {
    headers: { authorization: "synthetic-do-not-store" },
    toJSON: forbidden,
  });
  const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql === "BEGIN IMMEDIATE") input.response.output = [];
    return exec.call(this, sql);
  });
  store.providerRecordReviewResponse(input);
  hook.mockRestore();
  const raw = store.providerArtifact(id(), "review-response").body.toString("utf8");
  expect(JSON.parse(raw).response).toEqual(original.response);
  expect(raw).not.toContain("synthetic-do-not-store");
  expect(store.providerReviewResponseLookup(original).state).toBe("committed");
  const accessor = {
    ...original,
    response: Object.defineProperty({}, "usage", { get: forbidden }),
  };
  expect(() => store.providerRecordReviewResponse(accessor)).toThrow("PROVIDER_RESPONSE_NOT_JSON");
});
it("refuses oversized response before any write", () => {
  input.response.output = "한".repeat(2 * 1024 * 1024);
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
] as const)("rolls back %s response and budget together at INSERT %i", (kind, point) => {
  if (kind === "unknown") delete input.response.usage;
  const before = inspect(),
    budget = store.providerBudgetGet("production"),
    prepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  const hook = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (/^INSERT INTO quality_actual_(artifacts|budget_events|events|requests)\(/.test(sql)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => {
        const result = run(...args);
        if (++inserts === point) throw Error("Synthetic insert failure");
        return result;
      });
    }
    return statement;
  });
  expect(record).toThrow();
  hook.mockRestore();
  expect(inspect()).toEqual(before);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerReviewResponseLookup(input)).toEqual({ state: "not-observed" });
  expect(record().newlyCommitted).toBe(true);
});
it.each(["before", "after"])(
  "recovers exact response if COMMIT throws %s SQLite commits",
  (point) => {
    const exec = DatabaseSync.prototype.exec;
    let first = true;
    const hook = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const target = first && sql === "COMMIT";
      if (target) first = false;
      if (target && point === "before") throw Error("Uncertain commit");
      const result = exec.call(this, sql);
      if (target && point === "after") throw Error("Uncertain commit");
      return result;
    });
    expect(record).toThrow();
    hook.mockRestore();
    reopen();
    expect(snapshot().revision).toBe(point === "before" ? 7 : 8);
    expect(phase("review").settled).toBe(point === "after");
    expect(store.providerReviewResponseLookup(input).state).toBe(
      point === "before" ? "not-observed" : "committed",
    );
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    expect(record().replayed).toBe(point === "after");
    expect(snapshot().responseCount).toBe(2);
  },
);
it.each(["DELETE", "WAL"])("plans and audits under a writer lock in %s", (mode) => {
  db.exec(`PRAGMA journal_mode=${mode}`);
  const original = planner.prepareVersionedProviderReviewResponse;
  const hook = vi.spyOn(planner, "prepareVersionedProviderReviewResponse").mockImplementation((value) => {
    expect(value.additionalUsedBytes).toBeGreaterThan(0);
    expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    return original(value);
  });
  record();
  expect(hook).toHaveBeenCalledOnce();
});
it.each([
  "quality_provider_transmission_bindings",
  "quality_provider_reservation_bindings",
  "quality_provider_transmission_coverage",
])("refuses damaged %s in both new capture and historical lookup", (table) => {
  record();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec(`DELETE FROM ${table}`);
  for (const trigger of triggers) db.exec(trigger.sql);
  expect(record).toThrow();
  expect(() => store.providerReviewResponseLookup(input)).toThrow();
});
it("default store keeps production capture writes closed but can recover a stored response read-only", () => {
  const result = record();
  store.close();
  store = new PlanQualityStore(directory);
  const before = inspect();
  expect(record).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_RESPONSE_RECORDING_DISABLED",
    }),
  );
  expect(store.providerReviewResponseLookup(input)).toEqual(result.record);
  expect(inspect()).toEqual(before);
});
it("restored backup preserves raw response and one review recognition", async () => {
  const result = record(),
    budget = store.providerBudgetGet("production"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  await restoreQualityData(backup, restored);
  store.close();
  store = new PlanQualityStore(restored, { providerEnvironment: "synthetic-test" });
  expect(record()).toEqual({ record: result.record, newlyCommitted: false, replayed: true });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerReviewResponseLookup(input)).toEqual(result.record);
}, 150000);
