import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createPlanQualityFixtures } from "@/lib/studio-plan-quality-fixtures";
import type { BusinessPlan } from "@/lib/studio-schema";
import {
  guidedAnswerText,
  guidedQuestionContexts,
  guidedQuestionExamples,
} from "./guided-question-context";
import { GuidedQuestionCard } from "./guided-question-card";
function setup() {
  const fixture = createPlanQualityFixtures()[0],
    company = fixture.company;
  company.analysis = {
    generatedAt: company.updatedAt,
    mode: "ai",
    sourceRevision: 0,
    summary: "합성 분석",
    facts: [],
    candidates: [fixture.candidate],
    questions: [
      { id: "q1", question: "시험 한계는?", reason: "한계 확인", priority: "high" },
      { id: "q2", question: "확인 시점은?", reason: "시점 확인", priority: "medium" },
    ],
    warnings: [],
  };
  company.selectedCandidateId = fixture.candidate.id;
  const plan: BusinessPlan = {
    id: "original-plan",
    version: 2,
    generatedAt: company.updatedAt,
    mode: "ai",
    candidateId: fixture.candidate.id,
    sourceRevision: 0,
    content: { ...fixture.plan, interviewQuestions: ["시험 한계는?", "계약 여부는?"] },
    review: [],
    confirmedAt: null,
  };
  company.plans = [plan];
  return { company, plan };
}
describe("보완 질문 출처·연결과 사용자 진술 보관", () => {
  it("같은 질문의 분석/원고 출처와 서로 다른 이유를 모두 보존한다", () => {
    const { company, plan } = setup();
    const q = guidedQuestionContexts(company, plan)[0];
    expect(q.origins).toHaveLength(2);
    expect(q.priority).toBe("high");
    expect(q.origins[0].identity).toContain("질문 q1");
    expect(q.origins[1].identity).toContain("original-plan");
    expect(q.origins[1].label).toContain("v2");
  });
  it("다른 후보 또는 오래된 원고를 현재 질문 출처로 붙이지 않는다", () => {
    const { company, plan } = setup();
    plan.candidateId = "other";
    expect(guidedQuestionContexts(company, plan).every((q) => q.origins.length === 1)).toBe(true);
    plan.candidateId = company.selectedCandidateId!;
    plan.sourceRevision = -1;
    expect(guidedQuestionContexts(company, plan).every((q) => q.origins.length === 1)).toBe(true);
  });
  it("질문이 없으면 강제 체크리스트를 만들지 않고 읽기로 회사·원고를 수정하지 않는다", () => {
    const { company, plan } = setup();
    company.analysis!.questions = [];
    plan.content.interviewQuestions = [];
    const before = JSON.stringify(company);
    expect(guidedQuestionContexts(company, plan)).toEqual([]);
    expect(JSON.stringify(company)).toBe(before);
  });
  it("자료 추가로 분석 연결이 초기화돼도 보관한 원고 질문은 이전 출처로 구분한다", () => {
    const { company, plan } = setup();
    company.analysis = null;
    company.selectedCandidateId = null;
    const before = JSON.stringify(company),
      questions = guidedQuestionContexts(company, plan);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.reason.includes("자료 변경 전"))).toBe(true);
    expect(questions[0].origins[0].label).toContain("이전 원고 v2");
    expect(JSON.stringify(company)).toBe(before);
  });
  it("보관 원고와 다른 내용이나 신원은 이전 질문 복원 근거로 쓰지 않는다", () => {
    const { company, plan } = setup();
    company.analysis = null;
    company.selectedCandidateId = null;
    const altered = structuredClone(plan);
    altered.content.interviewQuestions.push("다른 질문");
    expect(guidedQuestionContexts(company, altered)).toEqual([]);
    expect(guidedQuestionContexts(company, { ...plan, id: "another" })).toEqual([]);
  });
  it("자료 예시는 명시 항목의 기존 작성 가이드만 재사용하고 단어로 질문 항목을 추정하지 않는다", () => {
    expect(guidedQuestionExamples("funding").length).toBeGreaterThan(0);
    expect(guidedQuestionExamples("자금 계약 확정")).toEqual([]);
    expect(guidedQuestionExamples("")).toEqual([]);
  });
  it("짧은 답변에 질문·이유·원래 출처·사용자 연결을 보관하고 원문/확인 상태는 불변이다", () => {
    const { company, plan } = setup(),
      q = guidedQuestionContexts(company, plan)[0],
      before = JSON.stringify(company);
    const text = guidedAnswerText(
      company,
      [q],
      { [q.id]: "  아직 외부 시험 전입니다.  " },
      { [q.id]: { sectionKey: "development", sourceIds: [company.sources[0].id] } },
    )!;
    expect(text).toContain("별도 증빙·진위 확인");
    expect(text).toContain("원고에 자동 반영하지 않습니다");
    expect(text).toContain("original-plan");
    expect(text).toContain(company.sources[0].id);
    expect(text).toContain("아직 외부 시험 전입니다.");
    expect(text).toContain("development");
    expect(JSON.stringify(company)).toBe(before);
  });
  it("글 답변 없이 미판독 파일만 연결해도 내용 채택으로 기록하지 않고 본문을 복사하지 않는다", () => {
    const { company, plan } = setup(),
      q = guidedQuestionContexts(company, plan)[0];
    company.sources[0].extraction = "pending";
    company.sources[0].text = "MUST_NOT_COPY_BODY";
    const text = guidedAnswerText(
      company,
      [q],
      {},
      { [q.id]: { sectionKey: "", sourceIds: [company.sources[0].id] } },
    )!;
    expect(text).toContain("본문 판독·채택 전");
    expect(text).toContain("글 답변 없이 자료만 연결함");
    expect(text).toContain("미지정");
    expect(text).not.toContain("MUST_NOT_COPY_BODY");
  });
  it("연결 항목만 고른 미입력은 빈 답변 자료를 만들지 않는다", () => {
    const { company, plan } = setup(),
      q = guidedQuestionContexts(company, plan)[0];
    expect(
      guidedAnswerText(company, [q], {}, { [q.id]: { sectionKey: "funding", sourceIds: [] } }),
    ).toBeNull();
  });
  it.each(["missing", "duplicate", "section"])("%s 연결은 새 자료로 묵인하지 않는다", (kind) => {
    const { company, plan } = setup(),
      q = guidedQuestionContexts(company, plan)[0],
      id = company.sources[0].id;
    expect(() =>
      guidedAnswerText(
        company,
        [q],
        { [q.id]: "답변" },
        {
          [q.id]: {
            sectionKey: kind === "section" ? "fake" : "",
            sourceIds: kind === "duplicate" ? [id, id] : kind === "missing" ? ["gone"] : [],
          },
        },
      ),
    ).toThrow();
  });
  it("질문별5천자/전체10만자 상한을 자르거나 완화하지 않는다", () => {
    const { company, plan } = setup(),
      q = guidedQuestionContexts(company, plan)[0];
    expect(() => guidedAnswerText(company, [q], { [q.id]: "x".repeat(5001) }, {})).toThrow();
    const qs = Array.from({ length: 21 }, (_, i) => ({ ...q, id: "q" + i }));
    expect(() =>
      guidedAnswerText(
        company,
        qs,
        Object.fromEntries(qs.map((q) => [q.id, "x".repeat(5000)])),
        {},
      ),
    ).toThrow();
  });
  it("질문 출처 복사본을 수정해도 저장 분석/원고에 쓰지 않는다", () => {
    const { company, plan } = setup(),
      before = JSON.stringify(company),
      q = guidedQuestionContexts(company, plan)[0];
    q.origins[0].reason = "변경";
    expect(JSON.stringify(company)).toBe(before);
  });
  it("질문 카드는 수동 항목 연결·자료 예시의 한계·미판독 파일을 보여 준다", () => {
    const { company, plan } = setup();
    company.sources[0].extraction = "pending";
    const html = renderToStaticMarkup(
      createElement(GuidedQuestionCard, {
        company,
        question: guidedQuestionContexts(company, plan)[0],
        link: { sectionKey: "funding", sourceIds: [] },
        onLink: () => {},
      }),
    );
    for (const text of [
      "직접 지정",
      "자동으로 연결하지 않습니다",
      "필수서류 목록은 아닙니다",
      "본문 채택 전",
      "질문 출처 확인",
    ])
      expect(html).toContain(text);
  });
});
