import { describe, expect, it } from "vitest";
import { createPlanQualityFixtures } from "@/lib/studio-plan-quality-fixtures";
import type { BusinessPlan } from "@/lib/studio-schema";
import { guidedQuestions } from "./guided-questions";

function setup() {
  const fixture = createPlanQualityFixtures()[0];
  const company = fixture.company;
  company.analysis = {
    generatedAt: company.updatedAt,
    mode: "ai",
    sourceRevision: 0,
    summary: "합성 분석",
    facts: [],
    candidates: [fixture.candidate],
    questions: [],
    warnings: [],
  };
  company.selectedCandidateId = fixture.candidate.id;
  const plan: BusinessPlan = {
    id: "test-plan",
    version: 1,
    generatedAt: company.updatedAt,
    mode: "ai",
    candidateId: fixture.candidate.id,
    sourceRevision: 0,
    content: fixture.plan,
    review: [],
    confirmedAt: null,
  };
  plan.content.interviewQuestions = [];
  return { company, plan };
}

describe("일반 화면의 실제 추가 질문", () => {
  it("충분한 자료에는 필수 질문을 임의로 만들지 않는다", () => {
    const { company, plan } = setup();
    expect(guidedQuestions(company, plan)).toEqual([]);
  });
  it("핵심 질문과 원고 질문을 먼저 놓고 3개 이후 질문도 보존한다", () => {
    const { company, plan } = setup();
    company.analysis!.questions = [
      { id: "medium", question: "추가 설명?", reason: "보충", priority: "medium" },
      { id: "high", question: "현재 실적?", reason: "핵심", priority: "high" },
    ];
    plan.content.interviewQuestions = ["실험 대상?", "대조군?", "확인 날짜?"];
    expect(guidedQuestions(company, plan).map((item) => item.question)).toEqual([
      "현재 실적?",
      "실험 대상?",
      "대조군?",
      "확인 날짜?",
      "추가 설명?",
    ]);
  });
  it("공백만 다른 질문은 한 번만 표시하고 내용을 식별자로 연결한다", () => {
    const { company, plan } = setup();
    company.analysis!.questions = [
      { id: "same", question: " 실험  대상? ", reason: "핵심", priority: "high" },
    ];
    plan.content.interviewQuestions = ["실험 대상?", ""];
    const first = guidedQuestions(company, plan);
    expect(first).toHaveLength(1);
    company.analysis!.questions[0].question = "대조군?";
    expect(guidedQuestions(company, plan)[0].id).not.toBe(first[0].id);
  });
  it("다른 신청 주제의 과거 원고 질문은 섞지 않는다", () => {
    const { company, plan } = setup();
    plan.candidateId = "old-candidate";
    plan.content.interviewQuestions = ["과거 질문?"];
    expect(guidedQuestions(company, plan)).toEqual([]);
  });
  it("질문을 보는 것만으로 사실 확인·원고·회사 기록을 바꾸지 않는다", () => {
    const { company, plan } = setup();
    plan.content.interviewQuestions = ["사실을 확인할 증빙은?"];
    const before = structuredClone({ company, plan });
    guidedQuestions(company, plan);
    expect({ company, plan }).toEqual(before);
  });
  it("같은 후보라도 현재 분석보다 오래된 원고 질문은 섞지 않는다", () => {
    const { company, plan } = setup();
    company.analysis!.sourceRevision = 5;
    plan.sourceRevision = 3;
    plan.content.interviewQuestions = ["과거 원고 질문?"];
    expect(guidedQuestions(company, plan)).toEqual([]);
  });
  it("실무 준비 접두사는 질문 중복 비교에서만 제외한다", () => {
    const { company, plan } = setup();
    company.analysis!.questions = [
      { id: "a", question: "시험 자료가 있나요?", reason: "증빙", priority: "medium" },
    ];
    plan.content.interviewQuestions = [
      "[실무 준비 질문 · 기관 확정 질문 아님] 시험 자료가 있나요?",
    ];
    const result = guidedQuestions(company, plan);
    expect(result).toHaveLength(1);
    expect(result[0].question).toContain("기관 확정 질문 아님");
  });
});
