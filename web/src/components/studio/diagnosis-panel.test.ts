import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyProfile, type SourceDocument, type StudioCase } from "@/lib/studio-schema";
import {
  diagnosisCriteriaVersion,
  emptyDiagnosisAnswers,
  type Diagnosis,
  type DiagnosisAnswers,
} from "@/lib/studio-diagnosis-types";
import {
  canReviewDiagnosisAssessment,
  DiagnosisAssessmentEditor,
  DiagnosisPanel,
  DiagnosisResultView,
} from "./diagnosis-panel";

const sourceId = "22222222-2222-4222-8222-222222222222";
const now = "2026-09-25T00:00:00.000Z";
const source: SourceDocument = {
  id: sourceId,
  name: "가상 근거 자료",
  kind: "other",
  text: "현재 문서의 정확한 인용",
  originalName: "test-document.pdf",
  mimeType: "application/pdf",
  extraction: "manual",
  warnings: [],
  createdAt: now,
  updatedAt: now,
};
function assessment(): DiagnosisAnswers["sme"] {
  return {
    status: "supported",
    reviewed: true,
    note: "담당자 검토 사유",
    evidence: [{ sourceId, sourceUpdatedAt: now, quote: source.text, locator: "원본 1페이지" }],
  };
}
function diagnosis(change: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    clientRequestId: "44444444-4444-4444-8444-444444444444",
    requestDigest: "a".repeat(64),
    version: 1,
    sourceRevision: 2,
    inputFingerprint: "b".repeat(64),
    criteriaVersion: diagnosisCriteriaVersion,
    generatedAt: now,
    stale: false,
    mode: "assisted",
    outcome: "insufficient",
    items: [
      {
        id: "sme",
        title: "중소기업 해당 여부",
        area: "eligibility",
        status: "unknown",
        reason: "확인한 문서 근거가 부족합니다.",
        evidence: [
          {
            sourceId,
            sourceName: "진단 당시 자료명",
            sourceUpdatedAt: now,
            quote: "진단 당시 원문 <script>금지</script>",
            locator: "원본 1페이지",
            provenance: "documented",
          },
        ],
        unknowns: ["현재 기업의 적용 여부"],
        nextActions: ["현재 확인서를 원본과 대조"],
      },
    ],
    questions: [
      {
        id: "question-sme",
        itemId: "sme",
        question: "현재 확인한 근거가 있나요?",
        reason: "기본요건 검토에 필요합니다.",
      },
    ],
    actions: [
      { id: "action-sme", title: "현재 근거 확인", notes: "원본과 현재 기간을 대조하세요." },
    ],
    warnings: ["기관의 판단은 별도입니다."],
    ...change,
  };
}
function company(overrides: Partial<StudioCase> = {}): StudioCase {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    profile: { ...emptyProfile(), companyName: "가상 테스트 기업" },
    sources: [source],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    stageHistory: [],
    agencyRecords: [],
    sourceOcrReviews: [],
    preparationRuns: [],
    appealPreparations: [],
    applications: [],
    applicationEvents: [],
    responsePreparations: [],
    visitAnswers: [],
    planReviewDecisions: [],
    numericChecks: [],
    candidateSelections: [],
    companyContacts: [],
    claimReviews: [],
    sourceIntakes: [],
    sourceSuggestionAdoptions: [],
    applicationProcedures: [],
    criteriaVersions: [],
    applicationCriteriaBindings: [],
    preparationAutomation: { caseId: null, settings: [], events: [], batches: [], overflow: null },
    diagnosisAnswers: emptyDiagnosisAnswers(),
    diagnoses: [],
    revision: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function renderPanel(record = company()) {
  const mutate = vi.fn(),
    setDirty = vi.fn(),
    goToProfile = vi.fn(),
    goToSources = vi.fn(),
    goToAnalysis = vi.fn();
  const html = renderToStaticMarkup(
    createElement(DiagnosisPanel, {
      company: record,
      mutate,
      setDirty,
      goToProfile,
      goToSources,
      goToAnalysis,
    }),
  );
  for (const callback of [mutate, setDirty, goToProfile, goToSources, goToAnalysis])
    expect(callback).not.toHaveBeenCalled();
  return html;
}

describe("기업별 사전진단 화면", () => {
  it("기존 기업에도 확인 필요로 시작하며 진단이나 기본요건 검토를 자동 실행하지 않는다", () => {
    const record = company();
    delete (record as Partial<StudioCase>).diagnosisAnswers;
    delete (record as Partial<StudioCase>).diagnoses;
    const html = renderPanel(record);
    expect(html).toContain("아직 보관한 사전진단이 없습니다");
    expect(html).toContain("자료 부족을 요건 미충족으로 처리하지 않습니다");
    expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
    expect(html).toContain(diagnosisCriteriaVersion);
    expect(html).toContain("공식 신청불가 업종 안내");
    expect(html).toContain("업종 목록을 코드로 판독하지 않았으며");
    expect(html).toContain("자료함에서 근거 보강");
    expect(html).toContain("미확인 사항을 유지하고 아이템 분석");
  });
  it("지난 진단과 당시 원문을 보존하고 현재 자료명으로 바꾸지 않는다", () => {
    const html = renderPanel(
      company({
        diagnoses: [diagnosis({ stale: true })],
        sources: [{ ...source, name: "현재 바뀐 자료명" }],
      }),
    );
    expect(html).toContain("지난 결과 · 재진단 필요");
    expect(html).toContain("진단 당시 자료명");
    expect(html).toContain("진단 당시 원문 &lt;script&gt;금지&lt;/script&gt;");
    expect(html).toContain("현재 자료로 만든 최신 진단에서 업무를 등록");
    expect(html).toMatch(/<fieldset[^>]*disabled=""[^>]*>[\s\S]*?보강 과제를 진행 관리에 연결/);
    expect(html).not.toContain("<script>");
  });
  it("기준 버전이 바뀐 결과는 stale=false여도 현재 결과로 표시하지 않는다", () => {
    const html = renderPanel(
      company({ diagnoses: [diagnosis({ criteriaVersion: "old-criteria" })] }),
    );
    expect(html).toContain("지난 결과 · 재진단 필요");
    expect(html).not.toContain('<span class="text-xs text-muted-foreground">현재 자료 기준');
  });
  it("최신 진단을 기본 선택하며 과거 결과 선택지를 보존한다", () => {
    const latest = diagnosis({
      id: "55555555-5555-4555-8555-555555555555",
      version: 2,
      sourceRevision: 3,
    });
    const html = renderPanel(company({ diagnoses: [diagnosis(), latest] }));
    expect(html).toMatch(new RegExp(`<option value="${latest.id}" selected=""`));
    expect(html).toContain("사전진단 v2 결과");
    expect(html).toContain("v1 ·");
    expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
    expect(html).toContain("현재 확인한 근거가 있나요?");
    expect(html).toContain("선택한 보강 업무 등록");
    expect(html).toContain("현재 자료로 진단 확인");
    expect(html).toContain("생성 시각과 버전을 유지한 기존 결과");
    expect(html).not.toContain("새 진단 만들기");
  });
  it("같은 진단에서 등록한 업무는 중복 선택을 막고 삭제 후에는 다시 선택할 수 있다", () => {
    const value = diagnosis();
    const record = company({
      diagnoses: [value],
      tasks: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          title: "현재 근거 확인",
          category: "evidence",
          dueDate: "",
          status: "pending",
          notes: "",
          diagnosisOrigin: { diagnosisId: value.id, actionId: "action-sme" },
        },
      ],
    });
    const html = renderPanel(record);
    expect(html).toContain("이미 등록됨");
    expect((html.match(/<input\b[^>]*type="checkbox"[^>]*>/g) ?? []).at(-1)).toContain(
      'disabled=""',
    );
    const afterDelete = renderPanel({ ...record, tasks: [] });
    expect(afterDelete).not.toContain("이미 등록됨");
    expect((afterDelete.match(/<input\b[^>]*type="checkbox"[^>]*>/g) ?? []).at(-1)).not.toContain(
      'disabled=""',
    );
  });
  it.each(["draft_recommended", "reinforce_first", "eligibility_issue", "insufficient"] as const)(
    "%s 결과도 기관 판정이나 제출 준비 완료로 표현하지 않는다",
    (outcome) => {
      const html = renderToStaticMarkup(
        createElement(DiagnosisResultView, { diagnosis: diagnosis({ outcome }), current: true }),
      );
      expect(html).toContain("외부 AI를 사용하지 않으며");
      expect(html).toContain("심사 통과를 판정하지 않습니다");
      expect(html).toContain("원고 작성 권장은 제출 준비 완료가 아닙니다");
      expect(html).toContain("기술·고객 설명은 검토 전 참고");
      expect(html).not.toContain("통과확률");
      expect(html).not.toContain("합격점수");
    },
  );
  it("기업정보 참고 근거에 없는 개별 수정일을 만들거나 Invalid Date로 표시하지 않는다", () => {
    const value = diagnosis();
    value.items[0].evidence = [
      {
        sourceId: "profile",
        sourceName: "기업정보 · 담당자 입력",
        sourceUpdatedAt: "",
        quote: "가상 기업 설명",
        locator: "technologySummary",
        provenance: "reported",
      },
    ];
    const html = renderToStaticMarkup(
      createElement(DiagnosisResultView, { diagnosis: value, current: true }),
    );
    expect(html).toContain("개별 수정 시각 미기록 · 진단 생성 시점 기준");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("당시 자료 수정 시각");
  });
});

describe("기본요건 검토의 현재 원문 연결", () => {
  it("원문·위치·현재 자료 버전·기준을 모두 갖춘 경우에만 검토 확인을 선택할 수 있다", () => {
    expect(canReviewDiagnosisAssessment(assessment(), [source], true)).toBe(true);
    expect(canReviewDiagnosisAssessment(assessment(), [source], false)).toBe(false);
    expect(canReviewDiagnosisAssessment({ ...assessment(), evidence: [] }, [source], true)).toBe(
      false,
    );
  });
  it.each([
    { updatedAt: "2026-09-26T00:00:00.000Z" },
    { text: "다른 문장" },
    { extraction: "pending" as const },
    { kind: "consultation" as const },
    { originalName: null },
  ])(
    "자료가 바뀌거나 문서 근거가 아니면 기존 확인 체크를 완료로 표시하지 않는다 (%#)",
    (change) => {
      const sources = [{ ...source, ...change }];
      expect(canReviewDiagnosisAssessment(assessment(), sources, true)).toBe(false);
      const onChange = vi.fn();
      const html = renderToStaticMarkup(
        createElement(DiagnosisAssessmentEditor, {
          assessmentKey: "sme",
          value: assessment(),
          sources,
          criteriaCurrent: true,
          onChange,
        }),
      );
      expect(onChange).not.toHaveBeenCalled();
      expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
      expect(html).toMatch(/<input\b[^>]*type="checkbox"[^>]*disabled=""/);
      if (change.updatedAt)
        expect(html).toContain("인용이 남아 있어도 이전 검토를 재사용하지 않습니다");
    },
  );
  it("미추출 자료는 선택지에 보이되 인용 근거로 선택할 수 없다", () => {
    const html = renderToStaticMarkup(
      createElement(DiagnosisAssessmentEditor, {
        assessmentKey: "industryEligibility",
        value: {
          ...emptyDiagnosisAnswers().industryEligibility,
          evidence: [{ sourceId: "", sourceUpdatedAt: "", quote: "", locator: "" }],
        },
        sources: [{ ...source, extraction: "pending", text: "" }],
        criteriaCurrent: false,
        onChange: vi.fn(),
      }),
    );
    expect(html).toMatch(new RegExp(`<option value="${sourceId}" disabled=""`));
    expect(html).toContain("본문 확인 필요");
    expect(html).toContain("신청 제외업종이 아닌 근거 있음");
    expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
  });
  it("다른 회사 자료 ID·중복 ID·없는 위치·틀린 인용으로 확인을 허용하지 않는다", () => {
    expect(canReviewDiagnosisAssessment(assessment(), [], true)).toBe(false);
    expect(canReviewDiagnosisAssessment(assessment(), [source, source], true)).toBe(false);
    for (const changed of [{ locator: "" }, { quote: "부정확한 인용" }, { sourceId: "other" }]) {
      expect(
        canReviewDiagnosisAssessment(
          { ...assessment(), evidence: [{ ...assessment().evidence[0], ...changed }] },
          [source],
          true,
        ),
      ).toBe(false);
    }
  });
});
