import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { finalizationFixture } from "./studio-plan-quality-provider-finalization-test-helpers";
import {
  reviewValidationFixture,
  reviewValidationFindings,
  setReviewValidationOutput,
} from "./studio-plan-quality-provider-review-validation-test-helpers";
import { prepareProviderFinalization as prepare } from "./studio-plan-quality-provider-finalization";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import * as archiveInspector from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerDigest as digest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import * as native from "../../scripts/local-data-quality-provider-execution.mjs";
import type {
  ProviderExecutionArtifact,
  ProviderExecutionEvent,
  ProviderExecutionReceipt,
} from "./studio-plan-quality-provider-execution-types";
import * as engine from "./studio-engine";

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
  throw Error("No DB in pure finalization");
});
const base = finalizationFixture();
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
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
const refuse = (reason: string) =>
  expect(prepare(f.input)).toEqual({ status: "refused", reason, plan: null });
function apply() {
  const p = plan(),
    ledger = f.input.archive.archive.ledger;
  ledger.artifacts.push(p.rows.artifact);
  ledger.events.push(p.rows.event);
  ledger.receipts.push(p.rows.receipt);
  return p;
}
it("prepares only final artifact/completed r10/receipt, preserves all costs and inputs, and releases storage capacity only in the proposal", () => {
  const before = structuredClone(f),
    p = plan(),
    prior = inspect(f.input.archive).reservationArchive.ledger;
  expect(f).toEqual(before);
  expect(plan()).toEqual(p);
  expect(p).toMatchObject({
    kind: "provider-finalization-plan",
    status: "prepared-not-committed",
    completionPersisted: false,
    finalResultPersisted: false,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
    command: { expectedRevision: 9, clientRequestId: f.identity.finalizationRequestId },
    rows: {
      event: {
        revision: 10,
        previousEventDigest: f.identity.validationEventDigest,
        payload: {
          kind: "execution-stopped",
          outcome: "completed",
          failureCode: null,
          releasedBudgetEventDigests: [],
        },
      },
      receipt: { kind: "provider-finish", runRevision: 10 },
    },
  });
  expect(Object.keys(p.rows).sort()).toEqual(["artifact", "event", "receipt"]);
  expect(p.body).toEqual(JSON.parse(p.rows.artifact.body));
  expect(p.rows.artifact.sha256).toBe(providerRawDigest(p.rows.artifact.body));
  expect(p.rows.receipt.inputDigest).toBe(
    native.providerExecutionOperationDigest(
      f.identity.validation.dispatch.generation.dispatch.runId,
      p.command,
    ),
  );
  const { planDigest, ...unsigned } = p;
  expect(planDigest).toBe(digest(unsigned));
  expect(Object.isFrozen(p.body.content.sections[0].evidence)).toBe(true);
  expect(Object.isFrozen(p.identity.validation.dispatch.generation.dispatch)).toBe(true);
  if (p.rows.event.payload.kind !== "execution-stopped") throw Error("Expected completion");
  expect(Object.isFrozen(p.rows.event.payload.releasedBudgetEventDigests)).toBe(true);
  apply();
  const after = inspect(f.input.archive).reservationArchive.ledger;
  expect(after.provider.snapshots[0]).toMatchObject({
    revision: 10,
    state: "completed",
    terminal: true,
  });
  expect(after.provider.budgetEvents).toEqual(prior.provider.budgetEvents);
  expect(after.provider.budgets).toEqual(prior.provider.budgets);
  expect(after.provider.artifacts.filter((a) => a.key !== "final-result")).toEqual(
    prior.provider.artifacts,
  );
  expect(after.reservedBytes).toBeLessThan(prior.reservedBytes);
  expect(p.capacity.totalExposureBytes).toBeLessThan(p.capacity.previousExposureBytes);
  refuse("execution-stopped");
});
it.each(["warning", "info", "all", "empty"])(
  "preserves stored content/evidence and confirmation flags with %s findings",
  (kind) => {
    const finding = {
      ...reviewValidationFindings[0],
      severity: kind === "info" ? "info" : "warning",
      sectionKey: kind === "all" ? null : "problem",
    };
    f = finalizationFixture((response) =>
      setReviewValidationOutput(response, { findings: kind === "empty" ? [] : [finding] }),
    );
    const initial = JSON.parse(
      (f.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
        (a) => a.key === "generation-validated",
      )!.body,
    ).content;
    const p = plan();
    expect(p.body.content.title).toBe(initial.title);
    expect(p.body.content.summary).toBe(initial.summary);
    expect(p.body.content.sections).toEqual(
      initial.sections.map((s: Record<string, unknown>) => ({
        ...s,
        needsConfirmation:
          s.needsConfirmation ||
          (kind !== "info" && kind !== "empty" && (kind === "all" || s.key === "problem")),
      })),
    );
    expect(p.body.semanticReview).toEqual(kind === "empty" ? [] : [finding]);
    for (const value of p.body.semanticReview) expect(p.body.review).toContainEqual(value);
  },
);
it("requires stored review validation and does not run the review validator or reuse its preview", () => {
  const hook = vi.spyOn(engine, "validateObservedPlanReview").mockImplementation(() => {
    throw Error("No revalidation/preview");
  });
  expect(plan().body.semanticReview).toEqual(reviewValidationFindings);
  expect(hook).not.toHaveBeenCalled();
  const ledger = f.input.archive.archive.ledger;
  ledger.events = (ledger.events as ProviderExecutionEvent[]).filter((e) => e.revision !== 9);
  ledger.receipts = (ledger.receipts as ProviderExecutionReceipt[]).filter(
    (r) => r.clientRequestId !== f.identity.validation.validationRequestId,
  );
  ledger.artifacts = (ledger.artifacts as ProviderExecutionArtifact[]).filter(
    (a) => a.key !== "review-validated",
  );
  refuse("review-validation-required");
});
it("does not treat a settled terminal late r9 response as validated r9", () => {
  const late = reviewValidationFixture(undefined, true);
  f.input.archive = late.input.archive;
  f.identity.validation = late.identity;
  f.identity.validationEventDigest = late.response.eventDigest;
  refuse("execution-stopped");
});
it.each([
  "validationEventDigest",
  "validation.validationRequestId",
  "validation.responseRequestId",
  "validation.responseEventDigest",
  "validation.dispatch.preparedRequestId",
  "validation.dispatch.dispatchRequestId",
  "validation.dispatch.validationEventDigest",
  "validation.dispatch.generation.responseRequestId",
  "validation.dispatch.generation.responseEventDigest",
  "validation.dispatch.generation.validationRequestId",
  "validation.dispatch.generation.dispatch.runId",
  "validation.dispatch.generation.dispatch.runDigest",
  "validation.dispatch.generation.dispatch.approvalBindingDigest",
  "validation.dispatch.generation.dispatch.preparedRequestId",
  "validation.dispatch.generation.dispatch.dispatchRequestId",
])("binds original identity %s", (path) => {
  const parts = path.split(".");
  let row = f.identity as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) row = row[key] as Record<string, unknown>;
  const key = parts.at(-1)!;
  row[key] = key.endsWith("Digest") ? "f".repeat(64) : randomUUID();
  refuse("bindings-changed");
});
it.each(["body", "finalization", "configuration", "transport", "dispatchAllowed"])(
  "rejects caller %s injection",
  (key) => {
    Object.assign(f.identity, { [key]: {} });
    refuse("invalid-input");
  },
);
it("rejects nested extra identity fields and invalid nonces", () => {
  Object.assign(f.identity.validation.dispatch.generation, { body: {} });
  refuse("invalid-input");
  f = structuredClone(base);
  f.identity.finalizationRequestId = "invalid";
  refuse("invalid-input");
});
it.each(["validation", "response", "policy", "other"])(
  "rejects occupied completion nonce %s",
  (kind) => {
    if (kind === "validation")
      f.identity.finalizationRequestId = f.identity.validation.validationRequestId;
    if (kind === "response")
      f.identity.finalizationRequestId = f.identity.validation.responseRequestId;
    if (kind === "policy")
      f.identity.finalizationRequestId = inspect(
        f.input.archive,
      ).reservationArchive.ledger.policy.records[0].clientRequestId;
    if (kind === "other")
      f.input.archive.archive.ledger.otherNonces = [f.identity.finalizationRequestId];
    refuse("nonce-conflict");
  },
);
it.each([
  "review-response",
  "generation-validated",
  "review-validated",
  "receipt",
  "binding",
  "coverage",
])("rejects %s corruption before finalization", (kind) => {
  if (["review-response", "generation-validated", "review-validated"].includes(kind))
    (f.input.archive.archive.ledger.artifacts as ProviderExecutionArtifact[]).find(
      (a) => a.key === kind,
    )!.body += " ";
  if (kind === "receipt")
    (f.input.archive.archive.ledger.receipts.at(-1) as ProviderExecutionReceipt).inputDigest =
      "f".repeat(64);
  if (kind === "binding") f.input.archive.records.length = 0;
  if (kind === "coverage") f.input.archive.coverage = null;
  const hook = vi.spyOn(engine, "finalizeObservedPlanReview");
  refuse("archive-invalid");
  expect(hook).not.toHaveBeenCalled();
});
it("permits offline preparation after expiry with the original compatible domain contract", () => {
  f.input.inspectedAt = "2035-01-01T00:00:00.000Z";
  expect(plan().completionPersisted).toBe(false);
});
it("distinguishes changed and unavailable domain contracts", () => {
  const hook = vi
    .spyOn(engine, "getPlanExecutionContract")
    .mockReturnValue({ ...engine.getPlanExecutionContract(), contractDigest: "0".repeat(64) });
  refuse("validation-contract-changed");
  hook.mockImplementation(() => {
    throw Error("Unavailable");
  });
  refuse("validation-unavailable");
});
it.each(["exception", "title", "summary", "content", "evidence", "semantic", "review", "order"])(
  "rejects broken finalizer %s without blaming provider output",
  (kind) => {
    const original = engine.finalizeObservedPlanReview;
    vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
      if (kind === "exception") throw Error("Internal failure");
      const value = original(...args);
      if (kind === "title") value.content.title += " changed";
      if (kind === "summary") value.content.summary += " changed";
      if (kind === "content") value.content.sections[0].content += " changed";
      if (kind === "evidence") value.content.sections[0].evidence = [];
      if (kind === "semantic") value.semanticReview = [];
      if (kind === "review") value.review = [];
      if (kind === "order") value.content.sections.reverse();
      return value;
    });
    refuse("finalization-unavailable");
  },
);
it.each([0, 1])("checks actual UTF-8 final bytes at 4 MiB plus %s", (extra) => {
  const original = engine.finalizeObservedPlanReview;
  vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
    const value = original(...args),
      finding = { ...reviewValidationFindings[0], id: "" };
    value.review.push(finding);
    const bytes = Buffer.byteLength(JSON.stringify({ ...value, contractDigest: "0".repeat(64) }));
    finding.id = "x".repeat(native.providerExecutionLimits.finalBytes - bytes + extra);
    return value;
  });
  if (extra) refuse("final-result-too-large");
  else expect(plan().rows.artifact.sizeBytes).toBe(native.providerExecutionLimits.finalBytes);
});
it("checks capacity before completion could release reserved storage", () => {
  const p = plan();
  f.input.additionalUsedBytes = 256 * 1024 * 1024 - p.capacity.previousExposureBytes;
  expect(plan().capacity.previousExposureBytes).toBe(256 * 1024 * 1024);
  f.input.additionalUsedBytes++;
  refuse("capacity-exceeded");
});
it.each(["event", "receipt"])(
  "reaudits every proposed %s against the native completed archive",
  (kind) => {
    if (kind === "event") {
      const original = native.createProviderExecutionEvent;
      vi.spyOn(native, "createProviderExecutionEvent").mockImplementation((value) =>
        original({ ...value, previousEventDigest: "f".repeat(64) }),
      );
    } else {
      const original = native.createProviderExecutionReceipt;
      vi.spyOn(native, "createProviderExecutionReceipt").mockImplementation((value) =>
        original({ ...value, inputDigest: "f".repeat(64) }),
      );
    }
    refuse("planned-archive-invalid");
  },
);
it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid external raw byte count %s",
  (value) => {
    f.input.additionalUsedBytes = value;
    refuse("invalid-input");
  },
);
it.each(["invalid", "2026-09-27T03:39:59.999Z"])(
  "rejects invalid or backdated completion %s",
  (value) => {
    f.input.inspectedAt = value;
    refuse("invalid-input");
  },
);
it.each(["bound", "deficit", "generation-unsettled", "review-held"])(
  "rejects a current budget guard fault after a valid full audit: %s",
  (kind) => {
    // Keep historical native budget prefixes real. Inject only at the planner's current
    // budget boundary; altering all historical prefixes would correctly fail archive audit first.
    const audited = inspect(f.input.archive);
    vi.spyOn(archiveInspector, "inspectProviderTransmissionApprovalArchive").mockReturnValueOnce(
      audited,
    );
    const original = native.getProviderExecutionBudgetSnapshot;
    vi.spyOn(native, "getProviderExecutionBudgetSnapshot").mockImplementation((...args) => {
      const value = structuredClone(original(...args));
      if (kind === "bound") value.boundBreached = true;
      if (kind === "deficit") value.deficitUnits = "1";
      if (kind === "generation-unsettled")
        value.reservations[0].phases.find((p) => p.phase === "generation")!.settled = false;
      if (kind === "review-held")
        value.reservations[0].phases.find((p) => p.phase === "review")!.heldUnits = "1";
      return value;
    });
    refuse(["bound", "deficit"].includes(kind) ? "budget-bound-breached" : "budget-unsettled");
  },
);
