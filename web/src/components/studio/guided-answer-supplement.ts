import {
  sectionDefinitions,
  type BusinessPlan,
  type SourceDocument,
  type StudioCase,
} from "@/lib/studio-schema";
import type { PlanSupplementInput } from "@/lib/studio-plan-supplement-types";
import type { GuidedQuestionContext, GuidedQuestionLink } from "./guided-question-context";
import { guidedQuestionKey } from "./guided-questions";

export type AnswerSupplementSelection = {
  sourceId: string;
  sectionKey?: PlanSupplementInput["sectionKey"];
  questionIndex: number;
};
export type SavedGuidedAnswer = {
  caseId: string;
  revision: number;
  source: SourceDocument;
  plan: BusinessPlan | null;
  selection: AnswerSupplementSelection;
};
function currentPlan(company: StudioCase) {
  const version = Math.max(0, ...company.plans.map((plan) => plan.version));
  const plans = company.plans.filter((plan) => plan.version === version);
  return plans.length === 1 ? plans[0] : null;
}
/** A save receipt, not an AI approval. Server-assigned source timestamps are retained. */
export function savedGuidedAnswer(
  before: StudioCase,
  after: StudioCase,
  requested: SourceDocument,
  questions: GuidedQuestionContext[],
  answers: Record<string, string>,
  links: Record<string, GuidedQuestionLink>,
): SavedGuidedAnswer | null {
  const matches = after.sources.filter((source) => source.id === requested.id);
  const source = matches[0];
  if (
    before.id !== after.id ||
    after.revision <= before.revision ||
    before.sources.some((item) => item.id === requested.id) ||
    matches.length !== 1 ||
    !source ||
    source.name !== requested.name ||
    source.kind !== requested.kind ||
    source.text !== requested.text ||
    source.extraction !== "manual" ||
    source.originalName !== null ||
    source.mimeType !== null
  )
    return null;
  const plan = currentPlan(after);
  const answered = questions.filter(
    (question) => answers[question.id]?.trim() || links[question.id]?.sourceIds.length,
  );
  const keys = answered.map((question) => links[question.id]?.sectionKey ?? "");
  const sectionKey = sectionDefinitions.find(
    (item) =>
      keys.length > 0 &&
      keys.every((key) => key === item.key) &&
      plan?.content.sections.some((section) => section.key === item.key),
  )?.key;
  const questionMatches =
    plan?.content.interviewQuestions.flatMap((question, index) =>
      answered.some((answer) => guidedQuestionKey(answer.question) === guidedQuestionKey(question))
        ? [index]
        : [],
    ) ?? [];
  return structuredClone({
    caseId: after.id,
    revision: after.revision,
    source,
    plan,
    selection: {
      sourceId: source.id,
      sectionKey,
      questionIndex: questionMatches.length === 1 ? questionMatches[0] : -1,
    },
  });
}
/** Only reuse the saved answer and original draft; never choose a newer draft silently. */
export function answerSupplementSelection(company: StudioCase, saved: SavedGuidedAnswer | null) {
  if (!saved || company.id !== saved.caseId || company.revision < saved.revision) return null;
  const source = company.sources.filter((item) => item.id === saved.source.id);
  const plan = currentPlan(company);
  if (
    source.length !== 1 ||
    JSON.stringify(source[0]) !== JSON.stringify(saved.source) ||
    !plan ||
    !saved.plan ||
    JSON.stringify(plan) !== JSON.stringify(saved.plan) ||
    !plan.content.interviewQuestions.length ||
    !source[0].text.trim() ||
    source[0].text.length > 60000
  )
    return null;
  return { ...saved.selection };
}
