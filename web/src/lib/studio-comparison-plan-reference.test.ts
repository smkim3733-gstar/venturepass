import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
import { comparisonPlanReferenceFixture } from "../../scripts/fixtures/comparison-plan-reference";
import {
  comparisonPlanTarget,
  resolveComparisonPlanReference,
} from "./studio-comparison-plan-reference";
it("opens the exact original plan with a separate opinion copy and never rewrites company data", async () => {
  const { company, result } = comparisonPlanReferenceFixture(),
    before = structuredClone(company);
  const selected = await resolveComparisonPlanReference(company, result);
  expect(selected?.plan).toBe(company.plans[0]);
  expect(selected?.section.key).toBe("market");
  expect(selected?.plan.id).not.toBe(company.plans.at(-1)!.id);
  expect(selected?.result).toEqual(result);
  expect(selected?.result).not.toBe(result);
  expect(company).toEqual(before);
});
it.each([
  "historical",
  "changed",
  "unavailable",
  "synthetic",
  "no-opinion",
  "no-comparison",
  "observed-revision",
  "original-revision",
  "company",
  "selection-revision",
  "missing-claim",
  "duplicate-claim",
  "claim-version",
  "claim-digest",
  "claim-root",
  "claim-plan",
  "missing-plan",
  "duplicate-plan",
  "plan-version",
  "missing-section",
  "duplicate-section",
  "section-content",
  "section-title",
  "quote",
  "plan-hash",
  "record-hash",
  "record-content",
  "other-section",
  "source-content",
  "source-time",
  "missing-source",
  "duplicate-source",
])("rejects %s without choosing a replacement", async (kind) => {
  const { company, result } = comparisonPlanReferenceFixture();
  if (kind === "historical") result.current.status = "not-checked";
  if (kind === "changed") result.current.status = "changed";
  if (kind === "unavailable") result.current.status = "unavailable";
  if (kind === "synthetic") result.source = "synthetic-comparison-stored-review";
  if (kind === "no-opinion") result.historical.result.state = "comparison-rejected";
  if (kind === "no-comparison") result.historical.result.comparison = null;
  if (kind === "observed-revision") result.current.observedRevision!++;
  if (kind === "original-revision") result.current.originalRevision++;
  if (kind === "company") company.id = company.plans[0].id;
  if (kind === "selection-revision") result.resultIdentity.selection.companyRevision++;
  if (kind === "missing-claim") company.claimReviews = [];
  if (kind === "duplicate-claim")
    company.claimReviews.push(structuredClone(company.claimReviews[0]));
  if (kind === "claim-version") company.claimReviews[0].version++;
  if (kind === "claim-digest") company.claimReviews[0].inputDigest = "b".repeat(64);
  if (kind === "claim-root") company.claimReviews[0].claimId = company.id;
  if (kind === "claim-plan") company.claimReviews[0].planId = company.plans[1].id;
  if (kind === "missing-plan") company.plans.shift();
  if (kind === "duplicate-plan") company.plans.push(structuredClone(company.plans[0]));
  if (kind === "plan-version") company.plans[0].version++;
  if (kind === "missing-section") company.plans[0].content.sections.shift();
  if (kind === "duplicate-section")
    company.plans[0].content.sections.push(structuredClone(company.plans[0].content.sections[0]));
  if (kind === "section-content") company.plans[0].content.sections[0].content += " changed";
  if (kind === "section-title") company.plans[0].content.sections[0].title += " changed";
  if (kind === "quote") company.claimReviews[0].claimQuote = "different";
  if (kind === "plan-hash") result.resultIdentity.binding.planContentSha256 = "b".repeat(64);
  if (kind === "record-hash") result.resultIdentity.binding.claimRecordSha256 = "b".repeat(64);
  if (kind === "record-content") company.claimReviews[0].owner = "different owner";
  if (kind === "other-section") company.plans[0].content.sections[1].content += " changed";
  if (kind === "source-content") company.sources[0].text += " changed";
  if (kind === "source-time") company.sources[0].updatedAt = "2026-10-14T00:00:00.000Z";
  if (kind === "missing-source") company.sources = [];
  if (kind === "duplicate-source") company.sources.push(structuredClone(company.sources[0]));
  const before = structuredClone(company);
  expect(await resolveComparisonPlanReference(company, result)).toBeNull();
  expect(company).toEqual(before);
});
it("no displayed result offers no navigation target", () => {
  const { company } = comparisonPlanReferenceFixture();
  expect(comparisonPlanTarget(company, null)).toBeNull();
});
