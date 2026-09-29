import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  prepareProviderReviewStop as prepare,
  type ProviderReviewStopIdentity,
} from "./studio-plan-quality-provider-review-stop";
import {
  reviewStopFixture,
  applyReviewStopPlan,
  appendReviewStopTestResponse,
} from "./studio-plan-quality-provider-review-stop-test-helpers";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { prepareProviderReviewValidation } from "./studio-plan-quality-provider-review-validation";
import {
  setReviewValidationOutput,
  reviewValidationFindings,
} from "./studio-plan-quality-provider-review-validation-test-helpers";
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
  unobserved: reviewStopFixture("unobserved"),
  unknown: reviewStopFixture("unknown"),
  bound: reviewStopFixture("bound"),
  invalid: reviewStopFixture("invalid"),
  valid: reviewStopFixture("valid"),
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
const identity = () => f.input.identity as ProviderReviewStopIdentity;
const runId = () => identity().dispatch.generation.dispatch.runId;
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
function refuse(reason: string) {
  expect(prepare(f.input)).toEqual({ status: "refused", reason, plan: null });
}
function state(archive = f.input.archive) {
  return inspect(archive).reservationArchive.ledger.provider;
}
function budget(archive = f.input.archive) {
  const s = state(archive),
    run = s.snapshots.find((row) => row.run.id === runId())!;
  return native.getProviderExecutionBudgetSnapshot(
    s.budgetEvents.filter((row) => row.scopeId === run.run.preparation.budget.scopeId),
    run.run.preparation.budget.scopeId,
  );
}
it.each([
  ["unobserved", "result-unobserved", "INTERRUPTED"],
  ["unknown", "needs-cost-review", "COST_UNSETTLED"],
  ["bound", "bound-breached", "BOUND_BREACHED"],
  ["invalid", "output-invalid", "OUTPUT_INVALID"],
] as const)(
  "derives %s stop without releasing or recognizing either phase",
  (kind, outcome, failureCode) => {
    f = structuredClone(bases[kind]);
    const before = structuredClone(f),
      own = budget(),
      p = plan(),
      after = applyReviewStopPlan(f.input, p);
    expect(f).toEqual(before);
    expect(plan()).toEqual(p);
    expect(budget(after)).toEqual(own);
    expect(Object.keys(p.rows).sort()).toEqual(["event", "receipt"]);
    expect(p).toMatchObject({
      status: "prepared-not-committed",
      transaction: "single-immediate-transaction-required",
      stopPersisted: false,
      finalResultPersisted: false,
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      command: {
        expectedRevision: kind === "unobserved" ? 7 : 8,
        payload: { kind: "execution-stopped", outcome, failureCode, finalArtifactSha256: null },
      },
      rows: { event: { payload: { releasedBudgetEventDigests: [] } } },
    });
    expect(state(after).snapshots[0]).toMatchObject({
      state: outcome,
      terminal: true,
      canResume: false,
      dispatchIntentCount: 2,
      responseCount: kind === "unobserved" ? 1 : 2,
      dispatchAllowed: false,
    });
    expect(after.archive.ledger.artifacts).toEqual(f.input.archive.archive.ledger.artifacts);
    expect(after.archive.ledger.budgetEvents).toEqual(f.input.archive.archive.ledger.budgetEvents);
    expect(after.records).toEqual(f.input.archive.records);
    expect(Object.isFrozen(p.rows.event.payload)).toBe(true);
    expect(Object.isFrozen(p.identity.dispatch.generation)).toBe(true);
    expect(p.rows.receipt.inputDigest).toBe(
      native.providerExecutionOperationDigest(runId(), p.command),
    );
    const { planDigest, ...body } = p;
    expect(planDigest).toBe(digest(body));
  },
);
it("does not stop valid review or persist its preview as a side effect", () => {
  f = structuredClone(bases.valid);
  const before = structuredClone(f);
  refuse("review-valid");
  expect(f).toEqual(before);
});
it.each(["unobserved", "unknown", "bound", "invalid"] as const)(
  "classifies %s offline after expiry",
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
  "uses stored financial evidence for %s without a current domain validator",
  (kind) => {
    f = structuredClone(bases[kind]);
    const spy = vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(forbidden);
    expect(prepare(f.input).status).toBe("prepared");
    expect(spy).not.toHaveBeenCalled();
  },
);
it("distinguishes a changed validation contract from invalid review", () => {
  vi.spyOn(engine, "getPlanExecutionContract").mockReturnValue({
    ...engine.getPlanExecutionContract(),
    contractDigest: "0".repeat(64),
  });
  refuse("validation-contract-changed");
});
it.each(["contract", "validator", "native-validator", "finalizer", "native-finalizer"])(
  "does not misclassify internal %s failure",
  (kind) => {
    f = structuredClone(bases.valid);
    const fail = () => {
      throw Error("synthetic internal failure");
    };
    if (kind === "contract") vi.spyOn(engine, "getPlanExecutionContract").mockImplementation(fail);
    if (kind === "validator")
      vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(fail);
    if (kind === "native-validator")
      vi.spyOn(native, "validateProviderExecutionOutput").mockImplementation(fail);
    if (kind === "finalizer")
      vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation(fail);
    if (kind === "native-finalizer")
      vi.spyOn(native, "validateProviderExecutionFinalResult").mockImplementation(fail);
    const before = structuredClone(f);
    refuse(kind.includes("finalizer") ? "finalization-unavailable" : "validation-unavailable");
    expect(f).toEqual(before);
  },
);
it("does not convert oversized final composition into invalid review", () => {
  f = reviewStopFixture("valid", (response) =>
    setReviewValidationOutput(response, {
      findings: [{ ...reviewValidationFindings[0], id: "x".repeat(2094000) }],
    }),
  );
  refuse("final-result-too-large");
});
it("uses the audited native bound flag for token policy violations even without cost excess", () => {
  f = reviewStopFixture("valid", (response) => {
    response.usage = {
      input_tokens: 20,
      output_tokens: 16001,
      total_tokens: 16021,
      input_tokens_details: { cached_tokens: 5 },
    };
  });
  const current = budget(),
    review = current.reservations.find((row) => row.runId === runId())!.phases[1];
  expect(BigInt(review.recognizedUnits)).toBeLessThan(BigInt(review.reservedUnits));
  // Native accounting marks known usage-policy violations as a bound breach too.
  expect(current.boundBreached).toBe(true);
  expect(plan().command.payload).toMatchObject({
    outcome: "bound-breached",
    failureCode: "BOUND_BREACHED",
  });
});
it("requires explicit intent acknowledging that a response may still arrive", () => {
  f = structuredClone(bases.unobserved);
  f.input.identity = { ...identity(), observation: { kind: "unobserved" } };
  refuse("invalid-input");
});
it.each(["outcome", "failureCode", "releasedUnits", "configuration", "dispatchAllowed"])(
  "rejects supplied %s",
  (field) => {
    f.input.identity = { ...identity(), [field]: "override" };
    refuse("invalid-input");
  },
);
it.each([
  ["generation", "dispatch", "runId"],
  ["generation", "dispatch", "runDigest"],
  ["generation", "dispatch", "approvalBindingDigest"],
  ["generation", "dispatch", "preparedRequestId"],
  ["generation", "dispatch", "dispatchRequestId"],
  ["generation", "responseRequestId"],
  ["generation", "responseEventDigest"],
  ["generation", "validationRequestId"],
  ["validationEventDigest"],
  ["preparedRequestId"],
  ["dispatchRequestId"],
])("binds original dispatch path %j", (...path) => {
  let object = identity().dispatch as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1)) object = object[key] as Record<string, unknown>;
  const key = path.at(-1)!;
  object[key] = key.endsWith("Digest") ? "0".repeat(64) : randomUUID();
  refuse("bindings-changed");
});
it.each(["responseRequestId", "responseEventDigest"] as const)("binds observed %s", (field) => {
  const observation = identity().observation;
  if (observation.kind !== "response") throw Error("Response required");
  observation[field] = field === "responseRequestId" ? randomUUID() : "0".repeat(64);
  refuse("observation-changed");
});
it("rejects an unobserved intent after capture won", () => {
  identity().observation = {
    kind: "unobserved",
    disposition: "stop-with-possible-in-flight-response",
  };
  refuse("observation-changed");
});
it.each(["native", "policy", "other"])("rejects occupied %s nonce", (kind) => {
  if (kind === "native") identity().stopRequestId = identity().dispatch.dispatchRequestId;
  if (kind === "policy")
    identity().stopRequestId = inspect(
      f.input.archive,
    ).reservationArchive.ledger.policy.records[0].clientRequestId;
  if (kind === "other") f.input.archive.archive.ledger.otherNonces = [identity().stopRequestId];
  refuse("nonce-conflict");
});
it("cannot stop an already terminal run", () => {
  f.input.archive = applyReviewStopPlan(f.input, plan());
  refuse("review-prefix-changed");
});
it("does not stop an already validated review", () => {
  f = structuredClone(bases.valid);
  const observation = identity().observation;
  if (observation.kind !== "response") throw Error("Response required");
  const result = prepareProviderReviewValidation({
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
  refuse("review-prefix-changed");
});
it.each(["binding", "coverage", "raw"])("audits corrupted %s before stop preparation", (kind) => {
  if (kind === "binding") f.input.archive.records = [];
  if (kind === "coverage") f.input.archive.coverage = null;
  if (kind === "raw") (f.input.archive.archive.ledger.artifacts[0] as { body: string }).body += " ";
  refuse("archive-invalid");
});
it.each([-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid raw accounting %s",
  (value) => {
    f.input.additionalUsedBytes = value;
    refuse("invalid-input");
  },
);
it("enforces exact shared capacity before consuming reserved slots", () => {
  const before = plan().capacity.beforeExposureBytes;
  f.input.additionalUsedBytes = 256 * 1024 * 1024 - before;
  expect(plan().capacity.beforeExposureBytes).toBe(256 * 1024 * 1024);
  f.input.additionalUsedBytes++;
  refuse("capacity-exceeded");
});
it("preserves capacity errors from valid-review planning", () => {
  f = structuredClone(bases.valid);
  f.input.additionalUsedBytes = 256 * 1024 * 1024;
  refuse("capacity-exceeded");
});
it.each(["bad-time", "2026-09-27T03:35:00.000Z"])("refuses invalid evidence time %s", (time) => {
  f.input.inspectedAt = time;
  refuse("invalid-input");
});
it.each(["known", "unknown", "excess"])(
  "preserves late %s review capture without reopening",
  (kind) => {
    f = structuredClone(bases.unobserved);
    const p = plan(),
      archive = applyReviewStopPlan(f.input, p),
      before = budget(archive),
      own = before.reservations.find((row) => row.runId === runId())!;
    if (kind === "unknown") delete f.capture.response.usage;
    if (kind === "excess")
      f.capture.response.usage = {
        input_tokens: 20,
        output_tokens: 600000,
        total_tokens: 600020,
        input_tokens_details: { cached_tokens: 5 },
      };
    appendReviewStopTestResponse({
      archive,
      capture: f.capture,
      inspectedAt: "2026-09-27T03:41:00.000Z",
      additionalUsedBytes: 0,
    });
    expect(state(archive).snapshots[0]).toMatchObject({
      revision: 9,
      state: "result-unobserved",
      terminal: true,
      responseCount: 2,
      canResume: false,
    });
    expect(archive.archive.ledger.events[7]).toEqual(p.rows.event);
    const next = budget(archive),
      phases = next.reservations.find((row) => row.runId === runId())!.phases;
    expect(phases[0]).toEqual(own.phases[0]);
    if (kind === "unknown") expect(next).toEqual(before);
    else {
      expect(phases[1]).toMatchObject({ settled: true, heldUnits: "0" });
      expect(BigInt(next.recognizedUnits)).toBeGreaterThan(BigInt(before.recognizedUnits));
    }
    if (kind === "excess") expect(next.boundBreached).toBe(true);
    f.input.archive = archive;
    refuse("review-prefix-changed");
  },
);
