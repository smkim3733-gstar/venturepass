import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  applicationCycleSchema,
  applicationEventSchema,
  type ApplicationCycle,
  type ApplicationEvent,
  type ApplicationLink,
  type ApplicationSubmission,
} from "@/lib/studio-application-types";
import type { AgencyNoticeRecord } from "@/lib/studio-agency-records";
import {
  ApplicationHistory,
  ApplicationSubmissionView,
  applicationSaveAcknowledged,
} from "./application-history";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T09:00:00.000Z";
const companyId = id(1);
const cycleId = id(2);
const planId = id(3);
const sourceId = id(4);
const receiptId = id(5);
function cycle(overrides: Partial<ApplicationCycle> = {}): ApplicationCycle {
  return applicationCycleSchema.parse({
    id: cycleId,
    clientRequestId: id(102),
    inputDigest: "a".repeat(64),
    origin: "manual",
    recordedAt: now,
    title: "첫 신청 회차",
    kind: "new",
    plannedOn: "",
    criteriaNote: "기준 확인 필요",
    previousApplicationId: null,
    companyAtCreation: { companyName: "등록 당시 회사", businessNumber: "" },
    ...overrides,
  });
}
function receipt(overrides: Partial<AgencyNoticeRecord> = {}): AgencyNoticeRecord {
  return {
    id: receiptId,
    clientRequestId: id(105),
    inputDigest: "b".repeat(64),
    kind: "notice",
    origin: "manual",
    recordedAt: now,
    noticeRecordId: receiptId,
    previousVersionId: null,
    version: 1,
    institution: "가상 기관",
    title: "접수 안내 원문",
    body: "첫 통보의 담당자 기록",
    occurredOn: "",
    note: "",
    evidence: [],
    details: {
      category: "receipt",
      receiptNumber: "기입번호-ABC",
      receivedOn: "2026-09-24",
      statusText: "보관한 안내 문구",
    },
    ...overrides,
  };
}
function link(overrides: Partial<ApplicationLink> = {}): ApplicationLink {
  return applicationEventSchema.parse({
    id: id(6),
    clientRequestId: id(106),
    inputDigest: "c".repeat(64),
    kind: "agency-link",
    origin: "manual",
    recordedAt: now,
    applicationId: cycleId,
    fromApplicationId: null,
    chainRootId: receiptId,
    chainKind: "notice",
    recordVersionId: receiptId,
    previousLinkEventId: null,
    note: "처음 연결한 근거",
    ...overrides,
  }) as ApplicationLink;
}
function submission(overrides: Partial<ApplicationSubmission> = {}): ApplicationSubmission {
  return applicationEventSchema.parse({
    id: id(7),
    clientRequestId: id(107),
    inputDigest: "d".repeat(64),
    kind: "submission-recorded",
    origin: "manual",
    recordedAt: now,
    applicationId: cycleId,
    submissionRecordId: id(7),
    previousVersionId: null,
    version: 1,
    occurredOn: "2026-09-23",
    recordedBy: "합성 기록자",
    note: "과거 행위 수기 기록",
    claim: "reported-submitted",
    officialVerification: "unverified",
    companySnapshot: {
      caseId: companyId,
      revision: 2,
      companyName: "제출 당시 회사",
      businessNumber: "",
    },
    plan: {
      id: planId,
      version: 1,
      generatedAt: now,
      mode: "manual",
      candidateId: "candidate",
      sourceRevision: 1,
      contentSha256: "e".repeat(64),
      confirmedAt: null,
      review: [
        {
          id: "review",
          severity: "warning",
          category: "confirmation",
          message: "당시 남은 과제",
          action: "원문 확인",
          sectionKey: null,
          sourceIds: [],
        },
      ],
      sections: [{ key: "solution", needsConfirmation: true }],
      latestVersion: false,
      currentEvidence: false,
    },
    evidence: [
      {
        sectionKey: "solution",
        sourceId,
        sourceName: "당시 인용 자료",
        sourceUpdatedAt: now,
        quote: "과거 인용 <script>synthetic()</script>",
        locator: "첫 문단",
        state: "pending",
      },
    ],
    originals: [
      {
        sourceId,
        sourceName: "당시 원본",
        originalName: "synthetic.pdf",
        mimeType: "application/pdf",
        sizeBytes: 123,
        sha256: "f".repeat(64),
        sourceUpdatedAt: now,
      },
    ],
    owners: [
      {
        taskId: id(8),
        title: "당시 담당 업무",
        agencyOrigin: null,
        owners: { materials: "당시 준비자", writing: "", review: "" },
      },
    ],
    receiptRecordId: receiptId,
    ...overrides,
  }) as ApplicationSubmission;
}
function company(overrides: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "현재 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "confirmed",
    revision: 5,
    createdAt: now,
    updatedAt: now,
    applications: [cycle()],
    applicationEvents: [],
    agencyRecords: [receipt()],
    ...overrides,
  });
}
function render(record = company(), blockedReason = "") {
  const mutate = vi.fn();
  const html = renderToStaticMarkup(
    createElement(ApplicationHistory, {
      company: record,
      mutate,
      blockedReason,
      onDirtyChange: vi.fn(),
    }),
  );
  expect(mutate).not.toHaveBeenCalled();
  return html;
}

describe("신청 회차·제출 이력 화면", () => {
  it("기존 confirmed 단계라도 회차와 제출 성공을 추정하지 않는다", () => {
    const record = company({ applications: [], applicationEvents: [] });
    const html = render(record);
    expect(html).toContain("등록한 신청 회차가 없습니다");
    expect(html).toContain("회차를 자동 추정하지 않습니다");
    expect(html).toContain("미지정 1개");
    expect(html).toContain("공식 사이트 전송이나 기관 접수·심사 결과 확인이 아닙니다");
    expect(record.stage).toBe("confirmed");
    expect(record.applicationEvents).toEqual([]);
  });
  it("구형 응답에 두 배열이 없어도 미지정 안내만 보인다", () => {
    const record = company();
    delete (record as Partial<StudioCase>).applications;
    delete (record as Partial<StudioCase>).applicationEvents;
    expect(render(record)).toContain("등록한 신청 회차가 없습니다");
  });
  it("회차 정보 정정은 최신 명칭과 최초 기록을 함께 보존한다", () => {
    const correction = applicationEventSchema.parse({
      id: id(9),
      clientRequestId: id(109),
      inputDigest: "a".repeat(64),
      origin: "manual",
      recordedAt: now,
      kind: "cycle-correction",
      applicationId: cycleId,
      previousVersionId: cycleId,
      details: {
        title: "정정한 회차",
        kind: "renewal",
        plannedOn: "2026-10-01",
        criteriaNote: "담당자 정정 근거",
        previousApplicationId: null,
      },
    });
    const html = render(company({ applicationEvents: [correction] }));
    expect(html).toContain("정정한 회차");
    expect(html).toContain("최초 등록: 첫 신청 회차");
    expect(html).toContain("담당자 정정 근거");
    expect(html).toContain("최초 기준 메모: 기준 확인 필요");
    expect(html).toContain("이 회차 다음 신청 등록");
  });
  it("후속 정정이 있어도 채택한 과거 통보 버전과 번호를 바꾸지 않는다", () => {
    const html = render(
      company({
        agencyRecords: [
          receipt(),
          receipt({
            id: id(15),
            kind: "notice-correction",
            previousVersionId: receiptId,
            version: 2,
            body: "후속 통보 본문",
            details: {
              category: "receipt",
              receiptNumber: "다른-최신번호",
              receivedOn: "",
              statusText: "",
            },
          }),
        ],
        applicationEvents: [link()],
      }),
    );
    expect(html).toContain("기입번호-ABC");
    expect(html).toContain("후속 정정·답변 있음");
    expect(html).not.toContain("다른-최신번호");
    expect(html).not.toContain("후속 통보 본문");
  });
  it("기관 체인 이동은 현재 한 회차에만 귀속되고 이전 이동 이력을 남긴다", () => {
    const other = cycle({
      id: id(12),
      clientRequestId: id(112),
      title: "다음 신청 회차",
      previousApplicationId: cycleId,
    });
    const moved = link({
      id: id(16),
      clientRequestId: id(116),
      kind: "agency-link-correction",
      previousLinkEventId: id(6),
      fromApplicationId: cycleId,
      applicationId: other.id,
      note: "잘못된 귀속 정정",
    });
    const html = render(
      company({ applications: [cycle(), other], applicationEvents: [link(), moved] }),
    );
    expect(html.match(/현재 귀속된 기관 체인 1개/g)).toHaveLength(1);
    expect(html.match(/현재 귀속된 기관 체인 0개/g)).toHaveLength(1);
    expect(html).toContain("잘못된 귀속 정정");
    expect(html).toContain("첫 신청 회차 → 다음 신청 회차");
    expect(html).toContain("이전 회차: 첫 신청 회차");
  });
  it("귀속 해제 뒤 미지정으로 표시하고 과거 연결은 이력으로 남긴다", () => {
    const released = link({
      id: id(17),
      clientRequestId: id(117),
      kind: "agency-link-correction",
      previousLinkEventId: id(6),
      fromApplicationId: cycleId,
      applicationId: null,
      note: "귀속 해제 사유",
    });
    const html = render(company({ applicationEvents: [link(), released] }));
    expect(html).toContain("현재 귀속된 기관 체인 0개");
    expect(html).toContain("현재 귀속: 회차 미지정");
    expect(html).toContain("귀속 해제 사유");
    expect(html).toContain("첫 신청 회차 → 회차 미지정");
  });
  it("외부 편집 중에는 등록·정정·연결 버튼을 모두 막는다", () => {
    const html = render(company(), "업무 편집을 먼저 저장하거나 취소해 주세요.");
    expect(html).toContain("업무 편집을 먼저 저장하거나 취소해 주세요");
    for (const match of html.matchAll(/<button([^>]*)>/g))
      expect(match[1]).toContain('disabled=""');
  });
  it("회차와 사건 한도에 도달하면 새 기록을 만드는 버튼을 막는다", () => {
    const applications = Array.from({ length: 30 }, (_, i) =>
      cycle({ id: id(i + 200), clientRequestId: id(i + 400), title: `회차 ${i + 1}` }),
    );
    const applicationEvents = Array.from({ length: 200 }, (_, i) => ({
      ...link(),
      id: id(i + 500),
      clientRequestId: id(i + 800),
      applicationId: applications[0].id,
    })) as ApplicationEvent[];
    const html = render(company({ applications, applicationEvents }));
    expect(html).toContain("회차 30/30개 · 사건 200/200개");
    for (const match of html.matchAll(/<button([^>]*)>/g))
      expect(match[1]).toContain('disabled=""');
  });
});

describe("제출 당시 스냅샷 표시", () => {
  it("현재 원고·담당자 상태가 달라도 과거 미확인 상태와 이름을 표시한다", () => {
    const record = company({
      tasks: [
        {
          id: id(8),
          title: "수정한 현재 업무",
          category: "other",
          status: "done",
          notes: "",
          dueDate: "",
          owners: { materials: "현재 담당자", writing: "", review: "" },
        },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(ApplicationSubmissionView, { submission: submission(), company: record }),
    );
    expect(html).toContain("당시 선택 원고 v1");
    expect(html).toContain("당시 내부 검토 표시: 미확인");
    expect(html).toContain("확인 필요 항목 1개");
    expect(html).toContain("당시 준비자");
    expect(html).not.toContain("현재 담당자");
    expect(html).toContain("현재 기업정보와 다른 당시 값");
    expect(html).toContain("기관 확인 미실시");
    expect(html).toContain("소급 검증한 값이 아닙니다");
  });
  it("본문 미추출·원본 해시를 표시하며 현재 파일을 과거 원본 다운로드로 내보내지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationSubmissionView, { submission: submission(), company: company() }),
    );
    expect(html).toContain("당시 대조 미추출");
    expect(html).toContain("synthetic.pdf");
    expect(html).toContain("f".repeat(64));
    expect(html).toContain("현재 자료함 파일과 같다는 보장이나 기관 수신 증명이 아닙니다");
    expect(html).not.toContain("/sources/");
    expect(html).toContain("&lt;script&gt;synthetic()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("제출 정정 후에도 과거 제출 기록을 지우지 않는다", () => {
    const corrected = submission({
      id: id(18),
      clientRequestId: id(118),
      kind: "submission-correction",
      previousVersionId: id(7),
      version: 2,
      occurredOn: "2026-09-24",
      recordedBy: "정정 기록자",
      note: "제출일 정정",
    });
    const html = render(company({ applicationEvents: [submission(), corrected] }));
    expect(html).toContain("제출했다고 기록 · 기록 v2");
    expect(html).toContain("제출했다고 기록 · 기록 v1");
    expect(html).toContain("2026-09-23");
    expect(html).toContain("2026-09-24");
    expect(html).toContain("제출일 정정");
  });
});

describe("저장 응답의 회사·요청 번호 대조", () => {
  it("정확한 회차/사건 요청만 성공으로 인정하며 같은 revision replay도 허용한다", () => {
    expect(applicationSaveAcknowledged(company(), companyId, 5, id(102))).toBe(true);
    expect(
      applicationSaveAcknowledged(company({ applicationEvents: [link()] }), companyId, 5, id(106)),
    ).toBe(true);
    expect(applicationSaveAcknowledged(company(), companyId, 5, id(999))).toBe(false);
  });
  it("다른 회사·오래된 응답·중복 요청 식별자는 승인하지 않는다", () => {
    expect(applicationSaveAcknowledged(company(), id(999), 5, id(102))).toBe(false);
    expect(applicationSaveAcknowledged(company(), companyId, 6, id(102))).toBe(false);
    const duplicate = company({ applications: [cycle(), cycle({ id: id(999) })] });
    expect(applicationSaveAcknowledged(duplicate, companyId, 5, id(102))).toBe(false);
  });
});
