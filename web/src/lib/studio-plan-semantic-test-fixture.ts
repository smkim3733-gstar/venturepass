// Hand-authored synthetic cases for offline UI checks, never a model-quality score.
import corpus from "./fixtures/plan-semantic-contrast-cases.json";
import { caseSchema, emptyProfile, planSchema } from "./studio-schema";

export const semanticContrastCases = corpus.cases;
export function semanticContrastFixture(id: string) {
  const item = semanticContrastCases.find((entry) => entry.id === id);
  if (!item) throw new Error("Unknown semantic contrast case");
  const plan = planSchema.parse({
    id: "00000000-0000-4000-8000-000000000401",
    version: 1,
    generatedAt: "2026-10-01T00:00:00.000Z",
    mode: "manual",
    candidateId: "synthetic-contrast",
    sourceRevision: 1,
    confirmedAt: null,
    review: structuredClone(item.storedReview),
    content: {
      title: item.title,
      summary: "",
      sections: [
        {
          key: item.sectionKey,
          title: "합성 대비 원고",
          content: item.draft,
          evidence: item.sources.map((source) => ({
            sourceId: source.id,
            quote: source.text,
            locator: "합성 원문 전체",
          })),
          needsConfirmation: true,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
  });
  const company = caseSchema.parse({
    id: "00000000-0000-4000-8000-000000000402",
    profile: { ...emptyProfile(), companyName: "합성 대비 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    plans: [plan],
  });
  return { item: structuredClone(item), plan: company.plans[0], company };
}
