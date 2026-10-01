/** Synthetic plans only. No DB writer, SDK calls or transmission authority. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("No external IO");
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
  throw Error("No database in planning");
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
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import { generationValidationFixture } from "./studio-plan-quality-provider-generation-validation-test-helpers";
import { reviewDispatchFixture } from "./studio-plan-quality-provider-review-dispatch-test-helpers";
import {
  prepareVersionedProviderGenerationValidation as validate,
  prepareProviderGenerationValidation as frozenValidation,
  type ProviderGenerationValidationInput as Input,
  type ProviderGenerationValidationIdentity as Identity,
} from "./studio-plan-quality-provider-generation-validation";
import {
  prepareVersionedProviderReviewDispatch as review,
  prepareProviderReviewDispatch as frozenReview,
  type ProviderReviewDispatchInput as ReviewInput,
  type ProviderReviewDispatchIdentity as ReviewIdentity,
} from "./studio-plan-quality-provider-review-dispatch-plan";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { inspectVersionedProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  versionedProviderExecutionOperationDigest,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  providerDigest as digest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import * as engine from "./studio-engine";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
const fixed = readFixedProviderConfiguration()!;
function responseInput(change?: Parameters<typeof receive>[2]): Input {
  const f = fixture(executionBase());
  prepare(f, "generation");
  dispatch(f, "generation");
  receive(f, "generation", change);
  const nonce = (revision: number) =>
    f.data.receipts.find((r) => r.runRevision === revision)!.clientRequestId;
  const archive = f.upper();
  return {
    archive,
    inspectedAt: "2026-09-27T03:35:00.000Z",
    additionalUsedBytes: 0,
    identity: {
      dispatch: {
        runId: f.data.run.id,
        runDigest: f.data.run.runDigest,
        approvalBindingDigest: archive.records[0].recordDigest,
        preparedRequestId: nonce(2),
        dispatchRequestId: nonce(3),
      },
      responseRequestId: nonce(4),
      responseEventDigest: f.data.events[3].eventDigest,
      validationRequestId: randomUUID(),
    },
  };
}
const base = responseInput(),
  legacy = generationValidationFixture(),
  legacyReview = reviewDispatchFixture();
let input: Input;
beforeEach(() => {
  input = structuredClone(base);
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function validation(value = input) {
  const r = validate(v2, value);
  if (r.status !== "prepared") throw Error(r.reason);
  return r.plan;
}
function derived(value = input): ReviewInput {
  const p = validation(value),
    archive = structuredClone(value.archive),
    ledger = archive.archive.ledger;
  ledger.events.push(p.rows.event);
  ledger.artifacts.push(p.rows.artifact);
  ledger.receipts.push(p.rows.receipt);
  return {
    archive,
    configuration: fixed,
    inspectedAt: "2026-09-27T03:36:00.000Z",
    additionalUsedBytes: 0,
    identity: {
      generation: value.identity,
      validationEventDigest: p.rows.event.eventDigest,
      preparedRequestId: randomUUID(),
      dispatchRequestId: randomUUID(),
    },
  };
}
function reviewPlan(value = derived()) {
  const r = review(v2, value);
  if (r.status !== "prepared") throw Error(r.reason);
  return r.plan;
}
const reason = (r: { status: string; reason?: string }, value: string) =>
  expect(r).toMatchObject({ status: "refused", reason: value });
it("binds the original response, r5 validated artifact and same-version r6/r7 request without sending", () => {
  const before = JSON.stringify(input),
    validated = validation(),
    r = derived(),
    plan = reviewPlan(r);
  expect(validated.planVersion).toBe(2);
  expect(validated.rows.event.executionContractVersion).toBe(2);
  expect(validated.rows.receipt.inputDigest).toBe(
    versionedProviderExecutionOperationDigest(
      (input.identity as Identity).dispatch.runId,
      validated.command,
    ),
  );
  expect(validated.rows.receipt.inputDigest).not.toBe(
    providerExecutionOperationDigest(
      (input.identity as Identity).dispatch.runId,
      validated.command,
    ),
  );
  expect(plan.planVersion).toBe(2);
  expect(plan.rows.events.map((e) => [e.revision, e.executionContractVersion])).toEqual([
    [6, 2],
    [7, 2],
  ]);
  expect(plan.request.rawBody).toBe(validated.review.rawBody);
  expect(plan.basis.derivedFrom).toEqual(validated.review.derivedFrom);
  const ledger = r.archive.archive.ledger;
  ledger.events.push(...plan.rows.events);
  ledger.artifacts.push(plan.rows.artifact);
  ledger.receipts.push(...plan.rows.receipts);
  const snapshot = inspect(r.archive).reservationArchive.ledger.provider.snapshots[0];
  expect(snapshot).toMatchObject({
    archiveFormatVersion: 5,
    revision: 7,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(plan).toMatchObject({
    status: "prepared-not-committed",
    transaction: "single-immediate-transaction-required",
    ownership: "new-commit-owner-required",
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
  });
  expect(validated).toMatchObject({
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    automaticRetryAllowed: false,
  });
  expect(JSON.stringify(input)).toBe(before);
  expect(Object.isFrozen(plan.request.body)).toBe(true);
});
it("preserves complete v1 plan JSON through explicit selection", () => {
  expect(JSON.stringify(validate(v1, legacy.input))).toBe(
    JSON.stringify(frozenValidation(legacy.input)),
  );
  expect(JSON.stringify(review(v1, legacyReview.input))).toBe(
    JSON.stringify(frozenReview(legacyReview.input)),
  );
  expect(frozenValidation(input).status).toBe("refused");
  expect(frozenReview(derived()).status).toBe("refused");
});
it("rejects both directions of stored/server version mismatch", () => {
  reason(validate(v1, input), "server-version-mismatch");
  reason(validate(v2, legacy.input), "server-version-mismatch");
  reason(review(v1, derived()), "server-version-mismatch");
  reason(review(v2, legacyReview.input), "server-version-mismatch");
});
it.each([undefined, null, "unknown"])(
  "does not fall back for unsupported selection %s",
  (value) => {
    expect(() => validate(value as PlanPromptVersion, input)).toThrow();
    expect(() => review(value as PlanPromptVersion, derived())).toThrow();
  },
);
it.each([
  "version",
  "engineVersion",
  "configuration",
  "contract",
  "tokenEvidence",
  "tokenAssessment",
  "dispatchAllowed",
])("rejects caller authority field %s", async (key) => {
  const server = await createServerProviderPolicyContext(v2, fixed).loadValidationPlanning();
  const supplied = { ...input, [key]: true };
  reason(validate(v2, supplied), "invalid-input");
  expect(() => server.prepareGenerationValidation(supplied)).toThrow("Unsupported");
  const { configuration: _, ...r } = derived();
  void _;
  expect(() => server.prepareReviewDispatch({ ...r, [key]: true })).toThrow("Unsupported");
  if (key !== "configuration")
    reason(review(v2, { ...r, configuration: fixed, [key]: true }), "invalid-input");
});
it("preloads synchronous planners, copies configuration and isolates returned evidence", async () => {
  const config = structuredClone(fixed),
    context = createServerProviderPolicyContext(v2, config);
  const loading = context.loadValidationPlanning();
  Object.keys(config).forEach((k) => delete (config as unknown as Record<string, unknown>)[k]);
  const server = await loading,
    expected = validation(),
    result = server.prepareGenerationValidation(input);
  expect(result).not.toBeInstanceOf(Promise);
  (input.identity as Identity).responseEventDigest = "0".repeat(64);
  expect(result).toEqual({ status: "prepared", plan: expected });
  const r = derived(structuredClone(base)),
    expectedReview = reviewPlan(r),
    { configuration: _, ...evidence } = r;
  void _;
  const resultReview = server.prepareReviewDispatch(evidence);
  expect(resultReview).not.toBeInstanceOf(Promise);
  (evidence.identity as ReviewIdentity).validationEventDigest = "0".repeat(64);
  expect(resultReview).toEqual({ status: "prepared", plan: expectedReview });
});
it("keeps concurrent v1/v2 server planners isolated", async () => {
  const [one, two] = await Promise.all([
    createServerProviderPolicyContext(v1, fixed).loadValidationPlanning(),
    createServerProviderPolicyContext(v2, fixed).loadValidationPlanning(),
  ]);
  const rs = [
    one.prepareGenerationValidation(legacy.input),
    two.prepareGenerationValidation(input),
  ];
  expect(rs.map((r) => r.plan?.planVersion)).toEqual([1, 2]);
  const { configuration: _, ...r1 } = legacyReview.input,
    { configuration: __, ...r2 } = derived();
  void _;
  void __;
  const reviews = [one.prepareReviewDispatch(r1), two.prepareReviewDispatch(r2)];
  expect(reviews.map((r) => r.plan?.planVersion)).toEqual([1, 2]);
});
it.each(["responseRequestId", "responseEventDigest"])("requires original response %s", (key) => {
  (input.identity as unknown as Record<string, string>)[key] = key.endsWith("Id")
    ? randomUUID()
    : "0".repeat(64);
  reason(validate(v2, input), "bindings-changed");
});
it.each(["validationEventDigest", "validationRequestId", "responseEventDigest"])(
  "requires original validation and response chain: %s",
  (key) => {
    const r = derived(),
      id = r.identity as ReviewIdentity;
    if (key === "validationEventDigest") id.validationEventDigest = "0".repeat(64);
    else if (key === "validationRequestId") id.generation.validationRequestId = randomUUID();
    else id.generation.responseEventDigest = "0".repeat(64);
    reason(review(v2, r), "bindings-changed");
  },
);
it("rejects raw response corruption before deriving any review", () => {
  const row = input.archive.archive.ledger.artifacts.find(
    (a) => (a as { key: string }).key === "generation-response",
  ) as { body: string; sha256: string; sizeBytes: number };
  row.body += " ";
  row.sha256 = providerRawDigest(row.body);
  row.sizeBytes = Buffer.byteLength(row.body);
  reason(validate(v2, input), "archive-invalid");
});
it("rejects rehashed generated output that differs from its original response", () => {
  vi.spyOn(engine, "validateObservedPlanDraft").mockImplementation((company, raw) => {
    const changed = structuredClone(raw) as { sections: unknown[] };
    return { ...changed, title: "Different source" } as ReturnType<
      typeof engine.validateObservedPlanDraft
    >;
  });
  reason(validate(v2, input), "output-invalid");
});
it("retains unknown usage without validating or issuing a review request", () => {
  reason(
    validate(
      v2,
      responseInput((raw) => {
        delete raw.usage;
      }),
    ),
    "usage-unknown",
  );
});
it("rejects invalid captured domain output", () => {
  reason(
    validate(
      v2,
      responseInput((raw) => {
        raw.output = [{ type: "message", content: [{ type: "output_text", text: "{}" }] }];
      }),
    ),
    "output-invalid",
  );
});
it.each(["generation-validated", "generation-response", "generation-request"])(
  "rejects rehashed %s artifact",
  (key) => {
    const r = structuredClone(derived()),
      row = r.archive.archive.ledger.artifacts.find((a) => (a as { key: string }).key === key) as {
        body: string;
        sha256: string;
        sizeBytes: number;
      };
    expect(row).toBeDefined();
    row.body += " ";
    row.sha256 = providerRawDigest(row.body);
    row.sizeBytes = Buffer.byteLength(row.body);
    reason(review(v2, r), "archive-invalid");
  },
);
it("blocks nonce reuse across the complete archive", () => {
  (input.identity as Identity).validationRequestId = (
    input.archive.archive.ledger.receipts[0] as { clientRequestId: string }
  ).clientRequestId;
  reason(validate(v2, input), "nonce-conflict");
  const r = derived(structuredClone(base));
  (r.identity as ReviewIdentity).preparedRequestId = (
    r.identity as ReviewIdentity
  ).generation.validationRequestId;
  reason(review(v2, r), "nonce-conflict");
});
it("does not extend approval or accept validation from the future", () => {
  const r = derived();
  reason(
    review(v2, { ...r, inspectedAt: "2026-09-28T03:36:00.000Z" }),
    "approval-expired-or-future",
  );
  reason(
    review(v2, { ...r, inspectedAt: "2026-09-27T03:34:30.000Z" }),
    "approval-expired-or-future",
  );
  reason(validate(v2, { ...input, inspectedAt: "2026-09-27T03:33:00.000Z" }), "invalid-input");
});
it("rejects changed current configuration even when historical validation remains readable", () => {
  const r = derived();
  r.configuration = {};
  expect(review(v2, r).status).toBe("refused");
  expect(inspect(r.archive).reservationArchive.ledger.provider.snapshots[0].revision).toBe(5);
});
it("refuses replayed r5/r7 as a new validation/review plan", () => {
  const r = derived();
  reason(validate(v2, { ...input, archive: r.archive }), "generation-response-required");
  const p = reviewPlan(r),
    ledger = r.archive.archive.ledger;
  ledger.artifacts.push(p.rows.artifact);
  ledger.events.push(...p.rows.events);
  ledger.receipts.push(...p.rows.receipts);
  reason(review(v2, r), "generation-validation-required");
});
it("includes proposed rows in capacity bounds", () => {
  const p = validation(),
    max = 256 * 1024 * 1024;
  expect(
    validate(v2, { ...input, additionalUsedBytes: max - p.capacity.totalExposureBytes }).status,
  ).toBe("prepared");
  reason(
    validate(v2, { ...input, additionalUsedBytes: max - p.capacity.totalExposureBytes + 1 }),
    "capacity-exceeded",
  );
  const r = derived(),
    q = reviewPlan(r);
  expect(
    review(v2, { ...r, additionalUsedBytes: max - q.capacity.totalExposureBytes }).status,
  ).toBe("prepared");
  reason(
    review(v2, { ...r, additionalUsedBytes: max - q.capacity.totalExposureBytes + 1 }),
    "capacity-exceeded",
  );
});
it("plans from explicit timestamps without clock or network access", () => {
  const r = derived();
  vi.spyOn(Date, "now").mockImplementation(forbidden);
  expect(validate(v2, input).status).toBe("prepared");
  expect(review(v2, r).status).toBe("prepared");
});
it("binds r5 and r6/r7 operation receipts to v2 while preserving original approval bytes", () => {
  const r = derived(),
    before = JSON.stringify(r.archive.records[0]),
    p = reviewPlan(r);
  expect(p.rows.receipts.map((receipt) => receipt.inputDigest)).toEqual(
    [p.commands.prepared, p.commands.dispatch].map((c) =>
      versionedProviderExecutionOperationDigest(
        (r.identity as ReviewIdentity).generation.dispatch.runId,
        c,
      ),
    ),
  );
  expect(JSON.stringify(r.archive.records[0])).toBe(before);
  expect(p.basis.derivedFrom.outputDigest).toBe(
    digest(
      JSON.parse(
        (
          r.archive.archive.ledger.artifacts.find(
            (a) => (a as { key: string }).key === "generation-validated",
          ) as { body: string }
        ).body,
      ),
    ),
  );
});
