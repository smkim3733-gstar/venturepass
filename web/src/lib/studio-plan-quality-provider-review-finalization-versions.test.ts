/** Pure versioned r8/r9 plans. No DB, SDK, real approval or paid call. */
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
  throw Error("No DB in planning");
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
  validate as nativeValidate,
} from "./studio-plan-quality-provider-execution-version-test-helpers";
import {
  reviewValidationFixture,
  reviewValidationFindings,
  setReviewValidationOutput,
} from "./studio-plan-quality-provider-review-validation-test-helpers";
import { finalizationFixture } from "./studio-plan-quality-provider-finalization-test-helpers";
import {
  prepareVersionedProviderReviewValidation as validate,
  prepareProviderReviewValidation as frozenValidation,
  type ProviderReviewValidationInput as Input,
  type ProviderReviewValidationIdentity as Identity,
} from "./studio-plan-quality-provider-review-validation";
import {
  prepareVersionedProviderFinalization as finalize,
  prepareProviderFinalization as frozenFinalization,
  type ProviderFinalizationInput as FinalInput,
  type ProviderFinalizationIdentity as FinalIdentity,
} from "./studio-plan-quality-provider-finalization";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { inspectVersionedProviderTransmissionApprovalArchive as inspect } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerExecutionOperationDigest,
  versionedProviderExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  providerRawDigest,
  providerDigest as digest,
} from "../../scripts/local-data-quality-provider.mjs";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import * as engine from "./studio-engine";
const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
const fixed = readFixedProviderConfiguration()!;
function responseInput(change?: Parameters<typeof receive>[2]): Input {
  const f = fixture(executionBase());
  prepare(f, "generation");
  dispatch(f, "generation");
  receive(f, "generation");
  nativeValidate(f, "generation");
  prepare(f, "review");
  dispatch(f, "review");
  receive(f, "review", (raw) => {
    setReviewValidationOutput(raw);
    change?.(raw);
  });
  const nonce = (revision: number) =>
    f.data.receipts.find((r) => r.runRevision === revision)!.clientRequestId;
  const archive = f.upper();
  return {
    archive,
    inspectedAt: "2026-09-27T03:40:00.000Z",
    additionalUsedBytes: 0,
    identity: {
      dispatch: {
        generation: {
          dispatch: {
            runId: f.data.run.id,
            runDigest: f.data.run.runDigest,
            approvalBindingDigest: archive.records[0].recordDigest,
            preparedRequestId: nonce(2),
            dispatchRequestId: nonce(3),
          },
          responseRequestId: nonce(4),
          responseEventDigest: f.data.events[3].eventDigest,
          validationRequestId: nonce(5),
        },
        validationEventDigest: f.data.events[4].eventDigest,
        preparedRequestId: nonce(6),
        dispatchRequestId: nonce(7),
      },
      responseRequestId: nonce(8),
      responseEventDigest: f.data.events[7].eventDigest,
      validationRequestId: randomUUID(),
    },
  };
}
const base = responseInput(),
  legacy = reviewValidationFixture(),
  legacyFinal = finalizationFixture();
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
const reason = (r: { status: string; reason?: string }, expected: string) =>
  expect(r).toMatchObject({ status: "refused", reason: expected });
function validation(value = input) {
  const r = validate(v2, value);
  if (r.status !== "prepared") throw Error(r.reason);
  return r.plan;
}
function derived(value = input): FinalInput {
  const p = validation(value),
    archive = structuredClone(value.archive),
    ledger = archive.archive.ledger;
  ledger.artifacts.push(p.rows.artifact);
  ledger.events.push(p.rows.event);
  ledger.receipts.push(p.rows.receipt);
  return {
    archive,
    inspectedAt: "2026-09-27T03:41:00.000Z",
    additionalUsedBytes: 0,
    identity: {
      validation: structuredClone(value.identity),
      validationEventDigest: p.rows.event.eventDigest,
      finalizationRequestId: randomUUID(),
    },
  };
}
function final(value = derived()) {
  const r = finalize(v2, value);
  if (r.status !== "prepared") throw Error(r.reason);
  return r.plan;
}
it("binds r9 and r10 to the first manuscript and exact review response with no budget mutation", () => {
  const before = JSON.stringify(input),
    p = validation(),
    r = derived(),
    q = final(r);
  expect(p.planVersion).toBe(2);
  expect(q.planVersion).toBe(2);
  expect(p.output).toEqual({ kind: "review", findings: reviewValidationFindings });
  expect(p.finalization.rawBody).toBe(q.rows.artifact.body);
  expect(q.basis.generationEventDigest).toBe(
    (input.identity as Identity).dispatch.validationEventDigest,
  );
  expect(q.basis.reviewEventDigest).toBe(p.rows.event.eventDigest);
  expect(q.basis.reviewOutputDigest).toBe(digest(p.output));
  expect(p.rows.event.executionContractVersion).toBe(2);
  expect(q.rows.event.executionContractVersion).toBe(2);
  const id = (input.identity as Identity).dispatch.generation.dispatch.runId;
  for (const plan of [p, q]) {
    expect(plan.rows.receipt.inputDigest).toBe(
      versionedProviderExecutionOperationDigest(id, plan.command),
    );
    expect(plan.rows.receipt.inputDigest).not.toBe(
      providerExecutionOperationDigest(id, plan.command),
    );
    expect(plan).toMatchObject({
      status: "prepared-not-committed",
      transaction: "single-immediate-transaction-required",
      dispatchAllowed: false,
      budgetWriteAllowed: false,
      automaticRetryAllowed: false,
      finalResultPersisted: false,
    });
  }
  const ledger = r.archive.archive.ledger;
  ledger.artifacts.push(q.rows.artifact);
  ledger.events.push(q.rows.event);
  ledger.receipts.push(q.rows.receipt);
  const s = inspect(r.archive).reservationArchive.ledger.provider.snapshots[0];
  expect(s).toMatchObject({
    archiveFormatVersion: 5,
    revision: 10,
    terminal: true,
    state: "completed",
    dispatchAllowed: false,
    canResume: false,
  });
  expect(ledger.budgetEvents).toEqual(input.archive.archive.ledger.budgetEvents);
  expect(r.archive.records).toEqual(input.archive.records);
  expect(JSON.stringify(input)).toBe(before);
});
it("keeps complete v1 plan bytes and frozen entry point rejection of v2", () => {
  expect(JSON.stringify(validate(v1, legacy.input))).toBe(
    JSON.stringify(frozenValidation(legacy.input)),
  );
  expect(JSON.stringify(finalize(v1, legacyFinal.input))).toBe(
    JSON.stringify(frozenFinalization(legacyFinal.input)),
  );
  reason(frozenValidation(input), "archive-invalid");
  reason(frozenFinalization(derived()), "archive-invalid");
});
it("rejects both server/stored version mismatch directions", () => {
  reason(validate(v1, input), "server-version-mismatch");
  reason(validate(v2, legacy.input), "server-version-mismatch");
  reason(finalize(v1, derived()), "server-version-mismatch");
  reason(finalize(v2, legacyFinal.input), "server-version-mismatch");
});
it.each([undefined, null, "unknown"])("refuses unsupported selection %s", (version) => {
  expect(() => validate(version as PlanPromptVersion, input)).toThrow();
  expect(() => finalize(version as PlanPromptVersion, derived())).toThrow();
});
it.each([
  "version",
  "engineVersion",
  "configuration",
  "contract",
  "tokenEvidence",
  "tokenAssessment",
  "dispatchAllowed",
])("rejects caller authority field %s", async (key) => {
  const server = await createServerProviderPolicyContext(v2, fixed).loadValidationPlanning(),
    r = derived();
  reason(validate(v2, { ...input, [key]: true }), "invalid-input");
  reason(finalize(v2, { ...r, [key]: true }), "invalid-input");
  expect(() => server.prepareReviewValidation({ ...input, [key]: true })).toThrow("Unsupported");
  expect(() => server.prepareFinalization({ ...r, [key]: true })).toThrow("Unsupported");
});
it("preloads version-bound synchronous planners and isolates caller and returned data", async () => {
  const oneContext = createServerProviderPolicyContext(v1, fixed),
    config = structuredClone(fixed);
  const twoContext = createServerProviderPolicyContext(v2, config);
  const [one, two] = await Promise.all([
    oneContext.loadValidationPlanning(),
    twoContext.loadValidationPlanning(),
  ]);
  Object.keys(config).forEach((key) => delete (config as unknown as Record<string, unknown>)[key]);
  const r = derived(),
    a = one.prepareReviewValidation(legacy.input),
    b = two.prepareReviewValidation(input);
  const c = one.prepareFinalization(legacyFinal.input),
    d = two.prepareFinalization(r);
  expect([a, b, c, d].map((x) => x.plan?.planVersion)).toEqual([1, 2, 1, 2]);
  expect([a, b, c, d].some((x) => x instanceof Promise)).toBe(false);
  expect(b).toEqual({ status: "prepared", plan: validation() });
  expect(d).toEqual({ status: "prepared", plan: final(r) });
  (input.identity as Identity).responseEventDigest = "0".repeat(64);
  (r.identity as FinalIdentity).validationEventDigest = "0".repeat(64);
  expect(b.plan?.identity.responseEventDigest).not.toBe("0".repeat(64));
  expect(d.plan?.identity.validationEventDigest).not.toBe("0".repeat(64));
  expect(Object.isFrozen(b.plan?.output.findings)).toBe(true);
  expect(Object.isFrozen(d.plan?.body)).toBe(true);
});
it.each(["generation-response", "generation-validated", "review-request", "review-response"])(
  "rejects rehashed %s corruption before validation/finalization",
  (key) => {
    const r = derived();
    for (const value of [input, r]) {
      const row = value.archive.archive.ledger.artifacts.find(
        (a) => (a as { key: string }).key === key,
      ) as { body: string; sha256: string; sizeBytes: number };
      row.body += " ";
      row.sha256 = providerRawDigest(row.body);
      row.sizeBytes = Buffer.byteLength(row.body);
    }
    reason(validate(v2, input), "archive-invalid");
    reason(finalize(v2, r), "archive-invalid");
  },
);
it("rejects rehashed validated findings differing from original response", () => {
  const r = structuredClone(derived()),
    row = r.archive.archive.ledger.artifacts.find(
      (a) => (a as { key: string }).key === "review-validated",
    ) as { body: string; sha256: string; sizeBytes: number };
  const output = JSON.parse(row.body);
  output.findings[0].message = "변조된 검토 의견";
  row.body = JSON.stringify(output);
  row.sha256 = providerRawDigest(row.body);
  row.sizeBytes = Buffer.byteLength(row.body);
  reason(finalize(v2, r), "archive-invalid");
});
it.each([
  "responseRequestId",
  "responseEventDigest",
  "firstResponse",
  "firstValidation",
  "prepared",
  "dispatch",
])("binds exact historical source %s", (key) => {
  const id = input.identity as Identity;
  if (key === "responseRequestId") id.responseRequestId = randomUUID();
  else if (key === "responseEventDigest") id.responseEventDigest = "0".repeat(64);
  else if (key === "firstResponse") id.dispatch.generation.responseEventDigest = "0".repeat(64);
  else if (key === "firstValidation") id.dispatch.validationEventDigest = "0".repeat(64);
  else if (key === "prepared") id.dispatch.preparedRequestId = randomUUID();
  else id.dispatch.dispatchRequestId = randomUUID();
  reason(validate(v2, input), "bindings-changed");
  const r = derived(structuredClone(base));
  (r.identity as FinalIdentity).validation = id;
  reason(finalize(v2, r), "bindings-changed");
});
it("requires the exact r9 event and original validation nonce for finalization", () => {
  const r = derived();
  (r.identity as FinalIdentity).validationEventDigest = "0".repeat(64);
  reason(finalize(v2, r), "bindings-changed");
  const s = derived();
  (s.identity as FinalIdentity).validation.validationRequestId = randomUUID();
  reason(finalize(v2, s), "bindings-changed");
});
it("rejects domain validator substitution even when findings retain valid shape", () => {
  vi.spyOn(engine, "validateObservedPlanReview").mockReturnValue([
    { ...reviewValidationFindings[0], message: "다른 의견" },
  ]);
  reason(validate(v2, input), "output-invalid");
});
it("rejects finalizer substitution at preview and finalization", () => {
  const r = derived(),
    original = engine.finalizeObservedPlanReview;
  vi.spyOn(engine, "finalizeObservedPlanReview").mockImplementation((...args) => {
    const out = original(...args);
    return { ...out, content: { ...out.content, title: "다른 최종 원고" } };
  });
  reason(validate(v2, input), "finalization-unavailable");
  reason(finalize(v2, r), "finalization-unavailable");
});
it("does not validate unknown usage or invalid review output", () => {
  reason(
    validate(
      v2,
      responseInput((raw) => {
        delete raw.usage;
      }),
    ),
    "usage-unknown",
  );
  reason(
    validate(
      v2,
      responseInput((raw) => setReviewValidationOutput(raw, {})),
    ),
    "output-invalid",
  );
});
it("refuses reused nonce across the complete archive", () => {
  const r = derived();
  (input.identity as Identity).validationRequestId = (
    input.identity as Identity
  ).dispatch.generation.validationRequestId;
  reason(validate(v2, input), "nonce-conflict");
  (r.identity as FinalIdentity).finalizationRequestId = (
    r.identity as FinalIdentity
  ).validation.responseRequestId;
  reason(finalize(v2, r), "nonce-conflict");
});
it("does not treat r9/r10 as new validation/finalization", () => {
  const r = derived();
  reason(validate(v2, { ...input, archive: r.archive }), "review-response-required");
  const q = final(r),
    ledger = r.archive.archive.ledger;
  ledger.artifacts.push(q.rows.artifact);
  ledger.events.push(q.rows.event);
  ledger.receipts.push(q.rows.receipt);
  reason(finalize(v2, r), "execution-stopped");
});
it("respects explicit time ordering while deriving already observed output after approval expiry", () => {
  reason(validate(v2, { ...input, inspectedAt: "2026-09-27T03:33:00.000Z" }), "invalid-input");
  const r = derived();
  reason(finalize(v2, { ...r, inspectedAt: "2026-09-27T03:39:00.000Z" }), "invalid-input");
  expect(validate(v2, { ...input, inspectedAt: "2030-01-01T00:00:00.000Z" }).status).toBe(
    "prepared",
  );
  expect(finalize(v2, { ...r, inspectedAt: "2030-01-01T00:00:00.000Z" }).status).toBe("prepared");
});
it("accounts for proposed rows at the capacity boundary", () => {
  const p = validation(),
    r = derived(),
    q = final(r),
    max = 256 * 1024 * 1024;
  expect(
    validate(v2, { ...input, additionalUsedBytes: max - p.capacity.totalExposureBytes }).status,
  ).toBe("prepared");
  reason(
    validate(v2, { ...input, additionalUsedBytes: max - p.capacity.totalExposureBytes + 1 }),
    "capacity-exceeded",
  );
  expect(
    finalize(v2, {
      ...r,
      additionalUsedBytes:
        max - Math.max(q.capacity.previousExposureBytes, q.capacity.totalExposureBytes),
    }).status,
  ).toBe("prepared");
  reason(
    finalize(v2, { ...r, additionalUsedBytes: max - q.capacity.totalExposureBytes + 1 }),
    "capacity-exceeded",
  );
});
it("uses explicit time without network, DB or current clock", () => {
  const r = derived();
  vi.spyOn(Date, "now").mockImplementation(forbidden);
  expect(validate(v2, input).status).toBe("prepared");
  expect(finalize(v2, r).status).toBe("prepared");
});
