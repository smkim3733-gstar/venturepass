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
const scenario = "numeric-source-binding";

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
  "scripts/numeric-source-binding-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-source-binding-ui-"));
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
const company = fixture.numericReceiptFixture().company;
company.profile.companyName = "합성 수치 자료 연결 기업";
const sourceOne = {
  id: fixture.agencyId(231),
  kind: "technology",
  name: "중복 식별자 자료 하나",
  text: "첫 임의 본문의 수량 10개.",
  extraction: "manual",
  originalName: "",
  mimeType: "text/plain",
  warnings: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
};
const duplicate = {
  ...structuredClone(sourceOne),
  name: "중복 식별자 자료 둘",
  text: "다른 임의 본문의 수량 99개.",
};
const unique = {
  ...structuredClone(sourceOne),
  id: fixture.agencyId(232),
  name: "고유 합성 자료",
  text: "  고유 자료의 수량 30개.\n<b>합성 문자열</b>\n마지막 문장  ",
};
const pending = {
  ...structuredClone(sourceOne),
  id: fixture.agencyId(233),
  name: "판독 대기 합성 자료",
  extraction: "pending",
  text: "",
};
company.sources.push(sourceOne, duplicate, unique, pending);
company.numericChecks[0].observations.forEach((o, i) => {
  o.reference = {
    kind: "source",
    sourceId: [sourceOne.id, fixture.agencyId(239), unique.id][i],
    sourceUpdatedAt: sourceOne.updatedAt,
    quote: ["기존 중복 연결 인용", "기존 없는 연결 인용", "30개"][i],
    locator: "기존 위치 " + (i + 1),
  };
});

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
  await page.getByRole("tab", { name: /사업계획서/ }).click();

  const panel = page.getByRole("region", { name: "기간·단위·산식 수치 대조", exact: true });
  const editor = panel
    .locator("fieldset")
    .filter({ has: page.locator("#numeric-check-title") })
    .first();
  const obs = (n) => editor.getByRole("group", { name: "관측 수치 " + n, exact: true });
  const field = (n, label) => obs(n).getByLabel(label, { exact: true });
  const snapshot = () =>
    editor
      .locator("input,textarea,select")
      .evaluateAll((els) => els.map((e) => ({ id: e.id, value: e.value })));
  const alertText =
    "연결한 자료를 하나로 확인할 수 없어 본문을 표시하지 않습니다. 자료 연결을 다시 확인해 주세요.";
  const reader = (n) =>
    obs(n).getByRole("region", { name: "관측 수치 " + n + " 선택한 등록 본문", exact: true });
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(commands.length, 0);
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
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, "numeric-source-binding-" + name + "-mobile.png"),
    });
  }
  await panel.getByRole("button", { name: "이 대조안의 새 버전 작성", exact: true }).click();
  await editor.getByLabel("대조안 제목 *", { exact: true }).waitFor({ state: "visible" });
  const initial = await snapshot();
  for (const n of [1, 2]) {
    await obs(n)
      .getByRole("alert")
      .filter({ hasText: alertText })
      .waitFor({ state: "visible", timeout: 10000 });
    await obs(n).getByText("선택한 등록 원문 보기", { exact: true }).click();
    assert.equal(await reader(n).count(), 0);
    assert.equal(await obs(n).getByText(sourceOne.text, { exact: true }).count(), 0);
  }
  const options = await field(1, "같은 회사 자료 *")
    .locator("option")
    .evaluateAll((els) =>
      els.map((e) => ({ value: e.value, disabled: e.disabled, text: e.textContent })),
    );
  const duplicatedOptions = options.filter((e) => e.value === sourceOne.id);
  assert.equal(duplicatedOptions.length, 2);
  assert.ok(
    duplicatedOptions.every((e) => e.disabled && e.text.includes("자료 ID 중복 (수치 연결 불가)")),
  );
  assert.ok(options.find((e) => e.value === pending.id).disabled);
  assert.equal(options.find((e) => e.value === unique.id).disabled, false);
  assert.deepEqual(await snapshot(), initial);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("duplicate", obs(1).getByRole("alert"));
  await shot("missing", obs(2).getByRole("alert"));
  await sound();
  record(
    "Duplicate source IDs and missing source IDs show an explicit binding alert without an arbitrary body; duplicate options and pending source remain disabled, and every original input is unchanged.",
  );

  await field(1, "수치가 포함된 원문 그대로 인용 *").fill("");
  await field(1, "자료 쪽·위치").fill("");
  const beforeSelection = await snapshot();
  await field(1, "같은 회사 자료 *").selectOption(unique.id);
  const prefix = "numeric-observation-" + company.numericChecks[0].observations[0].id;
  assert.deepEqual(
    await snapshot(),
    beforeSelection.map((e) => (e.id === prefix + "-source" ? { ...e, value: unique.id } : e)),
  );
  assert.equal(await obs(1).getByRole("alert").count(), 0);
  await reader(1).waitFor({ state: "visible" });
  assert.equal(await reader(1).textContent(), unique.text);
  assert.equal(await reader(1).locator("b,script").count(), 0);
  await field(1, "수치가 포함된 원문 그대로 인용 *").fill("  인용 초안\n끝  ");
  await field(1, "자료 쪽·위치").fill("  쪽 3  ");
  await editor.getByLabel("판단 담당자", { exact: true }).fill("  합성 담당자  ");
  await editor.getByLabel("판단 메모·미해결 사항", { exact: true }).fill("  판단 메모\n보존  ");
  await editor.getByLabel("이번 버전의 내부 판단", { exact: true }).selectOption("needs-work");
  const draft = await snapshot();
  await reader(1).focus();
  await page.keyboard.press("End");
  assert.equal(await reader(1).evaluate((e) => e === document.activeElement), true);
  await obs(1).getByText("선택한 등록 원문 보기", { exact: true }).click();
  await obs(1).getByText("선택한 등록 원문 보기", { exact: true }).click();
  assert.equal(await reader(1).textContent(), unique.text);
  assert.deepEqual(await snapshot(), draft);
  await shot("resolved", reader(1));
  await sound();
  record(
    "Explicit unique-source selection uses that exact complete string, including whitespace and literal HTML-shaped text; keyboard reading and collapse/reopen preserve all numeric, citation, location and judgement inputs.",
  );

  await obs(3).getByText("선택한 등록 원문 보기", { exact: true }).click();
  assert.equal(await reader(3).textContent(), unique.text);
  assert.equal(await obs(3).getByRole("alert").count(), 0);
  assert.equal(await obs(2).getByRole("alert").textContent(), alertText);
  await editor.getByLabel("대조안 제목 *", { exact: true }).fill("");
  const beforeInvalid = await snapshot();
  await editor.getByRole("button", { name: "수치 대조 버전 저장", exact: true }).click();
  await editor
    .getByRole("alert")
    .filter({ hasText: "대조안 제목을 입력해 주세요." })
    .waitFor({ state: "visible" });
  assert.deepEqual(await snapshot(), beforeInvalid);
  assert.equal(await reader(1).textContent(), unique.text);
  assert.equal(await reader(3).textContent(), unique.text);
  assert.equal(await obs(2).getByRole("alert").textContent(), alertText);
  await shot("error-kept", obs(2).getByRole("alert"));
  await field(1, "수치가 포함된 원문 그대로 인용 *").fill("");
  await field(1, "자료 쪽·위치").fill("");
  await field(1, "같은 회사 자료 *").selectOption("");
  assert.equal(await obs(1).getByRole("alert").count(), 0);
  assert.equal(await reader(1).textContent(), "자료·원고 항목을 선택해 주세요.");
  assert.equal(await obs(2).getByRole("alert").textContent(), alertText);
  assert.equal(dialogs.length, 0);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  await shot("unselected", reader(1));
  await sound();
  record(
    "The other unique stored source still reads correctly; existing title validation leaves all raw inputs and binding alerts intact with no request. Explicitly cleared selection returns to ordinary unselected guidance without a false binding error.",
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
        blockedDevDiagnostics,
        consoleDiagnostics: network.filter((item) => item.console),
        startingState:
          "numeric source binding with duplicate/missing source IDs and a unique source; in-memory fixture only",
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
