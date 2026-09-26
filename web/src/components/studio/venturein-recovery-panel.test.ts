import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  VentureExecutionRecord,
  VentureRecoveryReview,
} from "@/lib/venturein-execution-schema";
import type { VentureResolvedText } from "@/lib/venturein-preflight";
import {
  validateVentureRecoveryReview,
  ventureRecoveryBlockedReason,
  VentureinRecoveryApproval,
  VentureinRecoveryPanel,
} from "./venturein-recovery-panel";

const binding = {
  caseId: "11111111-1111-4111-8111-111111111111",
  companyRevision: 5,
  accountRevision: 2,
  sessionStartedAt: "2026-09-25T01:00:00.000Z",
  snapshotId: "recovery-test-screen",
};
const fields: VentureResolvedText[] = [
  {
    fieldKey: "name",
    label: "기업명",
    source: { kind: "profile", property: "companyName" },
    value: "가상 시험기업",
    characterCount: 7,
    maxLength: 100,
    required: true,
    confirmed: true,
  },
  {
    fieldKey: "capital",
    label: "납입자본금",
    source: { kind: "profile", property: "paidInCapital" },
    value: "10000000",
    characterCount: 8,
    maxLength: 20,
    required: true,
    confirmed: true,
    financialContext: { unit: "원", evidenceNote: "가상 증빙 메모" },
  },
];
function receipt(): VentureExecutionRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    snapshotId: binding.snapshotId,
    status: "stopped",
    startedAt: binding.sessionStartedAt,
    finishedAt: "2026-09-25T01:01:00.000Z",
    completedFieldKeys: ["name"],
    attachmentFieldKeys: [],
    attemptedFieldKey: "name",
    requestedFieldKeys: ["name", "capital"],
    preservedFieldKeys: [],
    touchedFieldKeys: ["name"],
    priorExecutionId: null,
    code: "TARGET_CHANGED",
    previousAttempts: [],
    manifest: {
      version: 1,
      ...binding,
      workflowRevision: 3,
      fingerprint: "a".repeat(64),
      draftFingerprint: "b".repeat(64),
      targets: fields.map((field) => ({ fieldKey: field.fieldKey, kind: "text" })),
    },
  };
}
function review(overrides: Partial<VentureRecoveryReview> = {}): VentureRecoveryReview {
  return {
    scope: "text-recovery",
    workflowRevision: 4,
    ...binding,
    token: "33333333-3333-4333-8333-333333333333",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    priorExecutionId: receipt().id,
    observedAt: "2026-09-25T01:02:00.000Z",
    destination: "https://www.smes.go.kr/venturein/application-test",
    companyName: "가상 시험기업",
    fieldCount: 1,
    fields: [fields[1]],
    protectedFields: [{ fieldKey: "name", label: "기업명" }],
    submissionReady: false,
    remainingIssues: [
      {
        code: "AGREEMENT_REQUIRES_USER",
        severity: "error",
        message: "공식 약관 동의가 남아 있습니다.",
      },
    ],
    ...overrides,
  };
}
function expected() {
  const value = review();
  return {
    ...binding,
    workflowRevision: value.workflowRevision,
    priorExecutionId: value.priorExecutionId,
    destination: value.destination,
  };
}

describe("텍스트 부분 실행 복구 제한", () => {
  it("정확한 대상과 시도 이력이 있는 현재 텍스트 중단 기록만 검토할 수 있다", () => {
    expect(ventureRecoveryBlockedReason(receipt(), binding, fields)).toBe("");
  });
  it.each(["running", "completed"] as const)("%s는 중단 복구로 표시하지 않는다", (status) => {
    expect(ventureRecoveryBlockedReason({ ...receipt(), status }, binding, fields)).not.toBe("");
  });
  it.each([
    "manifest",
    "previousAttempts",
    "requestedFieldKeys",
    "preservedFieldKeys",
    "touchedFieldKeys",
    "priorExecutionId",
  ] as const)("레거시 기록 %s 누락을 미시도로 간주하지 않는다", (property) => {
    const record = receipt();
    delete record[property];
    expect(ventureRecoveryBlockedReason(record, binding, fields)).toContain(
      "이전 실행은 복구할 수 없습니다",
    );
  });
  it("현재 또는 이전 결과가 불확실하면 새 실행 검토를 금지한다", () => {
    const record = receipt();
    record.code = "INPUT_RESULT_UNKNOWN";
    expect(ventureRecoveryBlockedReason(record, binding, fields)).toContain("미확인");
    const attempt = structuredClone(record);
    delete attempt.manifest;
    delete attempt.previousAttempts;
    const latest = receipt();
    latest.previousAttempts = [attempt];
    expect(ventureRecoveryBlockedReason(latest, binding, fields)).toContain("미확인");
  });
  it("이번 요청이 텍스트만이어도 원래 첨부 대상이 있었으면 복구를 금지한다", () => {
    const record = receipt();
    record.manifest!.targets[1].kind = "file";
    expect(ventureRecoveryBlockedReason(record, binding, fields)).toContain("첨부가 포함된 실행");
  });
  it("원인이 불명확한 INPUT_FAILED는 명시적 재검토 허용 코드로 간주하지 않는다", () => {
    expect(
      ventureRecoveryBlockedReason({ ...receipt(), code: "INPUT_FAILED" }, binding, fields),
    ).not.toBe("");
  });
  it.each([
    { companyRevision: 6 },
    { accountRevision: 3 },
    { sessionStartedAt: "2026-09-25T02:00:00.000Z" },
    { snapshotId: "other" },
    { caseId: "other-case" },
  ])("현재 연결 변경 시 복구를 막는다: %j", (change) => {
    expect(ventureRecoveryBlockedReason(receipt(), { ...binding, ...change }, fields)).toContain(
      "현재와 다릅니다",
    );
  });
});

describe("새 복구 검토안 응답 검증", () => {
  it("현재와 일치하고 보호 항목과 새 입력 대상이 겹치지 않는 검토만 표시한다", () => {
    const value = review();
    expect(validateVentureRecoveryReview(value, expected(), fields, new Set(["name"]))).toBe(value);
  });
  it("이미 건드린 빈 항목이 새 입력에 포함되면 거부한다", () => {
    expect(() =>
      validateVentureRecoveryReview(review(), expected(), fields, new Set(["capital"])),
    ).toThrow("현재 연결이 일치하지 않습니다");
  });
  it.each([
    { priorExecutionId: "other" },
    { workflowRevision: 3 },
    { companyRevision: 4 },
    { accountRevision: 1 },
    { sessionStartedAt: "2026-09-24T01:00:00.000Z" },
    { snapshotId: "other" },
    { destination: "https://example.com/application" },
    { observedAt: "invalid" },
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    { protectedFields: [] },
    { protectedFields: [{ fieldKey: "capital", label: "납입자본금" }] },
    { fields: [], fieldCount: 0 },
  ])("오래되거나 대상이 바뀐 검토안을 폐기한다: %j", (change) => {
    expect(() =>
      validateVentureRecoveryReview(review(change), expected(), fields, new Set(["name"])),
    ).toThrow();
  });
  it("정확한 금액 또는 단위·근거가 바뀐 검토안을 거부한다", () => {
    expect(() =>
      validateVentureRecoveryReview(
        review({ fields: [{ ...fields[1], value: "1000" }] }),
        expected(),
        fields,
        new Set(["name"]),
      ),
    ).toThrow();
    expect(() =>
      validateVentureRecoveryReview(
        review({
          fields: [{ ...fields[1], financialContext: { unit: "월", evidenceNote: "다른 메모" } }],
        }),
        expected(),
        fields,
        new Set(["name"]),
      ),
    ).toThrow();
  });
});

describe("별도 새 전송 승인 표시", () => {
  it("자동 요청 없이 새 검토 버튼과 제한만 표시한다", () => {
    const prepare = vi.fn(),
      execute = vi.fn();
    const html = renderToStaticMarkup(
      createElement(VentureinRecoveryPanel, {
        prepare,
        execute,
        busy: false,
        blockedReason: "결과 미확인",
        describeSource: () => "기업정보",
      }),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(html).toContain("검토 준비와 화면 대조만으로 입력하지 않습니다");
    expect(html).toContain("결과 미확인");
    expect(html).toMatch(/<button\b[^>]*\sdisabled=""/);
    expect(html).not.toContain('type="checkbox"');
  });
  it("새 승인 기본 미체크, 일치 항목 보호와 이번 정확한 입력값·단위·근거를 분리한다", () => {
    const execute = vi.fn(),
      onApprovalChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(VentureinRecoveryApproval, {
        review: review(),
        approved: false,
        busy: false,
        describeSource: () => "기업정보 · 납입자본금",
        onApprovalChange,
        onExecute: execute,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(onApprovalChange).not.toHaveBeenCalled();
    expect(html).toContain("과거 승인을 복원하지 않습니다");
    expect(html).toContain("현재 값 일치 · 입력 제외");
    expect(html).toContain("10000000");
    expect(html).toContain("입력 단위: 원");
    expect(html).toContain("가상 증빙 메모");
    expect(html).toContain("공식 약관 동의가 남아 있습니다");
    expect(html).toContain("2분 단회");
    expect(html).toContain("https://www.smes.go.kr/venturein/application-test");
    expect(html).not.toMatch(/<input\b[^>]*\schecked=""/);
    expect(html).toMatch(/<button\b[^>]*\sdisabled=""/);
    expect(html).toContain("사이트 처리 방식에 따라 즉시 전송·저장될 수 있습니다");
    expect(html).not.toContain("동의 완료");
  });
});
