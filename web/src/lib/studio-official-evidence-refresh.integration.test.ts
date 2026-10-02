/** Current configuration project: no historical module alias, no real provider calls. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { readFixedProviderConfiguration as historical } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { policyAdoptionFixture } from "./studio-plan-quality-provider-policy-adoption-test-helpers";
import { reservationStoreFixture } from "./studio-plan-quality-provider-reservation-store-test-helpers";
import { transmissionStoreFixture } from "./studio-plan-quality-provider-transmission-approval-store-test-helpers";
import { generationDispatchStoreFixture } from "./studio-plan-quality-provider-dispatch-store-test-helpers";
import { generationResponseFixture } from "./studio-plan-quality-provider-response-test-helpers";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import { qualityProviderReviewRoute } from "./studio-plan-quality-provider-review-service";

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
const now = "2026-10-02T13:10:00.000Z";
// Multi-stage SQLite audits and reopen need additional wall-clock time on Windows.
const persistenceTimeout = process.platform === "win32" ? 15000 : 5000;
let directory: string, store: PlanQualityStore, db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-evidence-refresh-"));
  store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    expectedVersion: 0,
    clientRequestId: randomUUID(),
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
  db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  vi.setSystemTime(now);
});
afterEach(() => {
  db.close();
  store.close();
  expect(forbidden).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-evidence-refresh-") || rel.includes(".."))
    throw Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
const input = (value = configuration.getProviderConfigurationProposal(), inspectedAt = now) => {
  const registry = actualTestRegistry();
  return {
    registry,
    candidateId: registry.entries[0].candidateId,
    configuration: value,
    inspectedAt,
  };
};
function past() {
  vi.setSystemTime(actualTestNow);
  return vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(historical);
}
const budgetBytes = () =>
  db.prepare("SELECT * FROM quality_actual_budget_events ORDER BY rowid").all();

it("loads the new fixed official review, retains the same rates/request conditions, and clones values", () => {
  const current = configuration.getProviderConfigurationProposal()!;
  const old = historical()!;
  expect(old.configurationDigest).toBe(
    "125b7a48343dd0b3ff850ce36ea1baee0f0770a0e27728ce2fd259be2fd43fc8",
  );
  expect(current.configurationDigest).not.toBe(old.configurationDigest);
  expect(current.sources).toHaveLength(7);
  expect(
    current.sources.every(
      (s) =>
        s.reviewedAt === "2026-10-02T13:09:40.000Z" && s.validUntil === "2026-10-03T13:09:40.000Z",
    ),
  ).toBe(true);
  expect(current.sources.find((s) => s.id === "responses-api")?.url).toContain("/cli/");
  expect(current.conditions).toEqual(old.conditions);
  expect(current.pricing.shortContext).toEqual(old.pricing.shortContext);
  expect(current.pricing.longContext).toEqual(old.pricing.longContext);
  expect(current.usagePolicyTemplate.inputPartition).toEqual(
    old.usagePolicyTemplate.inputPartition,
  );
  expect(current.proposedBudget).toMatchObject({ ...old.proposedBudget, basis: expect.stringContaining("기존 완료 실행과 추가") });
  expect(configuration.createProviderConfigurationProposalView(input())).toMatchObject({
    state: "proposal-only",
    actualExecutionEnabled: false,
    proposal: { configurationDigest: current.configurationDigest },
  });
  current.sources[0].excerpt = "mutated caller copy";
  expect(configuration.getProviderConfigurationProposal()!.sources[0].excerpt).not.toBe(
    current.sources[0].excerpt,
  );
});

it("neither revives old evidence nor falls back to it before the new review date", () => {
  expect(configuration.createProviderConfigurationProposalView(input(historical()))).toBeNull();
  expect(configuration.getProviderConfigurationExpiry(input(historical()))).toEqual({
    configurationDigest: historical()!.configurationDigest,
    validUntil: "2026-09-27T23:57:59.000Z",
  });
  expect(
    configuration.createProviderConfigurationProposalView(input(undefined, actualTestNow)),
  ).toBeNull();
  expect(configuration.getProviderConfigurationExpiry(input())).toBeNull();
  const deadline = "2026-10-03T13:09:40.000Z";
  expect(
    configuration.createProviderConfigurationProposalView(input(undefined, deadline)),
  ).toBeNull();
  expect(configuration.getProviderConfigurationExpiry(input(undefined, deadline))).toEqual({
    configurationDigest: configuration.getProviderConfigurationProposal()!.configurationDigest,
    validUntil: deadline,
  });
});

it("uses current evidence in real store adoption/reservation/approval without an operational runtime", () => {
  const identity = generationDispatchStoreFixture(store);
  const budget = store.providerBudgetGet("production");
  expect(budget).toMatchObject({
    capUnits: "15000000",
    heldUnits: "11220000",
    recognizedUnits: "0",
  });
  expect(store.providerGet(identity.runId)).toMatchObject({ revision: 1, dispatchIntentCount: 0 });
  expect(
    store.providerTransmissionReview({ runId: identity.runId, runDigest: identity.runDigest })
      .status,
  ).toBe("review");
  expect(inspectQualityDatabase(db).providerPolicies).toBe(1);
});

it(
  "preserves old approvals, requests, and held budget across a fresh policy adoption and reopen",
  async () => {
    const oldGetter = past();
    const policy = policyAdoptionFixture(store);
    const adopted = store.providerPolicyAdopt(policy.command, policy.review);
    const reservation = reservationStoreFixture(store);
    const reserved = store.providerReserve(reservation.command, reservation.review);
    const approval = transmissionStoreFixture(store, reserved.record);
    const approved = store.providerApproveTransmission(approval.command, approval.review);
    const archive = inspectQualityDatabase(db),
      budget = store.providerBudgetGet("production"),
      bytes = budgetBytes();
    oldGetter.mockRestore();
    vi.setSystemTime(now);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(inspectQualityDatabase(db)).toEqual(archive);
    expect(store.providerPolicyAdopt(policy.command, null).record).toEqual(adopted.record);
    expect(store.providerReserve(reservation.command, null).record).toEqual(reserved.record);
    expect(store.providerApproveTransmission(approval.command, null).record).toEqual(
      approved.record,
    );
    const fresh = policyAdoptionFixture(store);
    expect(fresh.command.budgetAction).toBe("keep-existing-budget");
    expect(fresh.command.initialBudgetRequestId).toBeNull();
    expect(fresh.review.bindings.configurationDigest).toBe(
      configuration.getProviderConfigurationProposal()!.configurationDigest,
    );
    store.providerPolicyAdopt(fresh.command, fresh.review);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(budgetBytes()).toEqual(bytes);
    expect(store.providerPolicyLookup(policy.command.clientRequestId)).toEqual({
      state: "committed",
      record: adopted.record,
    });
    expect(store.providerTransmissionApprovalLookup(approval.command.clientRequestId)).toEqual({
      state: "committed",
      record: approved.record,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
    });
    const registry = store.candidateRegistryGet(1);
    const next = store.providerReservationReview({
      version: 1,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[1].candidateId,
    });
    expect(next).toMatchObject({ status: "review", review: { assessment: { state: "blocked" } } });
    const send = vi.fn(async () => undefined);
    await expect(
      store.providerSimulateGenerationDispatch(
        {
          runId: approved.record.runId,
          runDigest: approved.record.runDigest,
          approvalBindingDigest: approved.record.recordDigest,
          preparedRequestId: randomUUID(),
          dispatchRequestId: randomUUID(),
        },
        { provenance: "synthetic-test", send },
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(store.providerBudgetGet("production")).toEqual(budget);
  },
  persistenceTimeout,
);

it("rejects an uncommitted old review after refresh without resetting any budget", () => {
  const oldGetter = past();
  const stale = policyAdoptionFixture(store);
  oldGetter.mockRestore();
  vi.setSystemTime(now);
  const before = inspectQualityDatabase(db);
  expect(() => store.providerPolicyAdopt(stale.command, stale.review)).toThrow();
  expect(inspectQualityDatabase(db)).toEqual(before);
});

it("serves the fresh proposal over the real read-only route and expires it at its fixed deadline", async () => {
  const storeModule = await import("./studio-plan-quality-store");
  vi.spyOn(storeModule, "getPlanQualityStore").mockReturnValue(store);
  const registry = store.candidateRegistryGet(1);
  const request = () =>
    new Request("http://127.0.0.1:3000/api/studio/quality/provider-review/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        versionDigest: registry.versionDigest,
        candidateId: registry.entries[0].candidateId,
      }),
    });
  const before = inspectQualityDatabase(db);
  const fresh = await qualityProviderReviewRoute(request());
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toMatchObject({
    viewVersion: 4,
    state: "proposal-only",
    actualExecutionEnabled: false,
    proposal: {
      configurationDigest: configuration.getProviderConfigurationProposal()!.configurationDigest,
    },
  });
  vi.setSystemTime("2026-10-03T13:09:40.000Z");
  const expired = await qualityProviderReviewRoute(request());
  expect(expired.status).toBe(200);
  expect(await expired.json()).toMatchObject({
    viewVersion: 3,
    state: "configuration-expired",
    actualExecutionEnabled: false,
  });
  expect(inspectQualityDatabase(db)).toEqual(before);
});

it(
  "recovers a retained historical response after refresh using the original rate policy",
  async () => {
    const oldGetter = past();
    const response = generationResponseFixture(generationDispatchStoreFixture(store));
    const send = vi.fn(async () => undefined);
    await store.providerSimulateGenerationDispatch(response.dispatch, {
      provenance: "synthetic-test",
      send,
    });
    oldGetter.mockRestore();
    vi.setSystemTime(now);
    const saved = store.providerRecordGenerationResponse(response);
    const budget = store.providerBudgetGet("production"),
      bytes = budgetBytes();
    expect(BigInt(budget.recognizedUnits)).toBeGreaterThan(BigInt(0));
    expect(BigInt(budget.heldUnits)).toBeGreaterThan(BigInt(0));
    expect(budget.capUnits).toBe("15000000");
    const fresh = policyAdoptionFixture(store);
    store.providerPolicyAdopt(fresh.command, fresh.review);
    store.close();
    store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
    expect(store.providerRecordGenerationResponse(response).record).toEqual(saved.record);
    expect(store.providerBudgetGet("production")).toEqual(budget);
    expect(budgetBytes()).toEqual(bytes);
    expect(send).toHaveBeenCalledTimes(1);
  },
  persistenceTimeout,
);

it("preserves the September 28 configuration digest and its expired authority", async () => {
  const { readFixedProviderConfiguration } = await import("./studio-plan-quality-provider-configuration-20260928");
  const previous = readFixedProviderConfiguration()!;
  expect(previous.configurationDigest).toBe("6c63a5f747d1dc49560f0bdbe41a9c9ce237d0669d9bf62a8183c46f571b146e");
  expect(previous.sources.every(s => s.validUntil === "2026-09-29T14:34:32.000Z")).toBe(true);
  expect(configuration.createProviderConfigurationProposalView(input(previous))).toBeNull();
  expect(configuration.getProviderConfigurationProposal()!.configurationDigest).not.toBe(previous.configurationDigest);
});
