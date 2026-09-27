import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ parse: vi.fn(), constructor: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    responses = { parse: state.parse };
    constructor(options: unknown) {
      state.constructor(options);
    }
  },
}));
import { generatePlanWithRepair } from "./studio-engine";
import {
  caseSchema,
  emptyProfile,
  sectionDefinitions,
  type Candidate,
  type PlanContent,
  type ReviewFinding,
} from "./studio-schema";

const sourceId = "28ba14c2-de3f-4f4f-9cdd-736e8515c464";
const sourceText = "실험실 시제품을 개발 중이며 성능 검증은 아직 진행하지 않았습니다.";
const value = () =>
  caseSchema.parse({
    id: "e73a06cb-cc76-4633-8291-4c1391932d6a",
    profile: {
      ...emptyProfile(),
      companyName: "가상 수정 시험기업",
      technologySummary: sourceText,
    },
    sources: [
      {
        id: sourceId,
        name: "합성 기술 설명",
        kind: "technology",
        text: sourceText,
        originalName: null,
        mimeType: null,
        extraction: "manual",
        warnings: [],
        createdAt: "2026-09-26",
        updatedAt: "2026-09-26",
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: "2026-09-26",
    updatedAt: "2026-09-26",
  });
const evidence = [{ sourceId, quote: sourceText, locator: "합성 본문" }];
const candidate: Candidate = {
  id: "topic",
  classification: "current",
  title: "합성 시제품",
  problem: "가상 문제",
  solution: sourceText,
  targetCustomer: "가상 고객",
  differentiation: "확인 필요",
  stage: "개발 중",
  businessModel: "제안",
  recommendation: "원문에 개발 중으로 기재됨",
  evidence,
  gaps: ["성능 검증 근거"],
};
const draft = (): PlanContent => ({
  title: "합성 계획서",
  summary: "사용자 검토용 초안",
  sections: sectionDefinitions.map((definition, index) => ({
    ...definition,
    content: index === 0 ? "실험실 시제품을 개발 완료했습니다." : sourceText,
    evidence,
    needsConfirmation: index === 1,
  })),
  actionItems: ["성능 검증 자료를 확인해 주세요."],
  interviewQuestions: ["성능 검증 자료가 준비되어 있나요?"],
});
const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "semantic-1",
  severity: "warning",
  category: "fact-vs-plan",
  message: "본문의 개발 완료 표현은 개발 중이라는 원문과 다릅니다.",
  action: "원문의 진행 단계로 표현을 고쳐 주세요.",
  sectionKey: "problem",
  sourceIds: [sourceId],
  ...overrides,
});
const answer = (output_parsed: unknown) => ({ status: "completed", output_parsed });
function seedInitial(findings: ReviewFinding[] = [finding()], initial = draft()) {
  state.parse.mockResolvedValueOnce(answer(initial)).mockResolvedValueOnce(answer({ findings }));
}
function repaired(): PlanContent {
  const result = draft();
  result.sections[0].content = sourceText;
  result.sections.forEach((section) => {
    section.needsConfirmation = false;
  });
  result.actionItems = [];
  result.interviewQuestions = [];
  return result;
}
beforeEach(() => {
  state.parse.mockReset();
  state.constructor.mockClear();
  vi.stubEnv("OPENAI_API_KEY", "synthetic-only");
  vi.stubEnv("OPENAI_MODEL", "mock-model");
});
afterEach(() => vi.unstubAllEnvs());

describe("한 번의 근거 기반 문장 수정과 독립 재검토", () => {
  it("유효초안을 먼저 보관한 뒤 한 번 수정·재검토하며 기존 질문·확인표시를 유지한다", async () => {
    seedInitial();
    state.parse
      .mockResolvedValueOnce(answer(repaired()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const calls: string[] = [];
    const result = await generatePlanWithRepair(
      value(),
      candidate,
      () => {
        calls.push("guard");
      },
      {
        onInitial: (initial, review) => {
          calls.push("initial");
          expect(state.parse).toHaveBeenCalledTimes(2);
          expect(initial.sections[0].needsConfirmation).toBe(true);
          expect(review).toEqual(
            expect.arrayContaining([expect.objectContaining({ category: "fact-vs-plan" })]),
          );
        },
        beforeRepair: () => {
          calls.push("repair");
          expect(state.parse).toHaveBeenCalledTimes(2);
        },
      },
    );
    expect(result).toMatchObject({ repairStatus: "applied", attempted: true });
    expect(state.parse).toHaveBeenCalledTimes(4);
    expect(state.parse.mock.calls.map(([request]) => request.text.format.name)).toEqual([
      "business_plan",
      "business_plan_review",
      "business_plan_repair",
      "business_plan_review",
    ]);
    expect(calls.indexOf("initial")).toBeLessThan(calls.indexOf("repair"));
    expect(result.initial.sections[0].content).toContain("완료");
    expect(result.content.sections[0].content).toBe(sourceText);
    expect(result.content.sections[0].needsConfirmation).toBe(true);
    expect(result.content.sections[1].needsConfirmation).toBe(true);
    expect(result.content.actionItems).toContain("성능 검증 자료를 확인해 주세요.");
    expect(result.content.interviewQuestions).toEqual(result.initial.interviewQuestions);
    expect(result.initialReview.some((item) => item.category === "fact-vs-plan")).toBe(true);
    expect(result.finalReview.some((item) => item.category === "fact-vs-plan")).toBe(false);
    expect(result.finalReview.some((item) => item.category === "confirmation")).toBe(true);
    expect(
      state.constructor.mock.calls.every(
        ([options]) => options.maxRetries === 0 && options.baseURL === "https://api.openai.com/v1",
      ),
    ).toBe(true);
  });
  it.each(
    [
      [],
      [finding({ severity: "info" })],
      [finding({ category: "missing-evidence" })],
      [finding({ sourceIds: [] })],
      [
        finding({
          message: "성능 시험 자료가 없어 현재 수치를 검증할 수 없습니다.",
          action: "성능 시험 자료를 추가해 주세요.",
        }),
      ],
    ].map((findings) => ({ findings })),
  )(
    "문장 수정 대상이 없으면 규칙 경고가 있어도 추가 비용 호출을 만들지 않는다",
    async ({ findings }) => {
      seedInitial(findings);
      const beforeRepair = vi.fn(),
        onInitial = vi.fn();
      const result = await generatePlanWithRepair(value(), candidate, () => {}, {
        onInitial,
        beforeRepair,
      });
      expect(result.repairStatus).toBe("not-needed");
      expect(result.attempted).toBe(false);
      expect(state.parse).toHaveBeenCalledTimes(2);
      expect(onInitial).toHaveBeenCalledTimes(1);
      expect(beforeRepair).not.toHaveBeenCalled();
    },
  );
  it("재검토 뒤 남은 동일 의견은 보존하고 두 번째 수정을 요청하지 않는다", async () => {
    seedInitial();
    state.parse
      .mockResolvedValueOnce(answer(repaired()))
      .mockResolvedValueOnce(answer({ findings: [finding()] }));
    const result = await generatePlanWithRepair(value(), candidate, () => {});
    expect(result.repairStatus).toBe("unresolved");
    expect(result.finalReview).toEqual(expect.arrayContaining([finding()]));
    expect(result.content.actionItems.some((item) => item.startsWith("[AI 검토 의견"))).toBe(true);
    expect(state.parse).toHaveBeenCalledTimes(4);
  });
  it("문장을 고쳐도 같은 최초 검토에서 요구한 새 자료 요청은 지우지 않는다", async () => {
    const missingEvidence = finding({
      id: "missing-proof",
      sectionKey: "solution",
      message: "성능 시험 자료가 없어 결과를 확인할 수 없습니다.",
      action: "성능 시험 보고서를 추가해 주세요.",
    });
    seedInitial([finding(), missingEvidence]);
    state.parse
      .mockResolvedValueOnce(answer(repaired()))
      .mockResolvedValueOnce(answer({ findings: [] }));
    const result = await generatePlanWithRepair(value(), candidate, () => {});
    expect(result.repairStatus).toBe("applied");
    expect(result.content.actionItems).toEqual(
      expect.arrayContaining([expect.stringContaining(missingEvidence.action)]),
    );
    expect(
      result.content.sections.find((section) => section.key === "solution")?.needsConfirmation,
    ).toBe(true);
    expect(result.content.interviewQuestions).toEqual(result.initial.interviewQuestions);
    expect(result.initialReview).toEqual(expect.arrayContaining([missingEvidence]));
    expect(state.parse).toHaveBeenCalledTimes(4);
  });
  it.each([
    "invented-reference",
    "missing-section",
    "guarantee",
    "unrelated-section",
    "deleted-evidence",
  ])("수정본 %s는 기존 유효초안으로 되돌리고 검토사항을 지우지 않는다", async (kind) => {
    seedInitial();
    const next = repaired();
    if (kind === "invented-reference")
      next.sections[0].evidence = [{ ...evidence[0], quote: "허구의 실적" }];
    if (kind === "missing-section") next.sections.pop();
    if (kind === "guarantee") next.summary = "무조건 승인됩니다.";
    if (kind === "unrelated-section") next.sections[2].content = "원문과 관계없는 변경";
    if (kind === "deleted-evidence") next.sections[0].evidence = [];
    state.parse.mockResolvedValueOnce(answer(next)).mockResolvedValueOnce(answer({ findings: [] }));
    const result = await generatePlanWithRepair(value(), candidate, () => {});
    expect(result.repairStatus).toBe("rejected");
    expect(result.content).toEqual(result.initial);
    expect(result.finalReview).toEqual(result.initialReview);
    expect(state.parse.mock.calls.length).toBeLessThanOrEqual(4);
  });
  it.each(["new-section", "severity"])("재검토의 %s 악화는 기존 초안을 보존한다", async (kind) => {
    seedInitial();
    state.parse.mockResolvedValueOnce(answer(repaired())).mockResolvedValueOnce(
      answer({
        findings: [
          finding(
            kind === "severity"
              ? { severity: "error" }
              : { sectionKey: "funding", category: "financial-plan" },
          ),
        ],
      }),
    );
    const result = await generatePlanWithRepair(value(), candidate, () => {});
    expect(result.repairStatus).toBe("rejected");
    expect(result.content).toEqual(result.initial);
    expect(state.parse).toHaveBeenCalledTimes(4);
  });
  it.each(["repair", "rereview"])(
    "%s 통신 실패는 원문 오류를 노출하지 않고 첫 초안을 유지한다",
    async (phase) => {
      seedInitial();
      if (phase === "rereview") state.parse.mockResolvedValueOnce(answer(repaired()));
      state.parse.mockRejectedValueOnce(new Error("PRIVATE-PROVIDER-BODY"));
      const result = await generatePlanWithRepair(value(), candidate, () => {});
      expect(result.repairStatus).toBe("failed");
      expect(result.content).toEqual(result.initial);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-PROVIDER-BODY");
      expect(state.parse).toHaveBeenCalledTimes(phase === "repair" ? 3 : 4);
    },
  );
  it("잘못된 재검토 인용은 수정본을 채택하지 않는다", async () => {
    seedInitial();
    state.parse
      .mockResolvedValueOnce(answer(repaired()))
      .mockResolvedValueOnce(answer({ findings: [finding({ sourceIds: ["unknown"] })] }));
    const result = await generatePlanWithRepair(value(), candidate, () => {});
    expect(result.repairStatus).toBe("rejected");
    expect(result.content).toEqual(result.initial);
  });
  it.each(["initial-hook", "repair-hook", "repair-guard", "rereview-guard", "final-guard"])(
    "%s 오류는 실패 초안 반환으로 삼키지 않는다",
    async (point) => {
      seedInitial();
      state.parse
        .mockResolvedValueOnce(answer(repaired()))
        .mockResolvedValueOnce(answer({ findings: [] }));
      const stop = new Error("synthetic stale revision");
      let initialSaved = false,
        repairStarted = false;
      const guard = () => {
        if (point === "repair-guard" && repairStarted) throw stop;
        if (point === "rereview-guard" && state.parse.mock.calls.length === 3) throw stop;
        if (point === "final-guard" && state.parse.mock.calls.length === 4) throw stop;
      };
      await expect(
        generatePlanWithRepair(value(), candidate, guard, {
          onInitial: () => {
            initialSaved = true;
            if (point === "initial-hook") throw stop;
          },
          beforeRepair: () => {
            repairStarted = true;
            if (point === "repair-hook") throw stop;
          },
        }),
      ).rejects.toBe(stop);
      expect(initialSaved).toBe(true);
      expect(state.parse.mock.calls.length).toBeLessThanOrEqual(4);
    },
  );
  it("최초 검토가 실패하면 보관 가능한 초안으로 표시하거나 수정 요청을 보내지 않는다", async () => {
    state.parse
      .mockResolvedValueOnce(answer(draft()))
      .mockRejectedValueOnce(new Error("initial review failed"));
    const hooks = { onInitial: vi.fn(), beforeRepair: vi.fn() };
    await expect(generatePlanWithRepair(value(), candidate, () => {}, hooks)).rejects.toMatchObject(
      { code: "AI_REQUEST_FAILED" },
    );
    expect(hooks.onInitial).not.toHaveBeenCalled();
    expect(hooks.beforeRepair).not.toHaveBeenCalled();
    expect(state.parse).toHaveBeenCalledTimes(2);
  });
});
