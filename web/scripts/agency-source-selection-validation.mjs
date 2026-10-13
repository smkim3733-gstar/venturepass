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
const scenario = "agency-source-selection";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/agency-records.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/agency-record-receipt.ts",
  "scripts/agency-source-selection-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-agency-source-selection-ui-"));
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
  input: path.join(app, "scripts/fixtures/agency-record-receipt.ts"),
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
const company = fixture.agencyReceiptCompany();
company.profile.companyName = "합성 기관 원본 선택 기업";
const sid = (n) => "c1000000-0000-4000-8000-" + String(n).padStart(12, "0");
const source = (id, name, originalName, extraction = "local") => ({
  id,
  name,
  originalName,
  kind: "other",
  text: extraction === "pending" ? "" : "합성 저장 본문",
  mimeType: originalName ? "application/pdf" : null,
  extraction,
  warnings: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});
const unique = Array.from({ length: 11 }, (_, i) =>
  source(
    sid(10 + i),
    "고유 원본 " + (i + 1),
    "unique-" + (i + 1) + ".pdf",
    i === 0 ? "pending" : "local",
  ),
);
company.sources = [
  source(sid(1), "중복 원본 첫째", "duplicate-first.pdf"),
  source(sid(1), "중복 원본 둘째", "duplicate-second.pdf"),
  source(sid(2), "원본 있는 중복 항목", "ambiguous-original.pdf"),
  source(sid(2), "원본 없는 중복 항목", null, "manual"),
  ...unique,
  source(sid(30), "고유 수동 메모", null, "manual"),
];

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
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "기관 요청·답변·통보와 원본 증빙", exact: true });
  await panel.getByRole("button", { name: "기관 요청 기록 추가", exact: true }).click();
  const editor = panel
    .locator("fieldset")
    .filter({ has: page.getByRole("heading", { name: "새 기관 요청 기록", exact: true }) })
    .first();
  const picker = editor.getByRole("group", { name: "연결할 원본 증빙 · 최대 10개", exact: true });
  const row = (n) =>
    picker
      .locator("label")
      .filter({ hasText: n })
      .filter({ hasText: company.sources.find((source) => source.name === n).originalName })
      .first();
  const box = (n) => row(n).getByRole("checkbox");
  const duplicated = ["중복 원본 첫째", "중복 원본 둘째", "원본 있는 중복 항목"];
  const names = unique.map((s) => s.name);
  const selected = () =>
    picker
      .locator("label")
      .evaluateAll((els) =>
        els
          .filter((e) => e.querySelector("input")?.checked)
          .map((e) => e.querySelector("span")?.firstChild?.textContent),
      );
  const snapshot = () =>
    editor.locator("input,textarea,select").evaluateAll((els) =>
      els.map((e) => ({
        id: e.id,
        value: e.value,
        checked: e instanceof HTMLInputElement ? e.checked : undefined,
      })),
    );
  async function intact() {
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  }
  async function dirty(value) {
    assert.equal(
      await page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
      value,
    );
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, "agency-source-selection-" + n + "-mobile.png"),
    });
  }
  assert.equal(await picker.getByRole("checkbox").count(), 14);
  for (const n of duplicated) {
    assert.equal(await box(n).isDisabled(), true);
    assert.ok(
      (await row(n).textContent()).includes(
        "자료를 하나로 확인할 수 없어 새로 선택할 수 없습니다.",
      ),
    );
    assert.equal(await box(n).isChecked(), false);
  }
  assert.equal(await picker.getByText("원본 없는 중복 항목", { exact: false }).count(), 0);
  assert.equal(await picker.getByText("고유 수동 메모", { exact: false }).count(), 0);
  for (const n of names) assert.equal(await box(n).isDisabled(), false);
  assert.ok((await row(names[0]).textContent()).includes("본문 미추출 · 분석 완료 아님"));
  await dirty(false);
  await intact();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("ambiguous", row(duplicated[0]));
  await shot("hidden-duplicate", row(duplicated[2]));
  record(
    "Three ambiguous original rows cannot be newly selected, including an ID shared with a hidden no-original record; unique originals remain selectable and pending extraction remains accurately labelled.",
  );

  await editor.getByLabel("기록 제목 *", { exact: true }).fill("  기관 원본 선택 초안  ");
  await editor.getByLabel("기관명 *", { exact: true }).fill("  합성 기관  ");
  await editor
    .getByLabel("요청 원문·정정 내용 *", { exact: true })
    .fill("  확인할 요청\n합성 본문  ");
  await editor.getByLabel("기록·정정 근거 메모", { exact: true }).fill("  메모\n  보존  ");
  const nonSelection = () =>
    editor
      .locator("input:not([type=checkbox]),textarea,select")
      .evaluateAll((els) => els.map((e) => ({ id: e.id, value: e.value })));
  const draft = await nonSelection();
  await box(names[0]).focus();
  await page.keyboard.press("Space");
  assert.deepEqual(await selected(), [names[0]]);
  for (let i = 1; i < 10; i++) await box(names[i]).check();
  assert.deepEqual(await selected(), names.slice(0, 10));
  assert.equal(await box(names[10]).isDisabled(), true);
  for (let i = 0; i < 10; i++) assert.equal(await box(names[i]).isDisabled(), false);
  for (const n of duplicated) assert.equal(await box(n).isDisabled(), true);
  await shot("limit", row(names[10]));
  await box(names[0]).uncheck();
  assert.equal(await box(names[10]).isDisabled(), false);
  await box(names[10]).check();
  assert.deepEqual(await selected(), names.slice(1));
  assert.deepEqual(await nonSelection(), draft);
  await dirty(true);
  await intact();
  record(
    "A unique pending original can be selected by keyboard; ten unique selections enforce the existing limit, unchecking releases a slot, and a different unique original can fill it without selecting any ambiguous row or altering the text draft.",
  );

  await editor.getByLabel("기록 제목 *", { exact: true }).fill("");
  const invalid = await snapshot();
  await editor.getByRole("button", { name: "로컬 기록 저장", exact: true }).click();
  const error = panel.getByRole("alert");
  await error.waitFor({ state: "visible" });
  const message = await error.textContent();
  assert.ok(message.length > 0);
  assert.deepEqual(await snapshot(), invalid);
  assert.deepEqual(await selected(), names.slice(1));
  await box(names[1]).uncheck();
  await box(names[0]).check();
  assert.deepEqual(await selected(), [names[0], ...names.slice(2)]);
  assert.equal(await error.textContent(), message);
  for (const n of duplicated) {
    assert.equal(await box(n).isDisabled(), true);
    assert.equal(await box(n).isChecked(), false);
  }
  assert.equal(await editor.getByLabel("기록 제목 *", { exact: true }).inputValue(), "");
  assert.deepEqual(
    (await nonSelection()).filter((e) => e.id !== "agency-title"),
    draft.filter((e) => e.id !== "agency-title"),
  );
  await shot("pending-kept", row(names[0]));
  await dirty(true);
  await intact();
  assert.equal(dialogs.length, 0);
  assert.equal(caseReads, 1);
  record(
    "An existing required-title validation error sends no command and preserves all ten selections and draft inputs; explicitly replacing one selection with the pending original retains that error and keeps every ambiguous row disabled.",
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
          "ambiguous original source IDs blocked while unique original selection and draft inputs remain intact",
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
