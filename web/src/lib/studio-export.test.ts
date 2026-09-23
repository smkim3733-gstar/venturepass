import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyProfile, type BusinessPlan, type StudioCase } from "./studio-schema";
import { exportPlanMarkdown } from "./studio-export";

describe("사업계획서 내보내기", () => {
  it("원고·근거 인용·검토 과제·실사 질문과 오래된 자료 경고를 함께 제공한다", () => {
    const sourceId = randomUUID();
    const plan: BusinessPlan = {
      id: randomUUID(),
      version: 3,
      generatedAt: "2026-09-22T00:00:00Z",
      mode: "assisted",
      candidateId: "c",
      sourceRevision: 2,
      confirmedAt: "2026-09-22T01:00:00Z",
      content: {
        title: "센서 개발 사업계획서",
        summary: "개발·검증 계획",
        sections: [
          {
            key: "solution",
            title: "해결 기술",
            content: "센서 시제품 개발",
            needsConfirmation: true,
            evidence: [{ sourceId, quote: "시제품 테스트를 진행했습니다.", locator: "페이지 2" }],
          },
        ],
        actionItems: ["시험 성적서 확보"],
        interviewQuestions: ["측정 조건은 무엇입니까?"],
      },
      review: [
        {
          id: "r",
          severity: "warning",
          category: "evidence",
          message: "시험 결과를 확인해 주세요.",
          action: "증빙 확인",
          sectionKey: "solution",
          sourceIds: [sourceId],
        },
      ],
    };
    const record: StudioCase = {
      id: randomUUID(),
      profile: { ...emptyProfile(), companyName: "기업명" },
      sources: [],
      analysis: null,
      selectedCandidateId: null,
      plans: [plan],
      tasks: [],
      stage: "drafting",
      revision: 5,
      createdAt: "now",
      updatedAt: "now",
    };
    const markdown = exportPlanMarkdown(record, plan, false);
    for (const required of [
      "센서 개발 사업계획서",
      "AI 미사용",
      "재작성 필요",
      "사용자 검토 확인: 미확인",
      "페이지 2",
      "시제품 테스트를 진행했습니다.",
      "삭제되었거나",
      "시험 성적서 확보",
      "측정 조건은 무엇입니까?",
      "시험 결과를 확인해 주세요.",
    ])
      expect(markdown).toContain(required);
    expect(markdown).not.toContain("사용자 검토 확인: 2026");
  });
});
