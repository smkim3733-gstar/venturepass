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
const scenario = "appeal-reason";

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
  "scripts/appeal-reason-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-appeal-reason-ui-"));
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
company.profile.companyName = "합성 소명 사유 보호 기업";
const plan = company.plans.at(-1);
plan.content.sections.push({
  ...structuredClone(plan.content.sections[0]),
  key: "synthetic-second-appeal",
  title: "둘째 합성 원고 항목",
  content: "둘째 합성 본문",
});
company.plans.push({
  ...structuredClone(plan),
  id: fixture.agencyId(195),
  version: plan.version + 1,
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
  const reasons = () => editor.getByRole("group", { name: /^사유 [0-9]+$/ });
  const reason = (i = 0) => reasons().nth(i);
  const title = () => editor.getByLabel("준비안 제목 *", { exact: true });
  const review = () => editor.getByRole("checkbox");
  const field = (label, i = 0) => reason(i).getByLabel(label, { exact: true });
  const noticeField = () => field("사유를 가져올 통보 항목");
  const noticeQuote = () => field("대응할 사유를 위 원문 그대로 인용 *");
  const planSelect = () => field("기존 원고 버전 연결 (선택)");
  const sectionSelect = () => field("원고 항목");
  const planQuote = () => field("선택 원고의 해당 부분 그대로 인용 *");
  const remove = (i = 0) => reason(i).getByRole("button", { name: "이 사유 제거", exact: true });
  const values = (items) =>
    items.map((i) => ({
      id: i.id,
      value: i.value,
      checked: i.type === "checkbox" ? i.checked : null,
    }));
  const snapshot = () => editor.locator("input,textarea,select").evaluateAll(values);
  const reasonSnapshot = (i) => reason(i).locator("input,textarea,select").evaluateAll(values);
  async function sound() {
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await page.waitForFunction(
      () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      },
      null,
      { timeout: 10000 },
    );
  }
  async function ask(action, message, accept = false) {
    const count = dialogs.length;
    nextDialog = accept ? "accept" : "dismiss";
    await action();
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), { message, action: accept ? "accept" : "dismiss" });
  }
  async function reject(action, message) {
    await review().check();
    const before = await snapshot(),
      alerts = await panel.getByRole("alert").allTextContents();
    await ask(action, message);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await panel.getByRole("alert").allTextContents(), alerts);
    await sound();
    return before;
  }
  async function accepted(action, message, prior, removed = [], changed = {}) {
    await ask(action, message, true);
    const expected = prior
      .filter((i) => !removed.includes(i.id))
      .map((i) => ({
        ...i,
        value: Object.hasOwn(changed, i.id) ? changed[i.id] : i.value,
        checked: i.checked === null ? null : false,
      }));
    assert.deepEqual(await snapshot(), expected);
    await sound();
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "appeal-reason-" + name + "-mobile.png") });
  }
  const noticeMessage = "작성한 통보 사유 인용을 비우고 통보 항목을 변경할까요?";
  const sectionMessage = "작성한 원고 인용을 비우고 원고 항목을 변경할까요?";
  const planMessage = "선택한 원고 항목·인용을 비우고 원고 버전을 변경할까요?";
  const removeMessage = "작성한 인용·근거 연결과 소명 초안을 포함한 이 사유를 제거할까요?";
  await title().waitFor({ state: "visible" });
  await page.setViewportSize({ width: 390, height: 844 });
  await title().fill("  소명 사유 보호  ");
  await editor.getByLabel("진행 판단 메모", { exact: true }).fill("  판단\n유지  ");
  await editor
    .getByLabel("내부 검토자 (검토 기록 시 필수)", { exact: true })
    .fill("  합성 검토자  ");
  await editor.getByLabel("내부 검토 메모", { exact: true }).fill("  내부 메모\n둘째 줄  ");
  await field("기존 주장·설명").fill("  첫 주장\n유지  ");
  await field("이 사유에 대한 소명 초안").fill("  첫 소명\n초안  ");
  await noticeQuote().fill("  통보 인용\n확인 중  ");
  const noticeFieldId = await noticeField().getAttribute("id"),
    noticeQuoteId = await noticeQuote().getAttribute("id");
  const beforeNotice = await reject(() => noticeField().selectOption("body"), noticeMessage);
  await shot("notice-kept", noticeQuote());
  await accepted(() => noticeField().selectOption("body"), noticeMessage, beforeNotice, [], {
    [noticeFieldId]: "body",
    [noticeQuoteId]: "",
  });
  let count = dialogs.length;
  await noticeField().selectOption("reasons");
  assert.equal(dialogs.length, count);
  await noticeQuote().fill(" \n ");
  const spaceNotice = await reject(() => noticeField().selectOption("body"), noticeMessage);
  await accepted(() => noticeField().selectOption("body"), noticeMessage, spaceNotice, [], {
    [noticeFieldId]: "body",
    [noticeQuoteId]: "",
  });
  await noticeField().selectOption("reasons");
  record(
    "Notice-field changes protect both text and whitespace-only quotations; rejection preserves every reason, review check and raw input, while acceptance clears only that quotation and follows the existing review reset; empty quotation changes are prompt-free",
  );

  const firstPlan = company.plans.at(-2),
    nextPlan = company.plans.at(-1);
  const firstKey = firstPlan.content.sections[0].key,
    secondKey = firstPlan.content.sections.at(-1).key;
  await planQuote().fill("  원고 인용\n수정 중  ");
  const sectionId = await sectionSelect().getAttribute("id"),
    quoteId = await planQuote().getAttribute("id"),
    planId = await planSelect().getAttribute("id");
  const beforeSection = await reject(() => sectionSelect().selectOption(secondKey), sectionMessage);
  await shot("plan-kept", planQuote());
  await accepted(() => sectionSelect().selectOption(secondKey), sectionMessage, beforeSection, [], {
    [sectionId]: secondKey,
    [quoteId]: "",
  });
  count = dialogs.length;
  await sectionSelect().selectOption(firstKey);
  assert.equal(dialogs.length, count);
  await planQuote().fill(" \n ");
  const emptySection = await reject(() => sectionSelect().selectOption(""), sectionMessage);
  await accepted(() => sectionSelect().selectOption(""), sectionMessage, emptySection, [], {
    [sectionId]: "",
    [quoteId]: "",
  });
  await sectionSelect().selectOption(firstKey);
  const linkedOnly = await reject(() => planSelect().selectOption(nextPlan.id), planMessage);
  await accepted(() => planSelect().selectOption(nextPlan.id), planMessage, linkedOnly, [], {
    [planId]: nextPlan.id,
    [sectionId]: "",
    [quoteId]: "",
  });
  count = dialogs.length;
  await planSelect().selectOption(firstPlan.id);
  assert.equal(dialogs.length, count);
  await sectionSelect().selectOption(firstKey);
  await planQuote().fill("  마지막 원고\n인용  ");
  const noPlan = await reject(() => planSelect().selectOption(""), planMessage);
  await accepted(() => planSelect().selectOption(""), planMessage, noPlan, [sectionId, quoteId], {
    [planId]: "",
  });
  assert.equal(await sectionSelect().count(), 0);
  assert.equal(await planQuote().count(), 0);
  record(
    "Plan section changes and version/unlinked changes protect the original quotation or section-only link; rejecting retains review and all other inputs, accepting keeps the original clearing rules, and an empty plan link switches without a prompt",
  );

  await title().fill("");
  await review().check();
  await editor.getByRole("button", { name: "새 버전으로 저장", exact: true }).click();
  await panel.getByRole("alert").waitFor({ state: "visible" });
  const errorText = await panel.getByRole("alert").textContent(),
    secondReason = await reasonSnapshot(1);
  const beforeRemove = await reject(() => remove().click(), removeMessage),
    removeIds = (await reasonSnapshot(0)).map((i) => i.id);
  await shot("remove-kept", remove());
  await accepted(
    async () => {
      await remove().focus();
      await page.keyboard.press("Enter");
    },
    removeMessage,
    beforeRemove,
    removeIds,
  );
  assert.deepEqual(await reasonSnapshot(0), secondReason);
  assert.equal(await panel.getByRole("alert").textContent(), errorText);
  const add = () => editor.getByRole("button", { name: "대응 사유 추가", exact: true }).click();
  count = dialogs.length;
  await add();
  await remove(1).click();
  assert.equal(dialogs.length, count);
  await add();
  await field("기존 원고 버전 연결 (선택)", 1).selectOption(firstPlan.id);
  const planOnly = await reject(() => remove(1).click(), removeMessage),
    planOnlyIds = (await reasonSnapshot(1)).map((i) => i.id);
  await accepted(() => remove(1).click(), removeMessage, planOnly, planOnlyIds);
  await add();
  await field("이 사유에 대한 소명 초안", 1).fill(" \n ");
  const draftOnly = await reject(() => remove(1).click(), removeMessage),
    draftOnlyIds = (await reasonSnapshot(1)).map((i) => i.id);
  await accepted(() => remove(1).click(), removeMessage, draftOnly, draftOnlyIds);
  await add();
  await field("사유를 가져올 통보 항목", 1).selectOption("body");
  const fieldOnly = await reject(() => remove(1).click(), removeMessage),
    fieldOnlyIds = (await reasonSnapshot(1)).map((i) => i.id);
  await shot("field-only", remove(1));
  await accepted(() => remove(1).click(), removeMessage, fieldOnly, fieldOnlyIds);
  assert.equal(await reasons().count(), 1);
  assert.deepEqual(await reasonSnapshot(0), secondReason);
  assert.equal(await panel.getByRole("alert").textContent(), errorText);
  assert.equal(dialogs.length, 20);
  assert.equal(dialogs.filter((i) => i.action === "accept").length, 10);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  await sound();
  record(
    "Removing a populated reason or a plan-only, whitespace-draft-only or nondefault-notice-field-only reason requires confirmation; reject preserves all inputs/review/error, accept removes only that reason and keeps the other reason's IDs/values; a new default empty reason deletes freely, with no business request",
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
          "appeal reason field/plan changes and removal confirmation; memory receipt fixture with a second section/version, no API mutation",
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
