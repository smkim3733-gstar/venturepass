// Synthetic comparison-to-editor fixture only. No product imports this file.
import { randomUUID } from "node:crypto";
import { comparisonReviewTestFixture } from "../../src/lib/studio-public-claim-comparison-review-test-helpers";
export function comparisonPlanReferenceFixture() {
  const f = comparisonReviewTestFixture(),
    company = f.company,
    result = f.value();
  company.profile.companyName = "합성 비교 의견 보완 기업";
  const newest = structuredClone(company.plans[0]);
  newest.id = randomUUID();
  newest.version++;
  newest.content.title = "합성 최신 원고";
  newest.content.sections[0].content = "최신 원고의 다른 문장. 자동으로 선택하면 안 됩니다.";
  company.plans.push(newest);
  result.source = "comparison-stored-review";
  result.current = {
    status: "exact-original-request",
    originalRevision: company.revision,
    observedRevision: company.revision,
    reason: null,
  };
  result.historical.result.comparison!.comparison.overall.reason =
    "합성 검토 의견: 기간과 회사 적용 범위를 직접 확인하세요.";
  return { company, result, query: f.query };
}
