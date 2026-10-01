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
let seededCapture: planner.ProviderReviewResponseCapture,
  capture: planner.ProviderReviewResponseCapture;
let seededValidation: ProviderGenerationValidationIdentity;
let oldValidation: ProviderGenerationValidationIdentity, oldReview: ProviderReviewDispatchIdentity;
import type { ProviderGenerationValidationIdentity } from "./studio-plan-quality-provider-generation-validation";
import type { ProviderReviewDispatchIdentity } from "./studio-plan-quality-provider-review-dispatch-plan";
import * as engine from "./studio-engine";
import * as planner from "./studio-plan-quality-provider-review-response";
import { reviewResponseCapture } from "./studio-plan-quality-provider-review-response-test-helpers";
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
let identity: ProviderGenerationDispatchIdentity,
  seededIdentity: ProviderGenerationDispatchIdentity;
let selectedConfiguration: NonNullable<ReturnType<typeof readFixedProviderConfiguration>>;
const databasePath = (d: string) => join(d, "quality-evaluation", "quality.sqlite");
const send = vi.fn<(request: ProviderObservationPrepared) => Promise<void>>(async () => undefined);
function cleanup(path: string) {
  const rel = relative(resolve(tmpdir()), resolve(path));
  if (!rel.startsWith("venture-version-review-response-") || rel.includes(".."))
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
  seedRoot = mkdtempSync(join(tmpdir(), "venture-version-review-response-seed-"));
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
    seededCapture = reviewResponseCapture(review);
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
  root = mkdtempSync(join(tmpdir(), "venture-version-review-response-test-"));
  directory = join(root, "source");
  mkdirSync(join(directory, "quality-evaluation"), { recursive: true });
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  writeFileSync(databasePath(directory), seedBytes);
  identity = structuredClone(seededIdentity);
  capture = structuredClone(seededCapture);
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

it("preserves exact captured response, settles only review, keeps approval/request bytes and denies execution", () => {
  const before = inspectQualityDatabase(db),
    budget = store.providerBudgetGet("production"),
    request = store.providerArtifact(identity.runId, "review-request"),
    approval = store.providerDownload(identity.runId, 1).body;
  const planned = store.providerPrepareReviewResponse(capture);
  expect(planned).toMatchObject({
    status: "prepared",
    plan: {
      planVersion: 2,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
    },
  });
  if (planned.status !== "prepared") throw Error(planned.reason);
  expect(inspectQualityDatabase(db)).toEqual(before);
  const saved = store.providerRecordReviewResponse(capture);
  expect(saved).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      revision: 8,
      late: false,
      responsePersisted: true,
      dispatchAllowed: false,
      usageAssessment: { status: "known" },
    },
  });
  expect(snapshot()).toMatchObject({
    archiveFormatVersion: 5,
    revision: 8,
    state: "response-recorded",
    dispatchAllowed: false,
    canResume: false,
  });
  expect(store.providerArtifact(identity.runId, "review-response").body).toEqual(
    Buffer.from(planned.plan.rows.artifact.body, "utf8"),
  );
  expect(store.providerArtifact(identity.runId, "review-request")).toEqual(request);
  expect(store.providerDownload(identity.runId, 1).body).toBe(approval);
  expect(store.providerDownload(oldId, 10).body).toBe(oldExport);
  expect(store.providerBudgetGet("production")).toEqual(planned.plan.budget.after);
  expect(BigInt(planned.plan.budget.after.recognizedUnits) - BigInt(budget.recognizedUnits)).toBe(
    BigInt(saved.record.usageAssessment.units!),
  );
  const exact = inspectQualityDatabase(db);
  expect(store.providerRecordReviewResponse(capture)).toMatchObject({
    record: saved.record,
    replayed: true,
    newlyCommitted: false,
  });
  expect(inspectQualityDatabase(db)).toEqual(exact);
  expect(() => store.providerGet(identity.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
}, 15000);
it.each([1, 2, 3, 4])(
  "rolls back response insert %s including settlement and resumes original capture once",
  (point) => {
    const before = inspectQualityDatabase(db),
      spy = failInsert(point);
    expect(() => store.providerRecordReviewResponse(capture)).toThrow(
      "synthetic insert interruption",
    );
    spy.mockRestore();
    expect(inspectQualityDatabase(db)).toEqual(before);
    expect(store.providerReviewResponseLookup(capture)).toEqual({ state: "not-observed" });
    expect(store.providerRecordReviewResponse(capture).newlyCommitted).toBe(true);
  },
);
it.each(["before", "after"])(
  "recovers original capture after COMMIT throws %s commit without new settlement",
  (where) => {
    const before = inspectQualityDatabase(db),
      spy = atCommit(
        1,
        () => {
          throw Error("commit interrupted");
        },
        where === "before",
      );
    expect(() => store.providerRecordReviewResponse(capture)).toThrow(
      where === "before" ? "commit interrupted" : "cannot rollback - no transaction is active",
    );
    spy.mockRestore();
    const committed = inspectQualityDatabase(db);
    if (where === "before") expect(committed).toEqual(before);
    reopen("plan-observation-v1");
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    if (where === "after")
      vi.spyOn(planner, "prepareVersionedProviderReviewResponse").mockImplementation(forbidden);
    expect(store.providerRecordReviewResponse(capture)).toMatchObject({
      newlyCommitted: where === "before",
      replayed: where === "after",
    });
    if (where === "after") expect(inspectQualityDatabase(db)).toEqual(committed);
  },
);
it.each(["DELETE", "WAL"])(
  "holds the %s writer lock through response artifact, budget, event and receipt then replays on another connection",
  (mode) => {
    db.exec("PRAGMA journal_mode=" + mode);
    db.exec("PRAGMA busy_timeout=0");
    const second = open(),
      original = DatabaseSync.prototype.prepare;
    let attempts = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const stmt = original.call(this, sql);
      if (/^INSERT INTO quality_actual_(artifacts|budget_events|events|requests)\(/.test(sql)) {
        const run = stmt.run.bind(stmt);
        vi.spyOn(stmt, "run").mockImplementation((...args) => {
          expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
          attempts++;
          return run(...args);
        });
      }
      return stmt;
    });
    try {
      const saved = store.providerRecordReviewResponse(capture);
      spy.mockRestore();
      expect(attempts).toBe(4);
      expect(second.providerRecordReviewResponse(capture)).toMatchObject({
        record: saved.record,
        replayed: true,
      });
    } finally {
      spy.mockRestore();
      second.close();
    }
  },
);
it.each([null, "plan-observation-v1"] as const)(
  "preserves new capture after expiry with current selection %s and no loader/configuration/validator",
  (version) => {
    reopen(version);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden);
    expect(store.providerRecordReviewResponse(capture)).toMatchObject({
      newlyCommitted: true,
      record: { revision: 8 },
    });
  },
);
it("retains the original review hold when measured usage is absent", () => {
  delete capture.response.usage;
  const budget = store.providerBudgetGet("production");
  expect(store.providerRecordReviewResponse(capture)).toMatchObject({
    record: { usageAssessment: { status: "unknown" }, usageBudgetEventDigest: null },
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
});
it.each(["response", "nonce", "origin", "version", "tokenEvidence"])(
  "rejects substituted %s and never duplicates costs",
  (field) => {
    store.providerRecordReviewResponse(capture);
    const before = inspectQualityDatabase(db),
      changed = structuredClone(capture);
    if (field === "response") changed.response.status = "incomplete";
    if (field === "nonce") changed.responseRequestId = randomUUID();
    if (field === "origin") changed.dispatch.generation.responseEventDigest = "0".repeat(64);
    const input =
      field === "version" || field === "tokenEvidence"
        ? { ...changed, [field]: "plan-observation-v1" }
        : changed;
    expect(() => store.providerRecordReviewResponse(input)).toThrow();
    expect(inspectQualityDatabase(db)).toEqual(before);
  },
);
it("captures caller JSON before planning without invoking SDK accessors", () => {
  let hits = 0;
  const response = structuredClone(capture.response);
  Object.defineProperty(response, "status", {
    enumerable: true,
    get() {
      hits++;
      return "completed";
    },
  });
  const before = inspectQualityDatabase(db);
  expect(() => store.providerRecordReviewResponse({ ...capture, response })).toThrow();
  expect(hits).toBe(0);
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("does not enable non-synthetic response writes", () => {
  reopen(v2, false, false);
  const before = inspectQualityDatabase(db);
  expect(() => store.providerRecordReviewResponse(capture)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_DISPATCH_REVIEW_RESPONSE_RECORDING_DISABLED",
    }),
  );
  expect(inspectQualityDatabase(db)).toEqual(before);
});
it("audits unrelated corrupted original records before nonce recovery", () => {
  store.providerRecordReviewResponse(capture);
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
  expect(() => store.providerReviewResponseLookup(capture)).toThrow();
  expect(() => store.providerRecordReviewResponse(capture)).toThrow();
});
it("backs up writer-produced v2 response beside v1 completion with original bytes and settled budget", async () => {
  const saved = store.providerRecordReviewResponse(capture).record,
    exported = store.providerDownload(identity.runId, 8).body,
    raw = store.providerArtifact(identity.runId, "review-response").body,
    budget = store.providerBudgetGet("production"),
    backup = join(root, "backup"),
    target = join(root, "restored");
  mkdirSync(target);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, target);
  const restored = new PlanQualityStore(target, { providerEnvironment: "synthetic-test" });
  try {
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    vi.spyOn(planner, "prepareVersionedProviderReviewResponse").mockImplementation(forbidden);
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    expect(restored.providerDownload(identity.runId, 8).body).toBe(exported);
    expect(restored.providerDownload(oldId, 10).body).toBe(oldExport);
    expect(restored.providerArtifact(identity.runId, "review-response").body).toEqual(raw);
    expect(restored.providerBudgetGet("production")).toEqual(budget);
    expect(restored.providerRecordReviewResponse(capture)).toMatchObject({
      record: saved,
      replayed: true,
    });
  } finally {
    restored.close();
  }
}, 30000);

import * as native from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
/** Only the interrupted prefix uses a synthetic SQL fixture; the response is recorded by the real store. */
it.each([false, true])(
  "preserves one late review response after an unobserved prefix, unknown usage=%s",
  (unknown) => {
    const snap = snapshot(),
      budget = store.providerBudgetGet("production");
    if (snap.archiveFormatVersion !== 5 || !budget) throw Error("v2 snapshot and budget required");
    const command = {
      clientRequestId: randomUUID(),
      expectedRevision: 7,
      payload: {
        kind: "execution-stopped",
        outcome: "result-unobserved",
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
      },
    } as const;
    const event = native.createVersionedProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 2,
      runId: identity.runId,
      revision: 8,
      budgetRevision: budget.revision,
      previousEventDigest: snap.events[6].eventDigest,
      recordedAt: new Date().toISOString(),
      payload: { ...command.payload, releasedBudgetEventDigests: [] },
    });
    const receipt = native.createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: snap.run.preparation.budget.scopeId,
      kind: "provider-finish",
      clientRequestId: command.clientRequestId,
      inputDigest: native.versionedProviderExecutionOperationDigest(identity.runId, command),
      runId: identity.runId,
      runRevision: 8,
      budgetRevision: budget.revision,
      operationDigest: event.eventDigest,
      recordedAt: event.recordedAt,
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO quality_actual_events(run_id,revision,body,body_hash) VALUES(?,?,?,?)",
      ).run(identity.runId, 8, JSON.stringify(event), digest(event));
      db.prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)").run(
        receipt.clientRequestId,
        JSON.stringify(receipt),
        digest(receipt),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (unknown) delete capture.response.usage;
    reopen(null);
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const saved = store.providerRecordReviewResponse(capture);
    expect(saved).toMatchObject({ newlyCommitted: true, record: { revision: 9, late: true } });
    expect(snapshot()).toMatchObject({ revision: 9, state: "result-unobserved", terminal: true });
    if (unknown) expect(store.providerBudgetGet("production")).toEqual(budget);
    const exact = inspectQualityDatabase(db);
    expect(store.providerRecordReviewResponse(capture)).toMatchObject({
      record: saved.record,
      replayed: true,
    });
    expect(inspectQualityDatabase(db)).toEqual(exact);
    expect(() =>
      store.providerRecordReviewResponse({ ...capture, responseRequestId: randomUUID() }),
    ).toThrow();
  },
);
