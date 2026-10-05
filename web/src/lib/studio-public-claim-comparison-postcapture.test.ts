import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { comparisonReservationTestFixture } from "./studio-public-claim-comparison-reservation-test-helpers";
import { createPublicComparisonCoverage } from "./studio-public-claim-comparison-budget";
import {
  createComparisonReservationReview,
  inspectComparisonReservationState,
  comparisonReservationRows,
  planComparisonReservation,
  type ComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  comparisonSha as sha,
  createComparisonFinancialBasis,
} from "./studio-public-claim-comparison-financial";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  comparisonTransmissionCore,
  comparisonTransmissionBasisSchema,
  comparisonTransmissionNotice,
  comparisonDispatchCommandSchema,
  comparisonCaptureCommandSchema,
  comparisonUnknownCommandSchema,
  createComparisonTransmissionReview,
  inspectComparisonTransmissionState,
  planComparisonDispatch,
  planComparisonCapture,
} from "./studio-public-claim-comparison-transmission";
import {
  comparisonUsagePolicySchema,
  assessComparisonUsage,
} from "./studio-public-claim-comparison-usage";
import {
  comparisonDispatchV2CommandSchema,
  comparisonResultCommandSchema,
  comparisonCloseCommandSchema,
  createComparisonTransmissionV2Review,
  inspectComparisonTransmissionV4State,
  planComparisonDispatchV2,
  planComparisonContinuationV4,
  createComparisonPostcapturePreview,
  planComparisonPostcapture,
  type ComparisonTransmissionV4State,
} from "./studio-public-claim-comparison-transmission-v4";
import { preparePublicClaimComparison } from "./studio-public-claim-comparison";
import {
  createPublicComparisonNativeEvent,
  publicComparisonFinalBody,
} from "./studio-public-claim-comparison-native";
import { publicClaimComparisonRequestPins } from "./studio-public-claim-comparison-request-types";

vi.mock("server-only", () => ({}));
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
const guard = vi.hoisted(() => ({ enabled: false }));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("I/O forbidden");
  }),
);
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
        if (guard.enabled) forbidden();
        super(...args);
      }
    },
  };
});
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
const at = "2026-10-05T10:00:00.000Z",
  later = "2026-10-06T10:00:00.000Z",
  bad = "f".repeat(64);
let directory: string, initial: ComparisonReservationState, reserved: ComparisonTransmissionV4State;
let fixture: ReturnType<typeof comparisonReservationTestFixture>;
let basis: ReturnType<typeof comparisonTransmissionBasisSchema.parse>;
let policy: ReturnType<typeof comparisonUsagePolicySchema.parse>;
let review: ReturnType<typeof createComparisonTransmissionV2Review>;
let command: ReturnType<typeof comparisonDispatchV2CommandSchema.parse>;
type Fresh<T> = Extract<T, { status: "prepared-not-committed" }>;
let dispatched: Fresh<ReturnType<typeof planComparisonDispatchV2>>;
let captured: Fresh<ReturnType<typeof planComparisonContinuationV4>>;
let compared: Fresh<ReturnType<typeof planComparisonPostcapture>>;
let closed: Fresh<ReturnType<typeof planComparisonPostcapture>>;
let resultCommand: ReturnType<typeof comparisonResultCommandSchema.parse>;
let closeCommand: ReturnType<typeof comparisonCloseCommandSchema.parse>;
const response = {
  id: "synthetic-response",
  model: "synthetic-model",
  status: "completed",
  service_tier: "default",
  usage: {
    input_tokens: 20,
    output_tokens: 10,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 2 },
  },
  output: [],
};
function fresh<T extends { status: string }>(
  value: T,
): Extract<T, { status: "prepared-not-committed" }> {
  if (value.status !== "prepared-not-committed") throw Error(value.status);
  return value as Extract<T, { status: "prepared-not-committed" }>;
}
function head(s: ComparisonTransmissionV4State) {
  const e = s.reservation.archive.records.events.at(-1)!;
  return { revision: e.revision, headDigest: e.eventDigest };
}
function current() {
  return {
    company: fixture.company,
    approvedReview: review,
    basis,
    usagePolicy: policy,
    at,
    eventId: randomUUID(),
  };
}
function capFor(s: ComparisonTransmissionV4State, value: unknown) {
  const b = s.transmissionBindings[0],
    body = JSON.stringify(captureProviderResponse(value));
  return comparisonCaptureCommandSchema.parse({
    commandVersion: 1,
    kind: "persist-public-comparison-capture",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: head(s),
    responseArtifactSha256: sha(body),
    sizeBytes: Buffer.byteLength(body),
  });
}
function resultFor(s: ComparisonTransmissionV4State) {
  const b = s.transmissionBindings[0],
    p = createComparisonPostcapturePreview(s, b.runId);
  return comparisonResultCommandSchema.parse({
    commandVersion: 1,
    kind: "record-public-comparison-result",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: head(s),
    responseArtifactSha256: p.responseArtifactSha256,
    responseArtifactByteLength: p.responseArtifactByteLength,
    expectedValidatedArtifactSha256: p.expectedValidatedArtifactSha256,
  });
}
function closeFor(s: ComparisonTransmissionV4State) {
  const b = s.transmissionBindings[0],
    a = inspectComparisonTransmissionV4State(s),
    p = createComparisonPostcapturePreview(s, b.runId);
  return comparisonCloseCommandSchema.parse({
    commandVersion: 1,
    kind: "settle-finalize-public-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: head(s),
    responseArtifactSha256: p.responseArtifactSha256,
    comparisonEventDigest: s.reservation.archive.records.events.find(
      (e) => e.payload.kind === "comparison-recorded",
    )!.eventDigest,
    usagePolicyDigest: p.usage.usagePolicyDigest ?? bad,
    expectedAssessmentDigest: p.expectedAssessmentDigest ?? bad,
    expectedBudgetHead: {
      revision: a.reservation.view.native.revision,
      headDigest: a.reservation.view.native.headDigest,
    },
  });
}
function closeCurrent() {
  return {
    at: later,
    usageEventId: randomUUID(),
    usageNonce: randomUUID(),
    costEventId: randomUUID(),
    budgetEventId: randomUUID(),
    finalEventId: randomUUID(),
    finalizationNonce: randomUUID(),
  };
}
function usageInput() {
  return {
    policy: structuredClone(policy),
    financialBasis: structuredClone(fixture.review.financialBasis),
    identity: fixture.request.identity,
    transmission: structuredClone(basis),
    environment: "synthetic-test" as const,
    dispatchedAt: at,
    capture: structuredClone(response),
  };
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-postcapture-plan-"));
  const store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  try {
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(store);
    store.providerRecordFinalization(f.identity);
    const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      const prefix = readPublicComparisonPrefix(db);
      initial = {
        prefix,
        coverage: createPublicComparisonCoverage(prefix),
        archive: {
          records: { runs: [], events: [], receipts: [], artifacts: [] },
          financial: { events: [], receipts: [] },
        },
        bindings: [],
        additionalUsedBytes: 0,
      };
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
  guard.enabled = true;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(forbidden);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(forbidden);
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
  fixture = comparisonReservationTestFixture(initial, at);
  const r = fresh(
    planComparisonReservation(initial, fixture.command, {
      company: fixture.company,
      approvedReview: fixture.review,
      evidence: fixture.evidence,
      at,
      runId: randomUUID(),
      eventId: randomUUID(),
      budgetEventId: randomUUID(),
    }),
  );
  reserved = { reservation: r.next, transmissionBindings: [] };
  const e = fixture.evidence;
  basis = comparisonTransmissionBasisSchema.parse({
    kind: "public-comparison-transmission-basis",
    basisVersion: 1,
    purpose: e.purpose,
    provenance: e.provenance,
    model: e.model,
    requestVersion: e.requestVersion,
    contractDigest: e.contractDigest,
    destination: e.destination,
    store: false,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    omissions: e.omissions,
    sources: e.sources,
    method: "POST",
    strict: true,
    schemaDigest: publicClaimComparisonRequestPins.schemaDigest,
    financialBasisDigest: fixture.review.financialBasis.basisDigest,
    retentionNoticeDigest: fixture.review.retentionNoticeDigest,
    notice: { ...comparisonTransmissionNotice, noticeDigest: digest(comparisonTransmissionNotice) },
  });
  policy = comparisonUsagePolicySchema.parse({
    policyVersion: 1,
    kind: "public-comparison-usage-policy",
    purpose: e.purpose,
    provenance: e.provenance,
    financialBasisDigest: basis.financialBasisDigest,
    requestIdentityDigest: digest(fixture.request.identity),
    contractDigest: e.contractDigest,
    configuredModel: e.model,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    currency: e.pricing.currency,
    unitScale: e.pricing.unitScale,
    omissionsDigest: digest(e.omissions),
    responseModels: [e.model],
    responseTiers: ["default"],
    modelMappingBasis: "Synthetic explicit model only.",
    tierCoverageBasis: "Synthetic omitted tier mapping only.",
    inputPartition: {
      kind: "disjoint-cache",
      aggregate: "input-includes-cache-read-and-write",
      cacheRead: { kind: "field", path: ["input_tokens_details", "cached_tokens"] },
      cacheWrite: { kind: "not-applicable", basis: "Synthetic no write cache." },
      basis: "Synthetic partition.",
    },
    bandSelection: { kind: "short-only", basis: "Synthetic short context only." },
    outputMeaning: "aggregate-output-includes-reasoning-no-addition",
    authority: {
      sources: e.sources.map((s) => ({ id: s.id, recordDigest: s.recordDigest })),
      reviewedAt: at,
      validUntil: e.sources[0].validUntil,
      explanation: "Synthetic fixture only.",
    },
  });
  review = createComparisonTransmissionV2Review(
    reserved,
    fixture.company,
    r.rows.run.id,
    basis,
    policy,
    at,
  );
  command = comparisonDispatchV2CommandSchema.parse({
    commandVersion: 2,
    kind: "approve-dispatch-public-claim-comparison",
    purpose: e.purpose,
    clientRequestId: randomUUID(),
    runId: review.runId,
    runDigest: review.runDigest,
    expectedReservationBindingDigest: review.reservationBindingDigest,
    approvedReviewDigest: review.reviewDigest,
    expectedTransmissionArchiveDigest: review.transmissionArchiveDigest,
    expectedCoverageDigest: review.coverageDigest,
    expectedRunHead: review.runHead,
    expectedBudgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
    usagePolicyDigest: digest(policy),
    approval: {
      noticeVersion: 1,
      noticeDigest: basis.notice.noticeDigest,
      retentionNoticeDigest: review.retentionNoticeDigest,
      exactRequestIdentityDigest: digest(review.identity),
      approvedAt: at,
      expiresAt: review.expiresAt,
      externalTransmissionAcknowledged: true,
      comparisonPurposeAcknowledged: true,
      singleCallAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
      unknownCostHoldAcknowledged: true,
      noResendAcknowledged: true,
      localRetentionAcknowledged: true,
    },
  });
  dispatched = fresh(planComparisonDispatchV2(reserved, command, current()));
  captured = fresh(
    planComparisonContinuationV4(dispatched.next, capFor(dispatched.next, response), {
      at: later,
      eventId: randomUUID(),
      capture: response,
    }),
  );
  resultCommand = resultFor(captured.next);
  compared = fresh(
    planComparisonPostcapture(captured.next, resultCommand, { at: later, eventId: randomUUID() }),
  );
  closeCommand = closeFor(compared.next);
  closed = fresh(planComparisonPostcapture(compared.next, closeCommand, closeCurrent()));
}, 60000);
afterAll(() => {
  const forbiddenCallCount = forbidden.mock.calls.length;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  guard.enabled = false;
  if (directory) {
    const parent = resolve(tmpdir()),
      target = resolve(directory),
      rel = relative(parent, target);
    if (!rel || rel.startsWith("..") || !target.startsWith(parent)) throw Error("fixture path");
    rmSync(target, { recursive: true, force: true });
  }
  expect(forbiddenCallCount).toBe(0);
});
it("plans exact 3-row dispatch and result then 8-row close without authority", () => {
  expect(dispatched.rows.binding.recordVersion).toBe(4);
  expect(review.reviewVersion).toBe(2);
  expect(policy.requestedTier).toBeNull();
  expect(compared.operation).toBe("record-result");
  expect(closed.operation).toBe("settle-finalize");
  if (closed.operation !== "settle-finalize") throw Error("close");
  expect(closed.rows.events).toHaveLength(3);
  expect(closed.rows.receipts).toHaveLength(3);
  expect(closed.rows.budgetEvent.payload.kind).toBe("recognize-comparison-usage");
  expect(Object.values(closed.authority).every((x) => x === false)).toBe(true);
  expect(closed.owner).toBeNull();
  expect(forbidden).not.toHaveBeenCalled();
});
it("preserves original bytes, legacy cost prefix and releases only the final storage hold", () => {
  expect(closed.next.reservation.prefix).toEqual(initial.prefix);
  expect(closed.next.reservation.coverage).toEqual(initial.coverage);
  expect(closed.next.reservation.bindings).toEqual(reserved.reservation.bindings);
  expect(closed.next.reservation.archive.records.runs).toEqual(
    reserved.reservation.archive.records.runs,
  );
  expect(closed.next.reservation.archive.records.artifacts.slice(0, 3)).toEqual(
    captured.next.reservation.archive.records.artifacts,
  );
  const a = inspectComparisonTransmissionV4State(closed.next);
  expect(a.reservation.view.native.heldUnits).toBe("0");
  expect(a.reservation.view.native.runs[0]).toMatchObject({
    finalized: true,
    heldBytes: 0,
    costSettled: true,
  });
});
it.each(["dispatch", "result", "close"] as const)(
  "replays %s before any current inputs with no new owner",
  (kind) => {
    const hostile = Object.defineProperty({}, "at", {
      get() {
        throw Error("new inputs read");
      },
    });
    const r =
      kind === "dispatch"
        ? planComparisonDispatchV2(closed.next, command, hostile)
        : planComparisonPostcapture(
            closed.next,
            kind === "result" ? resultCommand : closeCommand,
            hostile,
          );
    expect(r.status).toBe("replay");
    expect(r.rows).toBeNull();
    expect(r.owner).toBeNull();
    if (kind === "close" && r.status === "replay" && "recordedRows" in r) {
      expect(r.recordedRows).toEqual(closed.operation === "settle-finalize" ? closed.rows : null);
    }
  },
);
it("reopens JSON suffixes without changing typed legacy BLOB bytes", () => {
  const s = {
    reservation: {
      ...closed.next.reservation,
      prefix: structuredClone(initial.prefix),
      archive: JSON.parse(JSON.stringify(closed.next.reservation.archive)),
      bindings: JSON.parse(JSON.stringify(closed.next.reservation.bindings)),
    },
    transmissionBindings: JSON.parse(JSON.stringify(closed.next.transmissionBindings)),
  };
  expect(inspectComparisonTransmissionV4State(s).commands).toHaveLength(4);
});
it("old v3 inspector refuses v4 rather than silently upgrading SQL12 inputs", () => {
  expect(() => inspectComparisonTransmissionState(dispatched.next)).toThrow();
});
it.each([
  [
    "request",
    (p: typeof policy) => {
      p.requestIdentityDigest = bad;
    },
  ],
  [
    "financial",
    (p: typeof policy) => {
      p.financialBasisDigest = bad;
    },
  ],
  [
    "omissions",
    (p: typeof policy) => {
      p.omissionsDigest = bad;
    },
  ],
  [
    "currency",
    (p: typeof policy) => {
      p.currency = "KRW";
    },
  ],
  [
    "model",
    (p: typeof policy) => {
      p.configuredModel = "different";
    },
  ],
  [
    "source",
    (p: typeof policy) => {
      p.authority.sources[0].recordDigest = bad;
    },
  ],
  [
    "duplicate model",
    (p: typeof policy) => {
      p.responseModels.push(p.responseModels[0]);
    },
  ],
  [
    "duplicate tier",
    (p: typeof policy) => {
      p.responseTiers.push(p.responseTiers[0]);
    },
  ],
  [
    "expired",
    (p: typeof policy) => {
      p.authority.validUntil = at;
    },
  ],
  [
    "future reviewed",
    (p: typeof policy) => {
      p.authority.reviewedAt = later;
    },
  ],
  [
    "source expiry extension",
    (p: typeof policy) => {
      p.authority.validUntil = later;
    },
  ],
  [
    "unsafe field",
    (p: typeof policy) => {
      if (p.inputPartition.kind === "disjoint-cache")
        p.inputPartition.cacheRead = { kind: "field", path: ["__proto__"] };
    },
  ],
  [
    "equal unequal rates",
    (p: typeof policy) => {
      p.inputPartition = { kind: "equal-rates", basis: "Invalid unequal rates." };
    },
  ],
  [
    "unsupported long band",
    (p: typeof policy) => {
      p.bandSelection = { kind: "input-threshold", threshold: 100, basis: "No long band." };
    },
  ],
] as const)("rejects policy %s", (_name, change) => {
  const f = usageInput();
  change(f.policy);
  expect(() => assessComparisonUsage(f)).toThrow();
});
it.each([
  [
    "missing total",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).total_tokens = null;
    },
  ],
  [
    "inconsistent total",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).total_tokens = 31;
    },
  ],
  [
    "missing usage",
    (r: Record<string, unknown>) => {
      delete r.usage;
    },
  ],
  [
    "negative",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).input_tokens = -1;
    },
  ],
  [
    "fraction",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).output_tokens = 1.5;
    },
  ],
  [
    "model",
    (r: Record<string, unknown>) => {
      r.model = "unmapped";
    },
  ],
  [
    "missing tier",
    (r: Record<string, unknown>) => {
      delete r.service_tier;
    },
  ],
  [
    "unmapped tier",
    (r: Record<string, unknown>) => {
      r.service_tier = "priority";
    },
  ],
  [
    "cache count missing",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).input_tokens_details = {};
    },
  ],
  [
    "cache exceeds input",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).input_tokens_details = { cached_tokens: 21 };
    },
  ],
  [
    "reasoning exceeds output",
    (r: Record<string, unknown>) => {
      (r.usage as Record<string, unknown>).output_tokens_details = { reasoning_tokens: 11 };
    },
  ],
] as const)("holds unknown usage for %s", (_name, change) => {
  const f = usageInput();
  change(f.capture);
  const result = assessComparisonUsage(f);
  expect(result.status).toBe("unknown");
  expect(result.units).toBeNull();
});
it("ceil-rounds uncached/cache/output separately without adding reasoning twice", () => {
  expect(assessComparisonUsage(usageInput())).toMatchObject({
    status: "known",
    units: "3",
    normalized: {
      inputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 2,
    },
    violations: ["RESERVATION_EXCEEDED"],
  });
});
it("accepts explicit observed zero only after the same policy and metadata checks", () => {
  const f = usageInput();
  f.capture.usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  expect(assessComparisonUsage(f)).toMatchObject({ status: "known", units: "0", violations: [] });
});
it.each(["policy changed", "run head", "budget head", "review"] as const)(
  "rejects new dispatch with %s",
  (which) => {
    const c = structuredClone(command),
      cur = current();
    if (which === "policy changed")
      cur.usagePolicy = { ...policy, tierCoverageBasis: "Changed mapping." };
    if (which === "run head") c.expectedRunHead.headDigest = bad;
    if (which === "budget head") c.expectedBudgetHead.headDigest = bad;
    if (which === "review") c.approvedReviewDigest = bad;
    expect(() => planComparisonDispatchV2(reserved, c, cur)).toThrow();
  },
);
it("rejects company same-revision selected source mutation", () => {
  const cur = current();
  cur.company = structuredClone(cur.company);
  cur.company.sources[0].text += " changed";
  expect(() => planComparisonDispatchV2(reserved, command, cur)).toThrow();
});
it.each(["dispatch", "result", "close"] as const)(
  "rejects full command collision for %s",
  (kind) => {
    if (kind === "dispatch")
      expect(() =>
        planComparisonDispatchV2(closed.next, { ...command, usagePolicyDigest: bad }),
      ).toThrow();
    else
      expect(() =>
        planComparisonPostcapture(closed.next, {
          ...(kind === "result" ? resultCommand : closeCommand),
          responseArtifactSha256: bad,
        }),
      ).toThrow();
  },
);
it.each(["usage", "cost", "final"] as const)("rejects a partial 8-row close missing %s", (kind) => {
  const s = structuredClone(closed.next);
  const event = s.reservation.archive.records.events.find(
    (e) =>
      e.payload.kind ===
      (kind === "usage" ? "usage-assessed" : kind === "cost" ? "cost-settled" : "finalized"),
  )!;
  s.reservation.archive.records.events = s.reservation.archive.records.events.filter(
    (e) => e !== event,
  );
  s.reservation.archive.records.receipts = s.reservation.archive.records.receipts.filter(
    (r) => r.operationDigest !== event.eventDigest,
  );
  expect(() => inspectComparisonTransmissionV4State(s)).toThrow();
});
it("does not treat an internal close receipt nonce as user-command ownership", () => {
  if (closed.operation !== "settle-finalize") throw Error("close");
  const internalNonce = closed.rows.receipts[0].clientRequestId;
  expect(() =>
    planComparisonPostcapture(closed.next, {
      ...closeCommand,
      clientRequestId: internalNonce,
    }),
  ).toThrow();
});
it("rejects duplicate internal nonce/ID", () => {
  const cur = closeCurrent();
  cur.finalizationNonce = cur.usageNonce;
  expect(() => planComparisonPostcapture(compared.next, closeCommand, cur)).toThrow();
});
it("rejects stale result artifact hash", () => {
  expect(() =>
    planComparisonPostcapture(
      captured.next,
      { ...resultCommand, expectedValidatedArtifactSha256: bad },
      { at: later, eventId: randomUUID() },
    ),
  ).toThrow();
});
it("retains supplied false authority on canonical result and final artifacts", () => {
  const validated = closed.next.reservation.archive.records.artifacts.find(
    (a) => a.key === "comparison-validated",
  )!;
  const final = closed.next.reservation.archive.records.artifacts.find(
    (a) => a.key === "final-result",
  )!;
  expect(JSON.parse(validated.body)).toMatchObject({
    source: "supplied-response",
    evidenceOrigin: "manual-unverified",
    currentContextVerified: false,
  });
  expect(JSON.parse(final.body)).toMatchObject({
    source: "supplied-native-archive",
    dispatchAllowed: false,
    costAssessmentVerified: false,
  });
});
it("returns detached records on replay", () => {
  const r = planComparisonPostcapture(closed.next, closeCommand);
  if (r.status !== "replay") throw Error("replay");
  r.receipt.recordedAt = at;
  expect(
    closed.next.reservation.archive.records.receipts.find(
      (x) => x.clientRequestId === closeCommand.clientRequestId,
    )!.recordedAt,
  ).toBe(later);
});
it.each(["accessor", "toJSON", "cycle", "extra"] as const)(
  "rejects capture %s without invoking hooks",
  (kind) => {
    const f = usageInput(),
      raw: Record<string, unknown> = structuredClone(response),
      hook = vi.fn();
    if (kind === "accessor") Object.defineProperty(raw, "usage", { enumerable: true, get: hook });
    if (kind === "toJSON") raw.toJSON = hook;
    if (kind === "cycle") raw.usage = raw;
    if (kind === "extra") raw.credentials = "forbidden";
    expect(() => assessComparisonUsage({ ...f, capture: raw })).toThrow();
    expect(hook).not.toHaveBeenCalled();
  },
);

function compareResponse(value: unknown, state = dispatched.next, atValue = later) {
  const capture = fresh(
    planComparisonContinuationV4(state, capFor(state, value), {
      at: atValue,
      eventId: randomUUID(),
      capture: value,
    }),
  );
  return fresh(
    planComparisonPostcapture(capture.next, resultFor(capture.next), {
      at: atValue,
      eventId: randomUUID(),
    }),
  );
}
it("keeps an unknown dispatch held and accepts its first late capture after expiry", () => {
  const b = dispatched.next.transmissionBindings[0];
  const unknownCommand = comparisonUnknownCommandSchema.parse({
    commandVersion: 1,
    kind: "mark-public-comparison-unknown",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: head(dispatched.next),
    reason: "transport-unknown",
  });
  const u = fresh(
    planComparisonContinuationV4(dispatched.next, unknownCommand, { at, eventId: randomUUID() }),
  );
  expect(u.next.reservation.archive.financial).toEqual(
    dispatched.next.reservation.archive.financial,
  );
  const comparison = compareResponse(response, u.next);
  const result = fresh(
    planComparisonPostcapture(comparison.next, closeFor(comparison.next), closeCurrent()),
  );
  expect(
    inspectComparisonTransmissionV4State(result.next).reservation.view.native.runs[0].finalized,
  ).toBe(true);
  expect(planComparisonContinuationV4(result.next, unknownCommand).status).toBe("replay");
}, 20000);
it("preserves binding3 capture and result but refuses a policy-based close or retrofit", () => {
  const before = { reservation: reserved.reservation, transmissionBindings: [] };
  const oldReview = createComparisonTransmissionReview(
    before,
    fixture.company,
    review.runId,
    basis,
    at,
  );
  const oldInput: Record<string, unknown> = {
    ...command,
    commandVersion: 1,
    approvedReviewDigest: oldReview.reviewDigest,
    approval: { ...command.approval, expiresAt: oldReview.expiresAt },
  };
  delete oldInput.usagePolicyDigest;
  const oldCommand = comparisonDispatchCommandSchema.parse(oldInput);
  const oldDispatch = fresh(
    planComparisonDispatch(before, oldCommand, {
      company: fixture.company,
      approvedReview: oldReview,
      basis,
      at,
      eventId: randomUUID(),
    }),
  );
  const oldCapture = fresh(
    planComparisonCapture(oldDispatch.next, capFor(oldDispatch.next, response), {
      at: later,
      eventId: randomUUID(),
      capture: response,
    }),
  );
  const result = fresh(
    planComparisonPostcapture(oldCapture.next, resultFor(oldCapture.next), {
      at: later,
      eventId: randomUUID(),
    }),
  );
  expect(result.next.transmissionBindings).toEqual(oldDispatch.next.transmissionBindings);
  expect(planComparisonPostcapture(result.next, closeFor(result.next))).toMatchObject({
    status: "blocked",
    rows: null,
    usage: { reasons: ["PRE_DISPATCH_USAGE_POLICY_MISSING"] },
  });
  const edited = structuredClone(oldDispatch.next);
  const editedReview = edited.transmissionBindings[0].approvedReview;
  if (!editedReview || typeof editedReview !== "object") throw Error("review");
  Object.assign(editedReview, {
    usagePolicy: policy,
    usagePolicyDigest: digest(policy),
  });
  expect(() => inspectComparisonTransmissionV4State(edited)).toThrow();
}, 20000);
it("keeps missing usage held with no close rows and without inspecting fresh IDs", () => {
  const value = { ...response, usage: null };
  const c = compareResponse(value),
    before = structuredClone(c.next);
  const hostile = Object.defineProperty({}, "at", {
    get() {
      throw Error("fresh input read");
    },
  });
  expect(planComparisonPostcapture(c.next, closeFor(c.next), hostile)).toMatchObject({
    status: "blocked",
    rows: null,
  });
  expect(c.next).toEqual(before);
  const a = inspectComparisonTransmissionV4State(c.next);
  expect(a.reservation.view.native.heldUnits).toBe(review.budget.heldUnits);
  expect(a.reservation.view.native.runs[0]).toMatchObject({ finalized: false, costSettled: false });
}, 20000);
it("settles observed zero and releases the original hold while preserving the rejected response", () => {
  const value = structuredClone(response);
  value.usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const c = compareResponse(value);
  const result = fresh(planComparisonPostcapture(c.next, closeFor(c.next), closeCurrent()));
  if (result.operation !== "settle-finalize") throw Error("close");
  expect(result.rows.budgetEvent.payload).toMatchObject({
    recognizedUnits: "0",
    consumedHeldUnits: "0",
    releasedHeldUnits: fixture.review.financialBasis.costs.reservedUnits,
    boundExcessUnits: "0",
  });
  expect(
    result.next.reservation.archive.records.artifacts.find((a) => a.key === "comparison-response")!
      .body,
  ).toBe(JSON.stringify(captureProviderResponse(value)));
}, 20000);
it.each(["refusal", "incomplete", "alias"] as const)(
  "preserves %s independently from known usage",
  (kind) => {
    const value = {
      ...response,
      status: kind === "incomplete" ? "incomplete" : "completed",
      model: kind === "alias" ? "unmapped-alias" : response.model,
      output:
        kind === "refusal"
          ? [{ type: "message", content: [{ type: "refusal", refusal: "Synthetic refusal" }] }]
          : [],
    };
    const c = compareResponse(value),
      p = createComparisonPostcapturePreview(c.next, command.runId);
    if (kind === "alias") {
      expect(p.usage.status).toBe("unknown");
      expect(planComparisonPostcapture(c.next, closeFor(c.next))).toMatchObject({
        status: "blocked",
        rows: null,
      });
    } else {
      expect(p.usage.status).toBe("known");
      expect(
        fresh(planComparisonPostcapture(c.next, closeFor(c.next), closeCurrent())).operation,
      ).toBe("settle-finalize");
    }
    expect(p.comparisonState).not.toBe("comparison-ready");
  },
  20000,
);
it("records a valid quoted comparison without changing its current-context authority", () => {
  const prepared = preparePublicClaimComparison(fixture.company, fixture.request.command.selection);
  const output = {
    preparationDigest: prepared.preparationDigest,
    claimQuote: prepared.input.claimQuote,
    overall: { relation: "undetermined", reason: "Synthetic comparison only" },
    evidence: prepared.input.selectedEvidence.map((e) => ({
      sourceId: e.sourceId,
      relation: "undetermined",
      quotes: [],
      reason: "Needs review",
      nextCheck: "",
    })),
    checks: [],
  };
  const c = compareResponse({
    ...response,
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(output) }],
      },
    ],
  });
  expect(createComparisonPostcapturePreview(c.next, command.runId).comparisonState).toBe(
    "comparison-ready",
  );
  expect(
    c.next.reservation.archive.records.artifacts.find((a) => a.key === "comparison-validated")!
      .body,
  ).toContain('"currentContextVerified":false');
});
it("records full excess in the same scope and prevents another reservation", () => {
  if (closed.operation !== "settle-finalize") throw Error("close");
  expect(closed.rows.budgetEvent.payload).toMatchObject({
    recognizedUnits: "3",
    consumedHeldUnits: "2",
    releasedHeldUnits: "0",
    boundExcessUnits: "1",
  });
  expect(closed.rows.budgetEvent.scopeId).toBe(initial.prefix.scopeId);
  expect(() => comparisonReservationTestFixture(closed.next.reservation, at)).toThrow();
});
it("rejects a valid native partial usage state as an incomplete binding4 close", () => {
  const s = structuredClone(compared.next),
    p = createComparisonPostcapturePreview(s, command.runId);
  if (!p.usage.assessment) throw Error("assessment");
  comparisonTransmissionCore.addEvent(s, randomUUID(), randomUUID(), later, command.runId, {
    kind: "usage-assessed",
    assessment: p.usage.assessment,
  });
  expect(() => inspectComparisonReservationState(s.reservation)).not.toThrow();
  expect(() => inspectComparisonTransmissionV4State(s)).toThrow("PUBLIC_COMPARISON_PARTIAL_CLOSE");
});
it("rejects a fully rehashed native-valid close whose supplied amount contradicts the pinned policy", () => {
  const s = structuredClone(compared.next),
    a = inspectComparisonReservationState(s.reservation);
  const p = createComparisonPostcapturePreview(s, command.runId);
  if (!p.usage.assessment) throw Error("assessment");
  const assessment = { ...p.usage.assessment, units: "1", violations: [] };
  const usage = comparisonTransmissionCore.addEvent(
    s,
    randomUUID(),
    randomUUID(),
    later,
    command.runId,
    { kind: "usage-assessed", assessment },
  );
  const b = s.transmissionBindings[0];
  const budget = comparisonReservationRows.money(s.reservation, a.view, randomUUID(), later, {
    kind: "recognize-comparison-usage",
    runId: command.runId,
    reservationDigest: b.reservationDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    responseArtifactSha256: p.responseArtifactSha256,
    usageAssessmentDigest: digest(assessment),
    recognizedUnits: "1",
    consumedHeldUnits: "1",
    releasedHeldUnits: "1",
    boundExcessUnits: "0",
  });
  const cost = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId: command.runId,
    eventId: randomUUID(),
    revision: usage.event.revision + 1,
    previousDigest: usage.event.eventDigest,
    recordedAt: later,
    payload: { kind: "cost-settled", budgetEventDigest: budget.eventDigest },
  });
  comparisonReservationRows.addMoney(s.reservation, cost, budget, randomUUID());
  const final = comparisonReservationRows.artifact(
    command.runId,
    "final-result",
    JSON.stringify(
      publicComparisonFinalBody(s.reservation.archive.records.runs[0], {
        cancelled: false,
        responseArtifactSha256: p.responseArtifactSha256,
        comparisonState: p.comparisonState,
        assessmentDigest: digest(assessment),
      }),
    ),
  );
  s.reservation.archive.records.artifacts.push(final);
  comparisonTransmissionCore.addEvent(s, randomUUID(), randomUUID(), later, command.runId, {
    kind: "finalized",
    finalArtifactSha256: final.sha256,
  });
  expect(() => inspectComparisonReservationState(s.reservation)).not.toThrow();
  expect(() => inspectComparisonTransmissionV4State(s)).toThrow();
});
it.each(["policy", "comparison", "assessment", "budget"] as const)(
  "rejects changed close %s before generating rows",
  (field) => {
    const c = structuredClone(closeCommand);
    if (field === "policy") c.usagePolicyDigest = bad;
    if (field === "comparison") c.comparisonEventDigest = bad;
    if (field === "assessment") c.expectedAssessmentDigest = bad;
    if (field === "budget") c.expectedBudgetHead.headDigest = bad;
    expect(() => planComparisonPostcapture(compared.next, c, closeCurrent())).toThrow();
  },
);
it("limits expiry to the pinned policy and never changes the original reservation", () => {
  const p = {
    ...policy,
    authority: { ...policy.authority, validUntil: "2026-10-05T10:01:00.000Z" },
  };
  const r = createComparisonTransmissionV2Review(
    reserved,
    fixture.company,
    command.runId,
    basis,
    p,
    at,
  );
  expect(r.expiresAt).toBe(p.authority.validUntil);
  expect(reserved.reservation.bindings[0].approvedReview).toEqual(fixture.review);
});
it.each(["financialBasis", "identity", "transmission"] as const)(
  "rejects %s accessors without evaluating them",
  (field) => {
    const f = usageInput(),
      hook = vi.fn();
    const raw = Object.defineProperty({}, "model", { enumerable: true, get: hook });
    expect(() => assessComparisonUsage({ ...f, [field]: raw })).toThrow();
    expect(hook).not.toHaveBeenCalled();
  },
);
it("rejects forged source body even when the caller updates its policy reference", () => {
  const f = usageInput();
  f.transmission.sources[0].excerpt += " altered";
  expect(() => assessComparisonUsage(f)).toThrow();
});
it("rejects policy byte overflow and reserved default-tier fields", () => {
  const p = structuredClone(policy);
  p.modelMappingBasis = "한".repeat(2000);
  p.tierCoverageBasis = "한".repeat(2000);
  p.authority.explanation = "한".repeat(2000);
  p.inputPartition.basis = "한".repeat(2000);
  p.bandSelection.basis = "한".repeat(2000);
  if (
    p.inputPartition.kind === "disjoint-cache" &&
    p.inputPartition.cacheWrite.kind === "not-applicable"
  )
    p.inputPartition.cacheWrite.basis = "한".repeat(2000);
  expect(() => assessComparisonUsage({ ...usageInput(), policy: p })).toThrow();
  expect(() =>
    assessComparisonUsage({ ...usageInput(), policy: { ...policy, requestedTier: "default" } }),
  ).toThrow();
});
it("includes supplied raw overhead in the unchanged total capacity limit", () => {
  const s = structuredClone(captured.next);
  s.reservation.additionalUsedBytes = 256 * 1024 * 1024;
  expect(() =>
    planComparisonPostcapture(s, resultCommand, { at: later, eventId: randomUUID() }),
  ).toThrow();
});
it("preserves every omitted request option in review2", () => {
  const wire = JSON.parse(fixture.request.rawBody);
  for (const key of ["service_tier", "truncation", "background", "stream"])
    expect(Object.hasOwn(wire, key)).toBe(false);
  expect(review.identity).toEqual(fixture.request.identity);
});

function changedPricing(change: (e: typeof fixture.evidence) => void) {
  const f = usageInput(),
    evidence = structuredClone(f.financialBasis.evidence);
  change(evidence);
  f.financialBasis = createComparisonFinancialBasis(
    evidence,
    f.identity,
    evidence.model,
    f.environment,
    at,
  );
  f.policy.financialBasisDigest = f.financialBasis.basisDigest;
  f.transmission.financialBasisDigest = f.financialBasis.basisDigest;
  return f;
}
it.each([20, 21])("uses the pinned short/long rate boundary at input %s", (input) => {
  const f = changedPricing((e) => {
    e.pricing.shortContext.uncachedInput = { units: "1", perTokens: 1 };
    e.pricing.shortContext.cacheReadInput = { kind: "rate", rate: { units: "1", perTokens: 1 } };
    e.pricing.shortContext.outputIncludingReasoning = { units: "1", perTokens: 1 };
    e.pricing.longContext = {
      ...e.pricing.shortContext,
      uncachedInput: { units: "2", perTokens: 1 },
      cacheReadInput: { kind: "rate", rate: { units: "2", perTokens: 1 } },
      outputIncludingReasoning: { units: "2", perTokens: 1 },
    };
  });
  f.policy.bandSelection = { kind: "input-threshold", threshold: 20, basis: "Synthetic boundary." };
  f.capture.usage.input_tokens = input;
  f.capture.usage.total_tokens = input + 10;
  expect(assessComparisonUsage(f)).toMatchObject({
    status: "known",
    units: input === 20 ? "30" : "62",
  });
});
it("reuses equal replacement rates without requiring a cache partition", () => {
  const f = changedPricing((e) => {
    e.pricing.shortContext.cacheReadInput = {
      kind: "rate",
      rate: e.pricing.shortContext.uncachedInput,
    };
  });
  f.policy.inputPartition = { kind: "equal-rates", basis: "Synthetic equal replacement rates." };
  expect(assessComparisonUsage(f)).toMatchObject({ status: "known", units: "2" });
});
it("applies cache write as a disjoint replacement rather than adding input twice", () => {
  const f = changedPricing((e) => {
    e.pricing.shortContext.cacheWriteInput = {
      kind: "rate",
      rate: { units: "7", perTokens: 1000000 },
    };
  });
  if (f.policy.inputPartition.kind !== "disjoint-cache") throw Error("policy");
  f.policy.inputPartition.cacheWrite = {
    kind: "field",
    path: ["input_tokens_details", "synthetic_write_tokens"],
  };
  Object.assign(f.capture.usage.input_tokens_details, { synthetic_write_tokens: 3 });
  expect(assessComparisonUsage(f)).toMatchObject({
    status: "known",
    units: "4",
    normalized: { cachedInputTokens: 5, cacheWriteInputTokens: 3 },
  });
});
it("retains a known amount above context/output/reservation bounds", () => {
  const f = usageInput();
  f.capture.usage = {
    input_tokens: 200000,
    output_tokens: 20000,
    total_tokens: 220000,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 20000 },
  };
  const r = assessComparisonUsage(f);
  expect(r.status).toBe("known");
  expect(BigInt(r.units!)).toBeGreaterThan(BigInt(f.financialBasis.costs.reservedUnits));
  expect(r.violations).toEqual([
    "INPUT_LIMIT_EXCEEDED",
    "OUTPUT_LIMIT_EXCEEDED",
    "CONTEXT_LIMIT_EXCEEDED",
    "RESERVATION_EXCEEDED",
  ]);
});

function newVersion4Run(f: typeof fixture, prior: ComparisonTransmissionV4State, atValue: string) {
  const rr = createComparisonReservationReview(
    prior.reservation,
    f.company,
    f.request.command,
    f.evidence,
    atValue,
  );
  const rc = {
    ...f.command,
    approvedReviewDigest: rr.reviewDigest,
    expectedArchiveDigest: rr.archiveDigest,
    expectedBudgetHead: { revision: rr.budget.revision, headDigest: rr.budget.headDigest },
    expectedGlobalRunCount: rr.globalRunCount,
    approval: { ...f.command.approval, expiresAt: rr.expiresAt },
  };
  const r = fresh(
    planComparisonReservation(prior.reservation, rc, {
      company: f.company,
      approvedReview: rr,
      evidence: f.evidence,
      at: atValue,
      runId: randomUUID(),
      eventId: randomUUID(),
      budgetEventId: randomUUID(),
    }),
  );
  const s = { reservation: r.next, transmissionBindings: prior.transmissionBindings };
  const b = {
    ...basis,
    sources: f.evidence.sources,
    omissions: f.evidence.omissions,
    financialBasisDigest: rr.financialBasis.basisDigest,
    retentionNoticeDigest: rr.retentionNoticeDigest,
  };
  const p = {
    ...policy,
    financialBasisDigest: b.financialBasisDigest,
    requestIdentityDigest: digest(f.request.identity),
    omissionsDigest: digest(b.omissions),
    authority: {
      ...policy.authority,
      reviewedAt: atValue,
      validUntil: b.sources[0].validUntil,
      sources: b.sources.map((x) => ({ id: x.id, recordDigest: x.recordDigest })),
    },
  };
  const tr = createComparisonTransmissionV2Review(s, f.company, r.rows.run.id, b, p, atValue);
  const tc = {
    ...command,
    clientRequestId: randomUUID(),
    runId: tr.runId,
    runDigest: tr.runDigest,
    expectedReservationBindingDigest: tr.reservationBindingDigest,
    approvedReviewDigest: tr.reviewDigest,
    expectedTransmissionArchiveDigest: tr.transmissionArchiveDigest,
    expectedCoverageDigest: tr.coverageDigest,
    expectedRunHead: tr.runHead,
    expectedBudgetHead: { revision: tr.budget.revision, headDigest: tr.budget.headDigest },
    usagePolicyDigest: tr.usagePolicyDigest,
    approval: {
      ...command.approval,
      approvedAt: atValue,
      expiresAt: tr.expiresAt,
      retentionNoticeDigest: tr.retentionNoticeDigest,
      exactRequestIdentityDigest: digest(tr.identity),
    },
  };
  return fresh(
    planComparisonDispatchV2(s, tc, {
      company: f.company,
      approvedReview: tr,
      basis: b,
      usagePolicy: p,
      at: atValue,
      eventId: randomUUID(),
    }),
  );
}
it("preserves the first binding4 close while reconstructing a second run review", () => {
  const value = structuredClone(response);
  value.usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const c = compareResponse(value, dispatched.next, at);
  const firstCommand = closeFor(c.next);
  const first = fresh(planComparisonPostcapture(c.next, firstCommand, { ...closeCurrent(), at }));
  const f = comparisonReservationTestFixture(first.next.reservation, at);
  const second = newVersion4Run(f, first.next, at);
  expect(inspectComparisonTransmissionV4State(second.next).state.transmissionBindings).toHaveLength(
    2,
  );
  expect(second.next.transmissionBindings[0]).toEqual(first.next.transmissionBindings[0]);
  expect(planComparisonPostcapture(second.next, firstCommand).status).toBe("replay");
}, 30000);
it("records known cost above the scope cap without clipping or resetting prior costs", () => {
  const f = comparisonReservationTestFixture(initial, at);
  f.evidence.pricing.shortContext.uncachedInput = { units: "100", perTokens: 1 };
  f.evidence.pricing.shortContext.cacheReadInput = {
    kind: "rate",
    rate: { units: "50", perTokens: 1 },
  };
  f.evidence.pricing.shortContext.outputIncludingReasoning = { units: "100", perTokens: 1 };
  const d = newVersion4Run(f, { reservation: initial, transmissionBindings: [] }, at);
  const value = structuredClone(response);
  value.usage = {
    input_tokens: 1000000,
    output_tokens: 0,
    total_tokens: 1000000,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  const c = compareResponse(value, d.next);
  const result = fresh(planComparisonPostcapture(c.next, closeFor(c.next), closeCurrent()));
  const a = inspectComparisonTransmissionV4State(result.next).reservation.view.native;
  expect(a.boundBreached).toBe(true);
  expect(BigInt(a.deficitUnits)).toBeGreaterThan(BigInt(0));
  expect(a.recognizedUnits).toBe(
    (BigInt("100000000") + BigInt(review.budget.recognizedUnits)).toString(),
  );
  expect(result.next.reservation.prefix).toEqual(initial.prefix);
}, 30000);
