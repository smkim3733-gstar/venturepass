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

// Actual app UI; all business APIs are fulfilled with synthetic, in-memory state.
// No server business route, SQL, SDK, key, customer record or external service is used.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/plan-supplement-panel.tsx",
  "src/components/studio/guided-answer-supplement.ts",
  "scripts/fixtures/guided-answer-workflow.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-answer-ui-"));
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`
globalThis.fetch=async(input)=>{
 const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);
 if(url.href==="https://registry.npmjs.org/-/package/next/dist-tags")return new Response(null,{status:503});
 process.stderr.write("FORBIDDEN_SERVER_FETCH\n");throw Error("Server fetch forbidden");
};
`,
);
const environment = localBuildEnvironment(output);
for (const key of Object.keys(environment))
  if (/OPENAI|KOSIS|API_KEY|TOKEN|SECRET/i.test(key)) delete environment[key];
environment.NODE_ENV = serverMode === "dev" ? "development" : "production";
environment.VENTURE_DATA_DIR = path.join(output, "unused-data");
delete environment.NODE_OPTIONS;
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = "http://127.0.0.1:" + port;
const requireVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "scripts/fixtures/guided-answer-workflow.ts"),
  cwd: app,
  platform: "browser",
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      resolveId(source) {
        if (
          /openai|server-only|node:|storage|provider-production|configuration-current/.test(source)
        )
          throw Error("Forbidden fixture import");
        return null;
      },
    },
  ],
});
let fixture;
try {
  const generated = await bundle.generate({ format: "esm" });
  assert.equal(generated.output.length, 1);
  const chunk = generated.output[0];
  assert.equal(chunk.type, "chunk");
  assert.deepEqual(chunk.imports, []);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
let company = fixture.answerWorkflowCompany();
const initialPlan = structuredClone(company.plans),
  name = company.profile.companyName,
  caseId = company.id;
const commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
let child,
  context,
  page,
  saveMode = "normal";
async function start() {
  child = spawn(
    process.execPath,
    [
      "--max-old-space-size=3072",
      "--import",
      pathToFileURL(guard).href,
      path.join(staging, "node_modules/next/dist/bin/next"),
      serverMode,
      ...(serverMode === "dev" ? ["--webpack"] : []),
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: staging, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.on("data", (b) => logs.push(b.toString()));
  child.stderr.on("data", (b) => logs.push(b.toString()));
  let startupError;
  child.once("error", (e) => {
    startupError = e;
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error("Child stopped");
    if (logs.join("").includes("Ready in")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Ready timeout");
}
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
}
async function answer(text, section) {
  await page.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  await page.getByLabel(fixture.answerQuestion, { exact: true }).fill(text);
  if (section)
    await page
      .getByRole("combobox", { name: /관련 계획서 항목/ })
      .nth(1)
      .selectOption(section);
  await page.getByRole("button", { name: "답변 보관하기", exact: true }).click();
}
const handoff = () => page.getByRole("region", { name: "저장한 답변으로 원고 보완", exact: true });
const panel = () => page.getByRole("region", { name: "한 항목 보완 수정안", exact: true });
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1280, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin !== origin) {
      unexpected.push("external");
      return route.abort();
    }
    const reply = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const root = "/api/studio/cases/" + caseId;
    if (req.method() === "GET") {
      if (u.pathname === "/api/studio/status")
        return reply({
          aiConfigured: false,
          model: "synthetic-disabled",
          storage: "local",
          supportedFiles: [],
        });
      if (u.pathname === "/api/studio/cases")
        return reply({
          cases: [
            {
              id: caseId,
              companyName: name,
              industry: "",
              stage: "preparing",
              revision: company.revision,
              createdAt: company.createdAt,
              updatedAt: company.updatedAt,
              sourceCount: company.sources.length,
              planCount: company.plans.length,
              pendingTaskCount: 0,
            },
          ],
        });
      if (u.pathname === root) return reply(company);
      if (u.pathname === root + "/source-intakes") return reply({ company, activeItemIds: [] });
      if (u.pathname === root + "/guided-preparation")
        return reply({
          company,
          active: false,
          aiConfigured: false,
          approval: {
            caseId,
            revision: company.revision,
            provider: "OpenAI",
            model: "synthetic-disabled",
            inputFingerprint: "a".repeat(64),
            sourceIds: company.sources.map((s) => s.id),
            sourceNames: company.sources.map((s) => s.name),
            profileIncluded: true,
            businessNumberIncluded: false,
            originalFilesIncluded: false,
            derivedDraftIncluded: true,
            purpose: "analysis-plan-review",
          },
        });
      if (u.pathname === root + "/plan-supplements/execution")
        return reply({
          company,
          active: false,
          retainedCapture: false,
          executions: [],
          transmissionAllowed: false,
        });
    }
    if (req.method() === "PATCH" && u.pathname === root) {
      const command = req.postDataJSON();
      commands.push(command);
      assert.equal(command.revision, company.revision);
      if (command.action === "source") {
        if (saveMode === "missing") return reply({ ...company, revision: company.revision + 1 });
        company = {
          ...company,
          revision: company.revision + 1,
          sources: [
            ...company.sources,
            {
              ...command.source,
              createdAt: "2026-10-09T01:00:00.000Z",
              updatedAt: "2026-10-09T01:00:00.000Z",
            },
          ],
        };
        return reply(company);
      }
      if (command.action === "save-plan") {
        const plan = company.plans.at(-1);
        company = {
          ...company,
          revision: company.revision + 1,
          plans: [
            ...company.plans,
            {
              ...plan,
              id: "a0000000-0000-4000-8000-000000000002",
              version: plan.version + 1,
              mode: "manual",
              content: command.content,
              confirmedAt: null,
            },
          ],
        };
        return reply(company);
      }
    }
    if (req.method() === "POST" && u.pathname === root + "/plan-supplements/execution") {
      const command = req.postDataJSON();
      commands.push(command);
      assert.equal(command.action, "prepare-ai");
      return reply(
        {
          error: "합성 시험: 전송 범위 요청을 확인했습니다. AI는 실행하지 않았습니다.",
          accepted: false,
        },
        503,
      );
    }
    if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      unexpected.push(u.pathname);
      return route.abort();
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await reopen();
  assert.equal(company.sources.length, 0);
  await answer("외부 시험은 아직 계획 단계입니다.", "development");
  await handoff().waitFor();
  assert.deepEqual(company.plans, initialPlan);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, "source");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "saved-answer-mobile.png"), fullPage: true });
  record(
    "file-free answer save offers the direct next action; original manuscript unchanged and mobile fits",
  );
  await handoff().getByRole("button", { name: "이 답변으로 항목 수정안 만들기" }).click();
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="한 항목 보완 수정안"] fieldset')?.disabled,
  );
  assert.equal(await panel().getByLabel("보완할 질문", { exact: true }).inputValue(), "1");
  assert.equal(
    await panel().getByLabel("수정할 항목", { exact: true }).inputValue(),
    "development",
  );
  assert.equal(await panel().getByRole("checkbox").first().isChecked(), true);
  assert.equal(commands.length, 1);
  await panel().getByRole("button", { name: "전송 범위 확인", exact: true }).click();
  await panel().getByRole("alert").waitFor();
  assert.equal(commands.length, 2);
  assert.equal(commands[1].input.target.questionIndex, 1);
  assert.equal(commands[1].input.sectionKey, "development");
  assert.equal(commands[1].input.sourceSelections.length, 1);
  assert.equal(commands[1].input.sourceSelections[0].sourceId, company.sources[0].id);
  record(
    "saved answer, explicit section and second manuscript question reach the existing preview; no AI execution",
  );
  await panel().getByRole("button", { name: "계획서로 돌아가기", exact: true }).click();
  await handoff().waitFor();
  assert.deepEqual(company.plans, initialPlan);
  await page.getByRole("button", { name: "내용 고치기", exact: true }).click();
  await page.locator("textarea").fill("수동 수정한 문장을 새 버전으로 보관합니다.");
  await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
  await page.getByRole("heading", { name: "준비한 계획서를 확인해 주세요" }).waitFor();
  assert.equal(await handoff().count(), 0);
  assert.deepEqual(company.plans[0], initialPlan[0]);
  assert.equal(company.plans.length, 2);
  record(
    "return preserves saved answer; a manual new version clears the old shortcut without replacing the previous version",
  );
  company = fixture.answerWorkflowCompany();
  await reopen();
  await answer("외부 시험은 계획입니다.", null);
  await handoff().waitFor();
  await handoff().getByRole("button", { name: "이 답변으로 항목 수정안 만들기" }).click();
  await panel().getByLabel("수정할 항목", { exact: true }).waitFor();
  assert.equal(await panel().getByLabel("수정할 항목", { exact: true }).inputValue(), "");
  assert.equal(
    await panel().getByRole("button", { name: "전송 범위 확인", exact: true }).isDisabled(),
    true,
  );
  await panel().getByLabel("수정할 항목", { exact: true }).selectOption("development");
  await page.waitForFunction(
    () => !document.querySelector('section[aria-label="한 항목 보완 수정안"] fieldset')?.disabled,
  );
  assert.equal(
    await panel().getByRole("button", { name: "전송 범위 확인", exact: true }).isEnabled(),
    true,
  );
  record("unassigned section requires explicit selection and never defaults to development");
  company = fixture.answerWorkflowCompany();
  saveMode = "missing";
  await reopen();
  await answer("보관 응답이 불명확해도 이 입력은 남아야 합니다.", "development");
  await page
    .getByRole("alert")
    .filter({ hasText: "답변의 저장 결과를 확인하지 못했습니다" })
    .waitFor();
  assert.equal(
    await page.getByLabel(fixture.answerQuestion, { exact: true }).inputValue(),
    "보관 응답이 불명확해도 이 입력은 남아야 합니다.",
  );
  assert.equal(await handoff().count(), 0);
  record("missing saved source keeps the answer draft and does not claim success");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(!logs.join("").includes("FORBIDDEN_SERVER_FETCH"));
  assert.equal((await readdir(output)).includes("unused-data"), false);
  assert.ok(commands.every((c) => ["source", "save-plan", "prepare-ai"].includes(c.action)));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        checks,
        syntheticApiCommands: commands.length,
        errors,
        unexpected,
        actualBusinessApi: 0,
        external: 0,
        sql: 0,
        sdk: 0,
        mode: serverMode,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, checks: checks.length, syntheticApiCommands: commands.length }),
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Owned child failed to stop")), 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
