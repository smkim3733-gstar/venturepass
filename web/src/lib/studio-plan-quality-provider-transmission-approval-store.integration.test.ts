/** Synthetic approvals/temporary DB only. SDK, fetch and company storage are forbidden. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  reserveTransmissionTestRun,
  transmissionStoreFixture,
} from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { adoptReservationTestPolicy } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { seedPolicyTestBudget } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  backupQualityData,
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { inspectProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import * as configuration from "./studio-plan-quality-provider-configuration";
import * as planner from "./studio-plan-quality-provider-transmission-plan";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerTransmissionReviewDigestInput } from "./studio-plan-quality-provider-transmission-review-types";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";

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
let root: string, directory: string, store: PlanQualityStore, db: DatabaseSync;
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-transmission-store-"));
  directory = join(root, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), "synthetic company sentinel");
  store = new PlanQualityStore(directory);
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  db.function("quality_storage_contract", () => "quality-v9");
}, 15000);
afterEach(() => {
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("synthetic company sentinel");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-transmission-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const ready = () => transmissionStoreFixture(store, reserveTransmissionTestRun(store));
const snapshot = () => inspectQualityDatabase(db);
function usage() {
  db.exec("BEGIN");
  try {
    return inspectQualityDatabaseUsage(db);
  } finally {
    db.exec("ROLLBACK");
  }
}
function tamper(table: string, action: "update" | "delete", work: () => void) {
  const name = `${table}_no_${action}`,
    sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  try {
    work();
  } finally {
    db.exec(sql);
  }
}
function expectedPlan(input: ReturnType<typeof ready>) {
  const registry = store.candidateRegistryGet(1);
  db.exec("BEGIN");
  try {
    const bytes = inspectQualityDatabaseUsage(db),
      ledger = readLedgerDatabaseInput(db, () => registry),
      { coverage, records } = readProviderReservationDatabaseRows(db),
      archive = { ledger, coverage, records },
      audited = inspectProviderReservationArchive(archive);
    const additionalUsedBytes = bytes.usedBytes - audited.ledger.usedBytes - audited.usedBytes;
    const result = planner.prepareProviderTransmissionApproval({
      ...input,
      current: {
        selection: { runId: input.command.runId, runDigest: input.command.runDigest },
        archive,
        configuration: configuration.getProviderConfigurationProposal(),
        inspectedAt: new Date().toISOString(),
      },
      additionalUsedBytes,
    });
    if (result.status !== "prepared") throw new Error(result.reason);
    return result.plan;
  } finally {
    db.exec("ROLLBACK");
  }
}
it("commits exactly three bound rows, consumes reserved bytes and grants no dispatch", () => {
  const input = ready(),
    before = snapshot(),
    bytes = usage(),
    budget = store.providerBudgetGet("production"),
    expected = expectedPlan(input);
  const result = store.providerApproveTransmission(input.command, input.review);
  expect(result).toMatchObject({
    state: "committed",
    newlyCommitted: true,
    replayed: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    record: { command: input.command, approvedReview: input.review, dispatchAllowed: false },
  });
  expect(result.record).toEqual(expected.rows.binding);
  expect(snapshot()).toMatchObject({
    actualRuns: before.actualRuns,
    actualArtifacts: before.actualArtifacts,
    actualBudgetEvents: before.actualBudgetEvents,
    providerPolicies: before.providerPolicies,
    actualEvents: 1,
    actualRequests: before.actualRequests + 1,
    providerTransmissionBindings: 1,
    providerTransmissionCoverage: 1,
    providerReservationBindings: 1,
  });
  expect(store.providerGet(input.command.runId)).toMatchObject({
    state: "approved",
    revision: 1,
    actualAiCalls: null,
    dispatchIntentCount: 0,
    responseCount: 0,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  const after = usage();
  expect(after.usedBytes + after.reservedBytes).toBe(
    bytes.usedBytes + bytes.reservedBytes + Buffer.byteLength(JSON.stringify(result.record)),
  );
  expect(store.providerTransmissionApprovalLookup(input.command.clientRequestId)).toEqual({
    state: "committed",
    record: result.record,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  expect(store.providerTransmissionApprovalLookup(randomUUID())).toEqual({ state: "not-observed" });
  expect(() => store.providerRecordApprove(input.command.runId, expected.execution)).toThrowError(
    expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }),
  );
});
it("replays before reading current configuration/time/review after restart, policy changes and expiry", () => {
  const input = ready(),
    first = store.providerApproveTransmission(input.command, input.review);
  adoptReservationTestPolicy(store, 1);
  const before = snapshot();
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw new Error("Unavailable config");
    });
  const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
    throw new Error("No new clock allowed");
  });
  expect(store.providerApproveTransmission(input.command, undefined)).toEqual({
    ...first,
    newlyCommitted: false,
    replayed: true,
  });
  expect(store.providerTransmissionApprovalLookup(input.command.clientRequestId)).toMatchObject({
    record: first.record,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(clock).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
});
it("keeps the synthetic gate closed for production execution even after approval", () => {
  const input = ready(),
    first = store.providerApproveTransmission(input.command, input.review);
  store.close();
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  expect(() =>
    store.providerRecordFinish(input.command.runId, {
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      payload: {
        kind: "execution-stopped",
        outcome: "before-dispatch",
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
  expect(store.providerGet(input.command.runId)).toMatchObject({
    state: "approved",
    revision: 1,
    dispatchAllowed: false,
  });
  expect(store.providerBudgetGet("production").heldUnits).toBe(input.review.budget.heldUnits);
  const before = snapshot();
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  expect(store.providerApproveTransmission(input.command, null)).toEqual({
    ...first,
    newlyCommitted: false,
    replayed: true,
  });
  expect(store.providerTransmissionApprovalLookup(input.command.clientRequestId)).toMatchObject({
    record: first.record,
    dispatchAllowed: false,
  });
  expect(snapshot()).toEqual(before);
});
it("rejects a different valid full command even when its native execution input digest is identical", () => {
  const run = reserveTransmissionTestRun(store),
    first = transmissionStoreFixture(store, run);
  vi.setSystemTime(new Date(Date.parse(actualTestNow) + 1000));
  const second = transmissionStoreFixture(store, run);
  first.command.approval.approvedAt = second.command.approval.approvedAt;
  second.command.clientRequestId = first.command.clientRequestId;
  expect(expectedPlan(first).rows.receipt.inputDigest).toBe(
    expectedPlan(second).rows.receipt.inputDigest,
  );
  expect(first.command.approvedReviewDigest).not.toBe(second.command.approvedReviewDigest);
  store.providerApproveTransmission(first.command, first.review);
  const before = snapshot();
  expect(() => store.providerApproveTransmission(second.command, second.review)).toThrowError(
    expect.objectContaining({ code: "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT" }),
  );
  expect(snapshot()).toEqual(before);
});
it.each(["registration", "policy", "reservation", "evaluation"])(
  "rejects an existing %s nonce without inventing a binding",
  (kind) => {
    const input = ready();
    if (kind === "evaluation")
      store.create({
        clientRequestId: randomUUID(),
        title: "synthetic",
        manifestDigest: store.list().manifestDigest,
      });
    const table =
      kind === "registration"
        ? "quality_candidate_requests"
        : kind === "policy"
          ? "quality_provider_policies"
          : kind === "evaluation"
            ? "quality_requests"
            : "quality_provider_reservation_bindings";
    input.command.clientRequestId = String(db.prepare(`SELECT nonce FROM ${table}`).get()!.nonce);
    const before = snapshot();
    expect(store.providerTransmissionApprovalLookup(input.command.clientRequestId)).toEqual({
      state: "not-observed",
    });
    expect(() => store.providerApproveTransmission(input.command, input.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT" }),
    );
    expect(snapshot()).toEqual(before);
  },
);
it.each([
  "expired",
  "configuration",
  "policy-head",
  "approved-run",
  "forged-review",
  "missing-review",
  "cas",
  "future-approval",
])("rejects new approval with changed %s without writes", (kind) => {
  const input = ready();
  if (kind === "expired") vi.setSystemTime(input.review.expiresAt);
  if (kind === "configuration") {
    const value = configuration.getProviderConfigurationProposal()!;
    value.proposedBudget.capUnits = "30000000";
    value.configurationDigest = digest(providerConfigurationDigestInput(value));
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(value);
  }
  if (kind === "policy-head") adoptReservationTestPolicy(store, 1);
  if (kind === "approved-run")
    store.providerApproveTransmission(
      { ...input.command, clientRequestId: randomUUID() },
      input.review,
    );
  if (kind === "forged-review") {
    input.review.request.generation.body.input[1].content += " changed";
    input.review.reviewDigest = digest(providerTransmissionReviewDigestInput(input.review));
    input.command.approvedReviewDigest = input.review.reviewDigest;
  }
  if (kind === "cas") input.command.expectedBudgetHead.revision++;
  if (kind === "future-approval")
    input.command.approval.approvedAt = new Date(Date.parse(actualTestNow) + 1).toISOString();
  const before = snapshot();
  expect(() =>
    store.providerApproveTransmission(
      input.command,
      kind === "missing-review" ? null : input.review,
    ),
  ).toThrow();
  expect(snapshot()).toEqual(before);
});
it.each(["unknown", "consent", "revision"])(
  "strictly rejects %s command before storage access",
  (kind) => {
    const input = ready(),
      before = snapshot();
    const command =
      kind === "unknown"
        ? { ...input.command, dispatchAllowed: true }
        : kind === "consent"
          ? {
              ...input.command,
              approval: { ...input.command.approval, acknowledgedExternalTransmission: false },
            }
          : { ...input.command, expectedRun: { ...input.command.expectedRun, revision: 1 } };
    const getter = vi.spyOn(configuration, "getProviderConfigurationProposal");
    expect(() => store.providerApproveTransmission(command, input.review)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  },
);
it("loads current configuration under the writer lock", () => {
  const input = ready(),
    original = configuration.getProviderConfigurationProposal;
  db.exec("PRAGMA busy_timeout=1");
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      expect(db.isTransaction).toBe(false);
      return original();
    });
  store.providerApproveTransmission(input.command, input.review);
  expect(getter).toHaveBeenCalledOnce();
});
it.each([
  "quality_actual_events",
  "quality_actual_requests",
  "quality_provider_transmission_bindings",
])("rolls back after %s insert and retries the unchanged command", (table) => {
  const input = ready(),
    before = snapshot(),
    prepare = DatabaseSync.prototype.prepare,
    failure = vi.fn();
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith(`INSERT INTO ${table}(`)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => {
        run(...args);
        failure();
        throw new Error("Synthetic insertion failure");
      });
    }
    return statement;
  });
  expect(() => store.providerApproveTransmission(input.command, input.review)).toThrow(
    "Synthetic insertion failure",
  );
  expect(failure).toHaveBeenCalledOnce();
  expect(snapshot()).toEqual(before);
  expect(store.providerTransmissionApprovalLookup(input.command.clientRequestId)).toEqual({
    state: "not-observed",
  });
  spy.mockRestore();
  expect(store.providerApproveTransmission(input.command, input.review).newlyCommitted).toBe(true);
});
it.each([false, true])("audits unrelated records on lookup and write, replay=%s", (replay) => {
  const evaluation = store.create({
      clientRequestId: randomUUID(),
      title: "synthetic",
      manifestDigest: store.list().manifestDigest,
    }),
    input = ready();
  if (replay) store.providerApproveTransmission(input.command, input.review);
  tamper("quality_runs", "update", () =>
    db
      .prepare("UPDATE quality_runs SET body_hash=? WHERE id=?")
      .run("a".repeat(64), evaluation.run.id),
  );
  for (const action of [
    () => store.providerTransmissionApprovalLookup(input.command.clientRequestId),
    () => store.providerApproveTransmission(input.command, input.review),
  ])
    expect(action).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_TRANSMISSION_STORAGE_CORRUPT" }),
    );
});
it.each(["binding", "coverage", "native", "schema"])(
  "blocks lookup and replay on %s corruption",
  (kind) => {
    const input = ready();
    store.providerApproveTransmission(input.command, input.review);
    if (kind === "binding")
      tamper("quality_provider_transmission_bindings", "delete", () =>
        db.exec("DELETE FROM quality_provider_transmission_bindings"),
      );
    if (kind === "coverage")
      tamper("quality_provider_transmission_coverage", "delete", () =>
        db.exec("DELETE FROM quality_provider_transmission_coverage"),
      );
    if (kind === "native")
      tamper("quality_actual_events", "update", () =>
        db.exec("UPDATE quality_actual_events SET body_hash='bad'"),
      );
    if (kind === "schema") db.exec("DROP TRIGGER quality_provider_transmission_bindings_no_delete");
    expect(() => store.providerTransmissionApprovalLookup(input.command.clientRequestId)).toThrow();
    expect(() => store.providerApproveTransmission(input.command, undefined)).toThrow();
  },
);
it.each(["parent", "planner"] as const)(
  "accounts for prior bindings and raw whitespace at exact %s capacity",
  (boundary) => {
    seedPolicyTestBudget(db, "30000000");
    const first = reserveTransmissionTestRun(store),
      second = reserveTransmissionTestRun(store, 1),
      firstInput = transmissionStoreFixture(store, first);
    store.providerApproveTransmission(firstInput.command, firstInput.review);
    for (const table of [
      "quality_candidate_versions",
      "quality_provider_reservation_coverage",
      "quality_provider_reservation_bindings",
      "quality_provider_transmission_coverage",
      "quality_provider_transmission_bindings",
      "quality_actual_events",
    ])
      tamper(table, "update", () => db.exec(`UPDATE ${table} SET body=body || '    '`));
    const input = transmissionStoreFixture(store, second),
      expected = expectedPlan(input),
      before = snapshot(),
      bytes = usage();
    expect(expected.capacity.totalExposureBytes).toBe(
      bytes.usedBytes +
        bytes.reservedBytes +
        Buffer.byteLength(JSON.stringify(expected.rows.binding)),
    );
    const limits =
        boundary === "parent" ? planQualityStoreLimits : planner.providerTransmissionPlanLimits,
      key = boundary === "parent" ? "totalBytes" : "databaseBytes",
      original =
        boundary === "parent"
          ? planQualityStoreLimits.totalBytes
          : planner.providerTransmissionPlanLimits.databaseBytes;
    try {
      Object.assign(limits, { [key]: expected.capacity.totalExposureBytes - 1 });
      expect(() => store.providerApproveTransmission(input.command, input.review)).toThrowError(
        expect.objectContaining({
          code:
            boundary === "parent"
              ? "QUALITY_STORAGE_LIMIT"
              : "QUALITY_PROVIDER_TRANSMISSION_CAPACITY_EXCEEDED",
        }),
      );
      expect(snapshot()).toEqual(before);
      Object.assign(limits, { [key]: expected.capacity.totalExposureBytes });
      expect(store.providerApproveTransmission(input.command, input.review).newlyCommitted).toBe(
        true,
      );
      expect(snapshot()).toMatchObject({ providerTransmissionBindings: 2, actualEvents: 2 });
    } finally {
      Object.assign(limits, { [key]: original });
    }
  },
  20000,
);
it("recovers the exact full command after backup/restore without resetting its historical meaning", async () => {
  const input = ready(),
    first = store.providerApproveTransmission(input.command, input.review),
    before = snapshot(),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  const reopened = new PlanQualityStore(restored);
  try {
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    expect(reopened.providerApproveTransmission(input.command, null)).toEqual({
      ...first,
      newlyCommitted: false,
      replayed: true,
    });
    expect(
      reopened.providerTransmissionApprovalLookup(input.command.clientRequestId),
    ).toMatchObject({ record: first.record, dispatchAllowed: false, budgetWriteAllowed: false });
  } finally {
    reopened.close();
  }
  expect(snapshot()).toEqual(before);
}, 150000);
