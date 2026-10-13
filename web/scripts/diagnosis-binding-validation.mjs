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
const scenario = "diagnosis-binding";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/diagnosis-panel.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/diagnosis-answers-receipt.ts",
  "scripts/diagnosis-binding-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-diagnosis-binding-ui-"));
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
  input: path.join(app, "scripts/fixtures/diagnosis-answers-receipt.ts"),
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
const prepared = fixture.diagnosisAnswersFixture();
const company = prepared.company;
company.profile.companyName = "합성 사전진단 연결 대조 기업";
const sourceOne = prepared.source;
const duplicate = {
  ...structuredClone(sourceOne),
  name: "같은 ID의 다른 합성 문서",
  text: "임의로 표시하면 안 되는 둘째 본문",
};
const sourceTwo = {
  ...structuredClone(sourceOne),
  id: "30000000-0000-4000-8000-000000000002",
  name: "고유 합성 검토 문서",
  text: "  고유 합성 검토 원문\n<b>문자 그대로 유지</b>\n둘째 근거 문장  ",
  originalName: "synthetic-unique.pdf",
};
const pending = {
  ...structuredClone(sourceOne),
  id: "30000000-0000-4000-8000-000000000003",
  name: "본문 판독 대기 원본",
  extraction: "pending",
  text: "",
};
company.sources.push(duplicate, sourceTwo, pending);
company.diagnosisAnswers = structuredClone(prepared.request.answers);
company.diagnosisAnswers.sme.evidence.push({
  sourceId: "30000000-0000-4000-8000-000000000099",
  sourceUpdatedAt: sourceOne.updatedAt,
  quote: "유실 연결의 기존 인용",
  locator: "유실 연결 위치",
});
company.diagnosisAnswers.industryEligibility.evidence = [
  {
    sourceId: sourceTwo.id,
    sourceUpdatedAt: sourceTwo.updatedAt,
    quote: "둘째 근거 문장",
    locator: "업종 확인 위치",
  },
];
company.diagnosisAnswers.industryEligibility.reviewed = true;
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
  await page.getByRole("tab", { name: /사전진단/ }).click();
  const editor = page.getByRole("group", { name: "기본요건 검토 답변", exact: true });
  const sme = editor.getByRole("group", { name: "중소기업 해당 여부 · 사용자 검토", exact: true });
  const industry = editor.getByRole("group", {
    name: "신청 제외업종 해당 여부 · 사용자 검토",
    exact: true,
  });
  const source = (i = 0, key = "sme") => editor.locator("#diagnosis-" + key + "-source-" + i);
  const quote = (i = 0, key = "sme") => editor.locator("#diagnosis-" + key + "-quote-" + i);
  const locator = (i = 0, key = "sme") => editor.locator("#diagnosis-" + key + "-locator-" + i);
  const row = (i = 0, key = "sme") => quote(i, key).locator("xpath=../..");
  const review = (group) => group.getByRole("checkbox");
  const warning =
    "연결한 자료를 하나로 확인할 수 없어 본문과 인용 일치 여부를 표시하지 않습니다. 자료 연결을 다시 확인해 주세요.";
  const exactText =
    "인용 문구가 현재 자료 본문에 있습니다. 기재 사실의 진위나 요건 충족을 확인한 것은 아닙니다.";
  const snapshot = () =>
    editor
      .locator("input,textarea,select")
      .evaluateAll((els) =>
        els.map((e) => ({
          id: e.id,
          value: e.value,
          checked: e.type === "checkbox" ? e.checked : null,
          group: e.closest("fieldset")?.querySelector(":scope > legend")?.textContent,
        })),
      );
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(commands, []);
    assert.deepEqual(dialogs, []);
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
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "diagnosis-binding-" + n + "-mobile.png") });
  }
  async function readBody(target, expected) {
    const details = target.locator("details");
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await details.locator("p").textContent(), expected);
    assert.equal(await details.locator("b,script").count(), 0);
    return details;
  }

  const baseline = await snapshot();
  await row()
    .getByRole("alert")
    .filter({ hasText: warning })
    .waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await row(1).getByRole("alert").textContent(), warning);
  assert.equal(await row().locator("details").count(), 0);
  assert.equal(await row(1).locator("details").count(), 0);
  assert.equal(await row().getByText(exactText, { exact: true }).count(), 0);
  const options = await source()
    .locator("option")
    .evaluateAll((els) =>
      els.map((e) => ({ value: e.value, disabled: e.disabled, text: e.textContent })),
    );
  const duplicates = options.filter((e) => e.value === sourceOne.id);
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((e) => e.disabled && e.text.includes("자료 ID 중복 · 선택 불가")));
  assert.equal(options.find((e) => e.value === pending.id).disabled, true);
  assert.equal(options.find((e) => e.value === sourceTwo.id).disabled, false);
  assert.equal(await review(sme).isDisabled(), true);
  assert.equal(await review(sme).isChecked(), false);
  assert.equal(await review(industry).isChecked(), true);
  await dirty(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("duplicate", row().getByRole("alert"));
  await shot("missing", row(1).getByRole("alert"));
  assert.deepEqual(await snapshot(), baseline);
  await sound();
  record(
    "Duplicate and missing diagnosis references show binding warnings without an arbitrary body or positive quote match. Duplicate and pending options are disabled; all inputs, the other assessment review, and clean state remain unchanged.",
  );

  await quote().fill("");
  await locator().fill("");
  const cleared = await snapshot();
  await source().selectOption(sourceTwo.id);
  assert.deepEqual(
    await snapshot(),
    cleared.map((e) => (e.id === "diagnosis-sme-source-0" ? { ...e, value: sourceTwo.id } : e)),
  );
  assert.equal(await row().getByRole("alert").count(), 0);
  const details = await readBody(row(), sourceTwo.text);
  await quote().fill("  고유 합성 검토 원문\n<b>문자 그대로 유지</b>\n둘째 근거 문장  ");
  await locator().fill("  확인 위치  ");
  await sme.getByLabel("검토 사유·미확인 사항", { exact: true }).fill("  판단 초안\n  보존  ");
  const draft = await snapshot();
  assert.equal(await row().getByText(exactText, { exact: true }).count(), 1);
  await shot("resolved", details);
  await details.locator("summary").click();
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await details.locator("p").textContent(), sourceTwo.text);
  assert.deepEqual(await snapshot(), draft);
  assert.equal(await row(1).getByRole("alert").textContent(), warning);
  assert.equal(await review(industry).isChecked(), true);
  await dirty(true);
  await sound();
  record(
    "Explicit unique source selection displays the exact body and positive quote match, with literal HTML-shaped text. Reading and toggling preserve whitespace-bearing drafts, the missing reference, and the other assessment review.",
  );

  const otherDetails = await readBody(row(0, "industryEligibility"), sourceTwo.text);
  await shot("other", otherDetails);
  assert.deepEqual(await snapshot(), draft);
  await quote().fill("");
  await locator().fill("");
  const beforeClear = await snapshot();
  await source().selectOption("");
  assert.deepEqual(
    await snapshot(),
    beforeClear.map((e) => (e.id === "diagnosis-sme-source-0" ? { ...e, value: "" } : e)),
  );
  assert.equal(await row().locator("details").count(), 0);
  assert.equal(await row().getByRole("alert").count(), 0);
  assert.equal(await row().getByText(exactText, { exact: true }).count(), 0);
  assert.equal(await row(1).getByRole("alert").textContent(), warning);
  assert.equal(await otherDetails.locator("p").textContent(), sourceTwo.text);
  assert.equal(await review(industry).isChecked(), true);
  assert.equal(await review(sme).isDisabled(), true);
  await shot("unselected", quote());
  await dirty(true);
  await sound();
  assert.equal(caseReads, 1);
  record(
    "Clearing the unique selection after explicitly clearing authored quote/location restores the ordinary unselected state without a binding error. The missing second reference and other assessment body/review remain intact; no save or business request runs.",
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
          "duplicate and missing diagnosis evidence blocks arbitrary body and quote match; unique reading preserves drafts",
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
