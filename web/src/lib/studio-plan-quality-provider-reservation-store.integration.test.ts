/** Synthetic approvals and temporary databases only. No actual customer/credential/transport access. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { seedPolicyTestBudget } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import {
  backupQualityData,
  inspectQualityDatabase,
  inspectQualityDatabaseUsage,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerReservationReviewDigestInput } from "./studio-plan-quality-provider-reservation-review-types";
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
const sentinel = "PRESERVE SYNTHETIC COMPANY DATABASE";
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  root = mkdtempSync(join(tmpdir(), "venture-reservation-store-"));
  directory = join(root, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
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
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  db.close();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-reservation-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function ready(index = 0) {
  adoptReservationTestPolicy(store, index);
  return reservationStoreFixture(store, index);
}
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
it("atomically saves five bound native rows without granting transmission or resetting the budget", () => {
  const input = ready(),
    prior = snapshot(),
    budget = store.providerBudgetGet("production"),
    bytes = usage();
  const result = store.providerReserve(input.command, input.review);
  expect(result).toMatchObject({
    state: "committed",
    newlyCommitted: true,
    replayed: false,
    record: { command: input.command, approvedReview: input.review, dispatchAllowed: false },
  });
  expect(snapshot()).toMatchObject({
    providerPolicies: prior.providerPolicies,
    actualRuns: 1,
    actualArtifacts: 1,
    actualBudgetEvents: 2,
    actualRequests: 2,
    providerReservationBindings: 1,
    providerReservationCoverage: 1,
  });
  const saved = store.providerGet(result.record.runId);
  expect(saved).toMatchObject({ state: "reserved", dispatchAllowed: false, actualAiCalls: 0 });
  expect(store.providerBudgetGet("production")).toMatchObject({
    capUnits: budget.capUnits,
    recognizedUnits: budget.recognizedUnits,
    heldUnits: input.review.policyReview.reservation.totalUnits,
  });
  expect(saved.run.runDigest).toBe(result.record.runDigest);
  const after = usage();
  expect(after.usedBytes + after.reservedBytes).toBe(
    bytes.usedBytes +
      bytes.reservedBytes +
      saved.run.storageReservationBytes +
      Buffer.byteLength(JSON.stringify(result.record)),
  );
  expect(store.providerReservationLookup(input.command.clientRequestId)).toEqual({
    state: "committed",
    record: result.record,
  });
  expect(store.providerReservationLookup(randomUUID())).toEqual({ state: "not-observed" });
  expect(() =>
    store.providerCancel(result.record.runId, {
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      reason: "test-cleanup",
    }),
  ).toThrowError(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
});
it("returns the identical archived result after restart, later policy, expiry and unavailable configuration", () => {
  const input = ready(),
    first = store.providerReserve(input.command, input.review);
  adoptReservationTestPolicy(store, 1);
  const before = snapshot();
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2035-01-01T00:00:00.000Z");
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw new Error("Current configuration unavailable");
    });
  expect(store.providerReserve(input.command, undefined)).toEqual({
    ...first,
    newlyCommitted: false,
    replayed: true,
  });
  expect(store.providerReservationLookup(input.command.clientRequestId)).toEqual({
    state: "committed",
    record: first.record,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
});
it.each(["approval", "candidate", "ledger", "review"])(
  "rejects a changed %s for the same nonce before loading current authority",
  (field) => {
    const input = ready();
    store.providerReserve(input.command, input.review);
    const before = snapshot();
    if (field === "approval") input.command.approval.approvedAt = "2035-01-01T00:00:00.000Z";
    else if (field === "candidate")
      input.command.candidateId = store.candidateRegistryGet(1).entries[1].candidateId;
    else if (field === "ledger") input.command.expectedLedgerDigest = "a".repeat(64);
    else input.command.approvedReviewDigest = "a".repeat(64);
    const getter = vi
      .spyOn(configuration, "getProviderConfigurationProposal")
      .mockImplementation(() => {
        throw new Error("Must not consult authority");
      });
    expect(() => store.providerReserve(input.command, undefined)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT" }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  },
);
it.each(["registration", "policy", "native-budget"])(
  "rejects a %s nonce without manufacturing a binding or replay",
  (kind) => {
    const input = ready();
    input.command.clientRequestId = String(
      db
        .prepare(
          kind === "registration"
            ? "SELECT nonce FROM quality_candidate_requests"
            : kind === "policy"
              ? "SELECT nonce FROM quality_provider_policies"
              : "SELECT nonce FROM quality_actual_requests",
        )
        .get()!.nonce,
    );
    const before = snapshot();
    expect(store.providerReservationLookup(input.command.clientRequestId)).toEqual({
      state: "not-observed",
    });
    expect(() => store.providerReserve(input.command, input.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT" }),
    );
    expect(snapshot()).toEqual(before);
  },
);
it.each(["expired", "configuration", "policy-head", "forged-review", "another-run"])(
  "rejects changed %s for a new command without writes",
  (kind) => {
    const input = ready();
    if (kind === "expired") vi.setSystemTime(input.review.policyReview.expiresAt);
    else if (kind === "configuration") {
      const value = configuration.getProviderConfigurationProposal()!;
      value.proposedBudget.capUnits = "16000000";
      value.configurationDigest = digest(providerConfigurationDigestInput(value));
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(value);
    } else if (kind === "policy-head") adoptReservationTestPolicy(store, 1);
    else if (kind === "another-run")
      store.providerReserve({ ...input.command, clientRequestId: randomUUID() }, input.review);
    else {
      input.review.policyReview.reservation.totalUnits = "1";
      input.review.reviewDigest = digest(providerReservationReviewDigestInput(input.review));
      input.command.approvedReviewDigest = input.review.reviewDigest;
    }
    const before = snapshot();
    expect(() => store.providerReserve(input.command, input.review)).toThrow();
    expect(snapshot()).toEqual(before);
  },
);
it("loads current authority only under the write lock", () => {
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
  store.providerReserve(input.command, input.review);
  expect(getter).toHaveBeenCalledOnce();
});
it.each([
  "quality_actual_runs",
  "quality_actual_artifacts",
  "quality_actual_budget_events",
  "quality_actual_requests",
  "quality_provider_reservation_bindings",
])("rolls back after %s insertion and can retry the original command", (table) => {
  const input = ready(),
    before = snapshot(),
    prepare = DatabaseSync.prototype.prepare;
  const failure = vi.fn();
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
        throw new Error("Synthetic failure after row");
      });
    }
    return statement;
  });
  expect(() => store.providerReserve(input.command, input.review)).toThrow(
    "Synthetic failure after row",
  );
  expect(failure).toHaveBeenCalledOnce();
  expect(snapshot()).toEqual(before);
  expect(store.providerReservationLookup(input.command.clientRequestId)).toEqual({
    state: "not-observed",
  });
  spy.mockRestore();
  expect(store.providerReserve(input.command, input.review).newlyCommitted).toBe(true);
});
it.each([false, true])(
  "audits unrelated evaluation records before lookup and reserve, replay=%s",
  (replay) => {
    const run = store.create({
      clientRequestId: randomUUID(),
      title: "synthetic",
      manifestDigest: store.list().manifestDigest,
    });
    const input = ready();
    if (replay) store.providerReserve(input.command, input.review);
    tamper("quality_runs", "update", () =>
      db.prepare("UPDATE quality_runs SET body_hash=? WHERE id=?").run("a".repeat(64), run.run.id),
    );
    for (const action of [
      () => store.providerReservationLookup(input.command.clientRequestId),
      () => store.providerReserve(input.command, input.review),
    ])
      expect(action).toThrowError(
        expect.objectContaining({ code: "QUALITY_PROVIDER_RESERVATION_STORAGE_CORRUPT" }),
      );
  },
);
it("counts pre-existing whitespace, metadata and held bytes before writing", () => {
  const input = ready();
  tamper("quality_candidate_versions", "update", () =>
    db.exec("UPDATE quality_candidate_versions SET body=body || '    '"),
  );
  tamper("quality_provider_reservation_coverage", "update", () =>
    db.exec("UPDATE quality_provider_reservation_coverage SET body=body || '    '"),
  );
  const before = snapshot(),
    bytes = usage(),
    original = planQualityStoreLimits.totalBytes;
  try {
    Object.assign(planQualityStoreLimits, {
      totalBytes: bytes.usedBytes + bytes.reservedBytes + 32 * 1024 * 1024,
    });
    expect(() => store.providerReserve(input.command, input.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_STORAGE_LIMIT" }),
    );
    expect(snapshot()).toEqual(before);
  } finally {
    Object.assign(planQualityStoreLimits, { totalBytes: original });
  }
  expect(store.providerReserve(input.command, input.review).newlyCommitted).toBe(true);
});
it("preserves cumulative reservations for two candidates under a previously configured budget", () => {
  seedPolicyTestBudget(db, "30000000");
  adoptReservationTestPolicy(store);
  adoptReservationTestPolicy(store, 1);
  const firstInput = reservationStoreFixture(store),
    first = store.providerReserve(firstInput.command, firstInput.review);
  const secondInput = reservationStoreFixture(store, 1),
    second = store.providerReserve(secondInput.command, secondInput.review);
  expect(first.record.runId).not.toBe(second.record.runId);
  expect(store.providerBudgetGet("production")).toMatchObject({
    capUnits: "30000000",
    heldUnits: (
      BigInt(firstInput.review.policyReview.reservation.totalUnits!) +
      BigInt(secondInput.review.policyReview.reservation.totalUnits!)
    ).toString(),
    revision: 3,
  });
  expect(snapshot()).toMatchObject({
    actualRuns: 2,
    providerReservationBindings: 2,
    actualBudgetEvents: 3,
  });
});
it("recovers the exact committed command after a real backup and restore", async () => {
  const input = ready(),
    first = store.providerReserve(input.command, input.review),
    before = snapshot();
  const backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  const reopened = new PlanQualityStore(restored);
  try {
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    expect(reopened.providerReserve(input.command, undefined)).toEqual({
      ...first,
      newlyCommitted: false,
      replayed: true,
    });
    expect(reopened.providerReservationLookup(input.command.clientRequestId)).toEqual({
      state: "committed",
      record: first.record,
    });
  } finally {
    reopened.close();
  }
  expect(snapshot()).toEqual(before);
}, 150000);
