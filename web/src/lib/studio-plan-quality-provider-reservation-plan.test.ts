import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { providerReservationReviewDigestInput } from "./studio-plan-quality-provider-reservation-review-types";
import {
  prepareProviderReservation,
  providerReservationCommandDigest,
  providerReservationPlanLimits,
  type ProviderReservationPlannerInput,
} from "./studio-plan-quality-provider-reservation-plan";
import {
  providerDigest as digest,
  providerStartDigestInput,
  providerBudgetScope,
} from "../../scripts/local-data-quality-provider.mjs";
import { inspectQualityLedgers } from "../../scripts/local-data-quality-ledgers.mjs";
import {
  registry,
  reviewedAt,
  approvedAt,
  recordedAt,
  config,
  adopt,
  review,
  commandFor,
  fixture,
  prepared,
  withRows,
  cancel,
  refresh,
} from "./studio-plan-quality-provider-reservation-test-helpers";
const denied = (input: ProviderReservationPlannerInput, reason: string) =>
  expect(prepareProviderReservation(input)).toEqual({ status: "refused", reason, plan: null });

describe("production candidate reservation command and pre-write plan", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error("Unexpected provider call");
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("binds exact server requests and policy consent to frozen v2 rows without changing the input", () => {
    const input = fixture(),
      before = structuredClone(input),
      plan = prepared(input);
    expect(input).toEqual(before);
    expect(prepared(input)).toEqual(plan);
    expect(plan).toMatchObject({
      status: "prepared-not-committed",
      persistence: "audited-v8-transaction-required",
      dispatchAllowed: false,
    });
    expect(plan.rows.binding).toMatchObject({
      command: input.command,
      approvedReview: input.review,
      commandDigest: providerReservationCommandDigest(input.command),
      runId: plan.rows.run.id,
      runDigest: plan.rows.run.runDigest,
      startInputDigest: digest(providerStartDigestInput(plan.start)),
      dispatchAllowed: false,
    });
    expect(plan.rows.receipt.inputDigest).toBe(plan.rows.binding.startInputDigest);
    expect(plan.rows.receipt.inputDigest).not.toBe(plan.rows.binding.commandDigest);
    expect(plan.rows.run).toMatchObject({
      schemaVersion: 2,
      observedTransport: "none",
      actualAiCalls: 0,
    });
    expect(plan.rows.run).not.toHaveProperty("policy");
    expect(plan.start.preparation.permissions).toEqual({
      dispatchAllowed: false,
      tokenFitVerified: false,
      accountAccessVerified: false,
    });
    expect(plan.rows.artifact.body).toBe(JSON.stringify(plan.start.preparation.generation.body));
    expect(plan.start.preparation.preparedAt).toBe(reviewedAt);
    expect(plan.start.approval).toMatchObject({
      provenance: "explicit-user",
      approvedAt,
      expiresAt: input.review.policyReview.expiresAt,
    });
    withRows(input, plan);
    const next = inspectQualityLedgers(input.current.ledger);
    expect(next.provider.snapshots[0]).toMatchObject({
      state: "reserved",
      dispatchAllowed: false,
      actualAiCalls: 0,
    });
    const budget = next.provider.budgets.find(
      (row) => row.scopeId === providerBudgetScope("production"),
    )!;
    expect(budget.capUnits).toBe(input.review.policyReview.budget.capUnits);
    expect(budget.recognizedUnits).toBe("0");
    expect(budget.heldUnits).toBe(input.review.policyReview.reservation.totalUnits);
    expect(plan.rows.budgetEvent.payload.kind).toBe("reserve-run");
    expect(next.reservedBudgetEventSlots).toBe(15);
    expect(next.reservedReceiptSlots).toBe(63);
    expect(plan.capacity.totalExposureBytes).toBe(
      next.usedBytes + next.reservedBytes + plan.capacity.bindingBytes,
    );
  });
  it.each([
    "preparation",
    "configuration",
    "financialInput",
    "budgetAction",
    "dispatchAllowed",
    "runId",
  ])("rejects client-supplied %s", (key) => {
    const input = fixture();
    input.command = { ...input.command, [key]: true };
    denied(input, "invalid-input");
  });
  it.each([
    "acknowledgedCandidate",
    "acknowledgedCurrentBudget",
    "acknowledgedReservationOnly",
    "acknowledgedFinancialBasisNotTokenFit",
    "acknowledgedRetention",
    "acknowledgedNoAutomaticRetry",
    "transmission",
  ])("requires explicit %s", (key) => {
    const input = fixture();
    input.command = { ...input.command, approval: { ...input.command.approval, [key]: false } };
    denied(input, "invalid-input");
  });
  it.each(["version", "versionDigest", "candidateId"])("rejects a different %s", (key) => {
    const input = fixture();
    input.command = {
      ...input.command,
      [key]:
        key === "version"
          ? 2
          : key === "versionDigest"
            ? "a".repeat(64)
            : registry.entries[1].candidateId,
    };
    denied(input, "scope-changed");
  });
  it.each([
    "policy-head",
    "policy-reference",
    "budget-head",
    "ledger",
    "global-count",
    "production-count",
  ])("rejects a changed command %s", (key) => {
    const input = fixture();
    if (key === "policy-head")
      input.command.expectedPolicyHead = { revision: 2, headDigest: "a".repeat(64) };
    if (key === "policy-reference")
      input.command.expectedPolicyReference.clientRequestId = randomUUID();
    if (key === "budget-head") input.command.expectedBudgetHead.revision++;
    if (key === "ledger") input.command.expectedLedgerDigest = "a".repeat(64);
    if (key === "global-count") input.command.expectedGlobalRunCount++;
    if (key === "production-count") {
      input.command.expectedGlobalRunCount++;
      input.command.expectedProductionRunCount++;
    }
    denied(input, "bindings-changed");
  });
  it.each(["policy", "receipt", "other"])("rejects a nonce already owned by %s", (source) => {
    const input = fixture(),
      state = inspectQualityLedgers(input.current.ledger);
    input.command.clientRequestId =
      source === "policy"
        ? state.policy.records[0].clientRequestId
        : source === "receipt"
          ? state.provider.receipts[0].clientRequestId
          : input.current.ledger.otherNonces![0];
    denied(input, "nonce-conflict");
  });
  it.each(["policy", "other-nonce", "configuration", "budget"])(
    "requires reinspection after current %s changes",
    (change) => {
      const input = fixture();
      if (change === "policy") adopt(input.current.ledger, 1);
      if (change === "other-nonce") input.current.ledger.otherNonces!.push(randomUUID());
      if (change === "configuration") {
        const c = config();
        c.proposedBudget.capUnits = "16000000";
        c.configurationDigest = digest(providerConfigurationDigestInput(c));
        input.current.configuration = c;
      }
      if (change === "budget") {
        const plan = prepared(input);
        withRows(input, plan);
        input.command.clientRequestId = randomUUID();
        input.runId = randomUUID();
      }
      denied(input, "review-not-current");
    },
  );
  it.each([actualTestNow, "2026-09-27T03:33:00.000Z"])(
    "rejects consent outside the review/recording interval: %s",
    (time) => {
      const input = fixture();
      input.command.approval.approvedAt = time;
      denied(input, "approval-time-invalid");
    },
  );
  it.each(["at-expiry", "before-review", "official-expiry"])(
    "rejects %s without refreshing the approved request",
    (boundary) => {
      const input = fixture();
      input.current.inspectedAt =
        boundary === "at-expiry"
          ? input.review.policyReview.expiresAt
          : boundary === "before-review"
            ? actualTestNow
            : config()
                .sources.map((row) => row.validUntil)
                .sort()[0];
      denied(input, "review-not-current");
    },
  );
  it("accepts consent at inspection and exactly at the current recording instant", () => {
    const input = fixture();
    input.command.approval.approvedAt = reviewedAt;
    prepared(input);
    input.command.approval.approvedAt = recordedAt;
    prepared(input);
  });
  it("rejects a forged review even with its digest recomputed", () => {
    const input = fixture();
    input.review.ledgerDigest = "a".repeat(64);
    input.review.reviewDigest = digest(providerReservationReviewDigestInput(input.review));
    input.command = commandFor(input.review);
    denied(input, "review-not-current");
  });
  it("keeps a selected older policy distinct from the global policy head", () => {
    const input = fixture();
    adopt(input.current.ledger, 1);
    refresh(input);
    const plan = prepared(input);
    expect(plan.rows.binding.command.expectedPolicyReference.revision).toBe(1);
    expect(plan.rows.binding.command.expectedPolicyHead.revision).toBe(2);
  });
  it("refuses an unmatched adopted policy even with a fresh review", () => {
    const input = fixture(),
      c = config();
    c.proposedBudget.capUnits = "16000000";
    c.configurationDigest = digest(providerConfigurationDigestInput(c));
    input.current.configuration = c;
    refresh(input);
    expect(input.review.policy.state).toBe("changed");
    denied(input, "reservation-blocked");
  });
  it("does not initialize a missing budget or fabricate missing policy consent", () => {
    const input = fixture();
    input.current.ledger.policies = [];
    input.current.ledger.budgetEvents = [];
    input.current.ledger.receipts = [];
    input.review = review(input.current);
    input.command.approvedReviewDigest = input.review.reviewDigest;
    denied(input, "reservation-blocked");
  });
  it("blocks unresolved reservations and insufficient current budget", () => {
    const input = fixture();
    adopt(input.current.ledger, 1);
    refresh(input);
    const plan = prepared(input);
    withRows(input, plan);
    input.runId = randomUUID();
    refresh(input);
    expect(input.review.assessment.blockers).toContain("candidate-unsettled");
    denied(input, "reservation-blocked");
    input.current.selection = {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[1].candidateId,
    };
    refresh(input);
    expect(input.review.assessment.blockers).toEqual(["budget-insufficient"]);
    denied(input, "reservation-blocked");
  });
  it("requires audited replay for an existing nonce, never a second reserve event", () => {
    const input = fixture(),
      plan = prepared(input);
    withRows(input, plan);
    denied(input, "nonce-conflict");
    const originalDigest = providerReservationCommandDigest(input.command);
    input.command.approval.approvedAt = recordedAt;
    expect(providerReservationCommandDigest(input.command)).not.toBe(originalDigest);
    denied(input, "nonce-conflict");
    expect(input.current.ledger.runs).toHaveLength(1);
    expect(input.current.ledger.budgetEvents).toHaveLength(2);
  });
  it("preserves other candidates' holds and uses the current counts and budget head", () => {
    const c = config();
    c.proposedBudget.capUnits = "100000000";
    c.configurationDigest = digest(providerConfigurationDigestInput(c));
    const input = fixture(c);
    adopt(input.current.ledger, 1, c);
    refresh(input);
    const first = prepared(input);
    withRows(input, first);
    input.additionalUsedBytes = first.capacity.bindingBytes;
    input.current.selection = {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[1].candidateId,
    };
    input.runId = randomUUID();
    refresh(input);
    const second = prepared(input);
    expect(second.start.expectedGlobalRunCount).toBe(1);
    expect(second.start.expectedScopeRunCount).toBe(1);
    expect(second.start.expectedBudgetRevision).toBe(first.rows.budgetEvent.revision);
    expect(second.start.preparation.budget.heldUnits).toBe(
      first.start.preparation.financialBasis.costs!.totalUnits,
    );
    withRows(input, second);
    const budget = inspectQualityLedgers(input.current.ledger).provider.budgets.find(
      (row) => row.scopeId === providerBudgetScope("production"),
    )!;
    expect(budget.capUnits).toBe("100000000");
    expect(budget.heldUnits).toBe(
      (
        BigInt(first.start.preparation.financialBasis.costs!.totalUnits) +
        BigInt(second.start.preparation.financialBasis.costs!.totalUnits)
      ).toString(),
    );
    expect(input.current.ledger.budgetEvents).toHaveLength(3);
  });
  it("counts cancelled history toward the shared 20-run limit", () => {
    const input = fixture();
    for (let index = 0; index < 20; index++) {
      const plan = prepared(input);
      expect(plan.rows.run.expectedGlobalRunCount).toBe(index);
      withRows(input, plan);
      cancel(input, plan);
      input.additionalUsedBytes += plan.capacity.bindingBytes;
      input.runId = randomUUID();
      if (index < 19) refresh(input);
    }
    input.review = review(input.current);
    expect(input.review.runs.globalCount).toBe(20);
    expect(input.review.assessment.blockers).toEqual(["run-limit"]);
    input.command.clientRequestId = randomUUID();
    input.command.approvedReviewDigest = input.review.reviewDigest;
    denied(input, "reservation-blocked");
  }, 20000);
  it("rejects an existing run id independently of the operation nonce", () => {
    const input = fixture();
    withRows(input, prepared(input));
    input.command.clientRequestId = randomUUID();
    denied(input, "run-id-conflict");
  });
  it.each(["policy", "receipt", "registry", "artifact"])(
    "refuses damaged %s evidence before planning",
    (kind) => {
      const input = fixture();
      if (kind === "policy") input.current.ledger.policies![0] = {};
      if (kind === "receipt") input.current.ledger.receipts[0] = {};
      if (kind === "registry")
        input.current.ledger.registries[0] = { ...registry, versionDigest: "a".repeat(64) };
      if (kind === "artifact") input.current.ledger.artifacts.push({ runId: randomUUID() });
      denied(input, "ledger-invalid");
    },
  );
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid extra storage accounting %s",
    (additionalUsedBytes) => {
      denied({ ...fixture(), additionalUsedBytes }, "invalid-input");
    },
  );
  it("accounts for reserved bytes, binding bytes and other DB tables at the exact shared limit", () => {
    const input = fixture(),
      first = prepared(input);
    input.additionalUsedBytes =
      providerReservationPlanLimits.databaseBytes - first.capacity.totalExposureBytes;
    expect(prepared(input).capacity.totalExposureBytes).toBe(
      providerReservationPlanLimits.databaseBytes,
    );
    input.additionalUsedBytes++;
    denied(input, "capacity-exceeded");
  });
  it("rejects a new reservation when other candidates already occupy the shared storage", () => {
    const c = config();
    c.proposedBudget.capUnits = "1000000000";
    c.configurationDigest = digest(providerConfigurationDigestInput(c));
    const input = fixture(c);
    for (let index = 1; index < 8; index++) adopt(input.current.ledger, index, c);
    for (let index = 0; index < 8; index++) {
      input.current.selection = {
        version: registry.version,
        versionDigest: registry.versionDigest,
        candidateId: registry.entries[index].candidateId,
      };
      input.runId = randomUUID();
      refresh(input);
      expect(input.review.assessment.state).toBe("conditions-met");
      if (index === 7) denied(input, "capacity-exceeded");
      else {
        const plan = prepared(input);
        withRows(input, plan);
        input.additionalUsedBytes += plan.capacity.bindingBytes;
      }
    }
    expect(input.current.ledger.runs).toHaveLength(7);
  }, 20000);
  it.each(["unknown", "none"])("never accepts an invalid %s run id", (runId) =>
    denied({ ...fixture(), runId }, "invalid-input"),
  );
});
