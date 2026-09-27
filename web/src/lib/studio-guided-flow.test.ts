import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, type BusinessPlan, type StudioCase } from "./studio-schema";
import type { AgencyRequestRecord } from "./studio-agency-records";
import type { PreparationRun } from "./studio-preparation-types";
import type { GuidedPreparationRun } from "./studio-guided-preparation-types";
import { deriveGuidedFlow } from "./studio-guided-flow";

const earlier = "2026-09-26T01:00:00.000Z";
const now = "2026-09-26T02:00:00.000Z";
const later = "2026-09-26T03:00:00.000Z";
const hash = "a".repeat(64);

function company(): StudioCase {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 안내 테스트 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 8,
    createdAt: earlier,
    updatedAt: now,
  });
}

function plan(version = 1): BusinessPlan {
  return {
    id: randomUUID(),
    version,
    generatedAt: now,
    mode: "manual",
    candidateId: "synthetic",
    sourceRevision: 3,
    confirmedAt: now,
    review: [],
    content: {
      title: "합성 계획서",
      summary: "검증용 합성 내용",
      sections: [
        {
          key: "problem",
          title: "합성 항목",
          content: "합성 본문",
          evidence: [],
          needsConfirmation: false,
        },
      ],
      actionItems: [],
      interviewQuestions: [],
    },
  };
}

function reviewedCompany(): StudioCase {
  const value = company();
  const candidate = {
    id: "synthetic",
    title: "합성 주제",
    problem: "합성 문제",
    solution: "합성 해결",
    targetCustomer: "합성 고객",
    differentiation: "합성 차이",
    stage: "개발 중",
    businessModel: "합성 수익",
    recommendation: "합성 추천",
    evidence: [],
    gaps: [],
  };
  value.analysis = {
    summary: "합성 분석",
    facts: [],
    candidates: [candidate],
    questions: [],
    warnings: [],
    generatedAt: earlier,
    mode: "assisted",
    sourceRevision: 3,
  };
  value.selectedCandidateId = candidate.id;
  value.candidateSelections = [
    {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: hash,
      recordedAt: earlier,
      origin: "manual",
      event: "selection",
      reason: "합성 선택 이유",
      previousCandidateId: null,
      candidateId: candidate.id,
      analysisGeneratedAt: earlier,
      analysisSourceRevision: 3,
      analysisMode: "assisted",
      analysisDigest: hash,
      candidateDigest: hash,
      candidate,
      previousCandidate: null,
      previousContext: "none",
      previousRecordId: null,
    },
  ];
  value.plans = [plan()];
  return value;
}

function pendingSource(value: StudioCase) {
  value.sources.push({
    id: randomUUID(),
    name: "합성 원본",
    kind: "other",
    text: "",
    originalName: "synthetic.pdf",
    mimeType: "application/pdf",
    extraction: "pending",
    warnings: [],
    createdAt: earlier,
    updatedAt: earlier,
  });
}

function run(status: PreparationRun["status"], stale = false): PreparationRun {
  return {
    id: randomUUID(),
    mode: "assisted",
    inputFingerprint: hash,
    criteriaVersion: "synthetic",
    sourceRevision: 3,
    createdAt: earlier,
    updatedAt: now,
    status,
    phase: "plan",
    stale,
    code: null,
    diagnosisId: null,
    analysisDigest: hash,
    candidates: [],
    selectedCandidateId: "synthetic",
    selectedCandidateDigest: hash,
    planId: null,
    planDigest: null,
    steps: [],
    requests: [{ clientRequestId: randomUUID(), digest: hash }],
  };
}

function request(): AgencyRequestRecord {
  const id = randomUUID();
  return {
    id,
    clientRequestId: randomUUID(),
    inputDigest: hash,
    kind: "request",
    requestRecordId: id,
    requestVersionId: id,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "합성 기관",
    title: "합성 보완 요청",
    body: "합성 요청 내용",
    occurredOn: "2026-09-26",
    dueOn: "",
    dueNote: "",
    note: "",
    responseStatus: null,
    evidence: [],
  };
}

function guidedRun(
  value: StudioCase,
  status: GuidedPreparationRun["status"],
): GuidedPreparationRun {
  return {
    id: randomUUID(),
    mode: "ai",
    approvedAt: earlier,
    status,
    phase: status === "awaiting_choice" || status === "awaiting_materials" ? "analysis" : "plan",
    analysisDigest: hash,
    candidateId: status === "awaiting_review" ? "synthetic" : null,
    candidateDigest: status === "awaiting_review" ? hash : null,
    planId: status === "awaiting_review" ? (value.plans.at(-1)?.id ?? null) : null,
    code: null,
    requests: [{ clientRequestId: randomUUID(), digest: hash }],
    createdAt: earlier,
    updatedAt: now,
    approval: {
      caseId: value.id,
      revision: 1,
      provider: "OpenAI",
      model: "synthetic-model",
      inputFingerprint: hash,
      sourceIds: value.sources
        .filter((source) => source.extraction !== "pending")
        .map((source) => source.id),
      sourceNames: value.sources
        .filter((source) => source.extraction !== "pending")
        .map((source) => source.name),
      profileIncluded: true,
      businessNumberIncluded: false,
      originalFilesIncluded: false,
      derivedDraftIncluded: true,
      purpose: "analysis-plan-review",
    },
  };
}

function currentApproval(value: StudioCase) {
  return { caseId: value.id, revision: value.revision, inputFingerprint: hash };
}

describe("일반 화면의 3단계 안내", () => {
  it("자료가 없는 새 회사에는 한 가지 자료 등록 행동을 안내한다", () => {
    const result = deriveGuidedFlow(company());
    expect(result).toMatchObject({
      step: "materials",
      planReady: false,
      action: { destination: "sources" },
    });
    expect(result.description).toContain("파일이 없으면 회사 설명");
  });

  it("파일이 없어도 회사 설명이 있으면 준비를 시작할 수 있다", () => {
    const value = company();
    value.profile.technologySummary = "합성 기술 설명";
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "plan",
      planReady: false,
      action: { destination: "diagnosis" },
    });
  });

  it("원본만 보관한 자료는 확인을 요청하고 준비 완료로 표시하지 않는다", () => {
    const value = reviewedCompany();
    pendingSource(value);
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "materials",
      planReady: false,
      action: { destination: "sources" },
    });
  });

  it("준비 근거가 충분한 원고는 내부 검토 상태와 신청 준비 동선을 구분한다", () => {
    const result = deriveGuidedFlow(reviewedCompany());
    expect(result).toMatchObject({
      step: "application",
      planReady: true,
      action: { destination: "venturein" },
    });
    expect(result.description).toContain("내부 검토 기록");
    expect(result.title).not.toMatch(/완료|발급|승인/);
  });

  it.each(["unconfirmed", "section", "error", "confirmation", "empty"])(
    "원고의 %s 조건을 내부 검토 완료로 승격하지 않는다",
    (condition) => {
      const value = reviewedCompany();
      const latest = value.plans[0];
      if (condition === "unconfirmed") latest.confirmedAt = null;
      if (condition === "section") latest.content.sections[0].needsConfirmation = true;
      if (condition === "empty") latest.content.sections = [];
      if (condition === "error" || condition === "confirmation")
        latest.review.push({
          id: "synthetic-finding",
          severity: condition === "error" ? "error" : "warning",
          category: condition,
          message: "합성 확인 필요",
          action: "합성 검토",
          sectionKey: null,
          sourceIds: [],
        });
      expect(deriveGuidedFlow(value)).toMatchObject({
        step: "plan",
        planReady: false,
        action: { destination: "plan" },
      });
    },
  );

  it("자료와 무관한 기업 revision 증가만으로 원고를 오래된 것으로 처리하지 않는다", () => {
    const value = reviewedCompany();
    value.revision = 100;
    expect(deriveGuidedFlow(value).planReady).toBe(true);
  });

  it("원고 이후 수정한 자료는 원고 재확인으로 연결한다", () => {
    const value = reviewedCompany();
    pendingSource(value);
    value.sources[0] = {
      ...value.sources[0],
      extraction: "manual",
      text: "수정한 합성 자료",
      updatedAt: later,
    };
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "plan",
      planReady: false,
      action: { destination: "diagnosis" },
    });
  });

  it("새 분석의 근거 revision과 원고가 다르면 재확인을 안내한다", () => {
    const value = reviewedCompany();
    value.analysis!.sourceRevision = 4;
    expect(deriveGuidedFlow(value)).toMatchObject({
      planReady: false,
      action: { destination: "diagnosis" },
    });
  });

  it("현재 선택 주제가 다른 원고를 신청 준비로 보내지 않는다", () => {
    const value = reviewedCompany();
    value.selectedCandidateId = "other";
    expect(deriveGuidedFlow(value)).toMatchObject({
      planReady: false,
      action: { destination: "diagnosis" },
    });
  });

  it("저장 배열 순서와 관계없이 가장 최근 버전을 검토한다", () => {
    const value = reviewedCompany();
    const latest = plan(2);
    latest.confirmedAt = null;
    value.plans.unshift(latest);
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "plan",
      planReady: false,
      action: { destination: "plan" },
    });
  });

  it("선택 확인 기록이 없으면 원고 확인 기록만으로 신청 준비를 표시하지 않는다", () => {
    const value = reviewedCompany();
    value.candidateSelections = [];
    expect(deriveGuidedFlow(value).planReady).toBe(false);
  });

  it("stale 준비 기록은 이전 원고 확인보다 우선한다", () => {
    const value = reviewedCompany();
    value.preparationRuns = [run("awaiting_review", true)];
    expect(deriveGuidedFlow(value)).toMatchObject({
      planReady: false,
      action: { destination: "diagnosis" },
    });
  });

  it.each(["blocked", "awaiting_choice", "awaiting_materials", "running", "failed"] as const)(
    "%s 준비 기록이 남으면 원고 확인 기록만으로 준비 완료 표시를 허용하지 않는다",
    (status) => {
      const value = reviewedCompany();
      value.preparationRuns = [run(status)];
      expect(deriveGuidedFlow(value).planReady).toBe(false);
    },
  );

  it.each(["running", "failed"] as const)(
    "저장된 %s 상태를 현재 실행 중으로 오인하지 않는다",
    (status) => {
      const value = company();
      value.preparationRuns = [run(status)];
      const result = deriveGuidedFlow(value);
      expect(result.title).toContain("저장된 준비 상태");
      expect(result.action?.destination).toBe("diagnosis");
    },
  );

  it("실제 실행 중 옵션에만 추가 실행 버튼을 숨긴다", () => {
    const result = deriveGuidedFlow(company(), {
      busy: true,
      busyMessage: "자료를 보관하고 있어요",
    });
    expect(result.action).toBeNull();
    expect(result.title).toBe("자료를 보관하고 있어요");
  });

  it("현재 보완 요청은 이전 원고와 자료 판독 안내보다 우선한다", () => {
    const value = reviewedCompany();
    pendingSource(value);
    value.agencyRecords = [request()];
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "application",
      planReady: false,
      action: {
        label: "답변 준비하기",
        destination: "workflow",
        workflowTarget: { kind: "response", requestVersionId: value.agencyRecords[0].id },
      },
    });
  });

  it("이전 요청에 발송 기록이 있어도 요청이 정정되면 새 보완을 안내한다", () => {
    const value = company();
    const initial = request();
    const response: AgencyRequestRecord = {
      ...initial,
      id: randomUUID(),
      clientRequestId: randomUUID(),
      kind: "response",
      version: 1,
      responseStatus: "reported-sent",
      previousVersionId: null,
    };
    value.agencyRecords = [initial, response];
    expect(deriveGuidedFlow(value).action).toBeNull();
    expect(deriveGuidedFlow(value).followup?.state).toBe("waiting");
    const correctionId = randomUUID();
    value.agencyRecords.push({
      ...initial,
      id: correctionId,
      clientRequestId: randomUUID(),
      kind: "request-correction",
      requestVersionId: correctionId,
      previousVersionId: initial.id,
      version: 2,
    });
    expect(deriveGuidedFlow(value).action).toMatchObject({
      label: "답변 준비하기",
      workflowTarget: { requestRecordId: initial.id, requestVersionId: correctionId },
    });
  });

  it.each(["submitted", "evaluating", "confirmed"] as const)(
    "수동 %s 상태를 공식 완료라고 부르지 않는다",
    (stage) => {
      const value = company();
      value.stage = stage;
      const result = deriveGuidedFlow(value);
      expect(result).toMatchObject({ step: "application", planReady: false });
      expect(result.action).toBeNull();
      expect(result.followup).toMatchObject({
        state: "waiting",
        provenance: "manual",
        lastCheckedAt: null,
      });
      expect(result.description).toContain("자동으로 확인한 것은 아닙니다");
    },
  );

  it("완료한 보완 업무는 다음 행동으로 다시 요구하지 않는다", () => {
    const value = company();
    value.tasks = [
      {
        id: randomUUID(),
        title: "합성 보완",
        category: "supplement",
        dueDate: "",
        status: "done",
        notes: "",
      },
    ];
    expect(deriveGuidedFlow(value).step).toBe("materials");
    value.tasks[0].status = "pending";
    expect(deriveGuidedFlow(value).action?.destination).toBe("workflow");
  });

  it("준비 중의 자료 확보 업무를 신청 후 기관 업무로 잘못 분류하지 않는다", () => {
    const value = company();
    value.tasks = [
      {
        id: randomUUID(),
        title: "합성 자료 준비",
        category: "evidence",
        dueDate: "",
        status: "pending",
        notes: "",
      },
    ];
    expect(deriveGuidedFlow(value).step).toBe("materials");
  });

  it("부족한 근거의 보강 경로를 제공하며 입력 자료는 바꾸지 않는다", () => {
    const value = company();
    value.preparationRuns = [run("awaiting_materials")];
    const before = structuredClone(value);
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "materials",
      action: { destination: "profile" },
    });
    expect(value).toEqual(before);
  });
});

describe("새 AI 준비 기록과 이전 원고를 구분하는 안내", () => {
  it("선택 대기인 새 분석이 있으면 이전 확인 원고보다 새 신청 방향을 먼저 안내한다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_choice")];
    value.selectedCandidateId = null;
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "plan",
      planReady: false,
      action: { label: "신청 방향 확인하기", destination: "analysis" },
    });
  });

  it("현재 후보 선택이 확인돼도 이전 원고를 쓰지 않고 새 작성을 이어가도록 안내한다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_choice")];
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "plan",
      planReady: false,
      action: { label: "선택한 주제로 작성 이어가기", destination: "plan" },
    });
  });

  it("새 AI 분석에서 근거가 부족하면 기존 원고 확인 상태와 무관하게 자료 보완으로 보낸다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_materials")];
    expect(deriveGuidedFlow(value)).toMatchObject({
      step: "materials",
      planReady: false,
      action: { destination: "profile" },
    });
  });

  it.each(["running", "failed"] as const)(
    "AI의 %s 기록을 이전 원고로 덮지 않고 저장 상태 확인으로 보낸다",
    (status) => {
      const value = reviewedCompany();
      value.guidedPreparationRuns = [guidedRun(value, status)];
      expect(deriveGuidedFlow(value)).toMatchObject({
        step: "plan",
        planReady: false,
        action: { label: "AI 준비 상태 확인하기", destination: "plan" },
      });
    },
  );

  it("저장된 AI running 기록은 자료 추가보다 먼저 확인하지만 기관 요청을 덮지 않는다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "running")];
    pendingSource(value);
    expect(deriveGuidedFlow(value).action?.label).toBe("AI 준비 상태 확인하기");
    value.agencyRecords.push(request());
    expect(deriveGuidedFlow(value).action?.label).toBe("답변 준비하기");
  });

  it("원고 확인 기록이 있어도 업종·본문의 fingerprint 일치는 서버 확인 전 단정하지 않는다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_review")];
    value.profile.industry = "변경한 합성 업종";
    const result = deriveGuidedFlow(value);
    expect(result).toMatchObject({
      step: "plan",
      planReady: false,
      guidedInputState: "unverified",
    });
    expect(result.description).toContain("같은지 아직 확인하지 못했습니다");
  });

  it("현재 기업·revision에 묶인 서버 확인 결과만 입력 범위 일치 판단에 사용한다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_review")];
    expect(deriveGuidedFlow(value, { guidedApproval: currentApproval(value) })).toMatchObject({
      step: "application",
      planReady: true,
      guidedInputState: "current",
    });
    expect(
      deriveGuidedFlow(value, {
        guidedApproval: { ...currentApproval(value), revision: value.revision - 1 },
      }),
    ).toMatchObject({
      planReady: false,
      guidedInputState: "unverified",
    });
    expect(
      deriveGuidedFlow(value, {
        guidedApproval: { ...currentApproval(value), caseId: randomUUID() },
      }),
    ).toMatchObject({
      planReady: false,
      guidedInputState: "unverified",
    });
  });

  it("서버가 다른 자료 fingerprint를 확인하면 이전 완료 원고와 새 선택을 재사용하지 않는다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_choice")];
    const result = deriveGuidedFlow(value, {
      guidedApproval: { ...currentApproval(value), inputFingerprint: "b".repeat(64) },
    });
    expect(result).toMatchObject({ planReady: false, guidedInputState: "changed" });
    expect(result.action?.label).toBe("현재 준비 범위 확인하기");
  });

  it("서버 조회가 없어도 새 자료 추가로 확인된 범위 변경은 감지한다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_review")];
    pendingSource(value);
    value.sources[0] = { ...value.sources[0], extraction: "manual", text: "합성 추가 자료" };
    expect(deriveGuidedFlow(value)).toMatchObject({
      planReady: false,
      guidedInputState: "changed",
    });
  });

  it("AI 결과의 연결 원고가 사라지면 이전 원고로 완료를 대체하지 않는다", () => {
    const value = reviewedCompany();
    const generated = guidedRun(value, "awaiting_review");
    generated.planId = randomUUID();
    value.guidedPreparationRuns = [generated];
    const result = deriveGuidedFlow(value, { guidedApproval: currentApproval(value) });
    expect(result).toMatchObject({ step: "plan", planReady: false });
    expect(result.title).toBe("이번 AI 작성 결과를 확인해 주세요");
  });

  it("완료한 새 AI 원고는 과거 assisted 준비의 stale 상태로 되돌리지 않는다", () => {
    const value = reviewedCompany();
    value.preparationRuns = [run("awaiting_review", true)];
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_review")];
    expect(deriveGuidedFlow(value, { guidedApproval: currentApproval(value) })).toMatchObject({
      step: "application",
      planReady: true,
    });
  });

  it("AI 원고를 수정한 새 수동 버전은 같은 주제·근거의 검토 대상이다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_review")];
    const revised: BusinessPlan = { ...plan(2), generatedAt: later, confirmedAt: null };
    value.plans.push(revised);
    expect(deriveGuidedFlow(value, { guidedApproval: currentApproval(value) })).toMatchObject({
      step: "plan",
      planReady: false,
      action: { label: "계획서 확인하기" },
    });
    revised.confirmedAt = later;
    expect(deriveGuidedFlow(value, { guidedApproval: currentApproval(value) }).planReady).toBe(
      true,
    );
  });

  it("새 버전이라도 다른 주제의 원고를 AI 결과의 수정본으로 보지 않는다", () => {
    const value = reviewedCompany();
    value.guidedPreparationRuns = [guidedRun(value, "awaiting_review")];
    value.plans.push({ ...plan(2), candidateId: "different" });
    expect(deriveGuidedFlow(value, { guidedApproval: currentApproval(value) }).planReady).toBe(
      false,
    );
  });
});
