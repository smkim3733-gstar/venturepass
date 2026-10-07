import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// Actual isolated UI/read-only route; company/status replies and provider fetch are synthetic.
// The explicit build must be a current, environment-free build:local staging directory.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
assert.equal(
  process.argv.length >= 3 && process.argv.length <= 5,
  true,
  "Usage: node scripts/public-table-metadata-validation.mjs <build:local staging>",
);
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
const scope = process.argv[4] ?? "all";
assert.ok(["all", "cmmt-error"].includes(scope));
assert.ok(["dev", "start"].includes(serverMode));
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
const buildId =
  serverMode === "start"
    ? (await readFile(path.join(staging, ".next/BUILD_ID"), "utf8")).trim()
    : null;
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
 if(u.href==="https://registry.npmjs.org/-/package/next/dist-tags"){
  process.stderr.write("NEXT_VERSION_CHECK_STUBBED\n"); return new Response(null,{status:503});
 }
 if(u.origin==="https://kosis.kr"){
  if(u.searchParams.get("apiKey")!=="synthetic-kosis-test-key")throw Error("Wrong synthetic key");
  const mode=JSON.parse(await readFile(process.env.SYNTHETIC_MODE_FILE,"utf8")).mode;
  const params=Object.fromEntries(u.searchParams);delete params.apiKey;
  await appendFile(process.env.SYNTHETIC_WIRE_FILE,JSON.stringify({path:u.pathname,params})+"\n");
  if(u.pathname==="/openapi/statisticsSearch.do")return Response.json([{ORG_ID:"999",ORG_NM:"합성 기관",TBL_ID:"DT_SYNTHETIC",TBL_NM:mode==="changed"?"바뀐 합성 표":"합성 표",STRT_PRD_DE:"2020",END_PRD_DE:"2024",LINK_URL:"https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC"}]);
  if(u.pathname!=="/openapi/statisticsData.do")throw Error("Forbidden synthetic endpoint");
  if(mode==="hold"||mode==="hold-error"){
   while(["hold","hold-error"].includes(JSON.parse(await readFile(process.env.SYNTHETIC_MODE_FILE,"utf8")).mode)){
    if(init.signal.aborted)throw Error("Aborted synthetic hold");
    await new Promise(r=>setTimeout(r,20));
   }
  }
  if(mode==="code30"||mode==="hold-error")return Response.json({err:"30",errMsg:"PRIVATE_PROVIDER https://private.invalid?apiKey=secret"});
  if(mode==="ambiguous-code30")return new Response('{"err":"30","err":"30"}');
  if(mode==="empty")return Response.json([]);
  if(mode==="malformed")return Response.json({err:"SYNTHETIC_ONLY"});
  if(u.searchParams.get("method")!=="getMeta"||u.searchParams.get("orgId")!=="999"||u.searchParams.get("tblId")!=="DT_SYNTHETIC")throw Error("Wrong metadata selection");
  const kind=u.searchParams.get("type");
  if(kind==="CMMT")return Response.json([
    {CMMT_NM:" 원래 주석 유형 ",CMMT_DC:" 원래 첫 줄\n<svg onload=alert(1)> https://example.invalid "+ "긴합성주석".repeat(450),OBJ_ID:"",OBJ_NM:null,ITM_ID:" 01 ",ITM_NM:"원래 분류값"},
    {CMMT_NM:"",CMMT_DC:""},
    {CMMT_NM:"같은 코드의 다른 주석",CMMT_DC:"마지막 원문",OBJ_ID:"",ITM_ID:" 01 "}
  ]);
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
environment.NODE_ENV = serverMode === "dev" ? "development" : "production";
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
  checks = [],
  developmentDiagnostics = [],
  consoleErrors = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
async function start() {
  const logStart = logs.length;
  child = spawn(
    process.execPath,
    [
      "--max-old-space-size=1536",
      "--max-semi-space-size=8",
      "--import",
      pathToFileURL(guard).href,
      nextCli,
      serverMode,
      ...(serverMode === "dev" ? ["--webpack"] : []),
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
    if (logs.slice(logStart).join("").includes("Ready in")) return;
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
const name = "PRIVATE_COMPANY 합성 표 정보 시험";
const caseId = "c0000000-0000-4000-8000-000000000001";
// Bundle only audited pure schemas; never load the store/SDK to make fixture data.
const requireFromVitest = createRequire(
  createRequire(import.meta.url).resolve("vitest/package.json"),
);
const { rolldown } = await import(pathToFileURL(requireFromVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "src/lib/studio-schema.ts"),
  cwd: app,
  platform: "browser",
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      resolveId(source) {
        if (
          /openai|server-only|node:|storage|quality-store|provider-production|configuration-current/.test(
            source,
          )
        )
          throw Error("Forbidden fixture import: " + source);
        return null;
      },
    },
  ],
});
let schema;
try {
  const generated = await bundle.generate({ format: "esm" });
  assert.equal(generated.output.length, 1);
  const chunk = generated.output[0];
  assert.equal(chunk.type, "chunk");
  assert.deepEqual(chunk.imports, []);
  assert.deepEqual(chunk.dynamicImports, []);
  schema = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
const company = schema.caseSchema.parse({
  id: caseId,
  profile: { ...schema.emptyProfile(), companyName: name },
  sources: [],
  analysis: null,
  selectedCandidateId: null,
  plans: [],
  tasks: [],
  stage: "preparing",
  revision: 0,
  createdAt: "2026-10-07T02:00:00.000Z",
  updatedAt: "2026-10-07T02:00:00.000Z",
});
const summary = {
  id: caseId,
  companyName: name,
  industry: "",
  stage: company.stage,
  revision: 0,
  createdAt: company.createdAt,
  updatedAt: company.updatedAt,
  sourceCount: 0,
  planCount: 0,
  pendingTaskCount: 0,
};
const companyBefore = JSON.stringify(company);

const queryRequests = [],
  writes = [];
const panel = () => page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
const table = () => panel().getByLabel("선택 통계표 정보", { exact: true });
const result = () => table().getByRole("region", { name: "읽은 표 정보", exact: true });
const lookup = () => panel().getByRole("button", { name: "공개 검색 후보 10개 조회", exact: true });
const read = () => table().getByRole("button", { name: "선택 표 정보 한 번 조회", exact: true });

const wires = async () =>
  (await readFile(wireFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const modeFile = path.join(output, "synthetic-mode.json");
const mode = async (mode) => writeFile(modeFile, JSON.stringify({ mode }));
environment.SYNTHETIC_MODE_FILE = modeFile;
environment.KOSIS_API_KEY = "synthetic-kosis-test-key";
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
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
    if (serverMode === "dev" && u.pathname === "/__nextjs_original-stack-frames") {
      developmentDiagnostics.push(req.postDataJSON());
      return route.abort();
    }
    if (u.pathname === "/api/studio/public-research/search" && req.method() === "POST") {
      queryRequests.push(req.postDataJSON());
      return route.continue();
    }
    if (
      req.method() === "GET" &&
      u.pathname === "/api/studio/cases/" + caseId + "/guided-preparation"
    )
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          company,
          active: false,
          aiConfigured: false,
          approval: {
            caseId,
            revision: 0,
            provider: "OpenAI",
            model: "synthetic-disabled",
            inputFingerprint: "a".repeat(64),
            sourceIds: [],
            sourceNames: [],
            profileIncluded: true,
            businessNumberIncluded: false,
            originalFilesIncluded: false,
            derivedDraftIncluded: true,
            purpose: "analysis-plan-review",
          },
        }),
      });
    if (req.method() === "GET" && u.pathname === "/api/studio/cases/" + caseId + "/source-intakes")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ company, activeItemIds: [] }),
      });
    if (req.method() === "GET") {
      const payload =
        u.pathname === "/api/studio/status"
          ? {
              aiConfigured: false,
              model: "synthetic-disabled",
              storage: "local",
              supportedFiles: [],
            }
          : u.pathname === "/api/studio/cases"
            ? { cases: [summary] }
            : u.pathname === "/api/studio/cases/" + caseId
              ? company
              : undefined;
      if (payload !== undefined)
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(payload),
        });
    }
    if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      writes.push({ path: u.pathname, method: req.method() });
      return route.abort();
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await reopen();
  assert.equal(queryRequests.length, 0);
  if (scope === "cmmt-error") {
    await commentErrorChecks();
  } else {
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
    assert.equal(JSON.stringify(company), companyBefore);
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
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await table().screenshot({ path: path.join(output, "table-metadata-390.png") });
    record(
      "three metadata variants preserve inactive literal strings; selection clears old result and 390px fits",
    );

    await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("CMMT");
    assert.equal(await result().count(), 0);
    const commentAt = queryRequests.length;
    await read().click();
    await result().waitFor();
    assert.equal(queryRequests.length, commentAt + 1);
    assert.equal(await result().getByRole("article").count(), 3);
    assert.ok((await result().innerText()).includes("마지막 원문"));
    assert.ok((await result().innerText()).includes("본문이 빈 주석 행"));
    assert.equal(await result().locator("svg,script,a,img").count(), 0);
    await result().getByText("반환된 분류 표기", { exact: true }).first().click();
    const text = await result().innerText();
    assert.ok(text.includes("빈 문자열") && text.includes("반환값 null") && text.includes(" 01 "));
    await result().getByText("반환된 분류 표기", { exact: true }).nth(1).click();
    assert.ok((await result().innerText()).includes("반환 필드 없음"));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.ok(!(await table().innerText()).includes("분류·주석·표"));
    assert.equal(
      await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
      "PRIVATE_BODY",
    );
    await table().screenshot({ path: path.join(output, "comment-390.png") });
    record(
      "CMMT renders original multiline text and related fields safely; missing/null/empty stay distinct on mobile",
    );

    const fillComment = (index) =>
      result()
        .getByRole("article")
        .nth(index)
        .getByRole("button", { name: "이 주석을 아래 빈 입력칸에 넣기", exact: true });
    assert.equal(await fillComment(0).isDisabled(), true);
    assert.equal(await fillComment(2).isDisabled(), true);
    await panel().getByLabel("공개 자료 제목", { exact: true }).fill("");
    await panel().getByLabel("원문 발췌", { exact: false }).fill("");
    await panel().getByText("발행일·기준 기간·관련성 기록", { exact: true }).click();
    await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).fill("2026-09-01");
    await panel()
      .getByLabel("발행일 (원문 표기, 모르면 비워 두기)", { exact: true })
      .fill("2020-01-01");
    await panel()
      .getByLabel("발행처 (모르면 비워 두기)", { exact: true })
      .fill("PRIVATE_PUBLISHER");
    await panel().getByLabel("이 항목과 관련된 이유", { exact: false }).fill("PRIVATE_RELEVANCE");
    await panel()
      .getByLabel("기존 자료와 다른 점·추가 확인 사항", { exact: false })
      .fill("PRIVATE_CONFLICT");
    await panel().getByRole("checkbox").check();
    const transferAt = queryRequests.length,
      transferWireAt = (await wires()).length;
    assert.equal(await fillComment(1).isDisabled(), true);
    await fillComment(2).evaluate((b) => {
      b.click();
      b.click();
    });
    await table()
      .getByText(/선택한 주석을 아래 입력칸에 옮겼습니다/)
      .waitFor();
    const getQuote = () => panel().getByLabel("원문 발췌", { exact: false }).inputValue();
    const parseQuote = (text) =>
      JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    let transferred = parseQuote(await getQuote());
    assert.equal(transferred["선택한 행 번호 (이 응답에서 1부터)"], 3);
    assert.equal(transferred["원래 주석 행"].CMMT_DC, "마지막 원문");
    assert.equal(transferred["원래 주석 행"].ITM_ID, " 01 ");
    assert.equal(await panel().getByRole("checkbox").isChecked(), true);
    assert.equal(
      await panel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).inputValue(),
      "2026-09-01",
    );
    assert.equal(
      await panel()
        .getByLabel("발행일 (원문 표기, 모르면 비워 두기)", { exact: true })
        .inputValue(),
      "2020-01-01",
    );
    assert.equal(
      await panel().getByLabel("발행처 (모르면 비워 두기)", { exact: true }).inputValue(),
      "PRIVATE_PUBLISHER",
    );
    assert.equal(
      await panel().getByLabel("이 항목과 관련된 이유", { exact: false }).inputValue(),
      "PRIVATE_RELEVANCE",
    );
    assert.equal(
      await panel().getByLabel("기존 자료와 다른 점·추가 확인 사항", { exact: false }).inputValue(),
      "PRIVATE_CONFLICT",
    );
    assert.equal(
      await panel()
        .getByLabel("자료의 기준 기간·대상 (모르면 비워 두기)", { exact: true })
        .inputValue(),
      "",
    );
    assert.equal(queryRequests.length, transferAt);
    assert.equal((await wires()).length, transferWireAt);
    assert.deepEqual(writes, []);
    assert.equal(await fillComment(0).isDisabled(), true);
    record(
      "4H10 explicit repeated-ID third row transfer preserves manual dates/notes/checkbox and makes no IO; occupied and empty rows blocked",
    );

    await panel().getByLabel("공개 자료 제목", { exact: true }).fill("");
    await panel().getByLabel("원문 URL (HTTPS)", { exact: true }).fill("");
    await panel().getByLabel("원문 발췌", { exact: false }).fill("");
    assert.equal(await panel().getByRole("checkbox").isChecked(), false);
    await fillComment(0).click();
    transferred = parseQuote(await getQuote());
    assert.equal(transferred["선택한 행 번호 (이 응답에서 1부터)"], 1);
    assert.ok(transferred["원래 주석 행"].CMMT_DC.includes("<svg onload=alert(1)>"));
    assert.equal(transferred["원래 주석 행"].OBJ_ID, "");
    assert.equal(transferred["원래 주석 행"].OBJ_NM, null);
    assert.equal(Object.hasOwn(transferred["원래 주석 행"], "ITM_NM"), true);
    assert.equal(await panel().getByRole("checkbox").isChecked(), false);
    assert.equal(queryRequests.length, transferAt);
    assert.equal((await wires()).length, transferWireAt);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await panel().screenshot({ path: path.join(output, "comment-evidence-390.png") });
    record(
      "4H10 full multiline literal comment survives transfer with no invented period or automatic consent; mobile form fits",
    );

    const preservedQuote = await getQuote();
    await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("SOURCE");
    assert.equal(
      await table()
        .getByRole("button", { name: "이 주석을 아래 빈 입력칸에 넣기", exact: true })
        .count(),
      0,
    );
    assert.equal(await getQuote(), preservedQuote);
    await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("CMMT");
    await read().click();
    await result().waitFor();
    const outer = panel().getByText("공개 통계 찾기 (선택)", { exact: true });
    await outer.click();
    await until(async () => (await result().count()) === 0);
    const closedAt = queryRequests.length;
    await outer.click();
    assert.equal(await result().count(), 0);
    assert.equal(queryRequests.length, closedAt);
    assert.equal(await getQuote(), preservedQuote);
    await panel().getByLabel("공개 자료 제목", { exact: true }).fill("PRIVATE_DRAFT");
    await panel().getByLabel("원문 발췌", { exact: false }).fill("PRIVATE_BODY");
    record(
      "4H10 selection change and ancestor close discard transfer controls while preserving the editable draft without automatic reads",
    );

    const refreshAt = queryRequests.length;
    await search();
    assert.equal(queryRequests.length, refreshAt + 1);
    assert.equal(
      await panel().getByRole("region", { name: "읽은 표 정보", exact: true }).count(),
      0,
    );
    await openTable();
    await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("CMMT");
    assert.equal(queryRequests.length, refreshAt + 1);
    assert.equal(
      await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
      "PRIVATE_BODY",
    );
    record(
      "fresh candidate remount clears metadata and cell independently with no sibling-key collisions or automatic reads",
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
    assert.ok((await result().innerText()).includes("받은 주석 행이 0개"));
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
    const details = panel()
      .getByText("이 표의 기본 정보 확인 (선택)", { exact: true })
      .locator("..");
    await details.locator(":scope > summary").click();
    await mode("normal");
    await page.waitForTimeout(100);
    await details.locator(":scope > summary").click();
    assert.equal(await result().count(), 0);
    assert.equal(
      await panel().getByLabel("원문 발췌", { exact: false }).inputValue(),
      "PRIVATE_BODY",
    );
    record(
      "same Next HTTP route shares in-flight gate; closing aborts and discards the pending result",
    );

    await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("CMMT");
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
    assert.equal(JSON.stringify(company), companyBefore);
    assert.equal(JSON.stringify(company), companyBefore);
    record(
      "real HTTP rejects extra company payload and foreign origin before provider access; synthetic company unchanged and no write API",
    );
  }
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("");
  await panel().getByLabel("원문 발췌", { exact: false }).fill("");
  await page.reload({ waitUntil: "networkidle" });
  await stop();
  await start();
  const finalCount = (await wires()).length;
  await reopen();
  assert.equal((await wires()).length, finalCount);
  assert.equal(await panel().getByLabel("선택 통계표 정보", { exact: true }).count(), 0);
  assert.equal(JSON.stringify(company), companyBefore);
  assert.equal(JSON.stringify(company), companyBefore);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(developmentDiagnostics, []);
  assert.ok(
    !consoleErrors.some((text) => /same key|Encountered two children|hydration/i.test(text)),
  );
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  assert.ok(!JSON.stringify(await wires()).includes("PRIVATE"));
  assert.ok(!JSON.stringify(queryRequests).includes("PRIVATE"));
  assert.equal(JSON.stringify(company), companyBefore);
  assert.ok(
    !(
      await readdir(dataDirectory).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      })
    ).some((n) => /sqlite/.test(n)),
  );
  record(
    "server and page restart issue no public reads; synthetic company unchanged without SQL reads/writes",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        serverMode,
        scope,
        developmentDiagnostics,
        consoleErrors,
        checks,
        publicHttpCommands: queryRequests.length,
        syntheticWire: await wires(),
        syntheticCompanyUnchanged: true,
        nextVersionChecksStubbed: logs.filter((line) => line.includes("NEXT_VERSION_CHECK_STUBBED"))
          .length,
        databaseReads: 0,
        databaseWrites: 0,
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

async function commentErrorChecks() {
  await search();
  await openTable();
  const select = table().getByLabel("읽을 표 정보", { exact: true });
  await select.selectOption("CMMT");
  const quote = panel().getByLabel("원문 발췌", { exact: false });
  await panel().getByLabel("공개 자료 제목", { exact: true }).fill("PRIVATE_DRAFT");
  await quote.fill("PRIVATE_BODY");
  await panel().getByRole("checkbox").check();
  const alert = () => table().getByRole("alert");
  const fixed = "KOSIS가 이번 주석 요청에 조회결과 없음 오류를 반환했습니다.";
  const generic = "표 정보가 미확인입니다.";
  async function checkError(prefix) {
    await alert().waitFor();
    assert.ok((await alert().innerText()).startsWith(prefix));
    assert.ok(!(await alert().innerText()).includes("PRIVATE_PROVIDER"));
    assert.equal(await result().count(), 0);
    assert.equal(
      await table()
        .getByRole("button", { name: "이 주석을 아래 빈 입력칸에 넣기", exact: true })
        .count(),
      0,
    );
    await until(async () => await read().isEnabled());
  }
  await mode("code30");
  const before = queryRequests.length,
    wireBefore = (await wires()).length;
  await read().click();
  await checkError(fixed);
  assert.ok((await alert().innerText()).includes("표 전체에 주석이 없다는 뜻은 아닙니다"));
  assert.equal(queryRequests.length, before + 1);
  assert.equal((await wires()).length, wireBefore + 2);
  assert.equal(await quote.inputValue(), "PRIVATE_BODY");
  assert.equal(await panel().getByRole("checkbox").isChecked(), true);
  record(
    "4H21 real route keeps CMMT code30 as safe error, no result/transfer/retry, draft and consent retained",
  );

  await select.selectOption("TBL");
  assert.equal(await alert().count(), 0);
  await read().click();
  await checkError(generic);
  await select.selectOption("CMMT");
  await mode("empty");
  await read().click();
  await result().waitFor();
  assert.equal(await alert().count(), 0);
  assert.ok((await result().innerText()).includes("받은 주석 행이 0개"));
  await mode("ambiguous-code30");
  await read().click();
  await checkError(generic);
  record(
    "4H21 non-comment and duplicate error objects remain generic; empty array stays a distinct accepted result",
  );

  const outer = panel().getByText("공개 통계 찾기 (선택)", { exact: true });
  await mode("code30");
  await read().click();
  await checkError(fixed);
  await outer.click();
  await until(async () => (await alert().count()) === 0);
  const closedAt = queryRequests.length;
  await outer.click();
  assert.equal(await alert().count(), 0);
  assert.equal(queryRequests.length, closedAt);
  assert.equal(await quote.inputValue(), "PRIVATE_BODY");
  assert.equal(await panel().getByRole("checkbox").isChecked(), true);
  record("4H21 ancestor close discards error without clearing draft/consent or requerying");

  for (const boundary of ["close", "kind"]) {
    await select.selectOption("CMMT");
    await mode("hold-error");
    const startAt = (await wires()).length;
    await read().click();
    await until(async () => (await wires()).length === startAt + 2);
    if (boundary === "close") await outer.click();
    else await select.selectOption("SOURCE");
    await mode("code30");
    await page.waitForTimeout(150);
    if (boundary === "close") await outer.click();
    assert.equal(await alert().count(), 0);
    assert.equal(await result().count(), 0);
    assert.equal((await wires()).length, startAt + 2);
    assert.equal(await quote.inputValue(), "PRIVATE_BODY");
    record("4H21 pending comment error discarded on " + boundary + " without late stale display");
  }

  await select.selectOption("CMMT");
  // Exercise the client guard without contacting even the synthetic provider.
  for (const [status, code, expected] of [
    [502, "PUBLIC_COMMENT_NO_RESULTS", fixed],
    [400, "PUBLIC_COMMENT_NO_RESULTS", generic],
    [502, "UNKNOWN_CODE", generic],
  ]) {
    const stub = async (route) => {
      queryRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          code,
          error: "PRIVATE_PROVIDER https://private.invalid?apiKey=secret",
        }),
      });
    };
    await context.route(origin + "/api/studio/public-research/search", stub);
    const beforeStub = (await wires()).length;
    await read().click();
    await checkError(expected);
    assert.equal((await wires()).length, beforeStub);
    await context.unroute(origin + "/api/studio/public-research/search", stub);
  }
  record(
    "4H21 client uses only supported code/status for current CMMT and never renders supplied error text",
  );

  await mode("code30");
  await read().click();
  await checkError(fixed);
  await search();
  assert.equal(await panel().getByRole("alert").count(), 0);
  assert.equal(await panel().getByRole("region", { name: "읽은 표 정보", exact: true }).count(), 0);
  await openTable();
  assert.equal(await alert().count(), 0);
  assert.equal(await quote.inputValue(), "PRIVATE_BODY");
  assert.equal(await panel().getByRole("checkbox").isChecked(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await table().getByLabel("읽을 표 정보", { exact: true }).selectOption("CMMT");
  await read().click();
  await checkError(fixed);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await table().screenshot({ path: path.join(output, "cmmt-error-390.png") });
  record(
    "4H21 fresh candidate remount clears error, preserves draft/consent, fixed guidance fits mobile",
  );
}
