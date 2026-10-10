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
assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/public-evidence-panel.tsx",
  "src/components/studio/guided-workspace.tsx",
  "src/lib/studio-public-evidence.ts",
  "src/components/studio/shared.tsx",
  "scripts/fixtures/guided-public-recovery.ts",
  "scripts/guided-public-reentry-validation.mjs",
  "src/components/studio/public-evidence-recovery.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-public-reentry-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-public-recovery.ts"),
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
let company = fixture.recoveryCompany();
const original = structuredClone(company);
const name = company.profile.companyName,
  caseId = company.id;
const network = [];
const commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [];
let recoveryReads = 0;
let readMode = "stale";
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
                sourceCount: company.sources.length,
                planCount: company.plans.length,
                pendingTaskCount: 0,
              },
            ],
          });
        if (u.pathname === root) {
          if (!commands.length) return reply(company);
          recoveryReads++;
          if (readMode === "stale") return reply(original);
          if (readMode === "mismatch") {
            const wrong = structuredClone(company);
            wrong.sources[0].text = "정확한 발췌가 아닌 합성 응답";
            return reply(wrong);
          }
          return reply(company);
        }
        if (u.pathname === root + "/source-intakes") return reply({ company, activeItemIds: [] });
        if (u.pathname === root + "/guided-preparation") return reply(fixture.status(company));
      }
      if (req.method() === "PATCH" && u.pathname === root) {
        assert.equal(commands.length, 0, "Never resend an uncertain save");
        const command = req.postDataJSON();
        company = fixture.save(company, command);
        commands.push(structuredClone(command));
        const wrong = structuredClone(company);
        wrong.sources[0].text = "의도한 불완전 저장 응답";
        return reply(wrong);
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
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: /자료 올리기/ })
    .click();
  await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
  const panel = page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
  const title = panel.getByRole("textbox", { name: "공개 자료 제목", exact: true });
  const quote = "합성 산업 자료의 문장입니다. 회사의 매출이나 계약을 확인한 결과가 아닙니다.";
  await title.fill("복구 흐름용 공개 자료");
  await panel
    .getByRole("textbox", { name: "원문 URL (HTTPS)", exact: true })
    .fill("https://example.invalid/report");
  await panel.getByRole("textbox", { name: "원문 발췌" }).fill(quote);
  await panel.getByLabel("원문을 읽은 날짜 (담당자 기록)", { exact: true }).fill("2026-10-10");
  const close = panel.getByRole("button", { name: "닫기", exact: true });
  const save = panel.getByRole("button", { name: "공개 근거 후보 보관", exact: true });
  await panel.getByRole("checkbox", { name: /발췌와 출처를 확인/ }).check();
  const key = `venturepass:public-evidence:v1:${caseId}`;
  await page.evaluate(() => {
    window.originalStorageWrite = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("venturepass:public-evidence:")) throw Error("Synthetic quota failure");
      return window.originalStorageWrite.call(this, key, value);
    };
  });
  await save.click();
  await panel.getByText("복구 기록을 안전하게 보관하지 못했습니다.", { exact: false }).waitFor();
  assert.equal(commands.length, 0);
  assert.equal(await title.inputValue(), "복구 흐름용 공개 자료");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.originalStorageWrite;
    delete window.originalStorageWrite;
  });
  record("browser persistence failure prevents transmission and preserves the unsent draft");

  await save.click();
  await panel.getByText("저장 결과가 미확인입니다.", { exact: false }).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(recoveryReads, 1);
  const stored = await page.evaluate((key) => localStorage.getItem(key), key);
  const identity = JSON.parse(stored);
  assert.deepEqual(Object.keys(identity).sort(), [
    "caseId",
    "digest",
    "format",
    "revision",
    "sectionKey",
    "sourceId",
  ]);
  assert.equal(identity.caseId, caseId);
  assert.equal(identity.sourceId, commands[0].source.id);
  assert.equal(identity.revision, commands[0].revision);
  assert.ok(
    !stored.includes(quote) &&
      !stored.includes("example.invalid") &&
      !stored.includes("복구 흐름용"),
  );
  assert.equal(await close.isDisabled(), true);
  record("original request identity is persisted without evidence contents before the single save");

  readMode = "exact";
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await panel.getByText("이전 공개 근거 저장 요청이 미확인입니다.", { exact: false }).waitFor();
  assert.equal(await panel.getByRole("textbox").count(), 0);
  assert.equal(await save.count(), 0);
  assert.equal(await close.isDisabled(), true);
  assert.equal(commands.length, 1);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), stored);
  record(
    "real reload and company re-entry reopen the unresolved request without draft duplication or resend",
  );

  readMode = "mismatch";
  const inspect = panel.getByRole("button", { name: "이 자료의 저장 상태 확인", exact: true });
  await inspect.click();
  await panel.getByText("원래 공개 근거의 저장을 확인하지 못했습니다.", { exact: false }).waitFor();
  assert.equal(await close.isDisabled(), true);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), stored);
  assert.equal(commands.length, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, "public-evidence-reentry-mobile.png"),
    fullPage: true,
  });
  record(
    "same-ID different-body response after reload keeps the recovery identity and mobile controls locked",
  );

  readMode = "exact";
  // Close the tab entirely, then re-enter in another tab of the same isolated browser profile.
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  const reopened = page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
  await reopened.getByText("이전 공개 근거 저장 요청이 미확인입니다.", { exact: false }).waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), stored);
  await reopened.getByRole("button", { name: "이 자료의 저장 상태 확인", exact: true }).click();
  await reopened.getByText("공개 근거 후보를 보관했습니다.", { exact: false }).waitFor();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
  assert.equal(commands.length, 1);
  assert.ok((await reopened.innerText()).includes(quote));
  assert.deepEqual(company.plans, original.plans);
  await reopened.getByRole("button", { name: "닫기", exact: true }).click();
  await reopened.waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("button", { name: "상세 도구", exact: true }).isEnabled(),
    true,
  );
  record(
    "tab re-entry and explicit exact GET clear only the original identity and preserve the manuscript",
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
        syntheticApiCommands: commands.length,
        syntheticExports: 0,
        recoveryReads,
        continuousJourneys: 1,
        startingState:
          "existing synthetic manuscript; persistence failure then single public-evidence save, real reload and tab re-entry, mismatch and exact GET recovery; no writer, SQL or provider",
        commandActions: commands.map((c) => c.action),
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
