/** Synthetic temporary SQLite only. No actual approval, key, customer data or provider call. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import {
  createProviderReservationReview,
  createVersionedProviderReservationReview,
  isVersionedProviderReservationReviewCurrent,
} from "./studio-plan-quality-provider-reservation-review";
import {
  prepareProviderReservation,
  prepareVersionedProviderReservation,
} from "./studio-plan-quality-provider-reservation-plan";
import { fixture as nativeFixture } from "./studio-plan-quality-provider-reservation-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import {
  createProviderReservationMigrationCoverage,
  inspectVersionedProviderReservationArchive,
} from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import { createProviderTransmissionApprovalMigrationCoverage } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { readLedgerDatabaseInput } from "./studio-plan-quality-ledger-database";
import {
  backupQualityData,
  restoreQualityData,
  verifyQualityBackup,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("External access forbidden");
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
const sentinel = "SYNTHETIC COMPANY SENTINEL";
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
function reopen(version?: PlanPromptVersion, config = readFixedProviderConfiguration()!) {
  store.close();
  store = new PlanQualityStore(
    directory,
    version
      ? {
          providerPolicySelection: { version, configuration: config },
        }
      : {},
  );
}
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-reservation-version-"));
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
  if (!rel.startsWith("venture-reservation-version-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function adopt(legacy = false, index = 0) {
  if (legacy) {
    const input = policyAdoptionFixture(store, index);
    return store.providerPolicyAdopt(input.command, input.review);
  }
  const registry = store.candidateRegistryGet(1);
  const candidateId = registry.entries[index].candidateId;
  const { result, expectedPolicyHead } = store.providerPolicyReview(1, candidateId);
  if (result.status !== "review") throw Error(result.reason);
  const review = result.review;
  const command = providerPolicyAdoptionCommandSchema.parse({
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: 1,
    versionDigest: registry.versionDigest,
    candidateId,
    expectedPolicyHead,
    approvedReviewDigest: review.reviewDigest,
    budgetAction: review.budget.revision ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: review.budget.revision ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: new Date().toISOString(),
    },
  });
  return store.providerPolicyAdopt(command, review);
}
function input() {
  const registry = store.candidateRegistryGet(1);
  return {
    selection: {
      version: 1,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[0].candidateId,
    },
    ledger: readLedgerDatabaseInput(db, (version) => store.candidateRegistryGet(version), [1]),
    inspectedAt: new Date().toISOString(),
    configuration: readFixedProviderConfiguration()!,
  };
}
const rows = () => ({
  runs: db.prepare("SELECT * FROM quality_actual_runs ORDER BY id").all(),
  budget: db.prepare("SELECT * FROM quality_actual_budget_events ORDER BY scope_id,revision").all(),
  receipts: db.prepare("SELECT * FROM quality_actual_requests ORDER BY nonce").all(),
  policies: db.prepare("SELECT * FROM quality_provider_policies ORDER BY revision").all(),
  bindings: db.prepare("SELECT * FROM quality_provider_reservation_bindings ORDER BY run_id").all(),
});
const getReview = () => reservationStoreFixture(store).review;

it("keeps original record1/v1 review and full native write plan JSON bytes identical", () => {
  const f = nativeFixture();
  const old = createProviderReservationReview(f.current);
  expect(JSON.stringify(createVersionedProviderReservationReview(v1, f.current))).toBe(
    JSON.stringify(old),
  );
  expect(JSON.stringify(prepareVersionedProviderReservation(v1, f))).toBe(
    JSON.stringify(prepareProviderReservation(f)),
  );
  expect(isVersionedProviderReservationReviewCurrent(v1, f.review, f.current)).toBe(true);
  expect(isVersionedProviderReservationReviewCurrent(v2, f.review, f.current)).toBe(false);
});
it.each([v1, v2] as const)(
  "matches selected %s record2 without changing policy or budget rows",
  (version) => {
    reopen(version);
    adopt();
    const before = rows(),
      audit = inspectQualityDatabase(db);
    const review = getReview();
    expect(review.policy.state).toBe("matched");
    expect(review.assessment.state).toBe("conditions-met");
    expect(review.actions).toEqual({
      reservationAllowed: false,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
    });
    expect(isVersionedProviderReservationReviewCurrent(version, review, input())).toBe(true);
    expect(
      isVersionedProviderReservationReviewCurrent(version === v1 ? v2 : v1, review, input()),
    ).toBe(false);
    expect(rows()).toEqual(before);
    expect(inspectQualityDatabase(db)).toEqual(audit);
  },
);
it("keeps legacy policy selection v1 and uses old encoding only for record1", () => {
  adopt(true);
  const original = getReview(),
    before = rows();
  reopen(v1);
  expect(JSON.stringify(getReview())).toBe(JSON.stringify(original));
  reopen(v2);
  expect(getReview().policy.state).toBe("changed");
  expect(rows()).toEqual(before);
});
it("does not fall back to an older matching v1 policy behind a newer v2 policy", () => {
  adopt(true);
  reopen(v2);
  const latest = adopt().record;
  reopen(v1);
  const review = getReview();
  expect(review.policy).toMatchObject({
    state: "changed",
    reference: { recordDigest: latest.recordDigest },
  });
  expect(review.assessment.blockers).toContain("policy-changed");
});
it("writes selected record2/v1 reservation with original cumulative budget and no transmission", () => {
  reopen(v1);
  adopt();
  const before = rows(),
    f = reservationStoreFixture(store);
  const result = store.providerReserve(f.command, f.review);
  expect(result).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: { dispatchAllowed: false },
  });
  const after = rows();
  expect(after.budget[0]).toEqual(before.budget[0]);
  expect(after.budget).toHaveLength(before.budget.length + 1);
  expect(after.policies).toEqual(before.policies);
  expect(
    JSON.parse(String(after.runs[0].body)).preparation.contract.baseContract.engineVersion,
  ).toBe(v1);
  expect(inspectQualityDatabase(db)).toMatchObject({ actualRuns: 1, providerPolicies: 1 });
});
it("never reads mutable default configuration in selected reservation review or write", () => {
  const config = readFixedProviderConfiguration()!;
  reopen(v1, config);
  adopt();
  const before = getReview();
  config.model = "caller-mutated";
  const getter = vi.mocked(configuration.getProviderConfigurationProposal);
  getter
    .mockImplementation(() => {
      throw Error("Default must not be read");
    })
    .mockClear();
  const f = reservationStoreFixture(store);
  expect(f.review).toEqual(before);
  expect(store.providerReserve(f.command, f.review).newlyCommitted).toBe(true);
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  [v1, v2],
  [v2, v1],
] as const)(
  "rejects a %s reservation review under %s selection with zero writes",
  (first, second) => {
    reopen(first);
    adopt();
    const f = reservationStoreFixture(store),
      before = rows();
    reopen(second);
    expect(() => store.providerReserve(f.command, f.review)).toThrow(
      expect.objectContaining({
        code: "QUALITY_PROVIDER_RESERVATION_REVIEW_NOT_CURRENT",
      }),
    );
    expect(rows()).toEqual(before);
  },
);
it("stores v2 in the separate native format and keeps old execution gates closed", () => {
  reopen(v2);
  adopt();
  const f = reservationStoreFixture(store),
    before = rows();
  const result = store.providerReserve(f.command, f.review),
    snapshot = store.providerArchiveGet(result.record.runId);
  expect(result).toMatchObject({
    newlyCommitted: true,
    record: { recordVersion: 2, dispatchAllowed: false },
  });
  expect(snapshot).toMatchObject({
    archiveFormatVersion: 4,
    revision: 0,
    dispatchAllowed: false,
    canResume: false,
    actualAiCalls: 0,
    run: {
      archiveFormatVersion: 3,
      preparation: { contract: { baseContract: { engineVersion: v2 } } },
    },
  });
  expect(rows().budget[0]).toEqual(before.budget[0]);
  expect(rows().policies).toEqual(before.policies);
  expect(inspectQualityDatabase(db)).toMatchObject({ actualRuns: 1, providerPolicies: 1 });
  expect(() => store.providerGet(result.record.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(
    store.providerTransmissionReview({ runId: snapshot.run.id, runDigest: snapshot.run.runDigest }),
  ).toMatchObject({
    status: "review",
    review: { schemaVersion: 2, assessment: { state: "conditions-met", blockers: [] } },
  });
  const inspection = store.providerTransmissionReview({
    runId: snapshot.run.id,
    runDigest: snapshot.run.runDigest,
  });
  if (inspection.status !== "review") throw Error(inspection.reason);
  expect(Object.values(inspection.review.actions).every((allowed) => allowed === false)).toBe(true);
});
it("recovers original reservation nonce before changed selection, expiry and configuration", () => {
  adopt(true);
  const f = reservationStoreFixture(store),
    original = store.providerReserve(f.command, f.review);
  const before = rows();
  reopen(v2);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const getter = vi.mocked(configuration.getProviderConfigurationProposal);
  getter
    .mockImplementation(() => {
      throw Error("No current configuration");
    })
    .mockClear();
  expect(store.providerReserve(f.command, undefined)).toEqual({
    ...original,
    newlyCommitted: false,
    replayed: true,
  });
  expect(store.providerReservationLookup(f.command.clientRequestId)).toEqual({
    state: "committed",
    record: original.record,
  });
  expect(rows()).toEqual(before);
  expect(getter).not.toHaveBeenCalled();
  const changed = structuredClone(f.command);
  changed.approval.approvedAt = "2026-09-27T03:00:01.000Z";
  expect(() => store.providerReserve(changed, undefined)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT",
    }),
  );
});
it("invalidates reviewed reservation when another candidate changes the policy head", () => {
  reopen(v1);
  adopt();
  const f = reservationStoreFixture(store);
  adopt(false, 1);
  const before = rows();
  expect(() => store.providerReserve(f.command, f.review)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_RESERVATION_REVIEW_NOT_CURRENT",
    }),
  );
  expect(rows()).toEqual(before);
});
it("counts a previous unsettled v1 run under v2 and preserves held budget", () => {
  adopt(true);
  const f = reservationStoreFixture(store),
    old = store.providerReserve(f.command, f.review);
  reopen(v2);
  adopt();
  const before = rows(),
    review = getReview();
  expect(review.policy.state).toBe("matched");
  expect(review.assessment.blockers).toContain("candidate-unsettled");
  expect(review.runs.unsettledCandidateRunIds).toEqual([old.record.runId]);
  expect(BigInt(review.policyReview.budget.heldUnits)).toBeGreaterThan(BigInt(0));
  expect(rows()).toEqual(before);
});
it("expires selected current evidence without altering stored policies", () => {
  reopen(v2);
  adopt();
  const before = rows(),
    selected = input().selection;
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  expect(store.providerReservationReview(selected)).toMatchObject({
    status: "unavailable",
    reason: "configuration-expired",
  });
  expect(rows()).toEqual(before);
});
it("rechecks current inspection and approval times under the selected writer", () => {
  reopen(v1);
  adopt();
  const f = reservationStoreFixture(store),
    before = rows();
  f.command.approval.approvedAt = new Date(Date.parse(actualTestNow) - 1).toISOString();
  expect(() => store.providerReserve(f.command, f.review)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_RESERVATION_APPROVAL_TIME_INVALID",
    }),
  );
  expect(rows()).toEqual(before);
});
it("rejects rehashed review bindings even with a matching client approval digest", () => {
  reopen(v1);
  adopt();
  const f = reservationStoreFixture(store),
    before = rows();
  f.review.policyReview.bindings.requestReviewDigest = "a".repeat(64);
  const { reviewDigest: _p, ...policyBody } = f.review.policyReview;
  void _p;
  f.review.policyReview.reviewDigest = digest(policyBody);
  const { reviewDigest: _r, ...body } = f.review;
  void _r;
  f.review.reviewDigest = digest(body);
  f.command.approvedReviewDigest = f.review.reviewDigest;
  expect(() => store.providerReserve(f.command, f.review)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_RESERVATION_REVIEW_NOT_CURRENT",
    }),
  );
  expect(rows()).toEqual(before);
});
it("audits raw policy bytes before returning a selected review or nonce replay", () => {
  reopen(v1);
  adopt();
  const f = reservationStoreFixture(store);
  store.providerReserve(f.command, f.review);
  const selected = input().selection;
  const sql = String(
    db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_provider_policies_no_update'")
      .get()!.sql,
  );
  db.exec("DROP TRIGGER quality_provider_policies_no_update");
  db.prepare("UPDATE quality_provider_policies SET body_hash=?").run("a".repeat(64));
  db.exec(sql);
  const before = rows();
  expect(() => store.providerReservationReview(selected)).toThrow(
    expect.objectContaining({ code: "QUALITY_ACTUAL_STORAGE_CORRUPT" }),
  );
  expect(() => store.providerReserve(f.command, undefined)).toThrow(
    expect.objectContaining({
      code: "QUALITY_ACTUAL_STORAGE_CORRUPT",
    }),
  );
  expect(rows()).toEqual(before);
});
it.each(["configuration", "version", "engineVersion", "contract"])(
  "rejects caller %s injection in selected context methods",
  (field) => {
    adopt(true);
    const { configuration: config, ...inspection } = input();
    const context = createServerProviderPolicyContext(v1, config);
    const supplied = { ...inspection, [field]: field === "configuration" ? config : v2 };
    expect(() => context.reservationReview(supplied)).toThrow("cannot be supplied");
    expect(() => context.isReservationReviewCurrent(undefined, supplied)).toThrow(
      "cannot be supplied",
    );
    expect(() =>
      context.prepareReservation({
        current: supplied,
        review: undefined,
        command: undefined,
        runId: randomUUID(),
        additionalUsedBytes: 0,
      }),
    ).toThrow("cannot be supplied");
  },
);
it.each([undefined, null, "plan-observation-v99"])(
  "rejects unsupported explicit version %s before pure input processing",
  (version) => {
    const f = nativeFixture();
    expect(() =>
      createVersionedProviderReservationReview(version as PlanPromptVersion, f.current),
    ).toThrow();
    expect(() =>
      isVersionedProviderReservationReviewCurrent(
        version as PlanPromptVersion,
        f.review,
        f.current,
      ),
    ).toThrow();
    expect(() => prepareVersionedProviderReservation(version as PlanPromptVersion, f)).toThrow();
  },
);
it("rejects client version selection at the store input boundary", () => {
  reopen(v2);
  const selection = { ...input().selection, engineVersion: v1 };
  expect(() => store.providerReservationReview(selection)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_RESERVATION_SELECTION_INVALID",
    }),
  );
});

it("backs up selected record2/v1 reservation and restores its exact bytes without current evidence", async () => {
  reopen(v1);
  adopt();
  const f = reservationStoreFixture(store);
  const original = store.providerReserve(f.command, f.review);
  const before = rows(),
    audit = inspectQualityDatabase(db);
  const backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  writeFileSync(join(restored, "studio.sqlite"), sentinel);
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({
    version: 9,
    providerPolicies: 1,
    actualRuns: 1,
  });
  restoreQualityData(backup, restored);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("No evidence");
  });
  const reopened = new PlanQualityStore(restored);
  const connection = new DatabaseSync(join(restored, "quality-evaluation", "quality.sqlite"));
  try {
    expect(inspectQualityDatabase(connection)).toEqual(audit);
    expect(connection.prepare("SELECT * FROM quality_actual_runs ORDER BY id").all()).toEqual(
      before.runs,
    );
    expect(
      connection
        .prepare("SELECT * FROM quality_actual_budget_events ORDER BY scope_id,revision")
        .all(),
    ).toEqual(before.budget);
    expect(
      connection
        .prepare("SELECT * FROM quality_provider_reservation_bindings ORDER BY run_id")
        .all(),
    ).toEqual(before.bindings);
    expect(
      connection.prepare("SELECT * FROM quality_provider_policies ORDER BY revision").all(),
    ).toEqual(before.policies);
    expect(reopened.providerReserve(f.command, undefined)).toEqual({
      ...original,
      replayed: true,
      newlyCommitted: false,
    });
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
  } finally {
    connection.close();
    reopened.close();
  }
}, 30000);

it("recovers v2 nonce after reopen, changed server selection and expiry without another reservation", () => {
  reopen(v2);
  adopt();
  const f = reservationStoreFixture(store);
  const original = store.providerReserve(f.command, f.review);
  const before = rows(),
    snapshot = JSON.stringify(store.providerArchiveGet(original.record.runId));
  reopen(v1);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("No fresh evidence");
  });
  expect(store.providerReserve(f.command, undefined)).toEqual({
    ...original,
    replayed: true,
    newlyCommitted: false,
  });
  expect(store.providerReservationLookup(f.command.clientRequestId)).toEqual({
    state: "committed",
    record: original.record,
  });
  expect(JSON.stringify(store.providerArchiveGet(original.record.runId))).toBe(snapshot);
  expect(rows()).toEqual(before);
  expect(() =>
    store.providerReserve(
      { ...f.command, approval: { ...f.command.approval, approvedAt: "2030-01-01T00:00:00.000Z" } },
      undefined,
    ),
  ).toThrow(expect.objectContaining({ code: "QUALITY_PROVIDER_RESERVATION_NONCE_CONFLICT" }));
});
it.each([
  "quality_actual_runs",
  "quality_actual_artifacts",
  "quality_actual_budget_events",
  "quality_actual_requests",
  "quality_provider_reservation_bindings",
])("rolls back v2 all five rows after %s and reuses the original command", (table) => {
  reopen(v2);
  adopt();
  const f = reservationStoreFixture(store),
    before = rows();
  const prepare = DatabaseSync.prototype.prepare,
    failure = vi.fn();
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("INSERT INTO " + table + "(")) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => {
        run(...args);
        failure();
        throw Error("Synthetic after insert");
      });
    }
    return statement;
  });
  expect(() => store.providerReserve(f.command, f.review)).toThrow("Synthetic after insert");
  expect(failure).toHaveBeenCalledOnce();
  expect(rows()).toEqual(before);
  expect(store.providerReservationLookup(f.command.clientRequestId)).toEqual({
    state: "not-observed",
  });
  spy.mockRestore();
  expect(store.providerReserve(f.command, f.review)).toMatchObject({
    newlyCommitted: true,
    record: { recordVersion: 2 },
  });
});
it("holds the SQLite writer lock and resolves duplicate and stale v2 commands across connections", () => {
  reopen(v2);
  adopt();
  const f = reservationStoreFixture(store);
  const other = new PlanQualityStore(directory, {
    providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
  });
  const prepare = DatabaseSync.prototype.prepare;
  let checked = false;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql.startsWith("INSERT INTO quality_actual_runs(")) {
      expect(this.isTransaction).toBe(true);
      db.exec("PRAGMA busy_timeout=1");
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      checked = true;
    }
    return prepare.call(this, sql);
  });
  try {
    const original = store.providerReserve(f.command, f.review);
    expect(checked).toBe(true);
    spy.mockRestore();
    const before = rows();
    expect(other.providerReserve(f.command, undefined)).toEqual({
      ...original,
      newlyCommitted: false,
      replayed: true,
    });
    expect(() =>
      other.providerReserve({ ...f.command, clientRequestId: randomUUID() }, f.review),
    ).toThrow(expect.objectContaining({ code: "QUALITY_PROVIDER_RESERVATION_REVIEW_NOT_CURRENT" }));
    expect(rows()).toEqual(before);
  } finally {
    spy.mockRestore();
    other.close();
  }
});
it.each(["binding-format", "request", "budget"] as const)(
  "rejects persisted v2 corruption before nonce recovery: %s",
  (kind) => {
    reopen(v2);
    adopt();
    const f = reservationStoreFixture(store),
      original = store.providerReserve(f.command, f.review);
    const table =
      kind === "binding-format"
        ? "quality_provider_reservation_bindings"
        : kind === "request"
          ? "quality_actual_runs"
          : "quality_actual_budget_events";
    const trigger = table + "_no_update";
    const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(trigger)!.sql);
    const row = db
      .prepare("SELECT rowid AS row_id,body FROM " + table + " ORDER BY rowid DESC LIMIT 1")
      .get()!;
    const value = JSON.parse(String(row.body));
    if (kind === "binding-format") {
      value.recordVersion = 1;
      const { recordDigest: _old, ...body } = value;
      void _old;
      value.recordDigest = digest(body);
    }
    if (kind === "request") {
      value.preparation.generation.body.store = true;
      const { runDigest: _old, ...body } = value;
      void _old;
      value.runDigest = digest(body);
    }
    if (kind === "budget") value.payload.generationUnits = "0";
    db.exec("DROP TRIGGER " + trigger);
    db.prepare("UPDATE " + table + " SET body=?,body_hash=? WHERE rowid=?").run(
      JSON.stringify(value),
      digest(value),
      row.row_id,
    );
    db.exec(sql);
    const before = rows();
    expect(() => store.providerReservationLookup(f.command.clientRequestId)).toThrow(
      expect.objectContaining({ code: "QUALITY_ACTUAL_STORAGE_CORRUPT" }),
    );
    expect(() => store.providerReserve(f.command, undefined)).toThrow();
    expect(() => store.providerArchiveGet(original.record.runId)).toThrow();
    expect(() => inspectQualityDatabase(db)).toThrow();
    expect(rows()).toEqual(before);
  },
);
it("backs up mixed v1/v2 reservations with one budget and restores original export and nonce bytes", async () => {
  // Two synthetic reservations need a larger initial test cap; never reset an existing budget.
  const config = structuredClone(readFixedProviderConfiguration()!);
  config.proposedBudget.capUnits = "100000000";
  config.proposedBudget.basis =
    "격리 혼합 백업 시험 전용 초기 누적 USD 100. 실제 운영 승인 또는 기존 예산 변경이 아니다.";
  config.configurationDigest = digest(providerConfigurationDigestInput(config));
  vi.mocked(configuration.getProviderConfigurationProposal).mockReturnValue(config);
  adopt(true);
  const oldInput = reservationStoreFixture(store),
    old = store.providerReserve(oldInput.command, oldInput.review);
  const oldExport = store.providerDownload(old.record.runId, 0).body,
    oldRows = rows();
  reopen(v2, config);
  adopt(false, 1);
  const f = reservationStoreFixture(store, 1);
  expect(f.review.assessment).toEqual({ state: "conditions-met", blockers: [] });
  const current = store.providerReserve(f.command, f.review);
  const before = rows(),
    audit = inspectQualityDatabase(db);
  const exported = store.providerDownload(current.record.runId, 0),
    payload = JSON.parse(exported.body);
  expect(payload).toMatchObject({
    archiveFormatVersion: 4,
    kind: "provider-reservation-archive",
    run: { archiveFormatVersion: 3 },
  });
  expect(payload.run).toEqual(store.providerArchiveGet(current.record.runId).run);
  expect(store.providerDownload(old.record.runId, 0).body).toBe(oldExport);
  expect(before.budget[0]).toEqual(oldRows.budget[0]);
  expect(before.runs.find((row) => row.id === old.record.runId)).toEqual(oldRows.runs[0]);
  expect(getReview().runs.unsettledCandidateRunIds).toEqual([old.record.runId]);
  const backup = join(root, "mixed-backup"),
    restored = join(root, "mixed-restored");
  mkdirSync(restored);
  writeFileSync(join(restored, "studio.sqlite"), sentinel);
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({
    version: 9,
    actualRuns: 2,
    providerPolicies: 2,
  });
  restoreQualityData(backup, restored);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("No fresh evidence");
  });
  const reopened = new PlanQualityStore(restored),
    connection = new DatabaseSync(join(restored, "quality-evaluation", "quality.sqlite"));
  try {
    expect(inspectQualityDatabase(connection)).toEqual(audit);
    for (const [table, key, order] of [
      ["quality_actual_runs", "runs", "id"],
      ["quality_actual_budget_events", "budget", "scope_id,revision"],
      ["quality_actual_requests", "receipts", "nonce"],
      ["quality_provider_reservation_bindings", "bindings", "run_id"],
    ] as const)
      expect(connection.prepare("SELECT * FROM " + table + " ORDER BY " + order).all()).toEqual(
        before[key],
      );
    expect(reopened.providerDownload(old.record.runId, 0).body).toBe(oldExport);
    expect(reopened.providerDownload(current.record.runId, 0).body).toBe(exported.body);
    expect(reopened.providerReserve(f.command, undefined)).toEqual({
      ...current,
      newlyCommitted: false,
      replayed: true,
    });
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
  } finally {
    connection.close();
    reopened.close();
  }
}, 30000);

it("refuses grandfathering format3 runs into either immutable migration boundary", () => {
  reopen(v2);
  adopt();
  const f = reservationStoreFixture(store);
  const saved = store.providerReserve(f.command, f.review);
  const ledger = input().ledger,
    originalRows = rows();
  const decoded = readProviderReservationDatabaseRows(db);
  const archive = { ledger, coverage: decoded.coverage, records: decoded.records };
  expect(() => inspectVersionedProviderReservationArchive(archive)).not.toThrow();
  expect(() => createProviderReservationMigrationCoverage(ledger)).toThrow();
  expect(() => createProviderTransmissionApprovalMigrationCoverage(archive)).toThrow();
  const run = store.providerArchiveGet(saved.record.runId).run;
  const forged = {
    ...decoded.coverage,
    cutoverGlobalRunCount: 1,
    cutoverRunPrefixDigest: digest([
      { id: run.id, schemaVersion: run.schemaVersion, runDigest: run.runDigest },
    ]),
    legacyProductionRuns: [{ runId: run.id, runDigest: run.runDigest }],
  };
  const { coverageDigest: _old, ...body } = forged;
  void _old;
  forged.coverageDigest = digest(body);
  expect(() =>
    inspectVersionedProviderReservationArchive({ ledger, coverage: forged, records: [] }),
  ).toThrow();
  expect(rows()).toEqual(originalRows);
});
