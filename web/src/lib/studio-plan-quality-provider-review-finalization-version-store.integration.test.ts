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
import {
  backupQualityData,
  restoreQualityData,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";

const v2 = "plan-observation-v2",
  sentinel = "synthetic customer sentinel";
let seedRoot: string, seedBytes: Buffer, oldId: string, oldExport: string;

let seededValidation: ProviderGenerationValidationIdentity;
let oldValidation: ProviderGenerationValidationIdentity, oldReview: ProviderReviewDispatchIdentity;
import type { ProviderGenerationValidationIdentity } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import * as engine from "./studio-engine";
import * as validationPlanner from "./studio-plan-quality-provider-review-validation";
import * as finalPlanner from "./studio-plan-quality-provider-finalization";
import { setReviewValidationOutput } from "./studio-plan-quality-provider-review-validation-test-helpers";
let seededReviewValidation: validationPlanner.ProviderReviewValidationIdentity;
let validationIdentity: validationPlanner.ProviderReviewValidationIdentity;
let oldFinalIdentity: finalPlanner.ProviderFinalizationIdentity;
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
let identity: ProviderGenerationDispatchIdentity,
  seededIdentity: ProviderGenerationDispatchIdentity;
let selectedConfiguration: NonNullable<ReturnType<typeof readFixedProviderConfiguration>>;
const databasePath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
function cleanup(path: string) {
  const rel = relative(resolve(tmpdir()), resolve(path));
  if (!rel.startsWith("venture-version-review-final-") || rel.includes(".."))
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
    if (/^INSERT INTO quality_actual_(artifacts|budget_events|events|requests)\(/.test(sql)) {
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
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-review-final-seed-"));
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
    oldFinalIdentity = legacy.identity;
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
    await seeded.providerLoadValidationPlanning();
    const validated = seeded.providerRecordGenerationValidation(seededValidation).record;
    const review: ProviderReviewDispatchIdentity = {
      generation: seededValidation,
      validationEventDigest: validated.validationEventDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    };
    await seeded.providerSimulateReviewDispatch(review, {
      provenance: "synthetic-test",
      send: async () => undefined,
    });
    const reviewed = reviewResponseCapture(review);
    setReviewValidationOutput(reviewed.response);
    const saved = seeded.providerRecordReviewResponse(reviewed).record;
    seededReviewValidation = {
      dispatch: review,
      responseRequestId: reviewed.responseRequestId,
      responseEventDigest: saved.responseEventDigest,
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
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-09-27T03:34:00.000Z");
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-version-review-final-test-"));
  directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  writeFileSync(databasePath(directory), seedBytes);
  identity = structuredClone(seededIdentity);
  validationIdentity = structuredClone(seededReviewValidation);
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

function finalIdentity(): finalPlanner.ProviderFinalizationIdentity {
  const validated = store.providerRecordReviewValidation(validationIdentity).record;
  return {
    validation: structuredClone(validationIdentity),
    validationEventDigest: validated.validationEventDigest,
    finalizationRequestId: randomUUID(),
  };
}
const disabled = (code: string) =>
  expect.objectContaining({ code: "QUALITY_PROVIDER_DISPATCH_" + code });
it("stores r9 and r10 from exact original manuscript/review with no cost or approval mutation", () => {
  const budget = store.providerBudgetGet("production"),
    approval = store.providerDownload(identity.runId, 1).body;
  const original = ["generation-validated", "review-request", "review-response"].map(
    (key) => store.providerArtifact(identity.runId, key).body,
  );
  const p = store.providerPrepareReviewValidation(validationIdentity);
  expect(p).toMatchObject({
    status: "prepared",
    plan: { planVersion: 2, dispatchAllowed: false, finalResultPersisted: false },
  });
  const saved = store.providerRecordReviewValidation(validationIdentity);
  expect(saved).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      revision: 9,
      validationPersisted: true,
      finalResultPersisted: false,
      dispatchAllowed: false,
    },
  });
  const f = {
    validation: validationIdentity,
    validationEventDigest: saved.record.validationEventDigest,
    finalizationRequestId: randomUUID(),
  };
  const planned = store.providerPrepareFinalization(f);
  expect(planned).toMatchObject({
    status: "prepared",
    plan: { planVersion: 2, dispatchAllowed: false, completionPersisted: false },
  });
  const final = store.providerRecordFinalization(f);
  expect(final).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      revision: 10,
      completionPersisted: true,
      finalResultPersisted: true,
      dispatchAllowed: false,
    },
  });
  expect(snapshot()).toMatchObject({
    archiveFormatVersion: 5,
    revision: 10,
    state: "completed",
    terminal: true,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(
    snapshot()
      .events.slice(8)
      .map((e) => ("executionContractVersion" in e ? e.executionContractVersion : null)),
  ).toEqual([2, 2]);
  expect(store.providerArtifact(identity.runId, "final-result").body).toEqual(
    Buffer.from(planned.plan!.rows.artifact.body),
  );
  expect(planned.plan!.rows.artifact.body).toBe(p.plan!.finalization.rawBody);
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(store.providerDownload(identity.runId, 1).body).toBe(approval);
  expect(
    ["generation-validated", "review-request", "review-response"].map(
      (key) => store.providerArtifact(identity.runId, key).body,
    ),
  ).toEqual(original);
  expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
  expect(store.providerGenerationValidationLookup(oldValidation)).toMatchObject({
    validationPersisted: true,
  });
  expect(store.providerReviewDispatchLookup(oldReview)).toMatchObject({ reviewPersisted: true });
  expect(store.providerFinalizationLookup(oldFinalIdentity)).toMatchObject({
    completionPersisted: true,
  });
  expect(() => store.providerGet(identity.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
}, 15000);
it("requires preload outside transactions for each new selected write without SQL during loading", async () => {
  reopen();
  let before = inspectQualityDatabase(db);
  expect(() => store.providerRecordReviewValidation(validationIdentity)).toThrow(
    disabled("VALIDATION_PLANNING_NOT_LOADED"),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  const sql = vi.spyOn(DatabaseSync.prototype, "exec");
  await Promise.all([
    store.providerLoadValidationPlanning(),
    store.providerLoadValidationPlanning(),
  ]);
  expect(sql).not.toHaveBeenCalled();
  sql.mockRestore();
  const f = finalIdentity();
  reopen();
  before = inspectQualityDatabase(db);
  expect(() => store.providerRecordFinalization(f)).toThrow(
    disabled("VALIDATION_PLANNING_NOT_LOADED"),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  await store.providerLoadValidationPlanning();
  expect(store.providerRecordFinalization(f).newlyCommitted).toBe(true);
});
it.each([1, 2, 3])("rolls back r9 artifact/event/receipt at insert %s", (point) => {
  const before = inspectQualityDatabase(db),
    spy = failInsert(point);
  expect(() => store.providerRecordReviewValidation(validationIdentity)).toThrow(
    "synthetic insert interruption",
  );
  spy.mockRestore();
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(snapshot().revision).toBe(8);
  expect(store.providerReviewValidationLookup(validationIdentity)).toEqual({
    state: "not-observed",
  });
  expect(store.providerRecordReviewValidation(validationIdentity).newlyCommitted).toBe(true);
});
it.each([1, 2, 3])("rolls back r10 artifact/event/receipt at insert %s", (point) => {
  const f = finalIdentity(),
    before = inspectQualityDatabase(db),
    spy = failInsert(point);
  expect(() => store.providerRecordFinalization(f)).toThrow("synthetic insert interruption");
  spy.mockRestore();
  expect(inspectQualityDatabase(db)).toEqual(before);
  expect(snapshot().revision).toBe(9);
  expect(store.providerFinalizationLookup(f)).toEqual({ state: "not-observed" });
  expect(store.providerRecordFinalization(f).newlyCommitted).toBe(true);
});
it.each(["before", "after"])("recovers original r9 after error %s COMMIT", (where) => {
  const before = inspectQualityDatabase(db),
    spy = atCommit(
      1,
      () => {
        throw Error("commit interrupted");
      },
      where === "before",
    );
  expect(() => store.providerRecordReviewValidation(validationIdentity)).toThrow(
    where === "before" ? "commit interrupted" : "cannot rollback - no transaction is active",
  );
  spy.mockRestore();
  if (where === "before") {
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(store.providerRecordReviewValidation(validationIdentity).newlyCommitted).toBe(true);
  } else {
    const saved = inspectQualityDatabase(db);
    reopen(null);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(validationPlanner, "prepareVersionedProviderReviewValidation").mockImplementation(
      forbidden,
    );
    vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(forbidden);
    expect(store.providerRecordReviewValidation(validationIdentity)).toMatchObject({
      newlyCommitted: false,
      replayed: true,
    });
    expect(inspectQualityDatabase(db)).toEqual(saved);
  }
});
it.each(["before", "after"])("recovers original r10 after error %s COMMIT", (where) => {
  const f = finalIdentity(),
    before = inspectQualityDatabase(db),
    spy = atCommit(
      1,
      () => {
        throw Error("commit interrupted");
      },
      where === "before",
    );
  expect(() => store.providerRecordFinalization(f)).toThrow(
    where === "before" ? "commit interrupted" : "cannot rollback - no transaction is active",
  );
  spy.mockRestore();
  if (where === "before") {
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(store.providerRecordFinalization(f).newlyCommitted).toBe(true);
  } else {
    const saved = inspectQualityDatabase(db);
    reopen("plan-observation-v1");
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(finalPlanner, "prepareVersionedProviderFinalization").mockImplementation(forbidden);
    vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(forbidden);
    expect(store.providerRecordFinalization(f)).toMatchObject({
      newlyCommitted: false,
      replayed: true,
    });
    expect(inspectQualityDatabase(db)).toEqual(saved);
  }
});
it.each(["DELETE", "WAL"])(
  "keeps %s writer lock through both plans and rejects concurrent new identity",
  async (mode) => {
    db.exec("PRAGMA journal_mode=" + mode);
    db.exec("PRAGMA busy_timeout=0");
    const second = open();
    await second.providerLoadValidationPlanning();
    const original = engine.finalizeObservedPlanReview,
      checked = vi.fn();
    const spy = vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      checked();
      return original(...args);
    });
    try {
      const a = store.providerRecordReviewValidation(validationIdentity),
        f = {
          validation: validationIdentity,
          validationEventDigest: a.record.validationEventDigest,
          finalizationRequestId: randomUUID(),
        };
      expect(checked).toHaveBeenCalledTimes(1);
      const b = store.providerRecordFinalization(f);
      expect(checked).toHaveBeenCalledTimes(2);
      spy.mockRestore();
      expect(second.providerRecordReviewValidation(validationIdentity)).toMatchObject({
        replayed: true,
        record: a.record,
      });
      expect(second.providerRecordFinalization(f)).toMatchObject({
        replayed: true,
        record: b.record,
      });
      const before = inspectQualityDatabase(db);
      expect(() =>
        second.providerRecordReviewValidation({
          ...validationIdentity,
          validationRequestId: randomUUID(),
        }),
      ).toThrow(disabled("REVIEW_VALIDATION_CONFLICT"));
      expect(() =>
        second.providerRecordFinalization({ ...f, finalizationRequestId: randomUUID() }),
      ).toThrow(disabled("FINALIZATION_CONFLICT"));
      expect(inspectQualityDatabase(db)).toEqual(before);
    } finally {
      spy.mockRestore();
      second.close();
    }
  },
  15000,
);
it.each(["plan-observation-v1", null] as const)(
  "recovers both original nonces before selection/time/loader checks with %s",
  (version) => {
    const f = finalIdentity(),
      a = store.providerReviewValidationLookup(validationIdentity);
    const b = store.providerRecordFinalization(f).record,
      before = inspectQualityDatabase(db);
    reopen(version);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(forbidden);
    vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(forbidden);
    vi.spyOn(validationPlanner, "prepareVersionedProviderReviewValidation").mockImplementation(
      forbidden,
    );
    vi.spyOn(finalPlanner, "prepareVersionedProviderFinalization").mockImplementation(forbidden);
    expect(store.providerRecordReviewValidation(validationIdentity)).toMatchObject({
      record: a,
      newlyCommitted: false,
      replayed: true,
    });
    expect(store.providerRecordFinalization(f)).toMatchObject({
      record: b,
      newlyCommitted: false,
      replayed: true,
    });
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("refuses wrong fixed server selection before new r9/r10 writes", async () => {
  const before = inspectQualityDatabase(db);
  reopen("plan-observation-v1");
  await store.providerLoadValidationPlanning();
  expect(() => store.providerRecordReviewValidation(validationIdentity)).toThrow(
    disabled("REVIEW_VALIDATION_SERVER_VERSION_MISMATCH"),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  reopen();
  await store.providerLoadValidationPlanning();
  const f = finalIdentity(),
    validated = inspectQualityDatabase(db);
  reopen("plan-observation-v1");
  await store.providerLoadValidationPlanning();
  expect(() => store.providerRecordFinalization(f)).toThrow(
    disabled("FINALIZATION_SERVER_VERSION_MISMATCH"),
  );
  expect(inspectQualityDatabase(db)).toEqual(validated);
});
it.each(["source", "nonce", "version", "tokenEvidence"])(
  "rejects changed %s instead of returning original records",
  (field) => {
    const f = finalIdentity();
    store.providerRecordFinalization(f);
    const before = inspectQualityDatabase(db),
      a = structuredClone(validationIdentity),
      b = structuredClone(f);
    if (field === "source") {
      a.dispatch.validationEventDigest = "0".repeat(64);
      b.validation.responseEventDigest = "0".repeat(64);
    }
    if (field === "nonce") {
      a.validationRequestId = randomUUID();
      b.finalizationRequestId = randomUUID();
    }
    const changedA = ["version", "tokenEvidence"].includes(field) ? { ...a, [field]: true } : a;
    const changedB = ["version", "tokenEvidence"].includes(field) ? { ...b, [field]: true } : b;
    expect(() => store.providerRecordReviewValidation(changedA)).toThrow();
    expect(() => store.providerRecordFinalization(changedB)).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("requires explicit synthetic scope and keeps production/getter gates closed", async () => {
  const before = inspectQualityDatabase(db);
  reopen(v2, false, false);
  await store.providerLoadValidationPlanning();
  expect(() => store.providerRecordReviewValidation(validationIdentity)).toThrow(
    disabled("REVIEW_VALIDATION_RECORDING_DISABLED"),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
  reopen();
  await store.providerLoadValidationPlanning();
  const f = finalIdentity(),
    validated = inspectQualityDatabase(db);
  reopen(v2, false, false);
  await store.providerLoadValidationPlanning();
  expect(() => store.providerRecordFinalization(f)).toThrow(
    disabled("FINALIZATION_RECORDING_DISABLED"),
  );
  expect(() => store.providerGet(identity.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(inspectQualityDatabase(db)).toEqual(validated);
});
it("audits corruption in another run before nonce recovery or new output", () => {
  const f = finalIdentity();
  store.providerRecordFinalization(f);
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
  expect(() => store.providerReviewValidationLookup(validationIdentity)).toThrow();
  expect(() => store.providerRecordReviewValidation(validationIdentity)).toThrow();
  expect(() => store.providerFinalizationLookup(f)).toThrow();
  expect(() => store.providerRecordFinalization(f)).toThrow();
});
it("derives stored output after expiry without changing cumulative costs or granting a send", () => {
  const budget = store.providerBudgetGet("production");
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const f = finalIdentity();
  expect(store.providerRecordFinalization(f).record).toMatchObject({
    completionPersisted: true,
    dispatchAllowed: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it("backs up actual writer-produced v2 r10 beside v1 and recovers both nonces without current planners", async () => {
  const f = finalIdentity(),
    validation = store.providerReviewValidationLookup(validationIdentity),
    final = store.providerRecordFinalization(f).record;
  const exported = store.providerDownload(identity.runId, 10).body,
    budget = store.providerBudgetGet("production");
  const keys = [
    "generation-validated",
    "review-request",
    "review-response",
    "review-validated",
    "final-result",
  ];
  const raw = keys.map((key) => store.providerArtifact(identity.runId, key).body);
  const backup = join(root, "backup"),
    target = join(root, "restored");
  mkdirSync(target);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, target);
  const restored = new PlanQualityStore(target, { providerEnvironment: "synthetic-test" });
  try {
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    vi.spyOn(validationPlanner, "prepareProviderReviewValidation").mockImplementation(forbidden);
    vi.spyOn(finalPlanner, "prepareProviderFinalization").mockImplementation(forbidden);
    vi.spyOn(validationPlanner, "prepareVersionedProviderReviewValidation").mockImplementation(
      forbidden,
    );
    vi.spyOn(finalPlanner, "prepareVersionedProviderFinalization").mockImplementation(forbidden);
    vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(forbidden);
    vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(forbidden);
    expect(restored.providerDownload(identity.runId, 10).body).toBe(exported);
    expect(restored.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(keys.map((key) => restored.providerArtifact(identity.runId, key).body)).toEqual(raw);
    expect(restored.providerBudgetGet("production")).toEqual(budget);
    expect(restored.providerRecordReviewValidation(validationIdentity)).toMatchObject({
      record: validation,
      replayed: true,
    });
    expect(restored.providerRecordFinalization(f)).toMatchObject({ record: final, replayed: true });
    expect(restored.providerRecordFinalization(oldFinalIdentity)).toMatchObject({ replayed: true });
  } finally {
    restored.close();
  }
}, 30000);
