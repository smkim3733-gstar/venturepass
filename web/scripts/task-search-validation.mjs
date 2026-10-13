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
const scenario = "task-search";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/workflow-panel.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/workflow-task-receipt.ts",
  "scripts/task-search-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-task-search-ui-"));
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
  input: path.join(app, "scripts/fixtures/workflow-task-receipt.ts"),
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
const prepared = fixture.workflowTaskFixture();
const company = prepared.company;
company.profile.companyName = "합성 담당 업무 검색 기업";
const doneTask = company.tasks[0],
  pendingTask = company.tasks[1];
doneTask.title = "완료 보고서 Alpha";
doneTask.notes = "이전 완료 메모";
doneTask.status = "done";
pendingTask.title = "시험 자료 Alpha";
pendingTask.notes = "  [검토] <b>추가 확인</b>\n둘째 메모  ";
pendingTask.owners = { materials: "김자료", writing: "LEEwriter", review: "최종확인" };
const extraPending = {
  id: "30000000-0000-4000-8000-000000000003",
  title: "시험 장비 확보",
  category: "evidence",
  status: "pending",
  dueDate: "2026-10-18",
  notes: "지원금 확인",
};
const extraDone = {
  id: "30000000-0000-4000-8000-000000000004",
  title: "종료 기록",
  category: "other",
  status: "done",
  dueDate: "",
  notes: "보관 문장",
  owners: { materials: "", writing: "다른 담당", review: "" },
};
company.tasks.push(extraPending, extraDone);
const expectedAll = [extraPending, pendingTask, doneTask, extraDone];
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
  const search = page.getByLabel("업무 검색", { exact: true });
  const filter = page.getByLabel("업무 상태", { exact: true });
  const cards = page.locator('article[id^="workflow-task-"]');
  const titles = () => cards.locator("h4").allTextContents();
  const clear = page.getByRole("button", { name: "검색 지우기", exact: true });
  const searchBox = search.locator("xpath=..");
  const editor = page.getByRole("region", { name: "업무 편집", exact: true });
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
    assert.deepEqual(dialogs, []);
  }
  async function result(tasks) {
    assert.deepEqual(
      await titles(),
      tasks.map((t) => t.title),
    );
    await page.getByText("표시 " + tasks.length + "개 / 전체 4개", { exact: true }).waitFor();
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "task-search-" + n + "-mobile.png") });
  }
  await search.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await search.inputValue(), "");
  assert.equal(await clear.count(), 0);
  await result(expectedAll);
  assert.equal(await search.getAttribute("maxLength"), "300");
  const helpId = await search.getAttribute("aria-describedby");
  assert.equal(
    await page.locator('[id="' + helpId + '"]').textContent(),
    "저장된 업무 제목·요청 내용·메모·담당자 이름에서 찾습니다. 작성 중인 입력은 검색하지 않습니다.",
  );
  await search.fill("  aLpHa  ");
  await result([pendingTask, doneTask]);
  assert.equal(await search.inputValue(), "  aLpHa  ");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("title", searchBox);
  await filter.selectOption("done");
  await result([doneTask]);
  await filter.selectOption("pending");
  await result([pendingTask]);
  await filter.selectOption("all");
  await search.fill("[검토]");
  await result([pendingTask]);
  await search.fill("<b>");
  await result([pendingTask]);
  assert.equal(await cards.locator("b,script").count(), 0);
  await shot("literal", cards.first());
  await dirty(false);
  await sound();
  record(
    "Literal title and memo search combines with saved task status and preserves existing due-date order. Query edge spaces and letter case affect matching only; literal bracket/HTML-shaped terms are not patterns or markup.",
  );

  for (const word of ["김자료", "leewriter", "최종확인"]) {
    await search.fill(word);
    await result([pendingTask]);
  }
  await shot("owner", searchBox);
  await filter.selectOption("done");
  await result([]);
  await page.getByText("검색 조건에 맞는 업무가 없습니다", { exact: true }).waitFor();
  await shot("empty", searchBox);
  await clear.focus();
  await page.keyboard.press("Enter");
  assert.equal(await search.inputValue(), "");
  assert.equal(await filter.inputValue(), "done");
  assert.equal(await search.evaluate((e) => document.activeElement === e), true);
  await result([doneTask, extraDone]);
  assert.equal(await clear.count(), 0);
  await search.fill("   ");
  await result([doneTask, extraDone]);
  await clear.click();
  await filter.selectOption("all");
  await dirty(false);
  await sound();
  record(
    "All three owner roles are searchable, missing owners remain safe, and zero results differ from empty company state. Keyboard clear keeps the status filter, returns focus to search, and does not mark a draft dirty.",
  );

  await search.fill("시험 자료");
  await result([pendingTask]);
  await page.getByRole("button", { name: pendingTask.title + " 수정", exact: true }).click();
  await editor.locator("#task-title").fill("  검색에 포함하지 않을 초안  ");
  await editor.locator("#task-notes").fill("  새 업무 메모\n  보존  ");
  await editor.locator("#task-owner-writing").fill("  초안 담당자  ");
  const draft = await snapshot();
  await dirty(true);
  await search.fill("검색에 포함하지 않을 초안");
  await result([]);
  assert.deepEqual(await snapshot(), draft);
  await search.fill("시험 자료");
  await result([pendingTask]);
  assert.deepEqual(await snapshot(), draft);
  await filter.selectOption("done");
  await result([]);
  await shot("draft", editor.locator("#task-notes"));
  await filter.selectOption("pending");
  await search.fill("없는 검색어");
  await result([]);
  const linked = page.getByRole("link", { name: doneTask.title + " · 업무로 이동", exact: true });
  await linked.focus();
  await linked.press("Enter");
  await page.waitForFunction((id) => location.hash === "#workflow-task-" + id, doneTask.id);
  assert.equal(await search.inputValue(), "");
  assert.equal(await filter.inputValue(), "all");
  await result(expectedAll);
  assert.deepEqual(await snapshot(), draft);
  await dirty(true);
  const destination = page.locator("#workflow-task-" + doneTask.id);
  const box = await destination.boundingBox();
  assert.ok(box && box.y >= -2 && box.y < 844);
  await shot("linked", destination);
  assert.equal(caseReads, 1);
  await sound();
  record(
    "Search reads saved tasks while an edited task is hidden or shown without changing draft inputs. The existing linked-task anchor clears hiding search/status filters before navigation, reaches the original completed task, and preserves the open dirty draft.",
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
          "saved task title, memo and owner search preserves drafts and reveals linked targets",
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
