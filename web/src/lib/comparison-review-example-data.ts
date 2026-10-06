import "server-only";
import example from "./fixtures/comparison-review-example.json";
import provenance from "./fixtures/comparison-review-example-provenance.json";
import { validateComparisonExampleArtifact } from "./comparison-review-example-artifact";

// Audited synthetic SQL13 export at one point in time; no runtime database access.
// The manifest checks committed bytes/identity, not operational provenance or authority.
const { query, result } = validateComparisonExampleArtifact(example, provenance);
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
