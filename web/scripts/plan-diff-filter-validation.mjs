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
const scenario = "plan-diff-filter";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/plan-comparison.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/plan-diff-filter-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-plan-diff-filter-ui-"));
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
const fixtureEntry = path.join(output, "fixture-entry.mjs");
await writeFile(
  fixtureEntry,
  [
    "export { manualSourceFixture } from " +
      JSON.stringify(path.join(app, "scripts/fixtures/manual-source-receipt.ts")) +
      ";",
    "export { compareStoredPlans } from " +
      JSON.stringify(path.join(app, "src/lib/studio-plan-diff.ts")) +
      ";",
  ].join(String.fromCharCode(10)),
);
const bundle = await rolldown({
  input: fixtureEntry,
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

company.profile.companyName = "합성 원고 비교 범위 기업";
const basePlan = structuredClone(company.plans[0]);
const section = (key, title, content) => ({
  key,
  title,
  content,
  evidence: [],
  needsConfirmation: true,
});
const base = {
  ...basePlan,
  id: "a0000000-0000-4000-8000-000000000001",
  version: 1,
  confirmedAt: null,
  review: [],
  content: {
    title: "같은 원고 제목",
    summary: "같은 요약",
    sections: [
      section("same", "유지 항목", "  같은 본문\n그대로  "),
      section("changed", "변경 항목", "  기준 본문\n원래 내용  "),
      section("removed", "삭제 항목", "빠지는 원문"),
      section("duplicate", "중복 항목 A", "중복의 첫 원문"),
      section("duplicate", "중복 항목 B", "중복의 둘째 원문"),
    ],
    actionItems: Array.from({ length: 10 }, (_, i) => String(i) + "가".repeat(2990)),
    interviewQuestions: [],
  },
};
const revised = structuredClone(base);
revised.id = "a0000000-0000-4000-8000-000000000002";
revised.version = 2;
revised.content.sections[1].content = "  대조 본문\n고친 내용  ";
revised.content.sections = revised.content.sections.filter((item) => item.key !== "removed");
revised.content.sections.push(section("added", "추가 항목", "새로 있는 원문"));
revised.sourceRevision = base.sourceRevision + 1;
const identical = structuredClone(base);
identical.id = "a0000000-0000-4000-8000-000000000003";
identical.version = 3;
identical.content.sections = [section("same", "유지 항목", "  같은 본문\n그대로  ")];
identical.content.actionItems = [];
const identicalCopy = structuredClone(identical);
identicalCopy.id = "a0000000-0000-4000-8000-000000000004";
identicalCopy.version = 4;
company.plans = [base, revised, identical, identicalCopy];
const expected = fixture.compareStoredPlans(company.plans, {
  leftPlanId: base.id,
  rightPlanId: revised.id,
});
assert.equal(expected.status, "ready");
assert.equal(expected.complete, false);
for (const state of ["same", "changed", "added", "removed", "ambiguous", "limited"])
  assert.ok(expected.items.some((item) => item.state === state));
const differences = expected.items.filter((item) => item.state !== "same");
const sameExpected = fixture.compareStoredPlans(company.plans, {
  leftPlanId: identical.id,
  rightPlanId: identicalCopy.id,
});
assert.equal(sameExpected.complete, true);
assert.ok(sameExpected.items.every((item) => item.state === "same"));
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

  const panel = page.getByRole("region", { name: "저장 원고 버전 비교", exact: true });
  const left = panel.getByLabel("기준 버전 (왼쪽)", { exact: true }),
    right = panel.getByLabel("대조 버전 (오른쪽)", { exact: true });
  const compare = panel.getByRole("button", { name: "선택한 두 버전 비교", exact: true });
  const filter = panel.getByLabel("변경·확인 필요 항목만 보기", { exact: true });
  const rows = panel.locator("button[aria-expanded]");
  const rawRow = (title) =>
    rows.filter({ has: page.locator("span.font-medium").filter({ hasText: title }) });
  async function select(a, b) {
    await left.selectOption(a.id);
    await right.selectOption(b.id);
    assert.equal(await filter.count(), 0);
    await compare.click();
    await filter.waitFor({ state: "visible", timeout: 10000 });
  }
  async function checkRows(items, total) {
    assert.deepEqual(
      await panel.locator("button[aria-expanded] > span:first-child").allTextContents(),
      items.map((item) => item.title),
    );
    assert.equal(
      await panel
        .getByText("표시 " + items.length + "개 / 전체 " + total + "개", { exact: true })
        .count(),
      1,
    );
    assert.equal(commands.length, 0);
    assert.equal(dialogs.length, 0);
    assert.deepEqual(companies, original);
  }
  async function shot(filename, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, filename) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await filter.count(), 0);
  await select(base, revised);
  assert.equal(await filter.isChecked(), false);
  await checkRows(expected.items, expected.items.length);
  const changed = rawRow("변경 항목 · 본문");
  await changed.click();
  const unchangedRaw = await changed.locator("..").locator("pre").allTextContents();
  assert.deepEqual(unchangedRaw.slice(0, 2), [
    base.content.sections[1].content,
    revised.content.sections[1].content,
  ]);
  await filter.focus();
  await filter.press("Space");
  assert.equal(await filter.isChecked(), true);
  assert.equal(await changed.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await changed.locator("..").locator("pre").allTextContents(), unchangedRaw);
  await checkRows(differences, expected.items.length);
  assert.ok((await panel.textContent()).includes("전체 비교 완료가 아닙니다"));
  for (const state of ["ambiguous", "limited"]) {
    const item = differences.find((item) => item.state === state);
    assert.ok(item);
    const button = rawRow(item.title);
    assert.equal(await button.count(), 1);
    await button.click();
    assert.equal(await button.locator("..").getByText(item.note, { exact: true }).count(), 1);
    assert.equal(await button.locator("..").getByText("변경 조각", { exact: false }).count(), 0);
  }
  await shot("plan-diff-filter-attention-mobile.png", filter);
  await filter.uncheck();
  await checkRows(expected.items, expected.items.length);
  record(
    "explicit filter hides only same rows, retains changed/add/remove/context/ambiguous/limited rows and their order, and preserves expanded raw comparison and incomplete warnings",
  );

  await select(identical, identicalCopy);
  assert.equal(await filter.isChecked(), false);
  await checkRows(sameExpected.items, sameExpected.items.length);
  await filter.check();
  await checkRows([], sameExpected.items.length);
  const empty = panel.getByText(
    "변경·확인 필요 항목이 없습니다. 전체 항목은 선택을 해제해 확인할 수 있습니다.",
    { exact: true },
  );
  assert.equal(await empty.count(), 1);
  await shot("plan-diff-filter-empty-mobile.png", empty);
  await filter.focus();
  await filter.press("Space");
  assert.equal(await filter.isChecked(), false);
  assert.equal(await filter.evaluate((e) => e === document.activeElement), true);
  await checkRows(sameExpected.items, sameExpected.items.length);
  record(
    "distinct saved versions with identical compared values show an empty filtered result and keep keyboard access to restore all rows",
  );

  await select(base, revised);
  assert.equal(await filter.isChecked(), false);
  await filter.check();
  await checkRows(differences, expected.items.length);
  const planTitle = page.locator("#plan-title");
  assert.equal(await planTitle.inputValue(), identicalCopy.content.title);
  await planTitle.fill("  보존할 원고 제목 초안  ");
  assert.equal(await filter.count(), 0);
  assert.equal(await compare.isDisabled(), true);
  assert.equal(await planTitle.inputValue(), "  보존할 원고 제목 초안  ");
  await shot("plan-diff-filter-edit-mobile.png", panel);
  await planTitle.fill(identicalCopy.content.title);
  assert.equal(await filter.count(), 0);
  await select(base, revised);
  assert.equal(await filter.isChecked(), false);
  await checkRows(expected.items, expected.items.length);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 1);
  assert.equal(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
    false,
  );
  record(
    "new version selection resets display scope; manuscript edits retain draft and existing comparison block, and returning title to stored value permits a fresh explicit comparison",
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
          "saved plan comparison display filter in detailed screen; synthetic saved versions, no mutation, export or AI",
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
