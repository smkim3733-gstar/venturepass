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
const scenario = "local-ocr-retry";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/local-ocr-response.ts",
  "scripts/fixtures/local-ocr-receipt.ts",
  "scripts/local-ocr-retry-validation.mjs",
  "src/components/studio/sources-panel.tsx",
  "src/components/studio/local-ocr-request.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-local-ocr-retry-ui-"));
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
  input: path.join(app, "scripts/fixtures/local-ocr-receipt.ts"),
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
const prepared = await fixture.ocrReceiptFixture();
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let previewReads = 0,
  intakeReads = 0;
const changedText =
  "  [페이지 1]\n합성 수량은 재대조 후 1,250개로 교정했습니다.\n\n[페이지 2]\n추가 시험 여부는 아직 미확인입니다.  ";
let expectedText = prepared.raw;
let closeDecisions = [],
  closeDialogs = 0;
let caseReads = 0,
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
        if (u.pathname === `/api/studio/cases/${company.id}/source-intakes`) {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
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
        u.pathname ===
          `/api/studio/cases/${company.id}/sources/${prepared.command.sourceId}/ocr-preview`
      ) {
        previewReads++;
        assert.ok(previewReads <= 2);
        assert.deepEqual(req.postDataJSON(), { revision: original.revision });
        return reply(prepared.preview);
      }
      if (req.method() === "PATCH" && u.pathname === "/api/studio/cases/" + company.id) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.ok(commands.length <= 8);
        assert.deepEqual(command, {
          ...prepared.command,
          text: expectedText,
          clientRequestId: command.clientRequestId,
        });
        assert.match(command.clientRequestId, /^[a-f0-9-]{36}$/);
        if (patchMode === "http") return reply({ error: "합성 교정 저장 실패" }, 500);
        const result = await fixture.ocrReceiptResult(original, command);
        if (patchMode === "missing") {
          result.sourceOcrReviews.pop();
          return reply(result);
        }
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
  page.on("dialog", async (dialog) => {
    closeDialogs++;
    if (closeDecisions.shift() === true) await dialog.accept();
    else await dialog.dismiss();
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
  await page.getByRole("tab", { name: /자료/ }).click();
  const card = () =>
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "두 페이지 합성 원본", exact: true }) });
  await card().getByRole("button", { name: "이 PC에서 글자 읽기", exact: true }).click();
  const form = page.getByRole("region", { name: "로컬 글자 읽기 초안 검토", exact: true });
  await form.waitFor();
  const text = form.getByLabel("원본과 대조해 교정할 본문", { exact: true });
  assert.equal(await text.inputValue(), prepared.preview.text);
  await text.fill(prepared.raw);
  const confirmation = form.getByRole("checkbox");
  await confirmation.check();
  const save = () => form.getByRole("button", { name: "확인한 본문 저장", exact: true });
  const errorText =
    "교정 본문의 저장 기록을 확인하지 못했습니다. 원래 교정 내용과 확인 상태·요청 번호를 유지했습니다.";
  async function attempt(mode) {
    const count = commands.length;
    patchMode = mode;
    const response = page.waitForResponse((r) => r.request().method() === "PATCH");
    await save().click();
    await response;
    await form
      .getByText(
        "본문을 저장하지 못했습니다. 교정 내용과 확인 상태는 유지했습니다. 오류 안내와 최신 저장 상태를 확인해 주세요.",
        { exact: true },
      )
      .waitFor();
    assert.equal(commands.length, count + 1);
    assert.equal(await text.inputValue(), expectedText);
    assert.equal(await confirmation.isChecked(), true);
    assert.equal(await text.isDisabled(), false);
    assert.equal(await save().isDisabled(), false);
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    assert.deepEqual(company, original);
    // Let the previous toast expire so another explicit attempt is observed independently.
    const notice = page
      .getByText(mode === "http" ? "합성 교정 저장 실패" : errorText, { exact: true })
      .first();
    await notice.waitFor();
    await notice.waitFor({ state: "hidden", timeout: 15000 });
  }
  async function edit(value) {
    const count = commands.length;
    expectedText = value;
    await text.fill(value);
    assert.equal(await confirmation.isChecked(), false);
    assert.equal(await save().isDisabled(), true);
    assert.equal(commands.length, count);
    await confirmation.check();
  }
  await attempt("missing");
  await attempt("http");
  assert.deepEqual(commands[1], commands[0]);
  await edit(changedText);
  await attempt("missing");
  assert.notEqual(
    commands[2].clientRequestId,
    commands[0].clientRequestId,
    "edited text must use a fresh request ID",
  );
  await attempt("http");
  assert.deepEqual(commands[3], commands[2]);
  record(
    "same-text retries keep their request; edited text requires renewed confirmation and a new request without remounting the editor",
  );
  await edit(prepared.raw);
  await attempt("missing");
  assert.ok(
    ![commands[0].clientRequestId, commands[2].clientRequestId].includes(
      commands[4].clientRequestId,
    ),
  );
  closeDecisions.push(false);
  await form.getByRole("button", { name: "글자 읽기 초안 닫기", exact: true }).click();
  assert.equal(await text.inputValue(), prepared.raw);
  assert.equal(await confirmation.isChecked(), true);
  await attempt("missing");
  assert.deepEqual(commands[5], commands[4]);
  await page.setViewportSize({ width: 390, height: 844 });
  await save().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await form.screenshot({ path: path.join(output, "local-ocr-retry-mobile.png") });
  closeDecisions.push(true);
  await form.getByRole("button", { name: "글자 읽기 초안 닫기", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  assert.equal(commands.length, 6);
  await card().getByRole("button", { name: "이 PC에서 글자 읽기", exact: true }).click();
  await form.waitFor();
  assert.equal(await text.inputValue(), prepared.preview.text);
  assert.equal(await confirmation.isChecked(), false);
  await edit(prepared.raw);
  await attempt("missing");
  assert.ok(!commands.slice(0, 6).some((c) => c.clientRequestId === commands[6].clientRequestId));
  assert.equal(previewReads, 2);
  assert.equal(closeDialogs, 2);
  record(
    "returning to earlier text gets a new request; cancelled close preserves it, explicit close and reread start a fresh preview",
  );
  patchMode = "exact";
  await save().click();
  await form.waitFor({ state: "hidden" });
  assert.deepEqual(commands[7], commands[6]);
  await card()
    .getByText(/^직접 입력 · [0-9,]+자$/)
    .waitFor();
  assert.ok((await card().innerText()).includes(prepared.raw.trim()));
  assert.equal(company.sources[0].text, prepared.raw.trim());
  assert.equal(company.sources[0].originalName, original.sources[0].originalName);
  assert.deepEqual(company.sourceOcrReviews[0], original.sourceOcrReviews[0]);
  assert.deepEqual(company.sources[1], original.sources[1]);
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /자료/ }).click();
  await card()
    .getByText(/^직접 입력 · [0-9,]+자$/)
    .waitFor();
  assert.equal(commands.length, 8);
  assert.equal(caseReads, 1);
  assert.equal(previewReads, 2);
  for (const key of Object.keys(original)) {
    if (
      [
        "revision",
        "updatedAt",
        "sources",
        "sourceOcrReviews",
        "plans",
        "analysis",
        "selectedCandidateId",
      ].includes(key)
    )
      continue;
    assert.deepEqual(company[key], original[key]);
  }
  assert.deepEqual(
    company.plans,
    original.plans.map((p) => ({ ...p, confirmedAt: null })),
  );
  assert.equal(company.analysis, null);
  assert.equal(company.selectedCandidateId, null);
  record(
    "saved text survives tab roundtrip; manuscript content preserved with confirmation cleared; no automatic retry or original-file read",
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
        distinctRequests: new Set(commands.map((c) => c.clientRequestId)).size,
        closeDialogs,
        explicitPreviewReads: 2,
        syntheticCompanyGets: caseReads,
        syntheticPreviewPosts: previewReads,
        syntheticIntakeGets: intakeReads,
        actualOcr: 0,
        originalReads: 0,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "OCR preview and receipts are synthetic memory only; original bytes are not read, OCR is not executed, checkbox is synthetic input, no human accuracy acceptance, download, AI, SQL or institution execution",
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
