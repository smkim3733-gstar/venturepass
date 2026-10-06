// Node fixture only. Never imported by the application or browser entry.
import {
  exampleWireSha256, validateComparisonExampleArtifact, type ComparisonExampleProvenance,
} from "./comparison-review-example-artifact";
import {
  comparisonReviewSuccessWire, copyComparisonReviewQuery, type ComparisonReviewQuery,
} from "./studio-public-claim-comparison-review-wire";

export function exportComparisonExample(input: {
  query: ComparisonReviewQuery;
  read: (query: ComparisonReviewQuery) => unknown;
  cleanup: () => void;
}) {
  // A failed read/audit/wire or cleanup cannot return a publishable candidate.
  // The caller retains the original service/session on failure; no replacement.
  try {
    const query = copyComparisonReviewQuery(input.query);
    const wire = JSON.parse(comparisonReviewSuccessWire(query, input.read(query)));
    const identity = wire.result.resultIdentity;
    const provenance: ComparisonExampleProvenance = {
      kind: "synthetic-sql13-export", version: 1, sqlVersion: 13, witnessVersion: 3,
      runId: identity.runId, dispatchCommandDigest: identity.dispatchCommandDigest,
      comparisonEventDigest: identity.comparisonEventDigest,
      responseArtifactSha256: identity.responseArtifactSha256,
      validatedArtifactSha256: identity.validatedArtifactSha256,
      wireSha256: exampleWireSha256(JSON.stringify(wire)),
    };
    validateComparisonExampleArtifact(wire, provenance);
    return { wire, provenance };
  } finally {
    input.cleanup();
  }
}
