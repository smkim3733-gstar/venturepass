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
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import * as configuration from "./studio-plan-quality-provider-configuration";
import {
  createPublicComparisonCoverage,
  inspectPublicComparisonNativeArchive,
} from "./studio-public-claim-comparison-budget";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import {
  createPublicComparisonNativeEvent,
  publicComparisonNativeInputDigest,
} from "./studio-public-claim-comparison-native";
import {
  comparisonFinancialEvidenceSchema,
  createComparisonFinancialBasis,
  comparisonSha as sha,
  comparisonPlanAuthority,
  type ComparisonFinancialEvidence,
} from "./studio-public-claim-comparison-financial";
import {
  createComparisonReservationReview,
  planComparisonReservation,
  planComparisonCancellation,
  inspectComparisonReservationState,
  type ComparisonReservationState,
  comparisonReserveCommandSchema,
  comparisonCancelCommandSchema,
} from "./studio-public-claim-comparison-reservation";
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
const at = "2026-10-05T10:00:00.000Z";
let directory: string,
  state: ComparisonReservationState,
  company: ReturnType<typeof publicClaimComparisonFixture>["company"];
let request: ReturnType<typeof buildPublicClaimComparisonRequest>,
  evidence: ComparisonFinancialEvidence;
let review: ReturnType<typeof createComparisonReservationReview>;
let command: ReturnType<typeof comparisonReserveCommandSchema.parse>;
let reserved: Extract<
  ReturnType<typeof planComparisonReservation>,
  { status: "prepared-not-committed" }
>;
function ids() {
  return { at, runId: randomUUID(), eventId: randomUUID(), budgetEventId: randomUUID() };
}
function current() {
  return {
    company: structuredClone(company),
    evidence: structuredClone(evidence),
    approvedReview: structuredClone(review),
    ...ids(),
  };
}
function reserveCommand() {
  return { ...structuredClone(command), clientRequestId: randomUUID() };
}
function cancellation(s = reserved.next) {
  const b = s.bindings[0],
    events = s.archive.records.events.filter((e) => e.runId === b.runId),
    last = events.at(-1)!;
  const r = { revision: last.revision, headDigest: last.eventDigest },
    budget = s.archive.financial.events.at(-1)!;
  return comparisonCancelCommandSchema.parse({
    commandVersion: 1,
    kind: "cancel-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    expectedBindingDigest: b.recordDigest,
    reservationDigest: b.budgetEventDigest,
    expectedRunHead: { revision: r.revision, headDigest: r.headDigest },
    expectedBudgetHead: { revision: budget.revision, headDigest: budget.eventDigest },
  });
}
function cancelIds() {
  return {
    at,
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
    finalEventId: randomUUID(),
    finalizationNonce: randomUUID(),
  };
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-comparison-plan-"));
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
      state = {
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
  const f = publicClaimComparisonFixture(2);
  company = f.company;
  const selection = f.select();
  selection.sourceIds = selection.sourceIds.slice(0, 1);
  request = buildPublicClaimComparisonRequest(company, {
    requestVersion: "public-claim-comparison-request-v1",
    model: "synthetic-model",
    selection,
  });
  const sourceBody = {
    id: "synthetic-contract",
    url: "https://openai.com/synthetic-contract-fixture",
    title: "Synthetic test only; no actual official review",
    retrievedAt: at,
    reviewedAt: at,
    validUntil: "2026-10-05T12:00:00.000Z",
    excerpt:
      "SYNTHETIC fixture only. Does not establish any actual model support, terms or prices.",
    excerptSha256: "",
    bodySha256: null,
    digestKind: "curated-record" as const,
  };
  sourceBody.excerptSha256 = sha(sourceBody.excerpt);
  const source = { ...sourceBody, recordDigest: digest(sourceBody) };
  const omission = {
    interpretation: "omitted-all-applicable-outcomes-bounded",
    sourceIds: [source.id],
    explanation: "Synthetic assumption only.",
  };
  const rate = { units: "10", perTokens: 1000000 };
  evidence = comparisonFinancialEvidenceSchema.parse({
    evidenceVersion: 1,
    purpose: "compare-public-claim",
    provenance: "official-reviewed",
    model: request.command.model,
    requestVersion: request.command.requestVersion,
    contractDigest: request.identity.contractDigest,
    destination: "https://api.openai.com/v1/responses",
    store: false,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    omissions: {
      service_tier: omission,
      truncation: omission,
      background: omission,
      stream: omission,
    },
    context: {
      contextWindowTokens: 100000,
      maxOutputTokens: 16000,
      coverage: "input-plus-output-including-reasoning",
      sourceIds: [source.id],
    },
    pricing: {
      currency: "USD",
      unitScale: 6,
      rateMeaning: "all-in-replacement-rates-not-additive-surcharges",
      shortContext: {
        uncachedInput: rate,
        cacheReadInput: { kind: "rate", rate: { units: "5", perTokens: 1000000 } },
        cacheWriteInput: { kind: "not-applicable", explanation: "Synthetic absence." },
        outputIncludingReasoning: { units: "20", perTokens: 1000000 },
      },
      longContext: { kind: "not-applicable", explanation: "Synthetic absence." },
      additionalCharges: {
        kind: "none-under-stated-and-omitted-conditions",
        explanation: "Synthetic absence.",
      },
      sourceIds: [source.id],
    },
    retention: {
      policyVersion: "synthetic-only",
      localNotice: "Selected context persists after company changes.",
      providerNotice: "store:false is not a guarantee of zero provider retention.",
      localArtifacts: [
        "comparison-context",
        "comparison-request",
        "comparison-response",
        "comparison-validated",
        "final-result",
      ],
      survivesCompanyChanges: true,
      storeFalseIsNoRetentionGuarantee: false,
      sourceIds: [source.id],
    },
    sources: [source],
  });
  review = createComparisonReservationReview(state, company, request.command, evidence, at);
  command = comparisonReserveCommandSchema.parse({
    commandVersion: 1,
    kind: "reserve-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    companyId: company.id,
    companyRevision: company.revision,
    request: request.command,
    identity: request.identity,
    approvedReviewDigest: review.reviewDigest,
    expectedArchiveDigest: review.archiveDigest,
    expectedBudgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
    expectedGlobalRunCount: review.globalRunCount,
    approval: {
      noticeVersion: 1,
      noticeDigest: review.notice.noticeDigest,
      retentionNoticeDigest: review.retentionNoticeDigest,
      approvedAt: at,
      expiresAt: review.expiresAt,
      comparisonPurposeAcknowledged: true,
      selectedContentRetentionAcknowledged: true,
      currentBudgetReservationAcknowledged: true,
      financialBasisNotTokenFitAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
      transmission: "separate-approval-required",
    },
  });
  const result = planComparisonReservation(state, command, current());
  if (result.status !== "prepared-not-committed") throw Error("fixture not prepared");
  reserved = result;
}, 30000);
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (directory) {
    const r = relative(resolve(tmpdir()), resolve(directory));
    if (!r.startsWith("venture-comparison-plan-") || r.includes(".."))
      throw Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
it("reserves exactly one call, binds original consent and preserves prefix/selection bytes", () => {
  const original = digest(state),
    r = planComparisonReservation(state, reserveCommand(), current());
  expect(r.status).toBe("prepared-not-committed");
  if (r.status !== "prepared-not-committed") return;
  expect(digest(state)).toBe(original);
  expect(r.next.prefix).toEqual(state.prefix);
  expect(r.rows.artifacts.find((a) => a.key === "comparison-request")?.body).toBe(request.rawBody);
  expect(r.rows.artifacts[0].body).not.toContain("PRIVATE_PROFILE");
  expect(r.rows.binding.recordVersion).toBe(3);
  expect(r.next.archive.records.receipts).toHaveLength(1);
  expect(r.next.archive.financial.receipts).toHaveLength(1);
  expect(r.rows.receipt.clientRequestId).toBe(r.next.archive.financial.receipts[0].clientRequestId);
  expect(r.rows.binding.commandDigest).toBe(digest(r.rows.binding.command));
  expect(r.owner).toBeNull();
  expect(r.authority).toEqual(comparisonPlanAuthority);
  expect(Object.values(r.authority).every((x) => x === false)).toBe(true);
  expect(r.rows.run.manifest.reservedUnits).toBe("2");
  expect(r.rows.run.manifest.expiresAt).toBe("2026-10-05T10:10:00.000Z");
  expect(r.next.archive.financial.events[0].previousDigest).toBe(review.budget.headDigest);
  expect(r.capacity.totalExposureBytes).toBeGreaterThan(32 * 1024 * 1024);
});
it("keeps reservation arithmetic separate from request tokens, omission defaults and actual authority", () => {
  expect(review.financialBasis.costs.inputTokensReserved).toBe(100000);
  expect(review.requestedTier).toBeNull();
  expect(review.identity.requestCharacters).toBeLessThan(240000);
  expect(review.financialBasis.evidence.omissions.service_tier.interpretation).toBe(
    "omitted-all-applicable-outcomes-bounded",
  );
  expect(review.authority.priceAuthenticityVerified).toBe(false);
  expect(review.authority.humanConsentVerified).toBe(false);
  expect(request.body).not.toHaveProperty("service_tier");
});
it("replays original reservation before accessing current company/evidence/clock/ids", () => {
  const unread = Object.defineProperty({}, "company", {
    get: () => {
      throw Error("must not read");
    },
  });
  const r = planComparisonReservation(reserved.next, command, unread);
  expect(r.status).toBe("replay");
  expect(r.rows).toBeNull();
  expect(r.owner).toBeNull();
  if (r.status !== "replay") throw Error("Expected original replay");
  expect(r.binding).toEqual(reserved.rows.binding);
});
it("rejects same reservation nonce with different original consent even when money is unchanged", () => {
  const c = structuredClone(command);
  c.approval.approvedAt = "2026-10-05T10:00:01.000Z";
  expect(() => planComparisonReservation(reserved.next, c)).toThrow();
});
it("cancels after expiry with no current company/settings, releases money and finalizes storage", () => {
  const c = cancellation(),
    r = planComparisonCancellation(reserved.next, c, {
      ...cancelIds(),
      at: "2026-10-06T10:00:00.000Z",
    });
  expect(r.status).toBe("prepared-not-committed");
  if (r.status !== "prepared-not-committed") return;
  const audit = inspectComparisonReservationState(r.next);
  expect(audit.view.native.heldUnits).toBe("0");
  expect(audit.view.native.recognizedUnits).toBe(review.budget.recognizedUnits);
  expect(audit.view.native.runs[0].finalized).toBe(true);
  expect(audit.view.native.capacity.comparisonHeldBytes).toBe(0);
  expect(audit.cancellations).toEqual([c]);
  expect(r.rows.receipts).toHaveLength(2);
  expect(r.rows.receipts[1].budgetOperationDigest).toBeNull();
  expect(r.next.archive.financial.receipts).toHaveLength(2);
  expect(r.capacity.totalExposureBytes).toBeLessThan(reserved.capacity.totalExposureBytes);
  const replay = planComparisonCancellation(r.next, c, {
    get at() {
      throw Error("read current");
    },
  });
  expect(replay.status).toBe("replay");
  expect(replay.rows).toBeNull();
  const json = JSON.parse(JSON.stringify(r.next.archive));
  expect(inspectComparisonReservationState({ ...r.next, archive: json }).cancellations).toEqual([
    c,
  ]);
});
it("rejects a changed cancel command under its original nonce", () => {
  const c = cancellation(),
    r = planComparisonCancellation(reserved.next, c, cancelIds());
  if (r.status !== "prepared-not-committed") throw Error();
  expect(() =>
    planComparisonCancellation(r.next, { ...c, expectedBindingDigest: "f".repeat(64) }),
  ).toThrow();
});
it("preserves cancelled history and cumulative costs across a subsequent reservation", () => {
  const r = planComparisonCancellation(reserved.next, cancellation(), cancelIds());
  if (r.status !== "prepared-not-committed") throw Error();
  const review2 = createComparisonReservationReview(r.next, company, request.command, evidence, at);
  const c = {
    ...reserveCommand(),
    approvedReviewDigest: review2.reviewDigest,
    expectedArchiveDigest: review2.archiveDigest,
    expectedBudgetHead: {
      revision: review2.budget.revision,
      headDigest: review2.budget.headDigest,
    },
    expectedGlobalRunCount: review2.globalRunCount,
  };
  const next = planComparisonReservation(r.next, c, { ...current(), approvedReview: review2 });
  if (next.status !== "prepared-not-committed") throw Error();
  expect(next.next.archive.records.runs).toHaveLength(2);
  expect(next.next.archive.financial.events.slice(0, 2)).toEqual(r.next.archive.financial.events);
  expect(inspectComparisonReservationState(next.next).view.native.recognizedUnits).toBe(
    review.budget.recognizedUnits,
  );
});
it.each([
  [
    "missing omission",
    (e: ComparisonFinancialEvidence) => {
      delete (e.omissions as Partial<typeof e.omissions>).stream;
    },
  ],
  [
    "tier default",
    (e: ComparisonFinancialEvidence) => {
      Object.assign(e, { requestedTier: "default" });
    },
  ],
  [
    "two calls",
    (e: ComparisonFinancialEvidence) => {
      Object.assign(e, { maxCalls: 2 });
    },
  ],
  [
    "other model",
    (e: ComparisonFinancialEvidence) => {
      e.model = "alias";
    },
  ],
  [
    "other contract",
    (e: ComparisonFinancialEvidence) => {
      e.contractDigest = "a".repeat(64);
    },
  ],
  [
    "source hash",
    (e: ComparisonFinancialEvidence) => {
      e.sources[0].excerpt += " changed";
    },
  ],
  [
    "source record hash",
    (e: ComparisonFinancialEvidence) => {
      e.sources[0].recordDigest = "a".repeat(64);
    },
  ],
  [
    "source duplicate",
    (e: ComparisonFinancialEvidence) => {
      e.sources.push(e.sources[0]);
    },
  ],
  [
    "unbound reference",
    (e: ComparisonFinancialEvidence) => {
      e.omissions.stream.sourceIds = ["missing"];
    },
  ],
  [
    "duplicate reference",
    (e: ComparisonFinancialEvidence) => {
      e.pricing.sourceIds.push(e.pricing.sourceIds[0]);
    },
  ],
  [
    "expired",
    (e: ComparisonFinancialEvidence) => {
      e.sources[0].validUntil = at;
      const { recordDigest: _, ...b } = e.sources[0];
      void _;
      e.sources[0].recordDigest = digest(b);
    },
  ],
  [
    "future review",
    (e: ComparisonFinancialEvidence) => {
      e.sources[0].reviewedAt = "2026-10-06T10:00:00.000Z";
      const { recordDigest: _, ...b } = e.sources[0];
      void _;
      e.sources[0].recordDigest = digest(b);
    },
  ],
  [
    "synthetic production",
    (e: ComparisonFinancialEvidence) => {
      e.provenance = "synthetic-test";
    },
  ],
  [
    "context too small",
    (e: ComparisonFinancialEvidence) => {
      e.context.contextWindowTokens = 15999;
    },
  ],
  [
    "output too small",
    (e: ComparisonFinancialEvidence) => {
      e.context.maxOutputTokens = 15000;
    },
  ],
  [
    "zero money",
    (e: ComparisonFinancialEvidence) => {
      e.pricing.shortContext.uncachedInput.units = "0";
      e.pricing.shortContext.cacheReadInput = { kind: "rate", rate: { units: "0", perTokens: 1 } };
      e.pricing.shortContext.outputIncludingReasoning.units = "0";
    },
  ],
  [
    "extra authority",
    (e: ComparisonFinancialEvidence) => {
      Object.assign(e, { approvalVerified: true });
    },
  ],
] as const)("rejects financial %s", (label, change) => {
  const e = structuredClone(evidence);
  change(e);
  expect(() =>
    createComparisonFinancialBasis(e, request.identity, request.command.model, "production", at),
  ).toThrow();
});
it("ceil-rounds maximum all-in rates over both bands for only one request", () => {
  const e = structuredClone(evidence);
  e.pricing.longContext = {
    uncachedInput: { units: "1", perTokens: 3 },
    cacheReadInput: { kind: "rate", rate: { units: "1", perTokens: 7 } },
    cacheWriteInput: { kind: "rate", rate: { units: "2", perTokens: 5 } },
    outputIncludingReasoning: { units: "1", perTokens: 3 },
  };
  const b = createComparisonFinancialBasis(e, request.identity, e.model, "production", at);
  expect(b.costs.maximumInputRate.selectedFrom).toBe("longContext.cacheWriteInput");
  expect(b.costs.inputUnits).toBe("40000");
  expect(b.costs.outputUnits).toBe("5334");
  expect(b.costs.reservedUnits).toBe("45334");
});
it("limits review expiry to source expiry without mutating the original source", () => {
  const e = structuredClone(evidence);
  e.sources[0].validUntil = "2026-10-05T10:03:00.000Z";
  const { recordDigest: _, ...body } = e.sources[0];
  void _;
  e.sources[0].recordDigest = digest(body);
  const r = createComparisonReservationReview(state, company, request.command, e, at);
  expect(r.expiresAt).toBe(e.sources[0].validUntil);
  expect(evidence.sources[0].validUntil).toBe("2026-10-05T12:00:00.000Z");
});
it.each([
  [
    "company revision",
    (c: ReturnType<typeof current>) => {
      c.company.revision++;
    },
  ],
  [
    "same-time selected source",
    (c: ReturnType<typeof current>) => {
      c.company.sources[0].text += " changed";
    },
  ],
  [
    "review digest",
    (c: ReturnType<typeof current>) => {
      c.approvedReview.reviewDigest = "f".repeat(64);
    },
  ],
  [
    "server evidence",
    (c: ReturnType<typeof current>) => {
      c.evidence.retention.localNotice += " changed";
    },
  ],
  [
    "expired approval",
    (c: ReturnType<typeof current>) => {
      c.at = review.expiresAt;
    },
  ],
  [
    "before approval",
    (c: ReturnType<typeof current>) => {
      c.at = "2026-10-05T09:59:59.000Z";
    },
  ],
] as const)("rejects changed current %s", (label, change) => {
  const cur = current();
  change(cur);
  expect(() => planComparisonReservation(state, reserveCommand(), cur)).toThrow();
});
it.each([
  [
    "budget head",
    (c: ReturnType<typeof reserveCommand>) => {
      c.expectedBudgetHead.revision++;
    },
  ],
  [
    "archive head",
    (c: ReturnType<typeof reserveCommand>) => {
      c.expectedArchiveDigest = "f".repeat(64);
    },
  ],
  [
    "run count",
    (c: ReturnType<typeof reserveCommand>) => {
      c.expectedGlobalRunCount++;
    },
  ],
  [
    "company id",
    (c: ReturnType<typeof reserveCommand>) => {
      c.companyId = randomUUID();
    },
  ],
  [
    "notice",
    (c: ReturnType<typeof reserveCommand>) => {
      c.approval.noticeDigest = "f".repeat(64);
    },
  ],
  [
    "retention notice",
    (c: ReturnType<typeof reserveCommand>) => {
      c.approval.retentionNoticeDigest = "f".repeat(64);
    },
  ],
  [
    "false approval",
    (c: ReturnType<typeof reserveCommand>) => {
      Object.assign(c.approval, { comparisonPurposeAcknowledged: false });
    },
  ],
  [
    "transmission grant",
    (c: ReturnType<typeof reserveCommand>) => {
      Object.assign(c.approval, { transmission: "approved" });
    },
  ],
] as const)("rejects new reservation %s", (label, change) => {
  const c = reserveCommand();
  change(c);
  expect(() => planComparisonReservation(state, c, current())).toThrow();
});
it("blocks a second reserve while original cost/storage remains held", () => {
  expect(() =>
    createComparisonReservationReview(reserved.next, company, request.command, evidence, at),
  ).toThrow();
});
it("rejects legacy nonces before inspecting supplied current input", () => {
  const nonce = state.prefix.rows.actualRows.receipts[0].nonce;
  expect(() =>
    planComparisonReservation(state, { ...reserveCommand(), clientRequestId: nonce }),
  ).toThrow();
});
it("rejects internal cancellation nonce reuse", () => {
  expect(() =>
    planComparisonCancellation(reserved.next, cancellation(), {
      ...cancelIds(),
      finalizationNonce: command.clientRequestId,
    }),
  ).toThrow();
});
it("rejects duplicate planned IDs", () => {
  const cur = current();
  cur.budgetEventId = cur.runId;
  expect(() => planComparisonReservation(state, reserveCommand(), cur)).toThrow();
});
it("requires bound native records and never retrofits old supplied runs", () => {
  expect(() => inspectComparisonReservationState({ ...reserved.next, bindings: [] })).toThrow(
    "BINDING_REQUIRED",
  );
});
it("rejects a rehashed binding that changes the reviewed amount", () => {
  const s = structuredClone(reserved.next),
    b = s.bindings[0];
  const r = b.approvedReview as typeof review;
  r.financialBasis.costs.reservedUnits = "1";
  const { recordDigest: _, ...body } = b;
  void _;
  b.recordDigest = digest(body);
  expect(() => inspectComparisonReservationState(s)).toThrow();
});
it("rejects partial cancellation even if the old native/financial structure is valid", () => {
  const r = planComparisonCancellation(reserved.next, cancellation(), cancelIds());
  if (r.status !== "prepared-not-committed") throw Error();
  const s = structuredClone(r.next);
  s.archive.records.events.pop();
  s.archive.records.receipts.pop();
  s.archive.records.artifacts = s.archive.records.artifacts.filter((x) => x.key !== "final-result");
  expect(
    inspectPublicComparisonNativeArchive(s.prefix, s.coverage, s.archive).runs[0].costSettled,
  ).toBe(true);
  expect(() => inspectComparisonReservationState(s)).toThrow("PARTIAL_CANCELLATION");
});
it.each(["dispatch-recorded", "dispatch-unknown"] as const)("does not release %s funds", (kind) => {
  const s = structuredClone(reserved.next),
    run = s.archive.records.runs[0],
    b = s.bindings[0];
  const d = createPublicComparisonNativeEvent({
    schemaVersion: 3,
    purpose: "compare-public-claim",
    runId: run.id,
    eventId: randomUUID(),
    revision: 2,
    previousDigest: b.reservedEventDigest,
    recordedAt: at,
    payload: {
      kind: "dispatch-recorded",
      reservationDigest: b.budgetEventDigest,
      requestDigest: run.identity.requestDigest,
      manifestDigest: run.manifestDigest,
    },
  });
  function add(e: typeof d) {
    s.archive.records.events.push(e);
    s.archive.records.receipts.push({
      schemaVersion: 3,
      purpose: "compare-public-claim",
      runId: run.id,
      clientRequestId: randomUUID(),
      inputDigest: publicComparisonNativeInputDigest(e),
      eventRevision: e.revision,
      operationDigest: e.eventDigest,
      budgetOperationDigest: null,
      recordedAt: at,
    });
  }
  add(d);
  if (kind === "dispatch-unknown")
    add(
      createPublicComparisonNativeEvent({
        schemaVersion: 3,
        purpose: "compare-public-claim",
        runId: run.id,
        eventId: randomUUID(),
        revision: 3,
        previousDigest: d.eventDigest,
        recordedAt: at,
        payload: {
          kind: "dispatch-unknown",
          dispatchEventDigest: d.eventDigest,
          reason: "restart-unknown",
        },
      }),
    );
  expect(() => planComparisonCancellation(s, cancellation(s), cancelIds())).toThrow(
    "NOT_CANCELLABLE",
  );
});
it("enforces actual extra storage and untruncated binding limits", () => {
  expect(() =>
    createComparisonReservationReview(
      { ...state, additionalUsedBytes: 256 * 1024 * 1024 },
      company,
      request.command,
      evidence,
      at,
    ),
  ).toThrow();
  const e = structuredClone(evidence);
  e.retention.localNotice = "한".repeat(10000);
  e.retention.providerNotice = "글".repeat(10000);
  expect(() => createComparisonReservationReview(state, company, request.command, e, at)).toThrow();
});
it("does not invoke getter/toJSON hooks or accept cyclic command input", () => {
  const hook = vi.fn(() => {
    throw Error("secret");
  });
  const c = Object.defineProperty({}, "kind", { enumerable: true, get: hook });
  expect(() => planComparisonReservation(state, c)).toThrow();
  expect(hook).not.toHaveBeenCalled();
  expect(() => planComparisonReservation(state, { ...command, toJSON: hook })).toThrow();
  expect(hook).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => planComparisonReservation(state, cycle)).toThrow();
});
it("returns detached copies and cannot mutate later archive audits", () => {
  const x = inspectComparisonReservationState(reserved.next);
  x.state.bindings[0].command.approval.noticeDigest = "f".repeat(64);
  expect(inspectComparisonReservationState(reserved.next).state.bindings[0]).toEqual(
    reserved.rows.binding,
  );
});

it("rejects financial identity accessors before reading them", () => {
  const read = vi.fn(() => request.identity.requestDigest);
  const x = Object.defineProperty({}, "requestDigest", { get: read, enumerable: true });
  expect(() =>
    createComparisonFinancialBasis(evidence, x, request.command.model, "production", at),
  ).toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("accepts synthetic-labelled arithmetic only as supplied evidence in a synthetic scope", () => {
  const e = { ...structuredClone(evidence), provenance: "synthetic-test" as const };
  const f = createComparisonFinancialBasis(e, request.identity, e.model, "synthetic-test", at);
  expect(f.costs.reservedUnits).toBe("2");
  expect(Object.values(f.authority).every((v) => v === false)).toBe(true);
});
it.each(["expectedBudgetHead", "expectedRunHead"] as const)(
  "rejects stale cancellation %s",
  (field) => {
    const c = cancellation();
    c[field].revision++;
    expect(() => planComparisonCancellation(reserved.next, c, cancelIds())).toThrow();
  },
);
it("rejects an arbitrary amount or endpoint in the original command", () => {
  expect(() =>
    planComparisonReservation(state, { ...command, reservedUnits: "1" }, current()),
  ).toThrow();
  expect(() =>
    planComparisonReservation(state, { ...command, endpoint: "https://other.invalid" }, current()),
  ).toThrow();
});
it("rejects reservation beyond the same scope remaining cap", () => {
  const e = structuredClone(evidence);
  e.pricing.shortContext.uncachedInput = { units: "999999999999999999999999", perTokens: 1 };
  expect(() => createComparisonReservationReview(state, company, request.command, e, at)).toThrow(
    "RESERVATION_UNAVAILABLE",
  );
});
it("rejects same original nonce used for the other purpose operation", () => {
  expect(() =>
    planComparisonCancellation(reserved.next, {
      ...cancellation(),
      clientRequestId: command.clientRequestId,
    }),
  ).toThrow();
});
it("does not grant storage capacity from a modified supplied accounting input", () => {
  expect(() =>
    inspectComparisonReservationState({ ...reserved.next, additionalUsedBytes: -1 }),
  ).toThrow();
  expect(() =>
    inspectComparisonReservationState({ ...reserved.next, additionalUsedBytes: 256 * 1024 * 1024 }),
  ).toThrow();
});
