import { describe, expect, it } from "vitest";
import {
  answerWorkflowCompany,
  answerWorkflowSource,
  answerQuestion,
} from "../../../scripts/fixtures/guided-answer-workflow";
import { savedGuidedAnswer, answerSupplementSelection } from "./guided-answer-supplement";
import { guidedQuestionContexts } from "./guided-question-context";

function fixture() {
  const before = answerWorkflowCompany(),
    source = answerWorkflowSource();
  const after = structuredClone(before);
  after.revision++;
  after.sources.push(source);
  const questions = guidedQuestionContexts(before, before.plans[0]);
  const question = questions.find((q) => q.question === answerQuestion)!;
  const answers = { [question.id]: source.text };
  const links = { [question.id]: { sectionKey: "development", sourceIds: [] } };
  const save = () => savedGuidedAnswer(before, after, source, questions, answers, links);
  return { before, after, source, questions, question, answers, links, save };
}
describe("저장한 답변에서 항목 수정안으로 이어가기", () => {
  it("정확히 저장된 답변·사용자 지정 항목·원고의 두 번째 질문을 잇는다", () => {
    const f = fixture(),
      before = JSON.stringify(f.before),
      saved = f.save()!;
    expect(answerSupplementSelection(f.after, saved)).toEqual({
      sourceId: f.source.id,
      sectionKey: "development",
      questionIndex: 1,
    });
    expect(JSON.stringify(f.before)).toBe(before);
    expect(f.after.plans).toEqual(f.before.plans);
  });
  it("서버가 정한 시각을 그대로 보관한다", () => {
    const f = fixture();
    f.after.sources[0] = { ...f.source, updatedAt: "2026-10-09T00:02:00.000Z" };
    expect(f.save()!.source.updatedAt).toBe(f.after.sources[0].updatedAt);
  });
  it.each(["company", "revision", "missing", "text", "duplicate"] as const)(
    "잘못된 저장 응답 %s로 입력을 완료 처리하지 않는다",
    (change) => {
      const f = fixture();
      if (change === "company") f.after.id = "c0000000-0000-4000-8000-000000000002";
      if (change === "revision") f.after.revision = f.before.revision;
      if (change === "missing") f.after.sources = [];
      if (change === "text") f.after.sources[0] = { ...f.source, text: "다른 응답" };
      if (change === "duplicate") f.after.sources.push(f.source);
      expect(f.save()).toBeNull();
    },
  );
  it("항목 미지정과 여러 답변의 서로 다른 항목·질문을 추정하지 않는다", () => {
    const f = fixture();
    delete f.links[f.question.id];
    expect(f.save()!.selection.sectionKey).toBeUndefined();
    const first = f.questions[0];
    f.answers[first.id] = "첫 질문 답변";
    f.links[first.id] = { sectionKey: "problem", sourceIds: [] };
    expect(f.save()!.selection).toMatchObject({ sectionKey: undefined, questionIndex: -1 });
  });
  it("동일 질문이 원고에 중복되면 질문 위치를 대신 고르지 않는다", () => {
    const f = fixture();
    f.after.plans[0].content.interviewQuestions.push(answerQuestion);
    expect(f.save()!.selection.questionIndex).toBe(-1);
  });
  it.each(["source", "plan", "company", "revision", "source-duplicate"] as const)(
    "저장 뒤 변경된 %s를 조용히 이어받지 않는다",
    (change) => {
      const f = fixture(),
        saved = f.save()!;
      if (change === "source") f.after.sources[0].text += "변경";
      if (change === "plan") f.after.plans[0].content.summary += "수정";
      if (change === "company") f.after.id = "c0000000-0000-4000-8000-000000000002";
      if (change === "revision") f.after.revision--;
      if (change === "source-duplicate") f.after.sources.push(f.source);
      expect(answerSupplementSelection(f.after, saved)).toBeNull();
    },
  );
  it("원고가 없거나 질문이 없으면 답변 보관만 완료하고 수정안을 열지 않는다", () => {
    const f = fixture();
    f.after.plans = [];
    expect(f.save()).not.toBeNull();
    expect(answerSupplementSelection(f.after, f.save())).toBeNull();
    f.after.plans = structuredClone(f.before.plans);
    f.after.plans[0].content.interviewQuestions = [];
    expect(answerSupplementSelection(f.after, f.save())).toBeNull();
  });
  it("6만자 상한까지 이어받고 초과 본문을 자르지 않는다", () => {
    const f = fixture();
    f.source.text = "가".repeat(60000);
    expect(answerSupplementSelection(f.after, f.save())).not.toBeNull();
    f.source.text += "나";
    expect(f.save()!.source.text).toHaveLength(60001);
    expect(answerSupplementSelection(f.after, f.save())).toBeNull();
  });
});
