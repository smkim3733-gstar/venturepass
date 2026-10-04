import { evaluationFocusItems } from "@/lib/evaluation-guide";
import { sectionDefinitions, type BusinessPlan, type StudioCase } from "@/lib/studio-schema";
import { guidedQuestionKey, guidedQuestions, type GuidedQuestion } from "./guided-questions";

export type GuidedQuestionContext = GuidedQuestion & {
  origins: { label: string; identity: string; reason: string }[];
  priority: "high" | "normal";
};
export type GuidedQuestionLink = { sectionKey: string; sourceIds: string[] };

/** Only stored question provenance; never infer a section from keywords or claim a fact is verified. */
export function guidedQuestionContexts(
  company: StudioCase,
  plan?: BusinessPlan,
): GuidedQuestionContext[] {
  const retained =
    !!plan &&
    !company.analysis &&
    company.selectedCandidateId === null &&
    company.plans.some(
      (stored) => stored.id === plan.id && JSON.stringify(stored) === JSON.stringify(plan),
    );
  const contextCompany = retained ? { ...company, selectedCandidateId: plan.candidateId } : company;
  const currentPlan =
    plan?.candidateId === contextCompany.selectedCandidateId &&
    (!company.analysis || plan.sourceRevision >= company.analysis.sourceRevision)
      ? plan
      : undefined;
  return guidedQuestions(contextCompany, plan).map((question) => {
    const key = guidedQuestionKey(question.question);
    const analysis = (company.analysis?.questions ?? []).filter(
      (q) => guidedQuestionKey(q.question) === key,
    );
    const origins = analysis.map((q) => ({
      label: company.analysis?.mode === "ai" ? "AI 분석 질문" : "자료 정리 질문",
      identity: `분석 ${company.analysis!.generatedAt} · 자료 기준 ${company.analysis!.sourceRevision} · 질문 ${q.id}`,
      reason: q.reason,
    }));
    currentPlan?.content.interviewQuestions.forEach((q, index) => {
      if (guidedQuestionKey(q) === key)
        origins.push({
          label: `${retained ? "이전 " : ""}원고 v${currentPlan.version}의 준비 질문`,
          identity: `원고 ${currentPlan.id} · 자료 기준 ${currentPlan.sourceRevision} · 질문 ${index + 1}`,
          reason: retained
            ? "자료 변경 전 원고의 질문입니다. 현재 자료와 다시 대조해 주세요."
            : "작성한 계획서의 사실과 근거를 확인하는 질문입니다.",
        });
    });
    return {
      ...question,
      reason: retained
        ? "자료 변경 전 원고의 질문입니다. 현재 자료와 다시 대조해 주세요."
        : question.reason,
      origins,
      priority: analysis.some((q) => q.priority === "high") ? "high" : "normal",
    };
  });
}
export function guidedQuestionExamples(sectionKey: string) {
  return [
    ...new Set(
      evaluationFocusItems
        .filter((item) => item.sectionKeys.includes(sectionKey))
        .flatMap((item) => item.evidence),
    ),
  ].slice(0, 3);
}
export function guidedAnswerText(
  company: StudioCase,
  questions: GuidedQuestionContext[],
  answers: Record<string, string>,
  links: Record<string, GuidedQuestionLink>,
) {
  const blocks = questions.flatMap((question) => {
    const answer = answers[question.id]?.trim() ?? "";
    const link = links[question.id];
    if (!answer && !link?.sourceIds.length) return [];
    if (answer.length > 5000) throw Error("답변은 질문마다 5,000자까지 보관할 수 있습니다.");
    const section = sectionDefinitions.find((s) => s.key === link?.sectionKey);
    if (link?.sectionKey && !section) throw Error("연결할 계획서 항목을 다시 확인해 주세요.");
    const ids = link?.sourceIds ?? [];
    if (new Set(ids).size !== ids.length || ids.length > 100)
      throw Error("연결 자료를 다시 확인해 주세요.");
    const sources = ids.map((id) => {
      const source = company.sources.find((s) => s.id === id);
      if (!source)
        throw Error("연결한 자료가 바뀌었습니다. 입력은 유지하니 자료를 다시 선택해 주세요.");
      return `${source.name} · 자료 ${source.id} · 기록 시각 ${source.updatedAt} · ${source.extraction === "pending" ? "본문 판독·채택 전" : source.text.trim() ? "저장 본문 있음(진위 확인 별도)" : "본문 없음 · 기본 정보만"}`;
    });
    return [
      `질문: ${question.question}\n이유: ${question.reason}\n${question.origins.map((origin) => `질문 출처: ${origin.label} · ${origin.identity}\n출처의 이유: ${origin.reason}`).join("\n")}\n연결 항목(사용자 지정): ${section ? `${section.title} (${section.key})` : "미지정"}\n보완 자료 연결(사용자 지정): ${sources.length ? "\n" + sources.join("\n") : "없음"}\n답변/메모(사용자 진술): ${answer || "글 답변 없이 자료만 연결함"}`,
    ];
  });
  if (!blocks.length) return null;
  const text = `담당자가 입력한 설명과 자료 연결입니다. 별도 증빙·진위 확인이 필요하며 원고에 자동 반영하지 않습니다.\n회사 ${company.id} · 자료 기준 ${company.revision}\n\n${blocks.join("\n\n")}`;
  if (text.length > 100000)
    throw Error("질문·답변·연결 기록을 합쳐 100,000자까지 보관할 수 있습니다. 입력은 유지합니다.");
  return text;
}
