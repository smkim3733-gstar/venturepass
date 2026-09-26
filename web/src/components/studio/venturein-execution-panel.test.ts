import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VentureExecutionReview } from "@/lib/venturein-execution-schema";
import type { VenturePreflightReport } from "@/lib/venturein-preflight";
import type { VentureWorkflowStatus } from "@/lib/venturein-workflow";
import { VentureinApprovalScope, VentureinExecutionPanel } from "./venturein-execution-panel";

const now = "2026-09-25T01:00:00.000Z";
const remainingIssues: VentureExecutionReview["remainingIssues"] = [
  {
    code: "REQUIRED_FIELD_UNMAPPED",
    severity: "error",
    fieldKey: "other-required",
    message: "선택하지 않은 필수 매출 항목이 남아 있습니다.",
  },
  {
    code: "USER_CONSENT_REQUIRED",
    severity: "error",
    fieldKey: "agreement",
    message: "공식 약관 동의가 필요합니다.",
  },
];

function workflowFixture(selectedReady: boolean, submissionReady: boolean): VentureWorkflowStatus {
  return {
    revision: 3,
    updatedAt: now,
    snapshot: null,
    draft: null,
    execution: null,
    originalFiles: [],
    accountRevision: 2,
    session: { state: "connected_unmapped", startedAt: now, updatedAt: now, message: "가상 연결" },
    journey: { entries: [], phase: "execute", message: "가상 준비 상태" },
    report: {
      scope: "local-preflight",
      caseId: "11111111-1111-4111-8111-111111111111",
      snapshotId: "test-screen",
      planId: null,
      automaticSubmissionAvailable: false,
      companyVerification: null,
      textFields: [],
      attachments: [],
      issues: remainingIssues,
      readyForLocalReview: submissionReady,
      inputReadiness: {
        ready: selectedReady,
        blockingIssues: selectedReady
          ? []
          : [
              {
                code: "COMPANY_UNVERIFIED",
                severity: "error",
                message: "공식 화면의 사업자등록번호 확인이 필요합니다.",
              },
            ],
        deferredIssues: remainingIssues,
      },
    },
  };
}

function renderExecution(workflow: VentureWorkflowStatus) {
  const onBusyChange = vi.fn();
  const onWorkflowChange = vi.fn();
  const props: ComponentProps<typeof VentureinExecutionPanel> = {
    endpoint: "/api/studio/cases/11111111-1111-4111-8111-111111111111/venturein/workflow",
    workflow,
    companyRevision: 4,
    accountRevision: 2,
    sessionStartedAt: now,
    bindingKey: "synthetic-current-binding",
    blockedReason: "",
    canRefresh: true,
    describeSource: () => "가상 기업정보",
    onBusyChange,
    onWorkflowChange,
  };
  const html = renderToStaticMarkup(createElement(VentureinExecutionPanel, props));
  expect(onBusyChange).not.toHaveBeenCalled();
  expect(onWorkflowChange).not.toHaveBeenCalled();
  return html;
}

function prepareButton(html: string) {
  const button = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((item) => item.includes("입력·첨부 검토안 준비"));
  expect(button).toBeDefined();
  return button!;
}

describe("선택 항목 입력 준비 표시", () => {
  it("새 복구 검토가 가능해도 동일 화면의 일반 재실행 금지는 그대로 유지한다", () => {
    const workflow = workflowFixture(true, false);
    const caseId = workflow.report.caseId;
    workflow.report.textFields = [
      {
        fieldKey: "name",
        label: "기업명",
        source: { kind: "profile", property: "companyName" },
        value: "가상기업",
        characterCount: 4,
        maxLength: 100,
        required: true,
        confirmed: true,
      },
    ];
    workflow.snapshot = {
      caseId,
      accountRevision: 2,
      sessionStartedAt: now,
      screen: {
        id: "test-screen",
        observedAt: now,
        url: "https://www.smes.go.kr/venturein/test",
        title: "가상 화면",
        fields: [],
        companyEvidence: [],
        truncated: false,
        warnings: [],
      },
    };
    workflow.draft = {
      caseId,
      snapshotId: "test-screen",
      sessionStartedAt: now,
      accountRevision: 2,
      companyRevision: 4,
      planId: null,
      planVersion: null,
      textMappings: [
        { fieldKey: "name", source: { kind: "profile", property: "companyName" }, confirmed: true },
      ],
      attachmentMappings: [],
    };
    workflow.execution = {
      id: "22222222-2222-4222-8222-222222222222",
      snapshotId: "test-screen",
      status: "stopped",
      startedAt: now,
      finishedAt: now,
      completedFieldKeys: [],
      attachmentFieldKeys: [],
      attemptedFieldKey: null,
      code: "TARGET_CHANGED",
      requestedFieldKeys: ["name"],
      preservedFieldKeys: [],
      touchedFieldKeys: [],
      priorExecutionId: null,
      previousAttempts: [],
      manifest: {
        version: 1,
        fingerprint: "a".repeat(64),
        draftFingerprint: "b".repeat(64),
        caseId,
        companyRevision: 4,
        accountRevision: 2,
        workflowRevision: 2,
        sessionStartedAt: now,
        snapshotId: "test-screen",
        targets: [{ fieldKey: "name", kind: "text" }],
      },
    };
    const html = renderExecution(workflow);
    const recovery = html
      .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
      ?.find((item) => item.includes("미시도 빈 텍스트 새 검토"));
    expect(recovery).toBeDefined();
    expect(recovery).not.toMatch(/\sdisabled=""/);
    expect(prepareButton(html)).toMatch(/\sdisabled=""/);
    expect(html).not.toContain('type="checkbox"');
  });

  it("선택 항목이 준비되면 전체 제출 보완이 남아 있어도 검토안 준비를 허용한다", () => {
    const html = renderExecution(workflowFixture(true, false));
    expect(html).toContain("입력·첨부 검토안 준비");
    expect(prepareButton(html)).not.toMatch(/\sdisabled=""/);
    expect(html).toContain("전체 제출 준비와 동의 사항은");
    expect(html).toContain("별도로 확인해야 합니다");
  });

  it("전체 점검 준비만으로 기업 확인이 막힌 선택 입력을 허용하지 않는다", () => {
    const html = renderExecution(workflowFixture(false, true));
    expect(prepareButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("선택 항목 입력 전 보완사항을 먼저 해결해 주세요");
  });

  it("선택 준비 판정이 없는 이전 응답은 전체 점검이 준비돼도 새로고침을 요구한다", () => {
    const workflow = workflowFixture(true, true);
    delete (workflow.report as Partial<VenturePreflightReport>).inputReadiness;
    const html = renderExecution(workflow);
    expect(prepareButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("선택 입력 준비 정보가 없습니다");
    expect(html).toContain("점검 결과 새로고침");
  });
});

describe("승인 범위와 미해결 제출 사항 표시", () => {
  it("이번 선택 항목의 전송 승인과 남은 필수 입력·약관 동의를 분리한다", () => {
    const html = renderToStaticMarkup(
      createElement(VentureinApprovalScope, {
        review: { scope: "selected-fields", submissionReady: false, remainingIssues },
      }),
    );
    expect(html).toContain("이번에 선택한 항목만 입력·첨부합니다");
    expect(html).toContain("최종 제출 완료를 뜻하지 않습니다");
    expect(html).toContain("아직 보완할 항목이 있습니다");
    expect(html).toContain("선택하지 않은 필수 매출 항목이 남아 있습니다");
    expect(html).toContain("공식 약관 동의가 필요합니다");
    expect(html).toContain("보완 필요");
    expect(html).not.toContain("동의 완료");
    expect(html).not.toContain('type="checkbox"');
  });

  it("보고서의 보완 항목이 없어도 선택 입력을 최종 제출 완료로 표시하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(VentureinApprovalScope, {
        review: { scope: "selected-fields", submissionReady: true, remainingIssues: [] },
      }),
    );
    expect(html).toContain("현재 보고서의 보완 항목 없음");
    expect(html).toContain("최종 제출 완료를 뜻하지 않습니다");
    expect(html).not.toContain("전체 제출 전 남은 확인사항");
  });
});
