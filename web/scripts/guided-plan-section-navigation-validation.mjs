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
const scenario = "stored-section-navigation";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-plan-history.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/guided-plan-confirmation.ts",
  "scripts/guided-plan-section-navigation-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-plan-section-nav-ui-"));
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
const company = fixture.confirmationCompany();
company.profile.companyName = "합성 저장 원고 항목 이동 기업";
for (const plan of company.plans) {
  const template = plan.content.sections[0];
  plan.content.sections = Array.from({ length: 6 }, (_, index) => ({
    ...structuredClone(template),
    key: "synthetic-" + index,
    title: index === 0 || index === 3 ? "같은 이름의 항목" : "합성 항목 " + (index + 1),
    content:
      "  v" +
      plan.version +
      " 항목 " +
      (index + 1) +
      " 시작\n" +
      Array.from({ length: 35 }, (_, line) => "저장된 합성 본문 " + (line + 1)).join("\n") +
      "\n마지막 확인 문장  ",
    needsConfirmation: index % 2 === 0,
  }));
}
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
  dialogs = [],
  focusChecks = [];
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
            model: fixture.model,
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
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  const toggle = page.locator("summary").filter({ hasText: /^이전 원고 읽기$/ });
  await toggle.click();
  const panel = page.getByRole("region", { name: "저장된 원고 읽기", exact: true });
  const choice = panel.getByLabel("읽을 저장 원고", { exact: true });
  assert.equal(await panel.getByRole("navigation").count(), 0);
  await choice.selectOption(company.plans[0].id);
  await page.setViewportSize({ width: 390, height: 844 });
  function article(version) {
    return panel.getByRole("article", { name: "저장 원고 v" + version + " 원문", exact: true });
  }
  function navigation(version) {
    return article(version).getByRole("navigation", {
      name: "저장 원고 항목 바로가기",
      exact: true,
    });
  }
  async function jump(version, index, keyboard, screenshot) {
    const plan = company.plans[version - 1],
      section = plan.content.sections[index];
    const nav = navigation(version);
    assert.equal(await nav.count(), 1);
    const button = nav.getByRole("button", { name: index + 1 + ". " + section.title, exact: true });
    if (keyboard) {
      await button.focus();
      await button.press("Enter");
    } else await button.click();
    const target = article(version).getByRole("region", {
      name: "저장 항목 " + (index + 1) + ": " + section.title,
      exact: true,
    });
    const heading = target.locator("h4");
    await heading.evaluate((el) => {
      if (document.activeElement !== el) throw Error("Heading not focused");
    });
    const observation = await heading.evaluate((el) => ({
      focused: document.activeElement === el,
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      viewport: innerHeight,
    }));
    assert.equal(observation.focused, true);
    assert.ok(
      observation.top >= 0 && observation.bottom <= observation.viewport,
      JSON.stringify(observation),
    );
    assert.equal(await target.locator("p").last().textContent(), section.content);
    assert.equal(
      await target.locator("p").first().textContent(),
      section.needsConfirmation ? "항목 확인 필요" : "저장된 항목 확인 표시 있음",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    focusChecks.push({ version, index, ...observation });
    if (screenshot) await page.screenshot({ path: path.join(output, screenshot) });
  }
  assert.equal(await navigation(1).count(), 1);
  assert.deepEqual(
    await navigation(1).getByRole("button").allTextContents(),
    company.plans[0].content.sections.map((s, i) => i + 1 + ". " + s.title),
  );
  await navigation(1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, "plan-section-nav-menu-mobile.png") });
  await jump(1, 0, true, "plan-section-nav-first-mobile.png");
  await jump(1, 3, false, "plan-section-nav-middle-mobile.png");
  await jump(1, 5, true, "plan-section-nav-last-mobile.png");
  assert.equal(await choice.inputValue(), company.plans[0].id);
  record(
    "explicit keyboard/click shortcuts focus the first, middle and last stored v1 sections, including repeated titles; full raw body and confirmation flags preserved",
  );

  await choice.selectOption(company.plans[1].id);
  await jump(2, 5, false, "plan-section-nav-latest-mobile.png");
  await jump(2, 0, true);
  assert.equal(await article(1).count(), 0);
  assert.equal(
    await page
      .getByRole("link", { name: "원고 v2 Word 내려받기", exact: true })
      .getAttribute("href"),
    "/api/studio/cases/" + company.id + "/export?planId=" + company.plans[1].id + "&format=docx",
  );
  assert.deepEqual(companies, original);
  assert.equal(caseReads, 1);
  assert.equal(dialogs.length, 0);
  record(
    "after explicit version change, shortcuts target only v2 and leave the active manuscript, Word link, confirmation flags and memory state unchanged",
  );

  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).click();
  const title = page.getByLabel("사업계획서 제목", { exact: true }),
    summary = page.getByLabel("핵심 요약", { exact: true });
  assert.equal(await title.inputValue(), company.plans[1].content.title);
  assert.equal(await summary.inputValue(), company.plans[1].content.summary);
  const draft = "  원고 이동 뒤 남긴 합성 제목  ";
  await title.fill(draft);
  assert.equal(await toggle.count(), 0);
  assert.equal(await panel.count(), 0);
  assert.equal(
    await page.getByRole("navigation", { name: "저장 원고 항목 바로가기", exact: true }).count(),
    0,
  );
  assert.equal(await title.inputValue(), draft);
  nextDialog = "accept";
  await page.getByRole("button", { name: "수정 취소", exact: true }).click();
  assert.equal(dialogs.length, 1);
  await toggle.click();
  assert.equal(await choice.inputValue(), "");
  assert.equal(await panel.getByRole("navigation").count(), 0);
  await choice.selectOption(company.plans[0].id);
  await jump(1, 3, true);
  assert.equal(commands.length, 0);
  assert.equal(caseReads, 1);
  assert.deepEqual(companies, original);
  record(
    "existing edit screen replaces reading controls while preserving the draft; explicit discard and stored-version selection restore navigation without saving",
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
        focusChecks,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "explicit saved-section navigation in simple screen; synthetic memory only, no mutation, export or AI",
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
