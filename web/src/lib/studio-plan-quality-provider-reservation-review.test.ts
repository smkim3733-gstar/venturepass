import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestRegistry, actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { prepareProviderPolicyAdoption } from "./studio-plan-quality-provider-policy-adoption";
import {
  providerPolicyAdoptionCommandSchema,
  type ProviderPolicyAdoptionRecord,
} from "./studio-plan-quality-provider-policy-adoption-types";
import { createProviderPreparation } from "./studio-plan-quality-provider-core";
import * as providerCore from "./studio-plan-quality-provider-core";
import {
  providerTestFinancialInput,
  providerTestExpires,
} from "./studio-plan-quality-provider-test-helpers";
import type {
  ProviderRun,
  ProviderRunEvent,
  ProviderBudgetEvent,
  ProviderReceipt,
  ProviderArtifact,
  ProviderStart,
  ProviderEnvironment,
} from "./studio-plan-quality-provider-types";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
  providerBudgetScope,
  createProviderBudgetEvent,
  validateProviderBudgetLedger,
  createProviderReceipt,
  providerPolicyDigestInput,
  createProviderRun,
  createProviderArtifact,
  providerStartDigestInput,
  providerCancelDigestInput,
  createProviderRunEvent,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderReservationReview,
  isProviderReservationReviewCurrent,
  type ProviderReservationReviewInput,
} from "./studio-plan-quality-provider-reservation-review";
import {
  providerReservationReviewSchema,
  providerReservationReviewDigestInput,
} from "./studio-plan-quality-provider-reservation-review-types";

function configurationFixture() {
  const value = getProviderConfigurationProposal();
  if (!value) throw new Error("Missing fixture configuration");
  return value;
}
const registry = actualTestRegistry();
const recordedAt = "2026-09-27T03:01:00.000Z";
const now = "2026-09-27T03:30:00.000Z";
type Ledger = {
  runs: ProviderRun[];
  events: ProviderRunEvent[];
  artifacts: ProviderArtifact[];
  budgetEvents: ProviderBudgetEvent[];
  receipts: ProviderReceipt[];
  policies: ProviderPolicyAdoptionRecord[];
  registries: (typeof registry)[];
  otherNonces: string[];
};
const empty = (): Ledger => ({
  runs: [],
  events: [],
  artifacts: [],
  budgetEvents: [],
  receipts: [],
  policies: [],
  registries: [registry],
  otherNonces: [],
});
const input = (ledger = empty(), index = 0): ProviderReservationReviewInput => ({
  selection: {
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[index].candidateId,
  },
  inspectedAt: now,
  configuration: configurationFixture(),
  ledger,
});
const budget = (ledger: Ledger, environment: ProviderEnvironment = "production") =>
  validateProviderBudgetLedger(
    ledger.budgetEvents.filter((row) => row.environment === environment),
    providerBudgetScope(environment),
  );
// Wire-format fixtures in memory only. These are not real consent, committed DB records or paid calls.
function configure(
  ledger: Ledger,
  capUnits: string,
  currency = "USD",
  environment: ProviderEnvironment = "production",
) {
  const clientRequestId = randomUUID(),
    scopeId = providerBudgetScope(environment);
  const policy = {
    environment,
    provenance:
      environment === "production" ? ("explicit-user" as const) : ("synthetic-test" as const),
    currency,
    unitScale: 6,
    capUnits,
  };
  const event = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId,
    environment,
    provenance: policy.provenance,
    revision: 1,
    previousDigest: null,
    eventId: clientRequestId,
    recordedAt: actualTestNow,
    currency,
    unitScale: 6,
    payload: { kind: "configure", capUnits },
  });
  ledger.budgetEvents.push(event);
  ledger.receipts.push(
    createProviderReceipt({
      schemaVersion: 2,
      scopeId,
      kind: "provider-budget-configure",
      clientRequestId,
      inputDigest: digest(
        providerPolicyDigestInput({ clientRequestId, expectedRevision: 0, policy }),
      ),
      runId: null,
      runRevision: null,
      budgetRevision: 1,
      operationDigest: event.eventDigest,
      recordedAt: event.recordedAt,
    }),
  );
}
function adopt(ledger: Ledger, index = 0, configuration = configurationFixture()) {
  const b = budget(ledger);
  const current = {
    registry,
    candidateId: registry.entries[index].candidateId,
    inspectedAt: recordedAt,
    configuration,
    budgetEvents: ledger.budgetEvents.filter((row) => row.environment === "production"),
    expectedBudgetHead: { revision: b.revision, headDigest: b.headDigest },
  };
  const result = createProviderPolicyReview(current);
  if (result.status !== "review") throw new Error(result.reason);
  const head = {
    revision: ledger.policies.length,
    headDigest: ledger.policies.at(-1)?.recordDigest ?? null,
  };
  const command = providerPolicyAdoptionCommandSchema.parse({
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: current.candidateId,
    expectedPolicyHead: head,
    approvedReviewDigest: result.review.reviewDigest,
    budgetAction: b.revision ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: b.revision ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: recordedAt,
    },
  });
  const planned = prepareProviderPolicyAdoption({
    command,
    review: result.review,
    current: { ...current, inspectedAt: recordedAt },
    currentPolicyHead: head,
    usedRequestIds: [
      ...ledger.policies.map((row) => row.clientRequestId),
      ...ledger.receipts.map((row) => row.clientRequestId),
    ],
  });
  if (planned.status !== "prepared") throw new Error(planned.reason);
  ledger.policies.push(planned.plan.record);
  if (planned.plan.initialization) {
    ledger.budgetEvents.push(planned.plan.initialization.event);
    ledger.receipts.push(planned.plan.initialization.receipt);
  }
  return planned.plan.record;
}
function start(ledger: Ledger, index = 0, environment: ProviderEnvironment = "production") {
  const config = configurationFixture(),
    b = budget(ledger, environment);
  const at = "2026-09-27T03:02:00.000Z";
  const synthetic = environment === "synthetic-test";
  const financialInput = synthetic
    ? { ...providerTestFinancialInput(), calculatedAt: at }
    : {
        evidenceMode: "official-reviewed" as const,
        model: config.model,
        calculatedAt: at,
        outputReservationTokens: config.outputReservationTokens,
        conditions: config.conditions,
        context: config.context,
        pricing: config.pricing,
      };
  const preparation = createProviderPreparation({
    registry,
    candidateId: registry.entries[index].candidateId,
    environment,
    preparedAt: at,
    expiresAt: synthetic ? providerTestExpires : "2026-09-27T03:10:00.000Z",
    financialInput,
    budget: {
      scopeId: b.scopeId,
      revision: b.revision,
      headDigest: b.headDigest!,
      currency: b.currency!,
      unitScale: b.unitScale!,
      capUnits: b.capUnits,
      heldUnits: b.heldUnits,
      recognizedUnits: b.recognizedUnits,
    },
    retention: synthetic
      ? {
          policyVersion: "synthetic-v2",
          notice: "합성 보관 조건",
          sourceUrl: "https://example.invalid/retention",
          documentDigest: "b".repeat(64),
          reviewedAt: actualTestNow,
          validUntil: providerTestExpires,
        }
      : config.retention,
  });
  const startInput: ProviderStart = {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: b.revision,
    expectedBudgetDigest: b.headDigest!,
    expectedGlobalRunCount: ledger.runs.length,
    expectedScopeRunCount: ledger.runs.filter((row) => row.environment === environment).length,
    preparation,
    approval: {
      provenance: synthetic ? "synthetic-test" : "explicit-user",
      approvedPreparationDigest: preparation.preparationDigest,
      approvedAt: at,
      expiresAt: preparation.expiresAt,
      acknowledgedReservationOnly: true,
      acknowledgedFinancialBasisNotTokenFit: true,
      acknowledgedRetention: true,
      acknowledgedNoAutomaticRetry: true,
    },
  };
  const id = randomUUID(),
    costs = preparation.financialBasis.costs!;
  const reservation = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: b.scopeId,
    environment,
    provenance: startInput.approval.provenance,
    revision: b.revision + 1,
    previousDigest: b.headDigest,
    eventId: startInput.clientRequestId,
    recordedAt: at,
    currency: b.currency!,
    unitScale: b.unitScale!,
    payload: {
      kind: "reserve-run",
      runId: id,
      preparationDigest: preparation.preparationDigest,
      generationUnits: costs.generation.totalUnits,
      reviewUnits: costs.review.totalUnits,
    },
  });
  const run = createProviderRun({ input: startInput, id, recordedAt: at, reservation });
  ledger.runs.push(run);
  ledger.budgetEvents.push(reservation);
  ledger.artifacts.push(
    createProviderArtifact({ runId: id, body: JSON.stringify(preparation.generation.body) }),
  );
  ledger.receipts.push(
    createProviderReceipt({
      schemaVersion: 2,
      scopeId: b.scopeId,
      kind: "provider-start",
      clientRequestId: startInput.clientRequestId,
      inputDigest: digest(providerStartDigestInput(startInput)),
      runId: id,
      runRevision: 0,
      budgetRevision: reservation.revision,
      operationDigest: run.runDigest,
      recordedAt: at,
    }),
  );
  return run;
}
function cancel(ledger: Ledger, run: ProviderRun) {
  const b = budget(ledger, run.environment),
    costs = run.preparation.financialBasis.costs!;
  const command = {
    clientRequestId: randomUUID(),
    expectedRevision: 0 as const,
    reason: "test-cleanup" as const,
  };
  const release = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: b.scopeId,
    environment: run.environment,
    provenance: run.approval.provenance,
    revision: b.revision + 1,
    previousDigest: b.headDigest,
    eventId: command.clientRequestId,
    recordedAt: run.recordedAt,
    currency: b.currency!,
    unitScale: b.unitScale!,
    payload: {
      kind: "release-run",
      runId: run.id,
      reservationDigest: run.reservationDigest,
      generationUnits: costs.generation.totalUnits,
      reviewUnits: costs.review.totalUnits,
      reason: "cancelled-before-dispatch",
    },
  });
  const event = createProviderRunEvent({
    schemaVersion: 2,
    runId: run.id,
    revision: 1,
    budgetRevision: release.revision,
    previousEventDigest: null,
    recordedAt: run.recordedAt,
    payload: {
      kind: "cancelled-before-dispatch",
      reason: command.reason,
      releaseBudgetEventDigest: release.eventDigest,
    },
  });
  ledger.budgetEvents.push(release);
  ledger.events.push(event);
  ledger.receipts.push(
    createProviderReceipt({
      schemaVersion: 2,
      scopeId: b.scopeId,
      kind: "provider-cancel",
      clientRequestId: command.clientRequestId,
      inputDigest: digest(providerCancelDigestInput(run.id, command)),
      runId: run.id,
      runRevision: 1,
      budgetRevision: release.revision,
      operationDigest: event.eventDigest,
      recordedAt: run.recordedAt,
    }),
  );
}
function review(value: ProviderReservationReviewInput) {
  const result = createProviderReservationReview(value);
  if (result.status !== "review") throw new Error(result.reason);
  return result.review;
}
function configuredInput() {
  const ledger = empty();
  adopt(ledger);
  return { ledger, value: input(ledger) };
}
function changedConfig() {
  const configuration = configurationFixture();
  configuration.proposedBudget.capUnits = "16000000";
  configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
  return configuration;
}
const forbidden = vi.fn(() => {
  throw new Error("No credential, storage or network access");
});
let environment: NodeJS.ProcessEnv;
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  environment = process.env;
  process.env = new Proxy(environment, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(OPENAI|VENTURE_DATA_DIR)/.test(key)) return forbidden();
      return Reflect.get(target, key, receiver);
    },
  });
});
afterEach(() => {
  process.env = environment;
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("adopted policy reservation review", () => {
  it("reports absent adoption and budget without substituting the proposed cap", () => {
    const value = review(input());
    expect(value.assessment).toEqual({
      state: "blocked",
      blockers: ["policy-not-adopted", "budget-not-configured"],
    });
    expect(value.policyReview.budget.availableUnits).toBe("0");
  });
  it("matches frozen evidence after the consumed approval expires and uses the current budget", () => {
    const { value, ledger } = configuredInput(),
      before = JSON.stringify(value),
      result = review(value);
    expect(Date.parse(now)).toBeGreaterThan(
      Date.parse(ledger.policies[0].approvedReview.expiresAt),
    );
    expect(result.policy.state).toBe("matched");
    expect(result.assessment).toEqual({ state: "conditions-met", blockers: [] });
    expect(ledger.policies[0].approvedReview.budget.revision).toBe(0);
    expect(result.policyReview.budget).toMatchObject({
      revision: 1,
      capUnits: "15000000",
      heldUnits: "0",
      availableUnits: "15000000",
    });
    expect(Object.values(result.actions)).toEqual([false, false, false]);
    expect(result.policyReview.accountAccess).toBe("not-checked");
    expect(result.reviewDigest).toBe(digest(providerReservationReviewDigestInput(result)));
    expect(review(value)).toEqual(result);
    expect(JSON.stringify(value)).toBe(before);
  });
  it("does not treat another candidate's adoption as this candidate's approval", () => {
    const { ledger } = configuredInput();
    expect(review(input(ledger, 1)).policy.state).toBe("not-adopted");
  });
  it("preserves the latest matching candidate reference while another candidate advances the global head", () => {
    const { value, ledger } = configuredInput();
    adopt(ledger, 1);
    const result = review(value);
    expect(result.policy).toMatchObject({ state: "matched", reference: { revision: 1 } });
    expect(result.policyHead.revision).toBe(2);
  });
  it("never falls back to an older matching record when this candidate adopted different conditions", () => {
    const { value, ledger } = configuredInput();
    adopt(ledger, 0, changedConfig());
    expect(review(value).policy).toMatchObject({ state: "changed", reference: { revision: 2 } });
    expect(review(value).assessment.blockers).toEqual(["policy-changed"]);
  });
  it("requires renewed adoption when the current server configuration changes", () => {
    const { value } = configuredInput();
    value.configuration = changedConfig();
    expect(review(value).assessment.blockers).toEqual(["policy-changed"]);
  });
  it("detects an exact request change even when the fixed configuration is unchanged", () => {
    const { value } = configuredInput();
    const original = providerCore.createProviderRequestReview;
    vi.spyOn(providerCore, "createProviderRequestReview").mockImplementation((input) => {
      const request = original(input);
      const body = {
        ...request.generation.body,
        input: request.generation.body.input.map((item, index) =>
          index === 0 ? { ...item, content: item.content + "\nSynthetic prompt revision." } : item,
        ),
      };
      return {
        ...request,
        generation: {
          ...request.generation,
          body,
          requestDigest: providerWireDigest(body),
          sha256: providerRawDigest(JSON.stringify(body)),
          inputChars: request.generation.inputChars + 27,
        },
      };
    });
    expect(review(value).assessment.blockers).toEqual(["policy-changed"]);
  });
  it("a current blocked review remains informational and grants no reservation capability", () => {
    const value = input(),
      result = review(value);
    expect(isProviderReservationReviewCurrent(result, value)).toBe(true);
    expect(result.assessment.state).toBe("blocked");
    expect(Object.values(result.actions)).toEqual([false, false, false]);
  });
  it("deducts current reservations and blocks the same unresolved candidate", () => {
    const { ledger, value } = configuredInput();
    const run = start(ledger);
    const before = JSON.stringify(ledger),
      result = review(value);
    expect(result.policyReview.budget).toMatchObject({
      revision: 2,
      heldUnits: "11220000",
      availableUnits: "3780000",
    });
    expect(result.assessment.blockers).toEqual(["budget-insufficient", "candidate-unsettled"]);
    expect(result.runs.unsettledCandidateRunIds).toEqual([run.id]);
    expect(JSON.stringify(ledger)).toBe(before);
  });
  it("counts another candidate's held cost without marking this candidate unsettled", () => {
    const { ledger, value } = configuredInput();
    start(ledger, 1);
    expect(review(value).assessment.blockers).toEqual(["budget-insufficient"]);
  });
  it("uses validated cancellation evidence to release held cost and candidate blocking", () => {
    const { ledger, value } = configuredInput();
    cancel(ledger, start(ledger));
    const result = review(value);
    expect(result.assessment.blockers).toEqual([]);
    expect(result.policyReview.budget).toMatchObject({
      revision: 3,
      heldUnits: "0",
      availableUnits: "15000000",
    });
    expect(result.runs).toEqual({
      globalCount: 1,
      productionCount: 1,
      unsettledCandidateRunIds: [],
    });
  });
  it("keeps synthetic reservations out of production budgets and candidate blocking", () => {
    const { ledger, value } = configuredInput();
    configure(ledger, "100", "TST", "synthetic-test");
    start(ledger, 0, "synthetic-test");
    const result = review(value);
    expect(result.assessment.blockers).toEqual([]);
    expect(result.runs).toEqual({
      globalCount: 1,
      productionCount: 0,
      unsettledCandidateRunIds: [],
    });
    expect(result.policyReview.budget.availableUnits).toBe("15000000");
  });
  it("blocks the shared run limit even when all twenty production reservations were cancelled", () => {
    const { ledger, value } = configuredInput();
    for (let i = 0; i < 20; i++) cancel(ledger, start(ledger));
    expect(review(value).assessment.blockers).toEqual(["run-limit"]);
  }, 30000);
  it("keeps an adopted insufficient existing budget unchanged", () => {
    const ledger = empty();
    configure(ledger, "1000000");
    adopt(ledger);
    expect(review(input(ledger)).assessment.blockers).toEqual(["budget-insufficient"]);
    expect(ledger.budgetEvents).toHaveLength(1);
  });
  it("shows incompatible budget separately when there is no adopted policy", () => {
    const ledger = empty();
    configure(ledger, "15000000", "EUR");
    expect(review(input(ledger)).assessment.blockers).toEqual([
      "policy-not-adopted",
      "budget-incompatible",
    ]);
  });
  it.each(["policy", "receipt", "artifact", "orphan-reservation", "nonce"])(
    "rejects invalid %s evidence before returning a review",
    (corruption) => {
      const { ledger, value } = configuredInput();
      if (corruption === "policy") ledger.policies[0].recordDigest = "a".repeat(64);
      if (corruption === "receipt") ledger.receipts = [];
      if (corruption === "artifact") {
        start(ledger, 1);
        ledger.artifacts[0].body += "changed";
      }
      if (corruption === "orphan-reservation") {
        start(ledger);
        ledger.runs = [];
      }
      if (corruption === "nonce") ledger.otherNonces.push(ledger.policies[0].clientRequestId);
      expect(createProviderReservationReview(value)).toMatchObject({
        status: "unavailable",
        reason: "ledger-invalid",
        review: null,
      });
    },
  );
  it("rejects records from after the inspection instant", () => {
    const { value } = configuredInput();
    value.inspectedAt = actualTestNow;
    expect(createProviderReservationReview(value)).toMatchObject({
      reason: "ledger-after-inspection",
    });
  });
  it.each(["version", "digest", "candidate", "field"])("rejects invalid selection %s", (field) => {
    const { value } = configuredInput();
    const selection = value.selection as Record<string, unknown>;
    if (field === "version") selection.version = 2;
    if (field === "digest") selection.versionDigest = "a".repeat(64);
    if (field === "candidate") selection.candidateId = "missing";
    if (field === "field") selection.approved = true;
    expect(createProviderReservationReview(value)).toMatchObject({ reason: "selection-invalid" });
  });
  it("rejects damaged current configuration and expired official evidence", () => {
    const { value } = configuredInput();
    const config = configurationFixture();
    value.configuration = { ...config, configurationDigest: "a".repeat(64) };
    expect(createProviderReservationReview(value)).toMatchObject({
      reason: "configuration-missing-or-invalid",
    });
    value.configuration = config;
    value.inspectedAt = config.sources.map((row) => row.validUntil).sort()[0];
    expect(createProviderReservationReview(value)).toMatchObject({
      reason: "configuration-expired",
    });
  });
  it("rejects malformed inspection time", () => {
    expect(createProviderReservationReview({ ...input(), inspectedAt: "tomorrow" })).toMatchObject({
      reason: "inspection-invalid",
    });
  });
  it("validates current evidence only within the new review's own time window", () => {
    const { value } = configuredInput(),
      result = review(value);
    expect(isProviderReservationReviewCurrent(result, value)).toBe(true);
    expect(
      isProviderReservationReviewCurrent(result, {
        ...value,
        inspectedAt: "2026-09-27T03:31:00.000Z",
      }),
    ).toBe(true);
    expect(
      isProviderReservationReviewCurrent(result, { ...value, inspectedAt: actualTestNow }),
    ).toBe(false);
    expect(
      isProviderReservationReviewCurrent(result, {
        ...value,
        inspectedAt: result.policyReview.expiresAt,
      }),
    ).toBe(false);
  });
  it.each(["policy", "budget", "configuration", "other-nonce"])(
    "invalidates a previous review after %s changes",
    (change) => {
      const { ledger, value } = configuredInput(),
        result = review(value);
      if (change === "policy") adopt(ledger, 1);
      if (change === "budget") start(ledger, 1);
      if (change === "configuration") value.configuration = changedConfig();
      if (change === "other-nonce") ledger.otherNonces.push(randomUUID());
      expect(isProviderReservationReviewCurrent(result, value)).toBe(false);
    },
  );
  it.each(["grant", "state", "count", "reference", "extra", "digest"])(
    "rejects altered review %s",
    (change) => {
      const { value } = configuredInput();
      const result = review(value);
      const changed = JSON.parse(JSON.stringify(result));
      if (change === "grant") changed.actions.dispatchAllowed = true;
      if (change === "state") changed.assessment.blockers = ["policy-not-adopted"];
      if (change === "count") changed.runs.productionCount = 1;
      if (change === "reference") changed.policy.reference.revision = 2;
      if (change === "extra") changed.approved = true;
      if (change === "digest") changed.reviewDigest = "a".repeat(64);
      else changed.reviewDigest = digest(providerReservationReviewDigestInput(changed));
      if (change !== "digest")
        expect(providerReservationReviewSchema.safeParse(changed).success).toBe(false);
      expect(isProviderReservationReviewCurrent(changed, value)).toBe(false);
    },
  );
});
