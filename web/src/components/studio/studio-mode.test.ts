import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PreparedPackagesPanel } from "./prepared-packages-panel";
import { StudioModeProvider } from "./studio-mode";

vi.mock("server-only", () => ({}));

function render(serverMode: boolean, element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(StudioModeProvider, { serverMode }, element));
}
const panel = () =>
  createElement(PreparedPackagesPanel, {
    company: { id: "case" } as never,
    plan: undefined,
    dirty: false,
    blocked: false,
    onBusyChange: () => {},
    onUnsettledChange: () => {},
    onClose: () => {},
  });

describe("preserved packages in both modes", () => {
  it("offers preserved versions on the web service with the web storage notice", () => {
    const html = render(true, panel());
    expect(html).toContain("원고와 첨부 보관");
    expect(html).toContain("웹 서비스에 보관한 준비본입니다");
    expect(html).toContain("기업을 삭제하면 함께 삭제됩니다");
    expect(html).not.toContain("이 PC의 준비본입니다");
    expect(html).not.toContain("이 PC 앱에서만 제공합니다");
  });

  it("keeps the PC app wording unchanged", () => {
    const html = render(false, panel());
    expect(html).toContain("이 PC의 준비본입니다");
    expect(html).not.toContain("웹 서비스에 보관한 준비본입니다");
  });
});
