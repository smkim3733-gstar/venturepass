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
  "Usage: node scripts/application-number-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-number-view-"));
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
  if (!child || child.exitCode !== null || child.signalCode !== null) { child=undefined; return; }
  const owned = child;
  child=undefined;
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


const fixtures=[fixture("합성 번호 연결 A"),fixture("합성 번호 연결 B")];
const bootstrap=new StudioStore(dataDirectory);
const databaseFile=path.join(dataDirectory,"studio.sqlite");
const db=new DatabaseSync(databaseFile);
try {for(const c of fixtures)db.prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)").run(c.id,c.revision,c.revision,JSON.stringify(c));}finally{db.close();}
const { mutationSchema }=await import("../src/lib/studio-schema.ts");
for(let i=0;i<fixtures.length;i++){
 let c=fixtures[i];
 for(let j=0;j<2;j++)c=bootstrap.mutate(c.id,mutationSchema.parse({action:"create-application",revision:c.revision,clientRequestId:randomUUID(),title:"합성 회차 "+(j+1),kind:"new",plannedOn:"",criteriaNote:"",previousApplicationId:null}),()=>[]);
 fixtures[i]=c;
}
bootstrap.close();
const [first,second]=fixtures;
function rows(){const d=new DatabaseSync(databaseFile,{readOnly:true});try{return ["studio_cases","venture_accounts","venture_workflows","studio_prepared_packages"].map(t=>d.prepare("SELECT * FROM "+t+" ORDER BY 1").all());}finally{d.close();}}
const writes=[],reads=[],dialogs=[];
let dialogAnswer="accept",mode="normal",rejectRead=false,releaseRead,readStarted;
const panel=()=>page.getByRole("region",{name:"수동 신청번호 연결",exact:true});
const consent=()=>panel().getByRole("checkbox",{name:"선택한 회차와 번호를 확인했고, 담당자 진술로 보관하겠습니다.",exact:true});
async function openCompany(c){
 await page.goto(origin+"/studio",{waitUntil:"networkidle"});
 await page.getByRole("button").filter({hasText:c.profile.companyName}).first().click();
 await page.getByRole("navigation",{name:"신청 준비 3단계"}).getByRole("button",{name:"신청·진행"}).click();
 await page.getByText("신청 이력·보완·공식 연결",{exact:true}).click();
 await page.getByRole("button",{name:"기관 안내와 진행 기록",exact:true}).click();
 await page.getByRole("button",{name:"신청번호 수동 연결·정정",exact:true}).click();
 await panel().getByLabel("번호를 연결할 신청 회차").waitFor();
 await page.waitForFunction(()=>!document.querySelector('[aria-label="수동 신청번호 연결"] fieldset')?.disabled);
}
async function fill(number,reason="합성 수동 기록"){
 await panel().getByLabel("번호를 연결할 신청 회차").selectOption(first.applications[0].id);
 await panel().getByLabel("수동 신청번호",{exact:true}).fill(number);
 await panel().getByLabel("번호 연결 담당자",{exact:true}).fill("합성 담당자");
 await panel().getByLabel("번호 연결 사유",{exact:true}).fill(reason);
 await consent().check();
}
async function save(){
 await panel().getByRole("button",{name:"수동 연결 보관",exact:true}).evaluate(e=>{e.click();e.click();});
 await panel().getByText("수동 연결 기록을 보관했습니다. 공식 접수·심사 결과 확인은 아닙니다.",{exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('[aria-label="수동 신청번호 연결"] fieldset')?.disabled);
}
const live=async c=>await(await api("/api/studio/cases/"+c.id)).json();
async function separateWrite(number){
 const c=await live(first),applicationId=c.applications[1].id;
 const prior=c.applicationNumberBindings?.records.filter(r=>r.command.applicationId===applicationId).at(-1);
 await api("/api/studio/cases/"+c.id,{method:"PATCH",data:{action:"record-application-number",revision:c.revision,clientRequestId:randomUUID(),
 applicationId,metadataVersionId:applicationId,expectedPreviousBindingId:prior?.id??null,operation:"bind",applicationNumber:number,recordedBy:"별도 합성 담당자",reason:"독립 동시 편집 시험",confirmed:true}});
}
try{
 await start();
 context=await chromium.launchPersistentContext(path.join(output,"browser-profile"),{executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:true,viewport:{width:1100,height:1000},serviceWorkers:"block"});
 context.setDefaultTimeout(15000);
 await context.route("**/*",r=>{
  const req=r.request();if(new URL(req.url()).origin!==origin){externalRequests.push("blocked");return r.abort();}
  return r.continue();
 });
 page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
 page.on("dialog",async d=>{dialogs.push(d.message());await (dialogAnswer==="dismiss"?d.dismiss():d.accept());});
 await page.route("**/api/studio/cases/*",async r=>{
  if(r.request().method()!=="PATCH")return r.continue();
  writes.push(r.request().postDataJSON());
  if(mode==="before")return r.abort();
  if(mode==="after"){const response=await r.fetch();assert.equal(response.status(),200);rejectRead=true;return r.abort();}
  return r.continue();
 });
 await page.route("**/application-numbers",async r=>{
  reads.push(r.request().method());
  if(r.request().method()==="GET"&&rejectRead){rejectRead=false;return r.fulfill({status:503,json:{error:"synthetic read failure"}});}
  if(r.request().method()==="GET"&&mode==="hold"){
   const response=await r.fetch();readStarted();await new Promise(resolve=>{releaseRead=resolve;});
   return r.fulfill({response}).catch(()=>{});
  }
  return r.continue();
 });
 const untouchedSecond=await live(second);
 await openCompany(first);
 assert.equal(writes.length,0);assert.ok(reads.every(m=>m==="GET"));
 assert.equal(await panel().getByLabel("번호를 연결할 신청 회차").inputValue(),"");
 await fill("SYN-001");await panel().getByLabel("번호 연결 사유",{exact:true}).fill("수정한 합성 사유");assert.equal(await consent().isChecked(),false);
 await consent().check();await save();
 let saved=await live(first);assert.equal(saved.applicationNumberBindings.records.length,1);assert.equal(writes.length,1);
 assert.deepEqual(saved.plans,first.plans);assert.deepEqual(saved.sources,first.sources);
 record("explicit round/consent, changed input resets consent, duplicate save sends one real PATCH and preserves content");
 await fill("SYN-002");await save();
 await panel().getByLabel("번호를 연결할 신청 회차").selectOption(first.applications[0].id);
 await panel().getByLabel("신청번호 연결 동작").selectOption("release");
 await panel().getByLabel("번호 연결 담당자",{exact:true}).fill("해제 담당자");
 await panel().getByLabel("번호 연결 사유",{exact:true}).fill("합성 해제");
 await consent().check();await save();
 saved=await live(first);assert.equal(saved.applicationNumberBindings.records.length,3);assert.equal(saved.applicationNumberBindings.records[2].command.operation,"release");
 record("real correction and release append history without changing earlier commands");

 mode="after";await fill("SYN-003");
 await panel().getByRole("button",{name:"수동 연결 보관",exact:true}).click();
 await panel().getByText("원래 요청 결과 확인 필요 · 자동 재전송하지 않습니다.",{exact:true}).waitFor();
 const original=writes.at(-1),count=writes.length;
 assert.equal((await live(first)).applicationNumberBindings.records.length,4);
 const beforeRestart=rows();mode="normal";await stop();await start();await openCompany(first);
 await panel().getByText("원래 요청의 저장 기록을 확인했습니다. 현재 연결과 당시 기록은 다를 수 있습니다.",{exact:true}).waitFor();
 assert.equal(writes.length,count);assert.deepEqual(rows(),beforeRestart);
 assert.equal(await page.evaluate(id=>localStorage.getItem("venturepass:application-number:v1:"+id),first.id),null);
 assert.deepEqual((await live(first)).applicationNumberBindings.records[3].command,original);
 record("COMMIT response and following read loss recover after server/page restart using GET only and the exact original command");

 mode="before";await fill("SYN-NOT-SAVED");await panel().getByRole("button",{name:"수동 연결 보관",exact:true}).click();
 await panel().getByText("원래 요청 결과 확인 필요 · 자동 재전송하지 않습니다.",{exact:true}).waitFor();
 await panel().getByRole("button",{name:"이전 요청 종료 가능 여부 확인",exact:true}).click();
 await panel().getByText("아직 저장되지 않았다고 확정할 수 없어 요청을 유지합니다.",{exact:true}).waitFor();
 assert.equal(await panel().getByRole("button",{name:"저장되지 않은 이전 요청 종료",exact:true}).count(),0);
 mode="normal";await separateWrite("OTHER-1");
 await panel().getByRole("button",{name:"이전 요청 종료 가능 여부 확인",exact:true}).click();
 await panel().getByRole("checkbox",{name:"이전 요청만 종료하겠습니다.",exact:true}).check();
 await separateWrite("OTHER-2");await panel().getByRole("button",{name:"저장되지 않은 이전 요청 종료",exact:true}).click();
 await panel().getByRole("alert").first().waitFor();
 assert.ok(await page.evaluate(id=>localStorage.getItem("venturepass:application-number:v1:"+id),first.id));
 await panel().getByRole("button",{name:"이전 요청 종료 가능 여부 확인",exact:true}).click();
 await panel().getByRole("checkbox",{name:"이전 요청만 종료하겠습니다.",exact:true}).check();
 const beforeClose=rows();await panel().getByRole("button",{name:"저장되지 않은 이전 요청 종료",exact:true}).evaluate(e=>{e.click();e.click();});
 await panel().getByText("저장되지 않은 이전 요청을 이 브라우저에서 종료했습니다.",{exact:true}).waitFor();
 assert.deepEqual(rows(),beforeClose);assert.equal(await page.evaluate(id=>localStorage.getItem("venturepass:application-number:v1:"+id),first.id),null);
 record("pre-send loss stays unknown at same revision; stale closure rechecks and refuses later changes then clears only browser journal");

 await fill("LONG-"+ "A".repeat(150),"<img src=x onerror=alert(1)>\n"+"긴 수동 사유 ".repeat(90));
 dialogAnswer="dismiss";await panel().getByRole("button",{name:"닫기",exact:true}).click();assert.ok((await panel().getByLabel("번호 연결 사유",{exact:true}).inputValue()).includes("<img"));
 dialogAnswer="accept";await page.setViewportSize({width:390,height:900});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await panel().screenshot({path:path.join(output,"number-390.png")});
 await panel().getByRole("button",{name:"입력 취소",exact:true}).click();
 assert.equal(await panel().getByLabel("수동 신청번호",{exact:true}).inputValue(),"");
 record("close cancellation preserves draft; explicit cancel clears only draft; long inert text fits 390px");

 await page.setViewportSize({width:1100,height:1000});
 let entered=new Promise(resolve=>{readStarted=resolve;});mode="hold";
 await panel().getByRole("button",{name:"저장된 연결 다시 조회",exact:true}).click();await entered;
 await page.getByRole("button",{name:"전체 기업",exact:true}).click();
 await page.getByRole("button").filter({hasText:second.profile.companyName}).first().click();
 releaseRead();mode="normal";
 await page.getByRole("button",{name:"간단 화면",exact:true}).click();
 await page.getByRole("navigation",{name:"신청 준비 3단계"}).getByRole("button",{name:"신청·진행"}).click();
 await page.getByText("신청 이력·보완·공식 연결",{exact:true}).click();
 await page.getByRole("button",{name:"기관 안내와 진행 기록",exact:true}).click();
 await page.getByRole("button",{name:"신청번호 수동 연결·정정",exact:true}).click();
 await panel().getByText(second.profile.companyName+" · 현재 회사 버전 "+second.revision,{exact:true}).waitFor();
 assert.equal(await panel().getByText("SYN-003",{exact:true}).count(),0);
 assert.deepEqual(await live(second),untouchedSecond);assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 const last=await live(first);assert.equal(last.applicationNumberBindings.records.length,6);
 assert.deepEqual(last.plans,first.plans);assert.deepEqual(last.sources,first.sources);assert.deepEqual(last.agencyRecords,first.agencyRecords);
 record("late read after company switch cannot replace another company; all prior manuscript/source/manual agency contents stay unchanged");
 await writeFile(path.join(output,"report.json"),JSON.stringify({buildId,checks,syntheticCases:2,uiPatchRequests:writes.length,isolatedOtherWrites:2,readRequests:reads,dialogs,actualExternal:0,actualAi:0,errors},null,2));
 console.log(JSON.stringify({output,buildId,checks:checks.length}));
}catch(error){
 if(page){await page.screenshot({path:path.join(output,"failure.png"),fullPage:true}).catch(()=>{});console.error((await page.locator("body").innerText().catch(()=>"")).slice(-10000));}
 console.error(JSON.stringify({checks,errors}));throw error;
}finally{await context?.close();await stop();await writeFile(path.join(output,"server.log"),logs.join(""));}
