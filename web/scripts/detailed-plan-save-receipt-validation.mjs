import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
const scenario = process.argv[4] ?? "detailed-plan-save-receipt";
assert.ok(["detailed-plan-save-receipt", "section-identity"].includes(scenario));

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/manual-plan-save.ts",
  "src/components/studio/plan-editor.tsx",
  "scripts/fixtures/detailed-plan-save-receipt.ts",
  "scripts/detailed-plan-save-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(
  path.join(temporaryRoot, "venturepass-detailed-plan-save-receipt-ui-"),
);
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
  input: path.join(app, "scripts/fixtures/detailed-plan-save-receipt.ts"),
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
const prepared = fixture.detailedPlanSaveFixture();
if (scenario === "section-identity") {
  // Distinct originals sharing a section key are permitted by the saved schema.
  // They must remain readable and must never be edited or confirmed together.
  const duplicates = [true, false].map((needsConfirmation, index) => ({
    ...structuredClone(prepared.content.sections[0]),
    key: "duplicate-section",
    title: `중복 연결 원문 ${index + 1}`,
    content: `  서로 다른 합성 원문 ${index + 1}\n<확인되지 않은 내용>을 그대로 보존합니다.  `,
    needsConfirmation,
  }));
  for (const plan of prepared.company.plans)
    plan.content.sections.push(...structuredClone(duplicates));
  prepared.content.sections.push(...structuredClone(duplicates));
}
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
      if (req.method() === "PATCH" && u.pathname === "/api/studio/cases/" + company.id) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.deepEqual(command, {
          action: "save-plan",
          revision: original.revision,
          planId: prepared.planId,
          content: prepared.content,
        });
        assert.ok(commands.length <= 9);
        if (commands.length > 1) assert.deepEqual(command, commands[0]);
        const result = fixture.detailedPlanSaveResult(original, command.planId, command.content);
        const saved = result.plans.at(-1);
        if (patchMode === "missing") result.plans.pop();
        if (patchMode === "body") saved.content.sections[1].content = "다른 두 번째 본문";
        if (patchMode === "confirmation") saved.content.sections[1].needsConfirmation = false;
        if (patchMode === "source-revision") saved.sourceRevision++;
        if (patchMode === "version") saved.version++;
        if (patchMode === "history") result.plans[0].content.summary = "변경된 과거 원고";
        if (patchMode === "mode") saved.mode = "ai";
        if (patchMode === "http") return reply({ error: "합성 수정본 저장 응답 실패" }, 500);
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
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  await page.locator("#plan-version").selectOption(prepared.planId);
  const expected = prepared.content;
  const nav = page.getByRole("navigation", { name: "사업계획서 항목", exact: true });
  const confirmed = page.getByRole("checkbox", {
    name: "이 항목의 사실·수치·증빙과 실행계획을 확인했습니다.",
    exact: true,
  });
  const save = () => page.getByRole("button", { name: "수정본 저장", exact: true }).first();
  async function checkAmbiguousSections() {
    const originals = page.getByRole("region", {
      name: "수정 대상 확인이 필요한 원문",
      exact: true,
    });
    for (const label of ["중복 연결 원문 1", "중복 연결 원문 2"]) {
      await nav.getByRole("button").filter({ hasText: label }).click();
      await originals.waitFor();
      assert.equal(await originals.locator("article").count(), 2);
      for (const [index, item] of expected.sections.slice(-2).entries()) {
        const article = originals.locator("article").nth(index);
        assert.equal(
          await article.locator("h4").textContent(),
          `원문 ${index + 1} · ${item.title}`,
        );
        assert.equal(await article.locator("p").first().textContent(), item.content);
        assert.ok(
          (await article.textContent()).includes(
            item.needsConfirmation ? "항목 확인 필요" : "저장된 항목 확인 표시 있음",
          ),
        );
      }
      assert.equal(await page.locator("#plan-section, #plan-section-title").count(), 0);
      assert.equal(await confirmed.count(), 0);
      assert.equal(await page.getByRole("button", { name: "본문 복사", exact: true }).count(), 0);
    }
  }
  if (scenario === "section-identity") {
    await checkAmbiguousSections();
    assert.equal(await save().isDisabled(), true);
    assert.deepEqual(commands, []);
    assert.deepEqual(company, original);
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("region", { name: "수정 대상 확인이 필요한 원문", exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "ambiguous-sections-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 960 });
    record(
      "both ambiguous navigation entries expose all original bodies and confirmation states read-only, with no dirty state or write",
    );
  }
  await page.locator("#plan-title").fill(expected.title);
  await page.locator("#plan-summary").fill(expected.summary);
  for (let i = 0; i < 2; i++) {
    await nav.getByRole("button").nth(i).click();
    await page.locator("#plan-section-title").fill(expected.sections[i].title);
    await page.locator("#plan-section").fill(expected.sections[i].content);
    await confirmed.setChecked(!expected.sections[i].needsConfirmation);
  }
  await page.locator("summary").filter({ hasText: "보강할 자료와 실행 과제" }).click();
  await page.locator("#plan-action-item-0").fill(expected.actionItems[0]);
  await page.locator("summary").filter({ hasText: "실사 준비 질문" }).click();
  await page.locator("#plan-interview-question-1").fill(expected.interviewQuestions[1]);
  async function retained() {
    assert.equal(await page.locator("#plan-version").inputValue(), prepared.planId);
    assert.equal(await page.locator("#plan-title").inputValue(), expected.title);
    assert.equal(await page.locator("#plan-summary").inputValue(), expected.summary);
    for (let i = 0; i < 2; i++) {
      await nav.getByRole("button").nth(i).click();
      assert.equal(
        await page.locator("#plan-section-title").inputValue(),
        expected.sections[i].title,
      );
      assert.equal(await page.locator("#plan-section").inputValue(), expected.sections[i].content);
      assert.equal(await confirmed.isChecked(), !expected.sections[i].needsConfirmation);
    }
    assert.equal(await page.locator("#plan-action-item-0").inputValue(), expected.actionItems[0]);
    assert.equal(
      await page.locator("#plan-interview-question-1").inputValue(),
      expected.interviewQuestions[1],
    );
    assert.equal(await save().isDisabled(), false);
  }
  const errorText =
    "수정본의 저장 결과를 아직 확인하지 못했습니다. 입력을 유지했습니다. 저장 상태를 다시 확인해 주세요.";
  for (const mode of [
    "missing",
    "body",
    "confirmation",
    "source-revision",
    "version",
    "history",
    "mode",
    "http",
  ]) {
    patchMode = mode;
    await save().click();
    const message = mode === "http" ? "합성 수정본 저장 응답 실패" : errorText;
    await page.getByText(message, { exact: true }).first().waitFor();
    await retained();
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    assert.deepEqual(company, original);
    await page
      .getByText(message, { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  record(
    "rejects eight mismatched/failed responses; retained historical target, full original whitespace, two sections and confirmation flags with identical explicit retries",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await save().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, "detailed-plan-save-mobile.png"),
    fullPage: true,
  });
  patchMode = "exact";
  await save().click();
  await page
    .locator("#plan-version option:checked")
    .filter({ hasText: "버전 4" })
    .waitFor({ state: "attached" });
  assert.equal(await page.locator("#plan-version").inputValue(), prepared.savedId);
  assert.equal(await page.locator("#plan-title").inputValue(), expected.title);
  assert.equal(await save().isDisabled(), true);
  assert.deepEqual(company.plans.slice(0, -1), original.plans);
  assert.deepEqual(company.plans.at(-1).content, expected);
  assert.equal(company.plans.at(-1).mode, "manual");
  assert.equal(company.plans.at(-1).confirmedAt, null);
  record(
    "only exact manual v4 accepted; old v1/v3 unchanged, all requested content preserved and whole plan remains unconfirmed",
  );
  for (const previous of original.plans) {
    await page.locator("#plan-version").selectOption(previous.id);
    assert.equal(await page.locator("#plan-title").inputValue(), previous.content.title);
    assert.equal(await page.locator("#plan-summary").inputValue(), previous.content.summary);
    await nav.getByRole("button").nth(1).click();
    assert.equal(
      await page.locator("#plan-section").inputValue(),
      previous.content.sections[1].content,
    );
  }
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  assert.equal(await page.locator("#plan-version").inputValue(), prepared.savedId);
  assert.equal(await page.locator("#plan-summary").inputValue(), expected.summary);
  assert.equal(commands.length, 9);
  if (scenario === "section-identity") {
    await checkAmbiguousSections();
    assert.equal(await save().isDisabled(), true);
    assert.deepEqual(
      company.plans.at(-1).content.sections.slice(-2),
      original.plans[0].content.sections.slice(-2),
    );
    assert.ok(!network.some((entry) => entry.console?.includes("same key")));
    record(
      "editing unique sections and saving a new version preserves both ambiguous originals byte-for-byte through reentry",
    );
  }
  assert.equal(caseReads, 1);
  for (const key of Object.keys(original)) {
    if (["revision", "updatedAt", "plans"].includes(key)) continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "previous v1/v3 remain readable and saved v4 survives company/plan round-trip; other synthetic state preserved with no generation or automatic retry",
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
        syntheticGenerationPosts: 0,
        syntheticPreviewPosts: 0,
        actualPlanWrites: 0,
        originalReads: 0,
        syntheticCompanyGets: caseReads,
        syntheticIntakeGets: intakeReads,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "two synthetic saved manuscript versions; no server writer, real plan generation, AI, SQL or institution execution",
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
