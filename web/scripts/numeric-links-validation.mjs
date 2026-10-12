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
const scenario = "numeric-links";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/numeric-checks.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/numeric-check-receipt.ts",
  "scripts/numeric-links-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-links-ui-"));
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
  input: path.join(app, "scripts/fixtures/numeric-check-receipt.ts"),
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
const company = fixture.numericReceiptFixture().company;
company.profile.companyName = "합성 수치 연결 보호 기업";

const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0,
  nextDialog = "dismiss";
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

  const readiness = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await readiness;
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /사업계획서/ }).click();

  const panel = page.getByRole("region", { name: "기간·단위·산식 수치 대조", exact: true });
  const editor = panel
    .locator("fieldset")
    .filter({ has: page.locator("#numeric-check-title") })
    .first();
  const title = () => editor.getByLabel("대조안 제목 *", { exact: true });
  const formulas = () => editor.getByRole("group", { name: /^산식 [0-9]+$/ });
  const pairs = () => editor.getByRole("group", { name: /^비교쌍 [0-9]+$/ });
  const judgement = () => editor.getByLabel("이번 버전의 내부 판단", { exact: true });
  const formula = () => formulas().first();
  const operation = () =>
    formula().getByLabel("연산 (변경하면 피연산값 선택 초기화)", { exact: true });
  const operand = (n) => formula().getByLabel("피연산값 " + n, { exact: true });
  const expected = () => formula().getByLabel("계산 결과와 대조할 별도 입력값", { exact: true });
  const snapshot = () =>
    editor
      .locator("input, textarea, select")
      .evaluateAll((items) => items.map((i) => ({ id: i.id, value: i.value })));
  const removeFields = (values, ids) => values.filter((i) => !ids.includes(i.id));
  const changedValues = (values, changes) =>
    values.map((i) => ({ ...i, value: Object.hasOwn(changes, i.id) ? changes[i.id] : i.value }));
  async function sound() {
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await page.waitForFunction(
      () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      },
      null,
      { timeout: 10000 },
    );
  }
  async function ask(action, message, accept = false) {
    const count = dialogs.length;
    nextDialog = accept ? "accept" : "dismiss";
    await action();
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), { message, action: accept ? "accept" : "dismiss" });
  }
  async function reject(action, message) {
    await judgement().selectOption("needs-work");
    const before = await snapshot(),
      alerts = await editor.getByRole("alert").allTextContents();
    await ask(action, message);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await editor.getByRole("alert").allTextContents(), alerts);
    await sound();
    return before;
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    await page.screenshot({ path: path.join(output, "numeric-links-" + name + "-mobile.png") });
  }
  const switchMessage = "선택한 피연산값을 비우고 산식의 연산을 변경할까요?";
  const lastMessage = "선택한 수치 연결이 있는 마지막 합계 항을 삭제할까요?";
  const pairMessage = "선택한 수치 연결이 있는 이 비교쌍을 삭제할까요?";
  const formulaMessage = "선택한 연산·수치 연결을 포함한 이 산식을 삭제할까요?";
  await panel.getByRole("button", { name: "이 대조안의 새 버전 작성", exact: true }).click();
  await title().waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  const ids = company.numericChecks[0].observations.map((i) => i.id);
  await title().fill("  연결 보호 대조안  ");
  await editor.getByLabel("판단 담당자", { exact: true }).fill("  합성 담당  ");
  await editor
    .getByLabel("판단 메모·미해결 사항", { exact: true })
    .fill("  판단 메모\n마지막 줄  ");
  await editor
    .getByRole("group", { name: "관측 수치 1", exact: true })
    .getByLabel("출처 해석·범위·가정 메모 (수동)", { exact: true })
    .fill("  수치 메모\n보존  ");
  const judgementId = await judgement().getAttribute("id");
  const beforeSwitch = await reject(() => operation().selectOption("difference"), switchMessage);
  await shot("operation-kept", operation());
  const operationId = await operation().getAttribute("id"),
    firstId = await operand(1).getAttribute("id"),
    secondId = await operand(2).getAttribute("id");
  await ask(() => operation().selectOption("difference"), switchMessage, true);
  assert.deepEqual(
    await snapshot(),
    changedValues(beforeSwitch, {
      [operationId]: "difference",
      [firstId]: "",
      [secondId]: "",
      [judgementId]: "unreviewed",
    }),
  );
  assert.equal(await expected().inputValue(), ids[2]);
  const countSwitch = dialogs.length;
  await operation().selectOption("sum");
  assert.equal(dialogs.length, countSwitch);
  await operand(1).selectOption(ids[0]);
  await operand(2).selectOption(ids[1]);
  await expected().selectOption("");
  await formula().getByRole("button", { name: "합계 항 추가", exact: true }).click();
  await operand(3).selectOption(ids[2]);
  const lastButton = () =>
    formula().getByRole("button", { name: "마지막 합계 항 삭제", exact: true });
  const beforeLast = await reject(() => lastButton().click(), lastMessage);
  await shot("last-kept", lastButton());
  const lastId = await operand(3).getAttribute("id");
  await ask(
    async () => {
      await lastButton().focus();
      await page.keyboard.press("Enter");
    },
    lastMessage,
    true,
  );
  assert.deepEqual(
    await snapshot(),
    changedValues(removeFields(beforeLast, [lastId]), { [judgementId]: "unreviewed" }),
  );
  const countLast = dialogs.length;
  await formula().getByRole("button", { name: "합계 항 추가", exact: true }).click();
  await lastButton().click();
  assert.equal(dialogs.length, countLast);
  assert.equal(await lastButton().isDisabled(), true);
  await expected().selectOption(ids[2]);
  await sound();
  record(
    "Operation change and removal of a selected last sum operand require confirmation; rejection preserves all inputs/judgement, acceptance clears only the old operand choices or last operand and applies the existing judgement reset; empty paths need no prompt",
  );

  const pairButton = () =>
    pairs().first().getByRole("button", { name: "비교쌍 삭제", exact: true });
  const beforePair = await reject(() => pairButton().click(), pairMessage);
  await shot("pair-kept", pairButton());
  const pairIds = await pairs()
    .first()
    .locator("select")
    .evaluateAll((items) => items.map((i) => i.id));
  await ask(() => pairButton().click(), pairMessage, true);
  assert.deepEqual(
    await snapshot(),
    changedValues(removeFields(beforePair, pairIds), { [judgementId]: "unreviewed" }),
  );
  const addPair = () =>
    editor.getByRole("button", { name: "수치 비교쌍 추가", exact: true }).click();
  const countPair = dialogs.length;
  await addPair();
  await pairButton().click();
  assert.equal(dialogs.length, countPair);
  await addPair();
  await pairs().first().getByLabel("오른쪽 수치", { exact: true }).selectOption(ids[1]);
  const oneSide = await reject(() => pairButton().click(), pairMessage);
  const oneIds = await pairs()
    .first()
    .locator("select")
    .evaluateAll((items) => items.map((i) => i.id));
  await ask(() => pairButton().click(), pairMessage, true);
  assert.deepEqual(
    await snapshot(),
    changedValues(removeFields(oneSide, oneIds), { [judgementId]: "unreviewed" }),
  );
  assert.equal(await pairs().count(), 0);
  await sound();
  record(
    "Deleting a populated comparison or a right-only comparison requires confirmation; reject retains both raw draft and judgement, accept removes that comparison alone, and a newly empty pair deletes freely",
  );

  const formulaButton = () => formula().getByRole("button", { name: "산식 삭제", exact: true });
  await title().fill("");
  await judgement().selectOption("needs-work");
  await editor.getByRole("button", { name: "수치 대조 버전 저장", exact: true }).click();
  const alert = editor.getByRole("alert").filter({ hasText: "대조안 제목을 입력해 주세요." });
  await alert.waitFor({ state: "visible" });
  const beforeFormula = await snapshot();
  await ask(() => formulaButton().click(), formulaMessage);
  assert.deepEqual(await snapshot(), beforeFormula);
  assert.equal(await alert.count(), 1);
  await sound();
  await shot("formula-kept", formulaButton());
  const formulaIds = await formula()
    .locator("select")
    .evaluateAll((items) => items.map((i) => i.id));
  await ask(() => formulaButton().click(), formulaMessage, true);
  assert.deepEqual(
    await snapshot(),
    changedValues(removeFields(beforeFormula, formulaIds), { [judgementId]: "unreviewed" }),
  );
  assert.equal(await editor.getByRole("alert").count(), 0);
  const addFormula = () => editor.getByRole("button", { name: "산식 추가", exact: true }).click();
  const countFormula = dialogs.length;
  await addFormula();
  await formulaButton().click();
  assert.equal(dialogs.length, countFormula);
  await addFormula();
  await expected().selectOption(ids[2]);
  const expectedOnly = await reject(() => formulaButton().click(), formulaMessage);
  const expectedIds = await formula()
    .locator("select")
    .evaluateAll((items) => items.map((i) => i.id));
  await ask(() => formulaButton().click(), formulaMessage, true);
  assert.deepEqual(
    await snapshot(),
    changedValues(removeFields(expectedOnly, expectedIds), { [judgementId]: "unreviewed" }),
  );
  await addFormula();
  await operation().selectOption("quotient");
  const operationOnly = await reject(() => formulaButton().click(), formulaMessage);
  await shot("operation-only", operation());
  const operationIds = await formula()
    .locator("select")
    .evaluateAll((items) => items.map((i) => i.id));
  await ask(() => formulaButton().click(), formulaMessage, true);
  assert.deepEqual(
    await snapshot(),
    changedValues(removeFields(operationOnly, operationIds), { [judgementId]: "unreviewed" }),
  );
  assert.equal(await formulas().count(), 0);
  assert.equal(await pairs().count(), 0);
  assert.equal(await editor.getByRole("group", { name: /^관측 수치 [0-9]+$/ }).count(), 3);
  assert.equal(dialogs.length, 14);
  assert.equal(dialogs.filter((i) => i.action === "accept").length, 7);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  await sound();
  record(
    "Formula deletion protects populated operands, expected-value-only and changed-operation-only drafts; rejection also preserves an existing local validation error, acceptance follows existing error/judgement reset, and a default empty formula deletes without confirmation",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
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
        startingState:
          "numeric comparison/formula destructive editing confirmation; original memory receipt fixture, no API mutation",
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
