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
const scenario = "criteria-selection";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/criteria-versions.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/criteria-receipt.ts",
  "scripts/criteria-selection-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-criteria-selection-ui-"));
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
  input: path.join(app, "scripts/fixtures/criteria-receipt.ts"),
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
const prepared = await fixture.criteriaReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 회차 기준 선택 기업";
const initial = company.criteriaVersions[0];
const duplicate = structuredClone(initial);
duplicate.details.title = "중복 ID의 다른 기준";
duplicate.details.sources[0].quote = "임의로 선택하면 안 되는 둘째 원문";
const unique = structuredClone(initial);
unique.id = fixture.linkId(551);
unique.criteriaId = unique.id;
unique.version = 2;
unique.details.title = "고유 기준 둘째 버전";
unique.details.versionLabel = "선택 대조 v2";
unique.details.sources[0].quote = "  <b>고유 조건</b>\n둘째 줄  ";
unique.details.sources[0].note = "  확인 메모\n원문 유지  ";
unique.contentSha256 = await fixture.criteriaReceiptHash(unique.details);
const other = structuredClone(unique);
other.id = fixture.linkId(552);
other.version = 3;
other.details.title = "고유 기준 셋째 버전";
other.details.versionLabel = "선택 대조 v3";
other.details.sources[0].quote = "셋째 버전의 별도 원문";
other.contentSha256 = await fixture.criteriaReceiptHash(other.details);
company.criteriaVersions = [initial, duplicate, unique, other];
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
  await page.getByRole("button", { name: "회차에 기준 버전 연결", exact: true }).click();
  const editor = page.getByRole("region", { name: "회차 기준 연결 편집", exact: true });
  const confirmed = editor.getByRole("checkbox");
  const choice = editor.getByLabel("연결할 정확한 기준 버전 *", { exact: true });
  const author = editor.getByLabel("기록 담당자 *", { exact: true });
  const reason = editor.getByLabel("기록·정정·연결 이유 *", { exact: true });
  const view = editor.locator("article");
  const snapshot = () =>
    editor.locator("input,textarea,select").evaluateAll((es) =>
      es.map((e) => ({
        id: e.id,
        value: e.value,
        checked: e.type === "checkbox" ? e.checked : null,
      })),
    );
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
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(commands, []);
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "criteria-selection-" + n + "-mobile.png") });
  }

  await dirty(false);
  await editor
    .getByLabel("신청 회차의 현재 정보 *", { exact: true })
    .selectOption(company.applications[0].id);
  const duplicateOptions = choice.locator('option[value="' + initial.id + '"]');
  assert.equal(await duplicateOptions.count(), 2);
  for (const option of await duplicateOptions.all()) {
    assert.equal(await option.isDisabled(), true);
    assert.ok((await option.textContent()).includes("기준 ID 중복 · 선택 불가"));
  }
  assert.equal(await choice.locator("option").count(), 5);
  assert.equal(await choice.locator('option[value="' + unique.id + '"]').isDisabled(), false);
  assert.equal(await choice.locator('option[value="' + other.id + '"]').isDisabled(), false);
  assert.equal(await choice.inputValue(), "");
  assert.equal(await view.count(), 0);
  let before = await snapshot();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("ambiguous", choice);
  assert.deepEqual(await snapshot(), before);
  await sound();
  record(
    "Duplicate criteria IDs within the current company are disabled with explanatory option text; distinct versions remain selectable and no arbitrary criteria body is displayed. Reading leaves all inputs and company state unchanged.",
  );
  await choice.selectOption(unique.id);
  assert.equal(await view.count(), 1);
  assert.equal(
    await view.getByRole("heading").textContent(),
    unique.details.title + " · v2 · " + unique.details.versionLabel,
  );
  assert.equal(
    await view.getByText(duplicate.details.sources[0].quote, { exact: true }).count(),
    0,
  );
  const sourceDetails = () =>
    view
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: "기입 출처 1:" }) });
  const quote = () => sourceDetails().locator("p").filter({ hasText: "보관한 원문 인용:" });
  await sourceDetails().locator("summary").focus();
  await sourceDetails().locator("summary").press("Enter");
  assert.equal(await quote().textContent(), "보관한 원문 인용: " + unique.details.sources[0].quote);
  assert.equal(await view.locator("b,script").count(), 0);
  before = await snapshot();
  await shot("unique", sourceDetails());
  assert.deepEqual(await snapshot(), before);
  await author.fill("  기준 연결 담당  ");
  await reason.fill("  연결 이유\n둘째 줄 초안  ");
  await confirmed.check();
  before = await snapshot();
  await sourceDetails().locator("summary").click();
  await sourceDetails().locator("summary").focus();
  await sourceDetails().locator("summary").press("Enter");
  assert.deepEqual(await snapshot(), before);
  assert.equal(await quote().textContent(), "보관한 원문 인용: " + unique.details.sources[0].quote);
  await dirty(true);
  await shot("draft", reason);
  await choice.selectOption(other.id);
  const changed = await snapshot(),
    choiceId = await choice.getAttribute("id");
  assert.deepEqual(
    changed,
    before.map((x) => ({
      ...x,
      value: x.id === choiceId ? other.id : x.value,
      checked: x.checked === null ? null : false,
    })),
  );
  assert.equal(
    await view.getByRole("heading").textContent(),
    other.details.title + " · v3 · " + other.details.versionLabel,
  );
  if (
    !(await sourceDetails().getAttribute("open")) &&
    !(await sourceDetails().evaluate((e) => e.open))
  )
    await sourceDetails().locator("summary").click();
  assert.equal(await quote().textContent(), "보관한 원문 인용: " + other.details.sources[0].quote);
  await shot("version", sourceDetails());
  await choice.selectOption(unique.id);
  await sound();
  record(
    "Explicit unique selection shows the exact saved version and literal whitespace/HTML-like quote; reading preserves authored recorder/reason and checked confirmation. Switching unique versions changes only the version choice and existing confirmation reset, preserving the other draft fields.",
  );
  await author.fill("   ");
  await confirmed.check();
  before = await snapshot();
  await editor.getByRole("button", { name: "선택한 기준 버전을 회차에 연결", exact: true }).click();
  const error = page
    .getByRole("alert")
    .filter({ hasText: "필수 항목과 입력 형식을 확인해 주세요." });
  await error.waitFor({ state: "visible", timeout: 10000 });
  assert.deepEqual(await snapshot(), before);
  if (!(await sourceDetails().evaluate((e) => e.open)))
    await sourceDetails().locator("summary").click();
  await sourceDetails().locator("summary").click();
  await sourceDetails().locator("summary").focus();
  await sourceDetails().locator("summary").press("Enter");
  assert.deepEqual(await snapshot(), before);
  assert.equal(await error.isVisible(), true);
  await shot("error-kept", error);
  await choice.selectOption("");
  assert.equal(await view.count(), 0);
  assert.equal(await error.count(), 0);
  assert.deepEqual(
    await snapshot(),
    before.map((x) => ({
      ...x,
      value: x.id === choiceId ? "" : x.value,
      checked: x.checked === null ? null : false,
    })),
  );
  for (const option of await duplicateOptions.all()) assert.equal(await option.isDisabled(), true);
  assert.deepEqual(dialogs, []);
  await dirty(true);
  await sound();
  assert.equal(caseReads, 1);
  record(
    "A local blank-recorder save failure sends no command. Reading retains every draft value, checkbox and error; explicitly clearing the selection hides the criteria view and applies existing error/confirmation clearing while preserving recorder whitespace and reason.",
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
          "ambiguous criteria versions are not selectable; unique criteria display and draft preservation",
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
