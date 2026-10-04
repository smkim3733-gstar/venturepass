import { randomUUID } from "node:crypto";
import { caseSchema, emptyProfile, sectionDefinitions } from "./studio-schema";
import { answerSuggestionSha as sha } from "./studio-answer-suggestion";
import {
  preparePlanSupplement,
  comparePlanSupplement,
  type PlanSupplementInput,
  type PlanSupplementDraft,
} from "./studio-plan-supplement";
const now = "2026-10-04T14:56:19.000Z";
export function supplementFixture() {
  const sourceId = randomUUID(),
    baseId = randomUUID();
  const value = caseSchema.parse({
    id: randomUUID(),
    profile: {
      ...emptyProfile(),
      companyName: "합성 회사",
      businessNumber: "PRIVATE_NUMBER",
      financials: "PRIVATE_PROFILE",
    },
    sources: Array.from({ length: 100 }, (_, i) => ({
      id: i === 0 ? sourceId : randomUUID(),
      name: i === 0 ? "담당자 보완 답변" : `EXCLUDED_NAME_${i}`,
      text:
        i === 0
          ? "담당자 진술입니다.\n작은 범위의 내부 시험만 했습니다.\n외부 시험은 계획 중입니다."
          : `EXCLUDED_TEXT_${i}`,
      kind: "consultation",
      extraction: "manual",
      warnings: [],
      originalName: null,
      mimeType: null,
      createdAt: now,
      updatedAt: now,
    })),
    analysis: null,
    selectedCandidateId: null,
    plans: [
      {
        id: baseId,
        version: 2,
        generatedAt: now,
        mode: "manual",
        candidateId: "stored-topic",
        sourceRevision: 1,
        content: {
          title: "PRIVATE_TITLE",
          summary: "PRIVATE_SUMMARY",
          actionItems: ["담당자 확인 과제"],
          interviewQuestions: ["시험 범위는 어디까지인가요?", "비교 기준은?"],
          sections: sectionDefinitions.map((section) => ({
            ...section,
            content:
              section.key === "development"
                ? "직접 고친 개발 내용입니다.\r\n검증 범위를 보완해야 합니다."
                : `MANUAL_OTHER_${section.key}`,
            evidence: [
              { sourceId: "profile", quote: "PRIVATE_OLD_CITATION", locator: "기존 위치" },
            ],
            needsConfirmation: false,
          })),
        },
        review: [
          {
            id: "old-review",
            severity: "warning",
            category: "confirmation",
            sectionKey: "development",
            message: "이전 판단",
            action: "확인",
            sourceIds: [],
          },
        ],
        confirmedAt: now,
      },
    ],
    tasks: [],
    stage: "preparing",
    revision: 5,
    createdAt: now,
    updatedAt: now,
  });
  const questionText = value.plans[0].content.interviewQuestions[0];
  const input: PlanSupplementInput = {
    revision: value.revision,
    target: {
      kind: "visit-question",
      planId: baseId,
      planVersion: 2,
      questionIndex: 0,
      questionText,
      questionSha256: sha(questionText),
    },
    sectionKey: "development",
    baseContentSha256: sha(JSON.stringify(value.plans[0].content)),
    sourceSelections: [{ sourceId, sourceUpdatedAt: now, textSha256: sha(value.sources[0].text) }],
  };
  const quote = "작은 범위의 내부 시험만 했습니다.",
    start = value.sources[0].text.indexOf(quote);
  const draft: PlanSupplementDraft = {
    content:
      "직접 고친 개발 내용입니다.\r\n담당자는 작은 범위의 내부 시험만 했다고 설명했습니다. 외부 시험은 계획입니다.",
    addedEvidence: [{ sourceId, start, end: start + quote.length, quote }],
  };
  const preview = () => preparePlanSupplement(value, input);
  const compare = () => comparePlanSupplement(value, input, preview().binding, draft);
  return { value, input, draft, preview, compare };
}
