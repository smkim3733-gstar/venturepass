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
const scenario = "numeric-reference";

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
  "scripts/numeric-reference-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-reference-ui-"));
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
company.profile.companyName = "합성 수치 근거 전환 기업";
const plan = company.plans.at(-1);
const firstSection = plan.content.sections[0];
const secondSection = {
  ...structuredClone(firstSection),
  key: "numeric-extra",
  title: "다른 합성 항목",
  content: "다른 항목 수량 40개.",
};
plan.content.sections.push(secondSection);
const nextPlan = structuredClone(plan);
nextPlan.id = fixture.agencyId(230);
nextPlan.version = 5;
company.plans.push(nextPlan);
const sourceOne = {
  id: fixture.agencyId(231),
  kind: "technology",
  name: "합성 근거 자료 하나",
  text: "  첫 자료의 수량 10개\n보관 문장  ",
  extraction: "manual",
  originalName: "",
  mimeType: "text/plain",
  warnings: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const sourceTwo = {
  ...structuredClone(sourceOne),
  id: fixture.agencyId(232),
  name: "합성 근거 자료 둘",
  text: "  둘째 자료의 수량 20개\n다른 문장  ",
};
company.sources.push(sourceOne, sourceTwo);

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

  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/preparation-automation")),
    page.getByRole("button", { name: "상세 도구", exact: true }).click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /사업계획서/ }).click();

  const panel = page.getByRole("region", { name: "기간·단위·산식 수치 대조", exact: true });
  const editor = panel
    .locator("fieldset")
    .filter({ has: page.locator("#numeric-check-title") })
    .first();
  const observation = () => editor.getByRole("group", { name: "관측 수치 1", exact: true });
  const field = (label) => observation().getByLabel(label, { exact: true });
  const kind = () => field("정확한 인용 연결");
  const sourceSelect = () => field("같은 회사 자료 *");
  const planSelect = () => field("저장 원고 버전 *");
  const sectionSelect = () => field("원고 항목 *");
  const quote = () => field("수치가 포함된 원문 그대로 인용 *");
  const locator = () => field("자료 쪽·위치");
  const judgement = () => editor.getByLabel("이번 버전의 내부 판단", { exact: true });
  const title = () => editor.getByLabel("대조안 제목 *", { exact: true });
  const prefix = "numeric-observation-" + company.numericChecks[0].observations[0].id;
  const refIds = ["reference-kind", "source", "locator", "plan", "section", "quote"].map(
    (s) => prefix + "-" + s,
  );
  const snapshot = () =>
    editor
      .locator("input,textarea,select")
      .evaluateAll((els) => els.map((e) => ({ id: e.id, value: e.value })));
  const outside = async () => (await snapshot()).filter((i) => !refIds.includes(i.id));
  const kindMessage = "선택한 근거 연결과 작성한 인용·쪽/위치를 비우고 연결 종류를 변경할까요?";
  const sourceMessage = "작성한 인용·쪽/위치를 비우고 연결 자료를 변경할까요?";
  const planMessage = "선택한 원고 항목·인용을 비우고 원고 버전을 변경할까요?";
  const sectionMessage = "작성한 원고 인용을 비우고 원고 항목을 변경할까요?";
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(commands.length, 0);
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
  }
  async function accept(action, message) {
    const before = await outside(),
      id = await judgement().getAttribute("id");
    await ask(action, message, true);
    assert.deepEqual(
      await outside(),
      before.map((i) => (i.id === id ? { ...i, value: "unreviewed" } : i)),
    );
    await sound();
  }
  async function freely(action) {
    const count = dialogs.length;
    await action();
    assert.equal(dialogs.length, count);
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "numeric-reference-" + name + "-mobile.png") });
  }
  await panel.getByRole("button", { name: "이 대조안의 새 버전 작성", exact: true }).click();
  await title().waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  await title().fill("  수치 근거 전환 초안  ");
  await editor.getByLabel("판단 담당자", { exact: true }).fill("  합성 담당  ");
  await editor
    .getByLabel("판단 메모·미해결 사항", { exact: true })
    .fill("  판단 메모\n마지막 줄  ");
  await field("출처 해석·범위·가정 메모 (수동)").fill("  수치 메모\n보존  ");
  await reject(() => kind().selectOption("source"), kindMessage);
  await shot("kind-kept", quote());
  await accept(() => kind().selectOption("source"), kindMessage);
  assert.equal(await sourceSelect().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  assert.equal(await locator().inputValue(), "");
  await freely(() => sourceSelect().selectOption(sourceOne.id));
  await quote().fill("  자료 인용 초안\n두 번째 줄  ");
  await locator().fill("  합성 2쪽  ");
  await reject(() => sourceSelect().selectOption(sourceTwo.id), sourceMessage);
  await shot("source-kept", locator());
  await accept(() => sourceSelect().selectOption(sourceTwo.id), sourceMessage);
  assert.equal(await sourceSelect().inputValue(), sourceTwo.id);
  assert.equal(await quote().inputValue(), "");
  assert.equal(await locator().inputValue(), "");
  await locator().fill("   ");
  await reject(() => sourceSelect().selectOption(""), sourceMessage);
  await accept(() => sourceSelect().selectOption(""), sourceMessage);
  assert.equal(await sourceSelect().inputValue(), "");
  assert.equal(await locator().inputValue(), "");
  await freely(() => kind().selectOption("plan"));
  record(
    "Changing citation kind protects the original saved plan citation; source replacement and empty-source selection protect exact quote/location including whitespace-only location, reject preserves every input/judgement, accept changes only reference and existing judgement reset.",
  );

  await freely(() => planSelect().selectOption(plan.id));
  await freely(() => sectionSelect().selectOption(firstSection.key));
  await reject(() => planSelect().selectOption(nextPlan.id), planMessage);
  await shot("plan-kept", planSelect());
  await accept(() => planSelect().selectOption(nextPlan.id), planMessage);
  assert.equal(await planSelect().inputValue(), nextPlan.id);
  assert.equal(await sectionSelect().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  await freely(() => planSelect().selectOption(plan.id));
  await freely(() => sectionSelect().selectOption(firstSection.key));
  await quote().fill(" \n ");
  await reject(() => sectionSelect().selectOption(secondSection.key), sectionMessage);
  await shot("section-kept", quote());
  await accept(() => sectionSelect().selectOption(secondSection.key), sectionMessage);
  assert.equal(await sectionSelect().inputValue(), secondSection.key);
  assert.equal(await quote().inputValue(), "");
  await freely(() => sectionSelect().selectOption(firstSection.key));
  await quote().fill("  원고 인용\n유지할 줄  ");
  await reject(() => planSelect().selectOption(""), planMessage);
  await accept(() => planSelect().selectOption(""), planMessage);
  assert.equal(await planSelect().inputValue(), "");
  assert.equal(await sectionSelect().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  record(
    "Plan-version changes protect a selected section alone and populated citations, section changes protect whitespace/newline-only citation, and accepting or explicitly clearing the plan resets only its existing reference fields while unrelated numeric/comparison/formula inputs remain.",
  );

  await freely(() => planSelect().selectOption(plan.id));
  await freely(() => sectionSelect().selectOption(firstSection.key));
  await reject(() => kind().selectOption(""), kindMessage);
  await accept(() => kind().selectOption(""), kindMessage);
  assert.equal(await kind().inputValue(), "");
  assert.equal(await quote().count(), 0);
  await freely(() => kind().selectOption("source"));
  await freely(() => kind().selectOption("plan"));
  await quote().fill(" \n ");
  await reject(() => kind().selectOption("source"), kindMessage);
  await accept(() => kind().selectOption("source"), kindMessage);
  assert.equal(await sourceSelect().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  await locator().fill("   ");
  await title().fill("");
  await judgement().selectOption("needs-work");
  await editor.getByRole("button", { name: "수치 대조 버전 저장", exact: true }).click();
  const alert = editor.getByRole("alert").filter({ hasText: "대조안 제목을 입력해 주세요." });
  await alert.waitFor({ state: "visible" });
  const beforeError = await snapshot();
  await ask(() => kind().selectOption(""), kindMessage);
  assert.deepEqual(await snapshot(), beforeError);
  assert.equal(await alert.count(), 1);
  await shot("error-kept", locator());
  await accept(async () => {
    await kind().focus();
    await page.keyboard.press("Home");
  }, kindMessage);
  assert.equal(await kind().inputValue(), "");
  assert.equal(await quote().count(), 0);
  assert.equal(await editor.getByRole("alert").count(), 0);
  assert.equal(await editor.getByRole("group", { name: /^관측 수치 [0-9]+$/ }).count(), 3);
  assert.equal(dialogs.length, 18);
  assert.equal(dialogs.filter((i) => i.action === "accept").length, 9);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  await sound();
  record(
    "Disconnecting a selected plan and changing kind with only citation or whitespace-only location requires confirmation; empty kinds switch freely, rejection preserves the existing required-title error and all inputs, keyboard acceptance removes reference and applies prior error/judgement reset without a business request.",
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
          "numeric citation reference transitions with synthetic sources and plan versions; in-memory fixture only",
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
