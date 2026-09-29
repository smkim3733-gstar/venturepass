import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  providerDigest as digest,
  createProviderBudgetEvent,
  createProviderReceipt,
  providerPolicyDigestInput,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderReservationMigrationCoverage,
  inspectProviderReservationArchive,
} from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  createProviderExecutionArtifact,
  createProviderExecutionBudgetEvent,
  providerUsageRecognitionPayload,
  providerExecutionOperationDigest,
  getProviderExecutionBudgetSnapshot,
  validateProviderExecutionManifest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  ProviderExecutionPayload,
  ProviderExecutionArtifact,
} from "./studio-plan-quality-provider-execution-types";
import {
  assessProviderUsage,
  providerResponseMetadata,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { createProviderConfigurationProposalView } from "./studio-plan-quality-provider-configuration";
import {
  providerConfigurationDigestInput,
  providerProposalSourceDigestInput,
} from "./studio-plan-quality-provider-review-types";
import { createProviderReservationReview } from "./studio-plan-quality-provider-reservation-review";
import {
  fixture,
  prepared,
  withRows,
  config,
  adopt,
  cancel,
  registry,
  refresh,
} from "./studio-plan-quality-provider-reservation-test-helpers";
import {
  createProviderTransmissionReview,
  isProviderTransmissionReviewCurrent,
  type ProviderTransmissionReviewInput,
} from "./studio-plan-quality-provider-transmission-review";
import {
  providerTransmissionReviewSchema,
  providerTransmissionReviewDigestInput,
} from "./studio-plan-quality-provider-transmission-review-types";

vi.mock("./studio-plan-quality-store", () => {
  throw new Error("No database access in pure review");
});
vi.mock("./studio-provider-observation", () => {
  throw new Error("No provider access in pure review");
});
const now = "2026-09-27T03:33:00.000Z";
function transmissionFixture(configuration = config()) {
  const input = fixture(configuration);
  const coverage = createProviderReservationMigrationCoverage(input.current.ledger);
  const plan = prepared(input);
  withRows(input, plan);
  const current = {
    selection: { runId: plan.rows.run.id, runDigest: plan.rows.run.runDigest },
    inspectedAt: now,
    configuration,
    archive: { ledger: input.current.ledger, coverage, records: [plan.rows.binding] },
  };
  return { input, plan, current };
}
type Fixture = ReturnType<typeof transmissionFixture>;
function review(current: ProviderTransmissionReviewInput) {
  const result = createProviderTransmissionReview(current);
  if (result.status !== "review") throw new Error(result.reason);
  return result.review;
}
const reject = (current: ProviderTransmissionReviewInput, reason: string) =>
  expect(createProviderTransmissionReview(current)).toEqual({
    status: "unavailable",
    reason,
    review: null,
  });
function resign(configuration: ReturnType<typeof config>) {
  configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
  return configuration;
}
function addEvent(
  f: Fixture,
  payload: ProviderExecutionPayload,
  kind:
    | "provider-approve"
    | "provider-prepared"
    | "provider-dispatch"
    | "provider-finish"
    | "provider-response",
  artifact?: ProviderExecutionArtifact,
  clientRequestId = randomUUID(),
) {
  const ledger = f.current.archive.ledger,
    run = f.plan.rows.run;
  const events = (ledger.events as ProviderExecutionEvent[]).filter((row) => row.runId === run.id);
  const b = getProviderExecutionBudgetSnapshot(
    (ledger.budgetEvents as Parameters<typeof getProviderExecutionBudgetSnapshot>[0]).filter(
      (row) => row.scopeId === run.preparation.budget.scopeId,
    ),
    run.preparation.budget.scopeId,
  );
  const commandPayload = Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) =>
        !["releasedBudgetEventDigests", "usageAssessment", "usageBudgetEventDigest"].includes(key),
    ),
  );
  const command = {
    clientRequestId,
    expectedRevision: events.length,
    payload: commandPayload,
    ...(artifact ? { artifact } : {}),
  } as ProviderExecutionCommand;
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: run.id,
    revision: events.length + 1,
    budgetRevision: b.revision,
    previousEventDigest: events.at(-1)?.eventDigest ?? null,
    recordedAt: now,
    payload,
  });
  ledger.events.push(event);
  if (artifact) ledger.artifacts.push(artifact);
  ledger.receipts.push(
    createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: b.scopeId,
      kind,
      clientRequestId,
      inputDigest: providerExecutionOperationDigest(run.id, command),
      runId: run.id,
      runRevision: event.revision,
      budgetRevision: b.revision,
      operationDigest: event.eventDigest,
      recordedAt: now,
    }),
  );
  return event;
}
function approve(f: Fixture) {
  const v = review(f.current);
  return addEvent(
    f,
    {
      kind: "transmission-approved",
      manifest: v.manifest,
      provenance: "explicit-user",
      approvedAt: now,
      expiresAt: v.expiresAt,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: f.plan.rows.run.preparation.retentionDigest,
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      budgetRevision: v.budget.revision,
      budgetDigest: v.budget.headDigest!,
    },
    "provider-approve",
  );
}
function dispatchGeneration(f: Fixture) {
  const approval = approve(f),
    p = f.plan.rows.run.preparation,
    budget = review(f.current).budget;
  const preparedEvent = addEvent(
    f,
    {
      kind: "request-prepared",
      phase: "generation",
      requestDigest: p.generation.requestDigest,
      artifactSha256: p.generation.sha256,
      derivedFrom: null,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
    "provider-prepared",
  );
  return addEvent(
    f,
    {
      kind: "dispatch-intent",
      phase: "generation",
      requestDigest: p.generation.requestDigest,
      artifactSha256: p.generation.sha256,
      preparedEventDigest: preparedEvent.eventDigest,
      approvalEventDigest: approval.eventDigest,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
    "provider-dispatch",
  );
}
const external = vi.fn(() => {
  throw new Error("No external calls");
});
beforeEach(() => {
  external.mockClear();
  vi.stubGlobal("fetch", external);
});
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reviews an existing reservation without reserving it again or granting transmission", () => {
  const f = transmissionFixture(),
    before = structuredClone(f),
    v = review(f.current);
  expect(f).toEqual(before);
  expect(v.assessment).toEqual({ state: "conditions-met", blockers: [] });
  expect(v.actions).toEqual({
    approvalWriteAllowed: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  expect(v.budget).toMatchObject({
    capUnits: "15000000",
    heldUnits: "11220000",
    availableUnits: "3780000",
    revision: 2,
  });
  expect(v.request.generation).toEqual(f.plan.rows.run.preparation.generation);
  expect(v.request.reviewTemplate).toEqual(f.plan.rows.run.preparation.reviewTemplate);
  expect(v.reservation.bindingDigest).toBe(f.plan.rows.binding.recordDigest);
  expect(v.coverageDigest).toBe(f.current.archive.coverage.coverageDigest);
  expect(v.archiveDigest).toBe(digest(f.current.archive));
  expect(v.reviewDigest).toBe(digest(providerTransmissionReviewDigestInput(v)));
  expect(createProviderReservationReview({ ...f.input.current, inspectedAt: now })).toMatchObject({
    status: "review",
    review: {
      assessment: {
        state: "blocked",
        blockers: expect.arrayContaining(["candidate-unsettled", "budget-insufficient"]),
      },
    },
  });
});
it("binds the existing native manifest to the ORIGINAL financial calculation instant", () => {
  const f = transmissionFixture(),
    v = review(f.current),
    prep = f.plan.rows.run.preparation;
  const freshlyCalculated = createProviderConfigurationProposalView({
    registry,
    candidateId: prep.scope.candidateId,
    inspectedAt: now,
    configuration: f.current.configuration,
  })!;
  expect(v.financialBasis.calculatedAt).toBe(prep.preparedAt);
  expect(v.financialBasis.calculatedAt).not.toBe(now);
  expect(v.manifest.executionContract.usagePolicy.financialBasisDigest).toBe(
    prep.financialBasisDigest,
  );
  expect(v.manifest.executionContract.usagePolicy.financialBasisDigest).not.toBe(
    freshlyCalculated.proposal.usagePolicy.financialBasisDigest,
  );
  expect(validateProviderExecutionManifest(f.plan.rows.run, v.manifest)).toEqual(v.manifest);
  expect(v.expiresAt).toBe(prep.expiresAt);
});
it("allows the already held run when remaining unreserved budget is zero", () => {
  const configuration = config();
  configuration.proposedBudget.capUnits = "11220000";
  const f = transmissionFixture(resign(configuration)),
    v = review(f.current);
  expect(v.budget.availableUnits).toBe("0");
  expect(v.assessment.state).toBe("conditions-met");
});
it("does not use the machine clock or mutate inputs", () => {
  const f = transmissionFixture();
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("Use explicit inspection time");
  });
  expect(review(f.current).assessment.state).toBe("conditions-met");
});
it("blocks cancelled reservations while preserving their original request and released budget", () => {
  const f = transmissionFixture();
  cancel(f.input, f.plan);
  const v = review(f.current);
  expect(v.run.state).toBe("cancelled-before-dispatch");
  expect(v.assessment.blockers).toEqual(["run-not-reserved", "reservation-not-intact"]);
  expect(v.reservation.heldUnits).toBe("0");
  expect(v.budget.availableUnits).toBe("15000000");
});
it.each(["approved", "prepared", "dispatching"])(
  "blocks a second approval when the existing execution is %s",
  (target) => {
    const f = transmissionFixture(),
      approval = approve(f),
      p = f.plan.rows.run.preparation;
    if (target !== "approved") {
      const preparedEvent = addEvent(
        f,
        {
          kind: "request-prepared",
          phase: "generation",
          requestDigest: p.generation.requestDigest,
          artifactSha256: p.generation.sha256,
          derivedFrom: null,
          budgetRevision: 2,
          budgetDigest: f.plan.rows.budgetEvent.eventDigest,
        },
        "provider-prepared",
      );
      if (target === "dispatching")
        addEvent(
          f,
          {
            kind: "dispatch-intent",
            phase: "generation",
            requestDigest: p.generation.requestDigest,
            artifactSha256: p.generation.sha256,
            preparedEventDigest: preparedEvent.eventDigest,
            approvalEventDigest: approval.eventDigest,
            budgetRevision: 2,
            budgetDigest: f.plan.rows.budgetEvent.eventDigest,
          },
          "provider-dispatch",
        );
    }
    const v = review(f.current);
    expect(v.run.state).toBe(target);
    expect(v.assessment.blockers).toEqual(["run-not-reserved"]);
    expect(v.reservation.heldUnits).toBe("11220000");
  },
);
it("does not promote a historical production run from migration coverage to a bound reservation", () => {
  const f = transmissionFixture();
  f.current.archive.coverage = createProviderReservationMigrationCoverage(f.current.archive.ledger);
  f.current.archive.records = [];
  expect(inspectProviderReservationArchive(f.current.archive).records).toEqual([]);
  reject(f.current, "reservation-binding-required");
});
it.each(["before-dispatch", "result-unobserved"] as const)(
  "keeps a terminal %s run blocked without reusing its remaining reservation",
  (outcome) => {
    const f = transmissionFixture(),
      run = f.plan.rows.run,
      ledger = f.current.archive.ledger;
    if (outcome === "result-unobserved") dispatchGeneration(f);
    else approve(f);
    const released: string[] = [];
    for (const phase of ["generation", "review"] as const) {
      if (phase === "generation" && outcome === "result-unobserved") continue;
      const b = getProviderExecutionBudgetSnapshot(
        ledger.budgetEvents as Parameters<typeof getProviderExecutionBudgetSnapshot>[0],
        run.preparation.budget.scopeId,
      );
      const event = createProviderExecutionBudgetEvent({
        schemaVersion: 2,
        scopeId: run.preparation.budget.scopeId,
        environment: "production",
        provenance: "explicit-user",
        revision: b.revision + 1,
        previousDigest: b.headDigest,
        eventId: randomUUID(),
        recordedAt: now,
        currency: b.currency!,
        unitScale: b.unitScale!,
        payload: {
          kind: "release-phase",
          runId: run.id,
          phase,
          reservationDigest: run.reservationDigest,
          releasedUnits: run.preparation.financialBasis.costs![phase].totalUnits,
          reason: "not-dispatched",
        },
      });
      ledger.budgetEvents.push(event);
      released.push(event.eventDigest);
    }
    addEvent(
      f,
      {
        kind: "execution-stopped",
        outcome,
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
        releasedBudgetEventDigests: released,
      },
      "provider-finish",
    );
    const v = review(f.current);
    expect(v.run.state).toBe(outcome);
    expect(v.assessment.blockers).toEqual(["run-not-reserved", "reservation-not-intact"]);
    expect(v.reservation.heldUnits).toBe(outcome === "before-dispatch" ? "0" : "5610000");
  },
);
it.each(["same-policy", "different-policy"])(
  "requires the exact reserved policy reference after %s is newly adopted",
  (change) => {
    const f = transmissionFixture(),
      configuration = config();
    if (change === "different-policy") {
      configuration.proposedBudget.capUnits = "30000000";
      resign(configuration);
    }
    adopt(f.current.archive.ledger, 0, configuration, now);
    const v = review(f.current);
    expect(v.assessment.blockers).toEqual(["policy-superseded"]);
    expect(v.policy.reservedReference.revision).toBe(1);
    expect(v.policy.currentReference?.revision).toBe(2);
    expect(v.budget.capUnits).toBe("15000000");
  },
);
it("keeps unrelated candidate policy adoption distinct from the reserved candidate reference", () => {
  const f = transmissionFixture(),
    previous = review(f.current);
  adopt(f.current.archive.ledger, 1, config(), now);
  const v = review(f.current);
  expect(v.assessment.state).toBe("conditions-met");
  expect(v.policy.head.revision).toBe(2);
  expect(v.policy.currentReference?.revision).toBe(1);
  expect(isProviderTransmissionReviewCurrent(previous, f.current)).toBe(false);
});
it("preserves other production reservations and their holds in the shared current budget", () => {
  const configuration = config();
  configuration.proposedBudget.capUnits = "30000000";
  const f = transmissionFixture(resign(configuration));
  adopt(f.input.current.ledger, 1, configuration, f.input.current.inspectedAt);
  f.input.current.selection = {
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[1].candidateId,
  };
  f.input.runId = randomUUID();
  refresh(f.input);
  const second = prepared(f.input);
  withRows(f.input, second);
  f.current.archive.records.push(second.rows.binding);
  const v = review(f.current);
  expect(v.assessment.state).toBe("conditions-met");
  expect(v.budget).toMatchObject({ heldUnits: "22440000", availableUnits: "7560000" });
  expect(v.reservation.heldUnits).toBe("11220000");
});
it("includes synthetic history in the archive digest without mixing its budget into production", () => {
  const f = transmissionFixture(),
    before = review(f.current),
    clientRequestId = randomUUID();
  const policy = {
    environment: "synthetic-test",
    provenance: "synthetic-test",
    currency: "TST",
    unitScale: 6,
    capUnits: "1",
  } as const;
  const event = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: "candidate-quality-provider-v2-synthetic",
    environment: policy.environment,
    provenance: policy.provenance,
    revision: 1,
    previousDigest: null,
    eventId: clientRequestId,
    recordedAt: now,
    currency: policy.currency,
    unitScale: policy.unitScale,
    payload: { kind: "configure", capUnits: policy.capUnits },
  });
  f.current.archive.ledger.budgetEvents.push(event);
  f.current.archive.ledger.receipts.push(
    createProviderReceipt({
      schemaVersion: 2,
      scopeId: event.scopeId,
      kind: "provider-budget-configure",
      clientRequestId,
      inputDigest: digest(
        providerPolicyDigestInput({ clientRequestId, expectedRevision: 0, policy }),
      ),
      runId: null,
      runRevision: null,
      budgetRevision: 1,
      operationDigest: event.eventDigest,
      recordedAt: now,
    }),
  );
  const v = review(f.current);
  expect(v.budget).toEqual(before.budget);
  expect(v.assessment.state).toBe("conditions-met");
  expect(v.archiveDigest).not.toBe(before.archiveDigest);
  expect(isProviderTransmissionReviewCurrent(before, f.current)).toBe(false);
});
it("blocks an untouched reservation when another run breaches its phase bound even with available budget", () => {
  const configuration = config();
  configuration.proposedBudget.capUnits = "30000000";
  const f = transmissionFixture(resign(configuration)),
    original = f.plan,
    selection = f.current.selection;
  adopt(f.input.current.ledger, 1, configuration, f.input.current.inspectedAt);
  f.input.current.selection = {
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[1].candidateId,
  };
  f.input.runId = randomUUID();
  refresh(f.input);
  const second = prepared(f.input);
  withRows(f.input, second);
  f.current.archive.records.push(second.rows.binding);
  f.plan = second;
  f.current.selection = { runId: second.rows.run.id, runDigest: second.rows.run.runDigest };
  const policy = review(f.current).manifest.executionContract.usagePolicy;
  const dispatched = dispatchGeneration(f),
    run = second.rows.run,
    ledger = f.current.archive.ledger;
  const raw = {
    id: "synthetic-response",
    _request_id: "synthetic-request",
    model: run.preparation.model,
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 600000,
      total_tokens: 600001,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
  };
  const artifact = createProviderExecutionArtifact({
    runId: run.id,
    key: "generation-response",
    body: JSON.stringify({ captureKind: "sdk-response-json-v2", response: raw }),
  });
  const assessment = assessProviderUsage({
    response: raw,
    policy,
    financialBasis: run.preparation.financialBasis,
    phase: "generation",
  });
  const payload = providerUsageRecognitionPayload(
    run,
    "generation",
    dispatched.eventDigest,
    artifact.sha256,
    assessment,
  );
  if (!payload) throw new Error("Expected synthetic observed usage");
  const b = review(f.current).budget,
    clientRequestId = randomUUID();
  const event = createProviderExecutionBudgetEvent({
    schemaVersion: 2,
    scopeId: run.preparation.budget.scopeId,
    environment: "production",
    provenance: "explicit-user",
    revision: b.revision + 1,
    previousDigest: b.headDigest,
    eventId: clientRequestId,
    recordedAt: now,
    currency: b.currency!,
    unitScale: b.unitScale!,
    payload,
  });
  ledger.budgetEvents.push(event);
  addEvent(
    f,
    {
      kind: "response-received",
      phase: "generation",
      requestDigest: run.preparation.generation.requestDigest,
      dispatchEventDigest: dispatched.eventDigest,
      artifactSha256: artifact.sha256,
      metadata: providerResponseMetadata(raw, {
        configuredModel: run.preparation.model,
        requestedTier: "default",
      }),
      usageAssessment: assessment,
      usageBudgetEventDigest: event.eventDigest,
    },
    "provider-response",
    artifact,
    clientRequestId,
  );
  f.plan = original;
  f.current.selection = selection;
  const v = review(f.current);
  expect(v.run.state).toBe("reserved");
  expect(v.facts.reservationIntact).toBe(true);
  expect(BigInt(v.budget.availableUnits)).toBeGreaterThan(BigInt(0));
  expect(v.budget.boundBreached).toBe(true);
  expect(v.assessment.blockers).toEqual(["budget-bound-breached"]);
});
it.each(["invalid-id", "missing-run", "wrong-digest", "extra-field"])(
  "rejects %s selection",
  (change) => {
    const f = transmissionFixture();
    const selection = { ...f.current.selection };
    if (change === "invalid-id") selection.runId = "invalid";
    if (change === "missing-run") selection.runId = randomUUID();
    if (change === "wrong-digest") selection.runDigest = "a".repeat(64);
    reject(
      {
        ...f.current,
        selection: change === "extra-field" ? { ...selection, dispatchAllowed: true } : selection,
      },
      "selection-invalid",
    );
  },
);
it.each(["invalid-time", "before-reservation", "exact-expiry", "after-expiry"])(
  "rejects %s without extending the original reservation",
  (change) => {
    const f = transmissionFixture();
    const time =
      change === "invalid-time"
        ? "invalid"
        : change === "before-reservation"
          ? "2026-09-27T03:31:59.999Z"
          : change === "exact-expiry"
            ? f.plan.rows.run.preparation.expiresAt
            : "2035-01-01T00:00:00.000Z";
    reject(
      { ...f.current, inspectedAt: time },
      change === "invalid-time"
        ? "inspection-invalid"
        : change === "before-reservation"
          ? "archive-after-inspection"
          : "reservation-expired",
    );
  },
);
it.each(["missing", "tampered", "changed"])("rejects %s server configuration", (change) => {
  const f = transmissionFixture(),
    configuration = config();
  configuration.proposedBudget.capUnits = "30000000";
  reject(
    {
      ...f.current,
      configuration:
        change === "missing" ? null : change === "tampered" ? configuration : resign(configuration),
    },
    change === "changed" ? "configuration-changed" : "configuration-missing-or-invalid",
  );
});
it("distinguishes expired replacement evidence from missing configuration", () => {
  const f = transmissionFixture(),
    configuration = config(),
    deadline = "2026-09-27T03:32:30.000Z";
  for (const source of configuration.sources) {
    source.validUntil = deadline;
    source.recordDigest = digest(providerProposalSourceDigestInput(source));
  }
  for (const authority of [
    configuration.context.authority,
    configuration.pricing.authority,
    configuration.retention,
    configuration.usagePolicyTemplate.authority,
  ]) {
    authority.validUntil = deadline;
    const source = configuration.sources.find((row) => row.url === authority.sourceUrl)!;
    authority.documentDigest = source.recordDigest;
  }
  reject({ ...f.current, configuration: resign(configuration) }, "configuration-expired");
});
it.each([
  "missing-binding",
  "corrupt-binding",
  "missing-coverage",
  "corrupt-coverage",
  "artifact",
  "receipt",
  "registry",
  "nonce",
])("rejects whole-archive %s damage before returning a review", (damage) => {
  const f = transmissionFixture(),
    a = f.current.archive;
  if (damage === "missing-binding") a.records = [];
  if (damage === "corrupt-binding") a.records[0].recordDigest = "a".repeat(64);
  if (damage === "missing-coverage")
    return reject({ ...f.current, archive: { ...a, coverage: null } }, "archive-invalid");
  if (damage === "corrupt-coverage") a.coverage.coverageDigest = "a".repeat(64);
  if (damage === "artifact") a.ledger.artifacts = [];
  if (damage === "receipt") a.ledger.receipts.pop();
  if (damage === "registry") a.ledger.registries = [];
  if (damage === "nonce") a.ledger.otherNonces!.push(f.plan.rows.run.clientRequestId);
  reject(f.current, "archive-invalid");
});
it("rejects future records even when unrelated to this run", () => {
  const f = transmissionFixture();
  adopt(f.current.archive.ledger, 1, config(), "2026-09-27T03:34:00.000Z");
  reject(f.current, "archive-after-inspection");
});
it("validates an unchanged review during its window but not at or beyond expiry", () => {
  const f = transmissionFixture(),
    v = review(f.current);
  expect(
    isProviderTransmissionReviewCurrent(v, {
      ...f.current,
      inspectedAt: "2026-09-27T03:34:00.000Z",
    }),
  ).toBe(true);
  expect(
    isProviderTransmissionReviewCurrent(v, {
      ...f.current,
      inspectedAt: "2026-09-27T03:32:59.999Z",
    }),
  ).toBe(false);
  expect(isProviderTransmissionReviewCurrent(v, { ...f.current, inspectedAt: v.expiresAt })).toBe(
    false,
  );
  expect(
    isProviderTransmissionReviewCurrent(v, {
      ...f.current,
      inspectedAt: "2035-01-01T00:00:00.000Z",
    }),
  ).toBe(false);
});
it.each([
  "request",
  "manifest",
  "financial",
  "archive",
  "coverage",
  "reservation",
  "policy",
  "grant",
  "assessment",
])("rejects rehashed %s changes instead of trusting a checksum", (change) => {
  const f = transmissionFixture(),
    v = review(f.current);
  if (change === "request") v.request.generation.sha256 = "a".repeat(64);
  if (change === "manifest")
    v.manifest.executionContract.usagePolicy.responseModels = ["other-model"];
  if (change === "financial") v.financialBasis.limitations[0] = "Altered notice";
  if (change === "archive") v.archiveDigest = "a".repeat(64);
  if (change === "coverage") v.coverageDigest = "a".repeat(64);
  if (change === "reservation") v.reservation.bindingDigest = "a".repeat(64);
  if (change === "policy") v.policy.reservedReference.clientRequestId = randomUUID();
  if (change === "grant") Object.assign(v.actions, { dispatchAllowed: true });
  if (change === "assessment") v.assessment.state = "blocked";
  v.reviewDigest = digest(providerTransmissionReviewDigestInput(v));
  expect(isProviderTransmissionReviewCurrent(v, f.current)).toBe(false);
});
it("refuses stale reviews after a reservation is cancelled or a shared nonce is added", () => {
  const f = transmissionFixture(),
    v = review(f.current);
  f.current.archive.ledger.otherNonces!.push(randomUUID());
  expect(isProviderTransmissionReviewCurrent(v, f.current)).toBe(false);
  cancel(f.input, f.plan);
  expect(isProviderTransmissionReviewCurrent(v, f.current)).toBe(false);
});
it("rejects malformed money without throwing from shape refinement", () => {
  const f = transmissionFixture(),
    v = review(f.current);
  v.reservation.heldUnits = "invalid";
  expect(providerTransmissionReviewSchema.safeParse(v).success).toBe(false);
  expect(isProviderTransmissionReviewCurrent(v, f.current)).toBe(false);
});
