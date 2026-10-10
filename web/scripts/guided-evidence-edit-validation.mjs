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
const scenario = "evidence-edit";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/public-preview-cancel.ts",
  "scripts/guided-evidence-edit-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-evidence-edit-ui-"));
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
  input: path.join(app, "scripts/fixtures/public-preview-cancel.ts"),
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
let { company } = fixture.previewCompanyFixture(1);
company.profile.companyName = "합성 근거에서 원고 편집";
const basePlan = company.plans.at(-1);
basePlan.content.sections[1].title = "개발 범위";
basePlan.content.sections[1].content =
  "현재 개발 범위를 정리한 합성 원고입니다.\n성과는 별도 확인합니다.";
basePlan.content.sections[0].evidence = [
  { sourceId: company.sources[0].id, quote: "2023년 산업 표본", locator: "합성 출처 첫 부분" },
];
basePlan.content.sections[1].evidence = [
  { sourceId: company.sources[0].id, quote: "개발 완료 27%", locator: "확인이 필요한 합성 인용" },
];
const original = structuredClone(company);
const name = company.profile.companyName,
  caseId = company.id;
const targetSection = basePlan.content.sections[1];
const edited = "  실제 개발 단계는 검토 중입니다.\n성과 수치를 확인한 뒤 반영합니다.  ";
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0;
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
                sourceCount: company.sources.length,
                planCount: company.plans.length,
                pendingTaskCount: 0,
              },
            ],
          });
        if (u.pathname === root) {
          caseReads++;
          return reply(company);
        }
        if (u.pathname === root + "/plan-supplements/execution")
          return reply({
            company,
            active: false,
            retainedCapture: false,
            executions: [],
            transmissionAllowed: false,
          });
        if (u.pathname === root + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        if (u.pathname === root + "/preparation-automation")
          return reply({ company, active: false });
        if (u.pathname === root + "/guided-preparation") {
          preparationReads++;
          return reply({ company, active: false, aiConfigured: false, approval: null });
        }
      }
      if (req.method() === "PATCH" && u.pathname === root) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.equal(commands.length, 1, "Only the explicit target edit may save");
        assert.equal(command.action, "save-plan");
        assert.equal(command.planId, basePlan.id);
        assert.equal(command.revision, original.revision);
        assert.deepEqual(command.content, {
          ...basePlan.content,
          sections: basePlan.content.sections.map((section, index) =>
            index === 1 ? { ...section, content: edited, needsConfirmation: true } : section,
          ),
        });
        company = structuredClone(original);
        company.revision++;
        company.plans.push({
          ...structuredClone(basePlan),
          id: crypto.randomUUID(),
          version: basePlan.version + 1,
          generatedAt: new Date().toISOString(),
          mode: "manual",
          confirmedAt: null,
          content: command.content,
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
  await page.getByRole("button", { name: "내용 고치기", exact: true }).waitFor();
  const btn = (label) => page.getByRole("button", { name: label, exact: true });
  const input = page.locator("#guided-section");
  const checked = () =>
    page.getByRole("checkbox", {
      name: "이 항목의 사실·수치·근거를 직접 확인했습니다.",
      exact: true,
    });
  async function openEvidence(section) {
    const main = page
      .locator("details")
      .filter({ has: page.locator(":scope > summary", { hasText: /^기준·근거 보기$/ }) })
      .first();
    if (!(await main.evaluate((element) => element.open)))
      await main.locator(":scope > summary").click();
    const row = main
      .locator("details")
      .filter({ has: page.locator(":scope > summary", { hasText: section.title + " · 근거 1개" }) })
      .first();
    if (!(await row.evaluate((element) => element.open)))
      await row.locator(":scope > summary").click();
    const quotePanel = row
      .locator("details")
      .filter({
        has: page.locator(":scope > summary", { hasText: section.evidence[0].locator }),
      })
      .first();
    if (!(await quotePanel.evaluate((element) => element.open)))
      await quotePanel.locator(":scope > summary").click();
    return row;
  }
  let row = await openEvidence(targetSection);
  assert.ok((await row.innerText()).includes("현재 등록본문과 인용문이 달라요"));
  assert.ok((await row.innerText()).includes("개발 완료 27%"));
  await row.getByRole("button", { name: "이 항목의 원고 고치기 · 개발 범위", exact: true }).click();
  await input.waitFor();
  assert.equal(await input.inputValue(), targetSection.content);
  assert.equal(await checked().isChecked(), false);
  assert.equal(commands.length, 0);
  assert.deepEqual(company, original);
  record(
    "evidence mismatch opens the exact second section without changing quote, source, confirmation or saved manuscript",
  );

  await input.fill(edited);
  page.once("dialog", (dialog) => dialog.dismiss());
  await btn("수정 취소").click();
  assert.equal(await input.inputValue(), edited);
  page.once("dialog", (dialog) => dialog.accept());
  await btn("수정 취소").click();
  await btn("내용 고치기").waitFor();
  row = await openEvidence(basePlan.content.sections[0]);
  assert.ok((await row.innerText()).includes("현재 등록본문에 인용문이 있어요"));
  await row
    .getByRole("button", {
      name: "이 항목의 원고 고치기 · " + basePlan.content.sections[0].title,
      exact: true,
    })
    .click();
  assert.equal(await input.inputValue(), basePlan.content.sections[0].content);
  assert.equal(await checked().isChecked(), false);
  await btn("수정 취소").click();
  assert.equal(commands.length, 0);
  assert.deepEqual(company, original);
  record(
    "cancel refusal keeps typed text, accepted cancel preserves saved plan, another citation opens its own section with no automatic save",
  );

  row = await openEvidence(targetSection);
  await page.setViewportSize({ width: 390, height: 844 });
  await row.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await row.screenshot({ path: path.join(output, "evidence-edit-mobile.png") });
  await row.getByRole("button", { name: "이 항목의 원고 고치기 · 개발 범위", exact: true }).click();
  await input.fill(edited);
  await btn("수정 반영하기").click();
  await btn("내용 고치기").waitFor();
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 1);
  const latest = company.plans.at(-1);
  assert.deepEqual(company.plans.slice(0, -1), original.plans);
  assert.deepEqual(company.sources, original.sources);
  assert.equal(latest.confirmedAt, null);
  assert.equal(latest.content.sections[1].needsConfirmation, true);
  assert.deepEqual(latest.content.sections[0], original.plans.at(-1).content.sections[0]);
  assert.deepEqual(latest.content.sections[1].evidence, targetSection.evidence);
  assert.equal(
    await page
      .getByRole("link", { name: "원고 v" + latest.version + " Word 내려받기", exact: true })
      .getAttribute("href"),
    "/api/studio/cases/" + caseId + "/export?planId=" + latest.id + "&format=docx",
  );
  row = await openEvidence(latest.content.sections[1]);
  assert.ok((await row.innerText()).includes("현재 등록본문과 인용문이 달라요"));
  await row.getByRole("button", { name: "이 항목의 원고 고치기 · 개발 범위", exact: true }).click();
  assert.equal(await input.inputValue(), edited);
  assert.equal(await checked().isChecked(), false);
  await btn("수정 취소").click();
  record(
    "separate explicit save changes only the chosen section in a new unconfirmed version; old version, citations, sources, other section and exact Word target are retained",
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
        syntheticPreparationReads: preparationReads,
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "memory-only evidence-to-section editing through existing save-plan; no actual storage, download or AI execution",
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
