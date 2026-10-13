import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
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
const scenario = "visit-entry";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/visit-answers.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/visit-answer-receipt.ts",
  "scripts/visit-entry-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-visit-entry-ui-"));
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`
import { registerHooks } from "node:module";
registerHooks({resolve(specifier,context,next){if(specifier==="node:sqlite"||specifier==="openai")throw Error("Forbidden runtime import");return next(specifier,context);}});
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
let origin;
const requireVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "scripts/fixtures/visit-answer-receipt.ts"),
  cwd: app,
  platform: "browser",
  external: ["node:crypto"],
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      resolveId(source) {
        if (
          source !== "node:crypto" &&
          /openai|server-only|node:|storage|engine|provider-production|configuration-current/.test(
            source,
          )
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
const company = fixture.visitReceiptFixture().company;
company.profile.companyName = "합성 실사 답변 진입 기업";
const plan = company.plans.at(-1);
const duplicate = structuredClone(plan);
duplicate.content.title = "같은 ID의 다른 합성 원고";
const uniquePlan = structuredClone(plan);
uniquePlan.id = fixture.agencyId(241);
uniquePlan.version = plan.version + 1;
uniquePlan.content.title = "고유한 합성 답변 원고";
company.plans.push(duplicate, uniquePlan);
const ambiguousAnswer = company.visitAnswers[0];
ambiguousAnswer.answerText = "중복 원고 기준의 저장 답변";
const missingAnswer = structuredClone(ambiguousAnswer);
missingAnswer.id = missingAnswer.answerId = fixture.agencyId(243);
missingAnswer.planId = fixture.agencyId(249);
missingAnswer.questionSnapshot.planId = missingAnswer.planId;
missingAnswer.answerText = "유실 원고 기준의 저장 답변";
const validAnswer = structuredClone(ambiguousAnswer);
validAnswer.id = validAnswer.answerId = fixture.agencyId(244);
validAnswer.planId = uniquePlan.id;
validAnswer.questionSnapshot.planId = uniquePlan.id;
validAnswer.questionSnapshot.planVersion = uniquePlan.version;
validAnswer.questionSnapshot.planTitle = uniquePlan.content.title;
validAnswer.answerText = "고유 원고 기준의 저장 답변";
company.visitAnswers.push(missingAnswer, validAnswer);
let entryProbe = null;
const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0,
  nextDialog = "dismiss";
const blockedDevDiagnostics = [];
const network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [],
  dialogs = [];
// Browser attachment downloads may bypass Playwright interception. The HTTP boundary
// must enforce isolation independently: only static UI requests reach Next.
const proxy = createHttpServer(async (req, res) => {
  const u = new URL(req.url, origin);
  try {
    if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method)) {
      unexpected.push("proxy blocked " + u.pathname);
      res.writeHead(403);
      res.end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:" + port },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  } catch {
    errors.push("synthetic proxy failure");
    res.writeHead(500);
    res.end();
  }
});
const developmentSockets = new Set();
proxy.on("upgrade", (req, socket, head) => {
  if (serverMode !== "dev" || new URL(req.url, origin).pathname !== "/_next/hmr") {
    unexpected.push("blocked websocket");
    socket.destroy();
    return;
  }
  const upstream = connect({ host: "127.0.0.1", port }, () => {
    const headers = { ...req.headers, host: "127.0.0.1:" + port };
    upstream.write(
      req.method +
        " " +
        req.url +
        " HTTP/1.1\r\n" +
        Object.entries(headers)
          .map(([k, v]) => k + ": " + v)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  developmentSockets.add(socket);
  developmentSockets.add(upstream);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => {
    developmentSockets.delete(socket);
    upstream.destroy();
  });
  upstream.on("close", () => {
    developmentSockets.delete(upstream);
    socket.destroy();
  });
});
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
let child, context, page;
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
try {
  await start();
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  origin = "http://127.0.0.1:" + proxy.address().port;
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    try {
      const req = route.request(),
        u = new URL(req.url());
      if (u.origin !== origin) {
        unexpected.push("external");
        return route.abort();
      }
      if (serverMode === "dev" && u.pathname === "/__nextjs_original-stack-frames") {
        blockedDevDiagnostics.push({ method: req.method(), path: u.pathname });
        return route.fulfill({ status: 503, body: "Synthetic offline diagnostics" });
      }
      const reply = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (req.method() === "GET") {
        if (u.pathname === "/api/studio/status")
          return reply({
            aiConfigured: true,
            model: "synthetic-disabled",
            storage: "local",
            supportedFiles: [],
          });
        if (u.pathname === "/api/studio/cases")
          return reply({
            cases: companies.map((value) => ({
              id: value.id,
              companyName: value.profile.companyName,
              industry: "",
              stage: value.stage,
              revision: value.revision,
              createdAt: value.createdAt,
              updatedAt: value.updatedAt,
              sourceCount: value.sources.length,
              planCount: value.plans.length,
              pendingTaskCount: 0,
            })),
          });
        const found = companies.find((value) => u.pathname === "/api/studio/cases/" + value.id);
        if (found) {
          caseReads++;
          return reply(found);
        }
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
          preparationReads++;
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        }
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
      }
      if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
        unexpected.push(u.pathname);
        return route.abort();
      }
      return await route.continue();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Synthetic route failure");
      await route.abort().catch(() => {});
    }
  });
  page = await context.newPage();
  page.on("dialog", async (dialog) => {
    const action = nextDialog;
    nextDialog = "dismiss";
    dialogs.push({ message: dialog.message(), action });
    await dialog[action]();
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") network.push({ console: e.text().slice(0, 500) });
  });
  page.on("response", (r) => {
    if (r.status() >= 400) network.push({ status: r.status(), path: new URL(r.url()).pathname });
  });
  page.on("requestfailed", (r) =>
    network.push({ failed: r.failure()?.errorText, path: new URL(r.url()).pathname }),
  );
  page.on("request", (r) => network.push({ request: new URL(r.url()).pathname }));

  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "실사 모의 답변 기록", exact: true });
  const card = (text) => panel.getByRole("article").filter({ hasText: text }).locator("..");
  const entry = (text) =>
    card(text).getByRole("button", { name: "이 답변에서 새 버전 작성", exact: true });
  const message =
    "기준 원고를 하나로 확인할 수 없어 새 버전을 열 수 없습니다. 원고 연결을 확인해 주세요.";
  const answer = panel.getByLabel("담당자 모의 답변 (최대 10,000자)", { exact: true });
  const cancel = () => panel.getByRole("button", { name: "편집 취소", exact: true });
  const snapshot = () =>
    panel.locator("input,textarea,select").evaluateAll((els) =>
      els.map((e) => ({
        id: e.id,
        value: e.value,
        checked: e instanceof HTMLInputElement ? e.checked : undefined,
      })),
    );
  async function intact() {
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  }
  async function dirty(value) {
    await page.waitForFunction(
      (expected) => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented === expected;
      },
      value,
      { timeout: 10000 },
    );
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "visit-entry-" + n + "-mobile.png") });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await entry(ambiguousAnswer.answerText).isDisabled())) {
    await entry(ambiguousAnswer.answerText).click();
    const warning = panel.getByText(
      "연결한 원고를 고유하게 찾을 수 없습니다. 새로고침해 현재 자료를 확인해 주세요.",
      { exact: true },
    );
    await warning.waitFor({ state: "visible" });
    await dirty(true);
    entryProbe = {
      ambiguousEntryEnabled: true,
      editorInputs: await answer.count(),
      cancelButtons: await cancel().count(),
      dirty: true,
    };
    assert.equal(entryProbe.editorInputs, 0);
    assert.equal(entryProbe.cancelButtons, 0);
    await intact();
    assert.fail("Ambiguous saved answer opened a dirty state with no editor or cancel control.");
  }
  assert.equal(await entry(missingAnswer.answerText).isDisabled(), true);
  assert.equal(await entry(validAnswer.answerText).isDisabled(), false);
  assert.equal(await panel.getByText(message, { exact: true }).count(), 2);
  for (const text of [ambiguousAnswer.answerText, missingAnswer.answerText]) {
    const described = await entry(text).evaluate(
      (button) => document.getElementById(button.getAttribute("aria-describedby"))?.textContent,
    );
    assert.equal(described, message);
  }

  assert.equal(await answer.count(), 0);
  await dirty(false);
  await intact();
  await shot("duplicate", card(ambiguousAnswer.answerText).getByText(message, { exact: true }));
  await shot("missing", card(missingAnswer.answerText).getByText(message, { exact: true }));
  record(
    "Ambiguous and missing saved-answer plan bindings disable only their new-version entry with an explanation. Both saved answers remain readable; no editor or dirty state is created.",
  );

  await entry(validAnswer.answerText).focus();
  await page.keyboard.press("Enter");
  await answer.waitFor({ state: "visible" });
  assert.equal(await answer.inputValue(), validAnswer.answerText);
  assert.equal(await panel.getByText("기존 답변의 새 버전", { exact: true }).count(), 1);
  assert.equal(await cancel().count(), 1);
  await panel.getByLabel("응답자 이름", { exact: true }).fill("  합성 응답자  ");
  await answer.fill("  답변 초안\n  그대로  ");
  await panel.getByLabel("추가 자료·후속 확인", { exact: true }).fill("  후속 메모\n  보존  ");
  await panel.getByLabel("검토 담당자", { exact: true }).fill("  합성 검토자  ");
  await panel.getByLabel("검토 메모·미해결 사항", { exact: true }).fill(" \n ");
  await panel.getByRole("checkbox", { name: /원문과 답변을 대조한/ }).check();
  const edited = await snapshot();
  assert.equal(await entry(ambiguousAnswer.answerText).isDisabled(), true);
  assert.equal(await entry(missingAnswer.answerText).isDisabled(), true);
  assert.equal(await entry(validAnswer.answerText).isDisabled(), true);
  await shot("valid-draft", answer);
  assert.deepEqual(await snapshot(), edited);
  await dirty(true);
  await intact();
  nextDialog = "accept";
  await cancel().click();
  assert.equal(await answer.count(), 0);
  await dirty(false);
  assert.equal(await entry(validAnswer.answerText).isDisabled(), false);
  assert.equal(await entry(ambiguousAnswer.answerText).isDisabled(), true);
  assert.equal(await entry(missingAnswer.answerText).isDisabled(), true);
  await intact();
  record(
    "A uniquely bound saved answer opens by keyboard with its original answer and citation fields. Draft/review inputs remain editable and unchanged during reading; the existing explicit cancel returns to usable entry controls without saving.",
  );

  const planChoice = panel.getByLabel("기준 원고 버전 직접 선택", { exact: true });
  await planChoice.selectOption(uniquePlan.id);
  await panel.getByLabel("원고의 예상 질문 직접 선택", { exact: true }).selectOption("0");
  const startButton = panel.getByRole("button", { name: "미검토 답변 작성 시작", exact: true });
  await startButton.focus();
  await page.keyboard.press("Enter");
  await answer.waitFor({ state: "visible" });
  assert.equal(await panel.getByText("새 답변 초안", { exact: true }).count(), 1);
  assert.equal(await answer.inputValue(), "");
  const blank = await snapshot();
  await shot("new-draft", answer);
  assert.deepEqual(await snapshot(), blank);
  await dirty(true);
  await cancel().click();
  await dirty(false);
  assert.equal(await answer.count(), 0);
  assert.equal(await entry(validAnswer.answerText).isDisabled(), false);
  assert.equal(await panel.getByText(message, { exact: true }).count(), 2);
  assert.deepEqual(dialogs, [
    { message: "저장하지 않은 실사 모의 답변과 인용·검토 입력을 취소할까요?", action: "accept" },
  ]);
  await shot("returned", card(ambiguousAnswer.answerText).getByText(message, { exact: true }));
  await intact();
  assert.equal(caseReads, 1);
  record(
    "A new answer for another explicitly selected question in the unique plan still opens and an untouched draft closes without extra confirmation. Ambiguous/missing history remains readable and blocked; all company data and requests stay unchanged.",
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  for (const diagnostic of network.filter((item) => item.console)) {
    assert.ok(
      (diagnostic.console.startsWith("Encountered two children with the same key,") &&
        diagnostic.console.includes(plan.id)) ||
        diagnostic.console ===
          "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    );
  }
  assert.ok(!logs.join("").includes("FORBIDDEN_SERVER_FETCH"));
  assert.equal((await readdir(output)).includes("unused-data"), false);
  assert.ok(!logs.join("").includes("GET /api/"));

  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        checks,
        syntheticPatches: commands.length,
        syntheticCompanyGets: caseReads,
        syntheticIntakeGets: intakeReads,
        syntheticPreparationGets: preparationReads,
        syntheticUploadPosts: 0,
        syntheticPreviewPosts: 0,
        commands,
        dialogs,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        blockedDevDiagnostics,
        consoleDiagnostics: network.filter((item) => item.console),
        startingState:
          "ambiguous saved-answer plan binding blocks new-version entry while unique histories and new drafts remain usable",
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
  console.log(JSON.stringify({ output, checks, unexpected, errors, network, entryProbe }));
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  for (const socket of developmentSockets) socket.destroy();
  proxy.closeAllConnections();
  if (proxy.listening) await new Promise((resolve) => proxy.close(resolve));
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
  await writeFile(
    path.join(output, "cleanup.json"),
    JSON.stringify(
      {
        childStopped: !child || child.exitCode !== null || child.signalCode !== null,
        unusedDataPresent: (await readdir(output)).includes("unused-data"),
        businessRouteObserved: /(?:GET|POST|PATCH|PUT|DELETE) \/api\//.test(logs.join("")),
        forbiddenServerFetch: logs.join("").includes("FORBIDDEN_SERVER_FETCH"),
      },
      null,
      2,
    ),
  );
}
