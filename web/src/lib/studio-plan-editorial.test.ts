import { describe, expect, it } from "vitest";
import { groupPlanReviewFindings, planLanguageSuggestions } from "./studio-plan-editorial";
import type { PlanContent, ReviewFinding } from "./studio-schema";

const content = (): PlanContent => ({
  title: "사업계획서",
  summary: "",
  sections: [
    { key: "solution", title: "기술 구성", content: "", evidence: [], needsConfirmation: true },
  ],
  actionItems: [],
  interviewQuestions: [],
});
const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "r1",
  severity: "warning",
  category: "semantic-evidence",
  message: "권리 범위를 확인해 주세요.",
  action: "계약 원문을 대조합니다.",
  sectionKey: "solution",
  sourceIds: ["s1", "s2"],
  ...overrides,
});
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe("local Korean prose advice", () => {
  it("finds internal labels across editable prose with locations and counts", () => {
    const plan = content();
    plan.title = "future-proposal";
    plan.summary = "classification은 분류이고 current 후보다.";
    plan.sections[0].title = "unknown";
    plan.sections[0].content =
      "documented 내용과 REPORTED 자료. reported로 설명하고 planned로 구분.";
    plan.actionItems = ["evidence-needed 상태"];
    plan.interviewQuestions = ["unverified 근거는?"];
    const result = planLanguageSuggestions(plan);
    expect(result).toHaveLength(9);
    expect(result.find((item) => item.term === "reported")).toMatchObject({
      location: "unknown",
      sectionKey: "solution",
      count: 2,
      suggestion: "담당자 설명",
    });
    expect(result.find((item) => item.term === "documented")?.suggestion).toBe("문서에 기재됨");
    expect(result.find((item) => item.term === "future-proposal")?.location).toBe(
      "사업계획서 제목",
    );
    expect(result.find((item) => item.term === "evidence-needed")?.location).toBe("보강 과제 1");
    expect(result.find((item) => item.term === "unverified")?.location).toBe("실사 준비 질문 1");
  });
  it("does not flag longer English words, identifiers or other English terms", () => {
    const plan = content();
    plan.summary = "undocumented currently pre-planned unreported reported_value reported2 M01 PLC";
    expect(planLanguageSuggestions(plan)).toEqual([]);
  });
  it("leaves source quotations, approval flags and input bytes unchanged", () => {
    const plan = content();
    plan.summary = "planned 계획";
    plan.sections[0].evidence = [
      { sourceId: "reported", quote: "documented planned", locator: "classification" },
    ];
    const before = JSON.stringify(plan);
    freeze(plan);
    expect(planLanguageSuggestions(plan)).toHaveLength(1);
    expect(JSON.stringify(plan)).toBe(before);
    expect(plan.sections[0].needsConfirmation).toBe(true);
  });
  it("recomputes advice after manual editing without changing the original", () => {
    const original = content();
    original.summary = "planned 작업";
    const edited = structuredClone(original);
    edited.summary = "향후 계획인 작업";
    expect(planLanguageSuggestions(original)).toHaveLength(1);
    expect(planLanguageSuggestions(edited)).toEqual([]);
  });
});

describe("review display grouping", () => {
  it("groups identical opinions with all original indices and without modifying data", () => {
    const reviews = [
      finding(),
      finding({ id: "r2", sourceIds: ["s2", "s1"] }),
      finding({ id: "r3", message: "일정을 확인해 주세요." }),
      finding({ id: "r4" }),
    ];
    const before = JSON.stringify(reviews);
    freeze(reviews);
    const groups = groupPlanReviewFindings(reviews);
    expect(groups.map((group) => group.indices)).toEqual([[0, 1, 3], [2]]);
    expect(groups[0].finding).toBe(reviews[0]);
    expect(JSON.stringify(reviews)).toBe(before);
  });
  it.each([
    { severity: "error" as const },
    { category: "contradiction" },
    { sectionKey: "funding" },
    { sectionKey: null },
    { sourceIds: ["s3"] },
    { action: "새 시험을 수행합니다." },
    { message: "권리 범위를 확인했습니다." },
  ])("preserves a meaningful difference: %j", (difference) => {
    expect(groupPlanReviewFindings([finding(), finding({ id: "r2", ...difference })])).toHaveLength(
      2,
    );
  });
  it("does not merge paraphrases or reassign decisions when IDs happen to repeat", () => {
    const reviews = [finding(), finding({ message: "사용 권한의 범위를 확인해 주세요." })];
    expect(groupPlanReviewFindings(reviews).map((group) => group.indices)).toEqual([[0], [1]]);
  });
  it("handles an empty review without manufacturing a finding", () => {
    expect(groupPlanReviewFindings([])).toEqual([]);
  });
});
