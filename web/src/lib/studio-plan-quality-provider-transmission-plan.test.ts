import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderReservationMigrationCoverage,
  inspectProviderReservationArchive,
} from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import { providerExecutionOperationDigest } from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  fixture as reservationFixture,
  prepared as reserve,
  withRows,
  config,
  adopt,
  cancel,
} from "./studio-plan-quality-provider-reservation-test-helpers";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import {
  createProviderTransmissionReview,
  type ProviderTransmissionReviewInput,
} from "./studio-plan-quality-provider-transmission-review";
import {
  providerTransmissionReviewDigestInput,
  type ProviderTransmissionReview,
} from "./studio-plan-quality-provider-transmission-review-types";
import {
  providerTransmissionCommandSchema,
  type ProviderTransmissionCommand,
} from "./studio-plan-quality-provider-transmission-command";
import { providerTransmissionApprovalBindingSchema } from "./studio-plan-quality-provider-transmission-approval-types";
import {
  prepareProviderTransmissionApproval as prepare,
  providerTransmissionCommandDigest,
  providerTransmissionPlanLimits,
  type ProviderTransmissionPlannerInput,
  type ProviderTransmissionWritePlan,
} from "./studio-plan-quality-provider-transmission-plan";

vi.mock("./studio-plan-quality-store", () => {
  throw new Error("No database in pure planner");
});
vi.mock("./studio-provider-observation", () => {
  throw new Error("No provider in pure planner");
});
vi.mock("openai", () => {
  throw new Error("No SDK in pure planner");
});
const external = vi.fn(() => {
  throw new Error("No external call");
});
const inspectedAt = "2026-09-27T03:33:00.000Z",
  approvedAt = "2026-09-27T03:33:30.000Z",
  recordedAt = "2026-09-27T03:34:00.000Z";
const wrong = "a".repeat(64);
function review(current: ProviderTransmissionReviewInput) {
  const result = createProviderTransmissionReview(current);
  if (result.status !== "review") throw new Error(result.reason);
  return result.review;
}
function commandFor(v: ProviderTransmissionReview): ProviderTransmissionCommand {
  return providerTransmissionCommandSchema.parse({
    commandVersion: 1,
    kind: "approve-provider-transmission",
    clientRequestId: randomUUID(),
    runId: v.run.id,
    runDigest: v.run.runDigest,
    approvedReviewDigest: v.reviewDigest,
    expectedArchiveDigest: v.archiveDigest,
    expectedCoverageDigest: v.coverageDigest,
    expectedReservationBindingDigest: v.reservation.bindingDigest,
    expectedManifestDigest: v.manifest.manifestDigest,
    expectedRun: { revision: 0, snapshotDigest: v.run.snapshotDigest },
    expectedPolicyHead: v.policy.head,
    expectedPolicyReference: v.policy.reservedReference,
    expectedBudgetHead: { revision: v.budget.revision, headDigest: v.budget.headDigest },
    approval: {
      noticeVersion: 1,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: digest(v.retention),
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      acknowledgedCurrentPolicyAndBudget: true,
      approvedAt,
    },
  });
}
function fixture(configuration = config()) {
  const reservationInput = reservationFixture(configuration);
  const coverage = createProviderReservationMigrationCoverage(reservationInput.current.ledger);
  const reservation = reserve(reservationInput);
  withRows(reservationInput, reservation);
  const current = {
    selection: { runId: reservation.rows.run.id, runDigest: reservation.rows.run.runDigest },
    inspectedAt,
    configuration,
    archive: {
      ledger: reservationInput.current.ledger,
      coverage,
      records: [reservation.rows.binding],
    },
  };
  const value = review(current);
  const input = {
    command: commandFor(value),
    review: value,
    current: { ...current, inspectedAt: recordedAt },
    additionalUsedBytes: 0,
  };
  return { input, reservationInput, reservation };
}
type Fixture = ReturnType<typeof fixture>;
const base = fixture();
let f: Fixture;
beforeEach(() => {
  f = structuredClone(base);
  vi.stubGlobal("fetch", external);
});
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const denied = (input: ProviderTransmissionPlannerInput, reason: string) =>
  expect(prepare(input)).toEqual({ status: "refused", reason, plan: null });
function planned(input: ProviderTransmissionPlannerInput): ProviderTransmissionWritePlan {
  const result = prepare(input);
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function apply(input: ProviderTransmissionPlannerInput, plan: ProviderTransmissionWritePlan) {
  input.current.archive.ledger.events.push(plan.rows.event);
  input.current.archive.ledger.receipts.push(plan.rows.receipt);
}
function refresh() {
  f.input.review = review({ ...f.input.current, inspectedAt });
  f.input.command = commandFor(f.input.review);
}

it("prepares deterministic native approval and binding without IO, budget writes or grants", () => {
  const { input } = f,
    before = structuredClone(input);
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("Explicit clock required");
  });
  const plan = planned(input);
  expect(input).toEqual(before);
  expect(planned(input)).toEqual(plan);
  expect(Object.keys(plan.rows).sort()).toEqual(["binding", "event", "receipt"]);
  expect(plan).toMatchObject({
    status: "prepared-not-committed",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    transaction: "single-immediate-transaction-required",
    persistence: "audited-transmission-binding-transaction-required",
  });
  expect(plan.execution.payload).toMatchObject({
    kind: "transmission-approved",
    manifest: input.review.manifest,
    provenance: "explicit-user",
    approvedAt,
    expiresAt: input.review.expiresAt,
    budgetRevision: input.review.budget.revision,
    budgetDigest: input.review.budget.headDigest,
  });
  expect(plan.rows.event).toMatchObject({ revision: 1, previousEventDigest: null, recordedAt });
  expect(plan.rows.receipt.inputDigest).toBe(
    providerExecutionOperationDigest(input.command.runId, plan.execution),
  );
  expect(plan.rows.binding).toMatchObject({
    command: input.command,
    approvedReview: input.review,
    commandDigest: providerTransmissionCommandDigest(input.command),
    executionInputDigest: plan.rows.receipt.inputDigest,
    approvalEventDigest: plan.rows.event.eventDigest,
    recordedAt,
    dispatchAllowed: false,
  });
  expect(plan.rows.binding.commandDigest).not.toBe(plan.rows.receipt.inputDigest);
  expect(providerTransmissionApprovalBindingSchema.parse(plan.rows.binding)).toEqual(
    plan.rows.binding,
  );
  apply(input, plan);
  const next = inspectProviderReservationArchive(input.current.archive);
  expect(next.ledger.provider.snapshots[0]).toMatchObject({
    state: "approved",
    archiveFormatVersion: 3,
    revision: 1,
    // Native production history does not attest to measured provider calls.
    actualAiCalls: null,
    dispatchIntentCount: 0,
    responseCount: 0,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(input.current.archive.ledger.budgetEvents).toEqual(
    before.current.archive.ledger.budgetEvents,
  );
  expect(input.current.archive.ledger.runs).toEqual(before.current.archive.ledger.runs);
  expect(input.current.archive.records).toEqual(before.current.archive.records);
  expect(next.ledger.reservedBudgetEventSlots).toBe(15);
  expect(next.ledger.reservedReceiptSlots).toBe(62);
  expect(plan.capacity.totalExposureBytes).toBe(
    next.ledger.usedBytes + next.ledger.reservedBytes + next.usedBytes + plan.capacity.bindingBytes,
  );
});
it("retains original request/financial/retention timestamps and does not extend preparation expiry", () => {
  const plan = planned(f.input),
    prep = f.reservation.rows.run.preparation;
  expect(plan.execution.payload.manifest).toEqual(f.input.review.manifest);
  expect(plan.execution.payload.manifest.executionContract.usagePolicy.financialBasisDigest).toBe(
    prep.financialBasisDigest,
  );
  expect(plan.rows.binding.approvedReview.financialBasis.calculatedAt).toBe(prep.preparedAt);
  expect(plan.execution.payload.expiresAt).toBe(prep.expiresAt);
  expect(plan.execution.payload.acknowledgedRetentionNoticeDigest).toBe(prep.retentionDigest);
});
it("allows an intact already-funded reservation with zero available budget", () => {
  const configuration = config();
  configuration.proposedBudget.capUnits = "11220000";
  configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
  const { input } = fixture(configuration);
  expect(input.review.budget.availableUnits).toBe("0");
  expect(planned(input).budgetWriteAllowed).toBe(false);
});
it.each([
  "manifest",
  "configuration",
  "prices",
  "payload",
  "expiresAt",
  "dispatchAllowed",
  "budgetAction",
])("rejects client-supplied %s", (key) =>
  denied({ ...f.input, command: { ...f.input.command, [key]: true } }, "invalid-input"),
);
it.each([
  "acknowledgedExternalTransmission",
  "acknowledgedGenerationAndDerivedReview",
  "acknowledgedFinancialReservationNotTokenFit",
  "acknowledgedUnknownCostHoldAndNoRetry",
  "acknowledgedCurrentPolicyAndBudget",
])("requires explicit %s", (key) =>
  denied(
    {
      ...f.input,
      command: { ...f.input.command, approval: { ...f.input.command.approval, [key]: false } },
    },
    "invalid-input",
  ),
);
it.each(["runId", "runDigest"] as const)("rejects a changed %s selection", (key) => {
  f.input.command[key] = key === "runId" ? randomUUID() : wrong;
  denied(f.input, "selection-changed");
});
it.each([
  "archive",
  "coverage",
  "reservation",
  "manifest",
  "snapshot",
  "policy-head",
  "policy-reference",
  "budget",
  "retention",
])("rejects a changed %s command binding", (key) => {
  const c = f.input.command;
  if (key === "archive") c.expectedArchiveDigest = wrong;
  if (key === "coverage") c.expectedCoverageDigest = wrong;
  if (key === "reservation") c.expectedReservationBindingDigest = wrong;
  if (key === "manifest") c.expectedManifestDigest = wrong;
  if (key === "snapshot") c.expectedRun.snapshotDigest = wrong;
  if (key === "policy-head") c.expectedPolicyHead = { revision: 2, headDigest: wrong };
  if (key === "policy-reference") c.expectedPolicyReference.clientRequestId = randomUUID();
  if (key === "budget") c.expectedBudgetHead.revision++;
  if (key === "retention") c.approval.acknowledgedRetentionNoticeDigest = wrong;
  denied(f.input, "bindings-changed");
});
it.each(["policy", "reservation", "other"])("refuses a nonce already owned by %s", (owner) => {
  const state = inspectProviderReservationArchive(f.input.current.archive).ledger;
  f.input.command.clientRequestId =
    owner === "policy"
      ? state.policy.records[0].clientRequestId
      : owner === "reservation"
        ? f.reservation.rows.receipt.clientRequestId
        : f.input.current.archive.ledger.otherNonces![0];
  denied(f.input, "nonce-conflict");
});
it.each(["negative", "fraction", "missing"])(
  "requires explicit valid additional byte accounting: %s",
  (value) => {
    denied(
      {
        ...f.input,
        additionalUsedBytes:
          value === "negative" ? -1 : value === "fraction" ? 0.5 : (undefined as never),
      },
      "invalid-input",
    );
  },
);
it.each(["before-review", "after-now", "at-expiry"])("rejects approval time %s", (boundary) => {
  f.input.command.approval.approvedAt =
    boundary === "before-review"
      ? "2026-09-27T03:32:59.999Z"
      : boundary === "after-now"
        ? "2026-09-27T03:34:00.001Z"
        : f.input.review.expiresAt;
  denied(f.input, "approval-time-invalid");
});
it.each(["before-review", "at-expiry", "invalid"])("rejects current time %s", (boundary) => {
  f.input.current.inspectedAt =
    boundary === "before-review"
      ? "2026-09-27T03:32:59.999Z"
      : boundary === "at-expiry"
        ? f.input.review.expiresAt
        : "bad";
  denied(f.input, boundary === "invalid" ? "invalid-input" : "review-not-current");
});
it("accepts inclusive review/approval/recording start and exclusive expiry end", () => {
  f.input.command.approval.approvedAt = inspectedAt;
  f.input.current.inspectedAt = inspectedAt;
  expect(planned(f.input).rows.event.recordedAt).toBe(inspectedAt);
  f.input.command.approval.approvedAt = new Date(
    Date.parse(f.input.review.expiresAt) - 1,
  ).toISOString();
  f.input.current.inspectedAt = f.input.command.approval.approvedAt;
  expect(planned(f.input).execution.payload.expiresAt).toBe(f.input.review.expiresAt);
});
it.each(["review", "snapshot", "request", "manifest", "policy-reference"])(
  "rejects a rehashed %s forgery",
  (key) => {
    const v = f.input.review;
    if (key === "review") v.reviewDigest = wrong;
    if (key === "snapshot") v.run.snapshotDigest = wrong;
    if (key === "request") v.request.generation.body.input[1].content += " changed";
    if (key === "manifest") v.manifest.manifestDigest = wrong;
    if (key === "policy-reference") v.policy.reservedReference.clientRequestId = randomUUID();
    if (key !== "review") v.reviewDigest = digest(providerTransmissionReviewDigestInput(v));
    f.input.command = commandFor(v);
    expect(prepare(f.input).status).toBe("refused");
  },
);
it.each(["missing", "changed"])("requires current configuration: %s", (kind) => {
  if (kind === "missing") f.input.current.configuration = null as never;
  else {
    f.input.current.configuration.proposedBudget.capUnits = "30000000";
    f.input.current.configuration.configurationDigest = digest(
      providerConfigurationDigestInput(f.input.current.configuration),
    );
  }
  denied(f.input, "review-not-current");
});
it.each(["binding", "coverage", "receipt", "artifact"])(
  "audits the complete %s before planning",
  (kind) => {
    const a = f.input.current.archive;
    if (kind === "binding") a.records = [];
    if (kind === "coverage") a.coverage.coverageDigest = wrong;
    if (kind === "receipt") a.ledger.receipts.pop();
    if (kind === "artifact") (a.ledger.artifacts[0] as { body: string }).body += " ";
    denied(f.input, "archive-invalid");
  },
);
it.each(["same-candidate-policy", "other-candidate-policy", "other-nonce", "cancelled"])(
  "rejects the old review after %s",
  (change) => {
    if (change.endsWith("policy"))
      adopt(
        f.input.current.archive.ledger,
        change === "same-candidate-policy" ? 0 : 1,
        config(),
        inspectedAt,
      );
    if (change === "other-nonce") f.input.current.archive.ledger.otherNonces!.push(randomUUID());
    if (change === "cancelled") cancel(f.reservationInput, f.reservation);
    denied(f.input, "review-not-current");
  },
);
it("blocks a newly inspected policy replacement even when its review is current", () => {
  adopt(f.input.current.archive.ledger, 0, config(), inspectedAt);
  refresh();
  expect(f.input.review.assessment.blockers).toContain("policy-superseded");
  denied(f.input, "approval-blocked");
});
it("requires binding coverage for previously migrated unbound production reservations", () => {
  f.input.current.archive.coverage = createProviderReservationMigrationCoverage(
    f.input.current.archive.ledger,
  );
  f.input.current.archive.records = [];
  inspectProviderReservationArchive(f.input.current.archive);
  denied(f.input, "review-not-current");
});
it("never replans the same stored nonce, including after expiry or missing configuration", () => {
  const plan = planned(f.input);
  apply(f.input, plan);
  denied(f.input, "nonce-conflict");
  f.input.current.inspectedAt = "2027-01-01T00:00:00.000Z";
  f.input.current.configuration = null as never;
  denied(f.input, "nonce-conflict");
  expect(f.input.current.archive.ledger.events).toHaveLength(1);
  expect(plan.rows.binding.dispatchAllowed).toBe(false);
});
it("rejects a new nonce on an already approved run even with a fresh review", () => {
  apply(f.input, planned(f.input));
  f.input.review = review(f.input.current);
  f.input.command = commandFor(f.input.review);
  expect(f.input.review.assessment.blockers).toEqual(["run-not-reserved"]);
  denied(f.input, "approval-blocked");
});
it("keeps full command identity distinct when two valid reviews yield the same native approval", () => {
  const first = planned(f.input),
    next = structuredClone(f.input);
  next.review = review({ ...next.current, inspectedAt: "2026-09-27T03:33:01.000Z" });
  next.command = { ...commandFor(next.review), clientRequestId: next.command.clientRequestId };
  const second = planned(next);
  expect(first.rows.receipt.inputDigest).toBe(second.rows.receipt.inputDigest);
  expect(first.rows.binding.commandDigest).not.toBe(second.rows.binding.commandDigest);
  expect(first.rows.binding.recordDigest).not.toBe(second.rows.binding.recordDigest);
  expect(first.rows.binding.approvedReview.reviewDigest).not.toBe(
    second.rows.binding.approvedReview.reviewDigest,
  );
});
it("accounts for all existing v8 bindings and additional DB bytes at the exact capacity boundary", () => {
  const first = planned(f.input);
  f.input.additionalUsedBytes =
    providerTransmissionPlanLimits.databaseBytes - first.capacity.totalExposureBytes;
  expect(planned(f.input).capacity.totalExposureBytes).toBe(
    providerTransmissionPlanLimits.databaseBytes,
  );
  f.input.additionalUsedBytes++;
  denied(f.input, "capacity-exceeded");
  f.input.additionalUsedBytes = Number.MAX_SAFE_INTEGER;
  denied(f.input, "capacity-exceeded");
});
it("rejects second-revision commands, unknown consent keys and inconsistent policy references", () => {
  expect(
    providerTransmissionCommandSchema.safeParse({
      ...f.input.command,
      expectedRun: { ...f.input.command.expectedRun, revision: 1 },
    }).success,
  ).toBe(false);
  expect(
    providerTransmissionCommandSchema.safeParse({
      ...f.input.command,
      approval: { ...f.input.command.approval, granted: true },
    }).success,
  ).toBe(false);
  expect(
    providerTransmissionCommandSchema.safeParse({
      ...f.input.command,
      expectedPolicyReference: { ...f.input.command.expectedPolicyReference, revision: 2 },
    }).success,
  ).toBe(false);
  expect(() => providerTransmissionCommandDigest({ ...f.input.command, native: true })).toThrow();
});
