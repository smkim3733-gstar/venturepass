import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VentureinDisclosure, ventureDisclosureSections } from "./venturein-disclosure";

describe("벤처인 단계 표시", () => {
  it("서버 표시가 입력·검토 자식을 한 번 보존하고 동작을 호출하지 않는다", () => {
    const change = vi.fn();
    const html = renderToStaticMarkup(
      VentureinDisclosure({
        section: "execution",
        label: "합성 검토",
        title: "결과 확인",
        badge: "미확인",
        children: createElement("input", { value: "원래 검토안", onChange: change }),
      }),
    );
    expect(html).toContain('data-venture-disclosure="execution"');
    expect(html).toContain('open=""');
    expect(html).toContain('value="원래 검토안"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain("미확인");
    expect(change).not.toHaveBeenCalled();
  });
  it("항목 연결은 원본 첨부 연결도 펼치며 결과 확인은 검토 단계와 독립된다", () => {
    expect(ventureDisclosureSections("mapping")).toEqual(["mapping", "attachments"]);
    expect(ventureDisclosureSections("execution")).toEqual(["execution"]);
    const first = ventureDisclosureSections("mapping");
    first.pop();
    expect(ventureDisclosureSections("mapping")).toEqual(["mapping", "attachments"]);
  });
});
