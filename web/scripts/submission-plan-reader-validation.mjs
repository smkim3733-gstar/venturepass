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
const scenario = "submission-plan-reader";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/application-history.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/application-submission-receipt.ts",
  "scripts/submission-plan-reader-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-submission-plan-reader-ui-"));
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
  input: path.join(app, "scripts/fixtures/application-submission-receipt.ts"),
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
const company = fixture.submissionReceiptCompany();
company.profile.companyName = "합성 제출 원고 읽기 기업";
const plan = company.plans[0];
const section = plan.content.sections[0];
const longBody =
  "  저장 원고 시작\n<b>문자 그대로</b>  안쪽 공백\n" +
  Array.from({ length: 240 }, (_, i) => "합성 세부 행 " + (i + 1)).join("\n") +
  "\n  저장 원고 마지막 문장  ";
plan.content.sections = [
  { ...section, key: "synthetic-first", title: "합성 첫 항목", content: longBody },
  {
    ...section,
    key: "synthetic-second",
    title: "합성 둘째 항목",
    content: "  별도 둘째 본문\n줄바꿈 유지  ",
  },
];
const other = structuredClone(plan);
other.id = "d1000000-0000-4000-8000-000000000002";
other.version = 4;
other.content.title = "다른 저장 원고";
other.content.sections = [
  {
    ...section,
    key: "synthetic-other",
    title: "다른 버전 항목",
    content: "  원고 v4 고유 본문\n다른 마지막 문장  ",
  },
];
company.plans = [plan, other];
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
  const panel = page.getByRole("region", { name: "신청 회차·제출 당시 이력", exact: true });
  await panel.getByRole("button", { name: "제출 당시 버전 기록", exact: true }).click();
  let editor = panel.getByRole("region", { name: "제출했다고 기록", exact: true });
  const snapshot = () =>
    editor.locator("input,textarea,select").evaluateAll((els) =>
      els.map((e) => ({
        id: e.id,
        value: e.value,
        checked: e instanceof HTMLInputElement ? e.checked : undefined,
      })),
    );
  const reader = () =>
    editor.getByRole("region", { name: "선택한 제출 원고 저장 본문", exact: true });
  const summary = () => editor.locator("summary").filter({ hasText: "선택한 원고 본문 보기" });
  const details = () =>
    editor
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: "선택한 원고 본문 보기" }) });
  async function intact() {
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  }
  async function dirty(value) {
    assert.equal(
      await page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
      value,
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
      path: path.join(output, "submission-plan-reader-" + n + "-mobile.png"),
    });
  }
  async function body(expected) {
    assert.deepEqual(
      await reader().locator("h5").allTextContents(),
      expected.content.sections.map((s) => s.title),
    );
    assert.deepEqual(
      await reader().locator("p").allTextContents(),
      expected.content.sections.map((s) => s.content),
    );
    assert.equal(await reader().locator("b,script").count(), 0);
  }
  assert.equal(await summary().count(), 0);
  await dirty(false);
  await editor.getByLabel("제출했다고 기록할 원고 버전 *", { exact: true }).selectOption(plan.id);
  await summary().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await details().getAttribute("open"), null);
  const selectedSnapshot = await snapshot();
  await summary().focus();
  await page.keyboard.press("Enter");
  await body(plan);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("start", reader());
  await reader().focus();
  await page.keyboard.press("End");
  assert.equal(await reader().evaluate((e) => e === document.activeElement), true);
  assert.ok(
    await reader().evaluate(
      (e) => e.scrollTop > 0 && e.scrollTop + e.clientHeight >= e.scrollHeight - 2,
    ),
  );
  await shot("end", reader());
  assert.deepEqual(await snapshot(), selectedSnapshot);
  await dirty(true);
  await intact();
  record(
    "The new submission starts without a reader; explicitly choosing stored v3 opens a collapsed reader whose full two sections preserve whitespace and literal HTML-shaped text. Keyboard expansion and End scrolling do not change the submission inputs.",
  );

  await editor.getByLabel("담당자 기입 제출일 *", { exact: true }).fill("2026-10-10");
  await editor.getByLabel("기록자 이름 *", { exact: true }).fill("  합성 기록자  ");
  await editor.getByLabel("기록 메모 (선택)", { exact: true }).fill("  작성 메모\n  줄바꿈 보존  ");
  const draft = await snapshot();
  await summary().click();
  await summary().click();
  await body(plan);
  assert.deepEqual(await snapshot(), draft);
  await editor.getByLabel("기록자 이름 *", { exact: true }).fill("");
  await editor.getByRole("button", { name: "담당자 기록 저장", exact: true }).click();
  const error = panel.getByRole("alert");
  await error.waitFor({ state: "visible" });
  const message = await error.textContent();
  assert.ok(message.length > 0);
  const invalid = await snapshot();
  await summary().click();
  await summary().click();
  assert.deepEqual(await snapshot(), invalid);
  assert.equal(await error.textContent(), message);
  await shot("draft", editor.getByLabel("기록 메모 (선택)", { exact: true }));
  await editor.getByLabel("제출했다고 기록할 원고 버전 *", { exact: true }).selectOption(other.id);
  assert.equal(await details().getAttribute("open"), null);
  await summary().click();
  await body(other);
  assert.deepEqual(
    (await snapshot()).filter((e) => !e.id.endsWith("-plan")),
    invalid.filter((e) => !e.id.endsWith("-plan")),
  );
  assert.equal(await error.textContent(), message);
  await shot("version", reader());
  await editor.getByLabel("제출했다고 기록할 원고 버전 *", { exact: true }).selectOption("");
  assert.equal(await summary().count(), 0);
  assert.equal(await reader().count(), 0);
  assert.deepEqual(
    (await snapshot()).filter((e) => !e.id.endsWith("-plan")),
    invalid.filter((e) => !e.id.endsWith("-plan")),
  );
  await dirty(true);
  await intact();
  record(
    "Raw date/recorder/note drafts and an existing required-recorder error survive folding and reading. A deliberate v4 choice starts collapsed and shows only its own body; clearing the choice hides the reader while other inputs and the error stay intact.",
  );

  nextDialog = "accept";
  await editor.getByRole("button", { name: "편집 취소", exact: true }).click();
  await panel.getByRole("button", { name: "제출 기록 정정", exact: true }).click();
  editor = panel.getByRole("region", { name: "제출 기록 정정", exact: true });
  const missing = editor.getByRole("alert");
  await missing.waitFor({ state: "visible" });
  assert.equal(
    await missing.textContent(),
    "선택한 원고 버전을 하나로 확인할 수 없어 본문을 표시하지 않습니다. 원고 버전을 다시 확인해 주세요.",
  );
  assert.equal(await summary().count(), 0);
  const correction = await snapshot();
  await dirty(false);
  await shot("missing", missing);
  await editor.getByLabel("제출했다고 기록할 원고 버전 *", { exact: true }).selectOption(plan.id);
  assert.equal(await details().getAttribute("open"), null);
  assert.equal(await editor.getByRole("alert").count(), 0);
  await summary().click();
  await body(plan);
  assert.deepEqual(
    (await snapshot()).filter((e) => !e.id.endsWith("-plan")),
    correction.filter((e) => !e.id.endsWith("-plan")),
  );
  await reader().focus();
  await page.keyboard.press("End");
  assert.deepEqual(
    (await snapshot()).filter((e) => !e.id.endsWith("-plan")),
    correction.filter((e) => !e.id.endsWith("-plan")),
  );
  await dirty(true);
  await intact();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].action, "accept");
  assert.equal(caseReads, 1);
  record(
    "Opening the existing submission correction starts from its original unavailable plan ID and shows a clarification without replacing it. Explicitly choosing available v3 starts collapsed and displays the currently loaded stored body while the original correction date and recorder remain unchanged.",
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
        blockedDevDiagnostics,
        consoleDiagnostics: network.filter((item) => item.console),
        startingState:
          "selected saved submission plan body can be read without changing draft inputs",
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
