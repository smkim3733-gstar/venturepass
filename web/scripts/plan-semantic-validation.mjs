import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, access } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

// Only bundles synthetic fixtures and actual UI components; never starts Next or loads .env.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.resolve(app, "../../.venturepass-tools/build-temp");
await mkdir(temporaryRoot, { recursive: true });
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-semantic-"));
const corpusBytes = await readFile(
  path.join(app, "src/lib/fixtures/plan-semantic-contrast-cases.json"),
);
const corpus = JSON.parse(corpusBytes);
const requireFromVitest = createRequire(
  createRequire(import.meta.url).resolve("vitest/package.json"),
);
const { rolldown } = await import(pathToFileURL(requireFromVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  // Every imported component runs in this browser-only harness; there is no RSC boundary.
  onwarn(warning, defaultHandler) {
    if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes('"use client"'))
      return;
    defaultHandler(warning);
  },
  input: path.join(app, "scripts/plan-semantic-browser.tsx"),
  cwd: app,
  platform: "browser",
  tsconfig: path.join(app, "tsconfig.json"),
  resolve: { alias: { "@": path.join(app, "src") } },
  transform: { define: { "process.env.NODE_ENV": '"production"' }, jsx: { runtime: "automatic" } },
});
try {
  await bundle.write({ file: path.join(output, "harness.js"), format: "iife" });
} finally {
  await bundle.close();
}
const html = `<!doctype html><html lang="ko"><meta charset="utf-8">
<title>VenturePass 합성 사례 내부 UI 검증</title>
<style>
body{font:15px/1.7 "Malgun Gothic",sans-serif;background:#f5f7fa;color:#152536;margin:0}
nav,main{max-width:1000px;margin:20px auto;background:white;padding:24px;border:1px solid #dbe2ea;border-radius:14px}
h1{font-size:23px}h3{font-size:17px}section,details{padding:16px;margin:14px 0;border:1px solid #dbe2ea;border-radius:10px}
label{display:block;font-weight:600;margin-top:10px}textarea,input,select{box-sizing:border-box;font:inherit;padding:8px;max-width:100%;border:1px solid #9aabba;border-radius:6px}
textarea{width:100%;min-height:100px}button{font:inherit;padding:6px 12px;margin:6px;border:1px solid #b4c9db;border-radius:6px;background:#eaf3ff;cursor:pointer}
button:disabled,select:disabled{opacity:.5}blockquote{border-left:3px solid #2563a6;padding-left:16px;margin-left:0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}svg{width:16px;height:16px}
[data-testid=requests],[data-testid=dirty]{display:none}
[role=alert]{color:#a01818}fieldset{border:1px solid #cbd5df;margin-top:16px}
</style><nav>검증 전용 화면 · 운영 앱 경로가 아닙니다 · 화면 스타일은 시험용입니다</nav>
<div id="root"></div><script src="/harness.js"></script></html>`;
await writeFile(path.join(output, "index.html"), html);
const served = new Map([
  ["/", { type: "text/html; charset=utf-8", bytes: Buffer.from(html) }],
  [
    "/harness.js",
    {
      type: "text/javascript; charset=utf-8",
      bytes: await readFile(path.join(output, "harness.js")),
    },
  ],
]);
const server = createServer((request, response) => {
  const entry = served.get(request.url);
  if (!entry) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" })
    .end(entry.bytes);
});
let browser;
const checks = [];
const blockedNetwork = [];
const errors = [];
const record = (name) => checks.push({ name, passed: true });
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ];
  let executablePath;
  for (const candidate of candidates) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      executablePath = candidate;
      break;
    }
  }
  assert.ok(executablePath, "An installed Chromium browser is required; no download is performed");
  browser = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block",
  });
  await browser.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      blockedNetwork.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#draft").waitFor();
  const selectCase = async (id) => {
    await page.locator("#case").selectOption(id);
    await page.waitForFunction(
      (value) => document.querySelector("h1")?.textContent?.startsWith(value + " · "),
      id,
    );
  };
  const state = () => page.getByTestId("original").textContent().then(JSON.parse);
  const requests = () => page.getByTestId("requests").textContent().then(JSON.parse);
  const language = page.getByRole("region", { name: "한국어 표현 점검", exact: true });
  const original = await state();
  assert.equal(await language.locator("li").count(), 4);
  await language.getByRole("button", { name: "해당 항목 보기 →" }).first().click();
  assert.equal(await page.getByTestId("section").textContent(), "funding");
  record("English advice and section navigation");
  await page.locator("#draft").fill(corpus.cases.find((item) => item.id === "K2").draft);
  await page.getByText("점검 대상 영어 표현이 없습니다.", { exact: false }).waitFor();
  assert.deepEqual(await state(), original);
  assert.equal(
    await page.getByTestId("source").textContent(),
    corpus.cases.find((item) => item.id === "K1").sources[0].text,
  );
  record(
    "Unsaved Korean edit clears advice while quotes, stored draft and confirmation remain unchanged",
  );

  for (const item of corpus.cases) {
    await selectCase(item.id);
    const reviews = page.getByTestId("reviews");
    assert.equal(
      await reviews.getByRole("button", { name: "해당 항목 보기 →" }).count(),
      item.expected.displayGroups.length,
    );
    const options = page.locator("#plan-review-finding option");
    assert.equal(
      await options.count(),
      item.storedReview.length ? item.storedReview.length + 1 : 0,
    );
    assert.equal(await language.locator("li").count(), item.expected.languageTerms.length);
    if (!item.storedReview.length)
      assert.match(await reviews.textContent(), /사실과 증빙은 직접 확인/);
    const saved = await state();
    assert.equal(saved.confirmedAt, null);
    assert.equal(saved.content.sections[0].needsConfirmation, true);
    assert.deepEqual(saved.review, item.storedReview);
    record(item.id + " stored display and original decision options");
  }
  await selectCase("R0");
  await page.getByText("동일 의견 2건 · 원본 1, 2번", { exact: true }).waitFor();
  assert.equal(await page.locator("#plan-review-finding").inputValue(), "");
  await page.getByTestId("reviews").getByRole("button", { name: "해당 항목 보기 →" }).click();
  assert.equal(await page.getByTestId("section").textContent(), "funding");
  const r0 = await state();
  for (const index of [0, 1]) {
    if (index === 1) page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#plan-review-finding").selectOption(String(index));
    const save = page.getByRole("button", { name: "검토 판단 이력 저장", exact: true });
    const beforeCount = (await requests()).length;
    await save.click();
    await page.getByRole("alert").filter({ hasText: "담당자와 판단 이유" }).waitFor();
    assert.equal((await requests()).length, beforeCount);
    await page.locator("#plan-review-reviewer").fill("합성 시험 담당자");
    await page.locator("#plan-review-reason").fill("합성 시험: 원래 의견 번호를 대조했습니다.");
    await page.locator("#plan-review-status").selectOption("deferred");
    await save.click();
    await page.getByRole("alert").filter({ hasText: "저장 결과를 확인하지 못했습니다." }).waitFor();
    await page.waitForFunction(
      (count) =>
        JSON.parse(document.querySelector('[data-testid="requests"]').textContent).length === count,
      beforeCount + 1,
    );
    const sent = (await requests()).at(-1);
    assert.equal(sent.action, "append-plan-review");
    assert.equal(sent.decision.findingIndex, index);
    assert.deepEqual(sent.decision.finding, r0.review[index]);
    assert.equal(await page.locator("#plan-review-reviewer").inputValue(), "합성 시험 담당자");
    await save.click();
    await page.waitForFunction(
      (count) =>
        JSON.parse(document.querySelector('[data-testid="requests"]').textContent).length === count,
      beforeCount + 2,
    );
    const retry = (await requests()).at(-1);
    assert.deepEqual(retry, sent);
    assert.deepEqual(await state(), r0);
    record(
      "R0 original index " +
        index +
        ": required fields, missing acknowledgement, stable retry nonce, no confirmation",
    );
  }
  await page.screenshot({ path: path.join(output, "review-decisions.png"), fullPage: true });
  await page.locator("#draft").fill("합성 원고 편집 중");
  assert.equal(await page.locator("#plan-review-finding").isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "검토 판단 이력 저장", exact: true }).isDisabled(),
    true,
  );
  record("Unsaved draft blocks decision selection and save");
  await selectCase("R1");
  await page.screenshot({ path: path.join(output, "paraphrase-preservation.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await selectCase("K1");
  await page.screenshot({ path: path.join(output, "language-mobile.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  record("Narrow component harness has no horizontal overflow");
  assert.deepEqual(blockedNetwork, []);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        scope: "synthetic-component-interaction-only",
        providerCalls: 0,
        databaseWrites: 0,
        modelSemanticEvaluation: "not-performed",
        humanAcceptance: "not-performed",
        corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
        checks,
        blockedNetwork,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, checks: checks.length, result: "passed" }));
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
