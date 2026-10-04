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
  "Usage: node scripts/guided-public-evidence-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-public-evidence-"));
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
  else if(name==="one_section_supplement")content={content:value.section.content+"\n공개 자료의 기준 기간은 2023년이며 우리 회사 실적은 별도 확인해야 합니다.",addedEvidence:[{sourceId:value.sources[0].sourceId,start:0,end:value.sources[0].text.length,quote:value.sources[0].text}]};
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
const sourceRequests = [];
let sourceFailure = "",
  failSourceGet = false;

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
    }
    if (
      url.pathname === "/api/studio/cases/" + caseId &&
      req.method() === "PATCH" &&
      req.postDataJSON().action === "source"
    ) {
      sourceRequests.push(req.postDataJSON());
      if (sourceFailure === "after") {
        const response = await route.fetch();
        assert.ok(response.ok(), await response.text());
        sourceFailure = "";
        return route.abort("failed");
      }
      if (sourceFailure === "before") {
        sourceFailure = "";
        failSourceGet = true;
        return route.abort("failed");
      }
    }
    if (failSourceGet && url.pathname === "/api/studio/cases/" + caseId && req.method() === "GET") {
      failSourceGet = false;
      return route.abort("failed");
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
  const publicPanel = () => page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
  async function openPublic() {
    await reopen();
    await stage("AI 계획서").click();
    await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
    await publicPanel().waitFor();
  }
  async function fillPublic(title = "합성 공개 산업 자료") {
    await publicPanel().getByLabel("공개 자료 제목", { exact: true }).fill(title);
    await publicPanel()
      .getByLabel("원문 URL (HTTPS)", { exact: true })
      .fill("https://example.invalid/report");
    await publicPanel()
      .getByLabel("원문 발췌", { exact: false })
      .fill("  합성 산업 수치는 2023년 기준입니다.\n회사 실적 자료가 아닙니다.  ");
    await publicPanel()
      .getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true })
      .fill("2026-10-05");
    await publicPanel().getByLabel("보완할 항목", { exact: true }).selectOption("development");
  }
  await openPublic();
  assert.equal(
    await publicPanel().getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await publicPanel()
      .getByRole("button", { name: "공개 근거 후보 보관", exact: true })
      .isDisabled(),
    true,
  );
  await fillPublic();
  await publicPanel().getByText("발행일·기준 기간·관련성 기록", { exact: true }).click();
  await publicPanel().getByLabel("발행처 (모르면 비워 두기)", { exact: true }).fill("합성 발행처");
  await publicPanel()
    .getByLabel("발행일 (원문 표기, 모르면 비워 두기)", { exact: true })
    .fill("2024-06-01");
  await publicPanel()
    .getByLabel("자료의 기준 기간·대상 (모르면 비워 두기)", { exact: true })
    .fill("2023년 산업 전체");
  await publicPanel()
    .getByLabel("이 항목과 관련된 이유", { exact: true })
    .fill("담당자의 관련성 추정");
  await publicPanel().getByRole("checkbox").check();
  await publicPanel()
    .getByLabel("기존 자료와 다른 점·추가 확인 사항", { exact: true })
    .fill("회사 자료와 기준 기간이 다름");
  assert.equal(await publicPanel().getByRole("checkbox").isChecked(), false);
  assert.equal(sdkCalls().length, 3);
  assert.equal(sourceRequests.length, 0);
  assert.deepEqual(await snapshot(), c);
  record(
    "manual public provenance, empty read date, explicit storage consent reset and no fetch/write/AI on edit",
  );
  await publicPanel().getByRole("checkbox").check();
  sourceFailure = "after";
  await publicPanel()
    .getByRole("button", { name: "공개 근거 후보 보관", exact: true })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await publicPanel()
    .getByRole("status")
    .filter({ hasText: "공개 근거 후보를 보관했습니다" })
    .waitFor();
  const afterSave = await snapshot(),
    publicSource = afterSave.sources.at(-1);
  assert.equal(sourceRequests.length, 1);
  assert.equal(publicSource.id, sourceRequests[0].source.id);
  assert.equal(afterSave.sources.length, 3);
  assert.deepEqual(afterSave.sources.slice(0, 2), sourcesBefore);
  assert.deepEqual(
    afterSave.plans,
    plansBefore.map((p) => ({ ...p, confirmedAt: null })),
  );
  assert.deepEqual(afterSave.guidedPreparationRuns, runsBefore);
  for (const text of [
    "https://example.invalid/report",
    "2024-06-01",
    "2023년 산업 전체",
    "2026-10-05",
    "담당자의 관련성 추정",
    "회사 자료와 기준 기간이 다름",
    "  합성 산업 수치는 2023년 기준입니다.\n회사 실적 자료가 아닙니다.  ",
  ])
    assert.ok(publicSource.text.includes(text));
  assert.equal(sdkCalls().length, 3);
  assert.equal(commands.length, 0);
  record(
    "single source PATCH despite duplicate click, lost acknowledgement recovered by GET and exact original source ID",
  );
  await publicPanel()
    .getByRole("button", { name: "이 근거로 원고 보완 준비", exact: true })
    .click();
  await page.waitForFunction(() => {
    const f = document.querySelector('section[aria-label="한 항목 보완 수정안"] fieldset');
    return f && !f.disabled;
  });
  assert.equal(
    await panel()
      .getByLabel(/합성 공개 산업 자료/)
      .isChecked(),
    true,
  );
  assert.equal(
    await panel().getByLabel("수정할 항목", { exact: true }).inputValue(),
    "development",
  );
  assert.equal(commands.length, 0);
  await panel().getByRole("button", { name: "전송 범위 확인", exact: true }).click();
  const consent = panel().getByRole("region", { name: "수정안 전송 동의", exact: true });
  await consent.waitFor();
  await consent.getByText("전송할 정확한 내용 읽기").click();
  const exact = JSON.parse(await consent.locator("pre").innerText());
  assert.equal(exact.sources.length, 1);
  assert.equal(exact.sources[0].text, publicSource.text);
  assert.ok(!JSON.stringify(exact).includes("EXCLUDED_SUPPLEMENT_BODY"));
  assert.ok(!JSON.stringify(exact).includes("담당자가 직접 작성한 요약"));
  assert.equal(
    await consent.getByRole("button", { name: "동의하고 수정안 만들기", exact: true }).isDisabled(),
    true,
  );
  await consent.getByRole("checkbox").check();
  await consent.getByRole("button", { name: "동의하고 수정안 만들기", exact: true }).click();
  await panel().getByRole("button", { name: "현재 원고와 비교", exact: true }).click();
  const comparison = panel().getByRole("region", { name: "수정 전후 비교", exact: true });
  await comparison.waitFor();
  const calls = sdkCalls().filter((x) => x.name === "one_section_supplement");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].value, exact);
  assert.deepEqual((await snapshot()).plans, afterSave.plans);
  record(
    "exact selected public provenance in installed SDK mocked fetch, no excluded material or automatic execution",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await comparison.getByRole("checkbox").check();
  const adopted = await mutation(() =>
    comparison
      .getByRole("button", { name: "비교한 수정안을 새 버전으로 저장", exact: true })
      .click(),
  );
  assert.ok(adopted);
  await panel()
    .getByRole("status")
    .filter({ hasText: /새 버전 v/ })
    .waitFor();
  const final = await snapshot(),
    last = final.plans.at(-1),
    base = afterSave.plans.at(-1);
  assert.equal(final.plans.length, 3);
  assert.deepEqual(final.plans.slice(0, -1), afterSave.plans);
  assert.deepEqual(final.sources, afterSave.sources);
  assert.deepEqual(final.guidedPreparationRuns, runsBefore);
  assert.deepEqual(
    {
      ...last.content,
      sections: last.content.sections.map((s) =>
        s.key === "development" ? base.content.sections.find((old) => old.key === s.key) : s,
      ),
    },
    base.content,
  );
  assert.equal(last.confirmedAt, null);
  assert.equal(last.content.sections.find((s) => s.key === "development").needsConfirmation, true);
  record(
    "explicit comparison/adoption creates one manual version, preserves other content and original provenance, 390px layout",
  );
  await openPublic();
  await fillPublic("저장 전 중단 합성 후보");
  await publicPanel().getByRole("checkbox").check();
  sourceFailure = "before";
  await publicPanel().getByRole("button", { name: "공개 근거 후보 보관", exact: true }).click();
  await publicPanel().getByRole("alert").filter({ hasText: "저장 결과가 미확인" }).waitFor();
  assert.equal(sourceRequests.length, 2);
  assert.equal(
    await publicPanel().getByLabel("공개 자료 제목", { exact: true }).inputValue(),
    "저장 전 중단 합성 후보",
  );
  await publicPanel()
    .getByRole("button", { name: "이 자료의 저장 상태 확인", exact: true })
    .click();
  await publicPanel()
    .getByRole("alert")
    .filter({ hasText: "같은 자료의 저장을 확인하지 못했습니다" })
    .waitFor();
  assert.equal(sourceRequests.length, 2);
  assert.deepEqual(await snapshot(), final);
  page.once("dialog", (d) => d.dismiss());
  await publicPanel().getByRole("button", { name: "닫기", exact: true }).click();
  assert.equal(await publicPanel().count(), 1);
  page.once("dialog", (d) => d.accept());
  await publicPanel().getByRole("button", { name: "닫기", exact: true }).click();
  await publicPanel().waitFor({ state: "hidden" });
  record(
    "pre-write loss/read failure keeps original input, explicit inspect is GET only, no retry, close cancellation preserves draft",
  );
  await openPublic();
  await fillPublic("동시 편집 충돌 합성 후보");
  await publicPanel().getByRole("checkbox").check();
  const beforeConflict = await snapshot();
  await api("/api/studio/cases/" + caseId, {
    method: "PATCH",
    data: {
      action: "save-plan",
      revision: beforeConflict.revision,
      planId: beforeConflict.plans.at(-1).id,
      content: { ...beforeConflict.plans.at(-1).content, summary: "다른 화면의 나중 수동 편집" },
    },
  });
  const conflictSaved = await snapshot();
  await publicPanel().getByRole("button", { name: "공개 근거 후보 보관", exact: true }).click();
  await publicPanel().getByRole("alert").filter({ hasText: "저장 결과가 미확인" }).waitFor();
  assert.equal(sourceRequests.length, 3);
  assert.deepEqual(await snapshot(), conflictSaved);
  assert.equal(
    await publicPanel().getByLabel("공개 자료 제목", { exact: true }).inputValue(),
    "동시 편집 충돌 합성 후보",
  );
  assert.equal(sdkCalls().length, 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  page.once("dialog", (d) => d.accept());
  await publicPanel().getByRole("button", { name: "닫기", exact: true }).click();
  await stop();
  await start();
  await reopen();
  assert.deepEqual(await snapshot(), conflictSaved);
  assert.equal(sourceRequests.length, 3);
  record(
    "late manual edit rejects original CAS without rebase/retry; source and saved versions survive server/browser reload",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        caseId,
        sourceRequests: sourceRequests.length,
        savedPublicSources: 1,
        mockSdkCalls: sdkCalls().length,
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
