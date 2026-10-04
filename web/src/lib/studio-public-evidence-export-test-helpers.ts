import { randomUUID } from "node:crypto";
import { caseSchema, emptyProfile } from "./studio-schema";
import {
  emptyPublicEvidence,
  publicEvidenceText,
  type PublicEvidenceDraft,
} from "./studio-public-evidence";
export function publicEvidenceExportFixture() {
  const draft: PublicEvidenceDraft = {
    ...emptyPublicEvidence,
    title: "합성 산업 통계 자료",
    url: "https://example.invalid/report?year=2023&group=industry",
    publisher: "합성 발행기관",
    publishedOn: "2024-03-02",
    period: "2023년 국내 산업 전체",
    readOn: "2026-10-05",
    sectionKey: "market",
    quote: "  2023년 합성 산업의 표본 수는 120개입니다.\r\n단위는 개입니다.  ",
    relevance: "공개 산업의 범위를 설명하는 참고 자료입니다. 회사의 매출 증거는 아닙니다.",
    conflicts: "다른 자료는 2024년 기준입니다. 두 자료의 대상과 기간을 먼저 비교해야 합니다.",
  };
  const sourceId = randomUUID();
  const record = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 출처 확인 시험 회사" },
    revision: 5,
    sources: [
      {
        id: sourceId,
        name: `[공개 근거 후보] ${draft.title}`,
        text: publicEvidenceText(draft),
        kind: "market",
        extraction: "manual",
        originalName: null,
        mimeType: null,
        warnings: [],
        createdAt: "2026-10-04T00:00:00Z",
        updatedAt: "2026-10-05T00:00:00Z",
      },
    ],
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: "2026-10-04T01:00:00Z",
        mode: "manual",
        candidateId: "synthetic-topic",
        sourceRevision: 2,
        confirmedAt: "2026-10-04T02:00:00Z",
        content: {
          title: "산업 근거와 사업 추진 계획",
          summary:
            "현재 자료를 바탕으로 작성한 합성 초안입니다. 회사 실적은 담당자가 별도로 확인합니다.",
          sections: [
            {
              key: "market",
              title: "목표 시장",
              content:
                "공개 통계의 대상과 기준 기간을 확인한 뒤 시장 범위를 설명합니다. 회사 매출은 별도 자료로 확인할 계획입니다.",
              needsConfirmation: true,
              evidence: [
                {
                  sourceId,
                  quote: "2023년 합성 산업의 표본 수는 120개입니다.",
                  locator: "보관 발췌 첫 문장",
                },
              ],
            },
            {
              key: "solution",
              title: "기술 개발 계획",
              content: "직접 작성한 기술 설명을 보존합니다.",
              needsConfirmation: false,
              evidence: [],
            },
          ],
          actionItems: ["통계의 대상·단위와 회사 해당 여부를 확인합니다."],
          interviewQuestions: ["공개 자료와 회사 실적의 기준 기간은 같습니까?"],
        },
        review: [],
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
  });
  return { record, plan: record.plans[0], draft, source: record.sources[0] };
}
