import { comparisonReviewExampleData } from "@/lib/comparison-review-example-data";
import { ComparisonReviewExample } from "@/components/studio/comparison-review-example";

export default function ReviewExamplePage() {
  const { frame, result } = comparisonReviewExampleData();
  const input = result.historical.prepared.input;
  return <ComparisonReviewExample frame={frame} claim={input.claimQuote}
    sources={input.selectedEvidence.map((e) => ({ id: e.sourceId, title: e.metadata.title, excerpt: e.excerpt }))} />;
}
