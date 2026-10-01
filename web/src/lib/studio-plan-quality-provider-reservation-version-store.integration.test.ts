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
it("matches v2 review but blocks frozen native storage instead of downgrading to v1", () => {
  reopen(v2);
  adopt();
  const f = reservationStoreFixture(store),
    before = rows();
  expect(f.review.assessment.state).toBe("conditions-met");
  expect(() => store.providerReserve(f.command, f.review)).toThrow(
    expect.objectContaining({
      code: "QUALITY_PROVIDER_RESERVATION_NATIVE_VERSION_UNSUPPORTED",
    }),
  );
  expect(rows()).toEqual(before);
  expect(store.providerReservationLookup(f.command.clientRequestId)).toEqual({
    state: "not-observed",
  });
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
