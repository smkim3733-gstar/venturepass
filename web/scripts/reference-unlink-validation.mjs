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
const scenario = "reference-unlink";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/appeal-preparation.tsx",
  "src/components/studio/claim-reviews.tsx",
  "scripts/fixtures/claim-review-receipt.ts",
  "scripts/reference-unlink-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-reference-unlink-ui-"));
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
  input: path.join(app, "scripts/fixtures/claim-review-receipt.ts"),
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
const company = fixture.claimReceiptFixture().company;
company.profile.companyName = "합성 자료 연결 해제 기업";
const now = "2026-10-12T20:00:00.000Z";
const sources = [
  {
    id: fixture.agencyId(390),
    name: "첫째 합성 자료",
    kind: "technology",
    text: "  첫째 등록 본문\n대조 자료  ",
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: fixture.agencyId(391),
    name: "둘째 합성 자료",
    kind: "finance",
    text: "  둘째 등록 본문\n별도 자료  ",
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  },
];
company.sources.push(...sources);

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
  const panel = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
  await panel
    .getByRole("button", { name: "이 주장 v1에서 새 검토 버전 작성", exact: true })
    .click();
  const editor = panel.getByRole("group", {
    name: "기존 주장 새 버전 · 판단 미검토로 시작",
    exact: true,
  });
  const refs = editor.getByRole("group", { name: "대조할 등록 자료", exact: true });
  const chooser = refs.getByLabel("연결할 자료", { exact: true });
  const cards = () => refs.locator(":scope > div");
  const control = (name) => editor.getByLabel(name, { exact: true });
  const quote = (i) =>
    cards().nth(i).getByLabel("등록 본문 그대로 인용 (원본만 연결하면 비움)", { exact: true });
  const locator = (i) => cards().nth(i).getByLabel("쪽·위치 (선택)", { exact: true });
  const remove = (i) =>
    cards().nth(i).getByRole("button", { name: "이 자료 연결 해제", exact: true });
  const message = "작성한 인용·쪽/위치 입력과 이 자료 연결을 해제할까요?";
  async function judgement() {
    await control("이번 버전의 담당자 판단").selectOption("insufficient");
    await control("판단자").fill("  판단 담당자  ");
    await control("판단 이유").fill("  남겨 둔 판단\n근거 확인 필요  ");
    await control("판단 확인일 (직접 입력)").fill("2026-10-12");
  }
  async function assertJudgement(kept) {
    assert.equal(
      await control("이번 버전의 담당자 판단").inputValue(),
      kept ? "insufficient" : "unreviewed",
    );
    for (const [label, value] of [
      ["판단자", "  판단 담당자  "],
      ["판단 이유", "  남겨 둔 판단\n근거 확인 필요  "],
      ["판단 확인일 (직접 입력)", "2026-10-12"],
    ])
      assert.equal(await control(label).inputValue(), kept ? value : "");
  }
  async function confirmRemove(i, action, keyboard = false) {
    const count = dialogs.length;
    nextDialog = action;
    if (keyboard) {
      await remove(i).focus();
      await remove(i).press("Enter");
    } else await remove(i).click();
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), { message, action });
  }
  async function preserved() {
    assert.equal(await control("확인 담당자 (수동 기록)").inputValue(), "  확인 담당자  ");
    assert.equal(
      await control("기업·기간·단위·범위 해석 메모").inputValue(),
      "  확인 범위\n유지할 메모  ",
    );
    assert.deepEqual(companies, original);
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
  async function remaining() {
    assert.equal(await cards().nth(0).locator("p").first().textContent(), sources[1].name);
    assert.equal(await quote(0).inputValue(), "  둘째 인용\n보존  ");
    assert.equal(await locator(0).inputValue(), "  둘째 3쪽  ");
    assert.equal(
      await chooser.locator('option[value="' + sources[0].id + '"]').isDisabled(),
      false,
    );
    assert.equal(await chooser.locator('option[value="' + sources[1].id + '"]').isDisabled(), true);
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const el of [refs, chooser, target]) {
      const b = await el.boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= 391, "reference controls fit mobile");
    }
    await page.screenshot({ path: path.join(output, "reference-unlink-" + name + "-mobile.png") });
  }
  await control("확인 담당자 (수동 기록)").fill("  확인 담당자  ");
  await control("기업·기간·단위·범위 해석 메모").fill("  확인 범위\n유지할 메모  ");
  await chooser.selectOption(sources[0].id);
  await chooser.selectOption(sources[1].id);
  await quote(0).fill("  첫째 인용\n보존  ");
  await locator(0).fill("  첫째 2쪽  ");
  await quote(1).fill("  둘째 인용\n보존  ");
  await locator(1).fill("  둘째 3쪽  ");
  await judgement();
  await confirmRemove(0, "dismiss");
  assert.equal(await cards().count(), 2);
  assert.equal(await quote(0).inputValue(), "  첫째 인용\n보존  ");
  assert.equal(await locator(0).inputValue(), "  첫째 2쪽  ");
  assert.equal(await quote(1).inputValue(), "  둘째 인용\n보존  ");
  assert.equal(await locator(1).inputValue(), "  둘째 3쪽  ");
  await assertJudgement(true);
  await preserved();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("kept", quote(0));
  await confirmRemove(0, "accept", true);
  assert.equal(await cards().count(), 1);
  await remaining();
  await assertJudgement(false);
  await preserved();
  await shot("remaining", quote(0));
  record(
    "Rejecting unlink keeps both exact citations/locators and the full existing-claim judgement; keyboard acceptance removes only the first reference and follows the original judgement reset",
  );

  await chooser.selectOption(sources[0].id);
  const emptyCount = dialogs.length;
  await remove(1).click();
  assert.equal(dialogs.length, emptyCount);
  assert.equal(await cards().count(), 1);
  await remaining();
  await chooser.selectOption(sources[0].id);
  await locator(1).fill("   ");
  await judgement();
  await confirmRemove(1, "dismiss");
  assert.equal(await quote(1).inputValue(), "");
  assert.equal(await locator(1).inputValue(), "   ");
  await assertJudgement(true);
  await confirmRemove(1, "accept");
  assert.equal(await cards().count(), 1);
  await remaining();
  await assertJudgement(false);
  await chooser.selectOption(sources[0].id);
  await quote(1).fill(" \n ");
  await judgement();
  await confirmRemove(1, "dismiss");
  assert.equal(await quote(1).inputValue(), " \n ");
  assert.equal(await locator(1).inputValue(), "");
  await assertJudgement(true);
  await preserved();
  await shot("whitespace", quote(1));
  await confirmRemove(1, "accept");
  assert.equal(await cards().count(), 1);
  await remaining();
  await assertJudgement(false);
  await preserved();
  record(
    "A just-added empty reference unlinks without a dialog; locator-only spaces and quote-only whitespace are protected, while the unrelated second reference retains its ID and exact inputs",
  );

  await control("주장 문장을 원문 그대로 인용 *").fill("");
  await judgement();
  await editor.getByRole("button", { name: "주장 검토 새 버전 저장", exact: true }).click();
  const alert = editor.getByRole("alert");
  const errorText = "정확한 원고·인용·자료 버전과 길이, 날짜, 판단 필수 항목을 확인해 주세요.";
  await alert.getByText(errorText, { exact: true }).waitFor();
  assert.equal(commands.length, 0);
  await confirmRemove(0, "dismiss");
  await alert.getByText(errorText, { exact: true }).waitFor();
  await remaining();
  await assertJudgement(true);
  await preserved();
  assert.equal(await control("주장 문장을 원문 그대로 인용 *").inputValue(), "");
  await shot("error-kept", alert);
  await confirmRemove(0, "accept");
  assert.equal(await cards().count(), 0);
  assert.equal(await alert.count(), 0);
  await assertJudgement(false);
  await preserved();
  for (const source of sources)
    assert.equal(await chooser.locator('option[value="' + source.id + '"]').isDisabled(), false);
  assert.equal(dialogs.length, 8);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  record(
    "After a client-side empty-claim save error with no request, rejected unlink keeps the error, remaining citation and judgement; acceptance clears that edit/error without modifying saved company state",
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
          "shared reference unlink guards in existing claim editor; two memory sources, exact quote/locator and judgement preservation; no API mutation",
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
