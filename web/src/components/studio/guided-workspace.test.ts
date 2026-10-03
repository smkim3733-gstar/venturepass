import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  caseSchema,
  emptyProfile,
  type BusinessPlan,
  type StudioCase,
  type StudioStatus,
} from "@/lib/studio-schema";
import type { GuidedPreparationRun } from "@/lib/studio-guided-preparation-types";
import { GuidedWorkspace } from "./guided-workspace";

const companyId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const earlier = "2026-09-26T01:00:00.000Z";
const now = "2026-09-26T02:00:00.000Z";
const hash = "a".repeat(64);
const oldPlanTitle = "이전 버전만의 가상 계획서 제목";
const newCandidateTitle = "이번 분석의 가상 센서 진단 기술";
const navLabels = ["자료 올리기", "AI 계획서", "신청·진행"];

function company(change: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "합성 화면 검증 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 4,
    createdAt: earlier,
    updatedAt: now,
    ...change,
  });
}

function plan(change: Partial<BusinessPlan> = {}): BusinessPlan {
  return {
    id: planId,
    version: 1,
    generatedAt: earlier,
    mode: "ai",
    candidateId: "synthetic-old-candidate",
    sourceRevision: 1,
    confirmedAt: null,
    review: [],
    content: {
      title: oldPlanTitle,
      summary: "이전 자료로 만든 합성 원고입니다.",
      sections: [
        {
          key: "problem",
          title: "고객의 문제",
          content: "이전 가상 고객의 문제를 설명하는 본문입니다.",
          evidence: [],
          needsConfirmation: false,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
    ...change,
  };
}

function run(status: GuidedPreparationRun["status"]): GuidedPreparationRun {
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
    },
    approvedAt: now,
    status,
    phase: status === "awaiting_choice" ? "analysis" : "plan",
    analysisDigest: hash,
    candidateId: status === "awaiting_review" ? "synthetic-old-candidate" : null,
    candidateDigest: status === "awaiting_review" ? hash : null,
    planId: status === "awaiting_review" ? planId : null,
    code: status === "failed" ? "GUIDED_FAILED" : null,
    requests: [{ clientRequestId: requestId, digest: hash }],
    createdAt: now,
    updatedAt: now,
  };
}

const configured: StudioStatus = {
  aiConfigured: true,
  model: "synthetic-model-never-called",
  storage: "local",
  supportedFiles: [".txt"],
};

function render(
  companyValue = company(),
  change: Partial<ComponentProps<typeof GuidedWorkspace>> = {},
) {
  const callbacks = {
    onCompany: vi.fn(),
    onBusyChange: vi.fn(),
    onUnsettledChange: vi.fn(),
    setDirty: vi.fn(),
    mutate: vi.fn<() => Promise<StudioCase | null>>().mockResolvedValue(null),
    onDetails: vi.fn(),
    onSettings: vi.fn(),
  };
  const html = renderToStaticMarkup(
    createElement(GuidedWorkspace, {
      company: companyValue,
      status: configured,
      busy: "",
      blocked: false,
      ...callbacks,
      ...change,
    }),
  );
  for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  return html;
}

function buttonLabels(html: string) {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    match[1].replace(/<[^>]*>/g, "").trim(),
  );
}

const fetchGuard = vi.fn(() => {
  throw new Error("SSR 화면 검증에서 외부 요청을 실행하면 안 됩니다.");
});

beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});

afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("일반 작업 화면의 실제 상태별 렌더링", () => {
  it("기록된 평가 대기는 주 실행 없이 수동 기록과 공식 확인 시각 부재를 안내한다", () => {
    const html = render(company({ stage: "evaluating" }));
    expect(html).toContain("공식 사이트 자동 조회 미연결");
    expect(html).toContain("사용자 기록");
    expect(html).toContain("다음 안내를 기다리고 있어요");
    expect(html).not.toMatch(/class="[^"]*primary[^"]*"/);
    expect(buttonLabels(html)).not.toContain("진행 기록 보기");
    expect(buttonLabels(html)).toContain("기관 안내와 진행 기록");
  });

  it("대기 중 보류된 단순 준비 업무 때문에 불필요한 주 실행을 만들지 않는다", () => {
    const html = render(
      company({
        stage: "evaluating",
        tasks: [
          {
            id: requestId,
            title: "이미 마친 합성 업무",
            category: "supplement",
            status: "done",
            dueDate: "2026-09-27",
            notes: "합성",
          },
        ],
      }),
    );
    expect(html).not.toMatch(/class="[^"]*primary[^"]*"/);
    expect(html).not.toContain("지금 할 일 확인하기");
  });

  it("대응할 업무가 있으면 한 개의 주 실행과 정확한 업무 제목·기한을 보여 준다", () => {
    const html = render(
      company({
        stage: "evaluating",
        tasks: [
          {
            id: requestId,
            title: "가상 추가 근거 모으기",
            category: "supplement",
            status: "pending",
            dueDate: "2026-09-29",
            notes: "합성",
          },
        ],
      }),
    );
    expect(html).toContain("가상 추가 근거 모으기");
    expect(html).toContain("2026-09-29");
    expect(html.match(/class="[^"]*primary[^"]*"/g)).toHaveLength(1);
    expect(html).not.toContain("접수 완료로 확인");
  });

  it("시작 화면에 세 단계만 안내하고 파일 없는 시작 경로를 제공한다", () => {
    const html = render();
    const navigation = html.match(
      /<nav\b[^>]*aria-label="신청 준비 3단계"[^>]*>([\s\S]*?)<\/nav>/,
    )?.[1];
    expect(navigation).toBeDefined();
    const labels = buttonLabels(navigation!);
    expect(labels).toEqual(navLabels.map((label, index) => `${index + 1}${label}`));
    expect(navigation?.match(/aria-current="step"/g)).toHaveLength(1);
    expect(buttonLabels(html)).toContain("자료 없이 회사 설명부터 시작");
    expect(html).not.toContain("신청 준비 완료");
    expect(html).toContain("저장된 자료 0개");
    expect(html).toContain("아직 저장된 자료가 없습니다");
    expect(html).toContain("워드(DOCX)");
  });

  it("이전 원고가 있어도 새 분석이 선택 대기면 새 신청 주제를 보여 준다", () => {
    const value = company({
      plans: [plan()],
      guidedPreparationRuns: [run("awaiting_choice")],
      analysis: {
        summary: "새 가상 자료의 분석",
        facts: [],
        candidates: [
          {
            id: "synthetic-new-candidate",
            title: newCandidateTitle,
            problem: "가상 설비의 진단이 늦습니다.",
            solution: "가상 센서로 진단 정보를 모읍니다.",
            targetCustomer: "가상 시험 고객",
            differentiation: "실제 시험으로 확인할 예정입니다.",
            stage: "개발 중",
            businessModel: "도입 비용 검토",
            recommendation: "새로 올린 가상 기술 설명과 연결됩니다.",
            evidence: [],
            gaps: ["시험 자료 확인 필요"],
          },
        ],
        questions: [],
        warnings: [],
        generatedAt: now,
        mode: "ai",
        sourceRevision: 2,
      },
    });
    const html = render(value);
    expect(html).toContain(newCandidateTitle);
    expect(buttonLabels(html)).toContain("이 주제로 작성");
    expect(html).not.toContain(oldPlanTitle);
    expect(html).not.toContain("준비한 계획서를 확인해 주세요");
    expect(value.plans[0].content.title).toBe(oldPlanTitle);
  });

  it("이전 원고가 있어도 새 준비가 실패하면 원고 대신 복구 안내를 먼저 보여 준다", () => {
    const html = render(company({ plans: [plan()], guidedPreparationRuns: [run("failed")] }));
    expect(html).toContain("AI 준비가 중간에 멈췄어요");
    expect(html).toContain("자동으로 다시 보내지 않았습니다");
    expect(buttonLabels(html)).toContain("이전 원고 확인");
    expect(buttonLabels(html)).toContain("확인 후 다시 준비");
    expect(html).not.toContain(oldPlanTitle);
    expect(html).not.toContain("검토 마치고 신청 준비");
  });

  it("AI 미연결이면 회사 설명을 보관한 상태로 연결 필요를 알린다", () => {
    const value = company({
      profile: {
        ...emptyProfile(),
        companyName: "합성 미연결 기업",
        technologySummary: "합성 기술 설명",
      },
    });
    const html = render(value, { status: { ...configured, aiConfigured: false } });
    expect(html).toContain("AI 서비스 연결이 필요해요");
    expect(html).toContain("자료는 보관되어 있습니다");
    expect(buttonLabels(html)).toContain("AI 연결 상태 확인");
    expect(buttonLabels(html)).not.toContain("AI로 계획서 준비");
    expect(html).not.toContain("AI 작성 · 사용자 검토 필요");
  });

  it("실행 중 기록은 조회 복구만 제공하고 새 전송·기존 원고 확인으로 우회하지 않는다", () => {
    const html = render(company({ plans: [plan()], guidedPreparationRuns: [run("running")] }));
    const actions = buttonLabels(html).filter((label) => !/^\d/.test(label));
    expect(actions).toEqual(["저장 상태 확인"]);
    expect(html).toContain("결과가 불명확한 작업을 자동으로 반복하지 않습니다");
    expect(html).not.toContain(oldPlanTitle);
    expect(html).not.toContain("확인 후 다시 준비");
    expect(html).not.toContain("허용하고 AI 준비 시작");
  });

  it("독립 AI 검토의 상세 접두어가 있는 보완 의견을 사용자에게 보여 준다", () => {
    const value = plan();
    const finding = "[AI 검토 의견 · 근거 부족] 가상 성능 수치의 시험 자료를 확인하세요.";
    value.content.actionItems = [finding];
    const html = render(
      company({ plans: [value], guidedPreparationRuns: [run("awaiting_review")] }),
    );
    expect(html).toContain("확인할 내용이 남아 있어요");
    expect(html).toContain(finding);
    expect(html).toContain(oldPlanTitle);
  });

  it("실제 처리 중에는 상태 안내만 보여 주고 추가 작업 버튼을 만들지 않는다", () => {
    const message = "합성 검증: 준비 결과 확인 중";
    const html = render(company(), { busy: message });
    expect(html).toContain('role="status"');
    expect(html).toContain(message);
    expect(buttonLabels(html).filter((label) => !/^\d/.test(label))).toEqual([]);
    expect([...html.matchAll(/<button\b[^>]*>/g)]).toHaveLength(3);
    for (const match of html.matchAll(/<button\b[^>]*>/g)) expect(match[0]).toContain("disabled");
  });

  it("자료 기반 정리본을 실제 AI 작성 결과로 표시하지 않는다", () => {
    const html = render(company({ plans: [plan({ mode: "assisted" })] }));
    expect(html).toContain("자료 기반 정리본 · AI 작성 아님");
    expect(html).not.toContain("AI 작성 · 사용자 검토 필요");
  });
});
