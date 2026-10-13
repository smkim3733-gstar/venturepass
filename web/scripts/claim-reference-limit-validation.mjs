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
const scenario = "claim-reference-limit";

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
  "scripts/claim-reference-limit-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-claim-reference-limit-ui-"));
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
const prepared = fixture.claimReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 주장 참고 선택 한도 기업";
const plan = company.plans.at(-1);
const numericTemplate = company.numericChecks.at(-1);
company.numericChecks = Array.from({ length: 11 }, (_, i) => ({
  ...structuredClone(numericTemplate),
  id: fixture.agencyId(800 + i),
  checkId: fixture.agencyId(800 + i),
  version: i + 1,
  previousVersionId: null,
  clientRequestId: fixture.agencyId(820 + i),
  title: "선택 대조 " + (i + 1),
}));
company.planReviewDecisions = Array.from({ length: 11 }, (_, i) => ({
  id: fixture.agencyId(850 + i),
  rootId: fixture.agencyId(850 + i),
  version: i + 1,
  clientRequestId: fixture.agencyId(870 + i),
  inputDigest: "a".repeat(64),
  planId: plan.id,
  planVersion: plan.version,
  findingIndex: 0,
  finding: {
    id: "synthetic-review-" + i,
    severity: "warning",
    category: "evidence",
    message: "선택 판단 " + (i + 1),
    action: "합성 연결 대조",
    sectionKey: plan.content.sections[0].key,
    sourceIds: [],
  },
  previousRecordId: null,
  status: "deferred",
  reason: "합성 보류",
  reviewer: "합성 담당",
  recordedAt: "2026-10-13T04:02:00.000Z",
  origin: "manual",
  reviewKey: "b".repeat(64),
  planContentSha256: "c".repeat(64),
  findingSha256: "d".repeat(64),
  planSourceRevision: plan.sourceRevision,
  evidenceRevision: company.revision,
  evidenceFingerprint: "e".repeat(64),
  stale: false,
  staleReasons: [],
}));
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
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/preparation-automation")),
    page.getByRole("button", { name: "상세 도구", exact: true }).click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  const panel = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
  await panel
    .getByRole("button", { name: "이 주장 v1에서 새 검토 버전 작성", exact: true })
    .click();
  const form = panel.getByRole("group", {
    name: "기존 주장 새 버전 · 판단 미검토로 시작",
    exact: true,
  });
  const numeric = form.getByLabel("수치 대조 참고 버전 (최대 10개)", { exact: true });
  const review = form.getByLabel("선택한 원고의 검토 판단 버전 (최대 10개)", { exact: true });
  const numericIds = company.numericChecks.map((r) => r.id);
  const reviewIds = company.planReviewDecisions.map((r) => r.id);
  const snap = () =>
    form.locator("input,textarea,select").evaluateAll((es) =>
      es.map((e) => ({
        id: e.id,
        value: e.value,
        checked: e.type === "checkbox" ? e.checked : null,
        selected:
          e.tagName === "SELECT" && e.multiple
            ? Array.from(e.selectedOptions, (o) => o.value)
            : null,
      })),
    );
  const selection = (s) => s.locator("option:checked").evaluateAll((es) => es.map((e) => e.value));
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
      path: path.join(output, "claim-reference-limit-" + n + "-mobile.png"),
    });
  }
  async function count(s, amount) {
    const id = await s.getAttribute("aria-describedby");
    assert.ok(id);
    const p = form.locator('[id="' + id + '"]');
    assert.ok((await p.textContent()).includes("선택 " + amount + "/10개"));
    return p;
  }
  async function limited(s, ids) {
    assert.deepEqual(await selection(s), ids);
    for (const option of await s.locator("option").all()) {
      assert.equal(await option.isDisabled(), !ids.includes(await option.getAttribute("value")));
    }
    await count(s, 10);
  }
  const contextNote = "  범위 초안\n둘째 줄  ";
  const owner = "  확인 담당 초안  ";
  await form.getByLabel("기업·기간·단위·범위 해석 메모", { exact: true }).fill(contextNote);
  await form.getByLabel("확인 담당자 (수동 기록)", { exact: true }).fill(owner);
  await form.getByLabel("검토 방식", { exact: true }).selectOption("document");
  await numeric.selectOption(numericIds.slice(0, 10));
  // This is the first pre-change assertion: the eleventh option used to stay enabled.
  assert.equal(await numeric.locator('option[value="' + numericIds[10] + '"]').isDisabled(), true);
  await limited(numeric, numericIds.slice(0, 10));
  assert.deepEqual(await selection(review), []);
  for (const option of await review.locator("option").all())
    assert.equal(await option.isDisabled(), false);
  await count(review, 0);
  const afterNumeric = await snap();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("numeric", numeric);
  assert.deepEqual(await snap(), afterNumeric);
  await dirty(true);
  await sound();
  record(
    "Ten numeric reference versions disable only unselected numeric options; all ten selected versions remain removable, the manuscript-review picker stays available, and raw draft fields are preserved without a request.",
  );

  await review.selectOption(reviewIds.slice(0, 10));
  await limited(review, reviewIds.slice(0, 10));
  await limited(numeric, numericIds.slice(0, 10));
  await form.getByLabel("이번 버전의 담당자 판단", { exact: true }).selectOption("consistent");
  await form.getByLabel("판단자", { exact: true }).fill("  판단 담당  ");
  await form.getByLabel("판단 이유", { exact: true }).fill("  검토 초안\n줄바꿈  ");
  await form.getByLabel("판단 확인일 (직접 입력)", { exact: true }).fill("2026-10-12");
  const both = await snap();
  await shot("both", review);
  await numeric.focus();
  await page.keyboard.press("Tab");
  assert.equal(await review.evaluate((e) => document.activeElement === e), true);
  assert.deepEqual(await snap(), both);
  await shot("focus", review);
  const numericId = await numeric.getAttribute("id");
  const judgeIds = await form
    .locator(
      'select[id$="-judgement"],input[id$="-reviewer"],textarea[id$="-judgement-reason"],input[id$="-checked"]',
    )
    .evaluateAll((es) => es.map((e) => e.id));
  const except = (values, ids) => values.filter((e) => !ids.includes(e.id));
  await numeric.selectOption(numericIds.slice(1, 10));
  assert.deepEqual(await selection(numeric), numericIds.slice(1, 10));
  await count(numeric, 9);
  assert.equal(await numeric.locator('option[value="' + numericIds[10] + '"]').isDisabled(), false);
  assert.deepEqual(
    except(await snap(), [numericId, ...judgeIds]),
    except(both, [numericId, ...judgeIds]),
  );
  assert.equal(
    await form.getByLabel("이번 버전의 담당자 판단", { exact: true }).inputValue(),
    "unreviewed",
  );
  assert.equal(await form.getByLabel("판단자", { exact: true }).inputValue(), "");
  assert.equal(await form.getByLabel("판단 이유", { exact: true }).inputValue(), "");
  assert.equal(await form.getByLabel("판단 확인일 (직접 입력)", { exact: true }).inputValue(), "");
  await numeric.selectOption(numericIds.slice(1));
  await limited(numeric, numericIds.slice(1));
  await limited(review, reviewIds.slice(0, 10));
  await dirty(true);
  await sound();
  record(
    "Both reference kinds independently reach ten; keyboard Tab between the pickers preserves selections and judgement. Removing one numeric version makes room for the eleventh and follows only the existing judgement reset while other inputs and review references stay unchanged.",
  );

  await form.getByLabel("주장 문장을 원문 그대로 인용 *", { exact: true }).fill("");
  await form.getByRole("button", { name: "주장 검토 새 버전 저장", exact: true }).click();
  const error = "정확한 원고·인용·자료 버전과 길이, 날짜, 판단 필수 항목을 확인해 주세요.";
  await form.getByRole("alert").getByText(error, { exact: true }).waitFor();
  const errorDraft = await snap();
  await shot("error-kept", form.getByRole("alert"));
  await numeric.focus();
  await page.keyboard.press("Tab");
  assert.deepEqual(await snap(), errorDraft);
  assert.ok((await form.getByRole("alert").textContent()).includes(error));
  const reviewId = await review.getAttribute("id");
  await review.selectOption(reviewIds.slice(1, 10));
  await count(review, 9);
  assert.deepEqual(except(await snap(), [reviewId]), except(errorDraft, [reviewId]));
  assert.equal(await form.getByRole("alert").count(), 0);
  await review.selectOption(reviewIds.slice(1));
  await limited(review, reviewIds.slice(1));
  await limited(numeric, numericIds.slice(1));
  await shot("replacement", review);
  await review.selectOption([]);
  await count(review, 0);
  for (const option of await review.locator("option").all())
    assert.equal(await option.isDisabled(), false);
  await limited(numeric, numericIds.slice(1));
  assert.equal(
    await form.getByLabel("기업·기간·단위·범위 해석 메모", { exact: true }).inputValue(),
    contextNote,
  );
  assert.equal(
    await form.getByLabel("확인 담당자 (수동 기록)", { exact: true }).inputValue(),
    owner,
  );
  await dirty(true);
  await sound();
  assert.deepEqual(dialogs, []);
  assert.equal(caseReads, 1);
  record(
    "An explicit invalid save stays local. Reading and tabbing preserve its error and all inputs; removing a review reference follows the existing error-clear rule, permits the eleventh, and clearing that picker leaves numeric references and raw drafts intact.",
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
          "independent ten-version reference limits in a manual claim editor; all records and requests remain unchanged",
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
