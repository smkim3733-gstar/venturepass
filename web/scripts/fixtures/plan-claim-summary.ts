import { manualId, manualSourceFixture } from "./manual-source-receipt";
import { caseSchema } from "../../src/lib/studio-schema";
import {
  claimReviewRecordSchema,
  type ClaimReviewRecord,
} from "../../src/lib/studio-claim-review-types";

export function planClaimSummaryFixture() {
  const company = manualSourceFixture().company;
  company.profile.companyName = "합성 원고 주장 검토 기업";
  const plan = company.plans.at(-1)!;
  const source = company.sources.find((item) => item.extraction === "manual")!;
  const now = source.updatedAt;
  const states = ["consistent", "conflict", "insufficient", "unreviewed", "consistent"] as const;
  const quotes = states.map(
    (_, index) => `합성 주장 ${index + 1}: 연간 공급 계획을 담당자가 확인합니다.`,
  );
  plan.content.sections[0].content = quotes.join("\n");
  source.text = quotes.join("\n");
  const make = (index: number): ClaimReviewRecord =>
    claimReviewRecordSchema.parse({
      id: manualId(100 + index),
      claimId: manualId(100 + index),
      version: 1,
      previousVersionId: null,
      clientRequestId: manualId(200 + index),
      inputDigest: "a".repeat(64),
      origin: "manual",
      recordedAt: now,
      planId: plan.id,
      planVersion: plan.version,
      sectionKey: plan.content.sections[0].key,
      claimQuote: quotes[index],
      nature: "future-plan",
      references: [
        {
          sourceId: source.id,
          sourceUpdatedAt: index === 4 ? "2026-01-01T00:00:00.000Z" : now,
          quote: quotes[index],
          locator: "합성 자료 1쪽",
        },
      ],
      contextNote: "합성 시험 전용",
      owner: "합성 확인 담당자",
      dueOn: "2026-11-01",
      nextCheck: "현재 증빙을 확인한 뒤 직접 판단",
      method: "document",
      externalCheck: { target: "", content: "", occurredOn: "" },
      judgement: {
        state: states[index],
        reviewer: "합성 판단자",
        reason: "합성 기록의 이유",
        checkedOn: "2026-10-11",
        recordedAt: now,
      },
      numericReferences: [],
      planReviewReferences: [],
      auxiliarySnapshots: [],
      sourceSnapshots: [
        {
          sourceId: source.id,
          sourceName: source.name,
          sourceUpdatedAt: now,
          extraction: source.extraction,
          textSha256: "b".repeat(64),
          original: null,
        },
      ],
      planSnapshots: [{ planId: plan.id, version: plan.version, contentSha256: "c".repeat(64) }],
    });
  company.claimReviews = states.map((_, index) => make(index));
  return caseSchema.parse(company);
}
