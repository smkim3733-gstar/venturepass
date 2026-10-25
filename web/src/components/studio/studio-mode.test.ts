import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PreparedPackagesPanel } from "./prepared-packages-panel";
import { StudioModeProvider } from "./studio-mode";

vi.mock("server-only", () => ({}));

const notice = "이 PC 앱에서만 제공합니다";
function render(serverMode: boolean, element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(StudioModeProvider, { serverMode }, element));
}

describe("package features on the web service", () => {
  it("offers the package ZIP without the PC-only preserved versions on the web service", () => {
    const html = render(
      true,
      createElement(PreparedPackagesPanel, {
        company: { id: "case" } as never,
        plan: undefined,
        dirty: false,
        blocked: false,
        onBusyChange: () => {},
        onUnsettledChange: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain("제출 준비 ZIP 내려받기");
    expect(html).toContain(notice);
    expect(html).not.toContain("이 PC의 준비본입니다");
  });
});
