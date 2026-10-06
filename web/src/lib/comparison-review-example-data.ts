import "server-only";
import example from "./fixtures/comparison-review-example.json";
import { copyComparisonReviewQuery, decodeComparisonReviewWire } from "./studio-public-claim-comparison-review-wire";

// Committed synthetic fixture, generated with the SDK-free schema fixture.
// Database/authority fields describe a simulated record, never an observed database.
const query = copyComparisonReviewQuery(example.query);
const result = decodeComparisonReviewWire(JSON.stringify(example), 200, query);
export function comparisonReviewExampleData() {
  const value = structuredClone(result), identity = value.resultIdentity;
  return {
    query: { ...query }, result: value,
    frame: { snapshot: { id: identity.selection.companyId, revision: identity.selection.companyRevision },
      expected: { ...query, selection: identity.selection, binding: identity.binding,
        sectionKey: value.historical.prepared.input.section.key },
      open: true, dirty: false, blocked: false, aborted: false },
  };
}
