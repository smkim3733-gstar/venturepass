import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectProviderTransmissionApprovalArchive as inspect,
  createProviderTransmissionApprovalMigrationCoverage as cutover,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  assessProviderUsage,
  providerResponseMetadata,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  createProviderExecutionArtifact,
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
  providerUsageRecognitionPayload,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { prepareProviderTransmissionApproval } from "./studio-plan-quality-provider-transmission-plan";
import {
  transmissionCommandFor,
  transmissionReview,
} from "./studio-plan-quality-provider-transmission-test-helpers";
import { generationDispatchFixture } from "./studio-plan-quality-provider-dispatch-test-helpers";
import {
  adopt,
  config,
  prepared,
  refresh,
  registry,
  withRows,
} from "./studio-plan-quality-provider-reservation-test-helpers";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import {
  prepareProviderGenerationDispatch as prepare,
  providerGenerationDispatchPlanLimits as limits,
  type ProviderGenerationDispatchInput,
} from "./studio-plan-quality-provider-dispatch-plan";

vi.mock("./studio-plan-quality-store", () => {
  throw new Error("No DB in planning");
});
vi.mock("./studio-provider-observation", () => {
  throw new Error("No transport in planning");
});
vi.mock("openai", () => {
  throw new Error("No SDK in planning");
});
const base = generationDispatchFixture();
let f: typeof base;
const external = vi.fn(() => {
  throw new Error("No external request");
});
const wrong = "a".repeat(64);
function plan(input = f.input) {
  const result = prepare(input);
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function refuse(reason: string, input = f.input) {
  expect(prepare(input)).toEqual({ status: "refused", reason, plan: null });
}
function identity() {
  return f.input.identity as Record<string, string>;
}
function append(count = 2) {
  const p = plan();
  f.input.archive.archive.ledger.events.push(...p.rows.events.slice(0, count));
  f.input.archive.archive.ledger.receipts.push(...p.rows.receipts.slice(0, count));
  return p;
}
function resign(c: ReturnType<typeof config>) {
  c.configurationDigest = digest(providerConfigurationDigestInput(c));
  return c;
}
beforeEach(() => {
  f = structuredClone(base);
  external.mockClear();
  vi.stubGlobal("fetch", external);
});
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("plans the exact original request and native r2/r3 rows without granting or making a transmission", () => {
  const before = structuredClone(f),
    p = plan();
  expect(f).toEqual(before);
  expect(p).toMatchObject({
    status: "prepared-not-committed",
    transaction: "single-immediate-transaction-required",
    ownership: "new-commit-owner-required",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
  });
  expect(p.expiresAt).toBe(f.approval.rows.binding.approvedReview.expiresAt);
  const prep = f.transmission.reservation.rows.run.preparation;
  expect(p.request.body).toEqual(prep.generation.body);
  expect(p.request.rawBody).toBe(f.transmission.reservation.rows.artifact.body);
  expect(p.request.request).toMatchObject({
    model: prep.model,
    requestDigest: prep.generation.requestDigest,
    artifactSha256: prep.generation.sha256,
    phase: "generation",
    sequence: 1,
  });
  expect(p.rows.events.map((e) => [e.revision, e.payload.kind])).toEqual([
    [2, "request-prepared"],
    [3, "dispatch-intent"],
  ]);
  expect(p.rows.receipts.map((r) => [r.runRevision, r.kind])).toEqual([
    [2, "provider-prepared"],
    [3, "provider-dispatch"],
  ]);
  expect(p.rows.events[0].previousEventDigest).toBe(f.approval.rows.event.eventDigest);
  expect(p.rows.events[1].previousEventDigest).toBe(p.rows.events[0].eventDigest);
  expect(p.basis.approvalBindingDigest).toBe(f.approval.rows.binding.recordDigest);
  const { planDigest, ...body } = p;
  expect(planDigest).toBe(digest(body));
});
it("uses only explicit time, is deterministic and deeply detaches/freezes results", () => {
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("No wall clock");
  });
  const input = freezeProviderValue(structuredClone(f.input));
  const p = plan(input);
  expect(plan(input)).toEqual(p);
  expect(Object.isFrozen(p.request.body.input)).toBe(true);
  expect(Object.isFrozen(p.rows.events[0].payload)).toBe(true);
  expect(() => {
    p.request.body.model = "changed";
  }).toThrow();
  (f.input.identity as Record<string, string>).runId = randomUUID();
  expect(p.basis.runId).toBe(base.approval.rows.binding.runId);
});
it("proposed native rows pass the COMPLETE v9 audit and preserve budget, artifact and approval bytes", () => {
  const before = structuredClone(f.input.archive),
    p = append();
  const next = inspect(f.input.archive),
    snapshot = next.reservationArchive.ledger.provider.snapshots[0];
  expect(snapshot).toMatchObject({
    revision: 3,
    state: "dispatching",
    dispatchIntentCount: 1,
    responseCount: 0,
    dispatchAllowed: false,
    actualAiCalls: null,
  });
  expect(f.input.archive.archive.ledger.budgetEvents).toEqual(before.archive.ledger.budgetEvents);
  expect(f.input.archive.archive.ledger.artifacts).toEqual(before.archive.ledger.artifacts);
  expect(f.input.archive.records).toEqual(before.records);
  expect(f.input.archive.archive.records).toEqual(before.archive.records);
  const native = next.reservationArchive.ledger;
  expect(p.capacity.totalExposureBytes).toBe(
    native.usedBytes + native.reservedBytes + next.reservationArchive.usedBytes + next.usedBytes,
  );
  expect(p.capacity.reservedReceiptSlots).toBe(
    inspect(before).reservationArchive.ledger.reservedReceiptSlots - 2,
  );
});
it.each([1, 2])(
  "refuses a previously recorded prefix of %i rows, including with fresh nonces",
  (count) => {
    append(count);
    refuse("first-generation-required");
    Object.assign(identity(), { preparedRequestId: randomUUID(), dispatchRequestId: randomUUID() });
    refuse("first-generation-required");
  },
);
it("will not turn a native-only legacy approval into a current bound approval", () => {
  f.input.archive.coverage = cutover(f.input.archive.archive);
  f.input.archive.records = [];
  expect(() => inspect(f.input.archive)).not.toThrow();
  refuse("approval-binding-required");
});
it("requires explicit approval even if the untouched reservation itself is valid", () => {
  f.input.archive.archive.ledger.events.pop();
  f.input.archive.archive.ledger.receipts.pop();
  f.input.archive.records = [];
  expect(() => inspect(f.input.archive)).not.toThrow();
  refuse("approval-binding-required");
});

it.each([
  null,
  {},
  { ...(base.input.identity as object), model: "another" },
  { ...(base.input.identity as object), transport: "openai" },
  { ...(base.input.identity as object), baseURL: "https://example.invalid" },
  { ...(base.input.identity as object), dispatchAllowed: true },
])("rejects malformed or transport-overriding identity %#", (value) => {
  f.input.identity = value;
  refuse("invalid-input");
});
it.each(["runId", "runDigest", "approvalBindingDigest", "preparedRequestId", "dispatchRequestId"])(
  "strictly validates identity field %s",
  (key) => {
    identity()[key] = "invalid";
    refuse("invalid-input");
  },
);
it.each(["runId", "runDigest"])("refuses a different selected %s", (key) => {
  identity()[key] = key === "runId" ? randomUUID() : wrong;
  refuse("selection-changed");
});
it("requires the exact whole approval binding, not just the native receipt", () => {
  identity().approvalBindingDigest = wrong;
  refuse("approval-binding-required");
});
it.each(["preparedRequestId", "dispatchRequestId"])(
  "rejects globally used %s in all receipt/nonce domains",
  (key) => {
    const state = inspect(f.input.archive).reservationArchive.ledger;
    for (const used of [
      ...f.input.archive.archive.ledger.otherNonces!,
      ...state.provider.receipts.map((r) => r.clientRequestId),
      ...state.policy.records.map((r) => r.clientRequestId),
    ]) {
      identity()[key] = used;
      refuse("nonce-conflict");
    }
  },
);
it("requires distinct prepared and dispatch nonces", () => {
  identity().dispatchRequestId = identity().preparedRequestId;
  refuse("nonce-conflict");
});
it.each(["not-a-date", "2026-09-27", "2026-09-27T03:35:00"])("rejects malformed time %s", (at) => {
  f.input.inspectedAt = at;
  refuse("invalid-input");
});
it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid external byte count %s",
  (n) => {
    f.input.additionalUsedBytes = n;
    refuse("invalid-input");
  },
);
it.each(["before", "exact-expiry", "after"])("cannot extend original approval at %s", (which) => {
  const at =
    which === "before"
      ? Date.parse(f.approval.rows.binding.recordedAt) - 1
      : Date.parse(f.approval.rows.binding.approvedReview.expiresAt) + (which === "after" ? 1 : 0);
  f.input.inspectedAt = new Date(at).toISOString();
  refuse("approval-expired-or-future");
});
it("accepts the exact approval record instant and final millisecond before expiry without extending it", () => {
  const expiry = f.approval.rows.binding.approvedReview.expiresAt;
  for (const at of [
    f.approval.rows.binding.recordedAt,
    new Date(Date.parse(expiry) - 1).toISOString(),
  ]) {
    f.input.inspectedAt = at;
    expect(plan().expiresAt).toBe(expiry);
  }
});
it.each(["missing", "tampered", "replaced"])("rejects %s server configuration", (kind) => {
  const c = config();
  c.proposedBudget.capUnits = "30000000";
  f.input.configuration = kind === "missing" ? null : kind === "tampered" ? c : resign(c);
  refuse("current-evidence-unavailable");
});
it("blocks an identical policy newly adopted for the same candidate", () => {
  adopt(f.input.archive.archive.ledger, 0, config(), f.input.inspectedAt);
  refuse("policy-or-budget-blocked");
});
it("rechecks the new global policy head while permitting an unchanged selected candidate reference", () => {
  const p = plan();
  adopt(f.input.archive.archive.ledger, 1, config(), f.input.inspectedAt);
  const next = plan();
  expect(next.basis.policyHead.revision).toBe(p.basis.policyHead.revision + 1);
  expect(next.basis.archiveDigest).not.toBe(p.basis.archiveDigest);
  expect(next.planDigest).not.toBe(p.planDigest);
  expect(next.request).toEqual(p.request);
});
it("rejects future unrelated records instead of backdating dispatch", () => {
  adopt(f.input.archive.archive.ledger, 1, config(), "2026-09-27T03:36:00.000Z");
  refuse("current-evidence-unavailable");
});
it("uses the existing full hold when available unreserved budget is zero", () => {
  const c = config();
  c.proposedBudget.capUnits = "11220000";
  f = generationDispatchFixture(resign(c));
  expect(plan().basis.budgetHead.revision).toBe(2);
  expect(f.approval.rows.binding.approvedReview.budget.availableUnits).toBe("0");
});
it.each([1000, 600000, 2000000])(
  "rechecks another run's actual usage (%i output tokens) against the shared budget",
  (outputTokens) => {
    const c = config();
    c.proposedBudget.capUnits = "30000000";
    f = generationDispatchFixture(resign(c));
    const input = f.transmission.reservationInput,
      ledger = f.input.archive.archive.ledger;
    const at = f.input.inspectedAt;
    adopt(ledger, 1, c, at);
    input.current.inspectedAt = at;
    input.current.selection = {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[1].candidateId,
    };
    input.runId = randomUUID();
    refresh(input);
    const reserved = prepared(input);
    withRows(input, reserved);
    f.input.archive.archive.records.push(reserved.rows.binding);
    const run = reserved.rows.run;
    const current = {
      selection: { runId: run.id, runDigest: run.runDigest },
      inspectedAt: at,
      configuration: c,
      archive: f.input.archive.archive,
    };
    const review = transmissionReview(current),
      command = transmissionCommandFor(review);
    command.approval.approvedAt = at;
    const approval = prepareProviderTransmissionApproval({
      command,
      review,
      current,
      additionalUsedBytes: inspect(f.input.archive).usedBytes,
    });
    if (approval.status !== "prepared") throw new Error(approval.reason);
    ledger.events.push(approval.plan.rows.event);
    ledger.receipts.push(approval.plan.rows.receipt);
    f.input.archive.records.push(approval.plan.rows.binding);
    const second = plan({
      ...f.input,
      identity: {
        runId: run.id,
        runDigest: run.runDigest,
        approvalBindingDigest: approval.plan.rows.binding.recordDigest,
        preparedRequestId: randomUUID(),
        dispatchRequestId: randomUUID(),
      },
    });
    ledger.events.push(...second.rows.events);
    ledger.receipts.push(...second.rows.receipts);
    const dispatch = second.rows.events[1];
    const raw = {
      id: "synthetic-response",
      _request_id: "synthetic-request",
      model: run.preparation.model,
      service_tier: "default",
      status: "completed",
      usage: {
        input_tokens: 1,
        output_tokens: outputTokens,
        total_tokens: outputTokens + 1,
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
      policy: review.manifest.executionContract.usagePolicy,
      financialBasis: run.preparation.financialBasis,
      phase: "generation",
    });
    const usage = providerUsageRecognitionPayload(
      run,
      "generation",
      dispatch.eventDigest,
      artifact.sha256,
      assessment,
    );
    if (!usage) throw new Error("Expected known synthetic usage");
    const native = inspect(f.input.archive).reservationArchive.ledger;
    const b = getProviderExecutionBudgetSnapshot(
      native.provider.budgetEvents,
      run.preparation.budget.scopeId,
    );
    const nonce = randomUUID();
    const budgetEvent = createProviderExecutionBudgetEvent({
      schemaVersion: 2,
      scopeId: b.scopeId,
      environment: "production",
      provenance: "explicit-user",
      revision: b.revision + 1,
      previousDigest: b.headDigest,
      eventId: nonce,
      recordedAt: at,
      currency: b.currency!,
      unitScale: b.unitScale!,
      payload: usage,
    });
    const payload = {
      kind: "response-received" as const,
      phase: "generation" as const,
      requestDigest: run.preparation.generation.requestDigest,
      dispatchEventDigest: dispatch.eventDigest,
      artifactSha256: artifact.sha256,
      metadata: providerResponseMetadata(raw, {
        configuredModel: run.preparation.model,
        requestedTier: "default",
      }),
    };
    const response = createProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 1,
      runId: run.id,
      revision: 4,
      budgetRevision: budgetEvent.revision,
      previousEventDigest: dispatch.eventDigest,
      recordedAt: at,
      payload: {
        ...payload,
        usageAssessment: assessment,
        usageBudgetEventDigest: budgetEvent.eventDigest,
      },
    });
    ledger.budgetEvents.push(budgetEvent);
    ledger.artifacts.push(artifact);
    ledger.events.push(response);
    ledger.receipts.push(
      createProviderExecutionReceipt({
        schemaVersion: 2,
        scopeId: b.scopeId,
        kind: "provider-response",
        clientRequestId: nonce,
        inputDigest: providerExecutionOperationDigest(run.id, {
          clientRequestId: nonce,
          expectedRevision: 3,
          payload,
          artifact,
        }),
        runId: run.id,
        runRevision: 4,
        budgetRevision: budgetEvent.revision,
        operationDigest: response.eventDigest,
        recordedAt: at,
      }),
    );
    const observed = inspect(f.input.archive).reservationArchive.ledger;
    const budget = getProviderExecutionBudgetSnapshot(observed.provider.budgetEvents, b.scopeId);
    expect(observed.provider.snapshots[0].state).toBe("approved");
    if (outputTokens === 1000) {
      expect(plan().basis.budgetHead).toEqual({
        revision: budget.revision,
        headDigest: budget.headDigest,
      });
    } else {
      expect(budget.boundBreached).toBe(true);
      if (outputTokens === 600000) expect(BigInt(budget.availableUnits)).toBeGreaterThan(BigInt(0));
      else expect(BigInt(budget.deficitUnits)).toBeGreaterThan(BigInt(0));
      refuse("policy-or-budget-blocked");
    }
  },
);
it("counts native reservation, v8/v9 bindings and extra raw bytes at the exact shared capacity boundary", () => {
  const p = plan();
  f.input.additionalUsedBytes = limits.databaseBytes - p.capacity.totalExposureBytes;
  expect(plan().capacity.totalExposureBytes).toBe(limits.databaseBytes);
  f.input.additionalUsedBytes++;
  refuse("capacity-exceeded");
});

const corruptions: [string, (input: ProviderGenerationDispatchInput) => void][] = [
  [
    "missing approval coverage",
    (v) => {
      v.archive.coverage = null;
    },
  ],
  [
    "missing approval binding",
    (v) => {
      v.archive.records = [];
    },
  ],
  [
    "duplicate approval binding",
    (v) => {
      v.archive.records.push(v.archive.records[0]);
    },
  ],
  [
    "altered approval binding",
    (v) => {
      Object.assign(v.archive.records[0] as object, { recordDigest: wrong });
    },
  ],
  [
    "missing reservation binding",
    (v) => {
      v.archive.archive.records = [];
    },
  ],
  [
    "missing reservation coverage",
    (v) => {
      v.archive.archive.coverage = null;
    },
  ],
  [
    "missing approval receipt",
    (v) => {
      v.archive.archive.ledger.receipts.pop();
    },
  ],
  [
    "changed generation bytes",
    (v) => {
      Object.assign(v.archive.archive.ledger.artifacts[0] as object, { body: "{}" });
    },
  ],
  [
    "changed approval event",
    (v) => {
      Object.assign(v.archive.archive.ledger.events[0] as object, { eventDigest: wrong });
    },
  ],
  [
    "missing registry",
    (v) => {
      v.archive.archive.ledger.registries = [];
    },
  ],
];
it.each(corruptions)("rejects complete archive corruption: %s", (_, mutate) => {
  mutate(f.input);
  refuse("archive-invalid");
});
