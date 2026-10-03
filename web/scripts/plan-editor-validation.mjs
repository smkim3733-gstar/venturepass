import assert from "node:assert/strict";
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-editor-"));
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
  input: path.join(app, "scripts/plan-editor-browser.tsx"),
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
  await page.locator("#plan-summary").waitFor();

  const saved = () => page.getByTestId("saved").textContent().then(JSON.parse);
  const requests = () => page.getByTestId("requests").textContent().then(JSON.parse);
  const language = page.getByRole("region", { name: "한국어 표현 점검", exact: true });
  const card = (label) =>
    language.locator("li").filter({ has: page.getByText(label, { exact: true }) });
  const go = async (label, id) => {
    await card(label).getByRole("button", { name: "편집 위치로 이동 →" }).first().click();
    await page.waitForFunction((id) => document.activeElement?.id === id, id);
  };
  const reset = async () => {
    await page.locator("#reset").click();
    await page.waitForFunction(() =>
      document.querySelector("#plan-summary")?.value.includes("current"),
    );
  };
  const original = await saved();
  const originalPlan = original.plans.find((p) => p.version === 2);
  assert.equal(await language.locator("li").count(), 10);
  for (const [label, id] of [
    ["사업계획서 제목", "plan-title"],
    ["핵심 요약", "plan-summary"],
    ["보강 과제 2", "plan-action-item-1"],
    ["실사 준비 질문 1", "plan-interview-question-0"],
    ["unknown 자금 계획 · 제목", "plan-section-title"],
    ["unknown 자금 계획", "plan-section"],
  ])
    await go(label, id);
  assert.deepEqual(await saved(), original);
  assert.deepEqual(await requests(), []);
  assert.equal(await page.getByTestId("dirty").textContent(), "false");
  record(
    "Every advice location focuses the actual editor; collapsed lists open without mutating data",
  );
  assert.equal(await page.locator("#plan-section-title").inputValue(), "unknown 자금 계획");
  assert.equal(
    await page.locator("#plan-section").inputValue(),
    originalPlan.content.sections[1].content,
  );
  record("A different section is selected before title/body focus");

  await go("사업계획서 제목", "plan-title");
  await page.locator("#plan-title").fill("향후 제안 원고");
  await go("핵심 요약", "plan-summary");
  await page
    .locator("#plan-summary")
    .fill("현재 활동과 연결한 후보. 문서 기재, 담당자 설명, 향후 계획, 근거 미확인.");
  await go("unknown 자금 계획 · 제목", "plan-section-title");
  await page.locator("#plan-section-title").fill("분류 확인이 필요한 자금 계획");
  assert.equal(
    await page
      .getByRole("checkbox", { name: "이 항목의 사실·수치·증빙과 실행계획을 확인했습니다." })
      .isChecked(),
    false,
  );
  await go("분류 확인이 필요한 자금 계획", "plan-section");
  await page
    .locator("#plan-section")
    .fill("담당자 설명에 따른 자금 메모, 현재 가용성은 확인 필요.");
  await go("보강 과제 2", "plan-action-item-1");
  await page.locator("#plan-action-item-1").fill("향후 계획의 비용 점검");
  await go("실사 준비 질문 1", "plan-interview-question-0");
  await page.locator("#plan-interview-question-0").fill("근거가 확인되지 않은 권리는 무엇인가요?");
  await page.getByText("점검 대상 영어 표현이 없습니다.", { exact: false }).waitFor();
  assert.deepEqual(await saved(), original);
  assert.deepEqual(await requests(), []);
  assert.equal(await page.getByTestId("dirty").textContent(), "true");
  assert.equal(
    await page.getByRole("button", { name: "검토 완료 표시", exact: true }).isDisabled(),
    true,
  );
  record("Manual Korean edits remove advice but preserve originals and do not confirm facts");
  assert.equal(await page.locator("#plan-action-item-1").getAttribute("maxlength"), "3000");
  assert.equal(await page.locator("#plan-interview-question-0").getAttribute("maxlength"), "3000");
  assert.equal(await page.locator("#plan-section-title").getAttribute("maxlength"), "200");
  record("List and section-title fields respect existing schema limits");

  await page.getByRole("button", { name: "수정본 저장", exact: true }).first().click();
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('[data-testid="requests"]').textContent).length === 1,
  );
  const submitted = (await requests())[0];
  assert.equal(submitted.action, "save-plan");
  assert.equal(submitted.planId, originalPlan.id);
  assert.deepEqual(
    submitted.content.sections[1].evidence,
    originalPlan.content.sections[1].evidence,
  );
  assert.deepEqual(submitted.content.actionItems, ["근거 메모 대조", "향후 계획의 비용 점검"]);
  assert.deepEqual(submitted.content.interviewQuestions, [
    "근거가 확인되지 않은 권리는 무엇인가요?",
  ]);
  assert.equal(submitted.content.sections[1].needsConfirmation, true);
  assert.deepEqual(await saved(), original);
  assert.equal(await page.getByTestId("dirty").textContent(), "true");
  assert.equal(
    await page.locator("#plan-interview-question-0").inputValue(),
    "근거가 확인되지 않은 권리는 무엇인가요?",
  );
  record("Missing save acknowledgement retains edited fields and does not invent a saved version");
  await page.locator("#ack").selectOption("saved");
  await page.getByRole("button", { name: "수정본 저장", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("#plan-version").value.endsWith("404"));
  const acknowledged = await saved();
  assert.deepEqual(acknowledged.plans.slice(0, 2), original.plans);
  assert.equal(acknowledged.plans[2].confirmedAt, null);
  assert.deepEqual(acknowledged.plans[2].content, submitted.content);
  assert.equal(await page.getByTestId("dirty").textContent(), "false");
  record(
    "Acknowledged mock save selects new manual version while keeping old versions and confirmation state",
  );
  await page.locator("#plan-version").selectOption(originalPlan.id);
  assert.equal(await page.locator("#plan-summary").inputValue(), originalPlan.content.summary);
  await go("보강 과제 2", "plan-action-item-1");
  assert.equal(await page.locator("#plan-action-item-1").inputValue(), "planned 비용 점검");
  record("Returning to original version restores original prose and advice");

  await reset();
  await go("보강 과제 2", "plan-action-item-1");
  await page.locator("#plan-action-item-1").fill("미저장 한국어 수정");
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#plan-version").selectOption(original.plans[0].id);
  assert.equal(await page.locator("#plan-version").inputValue(), originalPlan.id);
  assert.equal(await page.locator("#plan-action-item-1").inputValue(), "미저장 한국어 수정");
  page.once("dialog", (d) => d.accept());
  await page.locator("#plan-version").selectOption(original.plans[0].id);
  assert.equal(await page.locator("#plan-title").inputValue(), "이전 한국어 원고");
  assert.deepEqual(await requests(), []);
  record("Unsaved list changes require the existing explicit discard confirmation");

  await reset();
  await page.locator("#plan-review-finding").selectOption("0");
  await page.locator("#plan-review-reason").fill("합성 검토 판단 편집 중");
  assert.equal(
    await language.getByRole("button", { name: "편집 위치로 이동 →" }).first().isDisabled(),
    true,
  );
  for (const id of [
    "plan-title",
    "plan-summary",
    "plan-section-title",
    "plan-section",
    "plan-action-item-1",
    "plan-interview-question-0",
  ])
    assert.equal(await page.locator("#" + id).isDisabled(), true);
  record("Concurrent review-decision edits lock all new edit controls and navigation");
  await reset();
  await page.setViewportSize({ width: 390, height: 844 });
  await go("실사 준비 질문 1", "plan-interview-question-0");
  assert.equal(await page.locator("#plan-interview-question-0").isVisible(), true);
  await page.screenshot({ path: path.join(output, "editor-mobile.png"), fullPage: true });
  record("Narrow-screen advice opens and focuses the question editor");
  assert.deepEqual(blockedNetwork, []);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        scope: "synthetic-real-editor-interaction",
        providerCalls: 0,
        databaseWrites: 0,
        humanAcceptance: "not-performed",
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
