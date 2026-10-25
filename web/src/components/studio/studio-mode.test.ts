import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PackagePanel } from "./package-panel";
import { PreparedPackagesPanel } from "./prepared-packages-panel";
import { VisitPackagePanel } from "./visit-package-panel";
import { StudioModeProvider } from "./studio-mode";

vi.mock("server-only", () => ({}));

const notice = "이 PC 앱에서만 제공합니다";
function render(serverMode: boolean, element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(StudioModeProvider, { serverMode, children: element }));
}

describe("PC-only features on the web service", () => {
  it.each([
    ["제출 준비 묶음 ZIP", PackagePanel],
    ["원고·첨부 보관과 내려받기", PreparedPackagesPanel],
    ["실사 준비 ZIP", VisitPackagePanel],
  ] as const)("replaces %s with a PC-only notice in server mode", (feature, Panel) => {
    const html = render(
      true,
      createElement(Panel as never, {} as ComponentProps<typeof PackagePanel>),
    );
    expect(html).toContain(feature);
    expect(html).toContain(notice);
  });
});
