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
const scenario = "question-binding";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-question-card.tsx",
  "src/components/studio/guided-question-context.ts",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/guided-answer-workflow.ts",
  "scripts/question-binding-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-question-binding-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-answer-workflow.ts"),
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
const company = fixture.answerWorkflowCompany();
company.profile.companyName = "합성 질문 자료 연결 기업";
const base = fixture.answerWorkflowSource();
const duplicateOne = {
  ...base,
  name: "중복 첫 자료",
  text: "첫 자료의 서로 다른 본문",
  kind: "technology",
};
const duplicateTwo = {
  ...base,
  name: "중복 둘째 자료",
  text: "둘째 자료의 다른 본문",
  kind: "consultation",
};
const unique = {
  ...base,
  id: "b0000000-0000-4000-8000-000000000002",
  name: "고유 본문 자료",
  text: "  고유 본문\n  <b>문자 그대로</b>  ",
};
const pending = {
  ...base,
  id: "b0000000-0000-4000-8000-000000000003",
  name: "고유 판독 대기 자료",
  text: "",
  extraction: "pending",
  originalName: "synthetic-pending.pdf",
  mimeType: "application/pdf",
};
company.sources = [duplicateOne, duplicateTwo, unique, pending];
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
    timezoneId: "Asia/Seoul",
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
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: /AI 계획서/ })
    .click();
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  await page.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  const answer = (i) => page.locator("#guided-answer-" + i);
  const card = (i) => answer(i).locator("..");
  const section = (i) => card(i).getByRole("combobox", { name: /관련 계획서 항목/ });
  const links = (i) =>
    card(i)
      .locator("details")
      .filter({ has: page.locator(":scope > summary").filter({ hasText: /^보관 자료 연결/ }) });
  const boxes = (i) => links(i).getByRole("checkbox");
  const preview = (i, n) => links(i).locator('details[aria-label="자료 ' + n + ' 저장된 본문"]');
  const snapshot = async () =>
    Promise.all(
      [0, 1].map((i) =>
        card(i)
          .locator("input,textarea,select")
          .evaluateAll((es) =>
            es.map((e) => ({
              id: e.id,
              value: e.value,
              checked: e.type === "checkbox" ? e.checked : null,
            })),
          ),
      ),
    );
  const warning =
    "자료 ID가 중복되어 새로 연결할 수 없습니다. 이미 연결한 자료는 해제할 수 있습니다.";
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
    assert.deepEqual(dialogs, []);
  }
  async function flags(i, expected) {
    assert.deepEqual(await boxes(i).evaluateAll((es) => es.map((e) => e.checked)), expected);
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "question-binding-" + n + "-mobile.png") });
  }
  await answer(1).waitFor();
  await links(0).locator(":scope > summary").click();
  assert.equal(await boxes(0).count(), 4);
  assert.equal(await boxes(0).nth(0).isDisabled(), true);
  assert.equal(await boxes(0).nth(1).isDisabled(), true);
  assert.equal(await boxes(0).nth(2).isDisabled(), false);
  assert.equal(await boxes(0).nth(3).isDisabled(), false);
  assert.equal(await links(0).getByText(warning, { exact: true }).count(), 2);
  const initial = await snapshot();
  await flags(0, [false, false, false, false]);
  await dirty(false);
  await page.setViewportSize({ width: 390, height: 844 });
  for (let n = 1; n <= 2; n++) {
    await preview(0, n).locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await preview(0, n).locator("p.whitespace-pre-wrap").textContent(),
      company.sources[n - 1].text,
    );
  }
  assert.deepEqual(await snapshot(), initial);
  await flags(0, [false, false, false, false]);
  await sound();
  await shot("ambiguous", boxes(0).nth(0));
  await shot("separate", preview(0, 2));
  record(
    "Both same-ID sources are disabled for new links and show a warning. Their individual row previews remain separately readable; reading does not select either, change any answer/section or dirty the company.",
  );
  const first = "  첫 질문 답변\n  그대로 보존  ",
    second = "  둘째 질문 답변\n추가 확인  ";
  await answer(0).fill(first);
  await section(0).selectOption("development");
  await boxes(0).nth(2).focus();
  await page.keyboard.press("Space");
  await boxes(0).nth(3).check();
  await answer(1).fill(second);
  await section(1).selectOption("problem");
  await links(1).locator(":scope > summary").click();
  await boxes(1).nth(2).check();
  await flags(0, [false, false, true, true]);
  await flags(1, [false, false, true, false]);
  const chosen = await snapshot();
  await preview(0, 3).locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await preview(0, 3).locator("p.whitespace-pre-wrap").textContent(), unique.text);
  assert.equal(await preview(0, 3).locator("b,script").count(), 0);
  await preview(0, 4).locator("summary").click();
  await preview(0, 4).getByText("저장된 본문이 없습니다.", { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), chosen);
  await dirty(true);
  await sound();
  await shot("unique", preview(0, 3));
  await shot("pending", preview(0, 4));
  await links(0).locator(":scope > summary").click();
  await links(0).locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await snapshot(), chosen);
  await boxes(0).nth(2).focus();
  await page.keyboard.press("Space");
  await flags(0, [false, false, false, true]);
  await flags(1, [false, false, true, false]);
  assert.equal(await answer(0).inputValue(), first);
  assert.equal(await answer(1).inputValue(), second);
  record(
    "Unique body and pending-source links remain explicit choices. The same unique source can be linked independently to another question, exact body reading does not change answers, and unlinking one question leaves the other question unchanged.",
  );
  const kept = await snapshot();
  await page.getByRole("button", { name: "지금은 없어요 · 나중에 답하기", exact: true }).click();
  await page.getByRole("button", { name: "보관한 답변 보기", exact: true }).click();
  assert.deepEqual(await snapshot(), kept);
  await links(0).locator(":scope > summary").click();
  await links(1).locator(":scope > summary").click();
  await flags(0, [false, false, false, true]);
  await flags(1, [false, false, true, false]);
  for (let i = 0; i < 2; i++) {
    assert.equal(await boxes(i).nth(0).isDisabled(), true);
    assert.equal(await boxes(i).nth(1).isDisabled(), true);
  }
  await dirty(true);
  await shot("returned", answer(0));
  await shot("second", answer(1));
  assert.deepEqual(await snapshot(), kept);
  await sound();
  assert.equal(caseReads, 1);
  record(
    "Deferring and reopening the answer screen keeps both raw answers, explicit section choices and independent source selections. Ambiguous new links remain disabled; no save, original read, recovery request or server mutation is attempted.",
  );
  const knownSourceKeyDiagnostic = (message) =>
    message.startsWith("Encountered two children with the same key,") &&
    message.endsWith(" " + duplicateOne.id);
  const offlineDiagnostic =
    "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
  const diagnostics = network.filter((item) => item.console);
  const duplicateDiagnostics = diagnostics.filter((item) => knownSourceKeyDiagnostic(item.console));
  const offlineDiagnostics = diagnostics.filter((item) => item.console === offlineDiagnostic);
  assert.deepEqual(
    diagnostics.filter(
      (item) => !knownSourceKeyDiagnostic(item.console) && item.console !== offlineDiagnostic,
    ),
    [],
  );
  assert.ok(offlineDiagnostics.length <= blockedDevDiagnostics.length);
  if (serverMode === "start") assert.deepEqual(diagnostics, []);
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
        consoleDiagnostics: diagnostics,
        knownSourceKeyDiagnostics: duplicateDiagnostics.length,
        offlineDiagnosticResponses: offlineDiagnostics.length,
        startingState:
          "ambiguous guided question source links and preserved independent raw answers",
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
