import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// This acceptance run uses the actual production UI/API and a new synthetic data directory.
// The explicit build must be a current, environment-free build:local staging directory.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/local-app-validation.mjs <build:local staging>",
);
const staging = await realpath(process.argv[2]);
const relativeBuild = path.relative(temporaryRoot, staging);
assert.ok(relativeBuild && !relativeBuild.startsWith("..") && !path.isAbsolute(relativeBuild));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(
  !(await readdir(staging)).some((name) => name.startsWith(".env")),
  "No environment files allowed",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function compareTree(relative) {
  const entry = path.join(app, relative);
  for (const item of await readdir(entry, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), "Source symlinks are not allowed");
    const child = path.join(relative, item.name);
    if (item.isDirectory()) await compareTree(child);
    else
      assert.equal(
        digest(await readFile(path.join(staging, child))),
        digest(await readFile(path.join(app, child))),
        "Stale build source: " + child,
      );
  }
}
await compareTree("src");
await compareTree("public");
for (const name of ["next.config.ts", "package.json", "pnpm-lock.yaml"]) {
  assert.equal(
    digest(await readFile(path.join(staging, name))),
    digest(await readFile(path.join(app, name))),
    "Stale build input: " + name,
  );
}
const buildId = (await readFile(path.join(staging, ".next/BUILD_ID"), "utf8")).trim();
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-local-app-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  `const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    process.stderr.write("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED\\n");
    throw new Error("External fetch disabled for local acceptance");
  }
  return original(input, init);
};`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
delete environment.NODE_OPTIONS;
const nextCli = path.join(staging, "node_modules/next/dist/bin/next");
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = "http://127.0.0.1:" + port;
let child, context, page;
const logs = [],
  errors = [],
  externalRequests = [],
  checks = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
async function start() {
  child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(guard).href,
      nextCli,
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: staging,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (bytes) => logs.push(bytes.toString()));
  child.stderr.on("data", (bytes) => logs.push(bytes.toString()));
  let startupError;
  child.once("error", (error) => {
    startupError = error;
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error("Server exited: " + logs.join(""));
    try {
      const response = await fetch(origin + "/api/studio/status");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Isolated server did not become ready");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const owned = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned server failed to stop")), 10000);
    owned.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    owned.kill();
  });
}
async function api(url, options = {}) {
  const response = await context.request.fetch(origin + url, options);
  assert.ok(response.ok(), response.status() + " " + (await response.text()));
  return response;
}
async function mutation(action) {
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes("/api/studio/cases") &&
      ["POST", "PATCH"].includes(response.request().method()),
    { timeout: 20000 },
  );
  const [response] = await Promise.all([pending, action()]);
  assert.ok(response.ok(), response.status() + " " + (await response.text()));
  return response.json();
}
const name = "합성 통합검증 · 로컬 마감";
let caseId;
async function openCompany() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
}
async function tab(value) {
  await page.locator("#studio-tab-" + value).click();
}
async function savePlan() {
  return mutation(() =>
    page.getByRole("button", { name: "수정본 저장", exact: true }).first().click(),
  );
}
async function expand(id) {
  await page.locator("#" + id).evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  });
}
try {
  await start();
  let executablePath;
  for (const candidate of [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ]) {
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
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath,
    headless: true,
    viewport: { width: 1360, height: 1000 },
    acceptDownloads: true,
  });
  context.setDefaultTimeout(15000);
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  const status = await (await api("/api/studio/status")).json();
  assert.equal(status.aiConfigured, false);
  assert.deepEqual((await (await api("/api/studio/cases")).json()).cases, []);
  record("isolated production server starts with no key and an empty synthetic database");
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  await page.locator("#new-company-industry").fill("합성 제조업");
  let company = await mutation(() =>
    page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
  );
  caseId = company.id;
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page
    .locator("#profile-technologySummary")
    .fill("합성 광학 검사 시제품입니다. current 상태이며 한 종류 용기의 내부 시험만 수행했습니다.");
  await page
    .locator("#profile-customers")
    .fill("합성 제조 담당자의 시험 의향이며 구매 계약이나 매출은 없습니다.");
  await page
    .locator("#profile-developmentPlan")
    .fill("planned 다른 용기 시험이며 실제 완료 사실이 아닙니다.");
  company = await mutation(() =>
    page.getByRole("button", { name: "기업정보 저장", exact: true }).first().click(),
  );
  record("real UI creates a company and saves its profile through the API");
  const sourceBytes = Buffer.from(
    "합성 기술 메모\n내부 시험 20개 중 18개를 구분했습니다. 외부 성능과 매출은 미확인입니다.\n",
  );
  company = await (
    await api("/api/studio/cases/" + caseId + "/sources", {
      method: "POST",
      multipart: {
        file: { name: "synthetic-source.txt", mimeType: "text/plain", buffer: sourceBytes },
        kind: "technology",
        revision: String(company.revision),
        allowAi: "false",
        extractionMode: "extract",
      },
    })
  ).json();
  const original = await (
    await api("/api/studio/cases/" + caseId + "/sources/" + company.sources[0].id)
  ).body();
  assert.deepEqual(original, sourceBytes);
  record("real multipart extraction and original download preserve synthetic source bytes");
  // Refresh the UI after the independent upload; this also verifies persisted profile reload.
  await openCompany();
  await tab("analysis");
  await page.getByRole("button", { name: "아이템 분석 시작", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /AI 분석·자동 작성/ }).isDisabled(), true);
  await page.getByRole("button", { name: /자료 기반 정리본/ }).click();
  company = await mutation(() =>
    page.getByRole("button", { name: "선택한 방식으로 분석", exact: true }).click(),
  );
  await page
    .getByRole("button", { name: /이유를 적고 아이템 선택|선택 이유 기록/ })
    .first()
    .click();
  await page
    .locator("#candidate-selection-reason")
    .fill("합성 자료의 현재 시제품과 시험 범위에 한정하여 선택합니다.");
  company = await mutation(() =>
    page.getByRole("button", { name: /이유와 함께 이 아이템 선택|선택 이유 새 기록 저장/ }).click(),
  );
  await tab("plan");
  await page.getByRole("button", { name: "사업계획서 작성", exact: true }).click();
  await page.getByRole("button", { name: /자료 기반 정리본/ }).click();
  company = await mutation(() =>
    page.getByRole("button", { name: "선택한 방식으로 작성", exact: true }).click(),
  );
  const originalPlan = structuredClone(company.plans.at(-1));
  assert.equal(originalPlan.content.sections.length, 10);
  assert.equal(originalPlan.mode, "assisted");
  record("real UI performs offline analysis, reasoned candidate selection and a ten-section plan");
  await page.locator("#plan-title").fill("합성 편집본 current");
  await page
    .locator("#plan-summary")
    .fill("documented 합성 자료입니다. 아직 사람의 확인 전입니다.");
  await page.locator("#plan-section-title").fill("reported 항목 제목");
  await page
    .locator("#plan-section")
    .fill(originalPlan.content.sections[0].content + "\nunknown 합성 편집 확인용입니다.");
  await expand("plan-action-item-0");
  await page.locator("#plan-action-item-0").fill("planned 보강 과제");
  await expand("plan-interview-question-0");
  await page.locator("#plan-interview-question-0").fill("unverified 준비 질문");
  company = await savePlan();
  const marked = structuredClone(company.plans.at(-1));
  assert.equal(marked.mode, "manual");
  assert.equal(marked.confirmedAt, null);
  assert.deepEqual(company.plans[0], originalPlan);
  const locations = [
    ["사업계획서 제목", "plan-title", "합성 편집본"],
    ["핵심 요약", "plan-summary", "문서에 기재된 합성 자료입니다. 아직 사람의 확인 전입니다."],
    ["reported 항목 제목 · 제목", "plan-section-title", "합성 항목 제목"],
    [
      "합성 항목 제목",
      "plan-section",
      originalPlan.content.sections[0].content + "\n합성 편집 확인용입니다.",
    ],
    ["보강 과제 1", "plan-action-item-0", "계획한 보강 과제"],
    ["실사 준비 질문 1", "plan-interview-question-0", "근거 확인이 필요한 준비 질문"],
  ];
  for (const [location, id, value] of locations) {
    const row = page
      .getByRole("region", { name: "한국어 표현 점검" })
      .locator("li")
      .filter({ has: page.getByText(location, { exact: true }) })
      .first();
    await row.getByRole("button", { name: "편집 위치로 이동 →", exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, location);
    await page.locator("#" + id).fill(value);
  }
  company = await savePlan();
  const finalPlan = structuredClone(company.plans.at(-1));
  assert.equal(company.plans.length, 3);
  assert.deepEqual(company.plans[0], originalPlan);
  assert.deepEqual(company.plans[1], marked);
  assert.equal(finalPlan.confirmedAt, null);
  assert.deepEqual(
    finalPlan.content.sections.map((section) => section.evidence),
    originalPlan.content.sections.map((section) => section.evidence),
  );
  const storedBeforeRestart = JSON.stringify(company);
  record(
    "six language locations edit and save new versions without altering original evidence or review status",
  );
  const exportPath = "/api/studio/cases/" + caseId + "/export?planId=" + finalPlan.id;
  const exportBefore = await (await api(exportPath)).body();
  assert.ok(exportBefore.toString().includes("계획한 보강 과제"));
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Markdown 다운로드", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  assert.deepEqual(await readFile(await download.path()), exportBefore);
  record("browser Markdown download matches the actual stored-version export");
  await stop();
  await start();
  company = await (await api("/api/studio/cases/" + caseId)).json();
  assert.equal(JSON.stringify(company), storedBeforeRestart);
  assert.deepEqual(await (await api(exportPath)).body(), exportBefore);
  assert.deepEqual(
    await (await api("/api/studio/cases/" + caseId + "/sources/" + company.sources[0].id)).body(),
    sourceBytes,
  );
  await openCompany();
  await tab("plan");
  assert.equal(await page.locator("#plan-summary").inputValue(), finalPlan.content.summary);
  await page.locator("#plan-version").selectOption(originalPlan.id);
  assert.equal(await page.locator("#plan-summary").inputValue(), originalPlan.content.summary);
  await page.locator("#plan-version").selectOption(finalPlan.id);
  record(
    "owned server restart preserves all versions, source bytes and export bytes without replaying generation",
  );
  await page.locator("#plan-summary").fill("저장하지 않은 합성 수정");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#plan-version").selectOption(originalPlan.id);
  assert.equal(await page.locator("#plan-summary").inputValue(), "저장하지 않은 합성 수정");
  assert.equal(
    JSON.stringify(await (await api("/api/studio/cases/" + caseId)).json()),
    storedBeforeRestart,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#plan-version").selectOption(originalPlan.id);
  assert.equal(await page.locator("#plan-summary").inputValue(), originalPlan.content.summary);
  record("unsaved-version cancellation retains local edits while persisted data stays unchanged");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#plan-version").selectOption(finalPlan.id);
  const overflow = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.ok(overflow.document <= overflow.width + 1, JSON.stringify(overflow));
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record("production CSS fits 390px with no browser runtime errors or external requests");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        buildId,
        staging,
        dataDirectory,
        caseId,
        checks,
        actualProviderCalls: 0,
        originalPlanDigest: digest(JSON.stringify(originalPlan)),
        finalPlanDigest: digest(JSON.stringify(finalPlan)),
        humanAcceptance: false,
      },
      null,
      2,
    ),
  );
  console.log("Acceptance report: " + path.join(output, "report.json"));
} catch (error) {
  if (page) {
    await writeFile(
      path.join(output, "failure-ui.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { passed: false, buildId, checks, error: String(error), errors, externalRequests },
      null,
      2,
    ),
  );
  console.error("Failed acceptance retained: " + output);
  throw error;
} finally {
  if (context) await context.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
