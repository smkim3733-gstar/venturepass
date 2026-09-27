import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";

export type GuidedQuestion = { id: string; question: string; reason: string };

/** Combine actual questions without inventing a fixed checklist or a completion claim. */
export function guidedQuestions(company: StudioCase, plan?: BusinessPlan): GuidedQuestion[] {
  const analysis = company.analysis?.questions ?? [];
  const currentPlan =
    plan?.candidateId === company.selectedCandidateId &&
    (!company.analysis || plan.sourceRevision >= company.analysis.sourceRevision)
      ? plan
      : undefined;
  const candidates = [
    ...analysis.filter((item) => item.priority === "high"),
    ...(currentPlan?.content.interviewQuestions ?? []).map((question) => ({
      question,
      reason: "작성한 계획서의 사실과 근거를 확인하는 질문입니다.",
    })),
    ...analysis.filter((item) => item.priority !== "high"),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((item) => {
    const question = item.question.trim();
    const key = question
      .replace(/^\[실무 준비 질문 · 기관 확정 질문 아님\]\s*/, "")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [{ id: `question:${key}`, question, reason: item.reason }];
  });
}
