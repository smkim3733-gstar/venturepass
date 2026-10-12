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
const scenario = "review-body-context";

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
  "scripts/review-body-context-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-review-body-ui-"));
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
company.profile.companyName = "합성 검토 대상 본문 기업";
const plan = company.plans[1],
  template = plan.content.sections[0];
plan.content.sections = [
  {
    ...structuredClone(template),
    key: "one",
    title: "같은 항목 이름",
    content:
      "  첫째 저장 본문\n<script>window.reviewBodyExecuted=true</script>\n" +
      Array.from({ length: 40 }, (_, i) => "합성 원고 내용 " + (i + 1)).join("\n") +
      "\n첫째 마지막 문장  ",
  },
  {
    ...structuredClone(template),
    key: "two",
    title: "같은 항목 이름",
    content: "  둘째 저장 본문\n서로 다른 검토 대상입니다.  ",
  },
  {
    ...structuredClone(template),
    key: "duplicate",
    title: "임의 첫 연결",
    content: "표시하면 안 되는 첫 본문",
  },
  {
    ...structuredClone(template),
    key: "duplicate",
    title: "임의 둘째 연결",
    content: "표시하면 안 되는 둘째 본문",
  },
];
plan.review = ["one", "two", null, "missing", "duplicate"].map((sectionKey, i) => ({
  ...structuredClone(plan.review[1]),
  id: "context-" + i,
  message: "합성 검토 의견 " + (i + 1),
  action: "해당 원고와 근거를 대조하세요.",
  sectionKey,
}));
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
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
  await page.getByRole("button", { name: "검토 의견 확인하기", exact: true }).click();
  const choose = page.getByLabel("판단할 검토 의견 직접 선택", { exact: true });
  const readToggle = () =>
    page.locator("summary").filter({ hasText: /^판단 대상 원고 본문 확인$/ });
  const body = () => page.getByRole("region", { name: "판단 대상 저장 본문", exact: true });
  assert.equal(await choose.inputValue(), "");
  assert.equal(await readToggle().count(), 0);
  await choose.selectOption("0");
  assert.equal(await readToggle().count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await readToggle().focus();
  await readToggle().press("Enter");
  assert.equal(await body().textContent(), plan.content.sections[0].content);
  assert.equal(await body().locator("script").count(), 0);
  assert.equal(await page.evaluate(() => globalThis.reviewBodyExecuted), undefined);
  assert.equal(
    await page.getByText("원고 v2 · 항목 1: 같은 항목 이름", { exact: true }).count(),
    1,
  );
  await body().focus();
  await page.screenshot({ path: path.join(output, "review-body-start-mobile.png") });
  await body().press("End");
  await page.waitForFunction(() => {
    const e = document.querySelector('[aria-label="판단 대상 저장 본문"]');
    return e && e.scrollTop + e.clientHeight >= e.scrollHeight - 2;
  });
  await page.screenshot({ path: path.join(output, "review-body-end-mobile.png") });
  assert.equal(dialogs.length, 0);
  assert.equal(commands.length, 0);
  record(
    "selected opinion exposes its unique stored v2 section, preserves exact whitespace and literal HTML, and supports keyboard reading without selecting a judgement",
  );

  const reviewer = page.getByLabel("판단 담당자 *", { exact: true }),
    reason = page.getByLabel("확인한 내용과 판단 이유 *", { exact: true }),
    status = page.getByLabel("처리 상태", { exact: true });
  const draft = {
    reviewer: "  합성 검토 담당자  ",
    reason: "  근거를 더 확인하는 중입니다.\n아직 저장하지 않았습니다.  ",
    status: "deferred",
  };
  await reviewer.fill(draft.reviewer);
  await reason.fill(draft.reason);
  await status.selectOption(draft.status);
  await readToggle().click();
  await readToggle().click();
  assert.equal(await body().textContent(), plan.content.sections[0].content);
  await choose.selectOption("1");
  assert.equal(dialogs.length, 1);
  assert.equal(await choose.inputValue(), "0");
  assert.equal(await reviewer.inputValue(), draft.reviewer);
  assert.equal(await reason.inputValue(), draft.reason);
  assert.equal(await status.inputValue(), draft.status);
  await reason.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, "review-body-draft-mobile.png") });
  nextDialog = "accept";
  await choose.selectOption("1");
  assert.equal(dialogs.length, 2);
  assert.equal(await readToggle().locator("..").getAttribute("open"), null);
  await readToggle().click();
  assert.equal(await body().textContent(), plan.content.sections[1].content);
  assert.equal(
    await page.getByText("원고 v2 · 항목 2: 같은 항목 이름", { exact: true }).count(),
    1,
  );
  assert.equal(await reviewer.inputValue(), "");
  assert.equal(await reason.inputValue(), "");
  record(
    "reading preserves status, reviewer and reason; rejected opinion change keeps its target, accepted existing discard shows the other same-title section collapsed",
  );

  for (const value of ["2", "3", "4"]) {
    await choose.selectOption(value);
    assert.equal(await readToggle().count(), 0);
    assert.equal(await body().count(), 0);
    assert.equal(
      await page
        .getByText(
          "이 의견의 원고 항목을 하나로 확인하지 못했습니다. 전체 원고에서 확인해 주세요.",
          { exact: true },
        )
        .count(),
      1,
    );
    assert.equal(await page.getByText("표시하면 안 되는 첫 본문", { exact: true }).count(), 0);
    assert.equal(await page.getByText("표시하면 안 되는 둘째 본문", { exact: true }).count(), 0);
  }
  await page
    .getByText("이 의견의 원고 항목을 하나로 확인하지 못했습니다. 전체 원고에서 확인해 주세요.", {
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, "review-body-unlinked-mobile.png") });
  await page.getByRole("button", { name: "원고로 돌아가기", exact: true }).click();
  await page.getByRole("button", { name: "의견 1: 합성 검토 의견 1", exact: true }).click();
  assert.equal(await choose.inputValue(), "0");
  assert.equal(await readToggle().locator("..").getAttribute("open"), null);
  await readToggle().click();
  assert.equal(await body().textContent(), plan.content.sections[0].content);
  assert.equal(dialogs.length, 2);
  assert.equal(caseReads, 1);
  assert.equal(commands.length, 0);
  assert.deepEqual(companies, original);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  record(
    "unlinked, missing and duplicate section keys never select arbitrary content; explicit return/reopen restores a collapsed unique context without mutation",
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
          "explicit review context reading in simple screen; synthetic memory only, no mutation, export or AI",
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
