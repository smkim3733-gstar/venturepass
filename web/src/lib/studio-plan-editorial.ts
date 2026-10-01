import type { PlanContent, ReviewFinding } from "./studio-schema";

const statusLabels: Readonly<Record<string, string>> = {
  documented: "문서에 기재됨",
  reported: "담당자 설명",
  planned: "향후 계획",
  unverified: "근거 미확인",
  classification: "후보 분류",
  current: "현재 활동과 연결한 후보",
  "evidence-needed": "관련 활동·권한·증빙 확인 필요",
  "future-proposal": "향후 제안",
  unknown: "분류 미확인",
};

export type PlanLanguageSuggestion = {
  location: string;
  sectionKey: string | null;
  term: string;
  suggestion: string;
  count: number;
};

/** Advice about editable prose only. Never rewrites evidence, stored plans or approval bytes. */
export function planLanguageSuggestions(content: PlanContent): PlanLanguageSuggestion[] {
  const fields = [
    { location: "사업계획서 제목", sectionKey: null, text: content.title },
    { location: "핵심 요약", sectionKey: null, text: content.summary },
    ...content.sections.flatMap((section) => [
      { location: `${section.title} · 제목`, sectionKey: section.key, text: section.title },
      { location: section.title, sectionKey: section.key, text: section.content },
    ]),
    ...content.actionItems.map((text, index) => ({
      location: `보강 과제 ${index + 1}`,
      sectionKey: null,
      text,
    })),
    ...content.interviewQuestions.map((text, index) => ({
      location: `실사 준비 질문 ${index + 1}`,
      sectionKey: null,
      text,
    })),
  ];
  return fields.flatMap(({ location, sectionKey, text }) => {
    const counts = new Map<string, number>();
    const terms =
      /(?<![a-zA-Z0-9_-])(?:documented|reported|planned|unverified|classification|current|evidence-needed|future-proposal|unknown)(?![a-zA-Z0-9_-])/gi;
    for (const match of text.matchAll(terms)) {
      const term = match[0].toLowerCase();
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    return [...counts].map(([term, count]) => ({
      location,
      sectionKey,
      term,
      suggestion: statusLabels[term],
      count,
    }));
  });
}

export type PlanReviewGroup = { finding: ReviewFinding; indices: number[] };

/** Only identical review contents are grouped; decision records retain their original indices. */
export function groupPlanReviewFindings(findings: readonly ReviewFinding[]): PlanReviewGroup[] {
  const groups = new Map<string, PlanReviewGroup>();
  findings.forEach((finding, index) => {
    const key = JSON.stringify([
      finding.severity,
      finding.category,
      finding.sectionKey,
      finding.message,
      finding.action,
      [...new Set(finding.sourceIds)].sort(),
    ]);
    const group = groups.get(key);
    if (group) group.indices.push(index);
    else groups.set(key, { finding, indices: [index] });
  });
  return [...groups.values()];
}
