/** All production-shaped records below are synthetic, in isolated temporary databases. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  policyAdoptionFixture,
  seedPolicyTestBudget,
} from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerPolicyReviewDigestInput } from "./studio-plan-quality-provider-policy-review-types";
import { planQualityStoreLimits } from "./studio-plan-quality-store-types";
import {
  providerTestConfigure,
  providerTestStartInput,
} from "./studio-plan-quality-provider-test-helpers";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
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
let directory: string, store: PlanQualityStore, db: DatabaseSync;
const sentinel = "SYNTHETIC COMPANY BYTES PRESERVED";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-policy-adopt-"));
  writeFileSync(join(directory, "studio.sqlite"), sentinel);
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
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
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-policy-adopt-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const snapshot = () => inspectQualityDatabase(db);
const budgetBytes = () =>
  db.prepare("SELECT * FROM quality_actual_budget_events ORDER BY rowid").all();

it("commits a policy and initial budget atomically, then returns only audited records", () => {
  const input = policyAdoptionFixture(store);
  const adopted = store.providerPolicyAdopt(input.command, input.review);
  expect(adopted).toMatchObject({
    state: "committed",
    newlyCommitted: true,
    replayed: false,
    record: { revision: 1, reservationAllowed: false, dispatchAllowed: false },
  });
  expect(store.providerPolicyHead()).toEqual({
    revision: 1,
    headDigest: adopted.record.recordDigest,
  });
  expect(store.providerPolicyLookup(input.command.clientRequestId)).toEqual({
    state: "committed",
    record: adopted.record,
  });
  expect(store.providerPolicyLookup(randomUUID())).toEqual({ state: "not-observed" });
  expect(snapshot()).toMatchObject({
    providerPolicies: 1,
    actualBudgetEvents: 1,
    actualRequests: 1,
    actualRuns: 0,
  });
  expect(store.providerBudgetGet("production")).toMatchObject({
    capUnits: input.review.proposedBudget.capUnits,
    heldUnits: "0",
    recognizedUnits: "0",
  });
  expect(() =>
    store.providerBudgetConfigure({
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      policy: {
        environment: "production",
        provenance: "explicit-user",
        currency: "USD",
        unitScale: 6,
        capUnits: "999999999",
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "PROVIDER_EXECUTION_DISABLED" }));
});
it("keeps an existing insufficient budget and independent synthetic reservations byte-for-byte", () => {
  seedPolicyTestBudget(db);
  providerTestConfigure(store);
  const run = store.providerStart(providerTestStartInput(store));
  const before = budgetBytes();
  const held = store.providerBudgetGet();
  const archive = store.providerDownload(run.snapshot.run.id, 0).body;
  const input = policyAdoptionFixture(store);
  expect(input.review.assessment.state).toBe("budget-insufficient");
  const adopted = store.providerPolicyAdopt(input.command, input.review);
  expect(adopted.record.budgetTransition.before).toEqual(adopted.record.budgetTransition.after);
  expect(budgetBytes()).toEqual(before);
  expect(store.providerBudgetGet()).toEqual(held);
  expect(store.providerDownload(run.snapshot.run.id, 0).body).toBe(archive);
});
it("recovers the original committed result after restart, later adoption, expiry and configuration failure", () => {
  const input = policyAdoptionFixture(store);
  const first = store.providerPolicyAdopt(input.command, input.review);
  const second = policyAdoptionFixture(store, 1);
  store.providerPolicyAdopt(second.command, second.review);
  const before = snapshot();
  store.close();
  store = new PlanQualityStore(directory);
  vi.setSystemTime("2030-01-01T00:00:00.000Z");
  const current = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      throw new Error("Current configuration unavailable");
    });
  expect(store.providerPolicyLookup(input.command.clientRequestId)).toEqual({
    state: "committed",
    record: first.record,
  });
  expect(store.providerPolicyAdopt(input.command, undefined)).toEqual({
    ...first,
    newlyCommitted: false,
    replayed: true,
  });
  expect(current).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
});
it("rejects another body for a committed nonce before checking fresh approval dates", () => {
  const input = policyAdoptionFixture(store);
  store.providerPolicyAdopt(input.command, input.review);
  const before = snapshot();
  expect(() =>
    store.providerPolicyAdopt(
      {
        ...input.command,
        approval: { ...input.command.approval, approvedAt: "2030-01-01T00:00:00.000Z" },
      },
      input.review,
    ),
  ).toThrowError(expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_NONCE_CONFLICT" }));
  expect(snapshot()).toEqual(before);
});
it("rejects a stale policy head across independent open connections", () => {
  const first = policyAdoptionFixture(store),
    stale = policyAdoptionFixture(store, 1);
  const second = new PlanQualityStore(directory);
  try {
    store.providerPolicyAdopt(first.command, first.review);
    const before = snapshot();
    expect(() => second.providerPolicyAdopt(stale.command, stale.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_POLICY_HEAD_CHANGED" }),
    );
    expect(snapshot()).toEqual(before);
  } finally {
    second.close();
  }
});
it("rejects changed budget evidence even if the policy head has not changed", () => {
  const input = policyAdoptionFixture(store);
  seedPolicyTestBudget(db);
  const before = snapshot();
  expect(() => store.providerPolicyAdopt(input.command, input.review)).toThrowError(
    expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_REVIEW_NOT_CURRENT" }),
  );
  expect(snapshot()).toEqual(before);
});
it.each(["changed-configuration", "expired", "forged-review"])(
  "rechecks %s against server inputs before writing",
  (kind) => {
    const input = policyAdoptionFixture(store),
      before = snapshot();
    if (kind === "expired") vi.setSystemTime(input.review.expiresAt);
    else if (kind === "changed-configuration") {
      const proposal = configuration.getProviderConfigurationProposal();
      if (!proposal) throw new Error("Synthetic configuration missing");
      proposal.proposedBudget.capUnits = "16000000";
      proposal.configurationDigest = digest(providerConfigurationDigestInput(proposal));
      vi.spyOn(configuration, "getProviderConfigurationProposal").mockReturnValue(proposal);
    } else {
      input.review.proposedBudget.capUnits = "1";
      input.review.reviewDigest = digest(providerPolicyReviewDigestInput(input.review));
      input.command.approvedReviewDigest = input.review.reviewDigest;
    }
    expect(() => store.providerPolicyAdopt(input.command, input.review)).toThrow();
    expect(snapshot()).toEqual(before);
  },
);
it("loads current configuration only after obtaining the write lock", () => {
  const input = policyAdoptionFixture(store),
    original = configuration.getProviderConfigurationProposal;
  db.exec("PRAGMA busy_timeout=1");
  const getter = vi
    .spyOn(configuration, "getProviderConfigurationProposal")
    .mockImplementation(() => {
      expect(() => db.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      expect(db.isTransaction).toBe(false);
      return original();
    });
  store.providerPolicyAdopt(input.command, input.review);
  expect(getter).toHaveBeenCalledOnce();
});
it.each(["clientRequestId", "initialBudgetRequestId"] as const)(
  "rejects a cross-ledger collision in %s without any rows",
  (field) => {
    const input = policyAdoptionFixture(store),
      before = snapshot();
    input.command[field] = store.candidateRegistryGet(1).clientRequestId;
    expect(() => store.providerPolicyAdopt(input.command, input.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_NONCE_CONFLICT" }),
    );
    expect(snapshot()).toEqual(before);
  },
);
it.each(["quality_provider_policies", "quality_actual_budget_events", "quality_actual_requests"])(
  "rolls back all rows after an injected failure following %s insertion",
  (table) => {
    const input = policyAdoptionFixture(store),
      before = snapshot();
    const prepare = DatabaseSync.prototype.prepare;
    const failure = vi.fn();
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith(`INSERT INTO ${table}(`)) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementation((...args) => {
          run(...args);
          failure();
          throw new Error("Injected after durable row");
        });
      }
      return statement;
    });
    expect(() => store.providerPolicyAdopt(input.command, input.review)).toThrow(
      "Injected after durable row",
    );
    expect(failure).toHaveBeenCalledOnce();
    expect(snapshot()).toEqual(before);
    expect(store.providerPolicyLookup(input.command.clientRequestId)).toEqual({
      state: "not-observed",
    });
  },
);
it.each([false, true])(
  "rejects unrelated archived evaluation corruption before returning a result, replay=%s",
  (replay) => {
    const input = policyAdoptionFixture(store);
    if (replay) store.providerPolicyAdopt(input.command, input.review);
    store.create({
      clientRequestId: randomUUID(),
      title: "synthetic archival integrity",
      manifestDigest: store.list().manifestDigest,
    });
    const trigger = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_runs_no_update'")
      .get()!.sql as string;
    db.exec("DROP TRIGGER quality_runs_no_update");
    db.prepare("UPDATE quality_runs SET body_hash=?").run("a".repeat(64));
    db.exec(trigger);
    for (const read of [
      () => store.providerPolicyHead(),
      () => store.providerPolicyLookup(input.command.clientRequestId),
      () => store.providerPolicyAdopt(input.command, input.review),
    ])
      expect(read).toThrowError(
        expect.objectContaining({ code: "QUALITY_PROVIDER_POLICY_STORAGE_CORRUPT" }),
      );
  },
);
it("refuses the shared byte limit before inserting policy or budget rows", () => {
  const input = policyAdoptionFixture(store),
    before = snapshot();
  const original = planQualityStoreLimits.totalBytes;
  try {
    Object.assign(planQualityStoreLimits, { totalBytes: 1 });
    expect(() => store.providerPolicyAdopt(input.command, input.review)).toThrowError(
      expect.objectContaining({ code: "QUALITY_STORAGE_LIMIT" }),
    );
  } finally {
    Object.assign(planQualityStoreLimits, { totalBytes: original });
  }
  expect(snapshot()).toEqual(before);
});
it("leaves success and failure of caller-owned audit transactions to the caller", () => {
  expect(() => inspectQualityDatabase(db, { inTransaction: true })).toThrow(
    "QUALITY_TRANSACTION_REQUIRED",
  );
  const before = snapshot();
  db.exec("BEGIN IMMEDIATE");
  expect(inspectQualityDatabase(db, { inTransaction: true })).toEqual(before);
  expect(db.isTransaction).toBe(true);
  db.prepare("INSERT INTO quality_provider_policies VALUES(?,?,?,?,?)").run(
    "bad-scope",
    1,
    randomUUID(),
    "{}",
    "bad-hash",
  );
  expect(() => inspectQualityDatabase(db, { inTransaction: true })).toThrow();
  expect(db.isTransaction).toBe(true);
  db.exec("ROLLBACK");
  expect(snapshot()).toEqual(before);
});
