/** Isolated mock callbacks and SQLite writes; never an operational provider invocation. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
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
import type { ProviderGenerationDispatchIdentity } from "./studio-plan-quality-provider-dispatch-plan";
import type { ProviderObservationPrepared } from "./studio-provider-observation";
import {
  backupQualityData,
  restoreQualityData,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";

const v2 = "plan-observation-v2",
  sentinel = "synthetic customer sentinel";
let seedRoot: string, seedBytes: Buffer, oldId: string, oldExport: string;
let seededValidation: ProviderGenerationValidationIdentity,
  validationIdentity: ProviderGenerationValidationIdentity;
let oldValidation: ProviderGenerationValidationIdentity, oldReview: ProviderReviewDispatchIdentity;
import type { ProviderGenerationValidationIdentity } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import * as engine from "./studio-engine";
import * as reviewPlanner from "./studio-plan-quality-provider-review-dispatch-plan";
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
let identity: ProviderGenerationDispatchIdentity,
  seededIdentity: ProviderGenerationDispatchIdentity;
let selectedConfiguration: NonNullable<ReturnType<typeof readFixedProviderConfiguration>>;
const databasePath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
const send = vi.fn<(request: ProviderObservationPrepared) => Promise<void>>(async () => undefined);
function cleanup(path: string) {
  const rel = relative(resolve(tmpdir()), resolve(path));
  if (!rel.startsWith("venture-version-validation-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
}
function open(
  version: "plan-observation-v1" | typeof v2 | null = v2,
  sdk = false,
  synthetic = true,
) {
  return new PlanQualityStore(directory, {
    ...(synthetic ? { providerEnvironment: "synthetic-test" as const } : {}),
    ...(version
      ? { providerPolicySelection: { version, configuration: selectedConfiguration } }
      : {}),
    ...(sdk
      ? { providerSdkTestNetwork: { provenance: "synthetic-test" as const, fetch: forbidden } }
      : {}),
  });
}
const execute = (r: ProviderReviewDispatchIdentity, s = store) =>
  s.providerSimulateReviewDispatch(r, { provenance: "synthetic-test", send });
function reviewIdentity(s = store): ProviderReviewDispatchIdentity {
  const validation = s.providerRecordGenerationValidation(validationIdentity).record;
  return {
    generation: validationIdentity,
    validationEventDigest: validation.validationEventDigest,
    preparedRequestId: randomUUID(),
    dispatchRequestId: randomUUID(),
  };
}
const snapshot = () => store.providerArchiveGet(identity.runId);
function reopen(
  version: "plan-observation-v1" | typeof v2 | null = v2,
  sdk = false,
  synthetic = true,
) {
  store.close();
  store = open(version, sdk, synthetic);
}
function failInsert(point: number) {
  const prepare = DatabaseSync.prototype.prepare;
  let inserts = 0;
  return vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const stmt = prepare.call(this, sql);
    if (/^INSERT INTO quality_actual_(artifacts|events|requests)\(/.test(sql)) {
      const run = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation((...args) => {
        const value = run(...args);
        if (++inserts === point) throw Error("synthetic insert interruption");
        return value;
      });
    }
    return stmt;
  });
}
function atCommit(number: number, callback: () => void, before = false) {
  const exec = DatabaseSync.prototype.exec;
  let commits = 0;
  return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const target = sql === "COMMIT" && ++commits === number;
    if (target && before) callback();
    const result = exec.call(this, sql);
    if (target && !before) callback();
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
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-validation-seed-"));
  let seeded = new PlanQualityStore(seedRoot, { providerEnvironment: "synthetic-test" });
  try {
    seeded.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: seeded.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const legacy = await finalizationStoreFixture(seeded);
    seeded.providerRecordFinalization(legacy.identity);
    oldId = legacy.identity.validation.dispatch.generation.dispatch.runId;
    oldReview = legacy.identity.validation.dispatch;
    oldValidation = oldReview.generation;
    oldExport = seeded.providerDownload(oldId, 10).body;
    seeded.close();
    seeded = new PlanQualityStore(seedRoot, {
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    });
    vi.setSystemTime("2026-09-27T03:32:00.000Z");
    const registry = seeded.candidateRegistryGet(1),
      candidateId = registry.entries[1].candidateId;
    const { result, expectedPolicyHead } = seeded.providerPolicyReview(1, candidateId);
    if (result.status !== "review") throw Error(result.reason);
    seeded.providerPolicyAdopt(
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
    const r = reservationStoreFixture(seeded, 1),
      reserved = seeded.providerReserve(r.command, r.review);
    vi.setSystemTime("2026-09-27T03:33:00.000Z");
    const a = transmissionStoreFixture(seeded, reserved.record),
      approved = seeded.providerApproveTransmission(a.command, a.review).record;
    seededIdentity = {
      runId: approved.runId,
      runDigest: approved.runDigest,
      approvalBindingDigest: approved.recordDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    };
    seeded.close();
    seeded = new PlanQualityStore(seedRoot, {
      providerEnvironment: "synthetic-test",
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    });
    vi.setSystemTime("2026-09-27T03:34:00.000Z");
    await seeded.providerSimulateGenerationDispatch(seededIdentity, {
      provenance: "synthetic-test",
      send: async () => undefined,
    });
    const capture = generationResponseFixture(seededIdentity);
    capture.response.output = [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(actualTestPlan(seeded.candidateRegistryGet(1), 1)),
          },
        ],
      },
    ];
    const response = seeded.providerRecordGenerationResponse(capture).record;
    seededValidation = {
      dispatch: seededIdentity,
      responseRequestId: capture.responseRequestId,
      responseEventDigest: response.responseEventDigest,
      validationRequestId: randomUUID(),
    };
  } finally {
    seeded.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
  seedBytes = readFileSync(databasePath(seedRoot));
}, 40000);
afterAll(() => {
  if (seedRoot) cleanup(seedRoot);
});
beforeEach(async () => {
  forbidden.mockClear();
  send.mockReset();
  send.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-version-validation-test-"));
  directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  writeFileSync(databasePath(directory), seedBytes);
  identity = structuredClone(seededIdentity);
  validationIdentity = structuredClone(seededValidation);
  selectedConfiguration = readFixedProviderConfiguration()!;
  store = open();
  await store.providerLoadValidationPlanning();
  db = new DatabaseSync(databasePath(directory));
  db.function("quality_storage_contract", () => "quality-v9");
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  store?.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (root) cleanup(root);
});

it("writes r5 then exact r6/r7 with original generation evidence under the same cumulative budget", async () => {
  const beforeBudget = store.providerBudgetGet("production"),
    approval = store.providerDownload(identity.runId, 1).body;
  const plan = store.providerPrepareGenerationValidation(validationIdentity);
  expect(plan.plan?.planVersion).toBe(2);
  const saved = store.providerRecordGenerationValidation(validationIdentity);
  expect(saved).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      revision: 5,
      validationPersisted: true,
      reviewPrepared: false,
      dispatchAllowed: false,
    },
  });
  expect(snapshot()).toMatchObject({
    archiveFormatVersion: 5,
    revision: 5,
    dispatchAllowed: false,
    canResume: false,
  });
  const r = reviewIdentity(),
    planned = store.providerPrepareReviewDispatch(r);
  expect(planned.status).toBe("prepared");
  if (planned.status !== "prepared") throw Error(planned.reason);
  send.mockImplementation(async (request) => {
    // Independent connection observes the committed r7 while initiation holds the writer slot.
    expect(
      db
        .prepare("SELECT MAX(revision) AS revision FROM quality_actual_events WHERE run_id=?")
        .get(identity.runId)!.revision,
    ).toBe(7);
    expect(request.rawBody).toBe(planned.plan.request.rawBody);
    expect(Object.isFrozen(request.body)).toBe(true);
  });
  expect(await execute(r)).toMatchObject({
    newlyCommitted: true,
    delivery: "mock-send-returned",
    responsePersisted: false,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    snapshot()
      .events.slice(4)
      .map((e) => ("executionContractVersion" in e ? e.executionContractVersion : undefined)),
  ).toEqual([2, 2, 2]);
  expect(store.providerBudgetGet("production")).toEqual(beforeBudget);
  expect(store.providerDownload(identity.runId, 1).body).toBe(approval);
  expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
  expect(store.providerGenerationValidationLookup(oldValidation)).toMatchObject({
    validationPersisted: true,
  });
  expect(store.providerReviewDispatchLookup(oldReview)).toMatchObject({ reviewPersisted: true });
}, 15000);
it("requires module preload before a new selected write and loads without SQL", async () => {
  reopen();
  const before = inspectQualityDatabase(db);
  expect(() => store.providerRecordGenerationValidation(validationIdentity)).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_VALIDATION_PLANNING_NOT_LOADED" }),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  const sql = vi.spyOn(DatabaseSync.prototype, "exec");
  sql.mockClear();
  await Promise.all([
    store.providerLoadValidationPlanning(),
    store.providerLoadValidationPlanning(),
  ]);
  expect(sql).not.toHaveBeenCalled();
  sql.mockRestore();
  expect(store.providerRecordGenerationValidation(validationIdentity).newlyCommitted).toBe(true);
});
it.each([1, 2, 3])("rolls back all r5 rows when insert %s fails", (point) => {
  const before = inspectQualityDatabase(db),
    spy = failInsert(point);
  expect(() => store.providerRecordGenerationValidation(validationIdentity)).toThrow(
    "synthetic insert interruption",
  );
  spy.mockRestore();
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(snapshot().revision).toBe(4);
  expect(store.providerGenerationValidationLookup(validationIdentity)).toEqual({
    state: "not-observed",
  });
  expect(store.providerRecordGenerationValidation(validationIdentity).newlyCommitted).toBe(true);
});
it.each([1, 2, 3, 4, 5])("rolls back all five r6/r7 rows when insert %s fails", async (point) => {
  const r = reviewIdentity(),
    before = inspectQualityDatabase(db),
    spy = failInsert(point);
  await expect(execute(r)).rejects.toThrow("synthetic insert interruption");
  spy.mockRestore();
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(snapshot().revision).toBe(5);
  expect(store.providerReviewDispatchLookup(r)).toEqual({ state: "not-observed" });
  expect(send).not.toHaveBeenCalled();
  expect(await execute(r)).toMatchObject({ newlyCommitted: true, delivery: "mock-send-returned" });
});
it.each(["before", "after"])(
  "recovers original r5 nonce when COMMIT throws %s SQLite commit",
  (where) => {
    const before = inspectQualityDatabase(db),
      spy = atCommit(
        1,
        () => {
          throw Error("commit interrupted");
        },
        where === "before",
      );
    expect(() => store.providerRecordGenerationValidation(validationIdentity)).toThrow(
      where === "before" ? "commit interrupted" : "cannot rollback - no transaction is active",
    );
    spy.mockRestore();
    if (where === "before") {
      expect(inspectQualityDatabase(db)).toEqual(before);
      expect(store.providerRecordGenerationValidation(validationIdentity).newlyCommitted).toBe(
        true,
      );
    } else {
      const preserved = inspectQualityDatabase(db);
      reopen(null);
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden);
      expect(store.providerRecordGenerationValidation(validationIdentity)).toMatchObject({
        replayed: true,
        newlyCommitted: false,
      });
      expect(inspectQualityDatabase(db)).toEqual(preserved);
    }
  },
);
it.each(["before", "after"])(
  "never reconstructs send ownership after COMMIT throws %s review commit",
  async (where) => {
    const r = reviewIdentity(),
      before = inspectQualityDatabase(db),
      spy = atCommit(
        1,
        () => {
          throw Error("commit interrupted");
        },
        where === "before",
      );
    await expect(execute(r)).rejects.toThrow(
      where === "before" ? "commit interrupted" : "cannot rollback - no transaction is active",
    );
    spy.mockRestore();
    expect(send).not.toHaveBeenCalled();
    if (where === "before") {
      expect(inspectQualityDatabase(db)).toEqual(before);
      expect(await execute(r)).toMatchObject({ newlyCommitted: true });
      expect(send).toHaveBeenCalledTimes(1);
    } else {
      const preserved = inspectQualityDatabase(db);
      reopen(null);
      vi.setSystemTime("2035-01-01T00:00:00.000Z");
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
      vi.spyOn(reviewPlanner, "prepareVersionedProviderReviewDispatch").mockImplementation(
        forbidden,
      );
      expect(await execute(r)).toMatchObject({ replayed: true, delivery: "already-recorded" });
      expect(inspectQualityDatabase(db)).toEqual(preserved);
      expect(send).not.toHaveBeenCalled();
    }
  },
);
it.each(["DELETE", "WAL"])(
  "keeps the %s writer slot through r5 validation and review callback initiation",
  async (mode) => {
    db.exec("PRAGMA journal_mode=" + mode);
    const second = open();
    await second.providerLoadValidationPlanning();
    const executeOriginal = engine.validateObservedPlanDraft,
      checked = vi.fn();
    const spy = vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation((company, raw) => {
      db.exec("PRAGMA busy_timeout=0");
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      checked();
      return executeOriginal(company, raw);
    });
    const r = reviewIdentity();
    spy.mockRestore();
    expect(checked).toHaveBeenCalledTimes(1);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let attempts = 0;
    const inserted = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const stmt = originalPrepare.call(this, sql);
      if (/^INSERT INTO quality_actual_events/.test(sql)) {
        const run = stmt.run.bind(stmt);
        vi.spyOn(stmt, "run").mockImplementation((...args) => {
          expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
          attempts++;
          return run(...args);
        });
      }
      return stmt;
    });
    send.mockImplementation(async () => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    });
    try {
      expect(await execute(r)).toMatchObject({ delivery: "mock-send-returned" });
      inserted.mockRestore();
      expect(attempts).toBe(2);
      expect(await execute(r, second)).toMatchObject({
        replayed: true,
        delivery: "already-recorded",
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      inserted.mockRestore();
      second.close();
    }
  },
);
it("recovers both original nonces after expiry and a different server selection without replanning", async () => {
  const r = reviewIdentity(),
    validation = store.providerGenerationValidationLookup(validationIdentity);
  await execute(r);
  const review = store.providerReviewDispatchLookup(r),
    before = inspectQualityDatabase(db);
  reopen("plan-observation-v1");
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
  vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden);
  expect(store.providerRecordGenerationValidation(validationIdentity)).toMatchObject({
    record: validation,
    replayed: true,
  });
  expect(await execute(r)).toMatchObject({
    record: review,
    replayed: true,
    delivery: "already-recorded",
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["responseEventDigest", "validationRequestId"])(
  "rejects substituted original generation identity %s",
  (key) => {
    store.providerRecordGenerationValidation(validationIdentity);
    const before = inspectQualityDatabase(db);
    const changed = {
      ...validationIdentity,
      [key]: key.endsWith("Id") ? randomUUID() : "0".repeat(64),
    };
    expect(() => store.providerRecordGenerationValidation(changed)).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it.each(["validationEventDigest", "preparedRequestId", "dispatchRequestId"])(
  "rejects substituted original review identity %s",
  async (key) => {
    const r = reviewIdentity();
    await execute(r);
    const before = inspectQualityDatabase(db);
    await expect(
      execute({ ...r, [key]: key.endsWith("Id") ? randomUUID() : "0".repeat(64) }),
    ).rejects.toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it("rejects wrong selection before a new r5 or r7 write", async () => {
  const before = inspectQualityDatabase(db);
  reopen("plan-observation-v1");
  await store.providerLoadValidationPlanning();
  expect(() => store.providerRecordGenerationValidation(validationIdentity)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_VALIDATION_SERVER_VERSION_MISMATCH",
    }),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  reopen();
  await store.providerLoadValidationPlanning();
  const r = reviewIdentity(),
    validated = inspectQualityDatabase(db);
  reopen("plan-observation-v1");
  await store.providerLoadValidationPlanning();
  await expect(execute(r)).rejects.toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_SERVER_VERSION_MISMATCH" }),
  );
  expect(inspectQualityDatabase(db)).toEqual(validated);
  expect(send).not.toHaveBeenCalled();
});
it("rechecks original approval expiry at the final initiation lock", async () => {
  const r = reviewIdentity(),
    spy = atCommit(1, () => vi.setSystemTime("2026-09-28T03:34:00.000Z"));
  expect(await execute(r)).toMatchObject({ newlyCommitted: true, delivery: "not-sent" });
  spy.mockRestore();
  expect(snapshot().revision).toBe(7);
  expect(send).not.toHaveBeenCalled();
  expect(await execute(r)).toMatchObject({ replayed: true, delivery: "already-recorded" });
});
it("does not promote v2 review plans into SDK or default production writes", async () => {
  const r = reviewIdentity(),
    before = inspectQualityDatabase(db);
  reopen(v2, true);
  await store.providerLoadValidationPlanning();
  await expect(store.providerSimulateReviewSdkDispatch(r)).rejects.toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_NATIVE_VERSION_UNSUPPORTED",
    }),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  reopen(v2, false, false);
  await store.providerLoadValidationPlanning();
  expect(() => store.providerRecordGenerationValidation(validationIdentity)).toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_VALIDATION_RECORDING_DISABLED" }),
  );
  await expect(execute(r)).rejects.toThrow(
    expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_REVIEW_SIMULATION_DISABLED" }),
  );
  expect(() => store.providerGet(identity.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it.each(["version", "contract", "tokenEvidence"])(
  "rejects caller authority %s on validation and review commands",
  async (key) => {
    const before = inspectQualityDatabase(db);
    expect(() =>
      store.providerRecordGenerationValidation({ ...validationIdentity, [key]: v2 }),
    ).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
    const r = reviewIdentity(),
      validated = inspectQualityDatabase(db);
    await expect(execute({ ...r, [key]: v2 })).rejects.toThrow();
    expect(inspectQualityDatabase(db)).toEqual(validated);
    expect(send).not.toHaveBeenCalled();
  },
);
it("audits unrelated corrupt evidence before recovering original r5 and r7 nonces", async () => {
  const r = reviewIdentity();
  await execute(r);
  const triggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='quality_actual_requests'",
    )
    .all();
  for (const t of triggers) db.exec('DROP TRIGGER "' + t.name + '"');
  db.prepare("UPDATE quality_actual_requests SET body_hash=? WHERE nonce=?").run(
    "0".repeat(64),
    oldValidation.validationRequestId,
  );
  for (const t of triggers) db.exec(String(t.sql));
  expect(() => store.providerGenerationValidationLookup(validationIdentity)).toThrow();
  expect(() => store.providerRecordGenerationValidation(validationIdentity)).toThrow();
  expect(() => store.providerReviewDispatchLookup(r)).toThrow();
  await expect(execute(r)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});
it("backs up mixed v1 completion and writer-produced v2 r7 preserving raw bytes, budget and original recovery", async () => {
  const r = reviewIdentity(),
    validation = store.providerGenerationValidationLookup(validationIdentity);
  await execute(r);
  const review = store.providerReviewDispatchLookup(r),
    exported = store.providerDownload(identity.runId, 7).body,
    budget = store.providerBudgetGet("production");
  const backup = join(root, "backup"),
    target = join(root, "restored");
  mkdirSync(target);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, target);
  const restored = new PlanQualityStore(target, { providerEnvironment: "synthetic-test" });
  try {
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden);
    expect(restored.providerDownload(identity.runId, 7).body).toBe(exported);
    expect(restored.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(restored.providerBudgetGet("production")).toEqual(budget);
    expect(restored.providerGenerationValidationLookup(validationIdentity)).toEqual(validation);
    expect(restored.providerRecordGenerationValidation(validationIdentity)).toMatchObject({
      record: validation,
      replayed: true,
    });
    expect(restored.providerReviewDispatchLookup(r)).toEqual(review);
    expect(await execute(r, restored)).toMatchObject({
      record: review,
      replayed: true,
      delivery: "already-recorded",
    });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    restored.close();
  }
}, 30000);
