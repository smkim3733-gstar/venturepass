import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  "Usage: node scripts/guided-plan-supplement-closure-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-supplement-closure-"));
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
  else if(name==="one_section_supplement")content={content:value.section.content+"\n보완 자료에는 내부 시험만 진행했으며 외부 시험은 계획이라고 기록되어 있습니다.",addedEvidence:[{sourceId:value.sources[0].sourceId,start:0,end:value.sources[0].text.length,quote:value.sources[0].text}]};
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
const panel = () => page.getByRole("region", { name: "한 항목 보완 수정안", exact: true });
const commands = [];
let dropAdoption = false;
let loseExecution = false,
  loseAdoption = false;
async function openPanel() {
  await reopen();
  await stage("AI 계획서").click();
  await page.getByRole("button", { name: "보완 자료로 수정안 만들기", exact: true }).click();
  if (await pendingCommand()) {
    await panel()
      .getByRole("button", { name: "이 요청의 종료 가능 여부 확인", exact: true })
      .waitFor();
    return;
  }
  await page.waitForFunction(() => {
    const field = document.querySelector('section[aria-label="한 항목 보완 수정안"] fieldset');
    return field && !field.disabled;
  });
}

async function pendingCommand() {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`venturepass:plan-supplement:v1:${id}`);
    return raw ? JSON.parse(raw).command : null;
  }, caseId);
}
async function manualEdit(label) {
  const c = await snapshot();
  return (
    await api("/api/studio/cases/" + caseId, {
      method: "PATCH",
      data: {
        action: "save-plan",
        revision: c.revision,
        planId: c.plans.at(-1).id,
        content: { ...c.plans.at(-1).content, summary: label },
      },
    })
  ).json();
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const inspectButton = () =>
  panel().getByRole("button", { name: "이 요청의 종료 가능 여부 확인", exact: true });
const closeButton = () =>
  panel().getByRole("button", { name: "저장되지 않은 이전 요청 종료", exact: true });
const doubleClick = (locator) =>
  locator.evaluate((button) => {
    button.click();
    button.click();
  });

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
    if (url.pathname.includes("/plan-supplements/") && req.method() === "POST") {
      const command = req.postDataJSON();
      commands.push(command);
      if (dropAdoption && command.action === "adopt-section-supplement") {
        dropAdoption = false;
        return route.abort("failed");
      }
      if (
        (loseExecution && command.action === "propose-section") ||
        (loseAdoption && command.action === "adopt-section-supplement")
      ) {
        const response = await route.fetch();
        assert.ok(response.ok(), await response.text());
        loseExecution = false;
        loseAdoption = false;
        return route.abort("failed");
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
  c = await addSource(c, "보완 답변 메모", "내부 시험만 진행했습니다. 외부 시험은 계획입니다.");
  c = await addSource(c, "제외할 이전 메모", "EXCLUDED_SUPPLEMENT_BODY 이전 시점 자료입니다.");
  await reopen();
  await stage("자료 올리기").click();
  await page.getByRole("button", { name: "AI에 사용할 자료 선택", exact: true }).click();
  await page
    .getByRole("dialog", { name: "AI에 사용할 자료 선택", exact: true })
    .getByRole("button", { name: "선택 범위 확인", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: /이 자료로 AI/ })
    .getByRole("button", { name: "허용하고 AI 준비 시작", exact: true })
    .click();
  await page.locator("#guided-choice-reason").fill("합성 자료로 검증하는 주제입니다.");
  await page.getByRole("button", { name: "이 주제로 작성", exact: true }).click();
  await page.getByRole("region", { name: "우선 보완 질문", exact: true }).waitFor();
  c = await snapshot();
  await api("/api/studio/cases/" + caseId, {
    method: "PATCH",
    data: {
      action: "save-plan",
      revision: c.revision,
      planId: c.plans.at(-1).id,
      content: {
        ...c.plans.at(-1).content,
        summary: "담당자가 직접 작성한 요약을 보존합니다.",
        sections: c.plans
          .at(-1)
          .content.sections.map((section, i) =>
            i === 0 ? { ...section, content: "다른 항목의 수동 문장을 보존합니다." } : section,
          ),
      },
    },
  });
  c = await snapshot();
  const plansBefore = structuredClone(c.plans),
    sourcesBefore = structuredClone(c.sources),
    runsBefore = structuredClone(c.guidedPreparationRuns);
  const other = await (
    await api("/api/studio/cases", {
      method: "POST",
      data: { profile: { ...c.profile, companyName: "별도 합성 기업" } },
    })
  ).json();
  await openPanel();
  await panel()
    .getByLabel(/보완 답변 메모/)
    .check();
  await panel().getByRole("button", { name: "전송 범위 확인", exact: true }).click();
  const consent = panel().getByRole("region", { name: "수정안 전송 동의", exact: true });
  await consent.getByRole("checkbox").check();
  await consent.getByRole("button", { name: "동의하고 수정안 만들기", exact: true }).click();
  await panel().getByRole("button", { name: "현재 원고와 비교", exact: true }).click();
  const comparison = panel().getByRole("region", { name: "수정 전후 비교", exact: true });
  await comparison.getByRole("checkbox").check();
  dropAdoption = true;
  await comparison
    .getByRole("button", { name: "비교한 수정안을 새 버전으로 저장", exact: true })
    .click();
  await panel().getByRole("alert").waitFor();
  const originalCommand = await pendingCommand();
  assert.equal(originalCommand.action, "adopt-section-supplement");
  const originalCapture = (await snapshot()).planSupplementExecutions;
  const beforeUnknown = await snapshot();
  await inspectButton().click();
  await panel()
    .getByText(/이 요청이 저장되지 않았다고 확정할 수 없습니다/)
    .waitFor();
  assert.equal(await closeButton().count(), 0);
  assert.deepEqual(await pendingCommand(), originalCommand);
  assert.deepEqual(await snapshot(), beforeUnknown);
  record(
    "dropped adoption at the same revision remains uncertain; explicit inspection does not close, retry or write",
  );

  // An explicit retry keeps the original nonce. A manual save wins before it reaches CAS.
  const retrySeen = deferred(),
    retryRelease = deferred(),
    retryFinished = deferred();
  await page.route("**/plan-supplements/adoption", async (route) => {
    if (
      route.request().method() !== "POST" ||
      route.request().postDataJSON().action !== "adopt-section-supplement"
    )
      return route.fallback();
    commands.push(route.request().postDataJSON());
    retrySeen.resolve();
    await retryRelease.promise;
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 409);
      await route.fulfill({ response });
      retryFinished.resolve(null);
    } catch (error) {
      retryFinished.resolve(error);
    }
  });
  await panel().getByRole("button", { name: "원래 요청으로 이어가기", exact: true }).click();
  await retrySeen.promise;
  await manualEdit("늦은 수동 편집을 보존합니다.");
  retryRelease.resolve();
  assert.equal(await retryFinished.promise, null);
  await page.unroute("**/plan-supplements/adoption");
  await panel().getByRole("alert").waitFor();
  assert.deepEqual(await pendingCommand(), originalCommand);
  assert.deepEqual(
    commands.filter((c) => c.action === "adopt-section-supplement"),
    [originalCommand, originalCommand],
  );
  assert.deepEqual((await snapshot()).planSupplementExecutions, originalCapture);
  record(
    "late manual version wins CAS; original command rejection preserves pending identity and captured response",
  );

  await page.route("**/plan-supplements/adoption", (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().postDataJSON().action === "inspect-adoption"
    )
      return route.abort("failed");
    return route.fallback();
  });
  await inspectButton().click();
  await panel().getByRole("alert").waitFor();
  assert.equal(await closeButton().count(), 0);
  assert.deepEqual(await pendingCommand(), originalCommand);
  await page.unroute("**/plan-supplements/adoption");
  environment.OPENAI_API_KEY = "";
  environment.OPENAI_MODEL = "changed-model";
  await stop();
  await start();
  const beforeReload = commands.length;
  await openPanel();
  assert.equal(commands.length, beforeReload);
  assert.deepEqual(await pendingCommand(), originalCommand);
  record(
    "failed inspection keeps the request; keyless server and page restart use GET only without inventing closure",
  );

  const seen = deferred(),
    release = deferred(),
    finished = deferred();
  await page.route("**/plan-supplements/adoption", async (route) => {
    if (
      route.request().method() !== "POST" ||
      route.request().postDataJSON().action !== "inspect-adoption"
    )
      return route.fallback();
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    assert.ok(response.ok());
    seen.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
      finished.resolve(null);
    } catch (error) {
      finished.resolve(error);
    }
  });
  await inspectButton().click();
  await seen.promise;
  assert.equal(
    await page.getByRole("button", { name: "기업 목록", exact: true }).isDisabled(),
    true,
  );
  await panel().getByRole("button", { name: "계획서로 돌아가기", exact: true }).click();
  await page.getByRole("button", { name: "기업 목록", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "별도 합성 기업" }).first().click();
  release.resolve();
  assert.equal(await finished.promise, null);
  await page.unroute("**/plan-supplements/adoption");
  assert.equal(await panel().count(), 0);
  assert.equal(await page.getByText(/이 요청으로 저장된 버전은 없습니다/).count(), 0);
  assert.deepEqual(await (await api("/api/studio/cases/" + other.id)).json(), other);
  assert.deepEqual(await pendingCommand(), originalCommand);
  record(
    "closing then switching companies ignores a late closure inspection and preserves both company identities",
  );

  await openPanel();
  const beforeInspect = commands.filter((c) => c.action === "inspect-adoption").length;
  await doubleClick(inspectButton());
  await closeButton().waitFor();
  assert.equal(commands.filter((c) => c.action === "inspect-adoption").length, beforeInspect + 1);
  assert.equal(await closeButton().isDisabled(), true);
  await manualEdit("종료 확인을 연 뒤 추가한 수동 편집도 보존합니다.");
  await panel()
    .getByRole("checkbox", { name: "저장되지 않은 이 요청의 대기를 종료하겠습니다." })
    .check();
  await closeButton().click();
  await panel().getByRole("alert").waitFor();
  assert.deepEqual(await pendingCommand(), originalCommand);
  record(
    "a second manual edit invalidates the displayed closure proof; fresh explicit inspection is required",
  );

  await inspectButton().click();
  await closeButton().waitFor();
  assert.equal(await closeButton().isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel()
    .getByRole("checkbox", { name: "저장되지 않은 이 요청의 대기를 종료하겠습니다." })
    .check();
  const beforeClose = await snapshot(),
    inspections = commands.filter((c) => c.action === "inspect-adoption").length;
  await doubleClick(closeButton());
  await panel()
    .getByText(
      "저장되지 않은 이전 요청의 대기를 종료했습니다. 보관한 원고와 수정안은 그대로입니다.",
      { exact: true },
    )
    .waitFor();
  assert.equal(commands.filter((c) => c.action === "inspect-adoption").length, inspections + 1);
  assert.equal(await pendingCommand(), null);
  assert.deepEqual(await snapshot(), beforeClose);
  assert.deepEqual(beforeClose.plans.slice(0, plansBefore.length), plansBefore);
  assert.deepEqual(beforeClose.sources, sourcesBefore);
  assert.deepEqual(beforeClose.guidedPreparationRuns, runsBefore);
  assert.deepEqual(beforeClose.planSupplementExecutions, originalCapture);
  assert.equal(beforeClose.planSupplementAdoptions?.length ?? 0, 0);
  assert.equal(beforeClose.plans.length, plansBefore.length + 2);
  assert.equal(sdkCalls().filter((c) => c.name === "one_section_supplement").length, 1);
  await openPanel();
  assert.equal(await pendingCommand(), null);
  assert.deepEqual(await snapshot(), beforeClose);
  record(
    "explicit closure rechecks once, removes browser pending only and preserves manual versions, sources, capture and original plans",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record("390px no overflow; no page errors, external requests, customer data or real AI calls");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        mockSdkCalls: sdkCalls().length,
        supplementRequests: commands.filter((item) => item.action === "propose-section").length,
        adoptionRequests: commands.filter((item) => item.action === "adopt-section-supplement")
          .length,
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
