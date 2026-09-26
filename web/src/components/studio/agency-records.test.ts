import { emptyDiagnosisAnswers } from "@/lib/studio-diagnosis-types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  emptyProfile,
  type SourceDocument,
  type StudioCase,
  type WorkflowTask,
} from "@/lib/studio-schema";
import {
  agencyRecordInputSchema,
  type AgencyRecord,
  type AgencyEvidenceSnapshot,
  type AgencyRequestRecord,
  type AgencyNoticeRecord,
  type AgencyNoticeDetails,
} from "@/lib/studio-agency-records";
import {
  AgencyRecords,
  AgencyRequestTasks,
  AgencyRecordView,
  AgencySourcePicker,
  AgencyEvidenceView,
  AgencyNoticeFields,
  emptyAgencyNoticeDetails,
  validateAgencyEvidenceCheck,
  type AgencyEvidenceCheck,
} from "./agency-records";

const caseId = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-25T00:00:00.000Z";
const sourceId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const evidence: AgencyEvidenceSnapshot = {
  sourceId,
  sourceName: "가상 요청 원문",
  originalName: "original-request.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  capturedAt: now,
  sourceUpdatedAt: now,
};
function source(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: sourceId,
    name: evidence.sourceName,
    kind: "other",
    text: "",
    originalName: evidence.originalName,
    mimeType: evidence.mimeType,
    extraction: "pending",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
function record(overrides: Partial<AgencyRequestRecord> = {}): AgencyRequestRecord {
  return {
    id: requestId,
    clientRequestId: "44444444-4444-4444-8444-444444444444",
    inputDigest: "b".repeat(64),
    kind: "request",
    requestRecordId: requestId,
    requestVersionId: requestId,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "가상 평가기관",
    title: "보완 요청",
    body: "최초 요청 본문 <script>untrusted()</script>",
    occurredOn: "2026-09-24",
    dueOn: "2026-10-02",
    dueNote: "담당자가 확인한 원문에 기재된 날짜",
    note: "가상 메모",
    responseStatus: null,
    evidence: [evidence],
    ...overrides,
  };
}
const noticeId = "77777777-7777-4777-8777-777777777777";
function notice(overrides: Partial<AgencyNoticeRecord> = {}): AgencyNoticeRecord {
  return {
    id: noticeId,
    clientRequestId: "88888888-8888-4888-8888-888888888888",
    inputDigest: "c".repeat(64),
    kind: "notice",
    noticeRecordId: noticeId,
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: now,
    institution: "가상 통보기관",
    title: "가상 납부 안내",
    body: "담당자가 기록한 최초 통보 <script>notice()</script>",
    occurredOn: "",
    note: "근거 원문 확인 필요",
    details: emptyAgencyNoticeDetails("payment"),
    evidence: [evidence],
    ...overrides,
  };
}
function company(records: AgencyRecord[]): StudioCase {
  return {
    id: caseId,
    profile: { ...emptyProfile(), companyName: "가상 시험기업" },
    sources: [source()],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    stageHistory: [],
    agencyRecords: records,
    sourceOcrReviews: [],
    diagnosisAnswers: emptyDiagnosisAnswers(),
    diagnoses: [],
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
    revision: 7,
    createdAt: now,
    updatedAt: now,
  };
}
function checked(
  state: AgencyEvidenceCheck["evidence"][number]["state"] = "matched",
): AgencyEvidenceCheck {
  return { caseRevision: 7, recordId: requestId, observedAt: now, evidence: [{ sourceId, state }] };
}

function linkedTask(change: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    title: "가상 요청 대응 업무",
    category: "supplement",
    status: "pending",
    dueDate: "2026-10-02",
    notes: "기존 업무 메모",
    agencyOrigin: { requestRecordId: requestId, requestVersionId: requestId },
    ...change,
  };
}
function renderAgencyTasks(record: StudioCase, blockedReason = "") {
  const mutate = vi.fn();
  const html = renderToStaticMarkup(
    createElement(AgencyRecords, {
      company: record,
      mutate,
      onDirtyChange: vi.fn(),
      blockedReason,
    }),
  );
  return { html, mutate };
}

describe("기관 요청 버전별 업무 연결", () => {
  it("adds tasks only for the latest request, excluding response and notice entries", () => {
    const response = record({ id: sourceId, kind: "response", responseStatus: "draft" });
    const output = renderAgencyTasks(company([record(), response, notice()]));
    expect((output.html.match(/요청 v1 업무 추가/g) ?? []).length).toBe(1);
    expect(output.html).not.toContain("통보 업무 추가");
    expect(output.html).not.toContain("답변 업무 추가");
    expect(output.mutate).not.toHaveBeenCalled();
  });
  it("disables duplicate creation and shows manually recorded status and due date", () => {
    const saved = company([record()]);
    saved.tasks = [linkedTask({ status: "done", dueDate: "2026-10-01" })];
    const html = renderAgencyTasks(saved).html;
    const button = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((item) => item.includes("요청 v1 업무 이미 등록됨"));
    expect(button).toContain('disabled=""');
    expect(html).toContain("담당자 표시 완료");
    expect(html).toContain("업무 기한: 2026-10-01");
    expect(html).toContain(`href="#workflow-task-${saved.tasks[0].id}"`);
  });
  it("keeps old tasks after correction while offering one explicit new-version task", () => {
    const changed = record({
      id: sourceId,
      kind: "request-correction",
      previousVersionId: requestId,
      requestVersionId: sourceId,
      version: 2,
      dueOn: "2026-10-15",
    });
    const saved = company([record(), changed]);
    saved.tasks = [linkedTask({ status: "done" })];
    const html = renderAgencyTasks(saved).html;
    expect(html).toContain("연결 기준: 요청 v1");
    expect(html).toContain("요청이 v2으로 정정되었습니다");
    expect(html).toContain("업무 기한: 2026-10-02");
    expect(html).toContain("기존 기한·완료 상태는 자동 변경하지 않습니다");
    const button = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((item) => item.includes("요청 v2 업무 추가"));
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled=""');
    expect(html).not.toContain("요청 v1 업무 추가");
  });
  it("blocks creation while another workflow editor is dirty or the task limit is reached", () => {
    const saved = company([record()]);
    const blocked = renderAgencyTasks(saved, "기존 업무 편집을 먼저 저장해 주세요.").html;
    const creation = (html: string) =>
      html
        .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
        ?.find((item) => item.includes("요청 v1 업무 추가"));
    expect(creation(blocked)).toContain('disabled=""');
    saved.tasks = Array.from({ length: 200 }, (_, index) =>
      linkedTask({
        id: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
        agencyOrigin: undefined,
      }),
    );
    expect(creation(renderAgencyTasks(saved).html)).toContain('disabled=""');
  });
  it("marks missing version references without substituting the current version", () => {
    const saved = company([record()]);
    saved.tasks = [
      linkedTask({ agencyOrigin: { requestRecordId: requestId, requestVersionId: sourceId } }),
    ];
    const html = renderToStaticMarkup(
      createElement(AgencyRequestTasks, { company: saved, requestRecordId: requestId }),
    );
    expect(html).toContain("요청 버전 확인 불가");
    expect(html).toContain("연결한 요청 원문을 찾지 못했습니다");
  });
  it("gives immutable request records stable anchor targets", () => {
    expect(renderAgencyTasks(company([record()])).html).toContain(
      `id="agency-record-${requestId}"`,
    );
  });
});

describe("기관 요청·답변 로컬 이력 표시", () => {
  it("기존 회사에 새 이력이 없어도 빈 상태로 보이며 자동 저장·원본 확인 요청을 하지 않는다", () => {
    const old = company([]);
    delete (old as Partial<StudioCase>).agencyRecords;
    const mutate = vi.fn(),
      onDirtyChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AgencyRecords, { company: old, mutate, onDirtyChange, blockedReason: "" }),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(onDirtyChange).not.toHaveBeenCalled();
    expect(html).toContain("아직 기관 요청 기록이 없습니다");
    expect(html).toContain("외부로 전송하지 않습니다");
    expect(html).not.toContain('type="checkbox"');
  });
  it("정정과 답변 버전이 생겨도 최초 요청 원문·날짜·근거를 함께 표시한다", () => {
    const correctionId = "55555555-5555-4555-8555-555555555555";
    const correction = record({
      id: correctionId,
      kind: "request-correction",
      previousVersionId: requestId,
      requestVersionId: correctionId,
      version: 2,
      title: "보완 요청 정정",
      body: "정정된 요청 본문",
      dueOn: "2026-10-05",
      note: "기한 정정 근거",
    });
    const reply = record({
      id: "66666666-6666-4666-8666-666666666666",
      kind: "response",
      requestVersionId: correctionId,
      version: 1,
      title: "답변 초안 제목",
      body: "답변 초안 본문",
      responseStatus: "draft",
      dueOn: "",
      dueNote: "",
      evidence: [],
    });
    const html = renderToStaticMarkup(
      createElement(AgencyRecords, {
        company: company([record(), correction, reply]),
        mutate: vi.fn(),
        onDirtyChange: vi.fn(),
        blockedReason: "",
      }),
    );
    expect(html).toContain("최초 요청 본문");
    expect(html).toContain("정정된 요청 본문");
    expect(html).toContain("답변 초안 본문");
    expect(html).toContain("2026-10-02");
    expect(html).toContain("2026-10-05");
    expect(html).toContain("요청 v2 기준");
    expect(html).toContain("법정기한 자동 검증 아님");
    expect(html).toContain("요청 정정 기록");
    expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
    expect(html).not.toContain("<script>untrusted()");
  });
  it("담당자 발송 기록을 앱의 전송 성공이나 기관 수신 완료로 표시하지 않는다", () => {
    const onCheck = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AgencyRecordView, {
        caseId,
        record: record({
          kind: "response",
          responseStatus: "reported-sent",
          occurredOn: "2026-09-24",
        }),
        sources: [source()],
        requestVersion: 1,
        busy: false,
        onCheck,
      }),
    );
    expect(onCheck).not.toHaveBeenCalled();
    expect(html).toContain("담당자 기입 발송 기록");
    expect(html).toContain("담당자 기입 발송일");
    expect(html).toContain("이 앱이 발송하거나 기관 수신을 확인한 기록이 아닙니다");
    expect(html).not.toContain("발송 완료");
    expect(html).not.toContain("접수 완료");
  });
  it("기존 단계·업무 편집 중에는 기관 기록의 쓰기와 원본 확인 버튼을 비활성화한다", () => {
    const html = renderToStaticMarkup(
      createElement(AgencyRecords, {
        company: company([record()]),
        mutate: vi.fn(),
        onDirtyChange: vi.fn(),
        blockedReason: "진행 중인 편집을 먼저 저장해 주세요.",
      }),
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toMatch(/\sdisabled=""/);
    expect(html).toContain("진행 중인 편집을 먼저 저장해 주세요");
  });
});

describe("기관 통보의 수동 기록과 상세 미확인 표시", () => {
  it.each(["payment", "receipt", "visit", "decision", "certificate"] as const)(
    "%s 상세 입력은 빈 상태를 보존하고 기관 상태를 추정하지 않는다",
    (category) => {
      const details = emptyAgencyNoticeDetails(category);
      const onChange = vi.fn();
      const html = renderToStaticMarkup(createElement(AgencyNoticeFields, { details, onChange }));
      expect(onChange).not.toHaveBeenCalled();
      expect(html).toContain(`value="${category}" selected=""`);
      const inputs = html.match(/<input\b[^>]*>/g) ?? [];
      for (const input of inputs) expect(input).toContain('value=""');
      expect(html).not.toContain('type="checkbox"');
      expect(html).toContain("빈 상세값은 미확인으로 남으며");
      expect(html).toContain("저장해도 진행 단계는 바뀌지 않습니다");
      expect(html).toContain("확인서 진위와 유효성을 자동 확인하지 않습니다");
      expect(
        agencyRecordInputSchema.safeParse({
          kind: "notice",
          institution: "가상 기관",
          title: "통보",
          body: "원문만 확인한 통보",
          occurredOn: "",
          note: "",
          sourceIds: [],
          details,
        }).success,
      ).toBe(true);
      const view = renderToStaticMarkup(
        createElement(AgencyRecordView, {
          caseId,
          record: notice({ details }),
          sources: [],
          busy: false,
          onCheck: vi.fn(),
        }),
      );
      expect(view.match(/<dd[^>]*>미확인<\/dd>/g)).toHaveLength(Object.keys(details).length - 1);
      expect(view).toContain("기관 통보 담당자 기록");
      expect(view).not.toContain("담당자 기입 발송 기록");
    },
  );
  it.each([
    [
      {
        category: "payment",
        amountWon: "0",
        dueOn: "2026-10-01",
        dueNote: "가상 안내 날짜",
        paidOn: "",
        referenceNumber: "PAY-1",
        statusText: "확인 필요",
      },
      "통보에 기재된 금액 (원)",
      "PAY-1",
    ],
    [
      {
        category: "receipt",
        receiptNumber: "RECEIPT-1",
        receivedOn: "2026-09-25",
        statusText: "원문상 접수",
      },
      "접수번호",
      "RECEIPT-1",
    ],
    [
      {
        category: "visit",
        scheduledOn: "2026-10-01",
        timeText: "오전 10시",
        location: "가상 사업장",
        preparation: "원본에 기재된 준비사항",
      },
      "안내된 실사 예정일",
      "가상 사업장",
    ],
    [
      {
        category: "decision",
        decisionText: "원문에 적힌 결과",
        notifiedOn: "2026-10-01",
        reasons: "<script>사유</script>",
      },
      "통보에 기재된 결과 문구",
      "&lt;script&gt;사유&lt;/script&gt;",
    ],
    [
      {
        category: "certificate",
        certificateNumber: "CERT-1",
        issuedOn: "2026-10-01",
        validFrom: "2026-10-01",
        validUntil: "2026-12-31",
        statusText: "진위 별도 확인",
      },
      "기재된 유효기간 종료일",
      "CERT-1",
    ],
  ] satisfies Array<[AgencyNoticeDetails, string, string]>)(
    "상세 %j는 담당자 기입 문구로만 표시한다",
    (details, label, value) => {
      const html = renderToStaticMarkup(
        createElement(AgencyRecordView, {
          caseId,
          record: notice({ details }),
          sources: [source()],
          busy: false,
          onCheck: vi.fn(),
        }),
      );
      expect(html).toContain(label);
      expect(html).toContain(value);
      expect(html).toContain("담당자가 기록한 통보 내용입니다");
      expect(html).toContain(
        "기관 송수신·납부 성공·심사 결과·확인서 진위 확인이나 진행 단계 변경을 의미하지 않습니다",
      );
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("납부 완료");
      expect(html).not.toContain("유효한 확인서");
      if (details.category === "payment") expect(html).toMatch(/<dd[^>]*>0<\/dd>/);
    },
  );
  it("통보 정정은 이전 원문·증빙·분류를 남기고 요청 답변과 별도 이력으로 표시한다", () => {
    const changed = notice({
      id: "99999999-9999-4999-8999-999999999999",
      kind: "notice-correction",
      previousVersionId: noticeId,
      version: 2,
      title: "가상 접수 통보로 정정",
      body: "정정된 통보 내용",
      details: { category: "receipt", receiptNumber: "R-002", receivedOn: "", statusText: "" },
      evidence: [],
    });
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AgencyRecords, {
        company: company([record(), notice(), changed]),
        mutate,
        onDirtyChange: vi.fn(),
        blockedReason: "",
      }),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(html).toContain("최초 요청 본문");
    expect(html).toContain("담당자가 기록한 최초 통보 &lt;script&gt;notice()&lt;/script&gt;");
    expect(html).toContain("정정된 통보 내용");
    expect(html).toContain("정정 분류: 납부 안내 → 접수 통보");
    expect(html).toContain("통보 v1");
    expect(html).toContain("통보 v2");
    expect(html).toContain("원문 정정과 답변은 새 버전으로 남기고 이전 기록은 보존합니다");
    expect(html.match(/답변 새 버전 기록<\/button>/g)).toHaveLength(1);
    expect(html.match(/통보 정정 기록 추가<\/button>/g)).toHaveLength(1);
    expect(html).toContain(evidence.sha256);
    expect(html).not.toContain("<script>");
  });
  it("통보만 있는 기업에는 요청·답변용 동작을 만들지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(AgencyRecords, {
        company: company([notice()]),
        mutate: vi.fn(),
        onDirtyChange: vi.fn(),
        blockedReason: "",
      }),
    );
    expect(html).toContain("아직 기관 요청 기록이 없습니다");
    expect(html).toContain("통보 정정 기록 추가");
    expect(html).not.toContain("답변 새 버전 기록");
    expect(html).not.toContain("요청 정정 기록 추가");
    expect(html).not.toContain("아직 기관 통보 기록이 없습니다");
  });
  it("다른 편집 중에는 통보 정정과 증빙 확인을 포함한 모든 버튼을 막는다", () => {
    const html = renderToStaticMarkup(
      createElement(AgencyRecords, {
        company: company([notice()]),
        mutate: vi.fn(),
        onDirtyChange: vi.fn(),
        blockedReason: "기존 편집 보존",
      }),
    );
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toContain('disabled=""');
  });
});

describe("원본 선택과 기록 당시 증빙의 구분", () => {
  it("pending 원본은 선택 가능하지만 자동 선택하거나 분석 완료로 표시하지 않는다", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(AgencySourcePicker, {
        sources: [
          source(),
          source({
            id: "manual",
            name: "원본 없는 수동 메모",
            originalName: null,
            extraction: "manual",
            text: "메모",
          }),
        ],
        selected: [],
        onChange,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(html).toContain("본문 미추출 · 분석 완료 아님");
    expect(html).not.toContain("원본 없는 수동 메모");
    expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
    expect(html).not.toMatch(/<input\b[^>]*\sdisabled=""/);
  });
  it("10개를 선택하면 추가 선택을 막고 선택한 원본은 해제할 수 있다", () => {
    const sources = Array.from({ length: 11 }, (_, index) =>
      source({ id: `source-${index}`, name: `원본${index}` }),
    );
    const html = renderToStaticMarkup(
      createElement(AgencySourcePicker, {
        sources,
        selected: sources.slice(0, 10).map((item) => item.id),
        onChange: vi.fn(),
      }),
    );
    const inputs = html.match(/<input\b[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(11);
    expect(inputs.filter((input) => /\sdisabled=""/.test(input))).toHaveLength(1);
    expect(inputs.filter((input) => /\schecked=""/.test(input))).toHaveLength(10);
  });
  it("기록 당시 파일명·해시와 현재 다운로드를 구분한다", () => {
    const html = renderToStaticMarkup(
      createElement(AgencyEvidenceView, {
        caseId,
        evidence: [evidence],
        sources: [source({ name: "현재 수정된 제목" })],
        check: checked(),
      }),
    );
    expect(html).toContain("가상 요청 원문");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("original-request.pdf");
    expect(html).toContain("보관 당시 원본과 현재 파일 일치 · 기관 접수 증명 아님");
    expect(html).toContain("기록 당시 SHA256과 다를 수 있습니다");
    expect(html).toContain("이후 변경은 반영하지 않습니다");
    expect(html).toContain(`/api/studio/cases/${caseId}/sources/${sourceId}`);
  });
  it.each(["changed", "unavailable"] as const)(
    "%s 원본은 일치나 기관 검증 성공으로 표시하지 않는다",
    (state) => {
      const html = renderToStaticMarkup(
        createElement(AgencyEvidenceView, {
          caseId,
          evidence: [evidence],
          sources: [],
          check: checked(state),
        }),
      );
      expect(html).not.toContain("현재 파일 일치");
      expect(html).not.toContain("현재 보관 원본 다운로드");
      expect(html).toContain(
        state === "changed" ? "현재 상태가 다릅니다" : "일치로 판단하지 않습니다",
      );
    },
  );
});

describe("현재 원본 상태 응답의 바인딩", () => {
  it("현재 기업 버전·기록·정확한 원본 목록만 수용한다", () => {
    const value = checked();
    expect(validateAgencyEvidenceCheck(value, record(), 7)).toBe(value);
  });
  it.each([
    { caseRevision: 6 },
    { recordId: "other-record" },
    { observedAt: "invalid" },
    { evidence: [] },
    { evidence: [{ sourceId: "other-source", state: "matched" }] },
    {
      evidence: [
        { sourceId, state: "matched" },
        { sourceId, state: "matched" },
      ],
    },
    { evidence: [{ sourceId, state: "agency-received" }] },
  ])("오래되거나 출처가 맞지 않는 응답은 폐기한다: %j", (changes) => {
    expect(() =>
      validateAgencyEvidenceCheck({ ...checked(), ...changes } as AgencyEvidenceCheck, record(), 7),
    ).toThrow("현재 기록이 일치하지 않습니다");
  });
});
