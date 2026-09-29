import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  prepareProviderGenerationStop as prepare,
  type ProviderGenerationStopIdentity,
} from "./studio-plan-quality-provider-generation-stop";
import {
  generationStopFixture,
  applyGenerationStopPlan,
  appendLateStopTestResponse,
} from "./studio-plan-quality-provider-generation-stop-test-helpers";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { prepareProviderGenerationValidation } from "./studio-plan-quality-provider-generation-validation";
import * as engine from "./studio-engine";
import * as native from "../../scripts/local-data-quality-provider-execution.mjs";
import * as configuration from "./studio-plan-quality-provider-configuration";
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
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
vi.mock("./studio-plan-quality-store", () => {
  throw Error("No DB in pure stop preparation");
});
const bases = {
  unobserved: generationStopFixture("unobserved"),
  unknown: generationStopFixture("unknown"),
  bound: generationStopFixture("bound"),
  invalid: generationStopFixture("invalid"),
  valid: generationStopFixture("valid"),
};
let f = structuredClone(bases.invalid);
beforeEach(() => {
  f = structuredClone(bases.invalid);
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const identity = () => f.input.identity as ProviderGenerationStopIdentity;
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
function refuse(reason: string) {
  const result = prepare(f.input);
  expect(result.status).toBe("refused");
  if (result.status === "refused") expect(result.reason).toBe(reason);
}
function state(archive = f.input.archive) {
  return inspect(archive).reservationArchive.ledger.provider;
}
function reservation(archive = f.input.archive) {
  const s = state(archive),
    run = s.snapshots.find((row) => row.run.id === identity().dispatch.runId)!;
  return native
    .getProviderExecutionBudgetSnapshot(
      s.budgetEvents.filter((row) => row.scopeId === run.run.preparation.budget.scopeId),
      run.run.preparation.budget.scopeId,
    )
    .reservations.find((row) => row.runId === run.run.id)!;
}
it.each([
  ["unobserved", "result-unobserved", "INTERRUPTED"],
  ["unknown", "needs-cost-review", "COST_UNSETTLED"],
  ["bound", "bound-breached", "BOUND_BREACHED"],
  ["invalid", "output-invalid", "OUTPUT_INVALID"],
] as const)(
  "derives %s stop from audited evidence and releases only review",
  (kind, outcome, failureCode) => {
    f = structuredClone(bases[kind]);
    const before = structuredClone(f),
      own = reservation(),
      p = plan(),
      after = applyGenerationStopPlan(f.input, p),
      next = reservation(after);
    expect(f).toEqual(before);
    expect(plan()).toEqual(p);
    expect(p).toMatchObject({
      status: "prepared-not-committed",
      transaction: "single-immediate-transaction-required",
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      command: {
        payload: { kind: "execution-stopped", outcome, failureCode, finalArtifactSha256: null },
      },
      rows: { budgetEvent: { payload: { phase: "review", reason: "not-dispatched" } } },
    });
    expect(next.phases[0]).toEqual(own.phases[0]);
    expect(next.phases[1]).toEqual({
      ...own.phases[1],
      settled: true,
      heldUnits: "0",
      releasedUnits: own.phases[1].heldUnits,
    });
    expect(
      state(after).budgets.find((row) => row.scopeId === p.rows.budgetEvent.scopeId)!
        .recognizedUnits,
    ).toBe(p.budget.recognizedUnits);
    expect(state(after).snapshots[0]).toMatchObject({
      state: outcome,
      terminal: true,
      canResume: false,
      dispatchIntentCount: 1,
      responseCount: kind === "unobserved" ? 0 : 1,
      dispatchAllowed: false,
    });
    expect(after.archive.ledger.artifacts).toEqual(f.input.archive.archive.ledger.artifacts);
    expect(after.records).toEqual(f.input.archive.records);
    expect(Object.isFrozen(p.rows.event.payload)).toBe(true);
    expect(p.rows.receipt.inputDigest).toBe(
      native.providerExecutionOperationDigest(identity().dispatch.runId, p.command),
    );
    const { planDigest, ...body } = p;
    expect(planDigest).toBe(digest(body));
  },
);
it("does not stop a valid generation or prepare review as a side effect", () => {
  f = structuredClone(bases.valid);
  const before = structuredClone(f);
  refuse("generation-valid");
  expect(f).toEqual(before);
});
it.each(["unobserved", "unknown", "bound", "invalid"] as const)(
  "supports offline %s classification after expiry without current configuration",
  (kind) => {
    f = structuredClone(bases[kind]);
    f.input.inspectedAt = "2035-01-01T00:00:00.000Z";
    const spy = vi
      .spyOn(configuration, "getProviderConfigurationProposal")
      .mockImplementation(forbidden);
    expect(plan().dispatchAllowed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  },
);
it.each(["unobserved", "unknown", "bound"] as const)(
  "does not need today's domain validator to establish %s financial evidence",
  (kind) => {
    f = structuredClone(bases[kind]);
    const spy = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(forbidden);
    expect(prepare(f.input).status).toBe("prepared");
    expect(spy).not.toHaveBeenCalled();
  },
);
it("distinguishes a changed validation contract from invalid generation", () => {
  const original = engine.getPlanExecutionContract();
  vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
    ...original,
    contractDigest: "0".repeat(64),
  });
  refuse("validation-contract-changed");
});
it.each(["contract", "validator", "native-validator"])(
  "preserves holds when the %s unexpectedly fails",
  (kind) => {
    f = structuredClone(bases.valid);
    if (kind === "contract")
      vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(() => {
        throw Error("internal failure");
      });
    if (kind === "validator")
      vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(() => {
        throw Error("internal failure");
      });
    if (kind === "native-validator")
      vi.spyOn(native, "validateProviderExecutionOutput").mockImplementation(() => {
        throw Error("internal failure");
      });
    const before = structuredClone(f);
    refuse("validation-unavailable");
    expect(f).toEqual(before);
  },
);
it("requires explicit acknowledgement that an unobserved response may still arrive", () => {
  f = structuredClone(bases.unobserved);
  f.input.identity = { ...identity(), observation: { kind: "unobserved" } };
  refuse("invalid-input");
});
it.each(["outcome", "failureCode", "releasedUnits", "configuration", "dispatchAllowed"])(
  "rejects caller supplied %s",
  (field) => {
    f.input.identity = { ...identity(), [field]: "override" };
    refuse("invalid-input");
  },
);
it.each([
  "runId",
  "runDigest",
  "approvalBindingDigest",
  "preparedRequestId",
  "dispatchRequestId",
] as const)("binds the original %s", (field) => {
  identity().dispatch[field] = field.endsWith("Digest") ? "0".repeat(64) : randomUUID();
  refuse("bindings-changed");
});
it.each(["responseRequestId", "responseEventDigest"] as const)(
  "binds observed response %s",
  (field) => {
    const observation = identity().observation;
    if (observation.kind !== "response") throw Error("Response required");
    observation[field] = field === "responseRequestId" ? randomUUID() : "0".repeat(64);
    refuse("observation-changed");
  },
);
it("cannot reuse an unobserved intent after response capture wins the race", () => {
  f.input.identity = {
    ...identity(),
    observation: { kind: "unobserved", disposition: "stop-with-possible-in-flight-response" },
  };
  refuse("observation-changed");
});
it.each(["native", "policy", "other"])("rejects occupied %s stop nonce", (kind) => {
  const ledger = f.input.archive.archive.ledger;
  if (kind === "native") identity().stopRequestId = identity().dispatch.dispatchRequestId;
  if (kind === "policy")
    identity().stopRequestId = inspect(
      f.input.archive,
    ).reservationArchive.ledger.policy.records[0].clientRequestId;
  if (kind === "other") ledger.otherNonces = [identity().stopRequestId];
  refuse("nonce-conflict");
});
it("cannot generate another stop plan for a terminal run", () => {
  f.input.archive = applyGenerationStopPlan(f.input, plan());
  refuse("generation-prefix-changed");
});
it("does not stop an already validated generation", () => {
  f = structuredClone(bases.valid);
  const observation = identity().observation;
  if (observation.kind !== "response") throw Error("Response required");
  const result = prepareProviderGenerationValidation({
    ...f.input,
    identity: {
      dispatch: identity().dispatch,
      responseRequestId: observation.responseRequestId,
      responseEventDigest: observation.responseEventDigest,
      validationRequestId: randomUUID(),
    },
  });
  if (result.status !== "prepared") throw Error(result.reason);
  const ledger = f.input.archive.archive.ledger;
  ledger.events.push(result.plan.rows.event);
  ledger.receipts.push(result.plan.rows.receipt);
  ledger.artifacts.push(result.plan.rows.artifact);
  refuse("generation-prefix-changed");
});
it.each(["binding", "coverage", "raw"])(
  "audits %s corruption before planning a release",
  (kind) => {
    if (kind === "binding") f.input.archive.records = [];
    if (kind === "coverage") f.input.archive.coverage = null;
    if (kind === "raw")
      (f.input.archive.archive.ledger.artifacts[0] as { body: string }).body += " ";
    refuse("archive-invalid");
  },
);
it.each([-1, NaN, 0.5])("rejects invalid raw byte accounting %s", (additional) => {
  f.input.additionalUsedBytes = additional;
  refuse("invalid-input");
});
it("checks exact shared capacity before releasing reservation slots", () => {
  const before = plan().capacity.beforeExposureBytes;
  f.input.additionalUsedBytes = 256 * 1024 * 1024 - before;
  expect(plan().capacity.beforeExposureBytes).toBe(256 * 1024 * 1024);
  f.input.additionalUsedBytes++;
  refuse("capacity-exceeded");
});
it("does not backdate a stop before its evidence", () => {
  f.input.inspectedAt = "2026-09-27T03:35:00.000Z";
  refuse("invalid-input");
});
it.each(["known", "unknown", "excess"])(
  "preserves a late %s response after an unobserved stop without reopening",
  (kind) => {
    f = structuredClone(bases.unobserved);
    const p = plan(),
      archive = applyGenerationStopPlan(f.input, p),
      held = reservation(archive).phases[0];
    if (kind === "unknown") delete f.raw.response.usage;
    if (kind === "excess")
      f.raw.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    appendLateStopTestResponse(archive, f.raw);
    expect(state(archive).snapshots[0]).toMatchObject({
      revision: 5,
      state: "result-unobserved",
      terminal: true,
      responseCount: 1,
      canResume: false,
    });
    const phases = reservation(archive).phases;
    expect(phases[1]).toMatchObject({
      settled: true,
      heldUnits: "0",
      releasedUnits: p.budget.reviewReleasedUnits,
    });
    if (kind === "unknown") expect(phases[0]).toEqual(held);
    else expect(phases[0]).toMatchObject({ settled: true, heldUnits: "0" });
  },
);
