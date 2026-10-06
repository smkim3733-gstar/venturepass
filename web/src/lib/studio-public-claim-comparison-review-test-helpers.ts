import { randomUUID } from "node:crypto";
import { publicClaimComparisonFixture } from "./studio-public-claim-comparison-test-helpers";
import { preparePublicClaimComparison, validatePreparedPublicClaimComparison } from "./studio-public-claim-comparison";
import { buildPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import { publicClaimComparisonRequestAuthority, publicClaimComparisonRequestVersion } from "./studio-public-claim-comparison-request-types";
import { comparisonPlanAuthority } from "./studio-public-claim-comparison-types";
import type { ComparisonReviewWireResult, ComparisonReviewQuery } from "./studio-public-claim-comparison-review-wire";

/** Test-only original comparison wire fixture. Callers retain the SDK-free format mocks. */
export function comparisonReviewTestFixture(count = 1) {
  const h = "a".repeat(64);
  const fixture = publicClaimComparisonFixture(count);
  const prepared = preparePublicClaimComparison(fixture.company, fixture.select());
  const request = buildPublicClaimComparisonRequest(fixture.company, {
    requestVersion: publicClaimComparisonRequestVersion, model: "synthetic", selection: fixture.select(),
  });
  const query: ComparisonReviewQuery = { runId: randomUUID(), dispatchCommandDigest: h, mode: "historical" };
  function value(): ComparisonReviewWireResult {
    const comparison = validatePreparedPublicClaimComparison(prepared, {
      preparationDigest: prepared.preparationDigest, claimQuote: prepared.input.claimQuote,
      overall: { relation: "undetermined", reason: "合成 의견" },
      evidence: prepared.input.selectedEvidence.map((e) => ({ sourceId: e.sourceId, relation: "undetermined",
        quotes: [e.originalReference.quote], reason: "합성 자료 대조", nextCheck: "" })), checks: [],
    });
    return {
      source: "synthetic-comparison-stored-review",
      resultIdentity: { runId: query.runId, dispatchCommandDigest: h, comparisonEventDigest: h,
        responseArtifactSha256: h, validatedArtifactSha256: h, requestIdentity: request.identity,
        preparationDigest: prepared.preparationDigest, selection: prepared.selection, binding: prepared.binding },
      historical: { prepared: structuredClone(prepared), result: {
        source: "supplied-response", evidenceOrigin: "manual-unverified", ...publicClaimComparisonRequestAuthority,
        currentContextVerified: false, requestIdentity: request.identity, responseArtifactSha256: h,
        state: "comparison-ready", comparison,
      }, currentContextVerified: false },
      database: { comparisonRecorded: true, costSettled: false, finalized: false, currentContextVerified: false,
        runHeldBytes: 1234, scopeHeldUnits: "123456789012345678901234567890", scopeRecognizedUnits: "0" },
      current: { status: "not-checked", originalRevision: 7, observedRevision: null, reason: null },
      owner: null, runtimeObserved: false, authority: { ...comparisonPlanAuthority },
    };
  }
  return { prepared, request, query, value };
}
