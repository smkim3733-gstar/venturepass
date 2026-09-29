import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  reviewResponseFixture,
  appendReviewStopFixture,
} from "./studio-plan-quality-provider-review-response-test-helpers";
import {
  prepareProviderReviewResponse as prepare,
  captureReviewResponseInput,
} from "./studio-plan-quality-provider-review-response";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerExecutionOperationDigest } from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerGenerationDispatchPlanLimits as limits } from "./studio-plan-quality-provider-dispatch-plan";
import { reviewDispatchFixture } from "./studio-plan-quality-provider-review-dispatch-test-helpers";
import type { ProviderExecutionBudgetSnapshot } from "./studio-plan-quality-provider-execution-types";

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
  throw Error("No DB in pure planner");
});
const base = reviewResponseFixture();
let f: typeof base;
beforeEach(() => {
  f = structuredClone(base);
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const refuse = (reason: string) =>
  expect(prepare(f.input)).toEqual({ status: "refused", reason, plan: null });
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
const phase = (budget: unknown, value: "generation" | "review") =>
  (budget as ProviderExecutionBudgetSnapshot).reservations[0].phases.find(
    (row) => row.phase === value,
  )!;
function append() {
  const p = plan(),
    ledger = f.input.archive.archive.ledger;
  ledger.artifacts.push(p.rows.artifact);
  ledger.events.push(p.rows.event);
  ledger.receipts.push(p.rows.receipt);
  if (p.rows.usageEvent) ledger.budgetEvents.push(p.rows.usageEvent);
  return p;
}
it("plans r8 capture and exact original-policy review settlement without changing input or granting capabilities", () => {
  const before = structuredClone(f),
    p = plan(),
    id = f.capture.dispatch.generation.dispatch.runId;
  expect(f).toEqual(before);
  expect(p).toMatchObject({
    late: false,
    responsePersisted: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
    resultingState: { revision: 8, state: "response-recorded", terminal: false },
    rows: {
      artifact: { key: "review-response" },
      event: { revision: 8, payload: { phase: "review" } },
      usageEvent: {
        eventId: f.capture.responseRequestId,
        payload: { phase: "review", kind: "recognize-usage" },
      },
    },
    usageAssessment: { status: "known", violations: [] },
  });
  expect(p.rows.receipt.inputDigest).toBe(providerExecutionOperationDigest(id, p.command));
  expect(p.rows.event.budgetRevision).toBe(p.rows.usageEvent!.revision);
  expect(p.budget.after.recognizedUnits).toBe(
    (BigInt(p.budget.before.recognizedUnits) + BigInt(p.usageAssessment.units!)).toString(),
  );
  expect(phase(p.budget.after, "generation")).toEqual(phase(p.budget.before, "generation"));
  expect(phase(p.budget.after, "review")).toMatchObject({
    heldUnits: "0",
    settled: true,
  });
  const { planDigest, ...body } = p;
  expect(planDigest).toBe(digest(body));
  expect(plan()).toEqual(p);
  for (const value of [
    p,
    p.identity.dispatch.generation.dispatch,
    p.command,
    p.rows.artifact,
    p.usageAssessment,
    p.budget.after.reservations,
    p.capacity,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  f.capture.response.status = "incomplete";
  expect(JSON.parse(p.rows.artifact.body).response.status).toBe("completed");
});
it("re-audits proposed rows and consumes reserved slots/bytes without adding reservation or dispatch", () => {
  const before = inspect(f.input.archive),
    p = append(),
    after = inspect(f.input.archive),
    nativeBefore = before.reservationArchive.ledger,
    nativeAfter = after.reservationArchive.ledger;
  expect(nativeAfter.provider.snapshots[0]).toMatchObject(p.resultingState);
  expect(nativeAfter.provider.snapshots[0]).toMatchObject({ dispatchIntentCount: 2 });
  expect(nativeAfter.reservedReceiptSlots).toBe(nativeBefore.reservedReceiptSlots - 1);
  expect(nativeAfter.reservedBudgetEventSlots).toBe(nativeBefore.reservedBudgetEventSlots - 1);
  expect(p.capacity.totalExposureBytes).toBe(
    nativeAfter.usedBytes +
      nativeAfter.reservedBytes +
      after.reservationArchive.usedBytes +
      after.usedBytes,
  );
  refuse("response-prefix-changed");
});
it.each(["missing-usage", "model", "tier", "inconsistent-tokens"])(
  "retains the entire review hold when usage is unknown: %s",
  (kind) => {
    if (kind === "missing-usage") delete f.capture.response.usage;
    if (kind === "model") f.capture.response.model = "unmapped-synthetic";
    if (kind === "tier") f.capture.response.service_tier = "unmapped-synthetic";
    if (kind === "inconsistent-tokens")
      f.capture.response.usage = { input_tokens: 2, output_tokens: 3, total_tokens: 99 };
    const p = plan();
    expect(p.usageAssessment.status).toBe("unknown");
    expect(p.rows.usageEvent).toBeNull();
    expect(p.rows.event.payload).toMatchObject({ usageBudgetEventDigest: null });
    expect(p.budget.after).toEqual(p.budget.before);
  },
);
it("preserves over-budget actual usage and violations instead of capping or discarding cost", () => {
  f.capture.response.usage = {
    input_tokens: 1000000,
    output_tokens: 1000000,
    total_tokens: 2000000,
    input_tokens_details: { cached_tokens: 0 },
  };
  const p = append();
  expect(p.usageAssessment.status).toBe("known");
  expect(p.usageAssessment.violations).toContain("RESERVATION_EXCEEDED");
  expect(p.usageAssessment.violations).toContain("OUTPUT_LIMIT_EXCEEDED");
  expect(BigInt(p.usageAssessment.units!)).toBeGreaterThan(BigInt(p.budget.before.heldUnits));
  expect(p.budget.after).toMatchObject({ boundBreached: true });
  expect(
    inspect(f.input.archive).reservationArchive.ledger.provider.budgets.find(
      (row) => row.scopeId === p.budget.after.scopeId,
    ),
  ).toEqual(p.budget.after);
});
it.each([false, true])(
  "preserves a late response after result-unobserved without reopening (unknown=%s)",
  (unknown) => {
    const stop = appendReviewStopFixture(f.input);
    if (unknown) delete f.capture.response.usage;
    f.input.inspectedAt = "2035-01-01T00:00:00.000Z";
    const p = append(),
      snapshot = inspect(f.input.archive).reservationArchive.ledger.provider.snapshots[0];
    expect(p).toMatchObject({
      late: true,
      resultingState: { revision: 9, state: "result-unobserved", terminal: true },
    });
    expect(snapshot.events[7]).toEqual(stop);
    expect(snapshot).toMatchObject(p.resultingState);
    expect(p.rows.event.previousEventDigest).toBe(stop.eventDigest);
    if (unknown) expect(p.budget.after).toEqual(p.budget.before);
    else expect(phase(p.budget.after, "review").settled).toBe(true);
  },
);
it("uses the frozen approval rules after their expiry and preserves incomplete/refusal metadata", () => {
  f.input.inspectedAt = "2035-01-01T00:00:00.000Z";
  f.capture.response.status = "incomplete";
  Object.assign(f.capture.response, { incomplete_details: { reason: "max_output_tokens" } });
  f.capture.response.output = [
    { type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] },
  ];
  const p = plan();
  expect(p.usageAssessment.status).toBe("known");
  expect(JSON.parse(p.rows.artifact.body).response).toEqual(
    captureReviewResponseInput(f.capture).response,
  );
  expect(p.rows.event.payload).toMatchObject({ metadata: { status: "incomplete" } });
});
it.each([
  "preparedRequestId",
  "dispatchRequestId",
  "validationEventDigest",
  "generation.responseRequestId",
  "generation.responseEventDigest",
  "generation.validationRequestId",
  "generation.dispatch.runId",
  "generation.dispatch.runDigest",
  "generation.dispatch.approvalBindingDigest",
  "generation.dispatch.preparedRequestId",
  "generation.dispatch.dispatchRequestId",
])("binds the full original identity: %s", (path) => {
  const parts = path.split(".");
  let row = f.capture.dispatch as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) row = row[key] as Record<string, unknown>;
  const key = parts.at(-1)!;
  row[key] = key.endsWith("Digest") ? "f".repeat(64) : randomUUID();
  refuse("bindings-changed");
});
it.each(["native", "policy", "other"])("rejects a globally reused response nonce: %s", (kind) => {
  const state = inspect(f.input.archive).reservationArchive.ledger;
  if (kind === "native") f.capture.responseRequestId = f.capture.dispatch.dispatchRequestId;
  if (kind === "policy") f.capture.responseRequestId = state.policy.records[0].clientRequestId;
  if (kind === "other") f.input.archive.archive.ledger.otherNonces = [f.capture.responseRequestId];
  refuse("nonce-conflict");
});
it("rejects r5 without review dispatch evidence", () => {
  const earlier = reviewDispatchFixture();
  f.input.archive = earlier.input.archive;
  f.capture.dispatch = earlier.input.identity as typeof f.capture.dispatch;
  refuse("review-dispatch-required");
});
it.each(["receipt", "artifact", "binding", "coverage"])(
  "rejects damaged full archive: %s",
  (kind) => {
    const ledger = f.input.archive.archive.ledger;
    if (kind === "receipt") ledger.receipts.pop();
    if (kind === "artifact") Object.assign(ledger.artifacts.at(-1)!, { body: "corrupt" });
    if (kind === "binding") f.input.archive.records = [];
    if (kind === "coverage") f.input.archive.coverage = null;
    refuse("archive-invalid");
  },
);
it("rejects backdated capture", () => {
  f.input.inspectedAt = "2026-09-27T03:37:59.000Z";
  refuse("capture-time-before-history");
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid shared bytes %s", (bytes) => {
  f.input.additionalUsedBytes = bytes;
  refuse("invalid-input");
});
it("enforces shared capacity including previously reserved storage", () => {
  const p = plan();
  f.input.additionalUsedBytes = limits.databaseBytes - p.capacity.previousExposureBytes + 1;
  refuse("capacity-exceeded");
  f.input.additionalUsedBytes -= 1;
  const result = prepare(f.input);
  if (result.status === "prepared")
    expect(result.plan.capacity.totalExposureBytes).toBeLessThanOrEqual(limits.databaseBytes);
  else expect(result.reason).toBe("capacity-exceeded");
});
it("rejects metadata/cost/transport injected outside SDK response", () => {
  f.input.capture = { ...f.capture, metadata: {}, cost: "0", send: forbidden };
  refuse("invalid-input");
});
it("copies only selected SDK fields and never invokes ignored accessors or toJSON", () => {
  Object.defineProperty(f.capture.response, "headers", { enumerable: true, get: forbidden });
  Object.defineProperty(f.capture.response, "toJSON", { value: forbidden });
  const captured = captureReviewResponseInput(f.capture);
  expect(captured.response).not.toHaveProperty("headers");
  expect(captured.response).not.toHaveProperty("toJSON");
  expect(plan().usageAssessment.status).toBe("known");
});
it.each(["accessor", "cycle", "bigint", "too-large"])(
  "refuses unsafe response capture: %s",
  (kind) => {
    if (kind === "accessor") Object.defineProperty(f.capture.response, "usage", { get: forbidden });
    if (kind === "cycle") f.capture.response.output = f.capture.response;
    if (kind === "bigint") Object.assign(f.capture.response, { usage: BigInt(1) });
    if (kind === "too-large") f.capture.response.output = "x".repeat(4 * 1024 * 1024);
    refuse("response-not-capturable");
  },
);
