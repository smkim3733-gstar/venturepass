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
const scenario = "source-editor-focus";

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
  "scripts/source-editor-focus-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-source-editor-focus-ui-"));
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
const company = prepared.company;
company.sources.push({
  ...company.sources[1],
  id: fixture.manualId(4),
  name: "합성 시장 조사",
  text: "  고객 설명과 METRIC-47 합성 본문\n추가 확인할 시장 문장  ",
});
const name = company.profile.companyName,
  companies = [company],
  original = structuredClone(companies);
let previewReads = 0,
  intakeReads = 0,
  caseReads = 0;
let dialogAction = "dismiss";

const dialogs = [];
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
            aiConfigured: false,
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
        const intake = companies.find(
          (value) => u.pathname === `/api/studio/cases/${value.id}/source-intakes`,
        );
        if (intake) {
          intakeReads++;
          return reply({ company: intake, activeItemIds: [] });
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

  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message(), action: dialogAction });
    if (dialogAction === "accept") await dialog.accept();
    else await dialog.dismiss();
  });
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
  const intakeReady = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/source-intakes"),
  );
  await page.getByRole("tab", { name: /자료/ }).click();
  await intakeReady;
  await page.waitForFunction(() => document.querySelector("#source-file")?.matches(":enabled"));
  await page.setViewportSize({ width: 390, height: 844 });
  const form = page.getByRole("region", { name: "자료 편집", exact: true });
  const nameInput = page.locator("#source-name");
  const body = page.locator("#source-text");
  const kind = page.locator("#source-kind");
  const focused = [];
  const expectFocus = async (id) => {
    await page.waitForFunction((target) => document.activeElement?.id === target, id, {
      timeout: 10000,
    });
    const position = await page.locator("#" + id).evaluate((e) => {
      const rect = e.getBoundingClientRect();
      return { id: e.id, top: rect.top, bottom: rect.bottom, viewport: innerHeight };
    });
    assert.ok(
      position.top >= 0 && position.top < position.viewport,
      "Focused input must be in viewport before screenshot scrolling",
    );
    focused.push(position);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  };
  const capture = async (file) => {
    await page.screenshot({ path: path.join(output, file) });
  };
  const expectGuard = (expected) =>
    page.waitForFunction((value) => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented === value;
    }, expected);
  const lastEdit = page.getByRole("button", { name: "합성 시장 조사 수정", exact: true });
  await lastEdit.focus();
  await page.keyboard.press("Enter");
  await expectFocus("source-name");
  assert.equal(await nameInput.inputValue(), "합성 시장 조사");
  await capture("source-focus-existing-mobile.png");
  const draft = {
    name: "  입력 초점을 유지할 제목  ",
    text: "  현재 작성 중인 본문\n계속 입력합니다.  ",
  };
  await nameInput.fill(draft.name);
  await body.fill(draft.text);
  assert.equal(await body.evaluate((e) => document.activeElement === e), true);
  await kind.selectOption("patent");
  await expectGuard(true);
  const pendingEdit = page.getByRole("button", { name: "보관 원본 자료 수정", exact: true });
  await pendingEdit.click();
  assert.equal(dialogs.length, 1);
  assert.equal(await nameInput.inputValue(), draft.name);
  assert.equal(await body.inputValue(), draft.text);
  assert.equal(await kind.inputValue(), "patent");
  assert.equal(await nameInput.evaluate((e) => document.activeElement === e), false);
  assert.equal(await body.evaluate((e) => document.activeElement === e), false);
  record(
    "Opening a lower saved card by keyboard focuses its title within the mobile viewport; normal typing retains focus and rejected replacement retains the active draft without forcing input focus",
  );
  dialogAction = "accept";
  await pendingEdit.click();
  await expectFocus("source-text");
  assert.equal(await nameInput.inputValue(), "보관 원본 자료");
  assert.equal(await body.inputValue(), "");
  await capture("source-focus-original-mobile.png");
  await body.fill("  원본에서 확인할 합성 본문\n아직 저장하지 않았습니다.  ");
  dialogAction = "dismiss";
  await form.getByRole("button", { name: "자료 편집 취소", exact: true }).click();
  assert.equal(await body.inputValue(), "  원본에서 확인할 합성 본문\n아직 저장하지 않았습니다.  ");
  dialogAction = "accept";
  await form.getByRole("button", { name: "자료 편집 취소", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  await expectGuard(false);
  const add = page.getByRole("button", { name: "텍스트 자료 추가", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expectFocus("source-name");
  assert.equal(await nameInput.inputValue(), "");
  assert.equal(await body.inputValue(), "");
  assert.equal(await kind.inputValue(), "consultation");
  await capture("source-focus-new-mobile.png");
  await nameInput.fill("  새 합성 제목  ");
  await body.fill("새 합성 본문");
  assert.equal(await body.evaluate((e) => document.activeElement === e), true);
  await form.getByRole("button", { name: "자료 편집 취소", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  await expectGuard(false);
  record(
    "Accepted replacement of the draft opens pending-original body input; closing keeps existing confirmation rules, and new text opens an empty title field without sending or saving text",
  );
  const edit = page.getByRole("button", { name: "기존 자료 수정", exact: true });
  await edit.click();
  await expectFocus("source-name");
  assert.equal(await nameInput.inputValue(), "기존 자료");
  assert.equal(await body.inputValue(), "기존 본문");
  await body.focus();
  await edit.click();
  await expectFocus("source-name");
  assert.equal(await nameInput.inputValue(), "기존 자료");
  assert.equal(await body.inputValue(), "기존 본문");
  await form.getByRole("button", { name: "자료 편집 취소", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  await expectGuard(false);
  assert.equal(dialogs.length, 5);
  assert.equal(dialogs.filter((d) => d.action === "accept").length, 3);
  assert.equal(commands.length, 0);
  assert.equal(caseReads, 1);
  assert.equal(previewReads, 0);
  assert.deepEqual(companies, original);
  record(
    "Explicitly opening the same unchanged saved source again refocuses its title; clean close needs no extra confirmation and the synthetic company remains unchanged",
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
        dialogs,
        focused,
        syntheticUploadPosts: 0,
        syntheticPatches: 0,
        commands,
        syntheticCompanyGets: caseReads,
        syntheticPreviewPosts: previewReads,
        syntheticIntakeGets: intakeReads,
        actualOcr: 0,
        originalReads: 0,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "Explicit source editor opening and focus with synthetic records and unsaved text; no file selected. No actual source, writer, SQL, AI or external execution.",
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
