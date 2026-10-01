/** Synthetic stop plans only; no DB, provider request, or operational budget. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
vi.mock("./studio-plan-quality-store", () => {
  throw Error("No DB in stop planning");
});
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
import {
  fixture,
  executionBase,
  prepare,
  dispatch,
  receive,
  validate,
  snapshot,
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import {
  prepareVersionedProviderGenerationStop as generationStop,
  prepareProviderGenerationStop as frozenGeneration,
  type ProviderGenerationStopIdentity,
  type ProviderGenerationStopInput,
} from "./studio-plan-quality-provider-generation-stop";
import {
  prepareVersionedProviderReviewStop as reviewStop,
  prepareProviderReviewStop as frozenReview,
  type ProviderReviewStopIdentity,
} from "./studio-plan-quality-provider-review-stop";
import { generationStopFixture } from "./studio-plan-quality-provider-generation-stop-test-helpers";
import { reviewStopFixture } from "./studio-plan-quality-provider-review-stop-test-helpers";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import { inspectVersionedProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest, providerRawDigest } from "../../scripts/local-data-quality-provider.mjs";
import {
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
  versionedProviderExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import * as generationValidation from "./studio-plan-quality-provider-generation-validation";
import * as reviewValidation from "./studio-plan-quality-provider-review-validation";
import * as configuration from "./studio-plan-quality-provider-configuration";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
type Phase = "generation" | "review";
type Kind = "unobserved" | "unknown" | "bound" | "invalid" | "valid";
type Input = ProviderGenerationStopInput;
const fixed = readFixedProviderConfiguration()!;
function make(phase: Phase, kind: Kind) {
  const f = fixture(executionBase());
  prepare(f, "generation");
  dispatch(f, "generation");
  if (phase === "review") {
    receive(f, "generation");
    validate(f, "generation");
    prepare(f, "review");
    dispatch(f, "review");
  }
  if (kind !== "unobserved")
    receive(f, phase, (raw) => {
      if (kind === "unknown") delete raw.usage;
      if (kind === "bound")
        raw.usage = {
          input_tokens: 20,
          output_tokens: 600000,
          total_tokens: 600020,
          input_tokens_details: { cached_tokens: 5 },
        };
      if (kind === "invalid") raw.output = [];
    });
  const nonce = (revision: number) =>
    f.data.receipts.find((r) => r.runRevision === revision)!.clientRequestId;
  const archive = f.upper();
  const generation = {
    runId: f.data.run.id,
    runDigest: f.data.run.runDigest,
    approvalBindingDigest: archive.records[0].recordDigest,
    preparedRequestId: nonce(2),
    dispatchRequestId: nonce(3),
  };
  const review =
    phase === "review"
      ? {
          generation: {
            dispatch: generation,
            responseRequestId: nonce(4),
            responseEventDigest: f.data.events[3].eventDigest,
            validationRequestId: nonce(5),
          },
          validationEventDigest: f.data.events[4].eventDigest,
          preparedRequestId: nonce(6),
          dispatchRequestId: nonce(7),
        }
      : null;
  const revision = phase === "generation" ? 4 : 8;
  const input: Input = {
    archive,
    inspectedAt: "2026-09-27T03:34:00.000Z",
    additionalUsedBytes: 0,
    identity: {
      dispatch: review ?? generation,
      stopRequestId: randomUUID(),
      observation:
        kind === "unobserved"
          ? { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" }
          : {
              kind: "response",
              responseRequestId: nonce(revision),
              responseEventDigest: f.data.events[revision - 1].eventDigest,
            },
    },
  };
  return { f, input };
}
const phases = ["generation", "review"] as const;
const kinds = ["unobserved", "unknown", "bound", "invalid", "valid"] as const;
const bases = Object.fromEntries(
  phases.map((phase) => [
    phase,
    Object.fromEntries(kinds.map((kind) => [kind, make(phase, kind).input])),
  ]),
) as Record<Phase, Record<Kind, Input>>;
const legacy = { generation: generationStopFixture(), review: reviewStopFixture() };
const run = (phase: Phase, input: Input, version: PlanPromptVersion = v2) =>
  phase === "generation" ? generationStop(version, input) : reviewStop(version, input);
const frozen = (phase: Phase, input: Input) =>
  phase === "generation" ? frozenGeneration(input) : frozenReview(input);
function plan(phase: Phase, input: Input) {
  const r = run(phase, input);
  if (r.status !== "prepared") throw Error(r.reason);
  return r.plan;
}
const id = (input: Input) =>
  input.identity as ProviderGenerationStopIdentity | ProviderReviewStopIdentity;
const runId = (input: Input) => {
  const dispatch = id(input).dispatch;
  return "generation" in dispatch ? dispatch.generation.dispatch.runId : dispatch.runId;
};
function apply(input: Input, p: ReturnType<typeof plan>) {
  const archive = structuredClone(input.archive),
    ledger = archive.archive.ledger;
  if ("budgetEvent" in p.rows) ledger.budgetEvents.push(p.rows.budgetEvent);
  ledger.events.push(p.rows.event);
  ledger.receipts.push(p.rows.receipt);
  return archive;
}
const state = (input: Input) => inspect(input.archive).reservationArchive.ledger.provider;
function budget(input: Input) {
  const s = state(input),
    scope = s.snapshots.find((r) => r.run.id === runId(input))!.run.preparation.budget.scopeId;
  return getProviderExecutionBudgetSnapshot(
    s.budgetEvents.filter((r) => r.scopeId === scope),
    scope,
  );
}
const reason = (result: ReturnType<typeof run>, expected: string) =>
  expect(result).toMatchObject({ status: "refused", reason: expected });
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(
  phases.flatMap((phase) =>
    kinds.filter((k) => k !== "valid").map((kind) => [phase, kind] as const),
  ),
)("%s %s preserves costs and only releases a never-dispatched review", (phase, kind) => {
  const input = structuredClone(bases[phase][kind]),
    before = JSON.stringify(input),
    p = plan(phase, input);
  const next = state({ ...input, archive: apply(input, p) });
  const outcomes = {
    unobserved: "result-unobserved",
    unknown: "needs-cost-review",
    bound: "bound-breached",
    invalid: "output-invalid",
  };
  expect(p).toMatchObject({
    planVersion: 2,
    status: "prepared-not-committed",
    transaction: "single-immediate-transaction-required",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
    command: { payload: { outcome: outcomes[kind] } },
    rows: { event: { executionContractVersion: 2 } },
  });
  const s = next.snapshots.find((s) => s.run.id === runId(input))!;
  expect(s).toMatchObject({
    archiveFormatVersion: 5,
    terminal: true,
    state: outcomes[kind],
    canResume: false,
    dispatchAllowed: false,
  });
  const b = budget(input),
    n = budget({ ...input, archive: apply(input, p) });
  expect(n.recognizedUnits).toBe(b.recognizedUnits);
  const originalPhases = b.reservations.find((r) => r.runId === runId(input))!.phases;
  const nextPhases = n.reservations.find((r) => r.runId === runId(input))!.phases;
  expect(nextPhases[0]).toEqual(originalPhases[0]);
  if (phase === "review") expect(n).toEqual(b);
  else {
    expect(nextPhases[1]).toMatchObject({
      settled: true,
      heldUnits: "0",
      releasedUnits: originalPhases[1].heldUnits,
    });
    expect(p.rows).toHaveProperty("budgetEvent.payload.reason", "not-dispatched");
  }
  expect(p.rows.receipt.inputDigest).toBe(
    versionedProviderExecutionOperationDigest(runId(input), p.command),
  );
  expect(p.rows.receipt.inputDigest).not.toBe(
    providerExecutionOperationDigest(runId(input), p.command),
  );
  expect(JSON.stringify(input)).toBe(before);
  expect(plan(phase, input)).toEqual(p);
  expect(Object.isFrozen(p.rows.event.payload)).toBe(true);
  const { planDigest, ...body } = p;
  expect(planDigest).toBe(providerDigest(body));
  reason(run(phase, { ...input, archive: apply(input, p) }), phase + "-prefix-changed");
});
it.each(phases)("%s refuses valid output and preserves frozen v1 behavior", (phase) => {
  reason(run(phase, bases[phase].valid), phase + "-valid");
  expect(JSON.stringify(run(phase, legacy[phase].input, v1))).toBe(
    JSON.stringify(frozen(phase, legacy[phase].input)),
  );
  reason(frozen(phase, bases[phase].invalid), "archive-invalid");
  reason(run(phase, bases[phase].invalid, v1), "server-version-mismatch");
  reason(run(phase, legacy[phase].input), "server-version-mismatch");
});
it.each(phases)("%s allows late observation once without reopening or resending", (phase) => {
  const { f, input } = make(phase, "unobserved"),
    p = plan(phase, input);
  if ("budgetEvent" in p.rows) f.data.budgetEvents.push(p.rows.budgetEvent);
  f.data.events.push(p.rows.event as (typeof f.data.events)[number]);
  f.data.receipts.push(p.rows.receipt);
  receive(f, phase);
  const s = snapshot(f);
  expect(s).toMatchObject({
    terminal: true,
    state: "result-unobserved",
    dispatchAllowed: false,
    canResume: false,
    dispatchIntentCount: phase === "generation" ? 1 : 2,
    responseCount: phase === "generation" ? 1 : 2,
  });
  expect(budget({ ...input, archive: f.upper() }).heldUnits).toBe("0");
  expect(() => receive(f, phase)).toThrow("QUALITY_PROVIDER_EXECUTION_INVALID");
  expect(() => inspect(f.upper())).toThrow();
});
it.each(phases)("%s binds original nonces, exact observed event and first manuscript", (phase) => {
  const a = structuredClone(bases[phase].invalid),
    identity = id(a);
  identity.stopRequestId = identity.dispatch.preparedRequestId;
  reason(run(phase, a), "nonce-conflict");
  identity.stopRequestId = randomUUID();
  if (identity.observation.kind !== "response") throw Error("response");
  identity.observation.responseRequestId = randomUUID();
  reason(run(phase, a), "observation-changed");
  const b = structuredClone(bases[phase].invalid),
    d = id(b).dispatch;
  if ("generation" in d) d.generation.responseEventDigest = "0".repeat(64);
  else d.dispatchRequestId = randomUUID();
  reason(run(phase, b), "bindings-changed");
});
it.each(phases)(
  "%s rejects rehashed original request and wrong event/receipt evidence",
  (phase) => {
    for (const key of ["generation-request", phase + "-response"]) {
      const input = structuredClone(bases[phase].invalid);
      const row = input.archive.archive.ledger.artifacts.find(
        (a) => (a as { key: string }).key === key,
      ) as { body: string; sha256: string; sizeBytes: number };
      row.body += " ";
      row.sha256 = providerRawDigest(row.body);
      row.sizeBytes = Buffer.byteLength(row.body);
      reason(run(phase, input), "archive-invalid");
    }
    for (const key of ["events", "receipts"] as const) {
      const input = structuredClone(bases[phase].invalid);
      const row = input.archive.archive.ledger[key].at(-1) as Record<string, unknown>;
      if (key === "events") row.executionContractVersion = 1;
      else row.inputDigest = "0".repeat(64);
      reason(run(phase, input), "archive-invalid");
    }
  },
);
it.each(phases)("%s rejects caller authority and unsupported explicit versions", (phase) => {
  for (const key of [
    "version",
    "configuration",
    "contract",
    "tokenEvidence",
    "tokenAssessment",
    "dispatchAllowed",
    "outcome",
  ]) {
    reason(run(phase, { ...bases[phase].invalid, [key]: true }), "invalid-input");
  }
  for (const version of [undefined, null, "unsupported"]) {
    expect(() =>
      (phase === "generation" ? generationStop : reviewStop)(
        version as PlanPromptVersion,
        bases[phase].invalid,
      ),
    ).toThrow();
  }
});
it.each(phases)("%s preserves holds for validator/contract infrastructure failures", (phase) => {
  const spy =
    phase === "generation"
      ? vi.spyOn(generationValidation, "prepareVersionedProviderGenerationValidation")
      : vi.spyOn(reviewValidation, "prepareVersionedProviderReviewValidation");
  spy.mockImplementation(() => {
    throw Error("validator unavailable");
  });
  reason(run(phase, bases[phase].invalid), "validation-unavailable");
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockReturnValue({ status: "refused", reason: "validation-contract-changed", plan: null });
  reason(run(phase, bases[phase].invalid), "validation-contract-changed");
  expect(spy).toHaveBeenCalledTimes(2);
});
it.each(phases)(
  "%s checks explicit time/capacity while permitting archival stops after expiry",
  (phase) => {
    const input = structuredClone(bases[phase].invalid),
      p = plan(phase, input),
      max = 256 * 1024 * 1024;
    reason(run(phase, { ...input, inspectedAt: "2026-09-27T03:33:00.000Z" }), "invalid-input");
    const free = max - Math.max(p.capacity.beforeExposureBytes, p.capacity.totalExposureBytes);
    expect(run(phase, { ...input, additionalUsedBytes: free }).status).toBe("prepared");
    reason(run(phase, { ...input, additionalUsedBytes: free + 1 }), "capacity-exceeded");
    vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
    vi.spyOn(Date, "now").mockImplementation(forbidden);
    expect(run(phase, { ...input, inspectedAt: "2035-01-01T00:00:00.000Z" }).status).toBe(
      "prepared",
    );
  },
);
it("keeps v1/v2 simultaneous server selection and cloned configuration after loading", async () => {
  const c = structuredClone(fixed);
  const a = createServerProviderPolicyContext(v1, c),
    b = createServerProviderPolicyContext(v2, c);
  Object.assign(c, { model: "caller-change" });
  const [old, current] = await Promise.all([
    a.loadValidationPlanning(),
    b.loadValidationPlanning(),
  ]);
  for (const phase of phases) {
    const name = phase === "generation" ? "prepareGenerationStop" : "prepareReviewStop";
    expect(JSON.stringify(old[name](legacy[phase].input))).toBe(
      JSON.stringify(frozen(phase, legacy[phase].input)),
    );
    expect(current[name](bases[phase].invalid)).toEqual(run(phase, bases[phase].invalid));
    reason(old[name](bases[phase].invalid), "server-version-mismatch");
    expect(() => current[name]({ ...bases[phase].invalid, tokenEvidence: {} } as Input)).toThrow();
    const copy = structuredClone(bases[phase].invalid),
      p = current[name](copy);
    (copy.identity as ProviderGenerationStopIdentity).stopRequestId = randomUUID();
    expect(p).toEqual(run(phase, bases[phase].invalid));
  }
});
