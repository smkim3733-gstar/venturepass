import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginForm, safeNextPath } from "./login-form";

describe("staff login form", () => {
  it("renders email and password fields with Korean labels", () => {
    const html = renderToStaticMarkup(createElement(LoginForm));
    expect(html).toContain("담당자 로그인");
    expect(html).toContain("current-password");
    expect(html).toContain('type="password"');
    expect(html).toContain("관리자가 승인한 담당자만");
  });

  it.each([
    [null, "/studio"],
    ["/studio?case=1", "/studio?case=1"],
    ["https://evil.example", "/studio"],
    ["//evil.example", "/studio"],
    ["/\\evil.example", "/studio"],
  ])("only follows same-site next paths (%s)", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });
});
