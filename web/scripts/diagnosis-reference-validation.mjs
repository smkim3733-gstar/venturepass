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
const scenario = "diagnosis-reference";

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
  "scripts/diagnosis-reference-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-diagnosis-reference-ui-"));
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
company.profile.companyName = "합성 사전진단 인용 보호 기업";
const sourceOne = prepared.source;
const sourceTwo = {
  ...structuredClone(sourceOne),
  id: "30000000-0000-4000-8000-000000000002",
  name: "둘째 합성 검토 문서",
  text: "다른 합성 검토 원문\n둘째 근거 문장",
  originalName: "synthetic-second.pdf",
};
company.sources.push(sourceTwo);
company.diagnosisAnswers = structuredClone(prepared.request.answers);
company.diagnosisAnswers.sme.evidence.push({
  sourceId: sourceTwo.id,
  sourceUpdatedAt: sourceTwo.updatedAt,
  quote: "둘째 근거 문장",
  locator: "둘째 위치",
});
company.diagnosisAnswers.industryEligibility.evidence = [
  {
    sourceId: sourceOne.id,
    sourceUpdatedAt: sourceOne.updatedAt,
    quote: "다른 원문 문구",
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
  const remove = (i = 0, key = "sme") =>
    editor.getByRole("button", {
      name:
        (key === "sme" ? "중소기업 해당 여부" : "신청 제외업종 해당 여부") +
        " 근거 " +
        (i + 1) +
        " 삭제",
      exact: true,
    });
  const review = (group) => group.getByRole("checkbox");
  const values = (els) =>
    els.map((e) => ({
      id: e.id,
      value: e.value,
      checked: e.type === "checkbox" ? e.checked : null,
      group: e.closest("fieldset")?.querySelector(":scope > legend")?.textContent,
    }));
  const inputs = () => editor.locator("input,textarea,select").evaluateAll(values);
  const groupInputs = (group) => group.locator("input,textarea,select").evaluateAll(values);
  const switchMessage = "작성한 인용·원문 위치를 비우고 근거 자료를 변경할까요?";
  const removeMessage = "선택한 자료와 작성한 인용·원문 위치를 포함한 이 근거를 삭제할까요?";
  async function sound() {
    assert.deepEqual(companies, original);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    assert.equal(commands.length, 0);
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
  async function confirmAction(action, message, run) {
    const count = dialogs.length;
    nextDialog = action;
    await run();
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), { message, action });
    await sound();
  }
  async function noDialog(run) {
    const count = dialogs.length;
    await run();
    assert.equal(dialogs.length, count);
    await sound();
  }
  async function shot(n, target) {
    await target.scrollIntoViewIfNeeded();
    const b = await target.boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 391);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "diagnosis-reference-" + n + "-mobile.png") });
  }
  function switched(before, id) {
    return before.map((e) =>
      e.id === "diagnosis-sme-source-0"
        ? { ...e, value: id }
        : ["diagnosis-sme-quote-0", "diagnosis-sme-locator-0"].includes(e.id)
          ? { ...e, value: "" }
          : e.checked !== null && e.group === "중소기업 해당 여부 · 사용자 검토"
            ? { ...e, checked: false }
            : e,
    );
  }
  const baseline = await inputs();
  assert.equal(await review(sme).isChecked(), true);
  assert.equal(await review(industry).isChecked(), true);
  await dirty(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await confirmAction("dismiss", switchMessage, () => source().selectOption(sourceTwo.id));
  assert.deepEqual(await inputs(), baseline);
  await dirty(false);
  await shot("switch-kept", quote());
  await confirmAction("accept", switchMessage, () => source().selectOption(sourceTwo.id));
  assert.deepEqual(await inputs(), switched(baseline, sourceTwo.id));
  await dirty(true);
  await locator().fill("   ");
  const locationOnly = await inputs();
  await confirmAction("dismiss", switchMessage, () => source().selectOption(""));
  assert.deepEqual(await inputs(), locationOnly);
  await shot("location-kept", locator());
  await confirmAction("accept", switchMessage, () => source().selectOption(""));
  assert.deepEqual(await inputs(), switched(locationOnly, ""));
  await noDialog(() => source().selectOption(sourceOne.id));
  assert.equal(await quote().inputValue(), "");
  assert.equal(await locator().inputValue(), "");
  record(
    "Source switching confirms before discarding exact quote/locator or whitespace-only locator. Dismiss preserves every input and initial review; accept applies only existing source reset and review clearing. Empty reference selection remains direct.",
  );

  await quote().fill("  합성 중소기업 검토 문구  ");
  await locator().fill("  원본 1페이지  ");
  await sme.getByLabel("검토 사유·미확인 사항", { exact: true }).fill("  판단 메모\n  보존  ");
  await review(sme).check();
  const beforeRemove = await inputs(),
    other = await groupInputs(industry);
  await confirmAction("dismiss", removeMessage, () => remove().click());
  assert.deepEqual(await inputs(), beforeRemove);
  await shot("remove-kept", quote());
  await remove().focus();
  await confirmAction("accept", removeMessage, () => page.keyboard.press("Enter"));
  const expected = beforeRemove
    .filter((e) => !/^diagnosis-sme-(source|quote|locator)-0$/.test(e.id))
    .map((e) =>
      /^diagnosis-sme-(source|quote|locator)-1$/.test(e.id)
        ? { ...e, id: e.id.replace(/-1$/, "-0") }
        : e.checked !== null && e.group === "중소기업 해당 여부 · 사용자 검토"
          ? { ...e, checked: false }
          : e,
    );
  assert.deepEqual(await inputs(), expected);
  assert.deepEqual(await groupInputs(industry), other);
  const add = sme.getByRole("button", { name: "원문 근거 연결", exact: true });
  await add.click();
  await noDialog(() => remove(1).click());
  await add.click();
  await noDialog(() => source(1).selectOption(sourceOne.id));
  const onlySource = await inputs();
  await confirmAction("dismiss", removeMessage, () => remove(1).click());
  assert.deepEqual(await inputs(), onlySource);
  await confirmAction("accept", removeMessage, () => remove(1).click());
  assert.deepEqual(await inputs(), expected);
  assert.deepEqual(await groupInputs(industry), other);
  record(
    "Removing a populated reference retains all input on refusal and removes only that row on keyboard acceptance, with the remaining reference renumbered. Empty rows remove directly, while source-only rows require confirmation.",
  );

  await review(sme).check();
  await industry.getByRole("button", { name: "원문 근거 연결", exact: true }).click();
  await quote(1, "industryEligibility").fill(" \n ");
  const errorInputs = await inputs();
  await editor.getByRole("button", { name: "검토 답변 저장", exact: true }).click();
  const error = page.getByRole("alert").filter({ hasText: "Invalid UUID" });
  await error.waitFor({ state: "visible" });
  const errorText = await error.textContent();
  assert.equal(errorText, "Invalid UUID");
  assert.deepEqual(await inputs(), errorInputs);
  await confirmAction("dismiss", removeMessage, () => remove(1, "industryEligibility").click());
  assert.deepEqual(await inputs(), errorInputs);
  assert.equal(await error.textContent(), errorText);
  await shot("error-kept", quote(1, "industryEligibility"));
  await confirmAction("accept", removeMessage, () => remove(1, "industryEligibility").click());
  const afterError = errorInputs.filter(
    (e) => !/^diagnosis-industryEligibility-(source|quote|locator)-1$/.test(e.id),
  );
  assert.deepEqual(await inputs(), afterError);
  assert.equal(await error.textContent(), errorText);
  assert.equal(await quote(0, "industryEligibility").inputValue(), "다른 원문 문구");
  assert.equal(await locator(0, "industryEligibility").inputValue(), "업종 확인 위치");
  await shot("remaining", quote(0, "industryEligibility"));
  await dirty(true);
  await sound();
  assert.equal(caseReads, 1);
  assert.equal(dialogs.length, 10);
  record(
    "A whitespace-only quote in the other assessment is protected even after existing local UUID validation fails. Refusal preserves the full form/error; acceptance removes only that new row and leaves the original evidence and error, with no save request.",
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
          "diagnosis reference switches and removal preserve authored evidence until explicit confirmation",
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
