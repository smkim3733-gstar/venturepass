/** Mock callbacks and isolated SQLite only; no SDK or operational ledger changes. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
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
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow, actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
import {
  backupQualityData,
  restoreQualityData,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import type { ProviderFinalizationIdentity } from "./studio-plan-quality-provider-finalization";
import type { ProviderGenerationStopIdentity } from "./studio-plan-quality-provider-generation-stop";
import type { ProviderReviewStopIdentity } from "./studio-plan-quality-provider-review-stop";
import * as generationPlanner from "./studio-plan-quality-provider-generation-stop";
import * as reviewPlanner from "./studio-plan-quality-provider-review-stop";
import * as engine from "./studio-engine";
const v2 = "plan-observation-v2",
  v1 = "plan-observation-v1";
type Phase = "generation" | "review";
type Kind = "unobserved" | "unknown" | "invalid" | "bound" | "valid";
const phases = ["generation", "review"] as const;
const sentinel = "synthetic customer sentinel";
let seedRoot: string, oldId: string, oldExport: string, oldFinal: ProviderFinalizationIdentity;
const seeds = {} as Record<Phase, Buffer>;
let generation: ProviderGenerationDispatchIdentity, review: ProviderReviewDispatchIdentity;
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
let selectedConfiguration: NonNullable<ReturnType<typeof readFixedProviderConfiguration>>;
const databasePath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
function cleanup(p: string) {
  const rel = relative(resolve(tmpdir()), resolve(p));
  if (!rel.startsWith("venture-version-stop-") || rel.includes("..")) throw Error("Unsafe cleanup");
  rmSync(p, { recursive: true, force: true });
}
function open(version: typeof v1 | typeof v2 | null = v2, synthetic = true) {
  return new PlanQualityStore(directory, {
    ...(synthetic ? { providerEnvironment: "synthetic-test" as const } : {}),
    ...(version
      ? { providerPolicySelection: { version, configuration: selectedConfiguration } }
      : {}),
  });
}
function reopen(version: typeof v1 | typeof v2 | null = v2, synthetic = true) {
  store.close();
  store = open(version, synthetic);
}
function generationCapture(s: PlanQualityStore = store) {
  const raw = generationResponseFixture(generation);
  raw.response.output = [
    {
      type: "message",
      content: [
        { type: "output_text", text: JSON.stringify(actualTestPlan(s.candidateRegistryGet(1), 1)) },
      ],
    },
  ];
  return raw;
}
function reviewCapture() {
  const raw = reviewResponseCapture(review);
  setReviewValidationOutput(raw.response);
  return raw;
}
async function select(phase: Phase) {
  db?.close();
  store?.close();
  writeFileSync(databasePath(directory), seeds[phase]);
  store = open();
  await store.providerLoadValidationPlanning();
  db = new DatabaseSync(databasePath(directory));
  db.function("quality_storage_contract", () => "quality-v9");
}
const snapshot = () => store.providerArchiveGet(generation.runId);
function identity(phase: Phase, kind: Kind = "unobserved") {
  const common = {
    stopRequestId: randomUUID(),
    observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
  if (kind === "unobserved")
    return { ...common, dispatch: phase === "generation" ? generation : review };
  const capture = phase === "generation" ? generationCapture() : reviewCapture();
  if (kind === "unknown") delete capture.response.usage;
  if (kind === "invalid") capture.response.output = [];
  if (kind === "bound")
    capture.response.usage = {
      input_tokens: 20,
      output_tokens: 600000,
      total_tokens: 600020,
      input_tokens_details: { cached_tokens: 5 },
    };
  const response =
    phase === "generation"
      ? store.providerRecordGenerationResponse(capture)
      : store.providerRecordReviewResponse(capture);
  return {
    ...common,
    dispatch: capture.dispatch,
    observation: {
      kind: "response",
      responseRequestId: capture.responseRequestId,
      responseEventDigest: response.record.responseEventDigest,
    },
  };
}
const record = (phase: Phase, id: unknown, s = store) =>
  phase === "generation" ? s.providerRecordGenerationStop(id) : s.providerRecordReviewStop(id);
const lookup = (phase: Phase, id: unknown, s = store) =>
  phase === "generation" ? s.providerGenerationStopLookup(id) : s.providerReviewStopLookup(id);
const prepare = (phase: Phase, id: unknown) =>
  phase === "generation"
    ? store.providerPrepareGenerationStop(id)
    : store.providerPrepareReviewStop(id);
const disabled = (code: string) =>
  expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_" + code });
function failInsert(point: number) {
  const original = DatabaseSync.prototype.prepare;
  let inserts = 0;
  return vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const stmt = original.call(this, sql);
    if (/^INSERT INTO quality_actual_(budget_events|events|requests)\(/.test(sql)) {
      const run = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation((...args) => {
        const v = run(...args);
        if (++inserts === point) throw Error("synthetic insert interruption");
        return v;
      });
    }
    return stmt;
  });
}
function atCommit(callback: () => void, before: boolean) {
  const original = DatabaseSync.prototype.exec;
  return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql === "COMMIT" && before) callback();
    const result = original.call(this, sql);
    if (sql === "COMMIT" && !before) callback();
    return result;
  });
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-stop-seed-"));
  let s = new PlanQualityStore(seedRoot, { providerEnvironment: "synthetic-test" });
  try {
    s.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: s.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const legacy = await finalizationStoreFixture(s);
    s.providerRecordFinalization(legacy.identity);
    oldFinal = legacy.identity;
    oldId = oldFinal.validation.dispatch.generation.dispatch.runId;
    oldExport = s.providerDownload(oldId, 10).body;
    s.close();
    s = new PlanQualityStore(seedRoot, {
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    });
    vi.setSystemTime("2026-09-27T03:32:00.000Z");
    const registry = s.candidateRegistryGet(1),
      candidateId = registry.entries[1].candidateId;
    const { result, expectedPolicyHead } = s.providerPolicyReview(1, candidateId);
    if (result.status !== "review") throw Error(result.reason);
    s.providerPolicyAdopt(
      providerPolicyAdoptionCommandSchema.parse({
        commandVersion: 1,
        kind: "adopt-provider-policy",
        clientRequestId: randomUUID(),
        version: 1,
        versionDigest: registry.versionDigest,
        candidateId,
        expectedPolicyHead,
        approvedReviewDigest: result.review.reviewDigest,
        budgetAction: "keep-existing-budget",
        initialBudgetRequestId: null,
        approval: {
          noticeVersion: 1,
          acknowledgedPolicy: true,
          acknowledgedBudgetAction: true,
          reservationAndTransmission: "separate-approval-required",
          approvedAt: new Date().toISOString(),
        },
      }),
      result.review,
    );
    const r = reservationStoreFixture(s, 1),
      reserved = s.providerReserve(r.command, r.review);
    vi.setSystemTime("2026-09-27T03:33:00.000Z");
    const a = transmissionStoreFixture(s, reserved.record),
      approved = s.providerApproveTransmission(a.command, a.review).record;
    generation = {
      runId: approved.runId,
      runDigest: approved.runDigest,
      approvalBindingDigest: approved.recordDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    };
    s.close();
    const options: NonNullable<ConstructorParameters<typeof PlanQualityStore>[1]> = {
      providerEnvironment: "synthetic-test" as const,
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    };
    s = new PlanQualityStore(seedRoot, options);
    vi.setSystemTime("2026-09-27T03:34:00.000Z");
    await s.providerSimulateGenerationDispatch(generation, {
      provenance: "synthetic-test",
      send: async () => undefined,
    });
    s.close();
    seeds.generation = readFileSync(databasePath(seedRoot));
    s = new PlanQualityStore(seedRoot, options);
    await s.providerLoadValidationPlanning();
    const capture = generationCapture(s),
      response = s.providerRecordGenerationResponse(capture).record;
    const validation = {
      dispatch: generation,
      responseRequestId: capture.responseRequestId,
      responseEventDigest: response.responseEventDigest,
      validationRequestId: randomUUID(),
    };
    const validated = s.providerRecordGenerationValidation(validation).record;
    review = {
      generation: validation,
      validationEventDigest: validated.validationEventDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    };
    await s.providerSimulateReviewDispatch(review, {
      provenance: "synthetic-test",
      send: async () => undefined,
    });
  } finally {
    s.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  seeds.review = readFileSync(databasePath(seedRoot));
}, 40000);
afterAll(() => {
  if (seedRoot) cleanup(seedRoot);
});
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-version-stop-test-"));
  directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  selectedConfiguration = readFixedProviderConfiguration()!;
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  store?.close();
  // Closed handles must never be reused across a different test's seed installation.
  db = undefined as unknown as DatabaseSync;
  store = undefined as unknown as PlanQualityStore;
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (root) cleanup(root);
});
it.each(
  phases.flatMap((p) =>
    (["unobserved", "unknown", "invalid", "bound", "valid"] as const).map((k) => [p, k] as const),
  ),
)(
  "%s persists only eligible %s stops and preserves original costs/approval",
  async (phase, kind) => {
    await select(phase);
    const id = identity(phase, kind),
      before = inspectQualityDatabase(db),
      budget = store.providerBudgetGet("production"),
      approval = store.providerDownload(generation.runId, 1).body;
    const p = prepare(phase, id);
    expect(inspectQualityDatabase(db)).toEqual(before);
    if (kind === "valid") {
      expect(p).toMatchObject({ status: "refused", reason: phase + "-valid" });
      expect(() => record(phase, id)).toThrow();
      expect(inspectQualityDatabase(db)).toEqual(before);
      return;
    }
    expect(p).toMatchObject({
      status: "prepared",
      plan: { planVersion: 2, dispatchAllowed: false },
    });
    const saved = record(phase, id);
    expect(saved).toMatchObject({
      newlyCommitted: true,
      replayed: false,
      record: { stopPersisted: true, dispatchAllowed: false, automaticRetryAllowed: false },
    });
    expect(snapshot()).toMatchObject({
      archiveFormatVersion: 5,
      terminal: true,
      canResume: false,
      dispatchAllowed: false,
    });
    expect(snapshot().events.at(-1)).toMatchObject({ executionContractVersion: 2 });
    const next = store.providerBudgetGet("production");
    expect(next.recognizedUnits).toBe(budget.recognizedUnits);
    if (phase === "review") expect(next).toEqual(budget);
    else expect(BigInt(next.heldUnits)).toBeLessThan(BigInt(budget.heldUnits));
    expect(store.providerDownload(generation.runId, 1).body).toBe(approval);
    expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(lookup(phase, id)).toEqual(saved.record);
    const committed = inspectQualityDatabase(db);
    expect(record(phase, id)).toEqual({ ...saved, newlyCommitted: false, replayed: true });
    expect(inspectQualityDatabase(db)).toEqual(committed);
  },
  15000,
);
it.each([
  ["generation", 1],
  ["generation", 2],
  ["generation", 3],
  ["review", 1],
  ["review", 2],
] as const)("%s rolls back every row when insert %s fails", async (phase, point) => {
  await select(phase);
  const id = identity(phase),
    before = inspectQualityDatabase(db),
    spy = failInsert(point);
  expect(() => record(phase, id)).toThrow("synthetic insert interruption");
  spy.mockRestore();
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(lookup(phase, id)).toEqual({ state: "not-observed" });
  expect(record(phase, id).newlyCommitted).toBe(true);
});
it.each(phases.flatMap((p) => (["before", "after"] as const).map((t) => [p, t] as const)))(
  "%s recovers original request after error %s COMMIT",
  async (phase, where) => {
    await select(phase);
    const id = identity(phase),
      before = inspectQualityDatabase(db);
    const spy = atCommit(() => {
      throw Error("commit interrupted");
    }, where === "before");
    expect(() => record(phase, id)).toThrow(
      where === "before" ? "commit interrupted" : "cannot rollback - no transaction is active",
    );
    spy.mockRestore();
    if (where === "before") {
      expect(inspectQualityDatabase(db)).toEqual(before);
      expect(record(phase, id).newlyCommitted).toBe(true);
    } else {
      const saved = lookup(phase, id),
        audit = inspectQualityDatabase(db);
      reopen(v1);
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
      vi.spyOn(generationPlanner, "prepareVersionedProviderGenerationStop").mockImplementation(
        forbidden,
      );
      vi.spyOn(reviewPlanner, "prepareVersionedProviderReviewStop").mockImplementation(forbidden);
      expect(record(phase, id)).toMatchObject({
        record: saved,
        newlyCommitted: false,
        replayed: true,
      });
      expect(inspectQualityDatabase(db)).toEqual(audit);
    }
  },
);
it.each(phases.flatMap((p) => (["DELETE", "WAL"] as const).map((m) => [p, m] as const)))(
  "%s retains %s writer lock and refuses another stop identity",
  async (phase, mode) => {
    await select(phase);
    db.exec("PRAGMA journal_mode=" + mode);
    db.exec("PRAGMA busy_timeout=0");
    const second = open();
    await second.providerLoadValidationPlanning();
    const id = identity(phase),
      called = vi.fn();
    const originalGeneration = generationPlanner.prepareVersionedProviderGenerationStop;
    const originalReview = reviewPlanner.prepareVersionedProviderReviewStop;
    const checkLock = () => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      called();
    };
    const spy =
      phase === "generation"
        ? vi
            .spyOn(generationPlanner, "prepareVersionedProviderGenerationStop")
            .mockImplementation((...args) => {
              checkLock();
              return originalGeneration(...args);
            })
        : vi
            .spyOn(reviewPlanner, "prepareVersionedProviderReviewStop")
            .mockImplementation((...args) => {
              checkLock();
              return originalReview(...args);
            });
    try {
      // The loader captures the planner reference; instrument before loading that store.
      reopen();
      await store.providerLoadValidationPlanning();
      const saved = record(phase, id);
      expect(called).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect(record(phase, id, second)).toMatchObject({ record: saved.record, replayed: true });
      const before = inspectQualityDatabase(db);
      expect(() => record(phase, { ...id, stopRequestId: randomUUID() }, second)).toThrow();
      expect(inspectQualityDatabase(db)).toEqual(before);
    } finally {
      spy.mockRestore();
      second.close();
    }
  },
  15000,
);
it.each(phases)(
  "%s requires preloading for new writes but never for original nonce recovery",
  async (phase) => {
    await select(phase);
    const id = identity(phase),
      before = inspectQualityDatabase(db);
    reopen();
    expect(() => record(phase, id)).toThrow(disabled("VALIDATION_PLANNING_NOT_LOADED"));
    expect(inspectQualityDatabase(db)).toEqual(before);
    await store.providerLoadValidationPlanning();
    const saved = record(phase, id),
      committed = inspectQualityDatabase(db);
    for (const version of [v2, v1, null] as const) {
      reopen(version);
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      expect(record(phase, id)).toMatchObject({ record: saved.record, replayed: true });
      expect(inspectQualityDatabase(db)).toEqual(committed);
    }
  },
  15000,
);
it.each(phases)(
  "%s rejects wrong selection, caller authority and non-synthetic writes",
  async (phase) => {
    await select(phase);
    const id = identity(phase),
      before = inspectQualityDatabase(db);
    reopen(v1);
    await store.providerLoadValidationPlanning();
    expect(() => record(phase, id)).toThrow(
      disabled((phase === "generation" ? "STOP" : "REVIEW_STOP") + "_SERVER_VERSION_MISMATCH"),
    );
    reopen(v2, false);
    await store.providerLoadValidationPlanning();
    expect(() => record(phase, id)).toThrow(
      disabled(
        phase === "generation" ? "STOP_RECORDING_DISABLED" : "REVIEW_STOP_RECORDING_DISABLED",
      ),
    );
    expect(() => store.providerGet(generation.runId)).toThrow(
      expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
    );
    reopen();
    await store.providerLoadValidationPlanning();
    for (const key of ["version", "configuration", "tokenEvidence", "outcome", "dispatchAllowed"])
      expect(() => record(phase, { ...id, [key]: true })).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it.each(phases)(
  "%s preserves stop evidence while settling one late response under changed selection",
  async (phase) => {
    await select(phase);
    const id = identity(phase),
      saved = record(phase, id).record;
    const before = store.providerBudgetGet("production");
    expect(BigInt(before.heldUnits)).toBeGreaterThan(BigInt(0));
    const capture = phase === "generation" ? generationCapture() : reviewCapture();
    reopen(v1);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const result =
      phase === "generation"
        ? store.providerRecordGenerationResponse(capture)
        : store.providerRecordReviewResponse(capture);
    expect(result.newlyCommitted).toBe(true);
    expect(snapshot()).toMatchObject({
      state: "result-unobserved",
      terminal: true,
      canResume: false,
      dispatchAllowed: false,
    });
    const budget = store.providerBudgetGet("production");
    expect(budget.heldUnits).toBe("0");
    expect(BigInt(budget.recognizedUnits)).toBeGreaterThan(BigInt(before.recognizedUnits));
    expect(lookup(phase, id)).toEqual(saved);
    expect(record(phase, id)).toMatchObject({ record: saved, replayed: true });
    const after = inspectQualityDatabase(db);
    const replay =
      phase === "generation"
        ? store.providerRecordGenerationResponse(capture)
        : store.providerRecordReviewResponse(capture);
    expect(replay).toMatchObject({ record: result.record, replayed: true });
    const changed = { ...capture, responseRequestId: randomUUID() };
    expect(() =>
      phase === "generation"
        ? store.providerRecordGenerationResponse(changed)
        : store.providerRecordReviewResponse(changed),
    ).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(after);
  },
  15000,
);
it.each(phases)("%s keeps unresolved hold on a late response with unknown usage", async (phase) => {
  await select(phase);
  const id = identity(phase);
  record(phase, id);
  const budget = store.providerBudgetGet("production"),
    capture = phase === "generation" ? generationCapture() : reviewCapture();
  delete capture.response.usage;
  if (phase === "generation") store.providerRecordGenerationResponse(capture);
  else store.providerRecordReviewResponse(capture);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(snapshot()).toMatchObject({ state: "result-unobserved", terminal: true });
});
it.each(phases)(
  "%s rejects changed source/observation and audits another run before replay",
  async (phase) => {
    await select(phase);
    const id = identity(phase),
      saved = record(phase, id).record,
      before = inspectQualityDatabase(db);
    const changed = structuredClone(id) as
      ProviderGenerationStopIdentity | ProviderReviewStopIdentity;
    changed.dispatch.preparedRequestId = randomUUID();
    expect(() => lookup(phase, changed)).toThrow();
    expect(() => record(phase, changed)).toThrow();
    expect(() =>
      record(phase, {
        ...id,
        observation: {
          kind: "response",
          responseRequestId: randomUUID(),
          responseEventDigest: "0".repeat(64),
        },
      }),
    ).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(lookup(phase, id)).toEqual(saved);
    const triggers = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='quality_actual_requests'",
      )
      .all();
    for (const t of triggers) db.exec('DROP TRIGGER "' + t.name + '"');
    db.prepare("UPDATE quality_actual_requests SET body_hash=? WHERE nonce=?").run(
      "0".repeat(64),
      oldFinal.finalizationRequestId,
    );
    for (const t of triggers) db.exec(String(t.sql));
    expect(() => lookup(phase, id)).toThrow();
    expect(() => record(phase, id)).toThrow();
  },
);
it.each(phases)(
  "%s preserves mixed stopped history, cost, raw bytes and nonces through backup",
  async (phase) => {
    await select(phase);
    const id = identity(phase),
      saved = record(phase, id).record;
    const exported = store.providerDownload(generation.runId, snapshot().revision).body,
      budget = store.providerBudgetGet("production");
    const raw = store.providerArtifact(generation.runId, phase + "-request").body;
    const backup = join(root, "backup"),
      target = join(root, "restored");
    mkdirSync(target);
    await backupQualityData(directory, backup);
    restoreQualityData(backup, target);
    const restored = new PlanQualityStore(target, { providerEnvironment: "synthetic-test" });
    try {
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
      vi.spyOn(generationPlanner, "prepareProviderGenerationStop").mockImplementation(forbidden);
      vi.spyOn(reviewPlanner, "prepareProviderReviewStop").mockImplementation(forbidden);
      vi.spyOn(generationPlanner, "prepareVersionedProviderGenerationStop").mockImplementation(
        forbidden,
      );
      vi.spyOn(reviewPlanner, "prepareVersionedProviderReviewStop").mockImplementation(forbidden);
      vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden);
      vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(forbidden);
      expect(restored.providerDownload(generation.runId, snapshot().revision).body).toBe(exported);
      expect(restored.providerDownload(oldId, 10).body).toBe(oldExport);
      expect(restored.providerArtifact(generation.runId, phase + "-request").body).toEqual(raw);
      expect(restored.providerBudgetGet("production")).toEqual(budget);
      expect(record(phase, id, restored)).toMatchObject({ record: saved, replayed: true });
      expect(restored.providerRecordFinalization(oldFinal)).toMatchObject({ replayed: true });
    } finally {
      restored.close();
    }
  },
  30000,
);
