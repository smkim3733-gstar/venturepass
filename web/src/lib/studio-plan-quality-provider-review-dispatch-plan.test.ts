import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { reviewDispatchFixture } from "./studio-plan-quality-provider-review-dispatch-test-helpers";
import {
  prepareProviderReviewDispatch as prepare,
  type ProviderReviewDispatchIdentity,
} from "./studio-plan-quality-provider-review-dispatch-plan";
import { inspectProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { providerExecutionOperationDigest } from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerGenerationDispatchPlanLimits as limits } from "./studio-plan-quality-provider-dispatch-plan";
import { config, adopt } from "./studio-plan-quality-provider-reservation-test-helpers";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
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
  throw Error("No DB in pure planner");
});
const base = reviewDispatchFixture();
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
const identity = () => f.input.identity as ProviderReviewDispatchIdentity;
const refuse = (reason: string) =>
  expect(prepare(f.input)).toEqual({ status: "refused", reason, plan: null });
function plan() {
  const result = prepare(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
function append(count = 2) {
  const p = plan(),
    ledger = f.input.archive.archive.ledger;
  ledger.artifacts.push(p.rows.artifact);
  ledger.events.push(...p.rows.events.slice(0, count));
  ledger.receipts.push(...p.rows.receipts.slice(0, count));
  return p;
}
it("derives exact review bytes from audited r5 and the original template without mutating any evidence", () => {
  const before = structuredClone(f),
    p = plan();
  expect(f).toEqual(before);
  expect(p).toMatchObject({
    status: "prepared-not-committed",
    ownership: "new-commit-owner-required",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
    request: { request: { phase: "review", sequence: 2, maxOutputTokens: 16000 } },
  });
  expect(p.request.body).toEqual(f.validation.review.body);
  expect(p.request.rawBody).toBe(f.validation.review.rawBody);
  expect(p.request.request.requestDigest).toBe(providerWireDigest(p.request.body));
  expect(p.request.request.artifactSha256).toBe(providerRawDigest(p.request.rawBody));
  expect(p.request.request.inputChars).toBe(
    p.request.body.input.reduce((n, r) => n + r.content.length, 0),
  );
  expect(p.commands.prepared.payload.derivedFrom).toEqual(f.validation.review.derivedFrom);
  expect(p.rows.artifact.body).toBe(p.request.rawBody);
  expect(p.rows.receipts[0].inputDigest).toBe(
    providerExecutionOperationDigest(identity().generation.dispatch.runId, p.commands.prepared),
  );
  expect(p.rows.receipts[1].inputDigest).toBe(
    providerExecutionOperationDigest(identity().generation.dispatch.runId, p.commands.dispatch),
  );
  const { planDigest, ...body } = p;
  expect(planDigest).toBe(digest(body));
  expect(plan()).toEqual(p);
  for (const value of [
    p,
    p.identity.generation.dispatch,
    p.request.body.input,
    p.commands.prepared,
    p.rows.artifact,
    p.rows.events,
    p.basis.derivedFrom,
  ])
    expect(Object.isFrozen(value)).toBe(true);
});
it("audits the resulting r6/r7 archive and consumes existing receipt/artifact reservations without changing budget", () => {
  const before = inspect(f.input.archive),
    p = append(),
    after = inspect(f.input.archive);
  expect(after.reservationArchive.ledger.provider.snapshots[0]).toMatchObject({
    revision: 7,
    state: "dispatching",
    terminal: false,
  });
  expect(p.rows.events.map((r) => r.revision)).toEqual([6, 7]);
  expect(p.rows.events[1].previousEventDigest).toBe(p.rows.events[0].eventDigest);
  expect(after.reservationArchive.ledger.provider.budgetEvents).toEqual(
    before.reservationArchive.ledger.provider.budgetEvents,
  );
  expect(after.reservationArchive.ledger.provider.budgets).toEqual(
    before.reservationArchive.ledger.provider.budgets,
  );
  expect(after.reservationArchive.ledger.reservedReceiptSlots).toBe(
    before.reservationArchive.ledger.reservedReceiptSlots - 2,
  );
  expect(after.reservationArchive.ledger.reservedBudgetEventSlots).toBe(
    before.reservationArchive.ledger.reservedBudgetEventSlots,
  );
});
it("uses stored validation instead of running today's generation domain validator again", () => {
  const spy = vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation(forbidden);
  expect(plan().basis.revision).toBe(5);
  expect(spy).not.toHaveBeenCalled();
});
it.each([1, 2])("refuses to replay a plan after %i review rows already exist", (count) => {
  append(count);
  refuse("generation-validation-required");
});
it("requires stored r5 validation, not a previously returned derivation", () => {
  const ledger = f.input.archive.archive.ledger;
  ledger.events.pop();
  ledger.receipts.pop();
  ledger.artifacts.pop();
  refuse("generation-validation-required");
});
it.each([
  "runId",
  "runDigest",
  "approvalBindingDigest",
  "preparedRequestId",
  "dispatchRequestId",
] as const)("binds generation dispatch %s", (key) => {
  identity().generation.dispatch[key] = key.endsWith("Digest") ? "0".repeat(64) : randomUUID();
  refuse("bindings-changed");
});
it.each(["responseRequestId", "responseEventDigest", "validationRequestId"] as const)(
  "binds generation %s",
  (key) => {
    identity().generation[key] = key.endsWith("Digest") ? "0".repeat(64) : randomUUID();
    refuse("bindings-changed");
  },
);
it("binds the saved validation event digest", () => {
  identity().validationEventDigest = "0".repeat(64);
  refuse("bindings-changed");
});
it.each(["body", "model", "configuration", "dispatchAllowed", "budgetWriteAllowed"])(
  "rejects caller supplied %s",
  (field) => {
    f.input.identity = { ...identity(), [field]: "override" };
    refuse("invalid-input");
  },
);
it("rejects unknown nested fields", () => {
  f.input.identity = {
    ...identity(),
    generation: { ...identity().generation, output: "override" },
  };
  refuse("invalid-input");
});
it.each(["preparedRequestId", "dispatchRequestId"] as const)(
  "rejects used %s in all global receipt domains",
  (key) => {
    const state = inspect(f.input.archive).reservationArchive.ledger;
    for (const nonce of [
      ...state.provider.receipts,
      ...state.legacy.receipts,
      ...state.policy.records,
    ]
      .map((r) => r.clientRequestId)
      .concat(f.input.archive.archive.ledger.otherNonces ?? [])) {
      identity()[key] = nonce;
      refuse("nonce-conflict");
    }
  },
);
it("requires distinct new review nonces", () => {
  identity().dispatchRequestId = identity().preparedRequestId;
  refuse("nonce-conflict");
});
it.each(["before-validation", "expiry", "after-expiry"])(
  "preserves the original deadline at %s",
  (kind) => {
    f.input.inspectedAt = new Date(
      kind === "before-validation"
        ? Date.parse(f.validation.inspectedAt) - 1
        : Date.parse(inspect(f.input.archive).records[0].approvedReview.expiresAt) +
            (kind === "after-expiry" ? 1 : 0),
    ).toISOString();
    refuse("approval-expired-or-future");
  },
);
it("accepts the exact r5 instant and last valid millisecond without extending approval", () => {
  const expiry = inspect(f.input.archive).records[0].approvedReview.expiresAt;
  for (const at of [f.validation.inspectedAt, new Date(Date.parse(expiry) - 1).toISOString()]) {
    f.input.inspectedAt = at;
    expect(plan().expiresAt).toBe(expiry);
  }
});
it.each(["missing", "tampered", "replaced"])("rechecks %s server configuration", (kind) => {
  const c = config();
  c.proposedBudget.capUnits = "30000000";
  if (kind === "replaced") c.configurationDigest = digest(providerConfigurationDigestInput(c));
  f.input.configuration = kind === "missing" ? null : c;
  refuse("current-evidence-unavailable");
});
it.each([0, 1])(
  "rechecks selected policy reference and global head after candidate %i adoption",
  (index) => {
    const before = plan();
    adopt(f.input.archive.archive.ledger, index, config(), f.input.inspectedAt);
    if (index === 0) refuse("policy-or-budget-blocked");
    else {
      const p = plan();
      expect(p.basis.policyHead.revision).toBe(before.basis.policyHead.revision + 1);
      expect(p.request).toEqual(before.request);
      expect(p.planDigest).not.toBe(before.planDigest);
    }
  },
);
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid audited byte count %s",
  (value) => {
    f.input.additionalUsedBytes = value;
    refuse("invalid-input");
  },
);
it("respects the exact shared capacity before and after consuming reserved slots", () => {
  const before = inspect(f.input.archive),
    p = plan();
  const baseline =
    before.reservationArchive.ledger.usedBytes +
    before.reservationArchive.ledger.reservedBytes +
    before.reservationArchive.usedBytes +
    before.usedBytes;
  f.input.additionalUsedBytes =
    limits.databaseBytes - Math.max(baseline, p.capacity.totalExposureBytes);
  expect(plan().capacity.totalExposureBytes).toBeLessThanOrEqual(limits.databaseBytes);
  f.input.additionalUsedBytes += 1;
  refuse("capacity-exceeded");
});
it.each(["coverage", "approval", "validated-artifact", "response-artifact"])(
  "audits %s before constructing a request",
  (kind) => {
    const ledger = f.input.archive.archive.ledger;
    if (kind === "coverage")
      (f.input.archive.coverage as { coverageDigest: string }).coverageDigest = "0".repeat(64);
    else if (kind === "approval") f.input.archive.records = [];
    else {
      const artifact = ledger.artifacts.find(
        (r) =>
          (r as { key: string }).key ===
          (kind === "validated-artifact" ? "generation-validated" : "generation-response"),
      ) as { body: string };
      artifact.body = "{}";
    }
    refuse("archive-invalid");
  },
);
