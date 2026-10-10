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
const scenario = "section-target";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/manual-plan-save.ts",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/guided-answer-workflow.ts",
  "scripts/guided-section-target-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-section-target-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-answer-workflow.ts"),
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
const company = fixture.answerWorkflowCompany();
company.profile.companyName = "합성 중복 항목 원고 기업";
company.plans[0].content.sections[0].needsConfirmation = true;
company.plans[0].content.sections.splice(1, 0, {
  ...structuredClone(company.plans[0].content.sections[0]),
  title: "다른 고객의 문제",
  content: "둘째 중복 본문 · 첫 항목과 다른 문장을 보존합니다.",
});
const second = fixture.answerWorkflowCompany();
second.id = crypto.randomUUID();
second.profile.companyName = "합성 같은 버전 원고 기업";
second.plans[0].id = crypto.randomUUID();
second.plans.push({ ...structuredClone(second.plans[0]), id: crypto.randomUUID() });
const companies = [company, second],
  original = structuredClone(companies),
  name = company.profile.companyName;
const editedText = "  유일한 기술 개발 항목만 직접 고쳤습니다.\n줄바꿈과 양끝 공백 보존  ";
let caseReads = 0;
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
        commands.push(structuredClone(command));
        assert.equal(commands.length, 1);
        assert.equal(command.action, "save-plan");
        assert.equal(command.planId, original[0].plans[0].id);
        assert.equal(command.revision, original[0].revision);
        const expected = structuredClone(original[0].plans[0].content);
        expected.sections[2].content = editedText;
        expected.sections[2].needsConfirmation = true;
        assert.deepEqual(command.content, expected);
        company.revision++;
        company.plans.push({
          ...structuredClone(company.plans[0]),
          id: crypto.randomUUID(),
          version: 2,
          generatedAt: new Date().toISOString(),
          mode: "manual",
          confirmedAt: null,
          content: structuredClone(command.content),
        });
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
  const full = () =>
    page.locator("details").filter({
      has: page.locator(":scope > summary", { hasText: /^전체 사업계획서 읽기$/ }),
    });
  const edits = () => full().getByRole("button", { name: /^이 부분 고치기/ });
  await full().locator(":scope > summary").click();
  assert.ok((await full().innerText()).includes("둘째 중복 본문"));
  assert.equal(await edits().count(), 3);
  assert.equal(await edits().nth(0).isDisabled(), true);
  assert.equal(await edits().nth(1).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "내용 고치기", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "확인이 필요한 부분 보기", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.locator("#guided-section").count(), 0);
  assert.ok(
    (await page.locator("body").innerText()).includes("고칠 항목을 하나로 확인하지 못했습니다"),
  );
  assert.equal(commands.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await full().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await full().screenshot({ path: path.join(output, "section-target-mobile.png") });
  record(
    "duplicate keys remain readable but both full-text entry points, main edit and confirmation-needed shortcut refuse an ambiguous target; no input or save",
  );

  assert.equal(await edits().nth(2).isDisabled(), false);
  await edits().nth(2).click();
  const input = () => page.locator("#guided-section");
  await input().waitFor();
  assert.equal(await input().inputValue(), original[0].plans[0].content.sections[2].content);
  assert.equal(
    await page
      .getByRole("checkbox", { name: "이 항목의 사실·수치·근거를 직접 확인했습니다." })
      .isChecked(),
    false,
  );
  await input().fill(editedText);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "수정 취소", exact: true }).click();
  assert.equal(await input().inputValue(), editedText);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "수정 취소", exact: true }).click();
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  await full().locator(":scope > summary").click();
  await edits().nth(2).click();
  await input().fill(editedText);
  await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(company.plans.length, 2);
  assert.deepEqual(company.plans[0], original[0].plans[0]);
  assert.deepEqual(
    company.plans[1].content.sections.slice(0, 2),
    original[0].plans[0].content.sections.slice(0, 2),
  );
  assert.equal(company.plans[1].content.sections[2].content, editedText);
  assert.equal(company.plans[1].content.sections[2].needsConfirmation, true);
  assert.equal(company.plans[1].confirmedAt, null);
  assert.equal(
    await page
      .getByRole("link", { name: "원고 v2 Word 내려받기", exact: true })
      .getAttribute("href"),
    "/api/studio/cases/" + company.id + "/export?planId=" + company.plans[1].id + "&format=docx",
  );
  record(
    "the unique third section still opens exactly, preserves cancelled input and saves only its content into a new unreviewed version, keeping both duplicate sections and the original plan",
  );

  await page.getByRole("button", { name: "기업 목록", exact: true }).click();
  await page.getByRole("button").filter({ hasText: second.profile.companyName }).first().click();
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  await full().locator(":scope > summary").click();
  assert.equal(await edits().count(), 2);
  assert.deepEqual(await edits().evaluateAll((nodes) => nodes.map((node) => node.disabled)), [
    true,
    true,
  ]);
  assert.equal(
    await page.getByRole("button", { name: "내용 고치기", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.locator("#guided-section").count(), 0);
  assert.deepEqual(second, original[1]);
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 2);
  record(
    "equal latest versions do not choose a manuscript by array order; section editing is blocked and the other company remains unchanged without extra save or AI",
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

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "ambiguous current section targets blocked; one explicit unique-section save in memory; no export or AI",
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
