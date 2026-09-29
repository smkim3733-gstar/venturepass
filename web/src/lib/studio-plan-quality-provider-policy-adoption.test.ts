import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestRegistry, actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { providerPolicyReviewDigestInput } from "./studio-plan-quality-provider-policy-review-types";
import {
  providerReviewDigestInput,
  providerConfigurationDigestInput,
} from "./studio-plan-quality-provider-review-types";
import {
  createProviderBudgetEvent,
  inspectProviderLedger,
} from "../../scripts/local-data-quality-provider.mjs";
import type { ProviderBudgetEvent } from "./studio-plan-quality-provider-types";
import {
  prepareProviderPolicyAdoption,
  compareProviderPolicyAdoptionRetry,
  providerPolicyAdoptionRequestDigest,
  type ProviderPolicyAdoptionPlannerInput,
} from "./studio-plan-quality-provider-policy-adoption";
import {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionRecordDigestInput,
  type ProviderPolicyAdoptionCommand,
  type ProviderPolicyAdoptionRecord,
} from "./studio-plan-quality-provider-policy-adoption-types";

const registry = actualTestRegistry();
const now = "2026-09-27T03:01:00.000Z";
const policyHead = { revision: 0, headDigest: null };
function fixture(
  events: ProviderBudgetEvent[] = [],
  head: { revision: number; headDigest: string | null } = policyHead,
) {
  const current = {
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: actualTestNow,
    configuration: getProviderConfigurationProposal(),
    budgetEvents: events,
    expectedBudgetHead: { revision: events.length, headDigest: events.at(-1)?.eventDigest ?? null },
  };
  const result = createProviderPolicyReview(current);
  if (result.status !== "review") throw new Error("Invalid synthetic protocol fixture");
  const command = providerPolicyAdoptionCommandSchema.parse({
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: current.candidateId,
    expectedPolicyHead: head,
    approvedReviewDigest: result.review.reviewDigest,
    budgetAction: events.length ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: events.length ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: "2026-09-27T03:00:30.000Z",
    },
  });
  return {
    command,
    review: result.review,
    current: { ...current, inspectedAt: now },
    currentPolicyHead: head,
    usedRequestIds: [] as string[],
  };
}
// Production wire format in memory only; no real approval, customer data, usage or payment.
function append(
  events: ProviderBudgetEvent[],
  payload: ProviderBudgetEvent["payload"],
  currency = "USD",
) {
  const event = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: "candidate-quality-provider-v2-live",
    environment: "production",
    provenance: "explicit-user",
    revision: events.length + 1,
    previousDigest: events.at(-1)?.eventDigest ?? null,
    eventId: randomUUID(),
    recordedAt: "2026-09-27T02:59:00.000Z",
    currency,
    unitScale: 6,
    payload,
  });
  events.push(event);
  return event;
}
function configured(capUnits = "20000000", currency = "USD") {
  const events: ProviderBudgetEvent[] = [];
  append(events, { kind: "configure", capUnits }, currency);
  return events;
}
function exposure() {
  const events = configured("10000000"),
    runId = randomUUID();
  const reservation = append(events, {
    kind: "reserve-run",
    runId,
    preparationDigest: "a".repeat(64),
    generationUnits: "1000000",
    reviewUnits: "1000000",
  });
  append(events, {
    kind: "recognize-usage",
    runId,
    phase: "generation",
    reservationDigest: reservation.eventDigest,
    dispatchEventDigest: "b".repeat(64),
    responseArtifactSha256: "c".repeat(64),
    usageAssessmentDigest: "d".repeat(64),
    recognizedUnits: "1100000",
    consumedHeldUnits: "1000000",
    releasedHeldUnits: "0",
    boundExcessUnits: "100000",
    violations: [],
  });
  return events;
}
function plan(input = fixture()) {
  const result = prepareProviderPolicyAdoption(input);
  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function reseal(record: ProviderPolicyAdoptionRecord) {
  record.recordDigest = digest(providerPolicyAdoptionRecordDigestInput(record));
  return record;
}
const forbidden = vi.fn(() => {
  throw new Error("No network or credential lookup");
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
  vi.useRealTimers();
});

describe("policy adoption pre-write contract", () => {
  it("plans one adoption and a separate legacy-compatible initial budget operation, without committing or reserving", () => {
    const input = fixture(),
      before = structuredClone(input),
      value = plan(input);
    expect(input).toEqual(before);
    expect(value.status).toBe("prepared-not-committed");
    expect(value.transaction).toBe("single-immediate-transaction-required");
    expect(value.record).toMatchObject({
      revision: 1,
      previousDigest: null,
      reservationAllowed: false,
      dispatchAllowed: false,
      clientRequestId: input.command.clientRequestId,
      requestDigest: providerPolicyAdoptionRequestDigest(input.command),
    });
    expect(value.initialization?.receipt.clientRequestId).toBe(
      input.command.initialBudgetRequestId,
    );
    expect(value.initialization?.receipt.clientRequestId).not.toBe(value.record.clientRequestId);
    const ledger = inspectProviderLedger({
      runs: [],
      events: [],
      artifacts: [],
      registries: [],
      budgetEvents: [value.initialization!.event],
      receipts: [value.initialization!.receipt],
    });
    expect(
      ledger.budgets.find((budget) => budget.scopeId === "candidate-quality-provider-v2-live"),
    ).toMatchObject({ capUnits: "15000000", recognizedUnits: "0", heldUnits: "0" });
    expect(value.record.budgetTransition.after).toEqual({
      revision: 1,
      headDigest: value.initialization!.event.eventDigest,
    });
    expect(compareProviderPolicyAdoptionRetry(input.command, value.record)).toBe("same-request");
  });
  it.each(["20000000", "10000000", "0"])(
    "preserves the existing %s cap instead of writing the USD15 proposal",
    (cap) => {
      const input = fixture(configured(cap)),
        value = plan(input);
      expect(value.initialization).toBeNull();
      expect(value.record.approvedReview.budget.capUnits).toBe(cap);
      expect(value.record.budgetTransition.after).toEqual(input.current.expectedBudgetHead);
      expect(value.record.budgetTransition.before).toEqual(value.record.budgetTransition.after);
      expect(compareProviderPolicyAdoptionRetry(input.command, value.record)).toBe("same-request");
    },
  );
  it("retains recognized use, unsettled holds and a prior bound violation; policy adoption is not a reservation", () => {
    const input = fixture(exposure()),
      value = plan(input);
    expect(value.initialization).toBeNull();
    expect(value.record.approvedReview.budget).toMatchObject({
      recognizedUnits: "1100000",
      heldUnits: "1000000",
      availableUnits: "7900000",
      boundBreached: true,
    });
    expect(value.record.approvedReview.assessment.state).toBe("budget-bound-breached");
    expect(value.record.reservationAllowed).toBe(false);
  });
  it("chains the next adoption to the checked policy head", () => {
    const input = fixture(configured(), { revision: 4, headDigest: "e".repeat(64) }),
      value = plan(input);
    expect(value.record.revision).toBe(5);
    expect(value.record.previousDigest).toBe("e".repeat(64));
  });
  it.each(["model", "capUnits", "configuration", "dispatchAllowed", "budgetEvents"])(
    "rejects extra client %s claims",
    (field) => {
      const input = fixture();
      Object.assign(input.command, { [field]: "client-value" });
      expect(prepareProviderPolicyAdoption(input)).toMatchObject({
        status: "refused",
        reason: "invalid-input",
        plan: null,
      });
    },
  );
  it.each(["acknowledgedPolicy", "acknowledgedBudgetAction", "reservationAndTransmission"])(
    "requires the exact %s acknowledgment",
    (field) => {
      const input = fixture();
      Object.assign(input.command.approval, { [field]: false });
      expect(prepareProviderPolicyAdoption(input)).toMatchObject({
        reason: "invalid-input",
        plan: null,
      });
    },
  );
  it.each(["same", "missing", "unexpected"])("rejects %s initialization nonce", (mode) => {
    const input = fixture();
    if (mode === "same") input.command.initialBudgetRequestId = input.command.clientRequestId;
    if (mode === "missing") input.command.initialBudgetRequestId = null;
    if (mode === "unexpected") input.command.budgetAction = "keep-existing-budget";
    expect(prepareProviderPolicyAdoption(input)).toMatchObject({ reason: "invalid-input" });
  });
  it.each(["clientRequestId", "initialBudgetRequestId"] as const)(
    "rejects an already used %s",
    (field) => {
      const input = fixture();
      input.usedRequestIds.push(input.command[field]!);
      expect(prepareProviderPolicyAdoption(input)).toMatchObject({ reason: "nonce-conflict" });
    },
  );
  it.each(["version", "versionDigest", "candidateId"] as const)(
    "rejects changed %s scope",
    (field) => {
      const input = fixture();
      if (field === "version") input.command.version++;
      if (field === "versionDigest") input.command.versionDigest = "a".repeat(64);
      if (field === "candidateId") input.command.candidateId = registry.entries[1].candidateId;
      expect(prepareProviderPolicyAdoption(input)).toMatchObject({ reason: "scope-changed" });
    },
  );
  it("rejects competing policy adoption even when the budget head is unchanged", () => {
    const input: ProviderPolicyAdoptionPlannerInput = fixture();
    input.currentPolicyHead = { revision: 1, headDigest: "a".repeat(64) };
    expect(prepareProviderPolicyAdoption(input)).toMatchObject({ reason: "policy-head-changed" });
  });
  it("enforces the policy-record limit", () => {
    expect(
      prepareProviderPolicyAdoption(fixture([], { revision: 100, headDigest: "a".repeat(64) })),
    ).toMatchObject({ reason: "policy-limit" });
  });
  it.each(["budget", "configuration", "request", "digest", "expiry", "before-review"])(
    "rejects a no-longer-current review (%s)",
    (mode) => {
      const input = fixture();
      if (mode === "budget") {
        input.current.budgetEvents = configured();
        input.current.expectedBudgetHead = {
          revision: 1,
          headDigest: input.current.budgetEvents[0].eventDigest,
        };
      }
      if (mode === "configuration") {
        const config = input.current.configuration!;
        config.proposedBudget.capUnits = "20000000";
        config.configurationDigest = digest(providerConfigurationDigestInput(config));
      }
      if (mode === "request") {
        input.review.bindings.requestReviewDigest = "a".repeat(64);
        input.review.reviewDigest = digest(providerPolicyReviewDigestInput(input.review));
        input.command.approvedReviewDigest = input.review.reviewDigest;
      }
      if (mode === "digest") input.command.approvedReviewDigest = "a".repeat(64);
      if (mode === "expiry") input.current.inspectedAt = input.review.expiresAt;
      if (mode === "before-review") input.current.inspectedAt = "2026-09-27T02:59:59.999Z";
      expect(prepareProviderPolicyAdoption(input)).toMatchObject({
        reason: "review-not-current",
        plan: null,
      });
    },
  );
  it.each(["2026-09-27T02:59:59.999Z", "2026-09-27T03:01:00.001Z"])(
    "rejects approval timestamp %s outside the server-verified interval",
    (approvedAt) => {
      const input = fixture();
      input.command.approval.approvedAt = approvedAt;
      expect(prepareProviderPolicyAdoption(input)).toMatchObject({
        reason: "approval-time-invalid",
      });
    },
  );
  it.each([true, false])("rejects the wrong budget action (configured=%s)", (configuredAlready) => {
    const input = fixture(configuredAlready ? configured() : []);
    input.command.budgetAction = configuredAlready
      ? "initialize-proposed-budget"
      : "keep-existing-budget";
    input.command.initialBudgetRequestId = configuredAlready ? randomUUID() : null;
    expect(prepareProviderPolicyAdoption(input)).toMatchObject({
      reason: "budget-action-mismatch",
    });
  });
  it("does not adopt incompatible operating currency", () => {
    expect(prepareProviderPolicyAdoption(fixture(configured("20000000", "KRW")))).toMatchObject({
      reason: "budget-incompatible",
    });
  });
  it("does not throw on malformed numeric review input", () => {
    const input = fixture();
    input.review.budget.capUnits = "malformed";
    expect(prepareProviderPolicyAdoption(input)).toMatchObject({ reason: "invalid-input" });
  });
});

describe("stable retry identity, not a persisted commit claim", () => {
  it("keeps the original command and result comparable after expiry and server configuration changes", () => {
    const input = fixture(),
      value = plan(input),
      requestDigest = providerPolicyAdoptionRequestDigest(input.command);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2035-01-01T00:00:00.000Z"));
    input.current.inspectedAt = new Date().toISOString();
    input.current.configuration = null;
    input.usedRequestIds.push(input.command.clientRequestId);
    expect(prepareProviderPolicyAdoption(input)).toMatchObject({ reason: "nonce-conflict" });
    expect(compareProviderPolicyAdoptionRetry(input.command, value.record)).toBe("same-request");
    expect(providerPolicyAdoptionRequestDigest(input.command)).toBe(requestDigest);
    expect(value.status).toBe("prepared-not-committed");
  });
  it("keeps request identity stable when only the server commit timestamp changes", () => {
    const input = fixture(),
      first = plan(input);
    input.current.inspectedAt = "2026-09-27T03:02:00.000Z";
    const second = plan(input);
    expect(second.record.requestDigest).toBe(first.record.requestDigest);
    expect(second.record.recordDigest).not.toBe(first.record.recordDigest);
    expect(second.initialization?.event.eventDigest).not.toBe(
      first.initialization?.event.eventDigest,
    );
  });
  it.each(["approval", "review", "budgetNonce", "head"])(
    "treats a changed %s under the same nonce as a conflict",
    (field) => {
      const input = fixture(),
        value = plan(input),
        command: ProviderPolicyAdoptionCommand = structuredClone(input.command);
      if (field === "approval") command.approval.approvedAt = now;
      if (field === "review") command.approvedReviewDigest = "a".repeat(64);
      if (field === "budgetNonce") command.initialBudgetRequestId = randomUUID();
      if (field === "head")
        command.expectedPolicyHead = { revision: 1, headDigest: "a".repeat(64) };
      expect(compareProviderPolicyAdoptionRetry(command, value.record)).toBe("nonce-conflict");
    },
  );
  it("distinguishes a different command nonce", () => {
    const input = fixture(),
      value = plan(input);
    input.command.clientRequestId = randomUUID();
    expect(compareProviderPolicyAdoptionRetry(input.command, value.record)).toBe(
      "different-request",
    );
  });
  it.each([
    "revision",
    "previous",
    "requestDigest",
    "reviewDigest",
    "requestEvidence",
    "reservation",
    "scope",
    "deadline",
    "afterHead",
    "recordedAt",
    "initializationNonce",
    "permission",
  ])("rejects resealed record tampering (%s)", (field) => {
    const input = fixture(),
      record = plan(input).record;
    if (field === "revision") record.revision++;
    if (field === "previous") record.previousDigest = "a".repeat(64);
    if (field === "requestDigest") record.requestDigest = "a".repeat(64);
    if (field === "reviewDigest") record.approvedReview.reviewDigest = "a".repeat(64);
    if (field === "requestEvidence") {
      record.reviewedProposal.proposal.requestReview.generation.body.model = "another-model";
      record.reviewedProposal.viewDigest = digest(
        providerReviewDigestInput(record.reviewedProposal),
      );
    }
    if (field === "reservation") {
      record.approvedReview.reservation.generationUnits = "5610001";
      record.approvedReview.reservation.reviewUnits = "5609999";
      record.approvedReview.reviewDigest = digest(
        providerPolicyReviewDigestInput(record.approvedReview),
      );
      record.command.approvedReviewDigest = record.approvedReview.reviewDigest;
      record.requestDigest = providerPolicyAdoptionRequestDigest(record.command);
    }
    if (field === "scope") record.command.candidateId = registry.entries[1].candidateId;
    if (field === "deadline") {
      record.approvedReview.expiresAt = "2026-09-27T03:14:59.000Z";
      record.approvedReview.reviewDigest = digest(
        providerPolicyReviewDigestInput(record.approvedReview),
      );
      record.command.approvedReviewDigest = record.approvedReview.reviewDigest;
      record.requestDigest = providerPolicyAdoptionRequestDigest(record.command);
    }
    if (field === "afterHead") record.budgetTransition.after.headDigest = "a".repeat(64);
    if (field === "recordedAt") record.recordedAt = record.approvedReview.expiresAt;
    if (field === "initializationNonce")
      record.budgetTransition.initializationRequestId = randomUUID();
    if (field === "permission") Object.assign(record, { dispatchAllowed: true });
    expect(compareProviderPolicyAdoptionRetry(input.command, reseal(record))).toBe(
      "invalid-record",
    );
  });
});
