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
const scenario = "numeric-context";

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
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/numeric-context-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-context-ui-"));
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
  input: path.join(app, "scripts/fixtures/manual-source-receipt.ts"),
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
const company = fixture.manualSourceFixture().company;
company.profile.companyName = "합성 수치 입력 보존 기업";
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
  dialogs = [],
  focusChecks = [];
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
  await panel.getByRole("button", { name: "새 미검토 수치 대조", exact: true }).click();
  const title = panel.getByLabel("대조안 제목 *", { exact: true });
  const observation = panel.getByRole("group", { name: "관측 수치 1", exact: true });
  const unit = observation.getByLabel("단위 직접 확인", { exact: true });
  const custom = observation.getByLabel("기타 단위의 정확한 표기 *", { exact: true });
  const period = observation.getByLabel("기준일·기간", { exact: true });
  const startDate = observation.locator('input[id$="-start"]');
  const endDate = observation.locator('input[id$="-end"]');
  const value = observation.getByLabel("원문 숫자 표기 (미확인은 비움)", { exact: true });
  const label = observation.getByLabel("수치 이름 *", { exact: true });
  const note = observation.getByLabel("출처 해석·범위·가정 메모 (수동)", { exact: true });
  const quote = observation.getByLabel("수치가 포함된 원문 그대로 인용 *", { exact: true });
  const locator = observation.getByLabel("자료 쪽·위치", { exact: true });
  const judgement = panel.getByLabel("판단 메모·미해결 사항", { exact: true });
  const unitMessage = "작성한 기타 단위명을 비우고 단위를 변경할까요?";
  const periodMessage = "작성한 날짜를 비우고 기준일·기간 구분을 변경할까요?";
  const source = company.sources.find((item) => item.extraction !== "pending");
  assert.ok(source);
  const draft = {
    title: "  합성 대조안  ",
    label: "  사용자 수  ",
    value: "1,200",
    note: "  수동 범위\n메모  ",
    quote: "  합성 인용\n보존  ",
    locator: "  합성 2쪽  ",
    judgement: "  아직 확인하지 않은 메모  ",
  };
  await title.fill(draft.title);
  await label.fill(draft.label);
  await value.fill(draft.value);
  await note.fill(draft.note);
  await judgement.fill(draft.judgement);
  await observation.getByLabel("정확한 인용 연결", { exact: true }).selectOption("source");
  await observation.getByLabel("같은 회사 자료 *", { exact: true }).selectOption(source.id);
  await quote.fill(draft.quote);
  await locator.fill(draft.locator);
  async function preserved() {
    assert.deepEqual(
      {
        title: await title.inputValue(),
        label: await label.inputValue(),
        value: await value.inputValue(),
        note: await note.inputValue(),
        quote: await quote.inputValue(),
        locator: await locator.inputValue(),
        judgement: await judgement.inputValue(),
      },
      draft,
    );
    assert.equal(
      await observation.getByLabel("같은 회사 자료 *", { exact: true }).inputValue(),
      source.id,
    );
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.equal(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      true,
    );
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, name) });
  }
  async function change(select, next, action, message) {
    const before = dialogs.length;
    nextDialog = action;
    await select.selectOption(next);
    assert.equal(dialogs.length, before + 1);
    assert.deepEqual(dialogs.at(-1), { message, action });
    await preserved();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await unit.selectOption("custom");
  assert.equal(dialogs.length, 0);
  await custom.fill("  명/월  ");
  await change(unit, "person", "dismiss", unitMessage);
  assert.equal(await unit.inputValue(), "custom");
  assert.equal(await custom.inputValue(), "  명/월  ");
  await shot("numeric-context-unit-kept-mobile.png", custom);
  await change(unit, "person", "accept", unitMessage);
  assert.equal(await unit.inputValue(), "person");
  assert.equal(await custom.count(), 0);
  await unit.selectOption("custom");
  assert.equal(await custom.inputValue(), "");
  assert.equal(dialogs.length, 2);
  record(
    "nonempty custom unit prompts before clearing; dismissal preserves unit and exact raw text, acceptance changes only the unit context",
  );

  await period.selectOption("range");
  await startDate.fill("2026-01-01");
  await endDate.fill("2026-09-30");
  await change(period, "point", "dismiss", periodMessage);
  assert.equal(await period.inputValue(), "range");
  assert.equal(await startDate.inputValue(), "2026-01-01");
  assert.equal(await endDate.inputValue(), "2026-09-30");
  await shot("numeric-context-period-kept-mobile.png", startDate);
  await change(period, "point", "accept", periodMessage);
  assert.equal(await period.inputValue(), "point");
  assert.equal(await startDate.inputValue(), "");
  assert.equal(await endDate.count(), 0);
  await startDate.fill("2026-10-12");
  await change(period, "not-applicable", "dismiss", periodMessage);
  assert.equal(await period.inputValue(), "point");
  assert.equal(await startDate.inputValue(), "2026-10-12");
  await change(period, "not-applicable", "accept", periodMessage);
  assert.equal(await startDate.count(), 0);
  assert.equal(await endDate.count(), 0);
  record(
    "range dates and a single reference date are retained after dismissal; acceptance retains the existing clear-dates behavior without altering numeric value or source quote",
  );

  await custom.fill("   ");
  await change(unit, "unknown", "dismiss", unitMessage);
  assert.equal(await custom.inputValue(), "   ");
  await change(unit, "unknown", "accept", unitMessage);
  assert.equal(await custom.count(), 0);
  const count = dialogs.length;
  await unit.selectOption("custom");
  assert.equal(await custom.inputValue(), "");
  await unit.selectOption("item");
  await period.selectOption("range");
  assert.equal(await startDate.inputValue(), "");
  assert.equal(await endDate.inputValue(), "");
  await endDate.fill("2026-12-31");
  await change(period, "unknown", "dismiss", periodMessage);
  assert.equal(await startDate.inputValue(), "");
  assert.equal(await endDate.inputValue(), "2026-12-31");
  await change(period, "unknown", "accept", periodMessage);
  assert.equal(dialogs.length, count + 2);
  await period.selectOption("point");
  assert.equal(await startDate.inputValue(), "");
  await period.selectOption("unknown");
  assert.equal(dialogs.length, 10);
  await preserved();
  await shot("numeric-context-final-mobile.png", unit);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 1);
  assert.deepEqual(companies, original);
  record(
    "whitespace-only custom text and an end date alone still require confirmation; empty unit/date transitions add no confirmation or request",
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
        focusChecks,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "numeric unit and period input preservation in detailed screen; memory company only, no mutation, export or AI",
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
