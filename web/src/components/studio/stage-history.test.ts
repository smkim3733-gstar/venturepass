import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageHistory } from "./stage-history";

describe("단계 기록의 표시 범위", () => {
  it("빈 과거 이력을 기관 확인 기록으로 추정하지 않는다", () => {
    const html = renderToStaticMarkup(React.createElement(StageHistory, { records: [] }));
    expect(html).toContain("과거 이력은 추정해서 만들지 않습니다");
    expect(html).toContain("자동 확인한 기록이 아닙니다");
  });
  it("수동·앱 변경과 발생일·기록 시각을 분리하며 메모 HTML을 실행하지 않는다", () => {
    const html = renderToStaticMarkup(
      React.createElement(StageHistory, {
        records: [
          {
            id: "manual",
            from: "drafting",
            to: "submitted",
            origin: "manual",
            recordedAt: "2026-09-25T00:00:00.000Z",
            occurredOn: "2026-09-24",
            note: "<script>unsafe()</script>",
          },
          {
            id: "auto",
            from: "preparing",
            to: "drafting",
            origin: "plan-created",
            recordedAt: "2026-09-24T00:00:00.000Z",
            occurredOn: "",
            note: "",
          },
        ],
      }),
    );
    expect(html).toContain("담당자 기록");
    expect(html).toContain("앱 자동 변경");
    expect(html).toContain("담당자가 입력한 발생일 2026-09-24");
    expect(html).toContain("발생일 미기재");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>unsafe()");
  });
});
