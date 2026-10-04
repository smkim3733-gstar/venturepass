import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { GuidedVentureConnection } from "./guided-venture-connection";
it("SSR renders a local-reading state and no execution, credentials or automatic external navigation", () => {
  const fetchGuard = vi.fn(() => {
    throw Error("SSR read forbidden");
  });
  vi.stubGlobal("fetch", fetchGuard);
  try {
    const onOpen = vi.fn();
    const html = renderToStaticMarkup(
      createElement(GuidedVentureConnection, {
        company: { id: "11111111-1111-4111-8111-111111111111", revision: 0 },
        disabled: false,
        onOpen,
      }),
    );
    expect(fetchGuard).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(html).toContain("수수료 납부 후 접수완료");
    expect(html).toContain("공식 사이트 조회나 로그인은 실행하지 않습니다.");
    expect(html).toContain("전체 자동 제출·접수");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toMatch(/<input|<iframe|<script|<details[^>]* open/);
    expect(html).not.toContain('class="primary"');
  } finally {
    vi.unstubAllGlobals();
  }
});
it("a locked view offers no external link or enabled action", () => {
  const html = renderToStaticMarkup(
    createElement(GuidedVentureConnection, {
      company: { id: "11111111-1111-4111-8111-111111111111", revision: 0 },
      disabled: true,
      onOpen: vi.fn(),
    }),
  );
  expect(html).not.toContain("<a ");
  expect(html).toContain('disabled=""');
});
