import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
  "Usage: node scripts/public-table-metadata-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-table-metadata-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
const wireFile = path.join(output, "synthetic-wire.jsonl");
await writeFile(wireFile, "");
await writeFile(
  guard,
  String.raw`import {appendFile,readFile} from "node:fs/promises";
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==="string"||input instanceof URL?input:input.url);
 if(u.origin==="https://kosis.kr"){
  if(u.searchParams.get("apiKey")!=="synthetic-kosis-test-key")throw Error("Wrong synthetic key");
  const mode=JSON.parse(await readFile(process.env.SYNTHETIC_MODE_FILE,"utf8")).mode;
  const params=Object.fromEntries(u.searchParams);delete params.apiKey;
  await appendFile(process.env.SYNTHETIC_WIRE_FILE,JSON.stringify({path:u.pathname,params})+"\n");
  if(u.pathname==="/openapi/statisticsSearch.do")return Response.json([{ORG_ID:"999",ORG_NM:"합성 기관",TBL_ID:"DT_SYNTHETIC",TBL_NM:mode==="changed"?"바뀐 합성 표":"합성 표",STRT_PRD_DE:"2020",END_PRD_DE:"2024",LINK_URL:"https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC"}]);
  if(u.pathname!=="/openapi/statisticsData.do")throw Error("Forbidden synthetic endpoint");
  if(mode==="hold"){
   while(JSON.parse(await readFile(process.env.SYNTHETIC_MODE_FILE,"utf8")).mode==="hold"){
    if(init.signal.aborted)throw Error("Aborted synthetic hold");
    await new Promise(r=>setTimeout(r,20));
   }
  }
  if(mode==="empty")return Response.json([]);
  if(mode==="malformed")return Response.json({err:"SYNTHETIC_ONLY"});
  const kind=u.searchParams.get("type");
  if(kind==="TBL")return Response.json([{TBL_NM:"<img src=x onerror=alert(1)> "+ "긴합성문자".repeat(45),TBL_NM_ENG:null}]);
  if(kind==="PRD")return Response.json([{PRD_SE:"IR",PRD_DE:"unknown"},{PRD_SE:"Y",PRD_DE:"2024"}]);
  if(kind==="SOURCE")return Response.json([{JOSA_NM:"합성 조사",STAT_ID:"SYNTHETIC",DEPT_NM:null,DEPT_PHONE:"<a href=x>연락처</a>"}]);
  throw Error("Wrong metadata type");
 }
 if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname)){process.stderr.write("EXTERNAL_FETCH_BLOCKED\n");throw Error("External fetch forbidden");}
 return original(input,init);
};`,
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
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    child = null;
    return;
  }
  const owned = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned server failed to stop")), 10000);
    owned.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    owned.kill();
  });
  child = null;
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

const name = "PRIVATE_COMPANY 합성 표 정보 시험";
let caseId;
const queryRequests = [],
  writes = [];
const panel = () => page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
const table = () => panel().getByLabel("선택 통계표 정보", { exact: true });
const result = () => table().getByRole("region", { name: "읽은 표 정보", exact: true });
const lookup = () => panel().getByRole("button", { name: "공개 검색 후보 10개 조회", exact: true });
const read = () => table().getByRole("button", { name: "선택 표 정보 한 번 조회", exact: true });
const snapshot = async () => (await api("/api/studio/cases/" + caseId)).json();
const wires = async () =>
  (await readFile(wireFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const modeFile = path.join(output, "synthetic-mode.json");
const mode = async (mode) => writeFile(modeFile, JSON.stringify({ mode }));
environment.SYNTHETIC_MODE_FILE = modeFile;
environment.KOSIS_API_KEY = "synthetic-kosis-test-key";
async function dbRows() {
  const db = new DatabaseSync(path.join(dataDirectory, "studio.sqlite"), { readOnly: true });
  try {
    return [
      "studio_cases",
      "venture_accounts",
      "venture_workflows",
      "studio_prepared_packages",
    ].map((t) => [t, db.prepare("SELECT * FROM " + t).all()]);
  } finally {
    db.close();
  }
}
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().waitFor();
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "자료 올리기" })
    .click();
  await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
  await panel().getByText("공개 통계 찾기 (선택)", { exact: true }).click();
}
async function search() {
  await panel().getByLabel("찾을 공개 주제", { exact: true }).selectOption("services");
  await lookup().click();
  await panel().getByRole("region", { name: "KOSIS 검색 후보" }).waitFor();
}
async function openTable() {
  await panel().getByText("이 표의 기본 정보 확인 (선택)", { exact: true }).click();
  await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("TBL");
}
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Synthetic observation timeout");
}
try {
  await mode("normal");
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
  });
  context.setDefaultTimeout(20000);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin !== origin) {
      externalRequests.push(req.url());
      return route.abort();
    }
    if (u.pathname === "/api/studio/public-research/search") queryRequests.push(req.postDataJSON());
    else if (!["GET", "HEAD"].includes(req.method()))
      writes.push({ path: u.pathname, method: req.method() });
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
  const before = await snapshot(),
    beforeRows = await dbRows();
  writes.length = 0;
  await reopen();
  assert.equal(queryRequests.length, 0);
  await search();
  assert.equal((await wires()).length, 1);
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("PRIVATE_DRAFT");
  await panel().getByLabel("원문 발췌", { exact: false }).fill("PRIVATE_BODY");
  await openTable();
  assert.equal((await wires()).length, 1);
  const beforeClick = queryRequests.length;
  await read().evaluate((b) => {
    b.click();
    b.click();
  });
  await result().waitFor();
  assert.equal(queryRequests.length, beforeClick + 1);
  assert.equal((await wires()).length, 3);
  assert.equal(queryRequests.at(-1).action, "read-selected-table-metadata");
  assert.equal(await result().locator("img,script,a").count(), 0);
  assert.ok((await result().innerText()).includes("<img src=x"));
  assert.equal(
    await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
    "PRIVATE_BODY",
  );
  assert.equal(await panel().getByRole("checkbox").isChecked(), false);
  assert.deepEqual(await dbRows(), beforeRows);
  record(
    "explicit double click is one HTTP command / fresh search plus metadata; no automatic reads or source changes",
  );

  await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("PRD");
  assert.equal(await result().count(), 0);
  await read().click();
  await result().waitFor();
  assert.ok((await result().innerText()).includes("unknown"));
  await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("SOURCE");
  await read().click();
  await result().waitFor();
  assert.ok((await result().innerText()).includes("<a href=x>"));
  assert.equal(await result().locator("a").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await table().screenshot({ path: path.join(output, "table-metadata-390.png") });
  record(
    "three metadata variants preserve inactive literal strings; selection clears old result and 390px fits",
  );

  await mode("changed");
  const changedAt = (await wires()).length;
  await read().click();
  await table().getByRole("alert").waitFor();
  assert.equal((await wires()).length, changedAt + 1);
  assert.equal(await result().count(), 0);
  await mode("empty");
  await read().click();
  await result().waitFor();
  assert.ok((await result().innerText()).includes("표 정보 행이 없습니다"));
  await mode("malformed");
  await read().click();
  await table().getByRole("alert").waitFor();
  assert.equal(await result().count(), 0);
  record(
    "changed candidate stops before metadata; empty differs from malformed response and all errors remove old results",
  );

  await mode("hold");
  const heldAt = (await wires()).length;
  await read().click();
  await until(async () => (await wires()).length === heldAt + 2);
  const busy = await context.request.post(origin + "/api/studio/public-research/search", {
    data: { topic: "services" },
  });
  assert.equal(busy.status(), 409);
  const details = panel().getByText("이 표의 기본 정보 확인 (선택)", { exact: true }).locator("..");
  await details.locator("summary").click();
  await mode("normal");
  await page.waitForTimeout(100);
  await details.locator("summary").click();
  assert.equal(await result().count(), 0);
  assert.equal(
    await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
    "PRIVATE_BODY",
  );
  record(
    "same Next HTTP route shares in-flight gate; closing aborts and discards the pending result",
  );

  await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("TBL");
  await read().click();
  await result().waitFor();
  const lastCommand = structuredClone(queryRequests.at(-1));
  const beforeReject = (await wires()).length;
  const invalid = await context.request.post(origin + "/api/studio/public-research/search", {
    data: { ...lastCommand, company: "PRIVATE" },
  });
  assert.equal(invalid.status(), 400);
  const foreign = await context.request.post(origin + "/api/studio/public-research/search", {
    headers: { origin: "https://evil.invalid" },
    data: lastCommand,
  });
  assert.equal(foreign.status(), 403);
  assert.equal((await wires()).length, beforeReject);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await dbRows(), beforeRows);
  record(
    "real HTTP rejects extra company payload and foreign origin before provider access; database four tables unchanged",
  );

  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("");
  await panel().getByLabel("원문 발췌", { exact: false }).fill("");
  await page.reload({ waitUntil: "networkidle" });
  await stop();
  await start();
  const finalCount = (await wires()).length;
  await reopen();
  assert.equal((await wires()).length, finalCount);
  assert.equal(await panel().getByLabel("선택 통계표 정보", { exact: true }).count(), 0);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await dbRows(), beforeRows);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  assert.ok(!JSON.stringify(await wires()).includes("PRIVATE"));
  record(
    "server and page restart issue no public reads; existing company and all four tables persist unchanged",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        publicHttpCommands: queryRequests.length,
        syntheticWire: await wires(),
        databaseTablesUnchanged: 4,
        serverWrites: 0,
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
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
