import { randomUUID } from "node:crypto";
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import {
  comparisonFinancialEvidenceSchema,
  comparisonSha as sha,
} from "./studio-public-claim-comparison-financial";
import {
  createComparisonReservationReview,
  comparisonReserveCommandSchema,
  type ComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";

/** Supplied synthetic evidence only, including the production-shaped provenance label. */
export function comparisonReservationTestFixture(
  state: ComparisonReservationState,
  at = "2026-10-05T10:00:00.000Z",
) {
  const f = publicClaimComparisonFixture(2);
  const company = f.company;
  const selection = f.select();
  selection.sourceIds = selection.sourceIds.slice(0, 1);
  const request = buildPublicClaimComparisonRequest(company, {
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
  const evidence = comparisonFinancialEvidenceSchema.parse({
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
  const review = createComparisonReservationReview(state, company, request.command, evidence, at);
  const command = comparisonReserveCommandSchema.parse({
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
  return { at, company, request, evidence, review, command };
}
