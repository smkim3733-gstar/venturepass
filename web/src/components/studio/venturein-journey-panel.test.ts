import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { VentureExecutionRecord } from "@/lib/venturein-execution-schema";
import type { VentureJourney } from "@/lib/venturein-journey";
import { VentureinJourneyPanel } from "./venturein-journey-panel";

function fixture(overrides: Partial<VentureExecutionRecord> = {}): VentureJourney {
  const execution: VentureExecutionRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    snapshotId: "screen-test",
    status: "completed",
    startedAt: "2026-09-25T01:00:00.000Z",
    finishedAt: "2026-09-25T01:00:01.000Z",
    completedFieldKeys: ["company", "evidence"],
    attachmentFieldKeys: ["evidence"],
    attemptedFieldKey: null,
    code: null,
    ...overrides,
  };
  return {
    entries: [
      {
        id: "screen-test",
        snapshotId: "screen-test",
        url: "https://www.smes.go.kr/venturein/aply/v2",
        title: "가상 신청 화면",
        observedAt: "2026-09-25T01:00:00.000Z",
        fieldCount: 1,
        attachmentCount: 1,
        execution,
      },
    ],
    phase: execution.status === "completed" && !execution.code ? "handoff" : "verify",
    message: "공식 화면을 직접 확인하세요.",
  };
}

function render(
  journey: ComponentProps<typeof VentureinJourneyPanel>["journey"],
  canReadNext = false,
) {
  const onReadCurrent = vi.fn();
  const html = renderToStaticMarkup(
    createElement(VentureinJourneyPanel, {
      journey,
      currentSnapshotId: "screen-test",
      canReadNext,
      readNextBlockedReason: "실행 결과 확인 전에는 다음 연결을 사용할 수 없습니다.",
      onReadCurrent,
    }),
  );
  expect(onReadCurrent).not.toHaveBeenCalled();
  return html;
}

describe("신청 화면 진행 이력 렌더링", () => {
  it.each([undefined, null])(
    "진행 이력이 없는 이전 응답은 단계나 성공을 추정하지 않고 새로고침만 안내한다: %s",
    (journey) => {
      const html = render(journey, true);
      expect(html).toContain("진행 이력을 아직 불러오지 못했습니다");
      expect(html).toContain("점검 결과 새로고침");
      expect(html).not.toContain("현재 단계");
      expect(html).not.toContain("다음 화면 연결");
      expect(html).not.toContain("완료");
      expect(html).not.toContain("<button");
    },
  );

  it("완료 기록은 텍스트와 첨부 확인을 구분하고 기관의 접수 완료로 표시하지 않는다", () => {
    const html = render(fixture(), true);
    expect(html).toContain("화면 값·첨부 상태 확인");
    expect(html).toContain("텍스트 1개 · 첨부 1개");
    expect(html).toContain("기관의 저장·접수·심사 완료를 증명하지 않습니다");
    expect(html).toContain("전체 필수 항목이나 약관·동의가 완료됐다는 뜻이 아닙니다");
    expect(html).toContain("사이트에서 직접 이동한 뒤");
    expect(html).toContain("다음·저장·동의·제출 버튼을 누르지 않습니다");
    expect(html).toContain("다음 화면 연결");
    expect(html).not.toMatch(/<button\b[^>]*\sdisabled=""/);
  });

  it.each(["stopped", "completed"] as const)(
    "결과 미확인 코드는 %s 상태보다 우선하고 확인 0개를 미전송으로 해석하지 않는다",
    (status) => {
      const html = render(
        fixture({
          status,
          code: "INPUT_RESULT_UNKNOWN",
          completedFieldKeys: [],
          attemptedFieldKey: "evidence",
        }),
      );
      expect(html).toContain("실행 결과 미확인");
      expect(html).toContain("일부 또는 모든 값·파일이 이미 전송됐을 수 있습니다");
      expect(html).toContain("확인 0개가 미전송을 뜻하지");
      expect(html).toContain("공식 화면을 직접 확인하세요");
      expect(html).not.toContain("화면 값·첨부 상태 확인");
      expect(html).toMatch(/<button\b[^>]*\sdisabled=""/);
    },
  );

  it("진행 중 기록은 완료 표시 없이 결과 확인을 요구한다", () => {
    const html = render(fixture({ status: "running", finishedAt: null, completedFieldKeys: [] }));
    expect(html).toContain("실행 결과 확인 필요");
    expect(html).not.toContain("화면 값·첨부 상태 확인");
    expect(html).toMatch(/<button\b[^>]*\sdisabled=""/);
  });
});
