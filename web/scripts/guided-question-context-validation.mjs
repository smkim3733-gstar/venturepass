import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// This acceptance run uses the actual production UI/API and a new synthetic data directory.
// The explicit build must be a current, environment-free build:local staging directory.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/guided-question-context-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-question-context-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
 const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
 if(url.href === "https://api.openai.com/v1/responses") {
  const request=JSON.parse(init?.body ?? await input.clone().text());
  const name=request.text.format.name, value=JSON.parse(request.input.find(item=>item.role==="user").content);
  process.stdout.write("SDK_MOCK_REQUEST "+JSON.stringify({name,value})+"\n");
  const evidence=value.sources.length?[{sourceId:value.sources[0].sourceId,quote:value.sources[0].text.slice(0,100),locator:"본문"}]:[{sourceId:"profile",quote:value.profile.technologySummary,locator:"technologySummary"}];
  const candidate={id:"synthetic-selected-topic",classification:"current",title:"합성 센서 분석",problem:"관찰 시간 단축 검토",solution:"합성 센서 데이터 분석",targetCustomer:"합성 시험 고객",differentiation:"차별성 확인 필요",stage:"검토 단계",businessModel:"검토할 계획",recommendation:"선택 자료에 근거한 후보",evidence,gaps:["시험 자료 확인 필요"]};
  let content;
  if(name==="company_analysis")content={summary:"선택 자료의 합성 분석",facts:[],candidates:[candidate],questions:[{id:"q1",question:"시험 자료가 있나요?",reason:"시험 범위 확인",priority:"high"},{id:"q2",question:"개발을 완료한 범위는?",reason:"계획과 완료 구분",priority:"high"},{id:"q3",question:"현재 자금 확보 상황은?",reason:"확정 여부 확인",priority:"medium"},{id:"q4",question:"고객 확인은 언제 했나요?",reason:"기준 시점 확인",priority:"medium"}],warnings:[]};
  else if(name==="business_plan")content={title:"합성 선택 근거 계획서",summary:"사실 확인이 필요한 초안",sections:value.sectionDefinitions.map(section=>({key:section.key,title:section.title,content:"선택 자료에 기반한 합성 계획입니다. [확인 필요] 시험 자료를 보완해야 합니다.",evidence,needsConfirmation:true})),actionItems:["시험 자료 확인"],interviewQuestions:["시험 자료가 있나요?","비교 대상은 무엇인가요?"]};
  else if(name==="business_plan_review")content={findings:[]};
  else throw Error("Unexpected synthetic SDK stage");
  return new Response(JSON.stringify({id:"resp_synthetic_"+name,object:"response",created_at:1,status:"completed",model:request.model,output:[{id:"msg_synthetic",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(content),annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}),{status:200,headers:{"content-type":"application/json"}});
 }
 if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  process.stderr.write("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED\n");throw Error("External fetch disabled");
 }
 return original(input, init);
};`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
environment.OPENAI_API_KEY = "synthetic-sdk-boundary-never-sent";
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

function pdf(text) {
  const stream = text ? "BT /F1 12 Tf 40 200 Td (" + text + ") Tj ET" : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += index + 1 + " 0 obj\n" + value + "\nendobj\n";
  }
  const xref = Buffer.byteLength(result);
  result += "xref\n0 " + offsets.length + "\n0000000000 65535 f \n";
  result += offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
    .join("");
  result +=
    "trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return Buffer.from(result);
}
async function docx(index) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>합성 워드 시험 ' +
      index +
      " 실제 고객 자료가 아닙니다.</w:t></w:r></w:p></w:body></w:document>",
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const name = "합성 선택 근거 화면";
async function addSource(c, label, text) {
  const at = new Date().toISOString();
  return (
    await api("/api/studio/cases/" + c.id, {
      method: "PATCH",
      data: {
        action: "source",
        revision: c.revision,
        source: {
          id: randomUUID(),
          name: label,
          kind: "technology",
          text,
          originalName: null,
          mimeType: null,
          extraction: "manual",
          warnings: [],
          createdAt: at,
          updatedAt: at,
        },
      },
    })
  ).json();
}
let caseId;
const writes = [],
  executions = [];
const sdkCalls = () =>
  logs
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("SDK_MOCK_REQUEST "))
    .map((line) => JSON.parse(line.slice("SDK_MOCK_REQUEST ".length)));
async function snapshot() {
  return (await api("/api/studio/cases/" + caseId)).json();
}
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
}
const stage = (label) =>
  page.getByRole("navigation", { name: "신청 준비 3단계" }).getByRole("button", { name: label });
const question = (i) => page.locator("#guided-answer-" + i).locator("..");
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1360, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      externalRequests.push(req.url());
      return route.abort();
    }
    if (req.method() === "PATCH") writes.push(req.postDataJSON());
    if (url.pathname.endsWith("/guided-preparation") && req.method() === "POST")
      executions.push(req.postDataJSON());
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
  let c = await snapshot();
  c = await addSource(c, "합성 근거 메모", "SELECTED-BODY 합성 시험 계획이며 미확인 내용입니다.");
  await reopen();
  await stage("자료 올리기").click();
  const upload = page.getByRole("region", { name: "자료 업로드와 이어 올리기", exact: true });
  await page.waitForFunction(() => {
    const input = document.querySelector('input[type="file"]');
    return input && !input.disabled;
  });
  await upload.locator('input[type="file"]').setInputFiles([
    { name: "시험 원본.pdf", mimeType: "application/pdf", buffer: pdf("Synthetic test") },
    {
      name: "자금 메모.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await docx(1),
    },
  ]);
  await upload.getByRole("button", { name: "선택 목록 마치기", exact: true }).click();
  await page.getByRole("button", { name: "AI에 사용할 자료 선택", exact: true }).click();
  await page
    .getByRole("dialog", { name: "AI에 사용할 자료 선택", exact: true })
    .getByRole("button", { name: "선택 범위 확인", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /이 자료로 AI/ })
    .getByRole("button", { name: "허용하고 AI 준비 시작", exact: true })
    .click();
  await page.locator("#guided-choice-reason").fill("합성 근거에 따른 준비 주제입니다.");
  await page.getByRole("button", { name: "이 주제로 작성", exact: true }).click();
  const overview = page.getByRole("region", { name: "우선 보완 질문", exact: true });
  await overview.waitFor();
  c = await snapshot();
  const editable = c.plans.at(-1);
  await api("/api/studio/cases/" + caseId, {
    method: "PATCH",
    data: {
      action: "save-plan",
      revision: c.revision,
      planId: editable.id,
      content: {
        ...editable.content,
        sections: editable.content.sections.map((section, i) =>
          i === 0
            ? { ...section, content: section.content + " 담당자가 직접 고친 합성 문장입니다." }
            : section,
        ),
      },
    },
  });
  await reopen();
  await stage("AI 계획서").click();
  await overview.waitFor();
  assert.equal(await overview.locator("article").count(), 3);
  assert.match(await overview.innerText(), /시험 범위 확인/);
  c = await snapshot();
  const originalPlans = JSON.stringify(c.plans),
    originalRuns = JSON.stringify(c.guidedPreparationRuns),
    beforeSource = JSON.stringify(c.sources);
  assert.equal(sdkCalls().length, 3);
  assert.equal(c.guidedPreparationRuns.at(-1).status, "awaiting_review");
  await overview.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  assert.equal(await page.locator('textarea[id^="guided-answer-"]').count(), 3);
  await question(0).getByText("질문 출처 확인", { exact: true }).click();
  assert.match(await question(0).innerText(), /AI 분석 질문/);
  assert.match(await question(0).innerText(), /원고 v2/);
  await question(0).getByRole("combobox").selectOption("development");
  assert.match(await question(0).innerText(), /필수서류 목록은 아닙니다/);
  await question(0).getByText("보관 자료 연결 · 0개", { exact: true }).click();
  await question(0)
    .getByRole("checkbox", { name: /시험 원본.pdf/ })
    .check();
  await page.locator("#guided-answer-0").fill("아직 외부 시험 전입니다. 작은 범위만 검토했습니다.");
  await page.locator("#guided-answer-1").fill("실적이 아니라 앞으로의 계획입니다.");
  await page.getByRole("button", { name: /남은 질문 2개 더 보기/ }).click();
  assert.equal(await page.locator('textarea[id^="guided-answer-"]').count(), 5);
  await page.locator("#guided-answer-4").fill("확인 날짜는 담당자에게 물어볼 예정입니다.");
  record(
    "three priority questions, full list, original dual provenance, explicit section and unadopted file link",
  );
  await page.getByRole("button", { name: "지금은 없어요 · 나중에 답하기", exact: true }).click();
  assert.equal(JSON.stringify((await snapshot()).sources), beforeSource);
  await page.getByRole("button", { name: "보관한 답변 보기", exact: true }).click();
  assert.equal(
    await page.locator("#guided-answer-0").inputValue(),
    "아직 외부 시험 전입니다. 작은 범위만 검토했습니다.",
  );
  assert.equal(await question(0).getByRole("combobox").inputValue(), "development");
  await page.getByRole("button", { name: "파일을 추가하고 돌아오기", exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[type="file"]');
    return input && !input.disabled;
  });
  await upload
    .locator('input[type="file"]')
    .setInputFiles([
      { name: "추가 시험.pdf", mimeType: "application/pdf", buffer: pdf("Synthetic later") },
    ]);
  await upload.getByRole("button", { name: "선택 목록 마치기", exact: true }).click();
  await stage("AI 계획서").click();
  assert.equal(
    await page.locator("#guided-answer-0").inputValue(),
    "아직 외부 시험 전입니다. 작은 범위만 검토했습니다.",
  );
  assert.equal(
    await page.getByRole("button", { name: "답변 보관하기", exact: true }).isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "이전 질문·입력을 유지하고 현재 자료에 연결", exact: true })
    .click();
  await question(0).getByText("보관 자료 연결 · 1개", { exact: true }).click();
  await question(0)
    .getByRole("checkbox", { name: /추가 시험.pdf/ })
    .check();
  record(
    "deferral and PDF upload retain drafts; revision change blocks save until explicit rebind of original question context",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await question(0).screenshot({ path: path.join(output, "question-mobile.png") });
  const priorWrites = writes.filter((x) => x.action === "source").length;
  await page.getByRole("button", { name: "답변 보관하기", exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page
    .getByRole("status")
    .filter({ hasText: "보완 내용을 사용자 진술 자료로 보관했습니다" })
    .waitFor();
  c = await snapshot();
  const answer = c.sources.find((s) => s.name === "사업계획서 준비 답변");
  assert.ok(answer);
  assert.equal(writes.filter((x) => x.action === "source").length, priorWrites + 1);
  assert.match(answer.text, /아직 외부 시험 전/);
  assert.match(answer.text, /실적이 아니라 앞으로/);
  assert.match(answer.text, /확인 날짜는 담당자/);
  assert.match(answer.text, /사용자 지정/);
  assert.match(answer.text, /본문 판독·채택 전/);
  assert.match(answer.text, /추가 시험.pdf/);
  assert.match(answer.text, /원고에 자동 반영하지 않습니다/);
  assert.ok(answer.text.includes(c.plans.at(-1).id));
  assert.equal(JSON.stringify(c.plans), originalPlans);
  assert.equal(JSON.stringify(c.guidedPreparationRuns), originalRuns);
  assert.equal(sdkCalls().length, 3);
  assert.equal(executions.length, 2);
  assert.equal(c.sources.filter((s) => s.extraction === "pending").length, 3);
  record(
    "one source write preserves question/section/file identities and manual edits; no approval expansion, AI call, or plan rewrite",
  );
  const final = JSON.stringify(c);
  await reopen();
  assert.equal(JSON.stringify(await snapshot()), final);
  await stage("AI 계획서").click();
  await page
    .getByRole("region", { name: "우선 보완 질문", exact: true })
    .getByRole("button", { name: /답변·메모·보완 자료 연결/ })
    .click();
  await question(0).getByText("보관 자료 연결 · 0개", { exact: true }).click();
  await question(0)
    .getByRole("checkbox", { name: /자금 메모.docx/ })
    .check();
  assert.equal(await page.locator("#guided-answer-0").inputValue(), "");
  await page.getByRole("button", { name: "답변 보관하기", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "보완 내용을 사용자 진술 자료로 보관했습니다" })
    .waitFor();
  c = await snapshot();
  const onlyFiles = c.sources.filter((s) => s.name === "사업계획서 준비 답변");
  assert.equal(onlyFiles.length, 2);
  assert.ok(
    onlyFiles.some(
      (s) => s.text.includes("글 답변 없이 자료만 연결함") && s.text.includes("자금 메모.docx"),
    ),
  );
  assert.equal(JSON.stringify(c.plans), originalPlans);
  assert.equal(JSON.stringify(c.guidedPreparationRuns), originalRuns);
  assert.equal(sdkCalls().length, 3);
  record(
    "file-only supplementation is stored separately without marking its unread content or original manuscript verified",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record(
    "reload retains saved statement and original plan; 390px no overflow, external/customer/paid calls zero",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        mockSdkCalls: sdkCalls().length,
        executions: executions.length,
        sourceWrites: writes.filter((x) => x.action === "source").length,
        errors,
        externalRequests,
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
      ).slice(0, 7000),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
