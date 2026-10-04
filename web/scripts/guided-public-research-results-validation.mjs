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
  "Usage: node scripts/guided-public-research-results-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-public-research-results-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
const wireFile = path.join(output, "synthetic-wire.jsonl");
await writeFile(wireFile, "");
await writeFile(
  guard,
  String.raw`
import { appendFile } from 'node:fs/promises';
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(u.origin==='https://kosis.kr'&&u.pathname==='/openapi/statisticsSearch.do'){
  if(u.searchParams.get('apiKey')!=='synthetic-kosis-test-key')throw Error('Unexpected synthetic credential');
  const query=u.searchParams.get('searchNm');
  await appendFile(process.env.SYNTHETIC_WIRE_FILE,JSON.stringify({query,method:init.method,parameters:[...u.searchParams.keys()],headers:init.headers,redirect:init.redirect})+'\n');
  if(query==='제조업')return Response.json([]);
  if(query==='정보통신업')return new Response('synthetic upstream failure',{status:429});
  return Response.json([
   {ORG_ID:'101',ORG_NM:'합성 제공기관',TBL_ID:'SYNTHETIC_TEST',TBL_NM:'합성 공개 통계표',STRT_PRD_DE:'202301',END_PRD_DE:'202412',LINK_URL:'http://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=SYNTHETIC_TEST&extra=UNWANTED',CONTENTS:'UPSTREAM_BODY_NOT_EVIDENCE'},
   {ORG_ID:'101',ORG_NM:'합성 제공기관',TBL_ID:'BAD_LINK',TBL_NM:'원문 주소 미확인 후보',STRT_PRD_DE:'',END_PRD_DE:'',LINK_URL:'https://evil.invalid/redirect'}
  ]);
 }
 if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)){process.stderr.write('EXTERNAL_FETCH_BLOCKED\n');throw Error('External fetch forbidden');}
 return original(input,init);
};
`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
environment.OPENAI_API_KEY = "";
environment.KOSIS_API_KEY = "";
environment.SYNTHETIC_WIRE_FILE = wireFile;
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

const name = "PRIVATE_COMPANY 합성 결과 조회 시험";
const originalUrl = "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=SYNTHETIC_TEST";
let caseId,
  delay = false,
  release,
  delayedDone,
  markDelayed;
const queryRequests = [],
  sourceRequests = [],
  outbound = [];
const panel = () => page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
const lookup = () => panel().getByRole("button", { name: "공개 검색 후보 10개 조회", exact: true });
const snapshot = async () => (await api("/api/studio/cases/" + caseId)).json();
const wires = async () =>
  (await readFile(wireFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "자료 올리기" })
    .click();
  await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
  await panel().getByText("공개 통계 찾기 (선택)", { exact: true }).click();
}
async function select(topic) {
  await panel().getByLabel("찾을 공개 주제", { exact: true }).selectOption(topic);
}
async function results() {
  await panel().getByRole("region", { name: "KOSIS 검색 후보" }).waitFor();
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
      u = new URL(req.url());
    if (u.origin !== origin) {
      if (req.url() === originalUrl) {
        outbound.push({ url: req.url(), referer: req.headers().referer ?? null });
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<p>합성 원문 표</p>",
        });
      }
      externalRequests.push(req.url());
      return route.abort();
    }
    if (u.pathname === "/api/studio/public-research/search") {
      queryRequests.push(req.postDataJSON());
      if (delay) {
        delay = false;
        const response = await route.fetch();
        await new Promise((resolve) => {
          release = resolve;
          markDelayed();
        });
        await route.fulfill({ response }).catch(() => {});
        delayedDone();
        return;
      }
    }
    if (req.method() === "PATCH" && req.postDataJSON()?.action === "source")
      sourceRequests.push(req.postDataJSON());
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
  await select("services");
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("PRIVATE_DRAFT");
  await panel().getByLabel("원문 발췌", { exact: false }).fill("PRIVATE_BODY");
  assert.equal(queryRequests.length, 0);
  assert.deepEqual(await snapshot(), before);
  await lookup().click();
  await panel().getByRole("status").filter({ hasText: "연결 설정 후" }).waitFor();
  assert.equal(queryRequests.length, 1);
  assert.deepEqual(await wires(), []);
  assert.equal(
    await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
    "PRIVATE_BODY",
  );
  record(
    "no automatic query or company transmission; missing key is unavailable with zero outbound requests",
  );
  // Restart only the owned isolated server with a synthetic credential.
  await stop();
  environment.KOSIS_API_KEY = "synthetic-kosis-test-key";
  await start();
  await reopen();
  await select("services");
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("PRIVATE_DRAFT");
  await panel().getByLabel("원문 발췌", { exact: false }).fill("PRIVATE_BODY");
  const count = queryRequests.length;
  await lookup().evaluate((b) => {
    b.click();
    b.click();
  });
  await results();
  assert.equal(queryRequests.length, count + 1);
  const actualWire = await wires();
  assert.equal(actualWire.length, 1);
  assert.deepEqual(queryRequests.at(-1), { topic: "services" });
  assert.deepEqual(actualWire[0], {
    query: "서비스업",
    method: "GET",
    parameters: [
      "method",
      "apiKey",
      "searchNm",
      "format",
      "content",
      "sort",
      "startCount",
      "resultCount",
    ],
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  assert.ok(!(await panel().innerText()).includes("UPSTREAM_BODY_NOT_EVIDENCE"));
  assert.ok(!(await page.content()).includes("synthetic-kosis-test-key"));
  assert.equal(await panel().getByRole("article").count(), 2);
  assert.ok((await panel().innerText()).includes("202301 ~ 202412"));
  assert.equal(
    await panel()
      .getByRole("button", { name: "제목·주소를 아래 빈 입력칸에 넣기", exact: true })
      .first()
      .isDisabled(),
    true,
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(sourceRequests.length, 0);
  record(
    "explicit double click performs one real API read with synthetic KOSIS fetch; candidates and dates do not change source data",
  );
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("");
  await panel()
    .getByRole("button", { name: "제목·주소를 아래 빈 입력칸에 넣기", exact: true })
    .first()
    .click();
  assert.equal(
    await panel().getByLabel("공개 자료 제목", { exact: true }).inputValue(),
    "합성 공개 통계표",
  );
  assert.equal(
    await panel().getByLabel("원문 URL (HTTPS)", { exact: true }).inputValue(),
    originalUrl,
  );
  assert.equal(
    await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
    "PRIVATE_BODY",
  );
  assert.equal(
    await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).inputValue(),
    "",
  );
  assert.equal(await panel().getByRole("checkbox").isChecked(), false);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    panel().getByRole("link", { name: "통계표 원문 열기 (새 창)", exact: true }).click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(await popup.evaluate(() => window.opener === null), true);
  await popup.close();
  assert.deepEqual(outbound, [{ url: originalUrl, referer: null }]);
  assert.deepEqual(await snapshot(), before);
  record(
    "explicit title/address fill preserves excerpt and blank read date; validated original link has no local referrer or opener",
  );
  await panel()
    .getByLabel("원문 발췌", { exact: false })
    .fill("직접 읽었다고 기록하는 합성 공개 자료. 회사 실적은 별도입니다.");
  await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).fill("2026-10-05");
  await panel().getByRole("checkbox").check();
  await panel().getByRole("button", { name: "공개 근거 후보 보관", exact: true }).click();
  await panel().getByRole("status").filter({ hasText: "공개 근거 후보를 보관했습니다" }).waitFor();
  const saved = await snapshot();
  assert.equal(saved.sources.length, 1);
  assert.equal(sourceRequests.length, 1);
  assert.ok(saved.sources[0].text.includes(originalUrl));
  assert.ok(saved.sources[0].text.includes("발행일 (원문 표기): 미확인"));
  assert.ok(!saved.sources[0].text.includes("UPSTREAM_BODY_NOT_EVIDENCE"));
  record(
    "only manual excerpt/read date and separate checked storage action create one ordinary public candidate",
  );
  await reopen();
  await select("services");
  delay = true;
  const reached = new Promise((resolve) => {
    markDelayed = resolve;
  });
  const done = new Promise((resolve) => {
    delayedDone = resolve;
  });
  await lookup().click();
  await reached;
  await select("manufacturing");
  release();
  await done;
  assert.equal(await panel().getByRole("region", { name: "KOSIS 검색 후보" }).count(), 0);
  await lookup().click();
  await panel().getByRole("status").filter({ hasText: "검색 후보가 없습니다" }).waitFor();
  assert.deepEqual(await snapshot(), saved);
  record(
    "topic change aborts late results; empty search is explicitly unknown and does not clear company evidence",
  );
  await select("ict");
  const beforeFailure = (await wires()).length;
  await lookup().click();
  await panel().getByRole("alert").filter({ hasText: "검색 결과가 미확인" }).waitFor();
  assert.equal((await wires()).length, beforeFailure + 1);
  assert.equal(await panel().getByRole("region", { name: "KOSIS 검색 후보" }).count(), 0);
  await lookup().click();
  await panel().getByRole("alert").filter({ hasText: "검색 결과가 미확인" }).waitFor();
  assert.equal((await wires()).length, beforeFailure + 2);
  assert.deepEqual(await snapshot(), saved);
  record(
    "provider 429 stays unconfirmed with no automatic retry; a new read requires another explicit click",
  );
  await select("services");
  delay = true;
  const reachedClose = new Promise((resolve) => {
    markDelayed = resolve;
  });
  const doneClose = new Promise((resolve) => {
    delayedDone = resolve;
  });
  await lookup().click();
  await reachedClose;
  await panel().getByRole("button", { name: "닫기", exact: true }).click();
  release();
  await doneClose;
  await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
  await panel().getByText("공개 통계 찾기 (선택)", { exact: true }).click();
  assert.equal(await panel().getByRole("region", { name: "KOSIS 검색 후보" }).count(), 0);
  await select("services");
  await lookup().click();
  await results();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await stop();
  await start();
  const endCount = (await wires()).length;
  await reopen();
  assert.equal((await wires()).length, endCount);
  assert.deepEqual(await snapshot(), saved);
  record(
    "closed screen ignores late results; 390px fits; server/page restart performs no public read and preserves the saved source",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  assert.ok(!JSON.stringify(await wires()).includes("PRIVATE"));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        caseId,
        publicApiRequests: queryRequests,
        syntheticWire: await wires(),
        sourceRequests: sourceRequests.length,
        savedSources: 1,
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
