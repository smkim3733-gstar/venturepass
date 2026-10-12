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
const scenario = "numeric-cancel";

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
  "scripts/numeric-cancel-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-cancel-ui-"));
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
company.profile.companyName = "합성 수치 편집 취소 기업";

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
  const cancel = () => editor.getByRole("button", { name: "편집 취소", exact: true });
  const title = () => editor.getByLabel("대조안 제목 *", { exact: true });
  const note = () => editor.getByLabel("판단 메모·미해결 사항", { exact: true });
  const judgement = () => editor.getByLabel("이번 버전의 내부 판단", { exact: true });
  const reviewer = () => editor.getByLabel("판단 담당자", { exact: true });
  const observation = () => editor.getByRole("group", { name: "관측 수치 1", exact: true });
  const snapshot = () =>
    editor
      .locator("input, textarea, select")
      .evaluateAll((items) => items.map((item) => ({ id: item.id, value: item.value })));
  async function dirty(expected) {
    await page.waitForFunction(
      (expected) => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented === expected;
      },
      expected,
      { timeout: 10000 },
    );
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
  }
  async function openNew() {
    await panel.getByRole("button", { name: "새 미검토 수치 대조", exact: true }).click();
    await title().waitFor({ state: "visible" });
  }
  async function openExisting() {
    await panel.getByRole("button", { name: "이 대조안의 새 버전 작성", exact: true }).click();
    await title().waitFor({ state: "visible" });
  }
  async function noChangeCancel() {
    const count = dialogs.length;
    await cancel().click();
    await title().waitFor({ state: "hidden" });
    assert.equal(dialogs.length, count);
    await dirty(false);
  }
  async function ask(action, keyboard = false) {
    const count = dialogs.length;
    nextDialog = action;
    if (keyboard) {
      await cancel().focus();
      await page.keyboard.press("Enter");
    } else await cancel().click();
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), {
      action,
      message: "저장하지 않은 수치·인용·비교쌍·산식과 판단 입력을 취소할까요?",
    });
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const box = await target.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
    await page.screenshot({ path: path.join(output, "numeric-cancel-" + name + "-mobile.png") });
  }
  await openNew();
  await noChangeCancel();
  await openNew();
  await title().fill("  새 수치 입력  ");
  await observation().getByLabel("수치 이름 *", { exact: true }).fill("  월별 수량  ");
  await observation().getByLabel("원문 숫자 표기 (미확인은 비움)", { exact: true }).fill("1,200");
  await observation()
    .getByLabel("출처 해석·범위·가정 메모 (수동)", { exact: true })
    .fill("  수치 메모\n원문 유지  ");
  await note().fill("  새 판단 메모\n유지  ");
  await editor.getByRole("button", { name: "수치 비교쌍 추가", exact: true }).click();
  await editor.getByRole("button", { name: "산식 추가", exact: true }).click();
  const newDraft = await snapshot();
  await page.setViewportSize({ width: 390, height: 844 });
  await ask("dismiss");
  assert.deepEqual(await snapshot(), newDraft);
  await dirty(true);
  await shot("new", note());
  await ask("accept", true);
  await title().waitFor({ state: "hidden" });
  await dirty(false);
  record(
    "Untouched new numeric editor closes without a dialog; rejecting cancellation preserves raw new observation, incomplete comparison/formula and judgement notes; keyboard acceptance closes without a request",
  );

  await openExisting();
  const initial = await snapshot();
  await noChangeCancel();
  await openExisting();
  assert.deepEqual(await snapshot(), initial);
  await judgement().selectOption("needs-work");
  const judgmentOnly = await snapshot();
  await ask("dismiss");
  assert.deepEqual(await snapshot(), judgmentOnly);
  await dirty(true);
  await shot("judgement", judgement());
  await judgement().selectOption("unreviewed");
  assert.deepEqual(await snapshot(), initial);
  await noChangeCancel();
  await openExisting();
  await note().fill(" \n ");
  const whitespace = await snapshot();
  await ask("dismiss");
  assert.deepEqual(await snapshot(), whitespace);
  await dirty(true);
  await note().fill("");
  assert.deepEqual(await snapshot(), initial);
  await noChangeCancel();
  record(
    "Untouched existing version and inputs reverted exactly to their starting values close freely; judgement-only and whitespace-only notes are protected without changing stored review or numeric records",
  );

  await openExisting();
  await title().fill("");
  await observation()
    .getByLabel("원문 숫자 표기 (미확인은 비움)", { exact: true })
    .fill("1,200.50");
  await observation()
    .getByLabel("출처 해석·범위·가정 메모 (수동)", { exact: true })
    .fill("  기존 수치 메모\n유지  ");
  await reviewer().fill("  수치 담당자  ");
  await note().fill("  검토 메모\n계산 확인  ");
  await editor
    .getByRole("group", { name: "산식 1", exact: true })
    .getByRole("button", { name: "합계 항 추가", exact: true })
    .click();
  await judgement().selectOption("needs-work");
  const failedDraft = await snapshot();
  await editor.getByRole("button", { name: "수치 대조 버전 저장", exact: true }).click();
  const alert = editor.getByRole("alert");
  await alert.waitFor({ state: "visible" });
  const alertText = await alert.textContent();
  assert.ok(alertText);
  assert.equal(commands.length, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await ask("dismiss");
  assert.deepEqual(await snapshot(), failedDraft);
  assert.equal(await alert.textContent(), alertText);
  await dirty(true);
  await shot("error-kept", cancel());
  await ask("accept");
  await title().waitFor({ state: "hidden" });
  await dirty(false);
  await openExisting();
  assert.deepEqual(await snapshot(), initial);
  assert.equal(await editor.getByRole("alert").count(), 0);
  await noChangeCancel();
  assert.equal(dialogs.length, 6);
  assert.equal(dialogs.filter((d) => d.action === "dismiss").length, 4);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  record(
    "After a local invalid-input save attempt, rejection preserves the entire existing-version draft, formula selections and error; acceptance closes and reopening restores stored baseline with fresh unreviewed judgement, without server requests",
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
          "numeric editor cancellation, original receipt fixture with a new empty editor and existing version; no API mutation",
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
