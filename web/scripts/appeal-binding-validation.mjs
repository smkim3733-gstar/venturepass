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
const scenario = "appeal-binding";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/appeal-preparation.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/appeal-preparation-receipt.ts",
  "scripts/appeal-binding-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-appeal-binding-ui-"));
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
  input: path.join(app, "scripts/fixtures/appeal-preparation-receipt.ts"),
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
const company = fixture.appealReceiptFixture().company;
company.profile.companyName = "합성 소명 원고 연결 기업";
const plan = company.plans.at(-1);
const originalSection = structuredClone(plan.content.sections[0]);
const uniqueSection = {
  ...originalSection,
  key: "unique-read",
  title: "고유 연결 항목",
  content: "  고유 원고 본문\n<b>문자열 표시</b>\n마지막 문장  ",
};
plan.content.sections = [
  { ...originalSection, content: "중복 첫 본문을 임의로 보여주면 안 됩니다." },
  { ...originalSection, title: "중복 둘째 항목", content: "중복 둘째 본문도 선택하지 않았습니다." },
  uniqueSection,
];
const nextPlan = { ...structuredClone(plan), id: fixture.agencyId(120), version: plan.version + 1 };
nextPlan.content.sections = [
  { ...originalSection, content: "  다른 버전의 고유 본문\n줄바꿈 유지  " },
];
company.plans.push(nextPlan);
const prior = company.appealPreparations[0];
prior.reasons[0].planClaim = {
  planId: plan.id,
  sectionKey: originalSection.key,
  quote: "  남길 원고 인용\n초안  ",
};
prior.reasons[1].planClaim = {
  planId: plan.id,
  sectionKey: "missing-section",
  quote: "  찾지 못한 항목의 기존 인용  ",
};
prior.reasons.push({
  ...structuredClone(prior.reasons[1]),
  id: fixture.agencyId(121),
  planClaim: {
    planId: fixture.agencyId(122),
    sectionKey: originalSection.key,
    quote: "  찾지 못한 버전의 기존 인용  ",
  },
});
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

  const readiness = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await readiness;
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );

  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "결과 사유별 소명 준비", exact: true });
  await panel.getByRole("button", { name: "이 준비안 새 버전 작성", exact: true }).click();
  const editor = panel.getByRole("group", { name: "소명 준비 새 버전", exact: true });
  const item = (i = 0) => editor.getByRole("group", { name: /^사유 [0-9]+$/ }).nth(i);
  const field = (label, i = 0) => item(i).getByLabel(label, { exact: true });
  const planSelect = () => field("기존 원고 버전 연결 (선택)");
  const sectionSelect = () => field("원고 항목");
  const quote = () => field("선택 원고의 해당 부분 그대로 인용 *");
  const warning = (i) => item(i).getByRole("alert");
  const reader = () =>
    item().getByRole("region", { name: "소명 사유 1의 연결 원고 본문", exact: true });
  const values = (els) =>
    els.map((e) => ({
      id: e.id,
      value: e.value,
      checked: e.type === "checkbox" ? e.checked : null,
    }));
  const inputs = () => editor.locator("input,textarea,select").evaluateAll(values);
  const common = () => editor.locator("input,textarea").evaluateAll(values);
  const others = () =>
    Promise.all([
      item(1).locator("input,textarea,select").evaluateAll(values),
      item(2).locator("input,textarea,select").evaluateAll(values),
    ]);
  const sectionMessage =
    "연결한 원고 항목을 하나로 확인할 수 없어 본문을 표시하지 않습니다. 원고 항목을 다시 확인해 주세요.";
  const planMessage =
    "연결한 원고 버전을 하나로 확인할 수 없어 본문을 표시하지 않습니다. 원고 버전을 다시 확인해 주세요.";
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(commands.length, 0);
    assert.equal(dialogs.length, 0);
  }
  async function dirty(expected) {
    await page.waitForFunction(
      (value) => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented === value;
      },
      expected,
      { timeout: 10000 },
    );
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "appeal-binding-" + name + "-mobile.png") });
  }
  await warning(0).waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await warning(0).textContent(), sectionMessage);
  assert.equal(await warning(1).textContent(), sectionMessage);
  assert.equal(await warning(2).textContent(), planMessage);
  for (let i = 0; i < 3; i++)
    assert.equal(
      await item(i)
        .getByRole("region", { name: new RegExp("연결 원고 본문") })
        .count(),
      0,
    );
  assert.equal(await item().locator("pre").filter({ hasText: "중복 첫 본문" }).count(), 0);
  assert.equal(await quote().inputValue(), prior.reasons[0].planClaim.quote);
  assert.equal(
    await field("선택 원고의 해당 부분 그대로 인용 *", 1).inputValue(),
    prior.reasons[1].planClaim.quote,
  );
  assert.equal(
    await field("선택 원고의 해당 부분 그대로 인용 *", 2).inputValue(),
    prior.reasons[2].planClaim.quote,
  );
  await editor.getByRole("checkbox").check();
  const initial = await inputs();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("ambiguous", warning(0));
  await shot("missing", warning(2));
  assert.deepEqual(await inputs(), initial);
  await sound();
  record(
    "Duplicate section keys, a missing section and a missing plan show explicit unresolved-body notices without choosing fallback text or changing citations, sibling reasons or the explicitly checked internal review",
  );

  await quote().fill("");
  const rest = await others();
  const beforeChoice = await common();
  await sectionSelect().selectOption(uniqueSection.key);
  assert.equal(await warning(0).count(), 0);
  assert.equal(await reader().textContent(), uniqueSection.content);
  assert.equal(await reader().locator("b,script").count(), 0);
  assert.deepEqual(await common(), beforeChoice);
  await field("이 사유에 대한 소명 초안").fill("  유지할 소명 초안\n둘째 줄  ");
  await field("선택 원고의 해당 부분 그대로 인용 *").fill("  고유 항목의 인용 초안\n다음 줄  ");
  await editor.getByRole("checkbox").check();
  const draft = await inputs();
  await reader().focus();
  await page.keyboard.press("End");
  assert.equal(await reader().evaluate((e) => e === document.activeElement), true);
  assert.deepEqual(await inputs(), draft);
  assert.deepEqual(await others(), rest);
  await shot("resolved", reader());
  await dirty(true);
  await sound();
  record(
    "Explicitly choosing a unique section restores its exact stored body, escapes HTML-like text and supports keyboard reading while preserving the appeal draft, explicitly checked internal review and other unresolved references",
  );

  await quote().fill("");
  await editor.getByRole("checkbox").uncheck();
  const commonBeforeVersion = await common();
  await sectionSelect().selectOption("");
  assert.equal(await reader().count(), 0);
  assert.equal(await warning(0).count(), 0);
  await planSelect().selectOption(nextPlan.id);
  await sectionSelect().selectOption(originalSection.key);
  assert.equal(await reader().textContent(), nextPlan.content.sections[0].content);
  assert.deepEqual(await common(), commonBeforeVersion);
  assert.deepEqual(await others(), rest);
  await shot("version", reader());
  await sectionSelect().selectOption("");
  await planSelect().selectOption(plan.id);
  await sectionSelect().selectOption({ index: 1 });
  assert.equal(await warning(0).textContent(), sectionMessage);
  assert.equal(await reader().count(), 0);
  assert.deepEqual(await common(), commonBeforeVersion);
  assert.deepEqual(await others(), rest);
  await editor.getByLabel("준비안 제목 *", { exact: true }).fill("");
  await editor.getByRole("checkbox").check();
  await editor.getByRole("button", { name: "새 버전으로 저장", exact: true }).click();
  assert.equal(await panel.getByRole("alert").filter({ hasText: "Too small" }).count(), 1);
  assert.equal(await warning(0).textContent(), sectionMessage);
  assert.equal(await editor.getByRole("checkbox").isChecked(), true);
  await shot("returned", warning(0));
  await dirty(true);
  await sound();
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  record(
    "Version and empty selection transitions use only the explicitly selected unique body; returning to the ambiguous key restores the notice, and existing required-title validation leaves all appeal drafts, checked review and unresolved notices intact without requests",
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
          "ambiguous and missing appeal plan references with one uniquely linked body; in-memory state only",
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
