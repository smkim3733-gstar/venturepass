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
const scenario = "review-history-filter";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/plan-review-decisions.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/guided-review-link.ts",
  "scripts/review-history-filter-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-review-history-filter-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-review-link.ts"),
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
const company = fixture.reviewLinkCompany();
company.profile.companyName = "합성 검토 판단 이력 기업";
const plan = company.plans[1];
const uid = (n) => "b0000000-0000-4000-8000-" + String(n).padStart(12, "0");
company.planReviewDecisions = ["deferred", "resolved", "deferred"].map((status, i) => ({
  id: uid(1 + i),
  rootId: uid(i === 1 ? 2 : 1),
  version: i === 2 ? 2 : 1,
  clientRequestId: uid(10 + i),
  inputDigest: "a".repeat(64),
  planId: plan.id,
  planVersion: plan.version,
  findingIndex: i === 1 ? 2 : 1,
  finding: structuredClone(plan.review[i === 1 ? 2 : 1]),
  previousRecordId: i === 2 ? uid(1) : null,
  status,
  reason: [
    "첫 보류 이유\n  자료 대조가 남았습니다.",
    "<b>저장된 담당자 판단</b>\n  사실 확인 보증 아님",
    "두 번째 보류 이유\n  추가 자료를 기다립니다.",
  ][i],
  reviewer: "합성 담당 " + (i + 1),
  recordedAt: "2026-10-10T0" + i + ":00:00.000Z",
  origin: "manual",
  reviewKey: "b".repeat(64),
  planContentSha256: "c".repeat(64),
  findingSha256: "d".repeat(64),
  planSourceRevision: plan.sourceRevision,
  evidenceRevision: company.revision,
  evidenceFingerprint: "e".repeat(64),
  stale: i === 1,
  staleReasons: i === 1 ? ["evidence-changed"] : [],
}));
// An older manuscript record is retained but must not enter the active manuscript history.
company.planReviewDecisions.push({
  ...structuredClone(company.planReviewDecisions[0]),
  id: uid(30),
  rootId: uid(30),
  clientRequestId: uid(31),
  planId: company.plans[0].id,
  planVersion: company.plans[0].version,
  reason: "다른 원고 이력",
});

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
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
  await page.getByRole("button", { name: "검토 의견 확인하기", exact: true }).click();
  const panel = page.getByRole("region", { name: "검토 의견 처리 이력", exact: true });
  const history = panel
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: /^원고 v2의 판단 이력 3개$/ }) })
    .first();
  const filter = history.getByLabel("저장 당시 처리 상태로 이력 보기", { exact: true });
  const articles = () => history.locator("article");
  const ids = async () => articles().locator("h4").allTextContents();
  const reasons = async () =>
    articles()
      .locator("p")
      .filter({ hasText: /^판단 이유:/ })
      .allTextContents();
  const current = company.planReviewDecisions.filter((r) => r.planId === plan.id);
  const expected = (status = "") =>
    current
      .filter((r) => !status || r.status === status)
      .slice()
      .reverse();
  const labels = { deferred: "보류", resolved: "담당자 해결 판단", pending: "확인 필요" };
  async function matches(status = "") {
    const records = expected(status);
    assert.deepEqual(
      await ids(),
      records.map((r) => labels[r.status] + " · 판단 v" + r.version),
    );
    assert.deepEqual(
      await reasons(),
      records.map((r) => "판단 이유: " + r.reason),
    );
    assert.equal(
      await history.getByRole("status").textContent(),
      "표시 " + records.length + " / 전체 3개",
    );
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(commands.length, 0);
  }
  const draftSnapshot = () =>
    panel
      .locator("fieldset input,fieldset textarea,fieldset select")
      .evaluateAll((els) => els.map((e) => ({ id: e.id, value: e.value })));
  async function dirty(expected) {
    const result = await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    assert.equal(result, expected);
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
      path: path.join(output, "review-history-filter-" + n + "-mobile.png"),
    });
  }
  await filter.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await filter.inputValue(), "");
  await matches();
  await dirty(false);
  assert.equal(await history.getByText("다른 원고 이력", { exact: false }).count(), 0);
  await filter.selectOption("deferred");
  await matches("deferred");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("deferred", filter);
  await dirty(false);
  await filter.selectOption("resolved");
  await matches("resolved");
  assert.equal(await articles().locator("b,script").count(), 0);
  assert.ok((await articles().textContent()).includes("재검토 필요"));
  await shot("resolved", articles().first());
  record(
    "Saved-status filtering retains every matching historical version in reverse stored order, excludes other manuscript records, and preserves literal reason text and stale warnings without marking a draft dirty.",
  );

  await filter.selectOption("pending");
  await matches("pending");
  await history
    .getByText("이 상태로 저장된 판단 이력이 없습니다.", { exact: true })
    .waitFor({ state: "visible" });
  await shot("empty", filter);
  const reset = history.getByRole("button", { name: "모든 상태 보기", exact: true });
  await reset.focus();
  await page.keyboard.press("Enter");
  assert.equal(await filter.inputValue(), "");
  await matches();
  assert.equal(await filter.evaluate((e) => e === document.activeElement), true);
  assert.equal(await reset.count(), 0);
  await dirty(false);
  record(
    "A status with no saved records shows zero/total and a clear empty-state message; keyboard reset restores all saved history and focuses the filter without requests or confirmation.",
  );

  await panel.getByLabel("판단할 검토 의견 직접 선택", { exact: true }).selectOption("1");
  await panel.getByLabel("판단 담당자 *", { exact: true }).fill("  합성 작성자  ");
  await panel
    .getByLabel("확인한 내용과 판단 이유 *", { exact: true })
    .fill("  작성 중 이유\n아직 저장하지 않음  ");
  await panel.getByLabel("처리 상태", { exact: true }).selectOption("pending");
  const draft = await draftSnapshot();
  await filter.selectOption("deferred");
  await matches("deferred");
  assert.deepEqual(await draftSnapshot(), draft);
  await dirty(true);
  await history.locator(":scope > summary").click();
  await history.locator(":scope > summary").click();
  assert.equal(await filter.inputValue(), "deferred");
  await matches("deferred");
  assert.deepEqual(await draftSnapshot(), draft);
  await filter.focus();
  await page.keyboard.press("Home");
  await matches();
  assert.equal(await filter.evaluate((e) => e === document.activeElement), true);
  assert.deepEqual(await draftSnapshot(), draft);
  await shot("draft", panel.getByLabel("확인한 내용과 판단 이유 *", { exact: true }));
  await panel.getByLabel("판단 담당자 *", { exact: true }).fill("");
  await panel.getByRole("button", { name: "검토 판단 이력 저장", exact: true }).click();
  const error = panel.getByRole("alert");
  assert.equal(
    await error.textContent(),
    "담당자와 판단 이유를 입력하고 검토 대상을 확인해 주세요.",
  );
  const invalid = await draftSnapshot();
  await filter.selectOption("pending");
  await matches("pending");
  assert.deepEqual(await draftSnapshot(), invalid);
  assert.equal(
    await error.textContent(),
    "담당자와 판단 이유를 입력하고 검토 대상을 확인해 주세요.",
  );
  await shot("error-kept", filter);
  assert.equal(dialogs.length, 0);
  assert.equal(caseReads, 1);
  await dirty(true);
  record(
    "Reading, collapsing and changing the history filter never changes the draft opinion, status, reviewer or raw reason; existing validation error and unsaved protection persist while the saved-status list can be empty independently.",
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
          "saved review history status filtering; synthetic memory records with draft preservation, no saved changes",
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
