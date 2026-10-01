import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  actualTestNow,
  actualTestRegistry,
  actualTestPlan,
} from "./studio-plan-quality-actual-test-helpers";
import {
  providerTestExpires,
  providerTestFinancialInput,
} from "./studio-plan-quality-provider-test-helpers";
import {
  createProviderPreparation,
  createVersionedProviderPreparationBuilder,
} from "./studio-plan-quality-provider-core";
import * as core from "../../scripts/local-data-quality-provider.mjs";
import {
  providerResponseMetadata,
  assessProviderUsage,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderUsagePolicy,
  ProviderCapturedResponse,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderStart,
  VersionedProviderStart,
  ProviderRunEvent,
} from "./studio-plan-quality-provider-types";
import type {
  ProviderExecutionPayload,
  ProviderExecutionArtifact,
  ProviderExecutionEvent,
} from "./studio-plan-quality-provider-execution-types";
const {
  providerBudgetScope,
  providerDigest,
  providerPolicyDigestInput,
  createProviderBudgetEvent,
  createProviderReceipt,
  createProviderRun,
  createProviderArtifact,
} = core;
function fixture() {
  const registry = actualTestRegistry(),
    scopeId = providerBudgetScope("synthetic-test"),
    nonce = randomUUID();
  const policy = {
    environment: "synthetic-test",
    provenance: "synthetic-test",
    currency: "TST",
    unitScale: 6,
    capUnits: "100",
  } as const;
  const configured = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId,
    environment: policy.environment,
    provenance: policy.provenance,
    revision: 1,
    previousDigest: null,
    eventId: nonce,
    recordedAt: actualTestNow,
    currency: policy.currency,
    unitScale: policy.unitScale,
    payload: { kind: "configure", capUnits: policy.capUnits },
  });
  const policyReceipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId,
    kind: "provider-budget-configure",
    clientRequestId: nonce,
    inputDigest: providerDigest(
      providerPolicyDigestInput({ clientRequestId: nonce, expectedRevision: 0, policy }),
    ),
    runId: null,
    runRevision: null,
    budgetRevision: 1,
    operationDigest: configured.eventDigest,
    recordedAt: actualTestNow,
  });
  const preparation = createProviderPreparation({
    registry,
    candidateId: registry.entries[0].candidateId,
    environment: "synthetic-test",
    preparedAt: actualTestNow,
    expiresAt: providerTestExpires,
    financialInput: providerTestFinancialInput(),
    budget: {
      scopeId,
      revision: 1,
      headDigest: configured.eventDigest,
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
      heldUnits: "0",
      recognizedUnits: "0",
    },
    retention: {
      policyVersion: "synthetic-v2",
      notice: "Synthetic fixture; no provider call",
      sourceUrl: "https://example.invalid/retention",
      documentDigest: "b".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
    },
  });
  const start: ProviderStart = {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: 1,
    expectedBudgetDigest: configured.eventDigest,
    expectedScopeRunCount: 0,
    expectedGlobalRunCount: 0,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      approvedAt: actualTestNow,
      expiresAt: providerTestExpires,
      acknowledgedReservationOnly: true,
      acknowledgedFinancialBasisNotTokenFit: true,
      acknowledgedRetention: true,
      acknowledgedNoAutomaticRetry: true,
    },
  };
  const id = randomUUID(),
    reservation = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: 2,
      previousDigest: configured.eventDigest,
      eventId: start.clientRequestId,
      recordedAt: actualTestNow,
      currency: "TST",
      unitScale: 6,
      payload: {
        kind: "reserve-run",
        runId: id,
        preparationDigest: preparation.preparationDigest,
        generationUnits: "2",
        reviewUnits: "2",
      },
    });
  const run = createProviderRun({ input: start, id, recordedAt: actualTestNow, reservation });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId,
    kind: "provider-start",
    clientRequestId: start.clientRequestId,
    inputDigest: run.inputDigest,
    runId: id,
    runRevision: 0,
    budgetRevision: 2,
    operationDigest: run.runDigest,
    recordedAt: actualTestNow,
  });
  const artifacts = [
    createProviderArtifact({ runId: id, body: JSON.stringify(preparation.generation.body) }),
  ];
  const data = {
    run,
    events: [] as ProviderRunEvent[],
    artifacts,
    budgetEvents: [configured, reservation],
    receipts: [receipt],
    registry,
  };
  const all = () => ({
    runs: [data.run],
    events: data.events,
    artifacts: data.artifacts,
    budgetEvents: data.budgetEvents,
    receipts: [policyReceipt, ...data.receipts],
    registries: [registry],
  });
  return { registry, preparation, start, data, all, policyReceipt };
}
const forbidden = vi.fn(() => {
  throw new Error("No provider IO");
});
beforeEach(() => vi.stubGlobal("fetch", forbidden));
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
type Fixture = ReturnType<typeof fixture>;
function usagePolicy(f: Fixture): ProviderUsagePolicy {
  return {
    schemaVersion: 1,
    kind: "provider-usage-rate-policy",
    provenance: "synthetic-test",
    financialBasisDigest: f.preparation.financialBasisDigest,
    configuredModel: f.preparation.model,
    responseModels: [f.preparation.model],
    requestedTier: "default",
    responseTier: "default",
    inputPartition: { kind: "equal-rates", basis: "Synthetic equal input channel rates" },
    bandSelection: { kind: "short-only", basis: "Synthetic single band" },
    authority: {
      sourceUrl: "https://example.invalid/synthetic-policy",
      documentDigest: "a".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
      excerpt: "Synthetic fixture, not provider evidence",
    },
  };
}
const budget = (f: Fixture) =>
  core.getProviderExecutionBudgetSnapshot(f.data.budgetEvents, f.preparation.budget.scopeId);
const snapshot = (f: Fixture) => core.validateProviderRunLedger(f.data);
function add(
  f: Fixture,
  payload: ProviderExecutionPayload,
  artifact?: ProviderExecutionArtifact,
  nonce = randomUUID(),
) {
  const p =
    payload.kind === "response-received"
      ? without(without(payload, "usageAssessment"), "usageBudgetEventDigest")
      : payload.kind === "execution-stopped"
        ? without(payload, "releasedBudgetEventDigests")
        : payload;
  const command = core.providerExecutionCommandSchema.parse({
    clientRequestId: nonce,
    expectedRevision: f.data.events.length,
    payload: p,
    ...(artifact ? { artifact } : {}),
  });
  const event = core.createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId: f.data.run.id,
    revision: f.data.events.length + 1,
    budgetRevision: budget(f).revision,
    previousEventDigest: f.data.events.at(-1)?.eventDigest ?? null,
    recordedAt: actualTestNow,
    payload,
  });
  const kind = {
    "transmission-approved": "provider-approve",
    "request-prepared": "provider-prepared",
    "dispatch-intent": "provider-dispatch",
    "response-received": "provider-response",
    "domain-validated": "provider-validated",
    "execution-stopped": "provider-finish",
  } as const;
  const receipt = core.createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: f.preparation.budget.scopeId,
    kind: kind[payload.kind],
    clientRequestId: nonce,
    inputDigest: core.providerExecutionOperationDigest(f.data.run.id, command),
    runId: f.data.run.id,
    runRevision: event.revision,
    budgetRevision: event.budgetRevision,
    operationDigest: event.eventDigest,
    recordedAt: actualTestNow,
  });
  if (artifact && !f.data.artifacts.some((v) => v.key === artifact.key))
    f.data.artifacts.push(artifact);
  f.data.events.push(event);
  f.data.receipts.push(receipt);
  return event;
}
function approve(f: Fixture) {
  const b = budget(f);
  return add(f, {
    kind: "transmission-approved",
    manifest: core.createProviderTransmissionManifest(f.data.run, usagePolicy(f)),
    provenance: "synthetic-test",
    approvedAt: actualTestNow,
    expiresAt: providerTestExpires,
    acknowledgedExternalTransmission: true,
    acknowledgedGenerationAndDerivedReview: true,
    acknowledgedRetentionNoticeDigest: f.preparation.retentionDigest,
    acknowledgedFinancialReservationNotTokenFit: true,
    acknowledgedUnknownCostHoldAndNoRetry: true,
    budgetRevision: b.revision,
    budgetDigest: b.headDigest!,
  });
}
function prepare(f: Fixture, phase: "generation" | "review") {
  const g = f.data.events.find(
    (v) => v.payload.kind === "domain-validated" && v.payload.phase === "generation",
  ) as ProviderExecutionEvent | undefined;
  const output = g
    ? JSON.parse(f.data.artifacts.find((v) => v.key === "generation-validated")!.body)
    : null;
  const body =
      phase === "generation"
        ? f.preparation.generation.body
        : core.deriveProviderExecutionReviewRequest(f.data.run, output),
    a = core.createProviderExecutionArtifact({
      runId: f.data.run.id,
      key: `${phase}-request`,
      body: JSON.stringify(body),
    }),
    b = budget(f);
  if (g && g.payload.kind !== "domain-validated") throw new Error("invalid fixture");
  return add(
    f,
    {
      kind: "request-prepared",
      phase,
      requestDigest: core.providerWireDigest(body),
      artifactSha256: a.sha256,
      derivedFrom:
        phase === "generation"
          ? null
          : {
              generationEventDigest: g!.eventDigest,
              artifactSha256:
                g!.payload.kind === "domain-validated" ? g!.payload.artifactSha256 : "",
              outputDigest: g!.payload.kind === "domain-validated" ? g!.payload.outputDigest : "",
            },
      budgetRevision: b.revision,
      budgetDigest: b.headDigest!,
    },
    a,
  );
}
function dispatch(f: Fixture, phase: "generation" | "review") {
  const p = f.data.events.at(-1)!;
  if (p.payload.kind !== "request-prepared") throw new Error("invalid fixture");
  const b = budget(f);
  return add(f, {
    kind: "dispatch-intent",
    phase,
    requestDigest: p.payload.requestDigest,
    artifactSha256: p.payload.artifactSha256,
    preparedEventDigest: p.eventDigest,
    approvalEventDigest: f.data.events[0].eventDigest,
    budgetRevision: b.revision,
    budgetDigest: b.headDigest!,
  });
}
function receive(
  f: Fixture,
  phase: "generation" | "review",
  change?: (raw: ProviderCapturedResponse) => void,
) {
  const d = f.data.events.find(
    (v) => v.payload.kind === "dispatch-intent" && v.payload.phase === phase,
  )!;
  if (d.payload.kind !== "dispatch-intent") throw new Error("invalid fixture");
  const raw: ProviderCapturedResponse = {
    id: `response-${phase}`,
    _request_id: `request-${phase}`,
    model: f.preparation.model,
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(
              phase === "generation" ? actualTestPlan(f.registry) : { findings: [] },
            ),
          },
        ],
      },
    ],
  };
  change?.(raw);
  const a = core.createProviderExecutionArtifact({
      runId: f.data.run.id,
      key: `${phase}-response`,
      body: JSON.stringify({ captureKind: "sdk-response-json-v2", response: raw }),
    }),
    metadata = providerResponseMetadata(raw, {
      configuredModel: f.preparation.model,
      requestedTier: "default",
    }),
    assessment = assessProviderUsage({
      response: raw,
      policy: usagePolicy(f),
      financialBasis: f.preparation.financialBasis,
      phase,
    }),
    recognition = core.providerUsageRecognitionPayload(
      f.data.run,
      phase,
      d.eventDigest,
      a.sha256,
      assessment,
    ),
    nonce = randomUUID();
  let h: null | string = null;
  if (recognition) {
    const b = budget(f),
      e = core.createProviderExecutionBudgetEvent({
        schemaVersion: 2,
        scopeId: b.scopeId,
        environment: "synthetic-test",
        provenance: "synthetic-test",
        revision: b.revision + 1,
        previousDigest: b.headDigest,
        eventId: nonce,
        recordedAt: actualTestNow,
        currency: b.currency!,
        unitScale: b.unitScale!,
        payload: recognition,
      });
    f.data.budgetEvents.push(e);
    h = e.eventDigest;
  }
  return add(
    f,
    {
      kind: "response-received",
      phase,
      requestDigest: d.payload.requestDigest,
      dispatchEventDigest: d.eventDigest,
      artifactSha256: a.sha256,
      metadata,
      usageAssessment: assessment,
      usageBudgetEventDigest: h,
    },
    a,
    nonce,
  );
}
function validate(f: Fixture, phase: "generation" | "review") {
  const response = f.data.events.at(-1)!;
  if (response.payload.kind !== "response-received") throw new Error("invalid fixture");
  const output =
    phase === "generation"
      ? { kind: "plan", content: actualTestPlan(f.registry) }
      : { kind: "review", findings: [] };
  const artifact = core.createProviderExecutionArtifact({
    runId: f.data.run.id,
    key: `${phase}-validated`,
    body: JSON.stringify(output),
  });
  return add(
    f,
    {
      kind: "domain-validated",
      phase,
      requestDigest: response.payload.requestDigest,
      responseEventDigest: response.eventDigest,
      artifactSha256: artifact.sha256,
      outputDigest: providerDigest(output),
    },
    artifact,
  );
}
function finish(
  f: Fixture,
  outcome: Extract<ProviderExecutionPayload, { kind: "execution-stopped" }>["outcome"],
) {
  const released = [];
  for (const phase of ["generation", "review"] as const) {
    if (
      f.data.events.some((v) => v.payload.kind === "dispatch-intent" && v.payload.phase === phase)
    )
      continue;
    const b = budget(f),
      s = b.reservations[0].phases.find((v) => v.phase === phase)!;
    const e = core.createProviderExecutionBudgetEvent({
      schemaVersion: 2,
      scopeId: b.scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: b.revision + 1,
      previousDigest: b.headDigest,
      eventId: randomUUID(),
      recordedAt: actualTestNow,
      currency: b.currency!,
      unitScale: b.unitScale!,
      payload: {
        kind: "release-phase",
        runId: f.data.run.id,
        phase,
        reservationDigest: f.data.run.reservationDigest,
        releasedUnits: s.heldUnits,
        reason: "not-dispatched",
      },
    });
    f.data.budgetEvents.push(e);
    released.push(e.eventDigest);
  }
  const approved = f.data.events[0];
  if (approved.payload.kind !== "transmission-approved") throw new Error("invalid fixture");
  const artifact =
    outcome === "completed"
      ? core.createProviderExecutionArtifact({
          runId: f.data.run.id,
          key: "final-result",
          body: JSON.stringify({
            content: actualTestPlan(f.registry),
            review: [],
            semanticReview: [],
            contractDigest: approved.payload.manifest.executionContract.contractDigest,
          }),
        })
      : undefined;
  return add(
    f,
    {
      kind: "execution-stopped",
      outcome,
      failureCode:
        outcome === "completed"
          ? null
          : outcome === "needs-cost-review"
            ? "COST_UNSETTLED"
            : "INTERRUPTED",
      finalArtifactSha256: artifact?.sha256 ?? null,
      releasedBudgetEventDigests: released,
    },
    artifact,
  );
}
function completed() {
  const f = fixture();
  approve(f);
  for (const p of ["generation", "review"] as const) {
    prepare(f, p);
    dispatch(f, p);
    receive(f, p);
    validate(f, p);
  }
  finish(f, "completed");
  return f;
}

describe("v2 explicit transmission ledger", () => {
  it("allows an explicit later reservation with accumulated known cost while preserving prior archive bytes", () => {
    const f = completed(),
      before = JSON.stringify(snapshot(f)),
      b = budget(f),
      p = createProviderPreparation({
        registry: f.registry,
        candidateId: f.preparation.scope.candidateId,
        environment: "synthetic-test",
        preparedAt: actualTestNow,
        expiresAt: providerTestExpires,
        financialInput: providerTestFinancialInput(),
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
        retention: f.preparation.retention,
      });
    const input: ProviderStart = {
        ...f.start,
        clientRequestId: randomUUID(),
        expectedBudgetRevision: b.revision,
        expectedBudgetDigest: b.headDigest!,
        expectedScopeRunCount: 1,
        expectedGlobalRunCount: 1,
        preparation: p,
        approval: { ...f.start.approval, approvedPreparationDigest: p.preparationDigest },
      },
      id = randomUUID();
    const e = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId: b.scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: b.revision + 1,
      previousDigest: b.headDigest,
      eventId: input.clientRequestId,
      recordedAt: actualTestNow,
      currency: b.currency!,
      unitScale: b.unitScale!,
      payload: {
        kind: "reserve-run",
        runId: id,
        preparationDigest: p.preparationDigest,
        generationUnits: "2",
        reviewUnits: "2",
      },
    });
    const run = createProviderRun({ input, id, recordedAt: actualTestNow, reservation: e }),
      receipt = createProviderReceipt({
        schemaVersion: 2,
        scopeId: b.scopeId,
        kind: "provider-start",
        clientRequestId: input.clientRequestId,
        inputDigest: run.inputDigest,
        runId: id,
        runRevision: 0,
        budgetRevision: e.revision,
        operationDigest: run.runDigest,
        recordedAt: actualTestNow,
      }),
      artifact = createProviderArtifact({ runId: id, body: JSON.stringify(p.generation.body) });
    const result = core.inspectProviderLedger({
      ...f.all(),
      runs: [f.data.run, run],
      artifacts: [...f.data.artifacts, artifact],
      budgetEvents: [...f.data.budgetEvents, e],
      receipts: [...f.all().receipts, receipt],
    });
    expect(result.snapshots[1].state).toBe("reserved");
    expect(result.budgets[0].recognizedUnits).toBe("4");
    expect(JSON.stringify(result.snapshots[0])).toBe(before);
    expect(() =>
      createProviderPreparation({
        registry: f.registry,
        candidateId: p.scope.candidateId,
        environment: "synthetic-test",
        preparedAt: actualTestNow,
        expiresAt: providerTestExpires,
        financialInput: providerTestFinancialInput(),
        budget: { ...p.budget, capUnits: "7" },
        retention: p.retention,
      }),
    ).toThrow();
  });
  it("reads completed legacy execution with a format3/v2 reservation and approval, preserving cost and old bytes", () => {
    const f = completed(),
      before = JSON.stringify(snapshot(f)),
      b = budget(f),
      p = createVersionedProviderPreparationBuilder("plan-observation-v2").createPreparation({
        registry: f.registry,
        candidateId: f.preparation.scope.candidateId,
        environment: "synthetic-test",
        preparedAt: actualTestNow,
        expiresAt: providerTestExpires,
        financialInput: providerTestFinancialInput(),
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
        retention: f.preparation.retention,
      });
    const input: VersionedProviderStart = {
        startVersion: 2,
        ...f.start,
        clientRequestId: randomUUID(),
        expectedBudgetRevision: b.revision,
        expectedBudgetDigest: b.headDigest!,
        expectedScopeRunCount: 1,
        expectedGlobalRunCount: 1,
        preparation: p,
        approval: { ...f.start.approval, approvedPreparationDigest: p.preparationDigest },
      },
      id = randomUUID();
    const e = createProviderBudgetEvent({
      schemaVersion: 2,
      scopeId: b.scopeId,
      environment: "synthetic-test",
      provenance: "synthetic-test",
      revision: b.revision + 1,
      previousDigest: b.headDigest,
      eventId: input.clientRequestId,
      recordedAt: actualTestNow,
      currency: b.currency!,
      unitScale: b.unitScale!,
      payload: {
        kind: "reserve-run",
        runId: id,
        preparationDigest: p.preparationDigest,
        generationUnits: "2",
        reviewUnits: "2",
      },
    });
    const run = core.createVersionedProviderRun({
        input,
        id,
        recordedAt: actualTestNow,
        reservation: e,
      }),
      receipt = createProviderReceipt({
        schemaVersion: 2,
        scopeId: b.scopeId,
        kind: "provider-start",
        clientRequestId: input.clientRequestId,
        inputDigest: run.inputDigest,
        runId: id,
        runRevision: 0,
        budgetRevision: e.revision,
        operationDigest: run.runDigest,
        recordedAt: actualTestNow,
      }),
      artifact = createProviderArtifact({ runId: id, body: JSON.stringify(p.generation.body) });
    const result = core.inspectVersionedProviderLedger({
      ...f.all(),
      runs: [f.data.run, run],
      artifacts: [...f.data.artifacts, artifact],
      budgetEvents: [...f.data.budgetEvents, e],
      receipts: [...f.all().receipts, receipt],
    });
    expect(result.snapshots[1]).toMatchObject({
      archiveFormatVersion: 4,
      state: "reserved",
      dispatchAllowed: false,
      canResume: false,
    });
    expect(result.budgets[0]).toMatchObject({
      capUnits: "100",
      heldUnits: "4",
      recognizedUnits: "4",
    });
    expect(result.budgets[0].recognizedUnits).toBe("4");
    expect(JSON.stringify(result.snapshots[0])).toBe(before);
    // The same native ledger keeps the settled v1 cost/bytes when v2 gains its first approval.
    const command = core.versionedProviderApprovalCommandSchema.parse({
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      payload: {
        kind: "transmission-approved",
        manifest: core.createVersionedProviderTransmissionManifest(run, {
          ...usagePolicy(f),
          financialBasisDigest: p.financialBasisDigest,
        }),
        provenance: "synthetic-test",
        approvedAt: actualTestNow,
        expiresAt: providerTestExpires,
        acknowledgedExternalTransmission: true,
        acknowledgedGenerationAndDerivedReview: true,
        acknowledgedRetentionNoticeDigest: p.retentionDigest,
        acknowledgedFinancialReservationNotTokenFit: true,
        acknowledgedUnknownCostHoldAndNoRetry: true,
        budgetRevision: e.revision,
        budgetDigest: e.eventDigest,
      },
    });
    const approval = core.createVersionedProviderApprovalEvent({
      schemaVersion: 2,
      executionContractVersion: 2,
      runId: id,
      revision: 1,
      budgetRevision: e.revision,
      previousEventDigest: null,
      recordedAt: actualTestNow,
      payload: command.payload,
    });
    const approvalReceipt = core.createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: b.scopeId,
      kind: "provider-approve",
      clientRequestId: command.clientRequestId,
      inputDigest: core.versionedProviderApprovalOperationDigest(id, command),
      runId: id,
      runRevision: 1,
      budgetRevision: e.revision,
      operationDigest: approval.eventDigest,
      recordedAt: actualTestNow,
    });
    const approved = core.inspectVersionedProviderLedger({
      ...f.all(),
      runs: [f.data.run, run],
      events: [...f.data.events, approval],
      artifacts: [...f.data.artifacts, artifact],
      budgetEvents: [...f.data.budgetEvents, e],
      receipts: [...f.all().receipts, receipt, approvalReceipt],
    });
    expect(approved.snapshots[1]).toMatchObject({
      archiveFormatVersion: 5,
      state: "approved",
      dispatchAllowed: false,
      canResume: false,
    });
    expect(approved.budgets).toEqual(result.budgets);
    expect(JSON.stringify(approved.snapshots[0])).toBe(before);

    expect(() =>
      createVersionedProviderPreparationBuilder("plan-observation-v2").createPreparation({
        registry: f.registry,
        candidateId: p.scope.candidateId,
        environment: "synthetic-test",
        preparedAt: actualTestNow,
        expiresAt: providerTestExpires,
        financialInput: providerTestFinancialInput(),
        budget: { ...p.budget, capUnits: "7" },
        retention: p.retention,
      }),
    ).toThrow();
  });
  it("normalizes an omitted generation artifact because original start bytes already bind it", () => {
    const f = fixture();
    approve(f);
    const event = prepare(f, "generation"),
      payload = event.payload;
    if (payload.kind !== "request-prepared") throw new Error("fixture");
    const receipt = f.data.receipts.at(-1)!;
    expect(receipt.inputDigest).toBe(
      core.providerExecutionOperationDigest(f.data.run.id, {
        clientRequestId: receipt.clientRequestId,
        expectedRevision: event.revision - 1,
        payload,
      }),
    );
    expect(snapshot(f).state).toBe("prepared");
  });
  it("preserves malformed output and its observed usage before rejecting domain validation", () => {
    const f = fixture();
    approve(f);
    prepare(f, "generation");
    dispatch(f, "generation");
    receive(f, "generation", (raw) => (raw.output = null));
    expect(snapshot(f).state).toBe("response-recorded");
    expect(budget(f).recognizedUnits).toBe("2");
    validate(f, "generation");
    expect(() => snapshot(f)).toThrow();
  });
  it("rejects a second prepared/dispatch path for an already dispatched phase", () => {
    const f = fixture();
    approve(f);
    prepare(f, "generation");
    dispatch(f, "generation");
    prepare(f, "generation");
    expect(() => snapshot(f)).toThrow();
  });
  it("rejects an otherwise valid artifact not referenced by the selected event prefix", () => {
    const f = fixture();
    approve(f);
    f.data.artifacts.push(
      core.createProviderExecutionArtifact({
        runId: f.data.run.id,
        key: "final-result",
        body: "{}",
      }),
    );
    expect(() => snapshot(f)).toThrow();
  });
  it("requires a new explicit approval, then records two phases without rewriting the reservation", () => {
    const f = completed();
    const result = core.inspectProviderLedger(f.all());
    expect(result.snapshots[0]).toMatchObject({
      archiveFormatVersion: 3,
      state: "completed",
      actualAiCalls: 0,
      dispatchIntentCount: 2,
      responseCount: 2,
      eligibleForNewCandidateRun: true,
    });
    expect(f.data.run.approval.acknowledgedReservationOnly).toBe(true);
    expect(f.data.run.actualAiCalls).toBe(0);
    expect(budget(f)).toMatchObject({ heldUnits: "0", recognizedUnits: "4", boundBreached: false });
  });
  it("never gives an old reservation approval dispatch authority", () => {
    const f = fixture();
    prepare(f, "generation");
    expect(() => snapshot(f)).toThrow();
  });
  it("keeps old r0 and future artifact exclusion byte-identical", () => {
    const f = fixture(),
      before = JSON.stringify(snapshot(f));
    approve(f);
    prepare(f, "generation");
    dispatch(f, "generation");
    receive(f, "generation");
    expect(
      JSON.stringify(
        core.validateProviderRunLedger({
          ...f.data,
          events: [],
          budgetEvents: f.data.budgetEvents.slice(0, 2),
          receipts: f.data.receipts.slice(0, 1),
          artifacts: f.data.artifacts.filter((v) => v.key === "generation-request"),
        }),
      ),
    ).toBe(before);
  });
  it("holds unknown usage, releases only untransmitted review, and forbids validation", () => {
    const f = fixture();
    approve(f);
    prepare(f, "generation");
    dispatch(f, "generation");
    receive(f, "generation", (raw) => delete raw.usage);
    finish(f, "needs-cost-review");
    expect(snapshot(f)).toMatchObject({
      state: "needs-cost-review",
      unsettled: true,
      eligibleForNewCandidateRun: false,
    });
    expect(budget(f).heldUnits).toBe("2");
  });
  it("retains original stop after late response, settles observed usage, and never resumes review", () => {
    const f = fixture();
    approve(f);
    prepare(f, "generation");
    dispatch(f, "generation");
    finish(f, "result-unobserved");
    receive(f, "generation");
    expect(snapshot(f)).toMatchObject({
      state: "result-unobserved",
      terminal: true,
      dispatchIntentCount: 1,
      responseCount: 1,
      unsettled: false,
    });
    expect(() => prepare(f, "review")).toThrow();
  });
  it("recognizes all observed excess and blocks later dispatch", () => {
    const f = fixture();
    approve(f);
    prepare(f, "generation");
    dispatch(f, "generation");
    receive(
      f,
      "generation",
      (raw) =>
        (raw.usage = { input_tokens: 200000000, output_tokens: 10, total_tokens: 200000010 }),
    );
    finish(f, "bound-breached");
    expect(snapshot(f).state).toBe("bound-breached");
    expect(budget(f)).toMatchObject({
      heldUnits: "0",
      recognizedUnits: "201",
      deficitUnits: "101",
      boundBreached: true,
    });
  });
  it.each(["metadata", "usage", "nonce", "approval", "body", "output"])(
    "rejects %s tampering in a completed ledger",
    (kind) => {
      const f = completed();
      if (kind === "metadata") {
        const e = f.data.events.find((v) => v.payload.kind === "response-received")!;
        if (e.payload.kind === "response-received") e.payload.metadata.responseTier = "flex";
      }
      if (kind === "usage") f.data.budgetEvents.at(-1)!.eventDigest = "a".repeat(64);
      if (kind === "nonce") f.data.receipts[3].clientRequestId = randomUUID();
      if (kind === "approval") f.data.events[0].eventDigest = "b".repeat(64);
      if (kind === "body") f.data.artifacts.find((v) => v.key === "review-request")!.body += " ";
      if (kind === "output")
        f.data.artifacts.find((v) => v.key === "generation-validated")!.sha256 = "e".repeat(64);
      expect(() => core.inspectProviderLedger(f.all())).toThrow();
    },
  );
});
