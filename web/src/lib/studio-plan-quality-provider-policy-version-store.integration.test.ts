import {
  reserveTransmissionTestRun,
  transmissionStoreFixture,
} from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import * as storeModule from "./studio-plan-quality-store";
import { qualityProviderPolicyRoute } from "./studio-plan-quality-provider-policy-service";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
/** Real SQLite transactions with synthetic approvals/data only. No provider or customer access. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  policyAdoptionFixture,
  seedPolicyTestBudget,
} from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import {
  compareVersionedProviderPolicyAdoptionRetry,
  compareProviderPolicyAdoptionRetry,
} from "./studio-plan-quality-provider-policy-adoption";
import {
  backupQualityData,
  restoreQualityData,
  verifyQualityBackup,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import {
  adoptReservationTestPolicy,
  reservationStoreFixture,
} from "./studio-plan-quality-provider-reservation-store-test-helpers";

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
const sentinel = "SYNTHETIC COMPANY BYTES PRESERVED";
const selection = (version: PlanPromptVersion = "plan-observation-v2") => ({
  version,
  configuration: readFixedProviderConfiguration()!,
});
function open(version: PlanPromptVersion = "plan-observation-v2") {
  return new PlanQualityStore(directory, { providerPolicySelection: selection(version) });
}
beforeEach(() => {
  forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-policy-version-store-"));
  directory = join(root, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = open();
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
  if (!rel.startsWith("venture-policy-version-store-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const snapshot = () => inspectQualityDatabase(db);
const policyRows = () =>
  db.prepare("SELECT * FROM quality_provider_policies ORDER BY revision").all();
const budgetRows = () =>
  db.prepare("SELECT * FROM quality_actual_budget_events ORDER BY rowid").all();
function fixture(target = store, index = 0) {
  const registry = target.candidateRegistryGet(1);
  const candidateId = registry.entries[index].candidateId;
  const { result, expectedPolicyHead } = target.providerPolicyReview(1, candidateId);
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
  return { command, review };
}
it("commits selected v2 policy and budget atomically without enabling reservation or execution", () => {
  const f = fixture(),
    committed = store.providerPolicyAdopt(f.command, f.review);
  expect(committed).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    record: {
      recordVersion: 2,
      reviewedProposal: {
        viewVersion: 4,
        proposal: {
          requestReview: {
            contract: { baseContract: { engineVersion: "plan-observation-v2" } },
          },
        },
      },
      reservationAllowed: false,
      dispatchAllowed: false,
    },
  });
  expect(snapshot()).toMatchObject({
    providerPolicies: 1,
    actualBudgetEvents: 1,
    actualRequests: 1,
    actualRuns: 0,
  });
  expect(JSON.stringify(JSON.parse(String(policyRows()[0].body)))).toBe(
    JSON.stringify(committed.record),
  );
  const reservation = store.providerReservationReview({
    version: 1,
    versionDigest: f.command.versionDigest,
    candidateId: f.command.candidateId,
  });
  expect(reservation).toMatchObject({
    status: "review",
    review: {
      policy: { state: "matched" },
      actions: { reservationAllowed: false, dispatchAllowed: false },
    },
  });
  expect(store.providerPolicyLookup(f.command.clientRequestId)).toEqual({
    state: "committed",
    record: committed.record,
  });
});
it("extends an old v1 policy with v2 while preserving original bytes and one cumulative budget", () => {
  store.close();
  store = new PlanQualityStore(directory);
  const old = policyAdoptionFixture(store);
  const original = store.providerPolicyAdopt(old.command, old.review);
  const bytes = policyRows()[0],
    budget = budgetRows();
  store.close();
  store = open();
  const next = fixture(),
    committed = store.providerPolicyAdopt(next.command, next.review);
  expect(committed.record.previousDigest).toBe(original.record.recordDigest);
  expect(committed.record.budgetTransition.before).toEqual(committed.record.budgetTransition.after);
  expect(policyRows()[0]).toEqual(bytes);
  expect(budgetRows()).toEqual(budget);
  expect(snapshot()).toMatchObject({
    providerPolicies: 2,
    actualBudgetEvents: 1,
    actualRequests: 1,
  });
  // A committed old nonce is archived evidence, not a new v2 request.
  expect(store.providerPolicyAdopt(old.command, undefined).record).toEqual(original.record);
});
it("recovers a committed response after reopen, later policy, expiry and unavailable current configuration", () => {
  const first = fixture(),
    committed = store.providerPolicyAdopt(first.command, first.review);
  const second = fixture(store, 1);
  store.providerPolicyAdopt(second.command, second.review);
  const before = snapshot(),
    rows = policyRows();
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const getter = vi
    .mocked(configuration.getProviderConfigurationProposal)
    .mockImplementation(() => {
      throw Error("No configuration");
    });
  getter.mockClear();
  expect(store.providerPolicyAdopt(first.command, undefined)).toEqual({
    ...committed,
    newlyCommitted: false,
    replayed: true,
  });
  expect(store.providerPolicyLookup(first.command.clientRequestId)).toEqual({
    state: "committed",
    record: committed.record,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(compareVersionedProviderPolicyAdoptionRetry(first.command, committed.record)).toBe(
    "same-request",
  );
  expect(compareProviderPolicyAdoptionRetry(first.command, committed.record)).toBe(
    "invalid-record",
  );
  expect(snapshot()).toEqual(before);
  expect(policyRows()).toEqual(rows);
  expect(() =>
    store.providerPolicyAdopt(
      {
        ...first.command,
        approval: { ...first.command.approval, approvedAt: new Date().toISOString() },
      },
      undefined,
    ),
  ).toThrowError(expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_NONCE_CONFLICT" }));
});
it.each(["quality_provider_policies", "quality_actual_budget_events", "quality_actual_requests"])(
  "rolls back every row after failure following %s insertion",
  (table) => {
    const f = fixture(),
      before = snapshot();
    const prepare = DatabaseSync.prototype.prepare;
    const failure = vi.fn();
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("INSERT INTO " + table + "(")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementation((...args) => {
          run(...args);
          failure();
          throw Error("Injected after row");
        });
      }
      return statement;
    });
    expect(() => store.providerPolicyAdopt(f.command, f.review)).toThrow("Injected after row");
    expect(failure).toHaveBeenCalledOnce();
    expect(snapshot()).toEqual(before);
    expect(store.providerPolicyLookup(f.command.clientRequestId)).toEqual({
      state: "not-observed",
    });
  },
);
it("rejects stale CAS across independent connections and audits inside the write transaction", () => {
  const first = fixture(),
    other = open();
  try {
    const stale = fixture(other, 1);
    store.providerPolicyAdopt(first.command, first.review);
    const before = snapshot();
    expect(() => other.providerPolicyAdopt(stale.command, stale.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_POLICY_HEAD_CHANGED" }),
    );
    expect(snapshot()).toEqual(before);
    const fresh = fixture(other, 1);
    const prepare = DatabaseSync.prototype.prepare;
    let checked = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql.startsWith("INSERT INTO quality_provider_policies(")) {
        expect(this.isTransaction).toBe(true);
        db.exec("PRAGMA busy_timeout=1");
        expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
        checked = true;
      }
      return prepare.call(this, sql);
    });
    other.providerPolicyAdopt(fresh.command, fresh.review);
    expect(checked).toBe(true);
  } finally {
    other.close();
  }
});
it.each(["clientRequestId", "initialBudgetRequestId"] as const)(
  "rejects cross-ledger %s reuse",
  (key) => {
    const f = fixture(),
      before = snapshot();
    f.command[key] = store.candidateRegistryGet(1).clientRequestId;
    expect(() => store.providerPolicyAdopt(f.command, f.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_NONCE_CONFLICT" }),
    );
    expect(snapshot()).toEqual(before);
  },
);
it.each(["v1-to-v2", "v2-to-v1"] as const)("rejects fresh %s approval before any write", (kind) => {
  const one = open("plan-observation-v1");
  try {
    const f = kind === "v1-to-v2" ? fixture(one) : fixture();
    const target = kind === "v1-to-v2" ? store : one;
    const before = snapshot();
    expect(() => target.providerPolicyAdopt(f.command, f.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_REVIEW_NOT_CURRENT" }),
    );
    expect(snapshot()).toEqual(before);
  } finally {
    one.close();
  }
});
it("keeps the default writer v1 and rejects a fresh v2 review or client-selected command fields", () => {
  const f = fixture(),
    before = snapshot(),
    legacy = new PlanQualityStore(directory);
  try {
    expect(() => legacy.providerPolicyAdopt(f.command, f.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_REVIEW_NOT_CURRENT" }),
    );
    expect(() => legacy.providerPolicyReview(1, f.command.candidateId)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_SELECTION_REQUIRED" }),
    );
    expect(() =>
      store.providerPolicyAdopt({ ...f.command, engineVersion: "plan-observation-v1" }, f.review),
    ).toThrow();
    expect(snapshot()).toEqual(before);
  } finally {
    legacy.close();
  }
});
it("snapshots server selection before opening the store and rejects missing/unknown versions before creating files", () => {
  store.close();
  const supplied = selection();
  store = new PlanQualityStore(directory, { providerPolicySelection: supplied });
  const before = fixture().review.bindings;
  supplied.version = "plan-observation-v1";
  supplied.configuration.proposedBudget.capUnits = "1";
  expect(fixture().review.bindings).toEqual(before);
  for (const value of ["future", null, undefined]) {
    const target = join(root, "invalid-" + String(value));
    expect(
      () =>
        new PlanQualityStore(target, {
          providerPolicySelection: {
            version: value as PlanPromptVersion,
            configuration: readFixedProviderConfiguration(),
          },
        }),
    ).toThrow();
    expect(existsSync(target)).toBe(false);
  }
});
it.each(["expired", "changed-budget", "storage-limit"] as const)(
  "rejects %s without partial policy initialization",
  (kind) => {
    const f = fixture();
    if (kind === "changed-budget") seedPolicyTestBudget(db);
    const before = snapshot(),
      original = planQualityStoreLimits.totalBytes;
    try {
      if (kind === "expired") vi.setSystemTime(f.review.expiresAt);
      if (kind === "storage-limit") Object.assign(planQualityStoreLimits, { totalBytes: 1 });
      expect(() => store.providerPolicyAdopt(f.command, f.review)).toThrow();
    } finally {
      Object.assign(planQualityStoreLimits, { totalBytes: original });
    }
    expect(snapshot()).toEqual(before);
  },
);
it("preserves an existing v1 reservation and held amount when a later v2 policy supersedes it", () => {
  store.close();
  store = new PlanQualityStore(directory);
  adoptReservationTestPolicy(store);
  const f = reservationStoreFixture(store),
    reserved = store.providerReserve(f.command, f.review);
  const budget = budgetRows(),
    before = snapshot();
  store.close();
  store = open();
  const next = fixture();
  store.providerPolicyAdopt(next.command, next.review);
  expect(budgetRows()).toEqual(budget);
  expect(snapshot()).toMatchObject({
    actualRuns: before.actualRuns,
    actualBudgetEvents: before.actualBudgetEvents,
  });
  expect(store.providerReservationLookup(f.command.clientRequestId)).toEqual({
    state: "committed",
    record: reserved.record,
  });
  expect(store.providerReserve(f.command, undefined)).toMatchObject({
    replayed: true,
    newlyCommitted: false,
  });
});
it("refuses unrelated corruption on head, lookup, replay and cold backup", async () => {
  const f = fixture();
  store.providerPolicyAdopt(f.command, f.review);
  store.create({
    clientRequestId: randomUUID(),
    title: "Synthetic audit",
    manifestDigest: store.list().manifestDigest,
  });
  const trigger = String(
    db.prepare("SELECT sql FROM sqlite_schema WHERE name='quality_runs_no_update'").get()!.sql,
  );
  db.exec("DROP TRIGGER quality_runs_no_update");
  db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64));
  db.exec(trigger);
  for (const action of [
    () => store.providerPolicyHead(),
    () => store.providerPolicyLookup(f.command.clientRequestId),
    () => store.providerPolicyAdopt(f.command, undefined),
    () => store.providerPolicyReview(1, f.command.candidateId),
  ])
    expect(action).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_STORAGE_CORRUPT" }),
    );
  await expect(backupQualityData(directory, join(root, "bad-backup"))).rejects.toThrow();
});
it("backs up mixed stored versions, verifies in cold Node and restores original bytes after evidence expiry", async () => {
  store.close();
  store = new PlanQualityStore(directory);
  const old = policyAdoptionFixture(store);
  store.providerPolicyAdopt(old.command, old.review);
  store.close();
  store = open();
  const f = fixture(),
    committed = store.providerPolicyAdopt(f.command, f.review);
  const before = snapshot(),
    bytes = policyRows(),
    budgets = budgetRows();
  const backup = join(root, "backup"),
    restored = join(root, "restored");
  mkdirSync(restored);
  writeFileSync(join(restored, "studio.sqlite"), sentinel);
  await backupQualityData(directory, backup);
  expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 9, providerPolicies: 2 });
  const forbiddenRoot = join(root, "forbidden");
  const child = spawnSync(
    process.execPath,
    [resolve("scripts/local-data.mjs"), "quality-verify", "--source", backup],
    {
      windowsHide: true,
      timeout: 60000,
      encoding: "utf8",
      maxBuffer: 4096,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        VENTURE_DATA_DIR: forbiddenRoot,
        OPENAI_API_KEY: sentinel,
      },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(child.stdout + child.stderr).not.toContain(sentinel);
  expect(existsSync(forbiddenRoot)).toBe(false);
  expect(JSON.parse(child.stdout)).toMatchObject({
    ok: true,
    providerPolicies: 2,
    companyDataChanged: false,
  });
  expect(restoreQualityData(backup, restored)).toMatchObject({ providerPolicies: 2 });
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const reopened = new PlanQualityStore(restored);
  const connection = new DatabaseSync(join(restored, "quality-evaluation", "quality.sqlite"));
  try {
    expect(inspectQualityDatabase(connection)).toEqual(before);
    expect(
      connection.prepare("SELECT * FROM quality_provider_policies ORDER BY revision").all(),
    ).toEqual(bytes);
    expect(
      connection.prepare("SELECT * FROM quality_actual_budget_events ORDER BY rowid").all(),
    ).toEqual(budgets);
    expect(reopened.providerPolicyAdopt(f.command, undefined).record).toEqual(committed.record);
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
  } finally {
    connection.close();
    reopened.close();
  }
  expect(snapshot()).toEqual(before);
}, 30000);

const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

it.each(["unknown-record-version", "rehashed-request"] as const)(
  "rejects %s in persisted new policy on every audited read and backup",
  async (kind) => {
    const f = fixture();
    store.providerPolicyAdopt(f.command, f.review);
    const row = policyRows()[0],
      body = JSON.parse(String(row.body));
    if (kind === "unknown-record-version") body.recordVersion = 999;
    else {
      const request = body.reviewedProposal.proposal.requestReview;
      request.generation.body.tools = [{ type: "web_search" }];
      request.generation.requestDigest = providerWireDigest(request.generation.body);
      request.generation.sha256 = providerRawDigest(JSON.stringify(request.generation.body));
      body.reviewedProposal.viewDigest = digest(omit(body.reviewedProposal, "viewDigest"));
      body.approvedReview.bindings.requestReviewDigest = digest(request);
      body.approvedReview.reviewDigest = digest(omit(body.approvedReview, "reviewDigest"));
      body.command.approvedReviewDigest = body.approvedReview.reviewDigest;
      body.requestDigest = digest(body.command);
    }
    body.recordDigest = digest(omit(body, "recordDigest"));
    const trigger = String(
      db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_provider_policies_no_update'")
        .get()!.sql,
    );
    db.exec("DROP TRIGGER quality_provider_policies_no_update");
    db.prepare("UPDATE quality_provider_policies SET body=?,body_hash=?").run(
      JSON.stringify(body),
      digest(body),
    );
    db.exec(trigger);
    for (const action of [
      () => store.providerPolicyHead(),
      () => store.providerPolicyLookup(f.command.clientRequestId),
      () => store.providerPolicyAdopt(f.command, undefined),
    ])
      expect(action).toThrowError(
        expect.objectContaining({ code: "QUALITY_ACTUAL_STORAGE_CORRUPT" }),
      );
    await expect(
      backupQualityData(directory, join(root, "corrupt-version-backup")),
    ).rejects.toThrow();
  },
);

it("returns the existing safe HTTP lookup receipt for a stored v2 record without granting execution", async () => {
  const f = fixture(),
    committed = store.providerPolicyAdopt(f.command, f.review);
  const before = snapshot();
  vi.spyOn(storeModule, "getPlanQualityStore").mockReturnValue(store);
  const response = await qualityProviderPolicyRoute(
    new Request(
      "http://localhost/api/studio/quality/provider-policy/requests/" + f.command.clientRequestId,
    ),
    "lookup",
    { clientRequestId: f.command.clientRequestId },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    responseVersion: 1,
    state: "committed",
    delivery: "lookup",
    receipt: {
      recordDigest: committed.record.recordDigest,
      clientRequestId: f.command.clientRequestId,
      reservationAllowed: false,
      dispatchAllowed: false,
    },
  });
  expect(body).not.toHaveProperty("record");
  expect(snapshot()).toEqual(before);
});

it("preserves a bound v1 transmission approval and its backup after a new v2 policy", async () => {
  store.close();
  store = new PlanQualityStore(directory);
  const reserved = reserveTransmissionTestRun(store);
  const f = transmissionStoreFixture(store, reserved);
  const approved = store.providerApproveTransmission(f.command, f.review);
  const before = snapshot(),
    budget = budgetRows();
  const originalBinding = db
    .prepare("SELECT * FROM quality_provider_transmission_bindings ORDER BY rowid")
    .all();
  store.close();
  store = open();
  vi.setSystemTime(new Date(Date.parse(actualTestNow) + 1000));
  const next = fixture();
  store.providerPolicyAdopt(next.command, next.review);
  expect(budgetRows()).toEqual(budget);
  expect(store.providerTransmissionApprovalLookup(f.command.clientRequestId)).toMatchObject({
    state: "committed",
    record: approved.record,
  });
  expect(store.providerApproveTransmission(f.command, undefined)).toMatchObject({
    replayed: true,
    newlyCommitted: false,
  });
  expect(snapshot()).toMatchObject({
    actualRuns: before.actualRuns,
    actualArtifacts: before.actualArtifacts,
  });
  const backup = join(root, "bound-backup"),
    restored = join(root, "bound-restored");
  mkdirSync(restored);
  writeFileSync(join(restored, "studio.sqlite"), sentinel);
  await backupQualityData(directory, backup);
  restoreQualityData(backup, restored);
  const reopened = new PlanQualityStore(restored),
    connection = new DatabaseSync(join(restored, "quality-evaluation", "quality.sqlite"));
  try {
    expect(
      connection
        .prepare("SELECT * FROM quality_provider_transmission_bindings ORDER BY rowid")
        .all(),
    ).toEqual(originalBinding);
    expect(reopened.providerTransmissionApprovalLookup(f.command.clientRequestId)).toMatchObject({
      state: "committed",
      record: approved.record,
    });
    expect(inspectQualityDatabase(connection)).toEqual(snapshot());
  } finally {
    connection.close();
    reopened.close();
  }
}, 30000);
