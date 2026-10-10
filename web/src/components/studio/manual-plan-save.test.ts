import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  manualPlanSaveSnapshot,
  manualPlanSectionTarget,
  type ManualPlanSave,
} from "./manual-plan-save";

const id = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const savedId = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const company = caseSchema.parse({
    id,
    profile: { ...emptyProfile(), companyName: "합성 수정본 단위 검증" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    revision: 7,
    createdAt: "2026-10-10",
    updatedAt: "2026-10-10",
    plans: [
      {
        id: planId,
        version: 3,
        mode: "ai",
        generatedAt: "2026-10-09",
        candidateId: "synthetic",
        sourceRevision: 2,
        confirmedAt: null,
        review: [],
        content: {
          title: "원래 제목",
          summary: "원래 요약",
          sections: [
            {
              key: "problem",
              title: "고객 문제",
              content: "원래 본문",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: ["남은 확인"],
          interviewQuestions: [],
        },
      },
    ],
  });
  const content = structuredClone(company.plans[0].content);
  content.sections[0].content = "명시 수정 본문";
  const pending: ManualPlanSave = { company, mutation: { action: "save-plan", planId, content } };
  const next = structuredClone(company);
  next.revision++;
  next.plans.push({
    ...structuredClone(company.plans[0]),
    id: savedId,
    version: 4,
    mode: "manual",
    content: structuredClone(content),
  });
  return { pending, next };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
describe("간단 원고 수정본의 저장 상태 대조", () => {
  it("정확한 새 manual 원고만 수락하며 입력과 이전 원고를 바꾸지 않는다", () => {
    const { pending, next } = fixture();
    freeze(pending);
    freeze(next);
    const original = structuredClone(pending);
    const result = manualPlanSaveSnapshot(next, pending);
    expect(result).toEqual(next);
    expect(result).not.toBe(next);
    expect(pending).toEqual(original);
    expect(result.plans[1].confirmedAt).toBeNull();
  });
  it("이후 revision도 원래 다음 버전의 본문을 정확히 확인해야 수락한다", () => {
    const { pending, next } = fixture();
    next.revision += 3;
    expect(manualPlanSaveSnapshot(next, pending).revision).toBe(11);
  });
  it.each([
    [
      "다른 회사",
      (c: StudioCase) => {
        c.id = savedId;
      },
    ],
    [
      "같은 revision",
      (c: StudioCase) => {
        c.revision = 7;
      },
    ],
    [
      "이전 revision",
      (c: StudioCase) => {
        c.revision = 6;
      },
    ],
    [
      "수정본 누락",
      (c: StudioCase) => {
        c.plans.pop();
      },
    ],
    [
      "다른 본문",
      (c: StudioCase) => {
        c.plans[1].content.sections[0].content = "다른 본문";
      },
    ],
    [
      "다른 확인 상태",
      (c: StudioCase) => {
        c.plans[1].content.sections[0].needsConfirmation = false;
      },
    ],
    [
      "다른 제목",
      (c: StudioCase) => {
        c.plans[1].content.title = "다른 제목";
      },
    ],
    [
      "다른 근거",
      (c: StudioCase) => {
        c.plans[1].sourceRevision++;
      },
    ],
    [
      "다른 주제",
      (c: StudioCase) => {
        c.plans[1].candidateId = "other";
      },
    ],
    [
      "잘못된 다음 버전",
      (c: StudioCase) => {
        c.plans[1].version++;
      },
    ],
    [
      "AI 원고",
      (c: StudioCase) => {
        c.plans[1].mode = "ai";
      },
    ],
    [
      "전체 확인 승격",
      (c: StudioCase) => {
        c.plans[1].confirmedAt = "2026-10-10";
      },
    ],
    [
      "이전 원고 손실",
      (c: StudioCase) => {
        c.plans.shift();
      },
    ],
    [
      "이전 원고 변경",
      (c: StudioCase) => {
        c.plans[0].content.sections[0].content = "변경";
      },
    ],
    [
      "같은 버전 두 개",
      (c: StudioCase) => {
        c.plans.push({
          ...structuredClone(c.plans[1]),
          id: "44444444-4444-4444-8444-444444444444",
        });
      },
    ],
    [
      "같은 ID 두 개",
      (c: StudioCase) => {
        c.plans.push({ ...structuredClone(c.plans[1]), version: 5 });
      },
    ],
  ] as const)("%s를 저장 성공으로 처리하지 않는다", (_, change) => {
    const { pending, next } = fixture();
    change(next);
    freeze(next);
    expect(() => manualPlanSaveSnapshot(next, pending)).toThrow("아직 확인하지 못했습니다");
  });
  it.each([null, {}, { ok: true }, { plans: [] }])(
    "잘못된 응답에서 내부 형식 오류를 표시하지 않는다 (%#)",
    (raw) => {
      expect(() => manualPlanSaveSnapshot(raw, fixture().pending)).toThrow("입력을 유지했습니다");
    },
  );
  it("원래 편집 대상이 없으면 결과를 수락하지 않는다", () => {
    const { pending, next } = fixture();
    pending.mutation.planId = savedId;
    expect(() => manualPlanSaveSnapshot(next, pending)).toThrow();
  });
});

describe("간단 원고의 유일한 항목 편집 대상", () => {
  it("최신 원고의 정확한 항목을 반환하고 원문과 확인 상태를 바꾸지 않는다", () => {
    const { pending } = fixture();
    const before = structuredClone(pending.company);
    freeze(pending.company);
    expect(manualPlanSectionTarget(pending.company, planId, "problem")).toEqual({
      plan: pending.company.plans[0],
      section: pending.company.plans[0].content.sections[0],
    });
    expect(pending.company).toEqual(before);
  });
  it.each([
    [
      "없는 원고",
      (c: StudioCase) => {
        c.plans[0].id = savedId;
      },
    ],
    [
      "없는 항목",
      (c: StudioCase) => {
        c.plans[0].content.sections[0].key = "development";
      },
    ],
    [
      "같은 키의 다른 본문",
      (c: StudioCase) => {
        c.plans[0].content.sections.push({
          ...structuredClone(c.plans[0].content.sections[0]),
          title: "다른 제목",
          content: "다른 본문",
        });
      },
    ],
    [
      "같은 원고 ID",
      (c: StudioCase) => {
        c.plans.push({ ...structuredClone(c.plans[0]), version: 4 });
      },
    ],
    [
      "같은 최신 버전",
      (c: StudioCase) => {
        c.plans.push({ ...structuredClone(c.plans[0]), id: savedId });
      },
    ],
    [
      "이전 원고",
      (c: StudioCase) => {
        c.plans.push({ ...structuredClone(c.plans[0]), id: savedId, version: 4 });
      },
    ],
  ] as const)("%s에서는 첫 대상을 추정하지 않는다", (_, change) => {
    const { pending } = fixture();
    change(pending.company);
    freeze(pending.company);
    expect(manualPlanSectionTarget(pending.company, planId, "problem")).toBeNull();
  });
  it("다른 키의 중복은 보존하며 유일한 선택 항목만 반환한다", () => {
    const { pending } = fixture();
    const section = {
      ...structuredClone(pending.company.plans[0].content.sections[0]),
      key: "development",
    };
    pending.company.plans[0].content.sections.push(section, structuredClone(section));
    freeze(pending.company);
    expect(manualPlanSectionTarget(pending.company, planId, "problem")?.section.key).toBe(
      "problem",
    );
    expect(manualPlanSectionTarget(pending.company, planId, "development")).toBeNull();
  });
});
