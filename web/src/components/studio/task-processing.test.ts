import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskProcessing, TaskProcessingPlan } from "@/lib/studio-task-processing-types";
import { TaskProcessingEditor, TaskProcessingSummary } from "./task-processing";

const planId = "11111111-1111-4111-8111-111111111111";
const plans: TaskProcessingPlan[] = [
  {
    id: planId,
    version: 1,
    content: {
      title: "첫 원고",
      sections: [
        {
          key: "solution",
          title: "기술 내용",
          content: "합성 인용 <script>sample()</script> 확인 필요",
        },
      ],
    },
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    version: 2,
    content: {
      title: "둘째 원고",
      sections: [{ key: "solution", title: "기술 내용", content: "다른 원고 내용" }],
    },
  },
];
const processing: TaskProcessing = {
  stage: "ready",
  planRefs: [{ planId, sectionKey: "solution", quote: "<script>sample()</script>" }],
};

describe("업무 내부 처리 단계·원고 연결 UI", () => {
  it("기존 업무는 미지정이며 단계를 선택하기 전 원고 연결 추가를 막는다", () => {
    const html = renderToStaticMarkup(
      createElement(TaskProcessingEditor, { processing: undefined, plans, onChange: vi.fn() }),
    );
    expect(html).toContain('value="" disabled="" selected=""');
    expect(html).toContain("미지정 · 단계를 선택해 주세요");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>[\s\S]*?원고 항목 연결 추가/);
    const summary = renderToStaticMarkup(
      createElement(TaskProcessingSummary, { processing: undefined, plans }),
    );
    expect(summary).toContain("내부 처리 단계: 미지정");
  });
  it("내부 준비 완료를 기관 송수신·법적 검토·업무 완료와 구분한다", () => {
    const html = renderToStaticMarkup(createElement(TaskProcessingSummary, { processing, plans }));
    expect(html).toContain("내부 준비 완료(담당자 기록)");
    expect(html).toContain("기관 송수신·법적 검토·원고 검토 완료를 뜻하지 않으며");
    expect(html).toContain("업무의 진행 필요·완료 표시는 별도로 관리합니다");
    expect(html).toContain("작성본 v1 · 기술 내용");
    expect(html).toContain("현재 최신 버전과 다른 작성본을 연결했습니다");
    expect(html).not.toContain("둘째 원고");
  });
  it("인용은 안전한 텍스트로 렌더하고 현재 찾지 못하는 연결을 대체하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(TaskProcessingSummary, { processing, plans: [] }),
    );
    expect(html).toContain("원고 연결 1 · 확인 필요");
    expect(html).toContain("다른 원고로 대체하지 않습니다");
    expect(html).toContain("&lt;script&gt;sample()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("서버 대조 실패나 편집 미완료 인용은 저장 가능한 일치로 표시하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(TaskProcessingEditor, {
        processing: {
          ...processing,
          planRefs: [{ ...processing.planRefs[0], quote: "없는 내용" }],
        },
        plans,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain("정확히 포함된 인용만 저장할 수 있습니다");
    expect(html).not.toContain("항목에 인용이 있습니다");
    expect(html).toContain('maxLength="1500"');
  });
  it("작성본이 없는 경우 원고 연결을 만들거나 준비 상태를 추정하지 않는다", () => {
    const html = renderToStaticMarkup(
      createElement(TaskProcessingEditor, {
        processing: { stage: "collecting", planRefs: [] },
        plans: [],
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain("저장된 작성본이 없습니다");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>[\s\S]*?원고 항목 연결 추가/);
  });
  it("10개 연결 한도에서는 추가를 막고 기존 연결은 표시한다", () => {
    const html = renderToStaticMarkup(
      createElement(TaskProcessingEditor, {
        processing: {
          stage: "writing",
          planRefs: Array.from({ length: 10 }, (_, i) => ({
            ...processing.planRefs[0],
            sectionKey: `section-${i}`,
          })),
        },
        plans,
        onChange: vi.fn(),
      }),
    );
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>[\s\S]*?원고 항목 연결 추가/);
    expect(html).toContain("원고 연결 10 제거");
  });
  it("같은 페이지에 편집기가 둘 있어도 label 대상 ID가 겹치지 않는다", () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(TaskProcessingEditor, { processing, plans, onChange }),
        createElement(TaskProcessingEditor, { processing, plans, onChange }),
      ),
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    const labels = [...html.matchAll(/ for="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(ids.length);
    expect(labels.every((label) => ids.includes(label))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
