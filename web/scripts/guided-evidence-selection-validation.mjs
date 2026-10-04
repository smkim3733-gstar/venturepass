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
  "Usage: node scripts/guided-evidence-selection-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-evidence-selection-"));
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
  if(name==="company_analysis")content={summary:"선택 자료의 합성 분석",facts:[],candidates:[candidate],questions:[],warnings:[]};
  else if(name==="business_plan")content={title:"합성 선택 근거 계획서",summary:"사실 확인이 필요한 초안",sections:value.sectionDefinitions.map(section=>({key:section.key,title:section.title,content:"선택 자료에 기반한 합성 계획입니다. [확인 필요] 시험 자료를 보완해야 합니다.",evidence,needsConfirmation:true})),actionItems:["시험 자료 확인"],interviewQuestions:["시험 자료가 있나요?"]};
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
let caseId;
const sdkCalls = () =>
  logs
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("SDK_MOCK_REQUEST "))
    .map((line) => JSON.parse(line.slice("SDK_MOCK_REQUEST ".length)));
const previewRequests = [],
  executions = [];
let failPreview = false,
  holdPreview = false,
  releasePreview,
  previewHeld = false,
  loseExecution = false;
const selection = () => page.getByRole("dialog", { name: "AI에 사용할 자료 선택", exact: true });
const approval = () => page.getByRole("dialog", { name: /이 자료로 AI/ });
const overview = () => page.getByRole("region", { name: "자료와 AI 입력 현황", exact: true });
async function snapshot() {
  return (await api("/api/studio/cases/" + caseId)).json();
}
async function reopen(label = name) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: label }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "자료 올리기" })
    .click();
  await overview().waitFor();
}
async function openSelection() {
  await overview().getByRole("button", { name: "AI에 사용할 자료 선택", exact: true }).click();
  await selection().waitFor();
}
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
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1360, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      externalRequests.push(request.url());
      return route.abort();
    }
    if (url.pathname.endsWith("/guided-preparation/preview")) {
      previewRequests.push(request.postDataJSON());
      if (failPreview) {
        failPreview = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "synthetic offline" }),
        });
      }
      if (holdPreview) {
        holdPreview = false;
        previewHeld = true;
        await new Promise((resolve) => {
          releasePreview = resolve;
        });
      }
    }
    if (url.pathname.endsWith("/guided-preparation") && request.method() === "POST") {
      executions.push(request.postDataJSON());
      if (loseExecution) {
        loseExecution = false;
        const response = await route.fetch();
        assert.ok(response.ok());
        return route.abort();
      }
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  caseId = (
    await mutation(() =>
      page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
    )
  ).id;
  let c = await snapshot();
  c = await (
    await api("/api/studio/cases/" + caseId, {
      method: "PATCH",
      data: {
        action: "profile",
        revision: c.revision,
        profile: {
          ...c.profile,
          technologySummary: "합성 센서 분석 설명입니다. 실제 실적은 미확인입니다.",
        },
      },
    })
  ).json();
  await reopen();
  await openSelection();
  assert.match(await selection().innerText(), /선택 0개/);
  await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).click();
  await approval().waitFor();
  assert.match(await approval().innerText(), /전송할 자료 0개/);
  await approval().getByRole("button", { name: "지금은 자료만 보관" }).click();
  assert.equal(executions.length, 0);
  assert.equal(sdkCalls().length, 0);
  record("zero attachments: description-only preview is separate from execution consent");
  const upload = page.getByRole("region", { name: "자료 업로드와 이어 올리기", exact: true });
  await upload.locator('input[type="file"]').setInputFiles([
    { name: "unread.pdf", mimeType: "application/pdf", buffer: pdf("Synthetic unread") },
    {
      name: "unadopted.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await docx(1),
    },
  ]);
  await upload.getByRole("button", { name: "선택 목록 마치기", exact: true }).click();
  c = await snapshot();
  c = await addSource(c, "선택 근거.pdf", "SELECTED-BODY 합성 근거입니다.");
  c = await addSource(c, "제외 근거.docx", "EXCLUDED-BODY 선택하지 않은 합성 근거입니다.");
  const sourceBytes = JSON.stringify(c.sources);
  await reopen();
  await openSelection();
  assert.equal(await selection().getByRole("checkbox").count(), 4);
  assert.equal(
    await selection()
      .getByRole("checkbox", { name: /unread.pdf/ })
      .isDisabled(),
    true,
  );
  assert.equal(
    await selection()
      .getByRole("checkbox", { name: /unadopted.docx/ })
      .isDisabled(),
    true,
  );
  await selection()
    .getByRole("checkbox", { name: /제외 근거.docx/ })
    .uncheck();
  failPreview = true;
  await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).click();
  await selection().getByRole("alert").waitFor();
  assert.equal(
    await selection()
      .getByRole("checkbox", { name: /제외 근거.docx/ })
      .isChecked(),
    false,
  );
  assert.equal(executions.length, 0);
  await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).click();
  await approval().waitFor();
  await approval().getByText("전송할 자료 1개 확인", { exact: true }).click();
  assert.match(await approval().innerText(), /선택 근거.pdf/);
  assert.doesNotMatch(await approval().innerText(), /제외 근거.docx/);
  await approval().getByRole("button", { name: "자료 선택 바꾸기", exact: true }).click();
  await selection().waitFor();
  assert.equal(await approval().count(), 0);
  await selection().getByRole("button", { name: "회사 설명만 사용", exact: true }).click();
  assert.match(await selection().innerText(), /선택 0개/);
  await selection()
    .getByRole("checkbox", { name: /선택 근거.pdf/ })
    .check();
  record(
    "PDF/Word originals are disabled; partial selection, failed preview retry, and consent invalidation preserve sources",
  );
  holdPreview = true;
  const beforeHeld = previewRequests.length;
  await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  for (let i = 0; i < 40 && !previewHeld; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(previewHeld);
  assert.equal(previewRequests.length, beforeHeld + 1);
  await selection().getByRole("button", { name: "닫기", exact: true }).click();
  releasePreview();
  await page.waitForLoadState("networkidle");
  assert.equal(await approval().count(), 0);
  assert.equal(executions.length, 0);
  record("duplicate preview clicks create one read; closing invalidates its late response");
  await openSelection();
  await selection()
    .getByRole("checkbox", { name: /제외 근거.docx/ })
    .uncheck();
  await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).click();
  await approval().waitFor();
  loseExecution = true;
  await approval().getByRole("button", { name: "허용하고 AI 준비 시작", exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.getByRole("button", { name: "저장 상태 확인", exact: true }).waitFor();
  assert.equal(sdkCalls().length, 1);
  assert.equal((await snapshot()).guidedPreparationRuns.at(-1).status, "awaiting_choice");
  await page.getByRole("button", { name: "저장 상태 확인", exact: true }).click();
  await page.locator("#guided-choice-reason").fill("선택한 근거에 맞는 합성 검토 주제입니다.");
  await page.getByRole("button", { name: "이 주제로 작성", exact: true }).click();
  await page.getByText("합성 선택 근거 계획서", { exact: true }).first().waitFor();
  c = await snapshot();
  assert.equal(c.guidedPreparationRuns.at(-1).status, "awaiting_review");
  assert.equal(c.plans.length, 1);
  assert.equal(c.plans[0].confirmedAt, null);
  assert.equal(JSON.stringify(c.sources), sourceBytes);
  assert.equal(sdkCalls().length, 3);
  assert.equal(executions.length, 2);
  for (const call of sdkCalls()) {
    assert.ok(call.value.sources.length === 1);
    assert.match(JSON.stringify(call.value), /SELECTED-BODY/);
    assert.doesNotMatch(JSON.stringify(call.value), /EXCLUDED-BODY|제외 근거.docx/);
    assert.equal(call.value.unextractedSourceCount, 2);
  }
  record(
    "real UI/API/SQLite plus mocked SDK: lost analysis acknowledgment recovers by reads; selected analysis/plan/review only",
  );
  const originalRun = JSON.stringify(c.guidedPreparationRuns),
    before = executions.length;
  await reopen();
  await openSelection();
  assert.equal(
    await selection()
      .getByRole("checkbox", { name: /선택 근거.pdf/ })
      .isChecked(),
    true,
  );
  assert.equal(
    await selection()
      .getByRole("checkbox", { name: /제외 근거.docx/ })
      .isChecked(),
    false,
  );
  await selection().getByRole("button", { name: "닫기", exact: true }).click();
  assert.equal(executions.length, before);
  assert.equal(JSON.stringify((await snapshot()).guidedPreparationRuns), originalRun);
  record(
    "reload restores durable selected scope with read-only preview; no automatic execution or approval rewrite",
  );
  const originalCase = caseId;
  let many = await (
    await api("/api/studio/cases", {
      method: "POST",
      data: { profile: { ...c.profile, companyName: "합성 100개 선택" } },
    })
  ).json();
  caseId = many.id;
  for (let i = 0; i < 100; i++) many = await addSource(many, "장문 " + (i + 1), '"'.repeat(1250));
  const manyBytes = JSON.stringify(many);
  await reopen("합성 100개 선택");
  await openSelection();
  assert.equal(await selection().getByRole("checkbox").count(), 100);
  assert.equal(
    await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).isDisabled(),
    true,
  );
  await selection().getByRole("button", { name: "회사 설명만 사용", exact: true }).click();
  await selection()
    .getByRole("checkbox", { name: /^장문 100/ })
    .check();
  assert.equal(
    await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).isDisabled(),
    false,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "selection-mobile.png"), fullPage: true });
  await selection().getByRole("button", { name: "선택 범위 확인", exact: true }).click();
  await approval().waitFor();
  assert.match(await approval().innerText(), /전송할 자료 1개/);
  await approval().getByRole("button", { name: "지금은 자료만 보관", exact: true }).click();
  assert.equal(JSON.stringify(await snapshot()), manyBytes);
  record(
    "100 full bodies exceed input cap; choosing one reduces actual preview without truncation or storage edits; 390px no overflow",
  );
  caseId = originalCase;
  await reopen();
  await openSelection();
  assert.match(await selection().innerText(), /선택 1개/);
  assert.equal(await selection().getByRole("checkbox").count(), 4);
  assert.equal(sdkCalls().length, 3);
  assert.equal(executions.length, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record(
    "company switching isolates selection; no customer data or external network; synthetic SDK calls exactly three",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        previewRequests,
        executions: executions.map((x) => ({
          action: x.action,
          clientRequestId: x.clientRequestId,
          sourceIds: x.approval?.sourceIds,
        })),
        mockSdkCalls: sdkCalls().map((x) => ({
          name: x.name,
          sourceIds: x.value.sources.map((s) => s.sourceId),
        })),
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
      ).slice(0, 4500),
    );
  }
  throw error;
} finally {
  releasePreview?.();
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
