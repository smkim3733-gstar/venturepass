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
const scenario = "procedure-cycle";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/application-procedures.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/application-procedure-receipt.ts",
  "scripts/procedure-cycle-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-procedure-cycle-ui-"));
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
async function listenSafe(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(20000 + Math.floor(Math.random() * 30000), "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw Error("No safe local port available");
}
await listenSafe(listener);
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
let origin;
const requireVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "scripts/fixtures/application-procedure-receipt.ts"),
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
const prepared = await fixture.procedureReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 절차 회차 전환 기업";
const firstCycle = company.applications[0].id,
  secondCycle = company.applications[1].id;
const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0,
  nextDialog = "dismiss";
const blockedDevDiagnostics = [];
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
  await listenSafe(proxy);
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
      if (serverMode === "dev" && u.pathname === "/__nextjs_original-stack-frames") {
        blockedDevDiagnostics.push({ method: req.method(), path: u.pathname });
        return route.fulfill({ status: 503, body: "Synthetic offline diagnostics" });
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
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/preparation-automation")),
    page.getByRole("button", { name: "상세 도구", exact: true }).click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "회차별 절차·안내기한", exact: true });
  await panel.getByRole("button", { name: "절차 기록 추가", exact: true }).click();
  const editor = panel.getByRole("region", { name: "새 절차 기록", exact: true });
  const cycle = editor.getByLabel("신청 회차의 현재 정보 *", { exact: true });
  const agency = editor.getByLabel("이 회차에 귀속된 기관 요청·통보의 최신 버전 *", {
    exact: true,
  });
  const confirmed = editor.getByRole("checkbox");
  const title = editor.getByLabel("절차 기록 제목 *", { exact: true });
  const snapshot = () =>
    editor
      .locator("input,textarea,select")
      .evaluateAll((es) =>
        es.map((e) => ({
          id: e.id,
          value: e.value,
          checked: e.type === "checkbox" ? e.checked : null,
        })),
      );
  async function dirty(value) {
    await page.waitForFunction(
      (expected) => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented === expected;
      },
      value,
      { timeout: 10000 },
    );
  }
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(commands, []);
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "procedure-cycle-" + n + "-mobile.png") });
  }
  const message =
    "선택한 기관 원문 연결을 해제하고 신청 회차를 변경할까요? 기입한 날짜·근거와 추가 증빙은 유지됩니다.";
  async function changeCycle(value, action) {
    const n = dialogs.length;
    nextDialog = action;
    await cycle.selectOption(value);
    assert.equal(dialogs.length, n + 1);
    assert.deepEqual(dialogs.at(-1), { message, action });
  }
  async function expectTransition(before, value) {
    const cid = await cycle.getAttribute("id"),
      aid = await agency.getAttribute("id");
    const expected = before.map((e) =>
      e.id === cid
        ? { ...e, value }
        : e.id === aid
          ? { ...e, value: "" }
          : e.checked !== null
            ? { ...e, checked: false }
            : e,
    );
    assert.deepEqual(await snapshot(), expected);
    assert.equal(await agency.inputValue(), "");
    assert.equal(await confirmed.isChecked(), false);
  }
  await dirty(false);
  await cycle.selectOption(secondCycle);
  await agency.selectOption(prepared.input.agencyVersionId);
  const textFields = [
    ["title", "절차 기록 제목 *"],
    ["requester", "요청 주체·담당자 (미확인 시 공란)"],
    ["dueBasis", "안내기한 근거"],
    ["extensionBasis", "연장 상태·일자·기한을 기록한 근거"],
    ["statusBasis", "진행 상태 근거"],
    ["completionBasis", "완료됐다고 기록할 근거"],
    ["recordedBy", "기록 담당자 *"],
    ["note", "추가 메모"],
  ];
  for (const [key, label] of textFields)
    await editor.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  for (const [key, label] of [
    ["requestedOn", "요청일 (선택)"],
    ["dueOn", "안내기한 (선택)"],
    ["extensionRequestedOn", "연장 요청일 (선택)"],
    ["extensionDecidedOn", "연장 결과 기록일 (선택)"],
    ["extendedDueOn", "연장됐다고 기록한 기한 (선택)"],
  ])
    await editor.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  await editor.getByLabel("절차 분류", { exact: true }).selectOption("evaluation");
  await editor
    .getByLabel("연장 상태 (담당자 기록)", { exact: true })
    .selectOption("reported_allowed");
  await editor.getByLabel("진행 상태 (담당자 기록)", { exact: true }).selectOption("preparing");
  await confirmed.check();
  const draft = await snapshot();
  assert.equal(dialogs.length, 0);
  await dirty(true);
  await changeCycle(firstCycle, "dismiss");
  assert.deepEqual(await snapshot(), draft);
  assert.ok((await editor.textContent()).includes("정정된 기관 요청 원문"));
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("kept", cycle);
  await shot("dates-kept", editor.getByLabel("안내기한 (선택)", { exact: true }));
  assert.deepEqual(await snapshot(), draft);
  await sound();
  await changeCycle(firstCycle, "accept");
  await expectTransition(draft, firstCycle);
  assert.ok(!(await editor.textContent()).includes("정정된 기관 요청 원문"));
  await dirty(true);
  record(
    "Changing the cycle with a selected exact agency request asks before clearing it; dismiss preserves every field, date, evidence selection and confirmation, while accept clears only cycle-dependent selection and the existing confirmation.",
  );

  const n = dialogs.length;
  await cycle.selectOption("");
  await cycle.selectOption(secondCycle);
  assert.equal(dialogs.length, n);
  await agency.selectOption(prepared.input.agencyVersionId);
  await confirmed.check();
  const beforeEmpty = await snapshot();
  await changeCycle("", "dismiss");
  assert.deepEqual(await snapshot(), beforeEmpty);
  await shot("unselect-kept", agency);
  await changeCycle("", "accept");
  await expectTransition(beforeEmpty, "");
  assert.equal(await agency.isDisabled(), true);
  await shot("unselected", cycle);
  await sound();
  await dirty(true);
  record(
    "Clearing the cycle also protects the selected agency link; acceptance keeps typed dates and reasons while disabling the empty agency picker. Cycle changes without an agency selection add no confirmation.",
  );

  const n2 = dialogs.length;
  await cycle.selectOption(secondCycle);
  assert.equal(dialogs.length, n2);
  await agency.selectOption(prepared.input.agencyVersionId);
  await title.fill("");
  await confirmed.check();
  const invalid = await snapshot();
  const save = editor.getByRole("button", { name: "담당자 절차 기록 저장", exact: true });
  await save.focus();
  await page.keyboard.press("Enter");
  const error = panel.getByRole("alert");
  await error.waitFor({ state: "visible" });
  const errorText = await error.textContent();
  assert.ok(errorText);
  assert.deepEqual(await snapshot(), invalid);
  await sound();
  await changeCycle(firstCycle, "dismiss");
  assert.deepEqual(await snapshot(), invalid);
  assert.equal(await error.textContent(), errorText);
  await shot("error-kept", error);
  await changeCycle(firstCycle, "accept");
  await expectTransition(invalid, firstCycle);
  assert.equal(await panel.getByRole("alert").count(), 0);
  await dirty(true);
  await sound();
  assert.equal(caseReads, 1);
  assert.equal(dialogs.length, 6);
  assert.deepEqual(
    dialogs.map((d) => d.action),
    ["dismiss", "accept", "dismiss", "accept", "dismiss", "accept"],
  );
  record(
    "After an explicit invalid save, rejecting a cycle change keeps the exact local error and complete draft/confirmation. Accepting follows the existing error/confirmation reset while retaining typed content; business writes and retries remain zero.",
  );
  assert.deepEqual(
    network.filter((item) => item.console),
    [],
  );
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
        blockedDevDiagnostics,
        consoleDiagnostics: network.filter((item) => item.console),
        startingState:
          "procedure cycle changes ask before clearing agency selection, preserving typed dates/reasons and cancellation state",
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
