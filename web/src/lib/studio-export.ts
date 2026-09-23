import type { BusinessPlan, StudioCase } from "./studio-schema";

export function exportPlanMarkdown(record: StudioCase, plan: BusinessPlan, current: boolean) {
  const lines = [
    `# ${plan.content.title}`,
    "",
    `기업: ${record.profile.companyName}`,
    `버전: ${plan.version}`,
    `작성일: ${plan.generatedAt}`,
    `작성 방식: ${plan.mode === "ai" ? "AI 작성" : plan.mode === "assisted" ? "입력자료 기반 작성 보조 (AI 미사용)" : "사용자 편집"}`,
    `작성 근거: 기업 자료 revision ${plan.sourceRevision}`,
    `현재 자료와 일치: ${current ? "예" : "아니요 — 자료 또는 아이템 변경 후 재작성 필요"}`,
    `사용자 검토 확인: ${plan.confirmedAt && current ? plan.confirmedAt : "미확인"}`,
    "",
    "> 신청 준비용 작성본입니다. 기관에 접수되거나 심사 통과가 확인된 문서가 아닙니다. 현재 실적과 향후 계획을 구분하고 제출 전 사실 및 근거를 확인해 주세요.",
    "",
    "## 사업 개요",
    "",
    plan.content.summary,
    "",
  ];
  for (const section of plan.content.sections) {
    lines.push(`## ${section.title}`, "", section.content, "");
    if (section.needsConfirmation) lines.push("**확인 필요:** 내용과 증빙을 검토해 주세요.", "");
    if (section.evidence.length) {
      lines.push("### 연결 근거", "");
      for (const reference of section.evidence) {
        const source = record.sources.find((entry) => entry.id === reference.sourceId);
        const name = reference.sourceId.startsWith("profile")
          ? "기업 기본정보"
          : (source?.name ?? "삭제되었거나 현재 자료에서 찾을 수 없는 출처");
        lines.push(
          `- ${name} · ${reference.locator || "위치 미지정"} · 출처 ID: ${reference.sourceId}`,
          `  - 인용: ${reference.quote.replaceAll("\n", " ")}`,
        );
      }
      lines.push("");
    }
  }
  lines.push("## 사전 검토 결과", "");
  if (!plan.review.length)
    lines.push(
      "자동 검토에서 표시된 항목이 없습니다. 사실 확인과 최종 검토는 별도로 필요합니다.",
      "",
    );
  for (const finding of plan.review)
    lines.push(
      `- [${finding.severity === "error" ? "오류" : finding.severity === "warning" ? "주의" : "안내"}] ${finding.message}`,
      `  - 조치: ${finding.action}`,
    );
  lines.push("", "## 추가 준비 과제", "");
  for (const action of plan.content.actionItems) lines.push(`- [ ] ${action}`);
  lines.push("", "## 실사 예상 질문", "");
  plan.content.interviewQuestions.forEach((question, index) =>
    lines.push(`${index + 1}. ${question}`),
  );
  lines.push("", "## 입력자료 목록", "");
  for (const source of record.sources) {
    lines.push(`- ${source.name} · ID: ${source.id} · 최종 수정: ${source.updatedAt}`);
    for (const warning of source.warnings) lines.push(`  - 추출 확인사항: ${warning}`);
  }
  lines.push(
    "",
    "평가항목과 제출 양식은 신청 시점의 벤처기업확인기관 안내를 확인해 주세요.",
    "https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C",
    "",
  );
  return lines.join("\n");
}
