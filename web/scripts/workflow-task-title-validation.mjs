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
const scenario = "workflow-task-title";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/manual-source-response.ts",
  "src/components/studio/workflow-panel.tsx",
  "src/lib/studio-schema.ts",
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/workflow-task-title-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-workflow-task-title-ui-"));
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
const fixtureEntry = path.join(output, "fixture-entry.ts");
await writeFile(
  fixtureEntry,
  "export {manualSourceFixture, manualId} from " +
    JSON.stringify(
      path.join(app, "scripts/fixtures/manual-source-receipt.ts").replaceAll("\\", "/"),
    ) +
    ";\n" +
    "export {taskSchema} from " +
    JSON.stringify(path.join(app, "src/lib/studio-schema.ts").replaceAll("\\", "/")) +
    ";\n",
);
const bundle = await rolldown({
  input: fixtureEntry,
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
company.tasks = [
  {
    id: fixture.manualId(8),
    title: "합성 기존 담당 업무",
    category: "supplement",
    dueDate: "2026-11-03",
    notes: "  저장된 업무 메모\n둘째 줄  ",
    status: "pending",
  },
];
const savedTask = structuredClone(company.tasks[0]);
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let previewReads = 0,
  intakeReads = 0,
  caseReads = 0;
let dialogAction = "accept";
const observedErrors = [];
let expectedTask;

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
        if (u.pathname === `/api/studio/cases/${company.id}/source-intakes`) {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
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
        commands.push(command);
        assert.ok(expectedTask);
        assert.deepEqual(command, {
          action: "task",
          revision: company.revision,
          task: expectedTask,
        });
        return reply({ error: "합성 업무 저장 실패" }, 500);
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
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const form = page.getByRole("region", { name: "업무 편집", exact: true });
  const add = () => page.getByRole("button", { name: "업무 추가", exact: true }).click();
  const close = () => form.getByRole("button", { name: "업무 편집 취소", exact: true }).click();
  const category = page.locator("#task-category"),
    title = page.locator("#task-title"),
    notes = page.locator("#task-notes"),
    due = page.locator("#task-due-date");
  const save = () => form.getByRole("button", { name: "업무 저장", exact: true }).click();
  const edit = () =>
    page.getByRole("button", { name: savedTask.title + " 수정", exact: true }).click();
  const guard = (expected) =>
    page.waitForFunction((value) => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented === value;
    }, expected);
  const snapshot = async () => ({
    title: await title.inputValue(),
    category: await category.inputValue(),
    dueDate: await due.inputValue(),
    notes: await notes.inputValue(),
  });
  const rejected = async (expected) => {
    await save();
    const toast = page.locator("[data-sonner-toast]").first();
    await toast.waitFor();
    await page.waitForFunction(
      (message) => document.querySelector("[data-sonner-toast]")?.textContent?.includes(message),
      expected,
      { timeout: 10000 },
    );
    observedErrors.push(await toast.innerText());
    assert.deepEqual(company, original);
    await guard(true);
  };
  const shot = async (name) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await form.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await form.screenshot({ path: path.join(output, name + "-mobile.png") });
    await page
      .locator("[data-sonner-toast]")
      .first()
      .screenshot({ path: path.join(output, name + "-notice-mobile.png") });
  };
  await add();
  await category.selectOption("supplement");
  await due.fill("2026-11-03");
  await notes.fill("  새 업무 요청 메모\n둘째 줄  ");
  const newDraft = await snapshot();
  await rejected("업무 제목을 입력해 주세요.");
  assert.equal(commands.length, 0);
  assert.deepEqual(await snapshot(), newDraft);
  await title.fill("   ");
  await rejected("업무 제목을 입력해 주세요.");
  assert.equal(commands.length, 0);
  assert.deepEqual(await snapshot(), { ...newDraft, title: "   " });
  await shot("task-title-new");
  record(
    "Empty and whitespace-only new titles show the Korean correction message without sending a request or changing other draft fields",
  );

  await close();
  assert.equal(dialogs.length, 1);
  await edit();
  await title.fill("");
  await notes.fill("  기존 업무 수정 메모\n보존할 둘째 줄  ");
  const existingDraft = await snapshot();
  await rejected("업무 제목을 입력해 주세요.");
  assert.equal(commands.length, 0);
  assert.deepEqual(await snapshot(), existingDraft);
  await shot("task-title-existing");
  record(
    "An existing task with its title cleared keeps its ID and saved task untouched while showing the same Korean title instruction",
  );

  const corrected = "  수정한 합성 업무 제목  ";
  await title.fill(corrected);
  expectedTask = fixture.taskSchema.parse({ ...savedTask, ...existingDraft, title: corrected });
  await rejected("합성 업무 저장 실패");
  assert.equal(commands.length, 1);
  assert.deepEqual(await snapshot(), { ...existingDraft, title: corrected });
  assert.deepEqual(company, original);
  assert.equal(dialogs.length, 1);
  assert.equal(caseReads, 1);
  assert.equal(previewReads, 0);
  // Pure schema boundaries are not additional browser journeys or server executions.
  const titleBoundaries = [];
  for (const [value, message] of [
    ["", "업무 제목을 입력해 주세요."],
    [" \n\t ", "업무 제목을 입력해 주세요."],
    ["가".repeat(301), "업무 제목은 300자 이하로 입력해 주세요."],
  ]) {
    const result = fixture.taskSchema.safeParse({ ...savedTask, title: value });
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].path[0], "title");
    assert.equal(result.error.issues[0].message, message);
    titleBoundaries.push({ length: value.length, accepted: false, message });
  }
  for (const value of ["가", "가".repeat(300), "  가  "]) {
    const parsed = fixture.taskSchema.parse({ ...savedTask, title: value });
    assert.equal(parsed.title, value.trim());
    titleBoundaries.push({
      length: value.length,
      accepted: true,
      parsedLength: parsed.title.length,
    });
  }
  record(
    "Corrected title sends one explicit request with the existing trim rule; HTTP failure preserves raw inputs, and six pure title boundaries retain the original limits",
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
        syntheticUploadPosts: 0,
        syntheticPatches: commands.length,
        observedErrors,
        titleBoundaries,
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
          "Korean task-title validation uses existing min/max/trim; one synthetic HTTP500 task PATCH; no actual server save, SQL, SDK, AI or institution execution.",
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
  console.log(JSON.stringify({ output, checks, unexpected, errors, observedErrors, network }));
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
