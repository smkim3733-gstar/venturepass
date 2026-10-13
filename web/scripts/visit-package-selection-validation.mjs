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
const scenario = "visit-package-selection";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/visit-package-panel.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/visit-answer-receipt.ts",
  "scripts/visit-package-selection-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-visit-package-selection-ui-"));
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
const prepared = fixture.visitReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 실사 출력 선택 보호 기업";
const plan = company.plans.at(-1);
const otherPlan = {
  ...structuredClone(plan),
  id: "30000000-0000-4000-8000-000000000004",
  version: 4,
};
otherPlan.content.title = "다른 합성 출력 원고";
company.plans.push(otherPlan);
const sourceOne = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "합성 출력 원본 하나",
  kind: "technology",
  text: "",
  originalName: "synthetic-package-one.pdf",
  mimeType: "application/pdf",
  extraction: "pending",
  warnings: [],
  createdAt: company.createdAt,
  updatedAt: company.updatedAt,
};
const sourceTwo = {
  ...structuredClone(sourceOne),
  id: "30000000-0000-4000-8000-000000000002",
  name: "합성 출력 원본 둘",
  originalName: "synthetic-package-two.pdf",
};
company.sources.push(sourceOne, sourceTwo);
plan.content.sections[0].evidence = [sourceOne, sourceTwo].map((s) => ({
  sourceId: s.id,
  quote: "",
  locator: "합성 위치",
}));
const firstAnswer = company.visitAnswers[0];
const secondAnswer = {
  ...structuredClone(firstAnswer),
  id: "30000000-0000-4000-8000-000000000005",
  answerId: "30000000-0000-4000-8000-000000000005",
  questionIndex: 0,
  questionText: plan.content.interviewQuestions[0],
  answerText: "두 번째 합성 출력 답변",
};
secondAnswer.questionSnapshot.questionIndex = 0;
secondAnswer.questionSnapshot.questionText = secondAnswer.questionText;
company.visitAnswers.push(secondAnswer);
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
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/preparation-automation")),
    page.getByRole("button", { name: "상세 도구", exact: true }).click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "실사 질문·답변 출력 묶음", exact: true });
  const mode = panel.getByLabel("출력 기준 직접 선택", { exact: true });
  const basis = panel.locator("select").nth(1);
  const answerOne = panel.getByRole("checkbox", { name: /질문 2 · 답변 v1/ });
  const answerTwo = panel.getByRole("checkbox", { name: /질문 1 · 답변 v1/ });
  const fileOne = panel.getByRole("checkbox", { name: new RegExp(sourceOne.name) });
  const fileTwo = panel.getByRole("checkbox", { name: new RegExp(sourceTwo.name) });
  const reset = panel.getByRole("button", { name: "출력 선택 초기화", exact: true });
  const messages = {
    mode: "선택한 원고·제출 기준과 답변·원본을 비우고 출력 기준을 변경할까요?",
    basis: "선택한 답변·원본을 비우고 기준 버전을 변경할까요?",
    answer: "선택한 원본을 비우고 답변 선택을 변경할까요?",
    reset: "선택한 기준과 답변·원본의 출력 선택을 초기화할까요?",
  };
  const snapshot = () =>
    panel
      .locator("input,select")
      .evaluateAll((es) =>
        es.map((e) => ({
          id: e.id,
          value: e.value,
          checked: e.type === "checkbox" ? e.checked : null,
          label: e.closest("label")?.textContent,
        })),
      );
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(commands, []);
    await page.waitForFunction(
      () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return !e.defaultPrevented;
      },
      null,
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
    await page.screenshot({
      path: path.join(output, "visit-package-selection-" + n + "-mobile.png"),
    });
  }
  async function confirm(action, key, choice) {
    const before = dialogs.length;
    nextDialog = choice;
    await action();
    assert.equal(dialogs.length, before + 1);
    assert.deepEqual(dialogs.at(-1), { message: messages[key], action: choice });
  }
  async function quiet(action) {
    const n = dialogs.length;
    await action();
    assert.equal(dialogs.length, n);
  }
  async function allSelected() {
    await quiet(() => mode.selectOption("draft"));
    await quiet(() => basis.selectOption(plan.id));
    await quiet(() => answerOne.click());
    await quiet(() => answerTwo.click());
    await quiet(() => fileOne.click());
    await quiet(() => fileTwo.click());
  }
  async function state(m, b, a = [], f = []) {
    assert.equal(await mode.inputValue(), m);
    assert.equal(await basis.inputValue(), b);
    const checked = await panel
      .getByRole("checkbox")
      .evaluateAll((es) => es.filter((e) => e.checked).map((e) => e.closest("label").textContent));
    const expected = [
      ...a.map((i) => (i === 1 ? "질문 2 · 답변 v1" : "질문 1 · 답변 v1")),
      ...f.map((i) => (i === 1 ? sourceOne.name : sourceTwo.name)),
    ];
    assert.equal(checked.length, expected.length);
    for (const text of expected) assert.equal(checked.filter((s) => s.includes(text)).length, 1);
  }
  await state("", "");
  await quiet(() => mode.selectOption("recorded-submission"));
  await quiet(() => mode.selectOption("draft"));
  await allSelected();
  await page.setViewportSize({ width: 390, height: 844 });
  let saved = await snapshot();
  await confirm(() => basis.selectOption(otherPlan.id), "basis", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await sound();
  await shot("basis-kept", basis);
  await confirm(() => basis.selectOption(otherPlan.id), "basis", "accept");
  await state("draft", otherPlan.id);
  await quiet(() => basis.selectOption(plan.id));
  await quiet(() => fileOne.click());
  saved = await snapshot();
  await confirm(() => basis.selectOption(""), "basis", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await confirm(() => basis.selectOption(""), "basis", "accept");
  await state("draft", "");
  record(
    "Changing the exact manuscript or clearing it asks before discarding selected answers/originals; rejection keeps every choice, acceptance applies existing clearing, and empty subordinate selections add no prompt.",
  );

  await quiet(() => basis.selectOption(plan.id));
  await quiet(() => answerOne.click());
  await quiet(() => fileOne.click());
  saved = await snapshot();
  await confirm(() => answerTwo.click(), "answer", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await shot("answer-kept", fileOne.locator("xpath=.."));
  await confirm(() => answerTwo.click(), "answer", "accept");
  await state("draft", plan.id, [1, 2]);
  await quiet(() => fileTwo.click());
  saved = await snapshot();
  await confirm(() => answerOne.click(), "answer", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await confirm(() => answerOne.click(), "answer", "accept");
  await state("draft", plan.id, [2]);
  await quiet(() => fileOne.click());
  saved = await snapshot();
  await confirm(() => mode.selectOption("recorded-submission"), "mode", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await shot("mode-kept", mode);
  await confirm(() => mode.selectOption("recorded-submission"), "mode", "accept");
  await state("recorded-submission", "");
  await quiet(() => mode.selectOption("draft"));
  await quiet(() => basis.selectOption(plan.id));
  saved = await snapshot();
  await confirm(() => mode.selectOption(""), "mode", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await confirm(() => mode.selectOption(""), "mode", "accept");
  await state("", "");
  await sound();
  record(
    "Adding/removing an answer asks before clearing original selections. Changing output mode protects full choices and a basis-only choice; accepting clears existing descendants and never changes stored company records.",
  );

  await allSelected();
  saved = await snapshot();
  await confirm(() => reset.click(), "reset", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await shot("reset-kept", reset);
  await reset.focus();
  await confirm(() => page.keyboard.press("Enter"), "reset", "accept");
  await state("", "");
  await quiet(() => mode.selectOption("draft"));
  await quiet(() => reset.click());
  await state("", "");
  await quiet(() => mode.selectOption("draft"));
  await quiet(() => basis.selectOption(plan.id));
  saved = await snapshot();
  await confirm(() => reset.click(), "reset", "dismiss");
  assert.deepEqual(await snapshot(), saved);
  await confirm(() => reset.click(), "reset", "accept");
  await state("", "");
  await shot("reset-empty", mode);
  assert.equal(await reset.isDisabled(), true);
  assert.equal(
    await panel
      .getByRole("button", { name: "선택한 실사 준비 ZIP 내려받기", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(dialogs.length, 16);
  assert.equal(dialogs.filter((d) => d.action === "dismiss").length, 8);
  assert.equal(caseReads, 1);
  await sound();
  record(
    "Explicit reset protects full and basis-only selections; keyboard acceptance restores an empty panel, mode-only reset needs no confirmation, and selection-only use never enables document dirty protection or sends a download/save request.",
  );

  assert.deepEqual(
    network.filter((item) => item.console),
    [],
  );
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
          "explicit output selection changes protect chosen manuscript, answers and originals before clearing",
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
  console.log(JSON.stringify({ output, checks, unexpected, errors, network }));
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
