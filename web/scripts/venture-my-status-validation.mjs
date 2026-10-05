import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { randomUUID } from "node:crypto";
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
  "Usage: node scripts/venture-my-status-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-my-status-view-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==="string"||input instanceof URL?input:input.url);if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname)){process.stderr.write("EXTERNAL_FETCH_BLOCKED\n");throw Error("External fetch forbidden");}return original(input,init);};`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
environment.OPENAI_API_KEY = "";
environment.KOSIS_API_KEY = "";
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

// Synthetic-only imports. This script never reads the customer's database or .env files.
const sourceRoot = pathToFileURL(path.join(app, "src") + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && context.parentURL?.startsWith(sourceRoot)) {
        const target = new URL(`${specifier}.ts`, context.parentURL);
        if (target.href.startsWith(sourceRoot) && existsSync(target))
          return { url: target.href, shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith(".ts")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { StudioStore } = await import("../src/lib/studio-storage.ts");
const { caseSchema, emptyProfile } = await import("../src/lib/studio-schema.ts");
const { deriveGuidedFlow } = await import("../src/lib/studio-guided-flow.ts");
const { publicEvidenceExportFixture } =
  await import("../src/lib/studio-public-evidence-export-test-helpers.ts");
function fixture(name) {
  const { record: c, plan: p } = publicEvidenceExportFixture();
  c.profile = { ...emptyProfile(), companyName: name, businessNumber: "1234567890" };
  c.sources = [];
  c.stage = "preparing";
  c.tasks = [];
  p.confirmedAt = "2026-10-05T00:00:00.000Z";
  p.sourceRevision = c.revision;
  p.content.sections.forEach((s) => {
    s.needsConfirmation = false;
    s.evidence = [];
  });
  const candidate = {
    id: p.candidateId,
    title: "합성 방향",
    problem: "합성 문제",
    solution: "합성 해결",
    targetCustomer: "합성 고객",
    differentiation: "합성 차이",
    stage: "개발",
    businessModel: "합성 수익",
    recommendation: "합성 추천",
    evidence: [],
    gaps: [],
  };
  c.analysis = {
    summary: "합성 분석",
    facts: [],
    candidates: [candidate],
    questions: [],
    warnings: [],
    generatedAt: "2026-10-04T00:00:00.000Z",
    mode: "assisted",
    sourceRevision: c.revision,
  };
  c.selectedCandidateId = candidate.id;
  c.candidateSelections = [
    {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      recordedAt: "2026-10-04T00:00:00.000Z",
      origin: "manual",
      event: "selection",
      reason: "시험 설정",
      previousCandidateId: null,
      candidateId: candidate.id,
      analysisGeneratedAt: c.analysis.generatedAt,
      analysisSourceRevision: c.revision,
      analysisMode: "assisted",
      analysisDigest: "a".repeat(64),
      candidateDigest: "a".repeat(64),
      candidate,
      previousCandidate: null,
      previousContext: "none",
      previousRecordId: null,
    },
  ];
  const value = caseSchema.parse(c);
  assert.equal(deriveGuidedFlow(value).planReady, true);
  return value;
}

const first = fixture("합성 현황 읽기 A"), second = fixture("합성 현황 읽기 B");
const fixtures=[first,second];
const bootstrap=new StudioStore(dataDirectory); bootstrap.close();
const databaseFile=path.join(dataDirectory,"studio.sqlite");
const db=new DatabaseSync(databaseFile);
try { for(const c of fixtures) db.prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)").run(c.id,c.revision,c.revision,JSON.stringify(c)); } finally { db.close(); }
function rows() {
  const d=new DatabaseSync(databaseFile,{readOnly:true});
  try {return ["studio_cases","venture_accounts","venture_workflows","studio_prepared_packages"].map(t=>d.prepare("SELECT * FROM "+t+" ORDER BY 1").all());} finally{d.close();}
}
const initialRows=rows(), reads=[], writes=[];
const panel=()=>page.getByRole("region",{name:"MY벤처현황 읽기",exact:true});
const readButton=()=>panel().getByRole("button",{name:"현재 MY벤처현황 한 번 읽기",exact:true});
const result=()=>panel().locator('[aria-label="이번에 읽은 MY벤처현황"]');
async function openCompany(c){
  await page.goto(origin+"/studio",{waitUntil:"networkidle"});
  await page.getByRole("button").filter({hasText:c.profile.companyName}).first().click();
  await page.getByRole("navigation",{name:"신청 준비 3단계"}).getByRole("button",{name:"신청·진행"}).click();
  await page.getByRole("region",{name:"벤처인 연결 기록 요약"}).getByRole("button",{name:"벤처인 연결 준비",exact:true}).click();
  await panel().waitFor();
}
const { decodeVentureMyStatus }=await import("../src/lib/venturein-my-status.ts");
const { myStatusFixture,myStatusExpected }=await import("../src/lib/venturein-my-status-test-fixture.ts");
const myPath=c=>"**/api/studio/cases/"+c.id+"/venturein/my-status";
let reply, behavior="normal", release, entered, handled;
const sameResponse=(c,connection,workflow)=>({
  format:"venturepass-my-status-read-v1",caseId:c.id,companyRevision:c.revision,
  accountRevision:connection.account.revision,workflowRevision:workflow.revision,
  sessionStartedAt:connection.session.startedAt,documentRevision:1,scope:"company-screen",
  applicationAttribution:"unavailable-no-application-number",
  observation:{...decodeVentureMyStatus(myStatusFixture(),{...myStatusExpected,applicationNumber:null}),origin:"page-observation"}
});
try{
  await start();
  context=await chromium.launchPersistentContext(path.join(output,"browser-profile"),{
    executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless:true,viewport:{width:1100,height:1000},serviceWorkers:"block"});
  context.setDefaultTimeout(15000);
  await context.route("**/*",r=>{
    const req=r.request();
    if(new URL(req.url()).origin!==origin){externalRequests.push("blocked");return r.abort();}
    if(!["GET","HEAD"].includes(req.method())) writes.push(req.method()+" "+new URL(req.url()).pathname);
    return r.continue();
  });
  page=await context.newPage();
  page.on("pageerror",e=>errors.push(e.message));
  page.on("dialog",async d=>{errors.push("unexpected dialog");await d.dismiss();});
  const originals=[];
  for(const c of fixtures){
    originals.push(await(await api("/api/studio/cases/"+c.id)).json());
    const baseConnection=await(await api("/api/studio/cases/"+c.id+"/venturein")).json();
    const baseWorkflow=await(await api("/api/studio/cases/"+c.id+"/venturein/workflow")).json();
    const now=new Date().toISOString();
    const connection={...baseConnection,account:{saved:true,revision:2,maskedLoginId:"synthetic***",updatedAt:now},
      session:{state:"connected_unmapped",startedAt:now,updatedAt:now,message:"합성 연결"}};
    const workflow={...baseWorkflow,revision:3,accountRevision:2,session:connection.session};
    await page.route("**/api/studio/cases/"+c.id+"/venturein",r=>r.fulfill({json:connection}));
    await page.route("**/api/studio/cases/"+c.id+"/venturein/workflow",r=>r.fulfill({json:workflow}));
    const value=sameResponse(c,connection,workflow);
    if(c===first) reply=value;
    await page.route(myPath(c),async r=>{
      reads.push({caseId:c.id,body:r.request().postDataJSON()});
      const captured=structuredClone(c===first?reply:value);
      if(behavior==="held"){entered();await new Promise(resolve=>{release=resolve;});}
      try { await r.fulfill(behavior==="error"?{status:409,json:{error:"SYNTHETIC PRIVATE ERROR",code:"UNSUPPORTED_PAGE"}}:{json:captured}); }
      catch{} finally { if(behavior==="held") handled(); }
    });
  }
  await openCompany(first);
  assert.equal(await panel().locator("details").first().evaluate(e=>e.open),false);
  assert.equal(reads.length,0);
  await panel().locator("summary").first().click();
  await readButton().waitFor();
  assert.equal(await readButton().isEnabled(),true);
  assert.equal(reads.length,0);
  assert.equal(await result().count(),0);
  record("mount, local GET refresh and disclosure do not collect or store remote results");

  await readButton().evaluate(e=>{e.click();e.click();});
  await result().waitFor();
  assert.equal(reads.length,1);
  assert.deepEqual(reads[0].body,{action:"read-current-my-status",companyRevision:first.revision,
    accountRevision:2,workflowRevision:3,sessionStartedAt:reply.sessionStartedAt,confirmed:true});
  assert.ok((await result().innerText()).includes("SYNTHETIC-REQUEST-A"));
  assert.ok((await result().innerText()).includes("SYNTHETIC-REQUEST-B"));
  assert.ok((await result().innerText()).includes("로컬 신청 회차 연결 미확인"));
  assert.deepEqual(rows(),initialRows);
  record("duplicate explicit click sends one exact command; separate application/certificate rows remain unassigned");

  const valid=structuredClone(reply);
  for(const changed of [{caseId:second.id},{companyRevision:first.revision+1},
    {observation:{...valid.observation,origin:"supplied-observation"}},
    {observation:{...valid.observation,officialStatusChecked:true}}]){
    reply={...valid,...changed};await readButton().click();
    await panel().getByRole("alert").waitFor();
    assert.equal(await result().count(),0);
    assert.ok(!(await panel().innerText()).includes("PRIVATE"));
  }
  reply=structuredClone(valid);behavior="error";await readButton().click();
  await panel().getByRole("alert").waitFor();assert.ok((await panel().getByRole("alert").innerText()).includes("읽기를 지원하지 않습니다"));behavior="normal";
  assert.equal(reads.length,6);
  record("wrong company/revision/supplied authority and server failure clear prior result without automatic retry");

  async function delayRead(){
    behavior="held";const started=new Promise(r=>{entered=r;});
    const done=new Promise(r=>{handled=r;});
    await readButton().click();await started;
    return async()=>{release();await done;behavior="normal";};
  }
  let finish=await delayRead();
  await panel().locator("summary").first().click();
  await finish();
  await panel().locator("summary").first().click();
  assert.equal(await result().count(),0);
  await readButton().click();await result().waitFor();
  const beforeEdit=reads.length;
  await page.locator("#venture-login-id").fill("synthetic-unsaved");
  // Busy/identity change remounts the disclosure; the account input itself stays in the DOM.
  await panel().locator("summary").first().click();
  assert.equal(await readButton().isDisabled(),true);
  assert.equal(await result().count(),0);
  assert.equal(await page.locator("#venture-login-id").inputValue(),"synthetic-unsaved");
  await page.locator("#venture-login-id").fill("");
  await panel().locator("summary").first().click();
  assert.equal(await readButton().isEnabled(),true);
  assert.equal(reads.length,beforeEdit);
  finish=await delayRead();
  await openCompany(second);
  await finish();
  await panel().locator("summary").first().click();
  assert.equal(await result().count(),0);
  record("closed disclosure, account editing and company switch discard late results and preserve unsaved account input");

  await openCompany(first);await panel().locator("summary").first().click();
  reply=structuredClone(valid);
  reply.observation.applications.rows[0].resultText='<img src="https://example.invalid/a"> '+ "합성긴결과".repeat(55);
  await readButton().click();await result().waitFor();
  assert.equal(await result().locator("img,a,script").count(),0);
  assert.ok((await result().innerText()).includes("<img"));
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(output,"my-status-390.png"),fullPage:true});
  await panel().screenshot({path:path.join(output,"my-status-panel-390.png")});
  for(const state of ["observed","not-present","unsupported"]){
    reply=structuredClone(valid);reply.observation.applications={state,rows:[],...(state==="unsupported"?{reason:"unsupported-content"}:{})};
    await readButton().click();await result().waitFor();
    const expected=state==="observed"?"읽은 표에 표시된 행이 없습니다":state==="not-present"?"해당 표를 찾지 못했습니다":"지원하지 않거나 모호한";
    assert.ok((await result().innerText()).includes(expected));
  }
  record("390px long inert text and empty/missing/unsupported tables preserve uncertainty without truncation");

  // Actual HTTP negative path is not a route fixture. No app Edge session was created in this server.
  const response=await context.request.post(origin+"/api/studio/cases/"+first.id+"/venturein/my-status",
    {data:reads[0].body,headers:{origin}});
  assert.equal(response.status(),409);
  assert.deepEqual(rows(),initialRows);
  const count=reads.length;
  await stop();await start();await openCompany(first);
  assert.equal(reads.length,count);
  assert.equal(await result().count(),0);
  for(let i=0;i<fixtures.length;i++)assert.deepEqual(await(await api("/api/studio/cases/"+fixtures[i].id)).json(),originals[i]);
  assert.deepEqual(rows(),initialRows);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record("actual HTTP cold-session rejection and server/UI restart keep all database rows unchanged with no collection");
  await writeFile(path.join(output,"report.json"),JSON.stringify({buildId,checks,syntheticCases:2,
    syntheticReadPosts:reads.length,actualHttpColdSessionRejections:1,serverWrites:writes,
    actualExternalRequests:0,actualAiCalls:0,errors},null,2));
  console.log(JSON.stringify({output,buildId,checks:checks.length}));
}catch(error){
  if(page){await page.screenshot({path:path.join(output,"failure.png"),fullPage:true}).catch(()=>{});
    console.error((await page.locator("body").innerText().catch(()=>"")).slice(-9000));}
  console.error(JSON.stringify({errors,checks}));throw error;
}finally{await context?.close();await stop();await writeFile(path.join(output,"server.log"),logs.join(""));}
