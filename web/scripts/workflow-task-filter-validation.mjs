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
const scenario = "workflow-task-filter";

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
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/workflow-task-filter-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-workflow-task-filter-ui-"));
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
company.profile.companyName = "합성 업무 상태 찾기 기업";
company.tasks = [
  {
    id: fixture.manualId(8),
    title: "완료한 첫 합성 업무",
    category: "supplement",
    dueDate: "2026-10-01",
    notes: "완료 메모",
    status: "done",
    agencyOrigin: { requestRecordId: fixture.manualId(40), requestVersionId: fixture.manualId(40) },
  },
  {
    id: fixture.manualId(9),
    title: "기한 없는 미완료 업무",
    category: "evidence",
    dueDate: "",
    notes: "  보존 메모\n둘째 줄  ",
    status: "pending",
  },
  {
    id: fixture.manualId(10),
    title: "기한 있는 미완료 업무",
    category: "visit",
    dueDate: "2026-11-03",
    notes: "합성 기한 메모",
    status: "pending",
  },
  {
    id: fixture.manualId(11),
    title: "완료한 둘째 합성 업무",
    category: "other",
    dueDate: "2026-10-02",
    notes: "둘째 완료 메모",
    status: "done",
  },
];
company.agencyRecords = [
  {
    id: fixture.manualId(40),
    clientRequestId: fixture.manualId(41),
    inputDigest: "a".repeat(64),
    kind: "request",
    requestRecordId: fixture.manualId(40),
    requestVersionId: fixture.manualId(40),
    previousVersionId: null,
    version: 1,
    origin: "manual",
    recordedAt: "2026-10-10T00:00:00.000Z",
    institution: "합성 기관",
    title: "합성 원문 요청",
    body: "실제 기관 요청이 아닌 화면 검증용 본문",
    occurredOn: "",
    dueOn: "",
    dueNote: "",
    note: "",
    responseStatus: null,
    evidence: [],
  },
];
const doneCompany = structuredClone(company);
doneCompany.id = fixture.manualId(50);
doneCompany.profile.companyName = "합성 완료 업무만 있는 기업";
doneCompany.tasks = doneCompany.tasks.filter((t) => t.status === "done");
const emptyCompany = structuredClone(company);
emptyCompany.id = fixture.manualId(51);
emptyCompany.profile.companyName = "합성 업무 없는 기업";
emptyCompany.tasks = [];
emptyCompany.agencyRecords = [];
const companies = [company, doneCompany, emptyCompany],
  original = structuredClone(companies),
  name = company.profile.companyName;
let previewReads = 0,
  intakeReads = 0,
  caseReads = 0,
  dialogAction = "dismiss";
const dialogs = [],
  network = [],
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
  const filter = page.getByLabel("업무 상태", { exact: true });
  const cards = page.locator('article[id^="workflow-task-"]');
  const titles = () => cards.locator("h4").allTextContents();
  const expectedAll = [company.tasks[2], company.tasks[1], company.tasks[0], company.tasks[3]];
  const guard = (expected) =>
    page.waitForFunction((value) => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented === value;
    }, expected);
  const noWrites = () => {
    assert.deepEqual(companies, original);
    assert.deepEqual(commands, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  };
  const shot = async (name, element) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await element.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, name + "-mobile.png") });
  };
  assert.equal(await filter.count(), 1);
  assert.equal(await filter.inputValue(), "all");
  assert.deepEqual(
    await titles(),
    expectedAll.map((t) => t.title),
  );
  assert.deepEqual(await filter.locator("option").allTextContents(), [
    "전체 (4)",
    "미완료 (2)",
    "완료 (2)",
  ]);
  await filter.selectOption("pending");
  assert.deepEqual(
    await titles(),
    expectedAll.slice(0, 2).map((t) => t.title),
  );
  await page.getByText("표시 2개 / 전체 4개", { exact: true }).waitFor();
  await guard(false);
  await shot("task-filter-pending", filter);
  await filter.selectOption("done");
  assert.deepEqual(
    await titles(),
    expectedAll.slice(2).map((t) => t.title),
  );
  await filter.selectOption("all");
  assert.deepEqual(
    await titles(),
    expectedAll.map((t) => t.title),
  );
  assert.equal(dialogs.length, 0);
  noWrites();
  record(
    "All/pending/done filters preserve existing due-date order and show exact counts without dirty state, confirmations or requests",
  );

  await page.getByRole("button", { name: company.tasks[2].title + " 수정", exact: true }).click();
  const title = page.locator("#task-title"),
    notes = page.locator("#task-notes"),
    category = page.locator("#task-category"),
    due = page.locator("#task-due-date");
  const draft = {
    title: "  미저장 합성 업무 제목  ",
    notes: "  미저장 메모\n다음 줄  ",
    category: "payment",
    due: "2026-12-01",
  };
  await title.fill(draft.title);
  await notes.fill(draft.notes);
  await category.selectOption(draft.category);
  await due.fill(draft.due);
  await guard(true);
  await filter.selectOption("done");
  assert.deepEqual(
    await titles(),
    expectedAll.slice(2).map((t) => t.title),
  );
  assert.equal(await title.inputValue(), draft.title);
  assert.equal(await notes.inputValue(), draft.notes);
  assert.equal(await category.inputValue(), draft.category);
  assert.equal(await due.inputValue(), draft.due);
  await guard(true);
  assert.equal(dialogs.length, 0);
  noWrites();
  await shot("task-filter-draft", page.getByRole("region", { name: "업무 편집", exact: true }));
  dialogAction = "accept";
  await page.getByRole("button", { name: "업무 편집 취소", exact: true }).click();
  assert.equal(dialogs.length, 1);
  await guard(false);
  await filter.selectOption("pending");
  const linked = page.getByRole("link", {
    name: company.tasks[0].title + " · 업무로 이동",
    exact: true,
  });
  await linked.focus();
  await linked.press("Enter");
  await page.waitForFunction((id) => location.hash === "#workflow-task-" + id, company.tasks[0].id);
  assert.equal(await filter.inputValue(), "all");
  assert.deepEqual(
    await titles(),
    expectedAll.map((t) => t.title),
  );
  const destination = page.locator("#workflow-task-" + company.tasks[0].id);
  const position = await destination.boundingBox();
  assert.ok(position && position.y >= -2 && position.y < 844);
  await page.screenshot({ path: path.join(output, "task-filter-linked-mobile.png") });
  noWrites();
  record(
    "Filtering out the edited card preserves all draft input and dirty guard; an existing linked task anchor clears the filter and reaches the hidden completed task",
  );

  await filter.selectOption("done");
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  assert.equal(await filter.inputValue(), "all");
  assert.deepEqual(
    await titles(),
    expectedAll.map((t) => t.title),
  );
  await page.getByRole("button", { name: "전체 기업", exact: true }).click();
  await page
    .getByRole("button")
    .filter({ hasText: doneCompany.profile.companyName })
    .first()
    .click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  await filter.selectOption("pending");
  assert.equal(await cards.count(), 0);
  assert.equal(await filter.inputValue(), "pending");
  await page.getByText("선택한 상태의 업무가 없습니다", { exact: true }).waitFor();
  await page.getByText("표시 0개 / 전체 2개", { exact: true }).waitFor();
  await shot("task-filter-empty-result", filter);
  await filter.selectOption("all");
  assert.equal(await cards.count(), 2);
  await page.getByRole("button", { name: "전체 기업", exact: true }).click();
  await page
    .getByRole("button")
    .filter({ hasText: emptyCompany.profile.companyName })
    .first()
    .click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  assert.equal(await filter.count(), 0);
  await page.getByText("다음 할 일을 등록하세요", { exact: true }).waitFor();
  assert.equal(await cards.count(), 0);
  assert.equal(dialogs.length, 1);
  assert.equal(caseReads, 3);
  assert.equal(previewReads, 0);
  noWrites();
  record(
    "Tab return resets the view to all; zero filtered results remain distinct from a company with no tasks, with no stored status change",
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
        syntheticUploadPosts: commands.length,
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
          "Local saved-task status filtering with draft and linked-anchor preservation; no server writes, SQL, SDK or AI.",
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
