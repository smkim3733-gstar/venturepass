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
const scenario = "claim-list-filter";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/claim-reviews.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/claim-review-receipt.ts",
  "scripts/claim-list-filter-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-claim-list-filter-ui-"));
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
const prepared = fixture.claimReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 주장 검토 목록 필터 기업";
const originalClaim = company.claimReviews[0];
const plan = company.plans.at(-1);
const quote = plan.content.sections[0].content;
const id = (n) => "40000000-0000-4000-8000-" + String(n).padStart(12, "0");
function make(n, state) {
  const r = structuredClone(originalClaim);
  Object.assign(r, {
    id: id(n),
    claimId: id(n),
    version: 1,
    previousVersionId: null,
    clientRequestId: id(n + 100),
    claimQuote: quote,
    method: state === "unreviewed" ? "unreviewed" : "document",
    contextNote: "합성 목록용 " + n,
    owner: "합성 담당자 " + n,
  });
  r.judgement = {
    state,
    reviewer: state === "unreviewed" ? "" : "합성 판단자",
    reason: state === "unreviewed" ? "" : "합성 저장 판단",
    checkedOn: state === "unreviewed" ? "" : "2026-10-12",
    recordedAt: state === "unreviewed" ? null : originalClaim.recordedAt,
  };
  return r;
}
const current = make(1, "consistent");
current.claimId = originalClaim.claimId;
current.previousVersionId = originalClaim.id;
current.version = 2;
const unreviewed = make(2, "unreviewed"),
  missing = make(3, "conflict"),
  insufficient = make(4, "insufficient"),
  stale = make(5, "consistent");
missing.planId = id(900);
stale.claimQuote = "현재 원고에 없는 과거 주장";
company.claimReviews.push(current, unreviewed, missing, insufficient, stale);
const expectedAll = [stale, insufficient, missing, unreviewed, current];
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
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/preparation-automation")),
    page.getByRole("button", { name: "상세 도구", exact: true }).click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  const panel = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
  const state = panel.getByLabel("저장 당시 담당자 판단으로 최신 주장 보기", { exact: true });
  const recheck = panel.getByLabel("연결 문맥 재확인 필요만", { exact: true });
  const reset = panel.getByRole("button", { name: "주장 목록 조건 초기화", exact: true });
  const editor = panel
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "기존 주장 새 버전" }) });
  const older = panel
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "과거 주장 검토 1개 버전" }) });
  const snapshot = () =>
    editor
      .locator("input,textarea,select")
      .evaluateAll((es) =>
        es.map((e) => ({
          id: e.id,
          value: e.value,
          checked: e.type === "checkbox" ? e.checked : null,
          selected: e.multiple ? [...e.selectedOptions].map((o) => o.value) : null,
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
    assert.deepEqual(dialogs, []);
  }
  async function result(records) {
    await panel
      .getByText("최신 주장 표시 " + records.length + "개 / 전체 5개", { exact: true })
      .waitFor();
    assert.deepEqual(
      await panel
        .locator(':scope > div > article[id^="claim-review-"]')
        .evaluateAll((es) => es.map((e) => e.id)),
      records.map((r) => "claim-review-" + r.id),
    );
    assert.equal(await older.count(), 1);
    assert.equal(
      await older.locator("article").getAttribute("id"),
      "claim-review-" + originalClaim.id,
    );
    await sound();
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "claim-list-filter-" + n + "-mobile.png") });
  }
  await state.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await state.inputValue(), "all");
  assert.equal(await recheck.isChecked(), false);
  assert.equal(await reset.isDisabled(), true);
  const helpId = await state.getAttribute("aria-describedby");
  assert.equal(await recheck.getAttribute("aria-describedby"), helpId);
  assert.ok(
    (await panel.locator('[id="' + helpId + '"]').textContent()).includes(
      "사실 검증 완료를 뜻하지 않습니다",
    ),
  );
  await result(expectedAll);
  await dirty(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await state.selectOption("unreviewed");
  await result([unreviewed]);
  await state.selectOption("consistent");
  await result([stale, current]);
  await shot("judgement", state);
  await state.selectOption("conflict");
  await result([missing]);
  await state.selectOption("insufficient");
  await result([insufficient]);
  await dirty(false);
  record(
    "All four stored judgement states filter latest claim roots without changing their order or hiding the separate older version. Reading filters creates no draft or requests.",
  );
  await state.selectOption("all");
  await recheck.check();
  await result([stale, missing]);
  await shot("recheck", state);
  await state.selectOption("consistent");
  await result([stale]);
  assert.ok(
    (await panel.locator("#claim-review-" + stale.id).textContent()).includes(
      "연결 문맥 재확인 필요",
    ),
  );
  await state.selectOption("conflict");
  await result([missing]);
  assert.ok(
    (await panel.locator("#claim-review-" + missing.id).textContent()).includes(
      "연결 원고를 고유하게 찾을 수 없습니다.",
    ),
  );
  await state.selectOption("insufficient");
  await result([]);
  await panel.getByText("선택한 조건의 최신 주장 검토가 없습니다.", { exact: true }).waitFor();
  await shot("empty", state);
  await older.locator("summary").first().focus();
  await page.keyboard.press("Enter");
  assert.equal(await older.evaluate((e) => e.open), true);
  assert.equal(await older.locator("blockquote").textContent(), originalClaim.claimQuote);
  await reset.focus();
  await page.keyboard.press("Enter");
  await result(expectedAll);
  assert.equal(await state.evaluate((e) => e === document.activeElement), true);
  assert.equal(await recheck.isChecked(), false);
  assert.equal(await older.evaluate((e) => e.open), true);
  await dirty(false);
  await shot("reset", state);
  record(
    "Recheck-only includes stale and missing registered contexts even when the saved judgement says consistent. Its intersection can be empty; older history remains readable, and keyboard reset restores all latest records with focus without updating judgement.",
  );
  await state.selectOption("consistent");
  await result([stale, current]);
  await panel
    .getByRole("button", { name: "이 주장 v2에서 새 검토 버전 작성", exact: true })
    .click();
  await editor.waitFor();
  await editor
    .getByLabel("기업·기간·단위·범위 해석 메모", { exact: true })
    .fill("  목록 필터 뒤에도\n  유지할 해석 <b>  ");
  await editor.getByLabel("확인 담당자 (수동 기록)", { exact: true }).fill("  초안 담당자  ");
  await editor.getByLabel("이번 버전의 담당자 판단", { exact: true }).selectOption("conflict");
  await editor.getByLabel("판단자", { exact: true }).fill("  초안 판단자  ");
  await editor.getByLabel("판단 이유", { exact: true }).fill("  초안 이유\n검토 중  ");
  await editor.getByLabel("판단 확인일 (직접 입력)", { exact: true }).fill("2026-10-13");
  const draft = await snapshot();
  await recheck.check();
  await result([stale]);
  assert.deepEqual(await snapshot(), draft);
  await state.selectOption("insufficient");
  await result([]);
  assert.deepEqual(await snapshot(), draft);
  await dirty(true);
  await shot("draft", editor.getByLabel("기업·기간·단위·범위 해석 메모", { exact: true }));
  const quoteField = editor.getByLabel("주장 문장을 원문 그대로 인용 *", { exact: true });
  await quoteField.fill("");
  const invalid = await snapshot();
  await editor.getByRole("button", { name: "주장 검토 새 버전 저장", exact: true }).click();
  const alert = editor.getByRole("alert");
  await alert
    .getByText("정확한 원고·인용·자료 버전과 길이, 날짜, 판단 필수 항목을 확인해 주세요.", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(await snapshot(), invalid);
  await sound();
  await reset.focus();
  await page.keyboard.press("Enter");
  await result(expectedAll);
  assert.deepEqual(await snapshot(), invalid);
  assert.equal(await alert.count(), 1);
  await dirty(true);
  await older.locator("summary").first().focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  assert.equal(await older.evaluate((e) => e.open), true);
  assert.deepEqual(await snapshot(), invalid);
  assert.equal(await alert.count(), 1);
  await shot("error-kept", alert);
  await sound();
  assert.equal(caseReads, 1);
  record(
    "Editing a saved consistent claim leaves filtering based on its stored state. Hiding that card and resetting filters preserve every draft field and manual judgement; after a local invalid save, filters and history reading keep the error and draft with zero business requests.",
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
          "latest saved claim judgement and registered-context filters with independent edit/history",
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
