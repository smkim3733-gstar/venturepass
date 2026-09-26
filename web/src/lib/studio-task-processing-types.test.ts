import { describe, expect, it } from "vitest";
import {
  resolveTaskPlanReference,
  taskProcessingSchema,
  taskProcessingStages,
  type TaskPlanReference,
  type TaskProcessingPlan,
} from "./studio-task-processing-types";

const planId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const plan: TaskProcessingPlan = {
  id: planId,
  version: 1,
  content: {
    title: "합성 원고",
    sections: [
      {
        key: "solution",
        title: "기술 내용",
        content: "목표 수치 10은 계획입니다.\n근거 확인이 필요합니다.",
      },
    ],
  },
};
const ref: TaskPlanReference = {
  planId,
  sectionKey: "solution",
  quote: "목표 수치 10은 계획입니다.",
};

describe("업무 내부 단계와 원고 인용 계약", () => {
  it.each(taskProcessingStages)("%s는 담당자 입력 단계이며 원고 연결 없이도 허용한다", (stage) => {
    expect(taskProcessingSchema.parse({ stage, planRefs: [] })).toEqual({ stage, planRefs: [] });
  });
  it("정확한 인용은 양끝 공백만 정리하고 내부 줄바꿈은 보존한다", () => {
    const parsed = taskProcessingSchema.parse({
      stage: "reviewing",
      planRefs: [
        {
          ...ref,
          sectionKey: " solution ",
          quote: " 목표 수치 10은 계획입니다.\n근거 확인이 필요합니다. ",
        },
      ],
    });
    expect(parsed.planRefs[0].quote).toBe(plan.content.sections[0].content);
    expect(parsed.planRefs[0].sectionKey).toBe("solution");
    expect(resolveTaskPlanReference([plan], parsed.planRefs[0]).state).toBe("matched");
  });
  it.each([
    { stage: "submitted", planRefs: [] },
    { stage: "ready", planRefs: [], submitted: true },
    { stage: "ready" },
    { stage: "writing", planRefs: [{ ...ref, approved: true }] },
    { stage: "writing", planRefs: [{ ...ref, planId: "foreign-invalid" }] },
    { stage: "writing", planRefs: [{ ...ref, sectionKey: " " }] },
    { stage: "writing", planRefs: [{ ...ref, sectionKey: "x".repeat(101) }] },
    { stage: "writing", planRefs: [{ ...ref, quote: " " }] },
    { stage: "writing", planRefs: [{ ...ref, quote: "가".repeat(1501) }] },
    { stage: "writing", planRefs: [{ ...ref, quote: 0 }] },
    {
      stage: "writing",
      planRefs: Array.from({ length: 11 }, (_, i) => ({ ...ref, sectionKey: `section-${i}` })),
    },
    { stage: "writing", planRefs: [ref, { ...ref, quote: "다른 부분" }] },
  ])("잘못된 상태·한도·위조 속성·중복 항목을 거부한다 %#", (value) => {
    expect(taskProcessingSchema.safeParse(value).success).toBe(false);
  });
  it("같은 항목이라도 명시적으로 선택한 서로 다른 버전은 별도 연결한다", () => {
    const current = { ...plan, id: otherId, version: 2 };
    const parsed = taskProcessingSchema.parse({
      stage: "collecting",
      planRefs: [ref, { ...ref, planId: otherId }],
    });
    expect(resolveTaskPlanReference([plan, current], parsed.planRefs[0])).toMatchObject({
      state: "matched",
      latest: false,
      plan: { version: 1 },
    });
    expect(resolveTaskPlanReference([plan, current], parsed.planRefs[1])).toMatchObject({
      state: "matched",
      latest: true,
      plan: { version: 2 },
    });
  });
  it("다른 회사의 같은 본문이나 최신 버전으로 누락된 원고를 대신하지 않는다", () => {
    expect(resolveTaskPlanReference([{ ...plan, id: otherId }], ref).state).toBe("missing-plan");
    expect(resolveTaskPlanReference([], ref).state).toBe("missing-plan");
  });
  it("동일 ID나 항목 키가 중복이면 일치하는 첫 항목을 임의 선택하지 않는다", () => {
    expect(resolveTaskPlanReference([plan, structuredClone(plan)], ref).state).toBe(
      "ambiguous-plan",
    );
    const duplicate = {
      ...plan,
      content: { ...plan.content, sections: [...plan.content.sections, ...plan.content.sections] },
    };
    expect(resolveTaskPlanReference([duplicate], ref).state).toBe("ambiguous-section");
    expect(resolveTaskPlanReference([plan], { ...ref, sectionKey: "missing" }).state).toBe(
      "missing-section",
    );
  });
  it.each([
    "목표 수치 20은 계획입니다.",
    "목표 수치  10은 계획입니다.",
    "목표 수치 10은 완료입니다.",
    "",
    "   ",
  ])("없는 문장·수치·추정 수정과 빈 인용은 일치 처리하지 않는다: %j", (quote) => {
    expect(resolveTaskPlanReference([plan], { ...ref, quote }).state).toBe("quote-mismatch");
  });
});
