import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import type { ProviderBudgetEvent } from "./studio-plan-quality-provider-types";
import { createProviderBudgetEvent } from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderPolicyReview,
  isProviderPolicyReviewCurrent,
  type ProviderPolicyReviewInput,
} from "./studio-plan-quality-provider-policy-review";
import {
  providerPolicyReviewDigestInput,
  providerPolicyReviewSchema,
} from "./studio-plan-quality-provider-policy-review-types";

const now = "2026-09-27T00:00:00.000Z";
const registry = actualTestRegistry();
const input = (events: ProviderBudgetEvent[] = []): ProviderPolicyReviewInput => ({
  registry,
  candidateId: registry.entries[0].candidateId,
  inspectedAt: now,
  configuration: getProviderConfigurationProposal(),
  budgetEvents: events,
  expectedBudgetHead: { revision: events.length, headDigest: events.at(-1)?.eventDigest ?? null },
});

// In-memory ledger protocol fixtures only; these do not record real consent, usage or payment.
function append(
  events: ProviderBudgetEvent[],
  payload: ProviderBudgetEvent["payload"],
  currency = "USD",
  unitScale = 6,
) {
  const event = createProviderBudgetEvent({
    schemaVersion: 2,
    environment: "production",
    scopeId: "candidate-quality-provider-v2-live",
    provenance: "explicit-user",
    revision: events.length + 1,
    previousDigest: events.at(-1)?.eventDigest ?? null,
    eventId: randomUUID(),
    recordedAt: "2026-09-26T23:59:00.000Z",
    currency,
    unitScale,
    payload,
  });
  events.push(event);
  return event;
}
function configured(capUnits = "15000000", currency = "USD", unitScale = 6) {
  const events: ProviderBudgetEvent[] = [];
  append(events, { kind: "configure", capUnits }, currency, unitScale);
  return events;
}
function rewriteEvent(event: ProviderBudgetEvent, patch: Partial<ProviderBudgetEvent>) {
  const { eventDigest: _ignored, ...body } = { ...event, ...patch };
  void _ignored;
  return createProviderBudgetEvent(body);
}
function reserved() {
  const events = configured();
  append(events, {
    kind: "reserve-run",
    runId: randomUUID(),
    preparationDigest: "a".repeat(64),
    generationUnits: "1000000",
    reviewUnits: "1000000",
  });
  return events;
}
function recognized(cost = "500000") {
  const events = reserved();
  const reservation = events[1];
  if (reservation.payload.kind !== "reserve-run") throw new Error("fixture");
  const amount = BigInt(cost);
  const held = BigInt(1000000);
  append(events, {
    kind: "recognize-usage",
    runId: reservation.payload.runId,
    phase: "generation",
    reservationDigest: reservation.eventDigest,
    dispatchEventDigest: "b".repeat(64),
    responseArtifactSha256: "c".repeat(64),
    usageAssessmentDigest: "d".repeat(64),
    recognizedUnits: cost,
    consumedHeldUnits: (amount < held ? amount : held).toString(),
    releasedHeldUnits: (amount < held ? held - amount : BigInt(0)).toString(),
    boundExcessUnits: (amount > held ? amount - held : BigInt(0)).toString(),
    violations: [],
  });
  return events;
}
function review(value = input()) {
  const result = createProviderPolicyReview(value);
  expect(result.status).toBe("review");
  if (result.status !== "review") throw new Error(result.reason);
  return result.review;
}

const forbidden = vi.fn(() => {
  throw new Error("No credential access or network");
});
let originalEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  originalEnvironment = process.env;
  process.env = new Proxy(originalEnvironment, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(OPENAI|VENTURE_DATA_DIR)/.test(key)) return forbidden();
      return Reflect.get(target, key, receiver);
    },
  });
});
afterEach(() => {
  process.env = originalEnvironment;
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("provider operating policy review", () => {
  it("keeps an empty ledger unconfigured and labels the USD15 calculation as an unapproved proposal", () => {
    const value = input();
    const before = JSON.stringify(value);
    const result = review(value);
    expect(result.budget).toMatchObject({
      revision: 0,
      headDigest: null,
      currency: null,
      capUnits: "0",
      availableUnits: "0",
    });
    expect(result.assessment).toEqual({
      state: "budget-not-configured",
      basis: "unapproved-proposal",
      availableBeforeReservationUnits: "15000000",
      availableAfterReservationUnits: "3780000",
      shortfallUnits: "0",
    });
    expect(result.reservation).toEqual({
      generationUnits: "5610000",
      reviewUnits: "5610000",
      totalUnits: "11220000",
    });
    expect(Object.values(result.actions)).toEqual([false, false, false, false]);
    expect(result.proposedBudget.status).toBe("not-approved");
    expect(result.accountAccess).toBe("not-checked");
    expect(result.reviewDigest).toBe(digest(providerPolicyReviewDigestInput(result)));
    expect(providerPolicyReviewSchema.parse(result)).toEqual(result);
    expect(review(value)).toEqual(result);
    expect(JSON.stringify(value)).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:payload|body|runId|eventId|preparation|transmissionManifest)":/,
    );
  });
  it("subtracts both recognized usage and unresolved reservations without resetting them on repeat inspection", () => {
    const events = recognized();
    const before = JSON.stringify(events);
    const result = review(input(events));
    expect(result.budget).toMatchObject({
      revision: 3,
      headDigest: events[2].eventDigest,
      capUnits: "15000000",
      recognizedUnits: "500000",
      heldUnits: "1000000",
      availableUnits: "13500000",
    });
    expect(result.assessment).toMatchObject({
      state: "budget-configured",
      basis: "existing-budget",
      availableAfterReservationUnits: "2280000",
      shortfallUnits: "0",
    });
    expect(review(input(events))).toEqual(result);
    expect(JSON.stringify(events)).toBe(before);
  });
  it.each([
    ["20000000", "budget-configured", "8780000", "0"],
    ["11220000", "budget-configured", "0", "0"],
    ["10000000", "budget-insufficient", "0", "1220000"],
    ["0", "budget-insufficient", "0", "11220000"],
  ])(
    "uses the existing %s cap instead of replacing it with the proposal",
    (cap, state, after, shortfall) => {
      const result = review(input(configured(cap)));
      expect(result.budget.capUnits).toBe(cap);
      expect(result.proposedBudget.capUnits).toBe("15000000");
      expect(result.assessment).toMatchObject({
        state,
        availableAfterReservationUnits: after,
        shortfallUnits: shortfall,
      });
    },
  );
  it.each([
    ["KRW", 6],
    ["USD", 0],
  ] as const)("does not subtract incompatible %s/%s units", (currency, scale) => {
    expect(review(input(configured("15000000", currency, scale))).assessment).toEqual({
      state: "budget-incompatible",
      basis: "incompatible",
      availableBeforeReservationUnits: null,
      availableAfterReservationUnits: null,
      shortfallUnits: null,
    });
  });
  it.each(["1100000", "20000000"])(
    "preserves a breached phase bound even when the cumulative balance alone could look usable (%s)",
    (cost) => {
      const result = review(input(recognized(cost)));
      expect(result.budget.boundBreached).toBe(true);
      expect(result.assessment.state).toBe("budget-bound-breached");
      expect(result.budget.deficitUnits).toBe(cost === "20000000" ? "6000000" : "0");
    },
  );
  it("keeps all unsettled reservations held", () => {
    expect(review(input(reserved())).assessment.availableAfterReservationUnits).toBe("1780000");
  });
  it.each([
    "scope",
    "environment",
    "provenance",
    "digest",
    "previousDigest",
    "revision",
    "duplicate",
    "untrusted-total",
  ])("rejects invalid ledger %s", (mode) => {
    const events = reserved();
    if (mode === "scope") events[0].scopeId = "candidate-quality-provider-v2-synthetic";
    if (mode === "environment") events[0].environment = "synthetic-test";
    if (mode === "provenance") events[0].provenance = "synthetic-test";
    if (mode === "digest") events[0].eventDigest = "f".repeat(64);
    if (mode === "previousDigest") events[1].previousDigest = "e".repeat(64);
    if (mode === "revision") events[1].revision = 1;
    if (mode === "duplicate") events.push(events[1]);
    if (mode === "untrusted-total") Object.assign(events[0], { availableUnits: "99999999" });
    expect(createProviderPolicyReview(input(events))).toMatchObject({
      status: "unavailable",
      reason: "budget-invalid",
      review: null,
    });
  });
  it("rejects a rehashed synthetic provenance, a truncated prefix, stale head and future events", () => {
    const events = configured();
    events[0] = rewriteEvent(events[0], { provenance: "synthetic-test" });
    expect(createProviderPolicyReview(input(events))).toMatchObject({ reason: "budget-invalid" });
    const current = input(configured());
    expect(createProviderPolicyReview({ ...current, budgetEvents: [] })).toMatchObject({
      reason: "budget-head-changed",
    });
    expect(
      createProviderPolicyReview({
        ...current,
        expectedBudgetHead: { revision: 0, headDigest: null },
      }),
    ).toMatchObject({ reason: "budget-head-changed" });
    const future = configured();
    future[0] = rewriteEvent(future[0], { recordedAt: "2026-09-27T00:00:00.001Z" });
    expect(createProviderPolicyReview(input(future))).toMatchObject({
      reason: "budget-event-after-inspection",
    });
  });
  it("distinguishes expired, missing, invalid configuration and invalid inspection time without returning amounts", () => {
    expect(createProviderPolicyReview({ ...input(), configuration: null })).toEqual({
      status: "unavailable",
      reason: "configuration-missing-or-invalid",
      review: null,
    });
    expect(
      createProviderPolicyReview({ ...input(), inspectedAt: "2030-01-01T00:00:00.000Z" }),
    ).toEqual({ status: "unavailable", reason: "configuration-expired", review: null });
    expect(createProviderPolicyReview({ ...input(), inspectedAt: "invalid" })).toMatchObject({
      reason: "inspection-invalid",
      review: null,
    });
    const configuration = getProviderConfigurationProposal()!;
    configuration.context.provenance = "synthetic-test";
    configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
    expect(
      createProviderPolicyReview({
        ...input(),
        configuration,
        inspectedAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ reason: "configuration-missing-or-invalid", review: null });
  });
  it("checks the exact time boundary, current configuration, candidate and current budget head", () => {
    const original = input(configured());
    const result = review(original);
    expect(
      isProviderPolicyReviewCurrent(result, {
        ...original,
        inspectedAt: "2026-09-27T00:14:59.999Z",
      }),
    ).toBe(true);
    for (const inspectedAt of ["invalid", "2026-09-26T23:59:59.999Z", result.expiresAt])
      expect(isProviderPolicyReviewCurrent(result, { ...original, inspectedAt })).toBe(false);
    expect(isProviderPolicyReviewCurrent(result, input(reserved()))).toBe(false);
    expect(
      isProviderPolicyReviewCurrent(result, {
        ...original,
        candidateId: "validation-candidate-missing",
      }),
    ).toBe(false);
    const configuration = getProviderConfigurationProposal()!;
    configuration.proposedBudget.capUnits = "20000000";
    configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
    expect(isProviderPolicyReviewCurrent(result, { ...original, configuration })).toBe(false);
  });
  it("caps review freshness at the first official source deadline", () => {
    const deadline = getProviderConfigurationProposal()!.sources[0].validUntil;
    const value = { ...input(), inspectedAt: new Date(Date.parse(deadline) - 5000).toISOString() };
    const result = review(value);
    expect(result.expiresAt).toBe(deadline);
    expect(isProviderPolicyReviewCurrent(result, { ...value, inspectedAt: deadline })).toBe(false);
  });
  it.each(["not-a-number", "1.5", "-1", "01", "9".repeat(81)])(
    "rejects malformed units %s without throwing from arithmetic refinements",
    (amount) => {
      const value = input();
      for (const field of ["budget", "proposal", "reservation"] as const) {
        const result = review(value);
        if (field === "budget") result.budget.recognizedUnits = amount;
        if (field === "proposal") result.proposedBudget.capUnits = amount;
        if (field === "reservation") result.reservation.totalUnits = amount;
        expect(providerPolicyReviewSchema.safeParse(result).success).toBe(false);
        expect(isProviderPolicyReviewCurrent(result, value)).toBe(false);
      }
    },
  );
  it.each(["grant", "remaining", "state", "head", "digest", "binding"])(
    "rejects changed review %s even with recomputed public hashes",
    (mode) => {
      const value = input(configured());
      const result = review(value);
      if (mode === "grant") Object.assign(result.actions, { dispatchAllowed: true });
      if (mode === "remaining") result.assessment.availableAfterReservationUnits = "99999999";
      if (mode === "state") result.assessment.state = "budget-not-configured";
      if (mode === "head") result.budget.headDigest = "e".repeat(64);
      if (mode === "binding") result.bindings.requestReviewDigest = "a".repeat(64);
      result.reviewDigest =
        mode === "digest" ? "d".repeat(64) : digest(providerPolicyReviewDigestInput(result));
      expect(isProviderPolicyReviewCurrent(result, value)).toBe(false);
    },
  );
});
