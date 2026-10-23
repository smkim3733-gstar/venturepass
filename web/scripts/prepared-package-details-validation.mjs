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
const scenario = "prepared-package-details";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/prepared-packages-panel.tsx",
  "src/components/studio/prepared-package-details.tsx",
  "src/components/studio/prepared-package-ui.ts",
  "scripts/fixtures/prepared-package-details.ts",
  "scripts/prepared-package-details-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-prepared-details-ui-"));
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
  input: path.join(app, "scripts/fixtures/prepared-package-details.ts"),
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
const { company, record: archive, emptyRecord, summaries } = fixture.preparedDetailsFixture();
const originalArchives = structuredClone([archive, emptyRecord]);
const detailReads = [],
  releases = new Map();
let listReads = 0;
const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0,
  nextDialog = "dismiss";
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
  await context.addInitScript(() => {
    const originalFetch = window.fetch;
    window.syntheticDetailSignals = [];
    window.syntheticDetailResponses = [];
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (!/\/prepared-packages\/[^/]+$/.test(url.pathname)) return originalFetch(input, init);
      const index = window.syntheticDetailSignals.push(init.signal);
      const response = await originalFetch(input, { ...init, signal: undefined });
      const json = response.json.bind(response);
      response.json = async () => {
        const value = await json();
        window.syntheticDetailResponses.push(index);
        return value;
      };
      return response;
    };
  });
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
        const archiveBase = "/api/studio/cases/" + company.id + "/prepared-packages";
        if (u.pathname === archiveBase) {
          listReads++;
          return reply({ caseId: company.id, caseRevision: company.revision, packages: summaries });
        }
        const target = [archive, emptyRecord].find(
          (item) => u.pathname === archiveBase + "/" + item.id,
        );
        if (target) {
          const index = detailReads.push(target.id);
          const mode = await new Promise((resolve) => releases.set(index, resolve));
          releases.delete(index);
          if (mode === "error") return reply({ error: "合성 상세 실패" }, 500);
          return reply({
            package:
              mode === "wrong" ? { ...target, id: "c0000000-0000-4000-8000-000000009999" } : target,
          });
        }
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

  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: /AI 계획서/ })
    .click();
  await page.getByText("추가 자료·AI 다시 작성·내려받기", { exact: true }).click();
  await page.getByRole("button", { name: "원고·첨부 보관 및 내려받기", exact: true }).click();
  const list = page.getByRole("region", { name: "보관한 준비본", exact: true });
  const row = list
    .locator("details")
    .filter({ has: page.locator(":scope > summary", { hasText: "준비본 1 ·" }) });
  const summary = row.locator(":scope > summary");
  await summary.click();
  const panel = page.locator('[aria-label="준비본 1 보관 내용"]');
  const lookup = () => panel.getByRole("button", { name: /보관 (당시 내용 보기|내용 다시 읽기)/ });
  assert.equal(detailReads.length, 0);
  const sourcePicker = page.getByText("포함할 원본 직접 선택", { exact: false });
  await sourcePicker.click();
  const selected = page
    .getByRole("region", { name: "제출 준비 묶음", exact: true })
    .getByRole("checkbox");
  await selected.check();
  const settledReads = { caseReads, preparationReads, listReads };
  const begin = async (n) => {
    await lookup().focus();
    await lookup().press("Enter");
    const deadline = Date.now() + 10000;
    while (!releases.has(n) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(releases.has(n));
  };
  const finish = async (n, mode = "valid") => {
    releases.get(n)(mode);
    await page.waitForFunction((n) => window.syntheticDetailResponses.includes(n), n);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  };
  await begin(1);
  await finish(1, "wrong");
  await panel.getByRole("alert").waitFor();
  assert.equal(await panel.getByRole("region", { name: "보관 당시 선택 원본" }).count(), 0);
  await begin(2);
  await finish(2);
  await panel.getByText("보관 당시 기술자료", { exact: true }).waitFor();
  assert.equal(await panel.getByText("현재 이름으로 바뀐 자료", { exact: true }).count(), 0);
  await panel.getByText("보관 당시 본문 확인 전 · 원본 포함", { exact: true }).waitFor();
  await panel.getByText("내부 검토 완료 표시가 없습니다.", { exact: true }).waitFor();
  await panel.getByText("추가 확인이 필요한 보관 사유: constructor", { exact: true }).waitFor();
  assert.equal(await selected.isChecked(), true);
  record(
    "Opening a summary makes no detail request; mismatched archive rejected; explicit retry reads historical filenames and review reasons without using renamed current sources or changing selected originals",
  );

  const bodySummary = panel.getByText("보관한 원고 본문 읽기", { exact: true });
  await bodySummary.focus();
  await bodySummary.press("Space");
  const body = panel.locator('p[tabindex="0"]').first();
  assert.equal(await body.textContent(), archive.plan.content.sections[0].content);
  assert.equal(await panel.locator("script").count(), 0);
  await panel.getByText("원고에 저장된 검토 의견 1개", { exact: true }).click();
  await panel.getByText("보관 당시 주장 근거 대조 필요", { exact: true }).waitFor();
  await panel.getByText("보관 시 규칙 점검 의견 0개", { exact: true }).click();
  await panel.getByText("보관된 의견이 없습니다.", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await body.focus();
  await body.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: path.join(output, "historical-body-mobile.png") });
  assert.equal(await selected.isChecked(), true);
  record(
    "390px keyboard disclosure shows frozen manuscript whitespace and markup as text, separates stored review from archive-time rule findings, and keeps original selection",
  );

  await begin(3);
  await summary.focus();
  await summary.press("Space");
  await page.waitForFunction(() => window.syntheticDetailSignals[2].aborted);
  await summary.click();
  assert.equal(detailReads.length, 3);
  await begin(4);
  await finish(3, "error");
  assert.equal(await panel.getByRole("alert").count(), 0);
  assert.equal(
    await panel.getByRole("button", { name: "보관 내용 읽는 중…", exact: true }).isDisabled(),
    true,
  );
  await finish(4);
  await panel.getByText("보관 당시 기술자료", { exact: true }).waitFor();
  await begin(5);
  await panel.getByRole("button", { name: "읽기 대기 중단", exact: true }).click();
  assert.equal(await page.evaluate(() => window.syntheticDetailSignals[4].aborted), true);
  await finish(5);
  assert.equal(await panel.getByRole("region", { name: "보관 당시 선택 원본" }).count(), 0);
  assert.equal(await lookup().isEnabled(), true);
  record(
    "Collapse and explicit stop abort held reads; late failure/success cannot replace a newer read or reopen cleared contents; reopening never retries automatically",
  );

  const row2 = list
    .locator("details")
    .filter({ has: page.locator(":scope > summary", { hasText: "준비본 2 ·" }) });
  await row2.locator(":scope > summary").click();
  const secondPanel = page.locator('[aria-label="준비본 2 보관 내용"]');
  await secondPanel.getByRole("button", { name: "보관 당시 내용 보기", exact: true }).click();
  const deadline = Date.now() + 10000;
  while (!releases.has(6) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(releases.has(6));
  await finish(6);
  await secondPanel
    .getByText("선택한 원본이 없는 준비본입니다. 원고와 점검 자료는 포함됩니다.", { exact: true })
    .waitFor();
  await secondPanel
    .getByText("기록된 사유가 없습니다. 기관 제출 준비나 승인 여부를 확인한 결과는 아닙니다.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await selected.isChecked(), true);
  assert.deepEqual({ caseReads, preparationReads, listReads }, settledReads);
  assert.deepEqual(companies, original);
  assert.deepEqual([archive, emptyRecord], originalArchives);
  assert.deepEqual(commands, []);
  assert.deepEqual(dialogs, []);
  record(
    "Empty attachments/reasons are explained without upgrading submission status; six explicit synthetic detail GETs, zero writes/downloads and company/archive records unchanged",
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
        syntheticPreparationGets: preparationReads,
        syntheticUploadPosts: 0,
        syntheticPreviewPosts: 0,
        commands,
        dialogs,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "historical prepared package contents with renamed current source, response mismatch and cancellation",
        syntheticListGets: listReads,
        syntheticDetailGets: detailReads.length,
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
  for (const release of releases.values()) release("error");
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
