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
const scenario = "manual-source-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/manual-source-response.ts",
  "src/components/studio/sources-panel.tsx",
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/manual-source-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-manual-source-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/manual-source-receipt.ts"),
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
const prepared = await fixture.manualSourceFixture();
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let phase = "create",
  phaseOriginal = structuredClone(company),
  phaseCommands = [];
let previewReads = 0,
  intakeReads = 0;
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
      if (req.method() === "PATCH" && u.pathname === "/api/studio/cases/" + company.id) {
        const command = req.postDataJSON();
        commands.push(command);
        phaseCommands.push(command);
        assert.ok(commands.length <= 11);
        assert.equal(command.action, "source");
        assert.equal(command.revision, phaseOriginal.revision);
        const expected = prepared[phase];
        assert.equal(command.source.name, expected.name);
        assert.equal(command.source.kind, expected.kind);
        assert.equal(command.source.text, expected.text);
        if (phase === "edit") assert.equal(command.source.id, expected.id);
        if (phaseCommands.length > 1) assert.deepEqual(command, phaseCommands[0]);
        if (patchMode === "transport")
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "합성 저장 응답을 받지 못했습니다." }),
          });
        const result = fixture.manualSourceResult(phaseOriginal, command.source);
        const saved = result.sources.find((s) => s.id === command.source.id);
        if (patchMode === "missing") result.sources = structuredClone(phaseOriginal.sources);
        if (patchMode === "text") saved.text = "다른 저장 본문";
        if (patchMode === "name") saved.name = "다른 자료 제목";
        if (patchMode === "kind") saved.kind = "finance";
        if (patchMode === "original")
          saved.originalName = phase === "create" ? "foreign.pdf" : null;
        if (patchMode === "other") result.sources[1].text = "변경된 다른 자료";
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
  await page.getByRole("tab", { name: /자료/ }).click();
  const form = page.getByRole("region", { name: "자료 편집", exact: true });
  const errorText =
    "자료의 저장 내용을 확인하지 못했습니다. 원래 제목·분류·본문과 자료 식별자를 유지했습니다.";
  for (const step of ["create", "edit"]) {
    phase = step;
    phaseOriginal = structuredClone(company);
    phaseCommands = [];
    const expected = prepared[step];
    if (step === "create")
      await page.getByRole("button", { name: "텍스트 자료 추가", exact: true }).click();
    else await page.getByRole("button", { name: "보관 원본 자료 수정", exact: true }).click();
    await form.waitFor();
    const nameInput = form.getByLabel("자료 제목", { exact: true }),
      kindInput = form.getByLabel("분류", { exact: true }),
      bodyInput = form.getByLabel("자료 내용", { exact: true });
    await nameInput.fill("  " + expected.name + "  ");
    await kindInput.selectOption(expected.kind);
    await bodyInput.fill(expected.text);
    const save = () => form.getByRole("button", { name: "자료 저장", exact: true });
    const modes =
      step === "create"
        ? ["missing", "transport", "text", "original"]
        : ["missing", "name", "kind", "original", "other"];
    for (const mode of modes) {
      patchMode = mode;
      await save().click();
      const message = mode === "transport" ? "합성 저장 응답을 받지 못했습니다." : errorText;
      await page.getByText(message, { exact: true }).first().waitFor();
      assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
      assert.equal(await nameInput.inputValue(), "  " + expected.name + "  ");
      assert.equal(await kindInput.inputValue(), expected.kind);
      assert.equal(await bodyInput.inputValue(), expected.text);
      assert.equal(await save().isDisabled(), false);
      assert.deepEqual(company, phaseOriginal);
      await page
        .getByText(message, { exact: true })
        .first()
        .waitFor({ state: "hidden", timeout: 15000 });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await save().scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await form.screenshot({ path: path.join(output, `manual-source-${step}-mobile.png`) });
    patchMode = "exact";
    await save().click();
    await form.waitFor({ state: "hidden" });
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: expected.name, exact: true }) });
    await card.waitFor();
    await card.getByText(/^직접 입력 · [0-9,]+자$/).waitFor();
    const id = phaseCommands[0].source.id;
    assert.equal(company.sources.filter((s) => s.id === id).length, 1);
    assert.equal(company.sources.find((s) => s.id === id).text, expected.text);
    assert.equal(phaseCommands.length, step === "create" ? 5 : 6);
    if (step === "edit") {
      assert.equal(company.sources[0].originalName, prepared.company.sources[0].originalName);
      assert.equal(company.sources[0].createdAt, prepared.company.sources[0].createdAt);
      assert.deepEqual(company.sources[0].warnings, ["원래 주의 메모"]);
    }
    record(
      step === "create"
        ? "new source survives four rejected saves with one stable ID and unchanged request; exact save closes editor without duplicate"
        : "original source edit survives five rejected saves; exact title/category/raw text and original link retained; editor closes only on acknowledgement",
    );
    await page
      .getByText("저장했습니다.", { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /자료/ }).click();
  for (const input of [prepared.create, prepared.edit])
    await page.getByRole("heading", { name: input.name, exact: true }).waitFor();
  assert.equal(await form.count(), 0);
  assert.equal(company.sources.length, 3);
  assert.equal(commands.length, 11);
  assert.equal(caseReads, 1);
  assert.notEqual(commands[0].source.id, commands[5].source.id);
  assert.deepEqual(company.sources[1], original.sources[1]);
  assert.deepEqual(company.sourceOcrReviews, original.sourceOcrReviews);
  for (const key of Object.keys(original)) {
    if (
      ["revision", "updatedAt", "sources", "plans", "analysis", "selectedCandidateId"].includes(key)
    )
      continue;
    assert.deepEqual(company[key], original[key]);
  }
  assert.deepEqual(
    company.plans,
    original.plans.map((p) => ({ ...p, confirmedAt: null })),
  );
  record(
    "both explicit saves survive tab roundtrip, other source and manuscript text preserved; no upload, OCR, original download or automatic retry",
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
        syntheticPreviewPosts: previewReads,
        syntheticIntakeGets: intakeReads,
        actualOcr: 0,
        originalReads: 0,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "Manual source commands and responses are synthetic memory only; no original bytes, upload, OCR, AI, SQL or institution execution; no server idempotency receipt is claimed",
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
