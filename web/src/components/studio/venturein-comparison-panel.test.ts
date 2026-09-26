import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  VentureInputComparison,
  VentureInputComparisonField,
} from "@/lib/venturein-execution-schema";
import {
  validateVentureInputComparison,
  VentureinComparisonPanel,
  VentureinComparisonResult,
} from "./venturein-comparison-panel";

const binding = {
  workflowRevision: 3,
  companyRevision: 5,
  accountRevision: 2,
  snapshotId: "synthetic-screen",
  sessionStartedAt: "2026-09-25T01:00:00.000Z",
};
function fixture(overrides: Partial<VentureInputComparison> = {}): VentureInputComparison {
  return {
    scope: "current-mapping",
    observedAt: "2026-09-25T01:02:00.000Z",
    ...binding,
    fields: [
      { fieldKey: "name", kind: "text", state: "matched", code: null },
      { fieldKey: "source", kind: "file", state: "empty", code: null },
      { fieldKey: "capital", kind: "text", state: "conflict", code: null },
      { fieldKey: "month", kind: "text", state: "unknown", code: "FIELD_READ_FAILED" },
    ],
    ...overrides,
  };
}
const selectedFields = new Map<string, VentureInputComparisonField["kind"]>([
  ["name", "text"],
  ["source", "file"],
  ["capital", "text"],
  ["month", "text"],
]);

describe("읽기 전용 현재 화면 대조", () => {
  it("명시적 클릭 전에는 비교나 입력 요청 없이 관측 범위와 승인 제한을 설명한다", () => {
    const compare = vi.fn();
    const html = renderToStaticMarkup(
      createElement(VentureinComparisonPanel, {
        compare,
        blockedReason: "",
        busy: false,
        fieldLabel: (key) => key,
      }),
    );
    expect(compare).not.toHaveBeenCalled();
    expect(html).toContain("현재 화면과 연결안 대조");
    expect(html).toContain("과거 승인 내용을 복원하거나 새 실행을 허가하지 않습니다");
    expect(html).toContain("미확인 상태나 재실행 제한은 해제되지 않습니다");
    expect(html).toContain("기관의 저장·접수 상태도 확인하지 않습니다");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("관측 시각");
    expect(html).not.toMatch(/<button\b[^>]*\sdisabled=""/);
  });

  it.each([
    { blockedReason: "현재 연결이 변경되었습니다.", busy: false },
    { blockedReason: "", busy: true },
  ])("다른 작업 또는 오래된 연결에서는 대조를 허용하지 않는다: %j", (state) => {
    const html = renderToStaticMarkup(
      createElement(VentureinComparisonPanel, {
        compare: vi.fn(),
        ...state,
        fieldLabel: (key) => key,
      }),
    );
    expect(html).toMatch(/<button\b[^>]*\sdisabled=""/);
    if (state.blockedReason) expect(html).toContain(state.blockedReason);
  });

  it("일치·빈칸·상충·미확인과 관측 시점을 구분하고 파일 공란을 미전송 증명으로 표시하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(VentureinComparisonResult, {
        comparison: fixture(),
        fieldLabel: (key) => `선택 항목 ${key}`,
      }),
    );
    for (const label of ["일치", "빈칸", "상충", "미확인", "관측 시각", "선택 항목 source"])
      expect(html).toContain(label);
    expect(html).toContain("이 시각 이후의 화면 변경은 반영하지 않습니다");
    expect(html).toContain("이전에 파일이 전송되지 않았다는 뜻은 아닙니다");
    expect(html).toContain("일치하거나 비어 있다고 판단하지 않습니다");
    expect(html).not.toContain("입력 완료");
    expect(html).not.toContain('type="checkbox"');
  });

  it("첨부 일치는 현재 선택 파일의 SHA256까지 확인하며 기관 수신·서버 저장을 증명하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(VentureinComparisonResult, {
        comparison: fixture({
          fields: [{ fieldKey: "source", kind: "file", state: "matched", code: null }],
        }),
        fieldLabel: () => "가상 증빙",
      }),
    );
    expect(html).toContain("이름·크기·형식·SHA256이 연결 원본과 일치합니다");
    expect(html).toContain("기관의 수신·서버 저장을 증명하지 않습니다");
  });
});

describe("대조 응답과 현재 연결의 일치 검사", () => {
  it("현재 연결과 정확히 같은 선택 대상의 대조만 받는다", () => {
    const comparison = fixture();
    expect(validateVentureInputComparison(comparison, binding, selectedFields)).toBe(comparison);
  });

  it.each([
    { workflowRevision: 2 },
    { companyRevision: 4 },
    { accountRevision: 1 },
    { snapshotId: "old-screen" },
    { sessionStartedAt: "2026-09-25T00:00:00.000Z" },
    { observedAt: "invalid" },
  ])("오래되거나 유효하지 않은 응답을 폐기한다: %j", (changes) => {
    expect(() => validateVentureInputComparison(fixture(changes), binding, selectedFields)).toThrow(
      "현재 연결이 일치하지 않습니다",
    );
  });

  it.each(["missing", "duplicate", "other-kind", "other-field", "invalid-state", "unsafe-code"])(
    "선택 대상이 바뀌거나 불완전한 응답을 거부한다: %s",
    (kind) => {
      const comparison = fixture();
      if (kind === "missing") comparison.fields.pop();
      if (kind === "duplicate") comparison.fields[1] = { ...comparison.fields[0] };
      if (kind === "other-kind") comparison.fields[0].kind = "file";
      if (kind === "other-field") comparison.fields[0].fieldKey = "other";
      if (kind === "invalid-state")
        comparison.fields[0].state = "approved" as VentureInputComparisonField["state"];
      if (kind === "unsafe-code") comparison.fields[0].code = "untrusted/raw-value";
      expect(() => validateVentureInputComparison(comparison, binding, selectedFields)).toThrow(
        "현재 연결이 일치하지 않습니다",
      );
    },
  );

  it("대상이 없는 응답을 모든 항목 일치로 해석하지 않는다", () => {
    expect(() =>
      validateVentureInputComparison(fixture({ fields: [] }), binding, new Map()),
    ).toThrow("현재 연결이 일치하지 않습니다");
  });
});
