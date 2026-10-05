import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

vi.mock("server-only", () => ({}));
import { collectVentureMyStatus } from "./venturein-my-status-collector";
import { ventureMyStatusUrl } from "./venturein-my-status";
import { myStatusExpected, myStatusFixture, myStatusHtml } from "./venturein-my-status-test-fixture";

let browser: Browser;
const contexts: BrowserContext[] = [];
beforeAll(async () => { browser = await chromium.launch({ channel: "msedge", headless: true }); });
afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
afterAll(async () => { await browser?.close(); });

async function pageWith(html = myStatusHtml(), url = ventureMyStatusUrl + "?synthetic=only") {
  const context = await browser.newContext({ serviceWorkers: "block" }); contexts.push(context);
  let routed = 0;
  await context.route("**/*", async (route) => {
    routed++;
    if (!route.request().isNavigationRequest()) { await route.abort(); return; }
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  });
  const page = await context.newPage(); await page.goto(url);
  return { page, routed: () => routed };
}
const read = (page: Page, current: () => void = () => {}) => collectVentureMyStatus(page, myStatusExpected, current);

describe("MY벤처현황 real DOM reader with entirely routed synthetic pages", () => {
  it("reads two scoped tables atomically, ignores private columns and never clicks/writes/navigates", async () => {
    const { page, routed } = await pageWith();
    await page.evaluate(() => {
      Object.defineProperty(HTMLInputElement.prototype, "value", { get() { throw new Error("Do not read input values"); } });
    });
    const before = await page.content(), requests = routed();
    const result = await read(page);
    expect(result).toMatchObject({ origin: "page-observation", target: { state: "matched", row: { resultText: "확인" } },
      officialStatusChecked: false, databaseChanged: false, receiptVerified: false });
    expect(result.certificates.rows[0]?.typeText).toBe("혁신성장유형");
    expect(result.url).toBe(ventureMyStatusUrl);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|synthetic=only|777-77/);
    expect(await page.content()).toBe(before);
    expect(routed()).toBe(requests);
  });
  it("reads the nine-column variant and an unrelated first result", async () => {
    const f = myStatusFixture();
    if (f.applications.state !== "observed") throw new Error("fixture");
    f.applications.headers.splice(4, 0, "이의신청가능기간");
    f.applications.rows.forEach((r) => r.splice(4, 0, "OTHER"));
    const { page } = await pageWith(myStatusHtml(f));
    expect((await read(page)).target.row?.applicationNumber).toBe("SYNTHETIC-REQUEST-B");
  });
  it("does not join a certificate body from an adjacent, unrelated container", async () => {
    const { page } = await pageWith(myStatusHtml(myStatusFixture(), false));
    const out = await read(page);
    expect(out.certificates.state).toBe("unsupported");
    expect(out.target.state).toBe("matched");
  });
  it.each(["duplicate", "span", "hidden-cell", "editable-cell", "unknown-column", "row-limit", "cell-limit"])(
    "rejects the application section for %s without returning a guessed row", async (kind) => {
      const { page } = await pageWith();
      await page.evaluate((kind) => {
        const table = [...document.querySelectorAll("table")].find(t => t.querySelector("caption")?.textContent?.startsWith("벤처확인 신청이력 목록"))!;
        if (kind === "duplicate") table.parentElement!.appendChild(table.cloneNode(true));
        if (kind === "span") table.querySelector("tbody td")!.setAttribute("colspan", "8");
        if (kind === "hidden-cell") (table.querySelector("tbody td") as HTMLElement).style.display = "none";
        if (kind === "editable-cell") table.querySelector("tbody td")!.innerHTML = '<input value="PRIVATE">';
        if (kind === "unknown-column") table.querySelectorAll("th")[4].textContent = "알 수 없음";
        if (kind === "row-limit") for (let i = 0; i < 100; i++) table.querySelector("tbody")!.appendChild(table.querySelector("tbody tr")!.cloneNode(true));
        if (kind === "cell-limit") table.querySelectorAll("tbody tr")[0].querySelectorAll("td")[4].textContent = "x".repeat(501);
      }, kind);
      const out = await read(page);
      expect(out.applications.state).toBe("unsupported");
      expect(out.target.row).toBeNull();
    });
  it.each(["logout-hidden", "password", "company-changed", "iframe"])("blocks unsafe current context %s", async (kind) => {
    const { page } = await pageWith();
    await page.evaluate((kind) => {
      if (kind === "logout-hidden") (document.querySelector('a[href$="logout"]') as HTMLElement).style.display = "none";
      if (kind === "password") document.body.insertAdjacentHTML("beforeend", '<input type="password" value="PRIVATE">');
      if (kind === "company-changed") document.querySelector("table td")!.textContent = "888-88-00002";
      if (kind === "iframe") document.body.insertAdjacentHTML("beforeend", '<iframe srcdoc="<p>private</p>"></iframe>');
    }, kind);
    await expect(read(page)).rejects.toThrow(expect.objectContaining({
      code: ["company-changed", "iframe"].includes(kind) ? "COMPANY_UNVERIFIED" : "READ_FAILED",
    }));
  });
  it("requires the supported path and never navigates toward it", async () => {
    const { page, routed } = await pageWith(myStatusHtml(), "https://www.smes.go.kr/venturein/aply/v2");
    await expect(read(page)).rejects.toThrow(expect.objectContaining({ code: "UNSUPPORTED_PAGE" }));
    expect(routed()).toBe(1);
  });
  it("copies expectations before the first await and rechecks caller revision", async () => {
    const { page } = await pageWith();
    const expected = { ...myStatusExpected };
    const pending = collectVentureMyStatus(page, expected, () => {});
    expected.applicationNumber = "SYNTHETIC-REQUEST-A";
    expect((await pending).target.row?.applicationNumber).toBe("SYNTHETIC-REQUEST-B");
    let checks = 0;
    await expect(read(page, () => {
      checks++;
      if (checks === 5) throw new Error("PRIVATE-CALLER-CONTEXT");
    })).rejects.toThrow(expect.objectContaining({ code: "READ_FAILED" }));
  });
  it("rejects the same URL with a replaced document and suppresses low-level data", async () => {
    const { page } = await pageWith();
    const original = page.evaluate.bind(page);
    let calls = 0;
    vi.spyOn(page, "evaluate").mockImplementation(async (...args: Parameters<Page["evaluate"]>) => {
      calls++;
      if (calls === 2) await page.reload();
      return original(...args);
    });
    await expect(read(page)).rejects.toThrow(expect.objectContaining({ code: "READ_FAILED" }));
  });
  it("rejects malformed expectations before any Page read", async () => {
    const { page, routed } = await pageWith();
    const url = vi.spyOn(page, "url");
    await expect(collectVentureMyStatus(page, { ...myStatusExpected, unexpected: true } as typeof myStatusExpected, () => {}))
      .rejects.toThrow(expect.objectContaining({ code: "INVALID_OBSERVATION" }));
    expect(url).not.toHaveBeenCalled();
    expect(routed()).toBe(1);
  });
  it("rechecks caller ownership after awaited handle cleanup", async () => {
    const { page } = await pageWith();
    let checks = 0;
    await expect(read(page, () => {
      checks++;
      if (checks === 7) throw new Error("PRIVATE-REPLACED-OWNER");
    })).rejects.toThrow(expect.objectContaining({ code: "READ_FAILED" }));
    expect(checks).toBe(7);
  });

  it("rejects a company switch between the initial snapshot and the atomic table read", async () => {
    const { page } = await pageWith();
    const original = page.evaluate.bind(page);
    let calls = 0;
    vi.spyOn(page, "evaluate").mockImplementation(async (...args: Parameters<Page["evaluate"]>) => {
      calls++;
      if (calls === 2) await original(() => { document.querySelector("table td")!.textContent = "888-88-00002"; });
      return original(...args);
    });
    await expect(read(page)).rejects.toThrow(expect.objectContaining({ code: "READ_FAILED" }));
  });

});
