import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type BusinessPlan,
  type ReviewFinding,
  type StudioCase,
} from "@/lib/studio-schema";
import type { GuidedPlanRepair, GuidedPreparationRun } from "@/lib/studio-guided-preparation-types";
import { GuidedRepairSummary } from "./guided-repair-summary";

const companyId = "11111111-1111-4111-8111-111111111111";
const initialPlanId = "22222222-2222-4222-8222-222222222222";
const finalPlanId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const foreignId = "66666666-6666-4666-8666-666666666666";
const candidateId = "synthetic-selected-candidate";
const now = "2026-09-26T02:00:00.000Z";
const hash = "a".repeat(64);
const initialText = "합성 자료의 기존 고객 문제 설명입니다.";
const finalText = "합성 자료의 근거와 연결한 수정 고객 문제 설명입니다.";
const initialFinding = "합성 자료와 고객 문제의 연결을 확인해 주세요.";

function finding(severity: ReviewFinding["severity"] = "warning"): ReviewFinding {
  return {
    id: `synthetic-${severity}`,
    severity,
    category: "evidence",
    message: severity === "info" ? "단순 참고 의견입니다." : initialFinding,
    action: "자료에서 해당 문장을 확인해 주세요.",
    sectionKey: "problem",
    sourceIds: [],
  };
}

function plan(final = false): BusinessPlan {
  return {
    id: final ? finalPlanId : initialPlanId,
    version: final ? 2 : 1,
    generatedAt: now,
    mode: "ai",
    candidateId,
    sourceRevision: final ? 5 : 3,
    confirmedAt: null,
    review: final ? [] : [finding(), finding("info")],
    content: {
      title: "가상 자동 수정 검증용 계획서",
      summary: "합성 자료만 사용한 계획서입니다.",
      sections: [
        {
          key: "problem",
          title: "고객의 문제",
          content: final ? finalText : initialText,
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: ["실제 사실 확인은 사용자가 진행해 주세요."],
      interviewQuestions: [],
    },
  };
}

function company(plans: BusinessPlan[] = [plan(), plan(true)]): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "합성 자동 수정 화면 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: candidateId,
    plans,
    tasks: [],
    stage: "drafting",
    revision: 6,
    createdAt: now,
    updatedAt: now,
  });
}

function run(status: GuidedPlanRepair["status"] = "applied"): GuidedPreparationRun {
  const completed = status !== "pending";
  const replaced = status === "applied" || status === "unresolved";
  const attempted = status !== "not-needed";
  return {
    id: runId,
    mode: "ai",
    approval: {
      caseId: companyId,
      revision: 2,
      provider: "OpenAI",
      model: "synthetic-model-never-called",
      inputFingerprint: hash,
      sourceIds: [],
      sourceNames: [],
      profileIncluded: true,
      businessNumberIncluded: false,
      originalFilesIncluded: false,
      derivedDraftIncluded: true,
      purpose: "analysis-plan-review",
      autoRevisionLimit: 1,
    },
    approvedAt: now,
    status: completed ? "awaiting_review" : "running",
    phase: "plan",
    analysisDigest: hash,
    candidateId,
    candidateDigest: hash,
    planId: replaced ? finalPlanId : initialPlanId,
    code: null,
    repair: {
      initialPlanId,
      finalPlanId: completed ? (replaced ? finalPlanId : initialPlanId) : null,
      status,
      attempted,
      reason: "합성 자료 범위에서 검토한 기록입니다.",
      initialReviewCount: 1,
      finalReviewCount: completed ? (replaced ? 0 : 1) : null,
      attemptedAt: attempted ? now : null,
      completedAt: completed ? now : null,
    },
    requests: [{ clientRequestId: requestId, digest: hash }],
    createdAt: now,
    updatedAt: now,
  };
}

function render(value = company(), preparation?: GuidedPreparationRun) {
  const before = structuredClone({ value, preparation });
  const html = renderToStaticMarkup(
    createElement(GuidedRepairSummary, { company: value, run: preparation }),
  );
  expect({ value, preparation }).toEqual(before);
  expect(html).not.toMatch(/<(?:button|input|form)\b/);
  return { html, text: html.replace(/<[^>]*>/g, "") };
}

const fetchGuard = vi.fn(() => {
  throw new Error("자동 수정 요약 SSR 검증에서 실제 AI를 호출하면 안 됩니다.");
});

beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("자동 수정 요약의 실제 SSR 표시", () => {
  it.each([false, true])(
    "진행 중 시도 여부 %s에서도 완료나 적용으로 표시하지 않는다",
    (attempted) => {
      const preparation = run("pending");
      preparation.repair!.attempted = attempted;
      preparation.repair!.attemptedAt = attempted ? now : null;
      const { text } = render(company(), preparation);

      expect(text).toContain("작성한 초안을 보관했어요");
      expect(text).toContain("다음 검토 미완료");
      expect(text).toContain(attempted ? "자동 수정 1회 시도" : "자동 수정 시도 없음");
      expect(text).toContain("최초 원고 v1 유지");
      expect(text).not.toContain("계획서를 수정하고 다시 점검했어요");
      expect(text).not.toContain("수정 전·후");
      expect(text).not.toContain(finalText);
    },
  );

  it("적용된 수정의 전후 본문과 의견 수를 보여 주되 승인이나 추가 동의를 만들지 않는다", () => {
    const { html, text } = render(company(), run());

    expect(text).toContain("계획서를 수정하고 다시 점검했어요");
    expect(text).toContain("자동 수정 1회 시도 · 최초 원고 v1 → 수정 원고 v2");
    expect(text).toContain("확인 의견 1개 → 0개");
    expect(text).toContain("의견 수는 승인 가능성이나 심사 점수가 아닙니다");
    expect(text).toContain("사실·수치의 확인과 제출 전 검토는 별도로 진행해 주세요");
    expect(text).toContain("고객의 문제 수정 전·후");
    expect(text).toContain(initialText);
    expect(text).toContain(finalText);
    expect(html.indexOf(initialText)).toBeLessThan(html.indexOf(finalText));
    expect(text).not.toContain("승인 완료");
    expect(text).not.toContain("제출 완료");
    expect(text).not.toContain("동의해 주세요");
  });

  it("남은 확인 의견은 수정본과 함께 표시하고 완료로 숨기지 않는다", () => {
    const preparation = run("unresolved");
    preparation.repair!.finalReviewCount = 1;
    const final = plan(true);
    final.review = [finding()];
    const { text } = render(company([plan(), final]), preparation);

    expect(text).toContain("수정본을 보관했어요. 확인할 내용이 남아 있어요");
    expect(text).toContain("확인 의견 1개 → 1개");
    expect(text).toContain(initialText);
    expect(text).toContain(finalText);
    expect(text).not.toContain("검토 완료");
  });

  it("수정이 필요 없으면 처음 검토한 원고를 유지하고 시도 횟수를 늘리지 않는다", () => {
    const preparation = run("not-needed");
    preparation.repair!.initialReviewCount = 0;
    preparation.repair!.finalReviewCount = 0;
    const initial = plan();
    initial.review = [];
    const { text } = render(company([initial, plan(true)]), preparation);

    expect(text).toContain("작성·검토 결과를 보관했어요");
    expect(text).toContain("자동 수정 시도 없음 · 최초 원고 v1 유지");
    expect(text).not.toContain("1회 시도");
    expect(text).not.toContain(finalText);
    expect(text).not.toContain("수정 전·후");
  });

  it.each([
    ["rejected", "이전 원고를 보관했어요. 수정안은 적용하지 않았어요"],
    ["failed", "원고는 보관했어요. 자동 수정을 마치지 못했어요"],
  ] as const)(
    "%s면 다른 수정안이 목록에 있어도 이전 원고의 검토 이력만 표시한다",
    (status, label) => {
      const { text } = render(company(), run(status));

      expect(text).toContain(label);
      expect(text).toContain("최초 원고 v1 유지");
      expect(text).toContain(initialFinding);
      expect(text).not.toContain(finalText);
      expect(text).not.toContain("수정 원고 v2");
      expect(text).not.toContain("수정 전·후");
    },
  );

  it("수정 중 중단되어 최종 원고가 없어도 보관된 초안과 검토 미완료를 알린다", () => {
    const preparation = run("failed");
    preparation.status = "failed";
    preparation.repair!.finalPlanId = null;
    preparation.repair!.finalReviewCount = null;
    const { text } = render(company([plan()]), preparation);

    expect(text).toContain("원고는 보관했어요. 자동 수정을 마치지 못했어요");
    expect(text).toContain("최초 원고 v1 유지");
    expect(text).toContain("다음 검토 미완료");
    expect(text).not.toContain("계획서를 수정하고 다시 점검했어요");
  });

  it("처음 발견한 확인 의견을 보존하고 단순 참고 의견은 별도 과제로 부풀리지 않는다", () => {
    const { text } = render(company(), run());

    expect(text).toContain("처음 발견한 확인 의견");
    expect(text).toContain(initialFinding);
    expect(text).not.toContain("단순 참고 의견입니다");
  });

  it("다른 기업에 승인된 실행의 수정 이력을 숨긴다", () => {
    const preparation = run();
    preparation.approval.caseId = foreignId;
    expect(render(company(), preparation).html).toBe("");
  });

  it("최초 원고와 실행의 신청 주제가 다르면 이력을 숨긴다", () => {
    const preparation = run();
    preparation.candidateId = "another-synthetic-candidate";
    expect(render(company(), preparation).html).toBe("");
  });

  it("수정 원고가 다른 신청 주제에 속하면 이력을 숨긴다", () => {
    const final = plan(true);
    final.candidateId = "another-synthetic-candidate";
    expect(render(company([plan(), final]), run()).html).toBe("");
  });

  it("최초 원고가 없으면 수정 이력과 이전 본문을 만들어 내지 않는다", () => {
    expect(render(company([plan(true)]), run()).html).toBe("");
  });

  it("완료 기록의 최종 ID에 해당하는 원고가 없으면 적용을 주장하지 않는다", () => {
    expect(render(company([plan()]), run()).html).toBe("");
  });

  it.each(["applied", "unresolved", "not-needed", "rejected"] as const)(
    "%s 기록에 최종 원고 연결이 없으면 완료 결과를 보여 주지 않는다",
    (status) => {
      const preparation = run(status);
      preparation.repair!.finalPlanId = null;
      preparation.planId = initialPlanId;
      expect(render(company(), preparation).html).toBe("");
    },
  );

  it("실행의 현재 원고와 수정 이력의 최종 원고가 다르면 이력을 숨긴다", () => {
    const preparation = run();
    preparation.planId = initialPlanId;
    expect(render(company(), preparation).html).toBe("");
  });

  it.each(["not-needed", "failed", "rejected"] as const)(
    "%s 기록이 다른 최종 원고를 가리키면 적용하지 않았다는 설명으로 수정안을 노출하지 않는다",
    (status) => {
      const preparation = run(status);
      preparation.planId = finalPlanId;
      preparation.repair!.finalPlanId = finalPlanId;
      expect(render(company(), preparation).html).toBe("");
    },
  );

  it("진행 중 기록에 최종 원고가 연결되어 있어도 완료된 전후 비교를 노출하지 않는다", () => {
    const preparation = run("pending");
    preparation.planId = finalPlanId;
    preparation.repair!.finalPlanId = finalPlanId;
    expect(render(company(), preparation).html).toBe("");
  });

  it("실행이나 수정 기록이 없는 기존 기업에는 빈 요약을 추가하지 않는다", () => {
    expect(render(company()).html).toBe("");
    const preparation = run();
    delete preparation.repair;
    delete preparation.approval.autoRevisionLimit;
    expect(render(company(), preparation).html).toBe("");
  });
});
