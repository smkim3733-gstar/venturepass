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
const scenario = "numeric-remove";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/numeric-checks.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/numeric-check-receipt.ts",
  "scripts/numeric-remove-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-remove-ui-"));
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
  input: path.join(app, "scripts/fixtures/numeric-check-receipt.ts"),
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
const prepared = fixture.numericReceiptFixture();
const first = prepared.company.numericChecks[0];
const obs = structuredClone(first.observations);
for (let i = 0; i < 2; i++)
  obs.push({
    ...structuredClone(obs[i + 1]),
    id: fixture.agencyId(220 + i),
    label: "보존 수치 " + (i + 4),
  });
const initialInput = {
  ...prepared.input,
  checkId: null,
  previousVersionId: null,
  title: "합성 연결 삭제 대조",
  observations: obs,
  comparisons: [
    ...first.comparisons,
    { id: fixture.agencyId(222), leftId: obs[3].id, rightId: obs[4].id },
  ],
  formulas: [
    ...first.formulas,
    {
      id: fixture.agencyId(223),
      operation: "sum",
      operandIds: [obs[2].id, obs[3].id],
      expectedId: obs[0].id,
    },
    {
      id: fixture.agencyId(224),
      operation: "sum",
      operandIds: [obs[1].id, obs[3].id],
      expectedId: obs[4].id,
    },
  ],
  judgement: { state: "unreviewed", reviewer: "", note: "" },
};
const company = fixture.numericReceiptResult(
  { ...prepared.company, numericChecks: [] },
  initialInput,
  fixture.agencyId(225),
  first.id,
);
company.profile.companyName = "합성 수치 연결 삭제 기업";

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
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  const panel = page.getByRole("region", { name: "기간·단위·산식 수치 대조", exact: true });
  await panel.getByRole("button", { name: "이 대조안의 새 버전 작성", exact: true }).click();
  const editor = panel.getByRole("group", { name: "수치 대조의 새 버전", exact: true });
  const title = editor.getByLabel("대조안 제목 *", { exact: true });
  const judgement = editor.getByLabel("이번 버전의 내부 판단", { exact: true });
  const reviewer = editor.getByLabel("판단 담당자", { exact: true });
  const note = editor.getByLabel("판단 메모·미해결 사항", { exact: true });
  const observations = () => editor.getByRole("group", { name: /^관측 수치 [0-9]+$/ });
  const pairs = () => editor.getByRole("group", { name: /^비교쌍 [0-9]+$/ });
  const formulas = () => editor.getByRole("group", { name: /^산식 [0-9]+$/ });
  const remove = (index) =>
    observations()
      .nth(index)
      .getByRole("button", { name: "이 수치와 연결 비교·산식 삭제", exact: true });
  const readInputs = (target) =>
    target
      .locator("input, textarea, select")
      .evaluateAll((items) => items.map((item) => ({ id: item.id, value: item.value })));
  async function readGroups(groups) {
    const result = [];
    for (let i = 0; i < (await groups.count()); i++) result.push(await readInputs(groups.nth(i)));
    return result;
  }
  async function readModel() {
    return {
      observations: await readGroups(observations()),
      comparisons: await readGroups(pairs()),
      formulas: await readGroups(formulas()),
    };
  }
  async function preserved() {
    assert.equal(await title.inputValue(), "  연결 삭제 초안  ");
    assert.equal(await reviewer.inputValue(), "  수치 담당자  ");
    assert.equal(await note.inputValue(), "  검토 메모\n원문 보존  ");
    await page.waitForFunction(
      () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      },
      null,
      { timeout: 10000 },
    );
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
  }
  async function ask(index, action, comparisonCount, formulaCount, keyboard = false) {
    const count = dialogs.length;
    nextDialog = action;
    if (keyboard) {
      await remove(index).focus();
      await page.keyboard.press("Enter");
    } else await remove(index).click();
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), {
      action,
      message:
        "관측 수치 " +
        (index + 1) +
        "과 연결된 비교쌍 " +
        comparisonCount +
        "개·산식 " +
        formulaCount +
        "개를 삭제할까요?",
    });
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const box = await target.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391);
    await page.screenshot({ path: path.join(output, "numeric-remove-" + name + "-mobile.png") });
  }
  await title.fill("  연결 삭제 초안  ");
  await observations()
    .nth(0)
    .getByLabel("출처 해석·범위·가정 메모 (수동)", { exact: true })
    .fill("  수치 초안\n유지  ");
  await reviewer.fill("  수치 담당자  ");
  await note.fill("  검토 메모\n원문 보존  ");
  await judgement.selectOption("needs-work");
  const before = await readModel();
  const allBefore = await readInputs(editor);
  assert.equal(before.observations.length, 5);
  assert.equal(before.comparisons.length, 2);
  assert.equal(before.formulas.length, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  await ask(0, "dismiss", 1, 2);
  assert.deepEqual(await readInputs(editor), allBefore);
  assert.deepEqual(await readModel(), before);
  assert.equal(await judgement.inputValue(), "needs-work");
  await preserved();
  await shot("kept", remove(0));
  record(
    "Rejecting removal preserves all five observations, two comparisons, three formulas, raw notes and reviewer judgement; confirmation counts one linked pair and two formulas including operand and expected-result use",
  );

  await ask(0, "accept", 1, 2, true);
  assert.deepEqual(await readModel(), {
    observations: before.observations.slice(1),
    comparisons: before.comparisons.slice(1),
    formulas: before.formulas.slice(2),
  });
  assert.equal(await judgement.inputValue(), "unreviewed");
  await preserved();
  await shot("remaining", pairs().first());
  record(
    "Accepting through keyboard removes only the selected observation and its one comparison/two formulas; unrelated inputs and the other comparison/formula retain exact IDs and values, with the existing judgement reset",
  );

  await judgement.selectOption("needs-work");
  const second = await readModel();
  await ask(0, "dismiss", 0, 1);
  assert.deepEqual(await readModel(), second);
  assert.equal(await judgement.inputValue(), "needs-work");
  await ask(0, "accept", 0, 1);
  assert.deepEqual(await readModel(), {
    observations: second.observations.slice(1),
    comparisons: second.comparisons,
    formulas: [],
  });
  assert.equal(await judgement.inputValue(), "unreviewed");
  await editor.getByRole("button", { name: "미확인 수치 항목 추가", exact: true }).click();
  const blank = await readModel();
  await judgement.selectOption("needs-work");
  await ask(3, "dismiss", 0, 0);
  assert.deepEqual(await readModel(), blank);
  assert.equal(await judgement.inputValue(), "needs-work");
  await ask(3, "accept", 0, 0);
  assert.deepEqual(await readModel(), { ...blank, observations: blank.observations.slice(0, -1) });
  assert.equal(await judgement.inputValue(), "unreviewed");
  await preserved();
  await shot("final", pairs().first());
  assert.equal(dialogs.length, 6);
  assert.equal(dialogs.filter((d) => d.action === "dismiss").length, 3);
  assert.equal(caseReads, 1);
  record(
    "Later removal reports the remaining zero-pair/one-formula impact; a newly added empty unlinked observation explicitly confirms zero/zero; both rejections preserve input and judgement and acceptances keep unrelated saved-memory state untouched",
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
          "numeric observation cascade removal in detailed screen; five memory observations, two comparisons and three formulas, no API mutation",
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
