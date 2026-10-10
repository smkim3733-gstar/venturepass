// Synthetic state only. No original-file reads, writer, provider or network.
import { createHash, randomUUID } from "node:crypto";
import { caseSchema, emptyProfile } from "../../src/lib/studio-schema";
import { buildClaimReview, claimReviewInputDigest } from "../../src/lib/studio-claim-review";
import type { ClaimReviewInput } from "../../src/lib/studio-claim-review-types";
import { emptyPublicEvidence, preparePublicEvidence } from "../../src/lib/studio-public-evidence";
import type { PublicClaimComparisonSelection } from "../../src/lib/studio-public-claim-comparison";
const now = "2026-10-05T10:00:00.000Z";
export function previewCompanyFixture(
  count = 1,
  excerpt = "  2023년 산업 표본: 0, 1,200.50 및 - 수치.\r\n회사 적용은 미확인.  ",
) {
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 미리보기 선택 보존 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
    revision: 7,
    createdAt: now,
    updatedAt: now,
    plans: [
      {
        id: randomUUID(),
        version: 3,
        mode: "manual",
        candidateId: "synthetic",
        generatedAt: now,
        sourceRevision: 1,
        confirmedAt: now,
        content: {
          title: "합성 비교 대상 원고",
          summary: "PRIVATE_SUMMARY",
          sections: [
            {
              key: "market",
              title: "시장",
              content: "  2023년 산업 표본 수치가 있다. 우리 회사 적용 여부는 확인하지 않았다.  ",
              evidence: [],
              needsConfirmation: true,
            },
            {
              key: "technology",
              title: "PRIVATE_SECTION_TITLE",
              content: "PRIVATE_SECTION",
              evidence: [],
              needsConfirmation: false,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
        review: [],
      },
    ],
  });
  const input: ClaimReviewInput = {
    claimId: null,
    previousVersionId: null,
    planId: company.plans[0].id,
    planVersion: 3,
    sectionKey: "market",
    claimQuote: "2023년 산업 표본 수치가 있다.",
    nature: "current-claim",
    references: [],
    contextNote: "PRIVATE_CONTEXT_NOTE",
    owner: "PRIVATE_OWNER",
    dueOn: "",
    nextCheck: "",
    method: "unreviewed",
    externalCheck: { target: "", content: "", occurredOn: "" },
    judgement: { state: "unreviewed", reviewer: "", reason: "", checkedOn: "" },
    numericReferences: [],
    planReviewReferences: [],
  };
  for (let n = 0; n < count; n++) {
    const source = preparePublicEvidence(
      company,
      {
        ...emptyPublicEvidence,
        title: "합성 보고서 " + n,
        url: "https://example.invalid/report/" + n,
        publisher: "",
        publishedOn: "",
        period: "2023년 산업 표본",
        readOn: "2026-10-05",
        quote: excerpt,
        relevance: "담당자 가정",
        conflicts: "조회 날짜가 발행일은 아님",
      },
      randomUUID(),
      now,
      true,
    ).command.source;
    company.sources.push(source);
    input.references.push({
      sourceId: source.id,
      sourceUpdatedAt: now,
      quote: excerpt.slice(0, 30),
      locator: "공개 발췌",
    });
  }
  const reader = (id: string) => {
    const source = company.sources.find((s) => s.id === id)!;
    const buffer = Buffer.from("synthetic original");
    return { source, buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
  };
  const build = (value = input) =>
    buildClaimReview(
      company,
      value,
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: claimReviewInputDigest(value),
        recordedAt: now,
      },
      reader,
    );
  const capture = () => {
    company.claimReviews = [];
    company.claimReviews.push(build());
  };
  capture();
  const select = (index = 0): PublicClaimComparisonSelection => {
    const record = company.claimReviews[index];
    return {
      companyId: company.id,
      companyRevision: company.revision,
      claimRecordId: record.id,
      claimVersion: record.version,
      claimInputDigest: record.inputDigest,
      sourceIds: record.references.map((r) => r.sourceId),
    };
  };
  return { company, input, reader, build, capture, select };
}

export const model = "synthetic-disabled";
