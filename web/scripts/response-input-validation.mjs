import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// Actual app UI; all business APIs are fulfilled with synthetic, in-memory state.
// No server business route, SQL, SDK, key, customer record or external service is used.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(tmpdir());
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
const scenario = "response-validation";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/response-preparation.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/response-preparation-receipt.ts",
  "scripts/response-input-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-response-validation-ui-"));
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
async function listenSafe(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(20000 + Math.floor(Math.random() * 30000), "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw Error("No safe local port available");
}
await listenSafe(listener);
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
let origin;
const requireVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "scripts/fixtures/response-preparation-receipt.ts"),
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
const prepared = fixture.responseReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 보완 답변 입력 안내 기업";
const request = company.agencyRecords
  .filter((r) => r.kind === "request" || r.kind === "request-correction")
  .at(-1);
const plan = company.plans.at(-1),
  section = plan.content.sections[0];
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
  await listenSafe(proxy);
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
  const panel = page.getByRole("region", { name: "보완 답변 작성 보조", exact: true });
  await panel.getByRole("button", { name: "답변 준비 새 버전 작성", exact: true }).click();
  const editor = panel.getByRole("group", { name: "답변 준비 편집", exact: true });
  const item = (n) => editor.getByRole("group", { name: "대응 항목 " + n, exact: true });
  const title = editor.getByLabel("답변 준비안 제목 *", { exact: true });
  const quote = (n) => item(n).getByLabel("대응할 요청 부분을 원문 그대로 인용 *", { exact: true });
  const summary = (n) => item(n).getByLabel("이 항목의 담당자 요약 *", { exact: true });
  const save = editor.getByRole("button", { name: "답변 준비 새 버전 저장", exact: true });
  const alert = panel.locator('p[role="alert"].text-destructive');
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
  let expectedDialogs = 0;
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(commands, []);
    assert.equal(dialogs.length, expectedDialogs);
  }
  async function invalid(message, target, keyboard = false) {
    const before = await snapshot();
    if (keyboard) {
      await save.focus();
      await page.keyboard.press("Enter");
    } else await save.click();
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('p[role="alert"].text-destructive')].some(
          (e) => e.textContent === text,
        ),
      message,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      (id) =>
        id
          ? document.activeElement?.id === id
          : document.activeElement?.getAttribute("role") === "alert",
      await target.getAttribute("id"),
      { timeout: 10000 },
    );
    assert.equal(await target.evaluate((element) => document.activeElement === element), true);
    if (target !== alert) {
      assert.equal(await target.getAttribute("aria-invalid"), "true");
      const id = await target.getAttribute("id");
      assert.ok((await target.getAttribute("aria-describedby")).split(" ").includes(id + "-error"));
      assert.equal(await page.locator(`[id="${id}-error"]`).textContent(), message);
    }
    assert.deepEqual(await snapshot(), before);
    await sound();
    await dirty(true);
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "response-validation-" + n + "-mobile.png") });
  }
  await dirty(false);
  for (let n = 1; n <= 2; n++) {
    await summary(n).fill("  " + n + "번 요약  ");
    await item(n)
      .getByLabel("부족한 자료와 확보할 이유", { exact: true })
      .fill("  " + n + "번 확보 이유\n그대로 유지  ");
    await item(n)
      .getByLabel("담당자가 검토할 답변 초안", { exact: true })
      .fill("  " + n + "번 답변 <b>문자</b>\n그대로 유지  ");
  }
  await title.fill("  ");
  await invalid("답변 준비안 제목을 1~300자로 입력해 주세요.", title);
  await invalid("답변 준비안 제목을 1~300자로 입력해 주세요.", title, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("title", title.locator(".."));
  const titleMessage = await alert.textContent();
  await title.fill("  보존할 준비안 제목  ");
  assert.equal(await alert.textContent(), titleMessage);
  assert.equal(await title.getAttribute("aria-invalid"), null);
  assert.equal(await page.locator("#response-preparation-title-error").count(), 0);
  await quote(1).fill("  \n ");
  await invalid("대응 항목 1 · 요청 원문 인용을 1~1,500자로 입력해 주세요.", quote(1), true);
  assert.ok((await quote(1).getAttribute("aria-describedby")).includes("request-match"));
  assert.ok((await quote(1).getAttribute("aria-describedby")).includes("request-comparison-note"));
  await shot("request", quote(1).locator(".."));
  await quote(1).fill(request.body);
  await summary(2).fill("   ");
  await invalid("대응 항목 2 · 담당자 요약을 1~200자로 입력해 주세요.", summary(2));
  await shot("summary", summary(2).locator(".."));
  record(
    "Invalid saves focus the exact title, request quote or second summary and attach inline errors, including repeated keyboard submission. Editing removes stale field markers, request descriptions remain linked, raw input is preserved and no business request runs.",
  );
  await summary(2).fill("  2번 요약  ");
  const planChoice = item(1).getByLabel("관련 원고 버전 (선택)", { exact: true });
  await planChoice.selectOption(plan.id);
  const sectionChoice = item(1).getByLabel("원고 항목", { exact: true });
  await invalid("대응 항목 1 · 연결할 원고 항목을 선택해 주세요.", sectionChoice);
  await sectionChoice.selectOption(section.key);
  const planQuote = item(1).getByLabel("해당 원고 부분 그대로 인용 *", { exact: true });
  await invalid("대응 항목 1 · 원고 인용을 1~1,500자로 입력해 주세요.", planQuote, true);
  await shot("plan", planQuote.locator(".."));
  const planMessage = await alert.textContent();
  await planQuote.fill(section.content);
  assert.equal(await alert.textContent(), planMessage);
  await sound();
  record(
    "Selecting an optional plan without its section or quote yields distinct first-item guidance. Correcting inputs keeps the previous message until the next explicit save, without trimming drafts or changing stored plans.",
  );
  await editor.getByRole("button", { name: "대응 항목 추가", exact: true }).click();
  await invalid("대응 항목 3 · 요청 원문 인용을 1~1,500자로 입력해 주세요.", quote(3));
  await quote(3).fill(request.body);
  await invalid("대응 항목 3 · 담당자 요약을 1~200자로 입력해 주세요.", summary(3), true);
  await shot("third", summary(3).locator(".."));
  const beforeRead = await snapshot(),
    message = await alert.textContent();
  const originalSummary = item(2).locator("summary").filter({ hasText: "기준 요청 원문 읽기" });
  await originalSummary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await originalSummary.evaluate((e) => document.activeElement === e), true);
  assert.deepEqual(await snapshot(), beforeRead);
  assert.equal(await alert.textContent(), message);
  await shot("draft", item(2).getByLabel("담당자가 검토할 답변 초안", { exact: true }));
  await dirty(true);
  await sound();
  assert.equal(caseReads, 1);
  record(
    "Newly added items receive focus at their own quote and summary. Reading a different request retains keyboard focus and all drafts, with no save or AI call.",
  );
  for (let count = 3; count > 0; count--) {
    nextDialog = "accept";
    expectedDialogs++;
    await item(count).getByRole("button", { name: "이 대응 항목 제거", exact: true }).click();
  }
  await invalid("대응 항목을 1~10개로 구성하고 중복 항목이 없는지 확인해 주세요.", alert, true);
  await shot("empty", alert);
  await editor.getByRole("button", { name: "대응 항목 추가", exact: true }).click();
  await invalid("대응 항목 1 · 요청 원문 인용을 1~1,500자로 입력해 주세요.", quote(1));
  await sound();
  record(
    "After explicitly removing all three draft items, an empty-list error focuses the alert without a guessed field. Adding a fresh item targets its new ID; stored company records and business request count remain unchanged.",
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
          "Korean first validation issue and response-item location with raw drafts preserved",
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
