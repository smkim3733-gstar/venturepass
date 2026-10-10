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
const scenario = "source-recovery";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-source-review.tsx",
  "scripts/fixtures/guided-plan-confirmation.ts",
  "scripts/guided-source-recovery-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-source-recovery-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-plan-confirmation.ts"),
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
let company = fixture.confirmationCompany();
company.profile.companyName = "합성 자료 교정 복구 기업";
company.sources = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "합성 교정 자료",
    kind: "technology",
    text: "처음 보관한 합성 자료 본문",
    extraction: "manual",
    originalName: "synthetic-note.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    warnings: [],
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  },
];
const original = structuredClone(company),
  name = company.profile.companyName,
  caseId = company.id,
  baseSource = company.sources[0];
const edited = "원본과 대조하여 고친 합성 본문\n매출은 확인 대기";
let saved,
  readMode = "initial",
  caseReads = 0,
  intakeReads = 0;
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
      const root = "/api/studio/cases/" + caseId;
      if (req.method() === "GET") {
        if (u.pathname === "/api/studio/status")
          return reply({
            aiConfigured: true,
            model: fixture.model,
            storage: "local",
            supportedFiles: [],
          });
        if (u.pathname === "/api/studio/cases")
          return reply({
            cases: [
              {
                id: caseId,
                companyName: name,
                industry: "",
                stage: company.stage,
                revision: company.revision,
                createdAt: company.createdAt,
                updatedAt: company.updatedAt,
                sourceCount: 1,
                planCount: company.plans.length,
                pendingTaskCount: 0,
              },
            ],
          });
        if (u.pathname === root) {
          caseReads++;
          if (readMode === "http") return reply({ error: "INTERNAL_SYNTHETIC_ERROR" }, 503);
          if (readMode === "foreign")
            return reply({ ...saved, id: "99999999-9999-4999-8999-999999999999" });
          if (readMode === "wrong") {
            const value = structuredClone(saved);
            value.sources[0].text = "다른 본문";
            return reply(value);
          }
          if (readMode === "invalid") return reply({ invalid: true });
          if (readMode === "exact") {
            company = structuredClone(saved);
            return reply(company);
          }
          return reply(company);
        }
        if (u.pathname === root + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        if (u.pathname === root + "/preparation-automation")
          return reply({ company, active: false });
        if (u.pathname === root + "/guided-preparation")
          return reply({ company, active: false, aiConfigured: false, approval: null });
      }
      if (req.method() === "PATCH" && u.pathname === root) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.ok(commands.length <= 2, "No automatic or repeated save");
        assert.equal(command.action, "source");
        assert.equal(command.revision, company.revision);
        assert.deepEqual(command.source, {
          ...company.sources[0],
          text: commands.length === 1 ? edited : edited + "\n별도 명시 수정",
          extraction: "manual",
          updatedAt: command.source.updatedAt,
        });
        assert.ok(Number.isFinite(Date.parse(command.source.updatedAt)));
        saved = structuredClone(company);
        saved.revision++;
        saved.sources[0] = command.source;
        if (commands.length === 1) return reply({ ...company, revision: saved.revision });
        company = structuredClone(saved);
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
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  const steps = page.getByRole("navigation", { name: "신청 준비 3단계" });
  await steps.getByRole("button").filter({ hasText: "자료 올리기" }).click();
  const open = page.getByRole("button", {
    name: "본문 확인·고치기 · " + baseSource.name,
    exact: true,
  });
  await open.click();
  const panel = page.getByRole("region", { name: "자료 본문 확인" });
  const input = panel.getByLabel("원본과 대조할 본문", { exact: true });
  const consent = panel.getByRole("checkbox");
  const save = panel.getByRole("button", { name: "확인한 본문 저장", exact: true });
  await input.fill(edited);
  await consent.check();
  await save.click();
  await page.getByText("저장 결과를 확인하지 못했습니다.", { exact: false }).waitFor();
  const inspect = panel.getByRole("button", { name: "본문 저장 상태 확인", exact: true });
  assert.equal(
    await inspect.count(),
    1,
    "Unconfirmed correction must offer exact read-only recovery",
  );
  await inspect.waitFor();
  assert.equal(
    await page.getByText("확인한 본문을 저장하고 있습니다.", { exact: true }).count(),
    0,
  );
  assert.equal(await input.inputValue(), edited);
  assert.equal(await consent.isChecked(), true);
  assert.equal(await input.getAttribute("readonly"), "");
  assert.equal(await panel.getByRole("button", { name: "닫기", exact: true }).isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(await steps.getByRole("button").filter({ hasText: "AI 계획서" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "상세 도구", exact: true }).isDisabled(),
    true,
  );
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 1);
  record(
    "missing saved body retains correction and consent, blocks close/navigation/resave, and offers explicit recovery without automatic GET",
  );
  for (const mode of ["foreign", "wrong", "invalid", "http"]) {
    readMode = mode;
    const before = caseReads;
    await inspect.click();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].find(
          (b) => b.textContent === "본문 저장 상태 확인",
        )?.disabled,
    );
    assert.equal(caseReads, before + 1);
    assert.equal(commands.length, 1);
    assert.equal(await input.inputValue(), edited);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await panel.getByRole("button", { name: "닫기", exact: true }).isDisabled(), true);
    assert.equal(await page.getByText("INTERNAL_SYNTHETIC_ERROR", { exact: false }).count(), 0);
  }
  record(
    "explicit reads reject another company, different body, malformed response and HTTP error while keeping the original correction",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await inspect.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, "source-save-recovery-mobile.png"),
    fullPage: true,
  });
  readMode = "exact";
  await inspect.click();
  await open.waitFor();
  assert.equal(await panel.count(), 0);
  await open.click();
  await input.waitFor();
  assert.equal(await input.inputValue(), edited);
  assert.equal(await consent.isChecked(), false);
  await input.fill(edited + "\n별도 명시 수정");
  await consent.check();
  await save.click();
  await open.waitFor();
  assert.equal(await panel.count(), 0);
  assert.equal(commands.length, 2);
  assert.equal(caseReads, 6);
  assert.deepEqual(company.plans, original.plans);
  assert.equal(company.sources[0].originalName, baseSource.originalName);
  await steps.getByRole("button").filter({ hasText: "AI 계획서" }).click();
  assert.equal(
    await page
      .getByRole("link", { name: "원고 v2 Word 내려받기", exact: true })
      .getAttribute("href"),
    "/api/studio/cases/" + caseId + "/export?planId=" + original.plans.at(-1).id + "&format=docx",
  );
  record(
    "only exact saved correction closes the editor; a separate explicit edit saves normally with source identity and stored manuscripts preserved",
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
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "memory-only source correction response; explicit GET recovery, no actual storage or OCR/AI execution",
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
