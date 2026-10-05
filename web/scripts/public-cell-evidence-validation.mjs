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
  "Usage: node scripts/public-cell-evidence-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-cell-evidence-"));
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
  if(u.pathname==="/openapi/statisticsSearch.do")return Response.json([{ORG_ID:"999",ORG_NM:"합성 기관",TBL_ID:"DT_SYNTHETIC",TBL_NM:mode==="long-title"?"긴제목".repeat(45):mode==="changed"?"바뀐 합성 표":"합성 표",STRT_PRD_DE:"2020",END_PRD_DE:"2024",LINK_URL:"https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC"}]);
  if(u.pathname!=="/openapi/Param/statisticsParameterData.do")throw Error("Forbidden synthetic endpoint");
  if(mode==="hold"){
   while(JSON.parse(await readFile(process.env.SYNTHETIC_MODE_FILE,"utf8")).mode==="hold"){
    if(init.signal.aborted)throw Error("Aborted synthetic hold");
    await new Promise(r=>setTimeout(r,20));
   }
  }
  if(mode==="empty")return Response.json([]);
  if(mode==="malformed")return Response.json({err:"SYNTHETIC_ONLY"});
  const row={ORG_ID:"999",TBL_ID:"DT_SYNTHETIC",TBL_NM:"<img src=x> "+"긴합성문자".repeat(45),ITM_ID:u.searchParams.get("itmId"),ITM_NM:"<a href=x>합성 항목</a>",PRD_SE:u.searchParams.get("prdSe"),PRD_DE:u.searchParams.get("startPrdDe"),DT:"12,345.00",UNIT_ID:"U001",UNIT_NM:"<b>합성단위</b>",LST_CHN_DE:"2025-01-01"};
  for(let i=1;i<=8;i++){const code=u.searchParams.get("objL"+i);if(code!==null){row["C"+i]=code;row["C"+i+"_NM"]=mode==="oversize"?"\n".repeat(3000):"긴문자".repeat(400);row["C"+i+"_OBJ_NM"]=mode==="oversize"?"\n".repeat(3000):"분류 "+i;}}
  if(mode==="mismatch")row.C1="OTHER";
  if(mode==="duplicate")return Response.json([row,row]);
  return Response.json([row]);

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

const name = "PRIVATE_COMPANY 합성 수치 시험";
let caseId;
const queryRequests = [],
  writes = [];
const panel = () => page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
const table = () => panel().getByLabel("선택 통계 수치 입력", { exact: true });
const result = () => table().getByRole("region", { name: "읽은 통계 수치", exact: true });
const lookup = () => panel().getByRole("button", { name: "공개 검색 후보 10개 조회", exact: true });
const read = () => table().getByRole("button", { name: "선택 수치 한 번 조회", exact: true });
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
  await panel().getByText("코드를 아는 수치 1건 조회 (선택)", { exact: true }).click();
}
async function confirmRead(wait = true) {
  await table().getByRole("checkbox").check();
  await read().click();
  if (wait) await result().waitFor();
}
let loseAck = false,
  blockGet = false;
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
    if (u.pathname === "/api/studio/cases/" + caseId && req.method() === "PATCH" && loseAck) {
      const response = await route.fetch();
      assert.ok(response.ok(), await response.text());
      loseAck = false;
      return route.abort("failed");
    }
    if (u.pathname === "/api/studio/cases/" + caseId && req.method() === "GET" && blockGet) {
      blockGet = false;
      return route.abort("failed");
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

  const before = await snapshot(),
    beforeRows = await dbRows();
  writes.length = 0;
  await reopen();
  assert.equal(queryRequests.length, 0);
  await search();
  await openTable();
  await table().getByLabel("항목 코드", { exact: true }).fill("T001");
  await table().getByLabel("분류 1 코드", { exact: true }).fill("001");
  await table().getByLabel("수치 주기", { exact: true }).selectOption("Y");
  await table().getByLabel("수치 시점", { exact: true }).fill("2024");
  await confirmRead();
  const transfer = () =>
    table().getByRole("button", { name: "수치·선택조건을 아래 빈 입력칸에 넣기", exact: true });
  const title = () => panel().getByLabel("공개 자료 제목", { exact: true });
  const url = () => panel().getByLabel("원문 URL (HTTPS)", { exact: true });
  const quote = () => panel().getByLabel("원문 발췌", { exact: false });
  const period = () =>
    panel().getByLabel("자료의 기준 기간·대상 (모르면 비워 두기)", { exact: true });
  const readDate = () => panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true });
  const consent = () => panel().getByRole("checkbox").last();
  const save = () => panel().getByRole("button", { name: "공개 근거 후보 보관", exact: true });
  const count = queryRequests.length;
  assert.equal(await title().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  assert.equal(await readDate().inputValue(), "");
  assert.equal(await transfer().isDisabled(), false);
  assert.deepEqual(await dbRows(), beforeRows);
  record("reading a matched cell alone leaves all draft fields/consent and DB unchanged");

  await panel().getByText("발행일·기준 기간·관련성 기록", { exact: true }).click();
  for (const field of [title, url, quote, period]) {
    await field().fill(" ");
    assert.equal(await transfer().isDisabled(), true);
    assert.equal(await field().inputValue(), " ");
    await field().fill("");
  }
  await panel().getByLabel("발행처 (모르면 비워 두기)", { exact: true }).fill("PRIVATE_PUBLISHER");
  await panel()
    .getByLabel("발행일 (원문 표기, 모르면 비워 두기)", { exact: true })
    .fill("2020-01-01");
  await panel().getByLabel("이 항목과 관련된 이유", { exact: false }).fill("PRIVATE_RELEVANCE");
  await panel()
    .getByLabel("기존 자료와 다른 점·추가 확인 사항", { exact: true })
    .fill("PRIVATE_CONFLICT");
  await consent().check();
  await transfer().evaluate((b) => {
    b.click();
    b.click();
  });
  assert.equal(await title().inputValue(), "합성 표");
  assert.equal(
    await url().inputValue(),
    "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC",
  );
  const transferred = await quote().inputValue();
  assert.ok(transferred.includes('"값 원문": "12,345.00"'));
  assert.ok(transferred.includes('"행 수정일 원문 (발행일 아님)": "2025-01-01"'));
  assert.equal(await period().inputValue(), "수동 지정 주기·시점: Y / 2024");
  assert.equal(await readDate().inputValue(), "");
  assert.equal(await consent().isChecked(), false);
  assert.equal(await save().isDisabled(), true);
  assert.equal(await transfer().isDisabled(), true);
  assert.equal(
    await panel().getByLabel("발행일 (원문 표기, 모르면 비워 두기)", { exact: true }).inputValue(),
    "2020-01-01",
  );
  assert.equal(
    await panel().getByLabel("이 항목과 관련된 이유", { exact: false }).inputValue(),
    "PRIVATE_RELEVANCE",
  );
  assert.equal(queryRequests.length, count);
  assert.deepEqual(writes, []);
  assert.deepEqual(await dbRows(), beforeRows);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await quote().evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: path.join(output, "cell-evidence-draft-390.png") });
  record(
    "explicit transfer fills four empty fields once, preserves human notes/dates, resets consent and causes zero requests/writes",
  );

  await table().getByLabel("항목 코드", { exact: true }).fill("OTHER");
  assert.equal(await transfer().count(), 0);
  assert.equal(await quote().inputValue(), transferred);
  await table().getByLabel("항목 코드", { exact: true }).fill("T001");
  await confirmRead();
  assert.equal(await transfer().isDisabled(), true);
  const clearFields = async () => {
    for (const field of [title, url, quote, period]) await field().fill("");
  };
  await clearFields();
  await mode("empty");
  await confirmRead();
  assert.equal(await transfer().count(), 0);
  await mode("mismatch");
  await confirmRead(false);
  await table().getByRole("alert").waitFor();
  assert.equal(await transfer().count(), 0);
  assert.equal(await quote().inputValue(), "");
  record(
    "editing selection removes old transfer action; an existing manual draft remains; empty/failed reads cannot transfer",
  );

  await mode("long-title");
  await lookup().click();
  await panel().getByRole("region", { name: "KOSIS 검색 후보" }).waitFor();
  await openTable();
  async function fillSelection() {
    await table().getByLabel("항목 코드", { exact: true }).fill("T001");
    await table().getByLabel("분류 1 코드", { exact: true }).fill("001");
    await table().getByLabel("수치 주기", { exact: true }).selectOption("Y");
    await table().getByLabel("수치 시점", { exact: true }).fill("2024");
  }
  await fillSelection();
  await confirmRead();
  assert.equal(await transfer().isDisabled(), true);
  assert.equal(await quote().inputValue(), "");
  assert.ok((await table().innerText()).includes("긴제목".repeat(45)));
  await mode("normal");
  await lookup().click();
  await panel().getByRole("region", { name: "KOSIS 검색 후보" }).waitFor();
  await openTable();
  await fillSelection();
  for (let i = 2; i <= 8; i++) {
    await table().getByRole("button", { name: "분류 칸 추가", exact: true }).click();
    await table()
      .getByLabel("분류 " + i + " 코드", { exact: true })
      .fill("001");
  }
  await mode("oversize");
  await confirmRead();
  assert.equal(await transfer().isDisabled(), true);
  assert.equal(await quote().inputValue(), "");
  assert.deepEqual(await dbRows(), beforeRows);
  record(
    "overlong candidate title and escaped excerpt over 50000 chars remain readable but cannot be truncated into the form",
  );

  await mode("normal");
  await confirmRead();
  await transfer().click();
  const finalQuote = await quote().inputValue();
  await readDate().fill("2026-10-05");
  assert.equal(await consent().isChecked(), false);
  await consent().check();
  loseAck = true;
  blockGet = true;
  await save().evaluate((b) => {
    b.click();
    b.click();
  });
  await panel()
    .getByText(/저장 결과가 미확인입니다/)
    .waitFor();
  assert.equal(writes.filter((w) => w.method === "PATCH").length, 1);
  assert.equal(await quote().inputValue(), finalQuote);
  const afterWrite = await snapshot(),
    afterRows = await dbRows();
  assert.equal(afterWrite.sources.length, before.sources.length + 1);
  assert.deepEqual(afterWrite.plans, before.plans);
  assert.deepEqual(afterWrite.sources.slice(0, before.sources.length), before.sources);
  const stored = afterWrite.sources.at(-1);
  assert.ok(stored.text.includes(finalQuote));
  assert.ok(stored.text.includes("PRIVATE_RELEVANCE"));
  assert.ok(stored.text.includes("담당자가 원문을 읽었다고 기록한 날짜: 2026-10-05"));
  assert.equal(stored.extraction, "manual");
  assert.equal(await table().count(), 0);
  for (let i = 1; i < 4; i++) assert.deepEqual(afterRows[i], beforeRows[i]);
  await panel().getByRole("button", { name: "이 자료의 저장 상태 확인", exact: true }).click();
  await panel()
    .getByText(/공개 근거 후보를 보관했습니다/)
    .waitFor();
  assert.equal(writes.filter((w) => w.method === "PATCH").length, 1);
  assert.deepEqual(await snapshot(), afterWrite);
  assert.deepEqual(await dbRows(), afterRows);
  record(
    "existing source PATCH commits once despite double click and lost acknowledgement/GET; explicit GET recovers exact manual source",
  );

  await panel().getByRole("button", { name: "닫기", exact: true }).click();
  const publicCount = queryRequests.length;
  await stop();
  await start();
  await reopen();
  assert.equal(await title().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  assert.equal(await readDate().inputValue(), "");
  assert.equal(await consent().isChecked(), false);
  assert.equal(queryRequests.length, publicCount);
  assert.deepEqual(await snapshot(), afterWrite);
  assert.deepEqual(await dbRows(), afterRows);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  assert.ok(!JSON.stringify(await wires()).includes("PRIVATE"));
  record(
    "server/page restart preserves the saved record, starts with an empty unconfirmed draft and sends no public query or write",
  );

  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        publicHttpCommands: queryRequests.length,
        syntheticWire: await wires(),
        transferServerWrites: 0,
        explicitSourceWrites: 1,
        unchangedOtherTables: 3,
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
