import assert from "node:assert/strict";
import { tmpdir } from "node:os";
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
const temporaryRoot = await realpath(tmpdir());
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
const planReferenceOnly = process.argv[4] === "plan-reference";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/claim-reviews.tsx",
  "src/components/studio/stored-comparison-reviews.tsx",
  "src/components/studio/plan-editor.tsx",
  "src/lib/studio-comparison-plan-reference.ts",
  "scripts/fixtures/comparison-plan-reference.ts",
  "src/lib/studio-comparison-review-http.ts",
  "src/lib/studio-comparison-review-catalog.ts",
  "scripts/fixtures/claim-review-receipt.ts",
  "scripts/stored-comparison-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-stored-comparison-ui-"));
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
  input: path.join(
    app,
    planReferenceOnly
      ? "scripts/fixtures/comparison-plan-reference.ts"
      : "scripts/fixtures/claim-review-receipt.ts",
  ),
  cwd: app,
  platform: "browser",
  external: ["node:crypto"],
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      load(id) {
        if (id === "synthetic:server-only") return "export {};";
        if (id === "synthetic:vitest") return "export const vi={fn:value=>value};";
      },
      resolveId(source) {
        if (planReferenceOnly && (source === "server-only" || source === "vitest"))
          return { id: "synthetic:" + source };
        if (
          source !== "node:crypto" &&
          !(planReferenceOnly && source === "./studio-engine-request-core") &&
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
  assert.deepEqual(chunk.imports, planReferenceOnly ? ["node:crypto"] : []);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
const prepared = planReferenceOnly
  ? fixture.comparisonPlanReferenceFixture()
  : fixture.claimReceiptFixture();
const company = prepared.company;
const wire = planReferenceOnly
  ? {
      wireVersion: 2,
      kind: "public-comparison-stored-review",
      query: prepared.query,
      result: prepared.result,
    }
  : JSON.parse(
      await readFile(path.join(app, "src/lib/fixtures/comparison-review-example.json"), "utf8"),
    );
company.id = wire.result.resultIdentity.selection.companyId;
company.revision = wire.result.resultIdentity.selection.companyRevision;
company.profile.companyName = "합성 보관 비교 조회 기업";
const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
const p = wire.result.historical.prepared;
const catalog = {
  source: "comparison-stored-catalog",
  companyId: company.id,
  companyRevision: company.revision,
  reviews: [
    {
      ...wire.result.resultIdentity,
      sectionKey: p.input.section.key,
      sectionTitle: p.input.section.title,
      claimQuote: p.input.claimQuote,
    },
  ],
  currentContextVerified: false,
  runtimeObserved: false,
  authority: wire.result.authority,
};
let omitReceipt = false;
let referenceStatus = "changed",
  referenceOpinion = true;
let catalogMode = "unconfigured",
  catalogReads = 0,
  resultReads = 0,
  cleanupCalls = 0;
let nextDialog = "dismiss";
const blockedDevDiagnostics = [],
  network = [],
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
      if (
        u.pathname ===
        "/api/studio/cases/" + company.id + "/public-claim-comparison/stored-reviews"
      ) {
        if (req.method() === "DELETE") {
          cleanupCalls++;
          return reply({ closed: true });
        }
        assert.equal(req.method(), "GET");
        assert.equal(u.searchParams.get("revision"), String(company.revision));
        catalogReads++;
        if (catalogMode === "unconfigured") return reply({ code: "NOT_CONFIGURED" }, 503);
        if (catalogMode === "empty") return reply({ ...catalog, reviews: [] });
        if (catalogMode === "wrong-company")
          return reply({ ...catalog, companyId: "00000000-0000-4000-8000-000000000000" });
        return reply(catalog);
      }
      if (
        u.pathname ===
        "/api/studio/cases/" + company.id + "/public-claim-comparison/stored-review"
      ) {
        assert.equal(req.method(), "POST");
        resultReads++;
        const query = JSON.parse(req.postData());
        assert.equal(query.runId, wire.query.runId);
        assert.equal(query.dispatchCommandDigest, wire.query.dispatchCommandDigest);
        assert.equal(req.headers()["x-venturepass-company-revision"], String(company.revision));
        const result = structuredClone(wire.result);
        result.source = "comparison-stored-review";
        if (query.mode === "inspect-current")
          result.current = {
            status: planReferenceOnly ? referenceStatus : "changed",
            originalRevision: result.current.originalRevision,
            observedRevision: company.revision,
            reason:
              planReferenceOnly && referenceStatus === "exact-original-request"
                ? null
                : planReferenceOnly && referenceStatus === "unavailable"
                  ? "CURRENT_READ_UNAVAILABLE"
                  : "PUBLIC_CLAIM_STALE",
          };
        else if (planReferenceOnly)
          result.current = {
            status: "not-checked",
            originalRevision: company.revision,
            observedRevision: null,
            reason: null,
          };
        if (planReferenceOnly && !referenceOpinion) {
          result.historical.result.state = "comparison-rejected";
          result.historical.result.comparison = null;
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: omitReceipt ? {} : { "x-venturepass-comparison-request": "complete" },
          body: JSON.stringify({ wireVersion: 2, kind: wire.kind, query, result }),
        });
      }
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
          return reply(found);
        }
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          return reply({ company, activeItemIds: [] });
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
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
  const section = panel
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "보관된 공개 근거 비교 결과 (선택)" }) });
  await section.locator("summary").first().focus();
  await page.keyboard.press("Enter");
  assert.equal(catalogReads, 0);
  assert.equal(resultReads, 0);
  const load = section.getByRole("button", { name: "보관 비교 목록 불러오기", exact: true });
  if (planReferenceOnly) {
    catalogMode = "valid";
    await load.click();
    const selection = section.getByLabel("확인할 보관 결과", { exact: true });
    await selection.selectOption(wire.query.runId);
    const read = section.getByRole("button", { name: "선택한 비교 결과 읽기", exact: true });
    const scope = section.getByLabel("조회 범위", { exact: true });
    const open = () =>
      section.getByRole("button", { name: "이 의견을 보며 원고 보완", exact: true });
    await read.click();
    await section.getByText(/현재 연결: 확인하지 않음/).waitFor();
    assert.equal(await open().isDisabled(), true);
    await scope.selectOption("inspect-current");
    for (const status of ["changed", "unavailable"]) {
      referenceStatus = status;
      await read.click();
      await section
        .getByText(status === "changed" ? /현재 연결: 변경됨/ : /현재 연결: 확인할 수 없음/)
        .waitFor();
      assert.equal(await open().isDisabled(), true);
    }
    referenceStatus = "exact-original-request";
    referenceOpinion = false;
    await read.click();
    await section.getByText("비교 의견이 없는 저장 결과", { exact: true }).waitFor();
    assert.equal(await open().isDisabled(), true);
    referenceOpinion = true;
    await read.click();
    await section.getByTestId("overall-reason").waitFor();
    const oldPlan = company.plans[0],
      newPlan = company.plans.at(-1);
    assert.equal(await page.locator("#plan-version").inputValue(), newPlan.id);
    await open().click();
    const reference = page.getByRole("region", { name: "원고 보완 참고 의견", exact: true });
    await reference.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === "plan-section");
    assert.equal(await page.locator("#plan-version").inputValue(), oldPlan.id);
    assert.equal(
      await page.locator("#plan-section").inputValue(),
      oldPlan.content.sections[0].content,
    );
    assert.equal(
      await page.getByRole("button", { name: "수정본 저장", exact: true }).first().isDisabled(),
      true,
    );
    assert.equal(
      await reference.getByTestId("overall-reason").innerText(),
      wire.result.historical.result.comparison.comparison.overall.reason,
    );
    record(
      "Historical/changed/unavailable/no-opinion views cannot open the editor; exact current opinion opens its original version and focuses the correct field without edits.",
    );
    const edited = oldPlan.content.sections[0].content + " 담당자가 직접 보완한 문장.";
    await page.locator("#plan-section").fill(edited);
    await reference.getByText(/지금 편집한 문장을 다시 검토한 결과가 아닙니다/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "수정본 저장", exact: true }).first().isDisabled(),
      false,
    );
    assert.equal(await section.getByTestId("overall-reason").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await reference.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.ok(
      (await reference.getByRole("button", { name: "참고 의견 닫기" }).boundingBox()).height >= 44,
    );
    await page.screenshot({ path: path.join(output, "comparison-plan-reference-mobile.png") });
    await reference.getByRole("button", { name: "참고 의견 닫기", exact: true }).click();
    assert.equal(await reference.count(), 0);
    assert.equal(await page.locator("#plan-section").inputValue(), edited);
    record(
      "Manual edits retain the original reference without automatically approving facts or judgement; closing reference preserves unsaved text and mobile layout has no overflow.",
    );
    nextDialog = "accept";
    await page.locator("#plan-version").selectOption(newPlan.id);
    await load.click();
    await selection.selectOption(wire.query.runId);
    await scope.selectOption("inspect-current");
    await read.click();
    await open().waitFor();
    assert.equal(await open().isDisabled(), false);
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (...args) => {
        crypto.subtle.digest = original;
        return new Promise((resolve) => {
          window.__releaseComparisonHash = () => original(...args).then(resolve);
        });
      };
    });
    await open().click();
    await page.waitForFunction(() => typeof window.__releaseComparisonHash === "function");
    await scope.selectOption("historical");
    await page.evaluate(() => window.__releaseComparisonHash());
    await section
      .getByText(/원고 연결을 다시 확인해 주세요/)
      .first()
      .waitFor();
    assert.equal(await reference.count(), 0);
    assert.equal(await page.locator("#plan-version").inputValue(), newPlan.id);
    assert.equal(
      await page.locator("#plan-section").inputValue(),
      newPlan.content.sections[0].content,
    );
    assert.equal(catalogReads, 2);
    assert.equal(resultReads, 6);
    record(
      "Changing review scope during delayed browser hash verification cancels navigation and keeps the current draft; no auto fetch, writes or paid execution.",
    );
  } else {
    await load.click();
    await section
      .getByText(
        "보관 비교 조회 연결이 설정되지 않았습니다. 서버의 기존 비교 저장소 설정이 필요합니다.",
        { exact: true },
      )
      .waitFor();
    assert.equal(catalogReads, 1);
    assert.equal(resultReads, 0);
    catalogMode = "empty";
    await load.click();
    await section.getByText("이 회사의 보관된 비교 결과가 없습니다.", { exact: true }).waitFor();
    record(
      "Explicit loading distinguishes missing configuration and an empty audited company catalog.",
    );
    catalogMode = "valid";
    await load.click();
    const selection = section.getByLabel("확인할 보관 결과", { exact: true });
    await selection.selectOption(wire.query.runId);
    const read = section.getByRole("button", { name: "선택한 비교 결과 읽기", exact: true });
    await read.click();
    await section.getByText("보관 결과를 읽었습니다.", { exact: true }).waitFor();
    assert.equal(resultReads, 1);
    assert.ok((await section.textContent()).includes(p.input.claimQuote));
    assert.ok((await section.textContent()).includes("현재 연결: 확인하지 않음"));
    assert.equal(
      await section.locator('[data-testid="source-excerpt"]').count(),
      p.input.selectedEvidence.length,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await read.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "stored-comparison-mobile.png") });
    record(
      "Actual claim-review screen selects an audited historical run and renders its original opinion at 390px without overflow.",
    );
    const mode = section.getByLabel("조회 범위", { exact: true });
    await mode.selectOption("inspect-current");
    assert.equal(await section.locator('[data-testid="source-excerpt"]').count(), 0);
    assert.equal(resultReads, 1);
    await read.click();
    await section.getByText(/현재 연결: 변경됨/).waitFor();
    assert.equal(resultReads, 2);
    record(
      "Changing scope hides the previous opinion; only an explicit new read displays the current-link outcome.",
    );
    await panel.getByRole("button", { name: "새 주장·근거 기록", exact: true }).click();
    await section.getByText("편집 또는 저장을 마친 뒤 확인해 주세요.", { exact: true }).waitFor();
    assert.equal(await section.locator('[data-testid="source-excerpt"]').count(), 0);
    assert.equal(await load.isDisabled(), true);
    nextDialog = "accept";
    await panel.getByRole("button", { name: "편집 취소", exact: true }).click();
    await section.locator("summary").first().click();
    await section.locator("summary").first().click();
    assert.equal(await section.locator('[data-testid="source-excerpt"]').count(), 0);
    catalogMode = "wrong-company";
    await load.click();
    await section
      .getByText("보관 목록을 확인하지 못했습니다. 회사와 저장 기록을 확인한 뒤 다시 불러오세요.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await selection.count(), 0);
    await section.getByRole("button", { name: "조회 연결 정리", exact: true }).click();
    await section
      .getByText("조회 연결을 정리했습니다. 목록을 다시 불러오세요.", { exact: true })
      .waitFor();
    assert.equal(cleanupCalls, 1);
    assert.equal(resultReads, 2);
    record(
      "Editing removes prior results, mismatched-company catalogs are rejected, and connection cleanup requires an explicit action.",
    );
    catalogMode = "valid";
    await load.click();
    await selection.selectOption(wire.query.runId);
    omitReceipt = true;
    await read.click();
    await section.getByText("결과 응답을 받지 못했습니다.", { exact: true }).waitFor();
    assert.equal(await section.locator('[data-testid="source-excerpt"]').count(), 0);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent === "선택한 비교 결과 읽기",
        )?.disabled,
    );
    await section.getByRole("button", { name: "조회 연결 정리", exact: true }).click();
    await section
      .getByText(
        "서버 조회 연결은 정리됐지만 이 창에서 이전 읽기의 종료를 확인하지 못했습니다. 앱을 새로고침한 뒤 다시 선택해 주세요.",
        { exact: true },
      )
      .waitFor();
    assert.equal(resultReads, 3);
    assert.equal(cleanupCalls, 2);
    assert.equal(await read.isDisabled(), true);
    record(
      "An unknown request receipt stays retained; successful server cleanup explains the explicit reload without silently replacing the client owner.",
    );
  }
  assert.deepEqual(companies, original);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(commands, []);
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        checks,
        planReferenceOnly,
        catalogReads,
        resultReads,
        cleanupCalls,
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
    JSON.stringify({ output, checks: checks.length, catalogReads, resultReads, cleanupCalls }),
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
