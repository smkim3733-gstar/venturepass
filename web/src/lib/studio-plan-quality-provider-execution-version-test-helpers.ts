/** Synthetic full v2 execution archive fixture. No SDK, paid calls or durable operational writes. */
import { randomUUID } from "node:crypto";
import { actualTestPlan } from "./studio-plan-quality-actual-test-helpers";
import { versionedTransmissionFixture } from "./studio-plan-quality-provider-transmission-version-test-helpers";
import { transmissionCommandFor } from "./studio-plan-quality-provider-transmission-test-helpers";
import * as core from "../../scripts/local-data-quality-provider.mjs";
import {
  providerResponseMetadata,
  assessProviderUsage,
  type ProviderCapturedResponse,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import type {
  ProviderArtifact,
  ProviderBudgetEvent,
  ProviderReceipt,
} from "./studio-plan-quality-provider-types";
import type {
  VersionedProviderExecutionPayload,
  VersionedProviderExecutionEvent,
  ProviderExecutionArtifact,
} from "./studio-plan-quality-provider-execution-types";
export { versionedTransmissionFixture as executionBase };
const recordedAt = "2026-09-27T03:34:00.000Z";
const providerDigest = core.providerDigest;
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
export function fixture(base: ReturnType<typeof versionedTransmissionFixture>) {
  const current = structuredClone(base.input);
  const reviewed = base.server.transmissionReview(current);
  if (reviewed.status !== "review" || reviewed.review.schemaVersion !== 2) throw Error("v2 review");
  const prepared = base.server.prepareTransmissionApproval({
    current: { ...current, inspectedAt: recordedAt },
    command: transmissionCommandFor(reviewed.review),
    review: reviewed.review,
    additionalUsedBytes: 0,
  });
  if (prepared.status !== "prepared" || prepared.plan.planVersion !== 2) throw Error("v2 approval");
  const archive = current.archive,
    ledger = archive.ledger;
  const run = core.versionedProviderRunSchema.parse(ledger.runs[0]);
  const data = {
    run,
    events: ledger.events as VersionedProviderExecutionEvent[],
    artifacts: ledger.artifacts as ProviderArtifact[],
    budgetEvents: ledger.budgetEvents as ProviderBudgetEvent[],
    receipts: ledger.receipts.filter(
      (r) => (r as ProviderReceipt).runId === run.id,
    ) as ProviderReceipt[],
    registry: ledger.registries[0],
  };
  const startSnapshot = core.validateVersionedProviderRunLedger(data);
  data.events.push(prepared.plan.rows.event);
  data.receipts.push(prepared.plan.rows.receipt);
  const all = () => ({
    ...ledger,
    runs: [data.run],
    events: data.events,
    artifacts: data.artifacts,
    budgetEvents: data.budgetEvents,
    receipts: [...(ledger.receipts as ProviderReceipt[]).filter((r) => !r.runId), ...data.receipts],
    otherNonces: ledger.policies!.map((p) => (p as { clientRequestId: string }).clientRequestId),
  });
  const coverage = {
    coverageVersion: 1 as const,
    kind: "provider-transmission-approval-coverage" as const,
    cutoverGlobalRunCount: 0,
    cutoverRunPrefixDigest: providerDigest([]),
    cutoverProviderEvents: [],
    legacyProductionApprovals: [],
  };
  return {
    data,
    registry: data.registry,
    preparation: run.preparation,
    startSnapshot,
    all,
    upper: () => ({
      archive: { ...archive, ledger: { ...all(), otherNonces: [] } },
      coverage: { ...coverage, coverageDigest: providerDigest(coverage) },
      records: [prepared.plan.rows.binding],
    }),
  };
}
export type Fixture = Pick<ReturnType<typeof fixture>, "data" | "registry" | "preparation">;
const initialPlan = (f: Fixture) =>
  actualTestPlan(
    f.registry,
    f.registry.entries.findIndex((entry) => entry.candidateId === f.preparation.scope.candidateId),
  );
const usagePolicy = (f: Fixture) => {
  const payload = f.data.events[0].payload;
  if (payload.kind !== "transmission-approved") throw Error("approval");
  return payload.manifest.executionContract.usagePolicy;
};
export const budget = (f: Fixture) =>
  core.getProviderExecutionBudgetSnapshot(f.data.budgetEvents, f.preparation.budget.scopeId);
export const snapshot = (f: Fixture) => core.validateVersionedProviderRunLedger(f.data);
export function add(
  f: Fixture,
  payload: VersionedProviderExecutionPayload,
  artifact?: ProviderExecutionArtifact,
  nonce: string = randomUUID(),
) {
  const p =
    payload.kind === "response-received"
      ? without(without(payload, "usageAssessment"), "usageBudgetEventDigest")
      : payload.kind === "execution-stopped"
        ? without(payload, "releasedBudgetEventDigests")
        : payload;
  const command = core.versionedProviderExecutionCommandSchema.parse({
    clientRequestId: nonce,
    expectedRevision: f.data.events.length,
    payload: p,
    ...(artifact ? { artifact } : {}),
  });
  const event = core.createVersionedProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 2,
    runId: f.data.run.id,
    revision: f.data.events.length + 1,
    budgetRevision: budget(f).revision,
    previousEventDigest: f.data.events.at(-1)?.eventDigest ?? null,
    recordedAt: recordedAt,
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
    inputDigest: core.versionedProviderExecutionOperationDigest(f.data.run.id, command),
    runId: f.data.run.id,
    runRevision: event.revision,
    budgetRevision: event.budgetRevision,
    operationDigest: event.eventDigest,
    recordedAt: recordedAt,
  });
  if (artifact && !f.data.artifacts.some((v) => v.key === artifact.key))
    f.data.artifacts.push(artifact);
  f.data.events.push(event);
  f.data.receipts.push(receipt);
  return event;
}
export function prepare(f: Fixture, phase: "generation" | "review") {
  const g = f.data.events.find(
    (v) => v.payload.kind === "domain-validated" && v.payload.phase === "generation",
  ) as VersionedProviderExecutionEvent | undefined;
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
export function dispatch(f: Fixture, phase: "generation" | "review") {
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
export function receive(
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
            text: JSON.stringify(phase === "generation" ? initialPlan(f) : { findings: [] }),
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
        environment: "production",
        provenance: "explicit-user",
        revision: b.revision + 1,
        previousDigest: b.headDigest,
        eventId: nonce,
        recordedAt: recordedAt,
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
export function validate(f: Fixture, phase: "generation" | "review") {
  const response = f.data.events.at(-1)!;
  if (response.payload.kind !== "response-received") throw new Error("invalid fixture");
  const output =
    phase === "generation"
      ? { kind: "plan", content: initialPlan(f) }
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
export function finish(
  f: Fixture,
  outcome: Extract<VersionedProviderExecutionPayload, { kind: "execution-stopped" }>["outcome"],
) {
  const released = [];
  for (const phase of ["generation", "review"] as const) {
    if (
      f.data.events.some((v) => v.payload.kind === "dispatch-intent" && v.payload.phase === phase)
    )
      continue;
    const b = budget(f),
      s = b.reservations
        .find((r) => r.runId === f.data.run.id)!
        .phases.find((v) => v.phase === phase)!;
    const e = core.createProviderExecutionBudgetEvent({
      schemaVersion: 2,
      scopeId: b.scopeId,
      environment: "production",
      provenance: "explicit-user",
      revision: b.revision + 1,
      previousDigest: b.headDigest,
      eventId: randomUUID(),
      recordedAt: recordedAt,
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
            content: initialPlan(f),
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
export function complete<T extends Fixture>(f: T): T {
  for (const phase of ["generation", "review"] as const) {
    prepare(f, phase);
    dispatch(f, phase);
    receive(f, phase);
    validate(f, phase);
  }
  finish(f, "completed");
  return f;
}
