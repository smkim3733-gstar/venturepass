import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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
  "Usage: node scripts/guided-public-research-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-public-research-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==="string"||input instanceof URL?input:input.url);if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname)){process.stderr.write("EXTERNAL_FETCH_BLOCKED\n");throw Error("External fetch forbidden");}return original(input,init);};`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
environment.OPENAI_API_KEY = "";
environment.OPENAI_MODEL = "synthetic-model";
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

const name = "PRIVATE_COMPANY 합성 공개 검색 시험";
const originalUrl = "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=SYNTHETIC_TEST";
let caseId,
  blockSave = false;
const outbound = [],
  sourceRequests = [];
const panel = () => page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
const snapshot = async () => (await api("/api/studio/cases/" + caseId)).json();
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "자료 올리기" })
    .click();
  await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
  await panel().waitFor();
}
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      if (
        url.origin === "https://kosis.kr" &&
        ["/search/search.do", "/statHtml/statHtml.do"].includes(url.pathname)
      ) {
        outbound.push({
          url: req.url(),
          method: req.method(),
          referer: req.headers()["referer"] ?? null,
        });
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><title>합성 KOSIS 시험</title><p>합성 검색·원문 화면</p><a href="${originalUrl}">개별 통계표</a>`,
        });
      }
      externalRequests.push(req.url());
      return route.abort();
    }
    if (req.method() === "PATCH" && req.postDataJSON()?.action === "source") {
      sourceRequests.push(req.postDataJSON());
      if (blockSave) {
        blockSave = false;
        return route.abort();
      }
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  caseId = (
    await mutation(() =>
      page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
    )
  ).id;
  const before = await snapshot();
  await reopen();
  await panel().getByText("공개 통계 찾기 (선택)", { exact: true }).click();
  assert.equal(await panel().getByRole("link").count(), 0);
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("PRIVATE_DRAFT 고객 제목");
  await panel().getByLabel("원문 발췌", { exact: false }).fill("PRIVATE_SOURCE 내부 고객 자료");
  await panel().getByLabel("찾을 공개 주제", { exact: true }).selectOption("manufacturing");
  let link = panel().getByRole("link", { name: "KOSIS에서 검색 열기 (새 창)", exact: true });
  const href = await link.getAttribute("href");
  assert.equal(new URL(href).searchParams.get("query"), "제조업");
  await panel().getByLabel("찾을 공개 주제", { exact: true }).selectOption("services");
  assert.equal(new URL(await link.getAttribute("href")).searchParams.get("query"), "서비스업");
  assert.deepEqual(outbound, []);
  assert.deepEqual(sourceRequests, []);
  assert.deepEqual(await snapshot(), before);
  record(
    "fixed public topics only; initial view and selection send nothing and preserve company and draft",
  );
  const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(await popup.evaluate(() => window.opener === null), true);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].referer, null);
  assert.equal(outbound[0].method, "GET");
  assert.deepEqual([...new URL(outbound[0].url).searchParams.entries()], [["query", "서비스업"]]);
  assert.ok(!JSON.stringify(outbound).includes("PRIVATE"));
  await popup.getByRole("link", { name: "개별 통계표", exact: true }).click();
  await popup.waitForURL(originalUrl);
  await popup.close();
  assert.equal(
    await panel().getByLabel("공개 자료 제목", { exact: true }).inputValue(),
    "PRIVATE_DRAFT 고객 제목",
  );
  assert.equal(
    await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).inputValue(),
    "",
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(sourceRequests.length, 0);
  record(
    "explicit new-tab navigation has no opener/referrer or customer query; viewing synthetic source does not adopt or populate evidence",
  );
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("합성 공개 통계표");
  await panel()
    .getByLabel("원문 발췌", { exact: false })
    .fill("2023년 합성 산업 자료입니다. 회사 실적은 별도입니다.");
  await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).fill("2026-10-05");
  await panel().getByLabel("원문 URL (HTTPS)", { exact: true }).fill(href);
  await panel().getByRole("checkbox").check();
  await panel().getByRole("alert").filter({ hasText: "검색 결과 주소 대신" }).waitFor();
  assert.equal(
    await panel().getByRole("button", { name: "공개 근거 후보 보관", exact: true }).isDisabled(),
    true,
  );
  await panel().getByLabel("원문 URL (HTTPS)", { exact: true }).fill(originalUrl);
  assert.equal(await panel().getByRole("checkbox").isChecked(), false);
  await panel().getByRole("checkbox").check();
  await panel().getByRole("button", { name: "공개 근거 후보 보관", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "공개 근거 후보를 보관했습니다" }).waitFor();
  const saved = await snapshot();
  assert.equal(saved.sources.length, 1);
  assert.equal(sourceRequests.length, 1);
  assert.ok(saved.sources[0].text.includes(originalUrl));
  assert.ok(saved.sources[0].text.includes("발행일 (원문 표기): 미확인"));
  assert.ok(!saved.sources[0].text.includes("search/search.do"));
  assert.equal(outbound.length, 2);
  record(
    "search result URL is rejected as original evidence; manual source and read date require fresh explicit storage confirmation",
  );
  await reopen();
  await panel().getByText("공개 통계 찾기 (선택)", { exact: true }).click();
  await panel().getByLabel("찾을 공개 주제", { exact: true }).selectOption("energy");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("중단 합성 후보");
  await panel().getByLabel("원문 URL (HTTPS)", { exact: true }).fill(originalUrl);
  await panel().getByLabel("원문 발췌", { exact: false }).fill("미전송 합성 원문");
  await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).fill("2026-10-05");
  await panel().getByRole("checkbox").check();
  blockSave = true;
  await panel().getByRole("button", { name: "공개 근거 후보 보관", exact: true }).click();
  await panel().getByRole("alert").filter({ hasText: "저장 결과가 미확인" }).waitFor();
  assert.equal(await panel().getByLabel("찾을 공개 주제", { exact: true }).isDisabled(), true);
  assert.equal(await panel().getByRole("link").count(), 0);
  assert.deepEqual(await snapshot(), saved);
  assert.equal(outbound.length, 2);
  assert.equal(sourceRequests.length, 2);
  page.once("dialog", (d) => d.accept());
  await panel().getByRole("button", { name: "닫기", exact: true }).click();
  await stop();
  await start();
  await reopen();
  assert.deepEqual(await snapshot(), saved);
  record(
    "pending storage disables external navigation, 390px fits, reload preserves one original candidate with no automatic search or AI",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        caseId,
        syntheticNavigation: outbound,
        sourceRequests: sourceRequests.length,
        savedSources: saved.sources.length,
        actualExternalRequests: 0,
        actualAiCalls: 0,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, buildId, checks: checks.length }));
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 6000),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
