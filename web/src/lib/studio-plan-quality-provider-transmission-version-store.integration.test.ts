/** Synthetic temporary SQLite only. No paid calls or customer data. */
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
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  backupQualityData,
  restoreQualityData,
  verifyQualityBackup,
  inspectQualityDatabase,
} from "../../scripts/local-data-quality.mjs";
import { qualityProviderTransmissionApprovalRoute } from "./studio-plan-quality-provider-transmission-approval-service";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  store: null as PlanQualityStore | null,
  forbidden: vi.fn(() => {
    throw Error("External access forbidden");
  }),
}));
vi.mock("./studio-plan-quality-store", async (original) => ({
  ...(await original<typeof import("./studio-plan-quality-store")>()),
  getPlanQualityStore: () => state.store!,
}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      state.forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({
  getStudioStore: state.forbidden,
  StudioStore: state.forbidden,
}));
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
  state.store = store;
}
beforeEach(() => {
  state.forbidden.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", state.forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(
    readFixedProviderConfiguration,
  );
  root = mkdtempSync(join(tmpdir(), "venture-transmission-version-"));
  directory = join(root, "source");
  mkdirSync(directory);
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory);
  state.store = store;
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
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe(sentinel);
  db.close();
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith("venture-transmission-version-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function adopt(legacy = false, index = 0) {
  if (legacy) {
    const f = policyAdoptionFixture(store, index);
    return store.providerPolicyAdopt(f.command, f.review);
  }
  const registry = store.candidateRegistryGet(1),
    candidateId = registry.entries[index].candidateId;
  const { result, expectedPolicyHead } = store.providerPolicyReview(1, candidateId);
  if (result.status !== "review") throw Error(result.reason);
  const review = result.review;
  return store.providerPolicyAdopt(
    providerPolicyAdoptionCommandSchema.parse({
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
    }),
    review,
  );
}
function ready(index = 0, legacy = false) {
  adopt(legacy, index);
  const f = reservationStoreFixture(store, index);
  const saved = store.providerReserve(f.command, f.review);
  return transmissionStoreFixture(store, saved.record);
}
function rows(connection = db) {
  return connection
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'quality_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [
      name,
      connection.prepare("SELECT rowid,* FROM " + name + " ORDER BY rowid").all(),
    ]);
}
function tamper(table: string, action: "update" | "delete", work: () => void) {
  const name = table + "_no_" + action;
  const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql);
  db.exec("DROP TRIGGER " + name);
  work();
  db.exec(sql);
}
it("commits selected v2 approval without a dispatch, new budget event or fresh default selection", () => {
  reopen(v2);
  const f = ready(),
    budget = store.providerBudgetGet("production");
  vi.mocked(configuration.getProviderConfigurationProposal).mockImplementation(() => {
    throw Error("No default selection");
  });
  const result = store.providerApproveTransmission(f.command, f.review);
  expect(result).toMatchObject({
    newlyCommitted: true,
    replayed: false,
    dispatchAllowed: false,
    record: { recordVersion: 2, command: f.command, approvedReview: f.review },
  });
  const snapshot = store.providerArchiveGet(f.command.runId);
  expect(snapshot).toMatchObject({
    archiveFormatVersion: 5,
    revision: 1,
    state: "approved",
    dispatchIntentCount: 0,
    responseCount: 0,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(store.providerBudgetGet("production")).toEqual(budget);
  expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_events").get()!.n).toBe(1);
  expect(() => store.providerGet(f.command.runId)).toThrow(
    expect.objectContaining({ code: "PROVIDER_NATIVE_VERSION_UNSUPPORTED" }),
  );
  expect(inspectQualityDatabase(db)).toMatchObject({
    actualEvents: 1,
    providerTransmissionBindings: 1,
  });
}, 20000);
it("recovers exact v2 nonce before changed selection, expiry, current clock or configuration", () => {
  reopen(v2);
  const f = ready(),
    first = store.providerApproveTransmission(f.command, f.review);
  reopen(v1);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const before = rows(),
    getter = vi.mocked(configuration.getProviderConfigurationProposal);
  getter.mockImplementation(() => {
    throw Error("No current evidence");
  });
  const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
    throw Error("No current clock");
  });
  expect(store.providerApproveTransmission(f.command, null)).toEqual({
    ...first,
    replayed: true,
    newlyCommitted: false,
  });
  expect(store.providerTransmissionApprovalLookup(f.command.clientRequestId)).toMatchObject({
    state: "committed",
    record: first.record,
  });
  expect(clock).not.toHaveBeenCalled();
  expect(() =>
    store.providerApproveTransmission(
      { ...f.command, expectedArchiveDigest: "a".repeat(64) },
      null,
    ),
  ).toThrow(expect.objectContaining({ code: "QUALITY_PROVIDER_TRANSMISSION_NONCE_CONFLICT" }));
  expect(rows()).toEqual(before);
}, 20000);
it.each([
  "quality_actual_events",
  "quality_actual_requests",
  "quality_provider_transmission_bindings",
])(
  "rolls back all v2 approval rows on interruption after %s",
  (table) => {
    reopen(v2);
    const f = ready(),
      before = rows(),
      prepare = DatabaseSync.prototype.prepare,
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
          throw Error("Synthetic interrupted insert");
        });
      }
      return statement;
    });
    expect(() => store.providerApproveTransmission(f.command, f.review)).toThrow(
      "Synthetic interrupted insert",
    );
    expect(failure).toHaveBeenCalledOnce();
    expect(rows()).toEqual(before);
    expect(store.providerTransmissionApprovalLookup(f.command.clientRequestId)).toEqual({
      state: "not-observed",
    });
    spy.mockRestore();
    expect(store.providerApproveTransmission(f.command, f.review)).toMatchObject({
      newlyCommitted: true,
      record: { recordVersion: 2 },
    });
  },
  20000,
);
it("holds one writer transaction and resolves duplicate and stale approvals across connections", () => {
  reopen(v2);
  const f = ready(),
    other = new PlanQualityStore(directory, {
      providerPolicySelection: { version: v2, configuration: readFixedProviderConfiguration()! },
    });
  const prepare = DatabaseSync.prototype.prepare;
  let checked = false;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql.startsWith("INSERT INTO quality_actual_events(")) {
      expect(this.isTransaction).toBe(true);
      db.exec("PRAGMA busy_timeout=1");
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      checked = true;
    }
    return prepare.call(this, sql);
  });
  try {
    const first = store.providerApproveTransmission(f.command, f.review);
    expect(checked).toBe(true);
    spy.mockRestore();
    const before = rows();
    expect(other.providerApproveTransmission(f.command, null)).toEqual({
      ...first,
      newlyCommitted: false,
      replayed: true,
    });
    expect(() =>
      other.providerApproveTransmission({ ...f.command, clientRequestId: randomUUID() }, f.review),
    ).toThrow(
      expect.objectContaining({ code: "QUALITY_PROVIDER_TRANSMISSION_REVIEW_NOT_CURRENT" }),
    );
    expect(rows()).toEqual(before);
  } finally {
    spy.mockRestore();
    other.close();
  }
}, 20000);
it.each(["selection", "expiry", "review", "token", "command-version"])(
  "rejects new v2 approval after %s changes without writing",
  (kind) => {
    reopen(v2);
    const f = ready(),
      before = rows();
    if (kind === "selection") reopen(v1);
    if (kind === "expiry") vi.setSystemTime(f.review.expiresAt);
    let review: unknown = f.review,
      command: unknown = f.command;
    if (kind === "review") {
      const copy = structuredClone(f.review);
      Object.assign(copy.manifest.executionContract, { engineVersion: v1 });
      const { reviewDigest: omitted, ...body } = copy;
      void omitted;
      copy.reviewDigest = digest(body);
      f.command.approvedReviewDigest = copy.reviewDigest;
      review = copy;
    }
    if (kind === "token") review = { ...f.review, tokenEvidence: { contextFitVerified: true } };
    if (kind === "command-version") command = { ...f.command, engineVersion: v2 };
    expect(() => store.providerApproveTransmission(command, review)).toThrow();
    expect(rows()).toEqual(before);
  },
  15000,
);
it.each(["missing-binding", "record-version", "event-version", "unrelated-registration"])(
  "refuses %s corruption on read, replay and backup audit",
  async (kind) => {
    reopen(v2);
    const f = ready();
    store.providerApproveTransmission(f.command, f.review);
    if (kind === "missing-binding")
      tamper("quality_provider_transmission_bindings", "delete", () =>
        db.exec("DELETE FROM quality_provider_transmission_bindings"),
      );
    if (kind === "record-version")
      tamper("quality_provider_transmission_bindings", "update", () => {
        const row = db.prepare("SELECT body FROM quality_provider_transmission_bindings").get()!;
        const value = JSON.parse(String(row.body));
        value.recordVersion = 1;
        const { recordDigest: omitted, ...body } = value;
        void omitted;
        value.recordDigest = digest(body);
        db.prepare("UPDATE quality_provider_transmission_bindings SET body=?,body_hash=?").run(
          JSON.stringify(value),
          digest(value),
        );
      });
    if (kind === "event-version")
      tamper("quality_actual_events", "update", () => {
        const value = JSON.parse(
          String(db.prepare("SELECT body FROM quality_actual_events").get()!.body),
        );
        value.executionContractVersion = 1;
        const { eventDigest: omitted, ...body } = value;
        void omitted;
        value.eventDigest = digest(body);
        db.prepare("UPDATE quality_actual_events SET body=?,body_hash=?").run(
          JSON.stringify(value),
          digest(value),
        );
      });
    if (kind === "unrelated-registration")
      tamper("quality_candidate_versions", "update", () =>
        db.prepare("UPDATE quality_candidate_versions SET body_hash=?").run("a".repeat(64)),
      );
    const before = rows();
    expect(() => store.providerTransmissionApprovalLookup(f.command.clientRequestId)).toThrow();
    expect(() => store.providerApproveTransmission(f.command, null)).toThrow();
    expect(() => inspectQualityDatabase(db)).toThrow();
    await expect(backupQualityData(directory, join(root, "corrupt-backup"))).rejects.toThrow();
    expect(rows()).toEqual(before);
  },
  20000,
);
it("returns stored v2 lookup/replay receipts over existing HTTP without accepting a new client v2 review", async () => {
  reopen(v2);
  const f = ready();
  const base = "http://127.0.0.1:3000/api/studio/quality/provider-transmission";
  const post = (review: unknown) =>
    new Request(base + "/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ command: f.command, approvedReview: review }),
    });
  const before = rows();
  expect((await qualityProviderTransmissionApprovalRoute(post(f.review), "approve")).status).toBe(
    400,
  );
  expect(rows()).toEqual(before);
  const first = store.providerApproveTransmission(f.command, f.review);
  reopen();
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const saved = rows();
  const lookup = await qualityProviderTransmissionApprovalRoute(
    new Request(base + "/requests/" + f.command.clientRequestId),
    "lookup",
    { clientRequestId: f.command.clientRequestId },
  );
  const replay = await qualityProviderTransmissionApprovalRoute(post(null), "approve");
  for (const response of [lookup, replay]) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      responseVersion: 1,
      state: "committed",
      receipt: {
        recordDigest: first.record.recordDigest,
        commandDigest: first.record.commandDigest,
        approvalEventDigest: first.record.approvalEventDigest,
        dispatchAllowed: false,
        budgetWriteAllowed: false,
      },
    });
  }
  expect(rows()).toEqual(saved);
}, 20000);
it("backs up mixed v1/v2 approvals and restores exact raw/export/nonce bytes with one cumulative budget", async () => {
  const config = structuredClone(readFixedProviderConfiguration()!);
  config.proposedBudget.capUnits = "100000000";
  config.proposedBudget.basis =
    "격리 혼합 승인 백업 시험 전용 초기 USD100. 실제 운영 승인이나 기존 예산 변경이 아니다.";
  config.configurationDigest = digest(providerConfigurationDigestInput(config));
  vi.mocked(configuration.getProviderConfigurationProposal).mockReturnValue(config);
  const old = ready(0, true),
    oldResult = store.providerApproveTransmission(old.command, old.review);
  const oldExport = store.providerDownload(old.command.runId, 1).body;
  reopen(v2, config);
  const current = ready(1),
    first = store.providerApproveTransmission(current.command, current.review);
  expect([oldResult.record.recordVersion, first.record.recordVersion]).toEqual([1, 2]);
  const before = rows(),
    budget = store.providerBudgetGet("production"),
    audit = inspectQualityDatabase(db);
  const exported = store.providerDownload(current.command.runId, 1).body;
  expect(JSON.parse(exported)).toMatchObject({
    archiveFormatVersion: 5,
    kind: "provider-execution-archive",
    run: { archiveFormatVersion: 3 },
  });
  expect(store.providerDownload(old.command.runId, 1).body).toBe(oldExport);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM quality_actual_budget_events WHERE revision=1").get()!.n,
  ).toBe(1);
  const backup = join(root, "backup"),
    restored = join(root, "restored");
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
    expect(rows(connection)).toEqual(before);
    expect(inspectQualityDatabase(connection)).toEqual(audit);
    expect(reopened.providerBudgetGet("production")).toEqual(budget);
    expect(reopened.providerDownload(old.command.runId, 1).body).toBe(oldExport);
    expect(reopened.providerDownload(current.command.runId, 1).body).toBe(exported);
    for (const [f, saved] of [
      [old, oldResult],
      [current, first],
    ] as const)
      expect(reopened.providerApproveTransmission(f.command, null)).toEqual({
        ...saved,
        newlyCommitted: false,
        replayed: true,
      });
    expect(rows(connection)).toEqual(before);
    expect(readFileSync(join(restored, "studio.sqlite"), "utf8")).toBe(sentinel);
  } finally {
    connection.close();
    reopened.close();
  }
}, 40000);
