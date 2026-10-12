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
const scenario = "analysis-result-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/analysis-result-response.ts",
  "src/components/studio/plan-editor.tsx",
  "scripts/fixtures/analysis-result-receipt.ts",
  "scripts/analysis-result-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-analysis-result-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/analysis-result-receipt.ts"),
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
  assert.deepEqual(chunk.imports, ["node:crypto"]);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
const prepared = fixture.analysisResultReceiptFixture();
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let intakeReads = 0,
  caseReads = 0,
  patchMode = "missing";
const network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [];
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
            supportedFiles: [".png", ".pdf", ".txt"],
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
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        const found = companies.find((value) => u.pathname === "/api/studio/cases/" + value.id);
        if (found) {
          caseReads++;
          return reply(found);
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided)
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
      }
      if (
        req.method() === "POST" &&
        u.pathname === "/api/studio/cases/" + company.id + "/generate"
      ) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.deepEqual(command, {
          revision: original.revision,
          operation: "analyze",
          mode: "assisted",
        });
        assert.ok(commands.length <= 11);
        if (commands.length > 1) assert.deepEqual(command, commands[0]);
        const result = fixture.analysisResultReceiptResult(original);
        if (patchMode === "missing") result.analysis = null;
        if (patchMode === "source") result.analysis.sourceRevision--;
        if (patchMode === "mode") result.analysis.mode = "ai";
        if (patchMode === "selection") result.selectedCandidateId = original.selectedCandidateId;
        if (patchMode === "confirmed") result.plans[0].confirmedAt = original.plans[0].confirmedAt;
        if (patchMode === "history") result.plans[1].content.summary = "다른 이전 원고";
        if (patchMode === "source-change") result.sources[1].text = "다른 기존 자료 본문";
        if (patchMode === "duplicate")
          result.analysis.candidates[1].id = result.analysis.candidates[0].id;
        if (patchMode === "company") result.id = "00000000-0000-4000-8000-000000000001";
        if (patchMode === "http") return reply({ error: "합성 아이템 분석 응답 실패" }, 500);
        if (patchMode !== "exact") return reply(result);
        company = result;
        companies[0] = company;
        return reply(company);
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
  await page.getByRole("tab", { name: /아이템 분석/ }).click();
  const generate = () => page.getByRole("button", { name: "자료 다시 분석", exact: true });
  const modal = () => page.getByRole("dialog");
  const message =
    "아이템 분석 결과를 아직 확인하지 못했습니다. 기존 분석·선택과 원고를 유지했습니다. 분석 상태를 확인해 주세요.";
  async function chooseAndRun() {
    await generate().click();
    await modal()
      .getByRole("button", { name: /자료 기반 정리본/ })
      .click();
    await modal().getByRole("button", { name: "선택한 방식으로 분석", exact: true }).click();
  }
  for (const mode of [
    "missing",
    "source",
    "mode",
    "selection",
    "confirmed",
    "history",
    "source-change",
    "duplicate",
    "company",
    "http",
  ]) {
    patchMode = mode;
    await chooseAndRun();
    const notice = mode === "http" ? "합성 아이템 분석 응답 실패" : message;
    await page.getByText(notice, { exact: true }).first().waitFor();
    await page.getByText(original.analysis.summary, { exact: true }).waitFor();
    await page
      .getByRole("heading", { name: original.analysis.candidates[0].title, exact: true, level: 3 })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "선택 이유 추가·정정", exact: true }).count(),
      1,
    );
    assert.equal(await generate().isDisabled(), false);
    assert.equal(await page.getByText("아이템 분석을 완료했습니다.", { exact: true }).count(), 0);
    assert.deepEqual(company, original);
    await page
      .getByText(notice, { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  record(
    "ten missing/mismatched/HTTP replies preserve original analysis, selection, source data and manuscripts with explicit retry only",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await generate().click();
  await modal()
    .getByRole("button", { name: /자료 기반 정리본/ })
    .click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await modal().screenshot({ path: path.join(output, "analysis-result-mode-mobile.png") });
  patchMode = "exact";
  await modal().getByRole("button", { name: "선택한 방식으로 분석", exact: true }).click();
  await page.getByText("아이템 분석을 완료했습니다.", { exact: true }).first().waitFor();
  await page.getByText(company.analysis.summary, { exact: true }).waitFor();
  for (const candidate of company.analysis.candidates)
    await page.getByRole("heading", { name: candidate.title, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "선택 이유 추가·정정", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "이유를 적고 아이템 선택", exact: true }).count(),
    2,
  );
  const second = page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: company.analysis.candidates[1].title, exact: true }),
    });
  await second.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await second.screenshot({ path: path.join(output, "analysis-result-candidate-mobile.png") });
  assert.equal(company.selectedCandidateId, null);
  assert.deepEqual(company.candidateSelections, original.candidateSelections);
  assert.deepEqual(company.sources, original.sources);
  assert.deepEqual(
    company.plans,
    original.plans.map((p) => ({ ...p, confirmedAt: null })),
  );
  record(
    "only requested assisted analysis accepted; two candidate identities unambiguous, prior selection and manuscript confirmations cleared while history/content retained",
  );
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  for (const plan of company.plans) {
    await page.locator("#plan-version").selectOption(plan.id);
    assert.equal(await page.locator("#plan-title").inputValue(), plan.content.title);
    assert.equal(await page.locator("#plan-summary").inputValue(), plan.content.summary);
    assert.equal(await page.getByText("내부 검토 완료", { exact: true }).count(), 0);
  }
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /아이템 분석/ }).click();
  await page.getByText(company.analysis.summary, { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "이유를 적고 아이템 선택", exact: true }).count(),
    2,
  );
  assert.equal(commands.length, 11);
  assert.equal(caseReads, 1);
  for (const key of Object.keys(original)) {
    if (["revision", "updatedAt", "analysis", "selectedCandidateId", "plans"].includes(key))
      continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "v1/v3 manuscript texts remain readable and unconfirmed; new analysis survives tab round-trip, eleven identical explicit synthetic commands without actual engine/AI/writer execution",
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
        syntheticPatches: 0,
        syntheticGenerationPosts: commands.length,
        actualGeneration: 0,
        actualAnalysis: 0,
        syntheticPreviewPosts: 0,
        actualPlanWrites: 0,
        originalReads: 0,
        syntheticCompanyGets: caseReads,
        syntheticIntakeGets: intakeReads,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "synthetic re-analysis of two sources, retained selection history and two manuscripts; no actual analyzer, writer, AI, SQL or institution execution",
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
