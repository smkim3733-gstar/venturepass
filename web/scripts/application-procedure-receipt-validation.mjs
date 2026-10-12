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
const scenario = "application-procedure-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/application-procedures-ui.ts",
  "scripts/fixtures/application-procedure-receipt.ts",
  "scripts/application-procedure-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(
  path.join(temporaryRoot, "venturepass-application-procedure-receipt-ui-"),
);
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
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let caseReads = 0,
  patchMode = "missing";
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
        assert.ok(commands.length <= 9);
        assert.equal(command.action, "append-application-procedure");
        assert.equal(command.revision, original.revision);
        assert.deepEqual(command.procedure, prepared.input);
        if (commands.length > 1) assert.deepEqual(command, commands[0]);
        const result = await fixture.procedureReceiptResult(
          original,
          command.procedure,
          command.clientRequestId,
        );
        const saved = result.applicationProcedures.at(-1);
        if (patchMode === "missing") result.applicationProcedures.pop();
        if (patchMode === "agency") saved.agencyVersionId = fixture.linkId(401);
        if (patchMode === "due") saved.dueOn = "2026-10-21";
        if (patchMode === "extension") saved.extendedDueOn = "2026-11-04";
        if (patchMode === "status") saved.status = "reported_completed";
        if (patchMode === "link") saved.linkEventId = fixture.linkId(499);
        if (patchMode === "digest") saved.inputDigest = "f".repeat(64);
        if (patchMode === "nonce") saved.clientRequestId = fixture.linkId(499);
        if (patchMode !== "exact") return reply(result);
        company = result;
        companies[0] = company;
        return reply(company);
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

  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  const readiness = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await readiness;
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "회차별 절차·안내기한", exact: true });
  await panel.getByRole("button", { name: "새 버전으로 정정", exact: true }).click();
  const form = panel.getByRole("region", { name: "절차 기록 정정", exact: true });
  await form
    .getByLabel("신청 회차의 현재 정보 *", { exact: true })
    .selectOption(prepared.input.applicationId);
  await form
    .getByLabel("이 회차에 귀속된 기관 요청·통보의 최신 버전 *", { exact: true })
    .selectOption(prepared.input.agencyVersionId);
  const fields = [
    ["절차 기록 제목 *", "title"],
    ["요청 주체·담당자 (미확인 시 공란)", "requester"],
    ["안내기한 근거", "dueBasis"],
    ["연장 상태·일자·기한을 기록한 근거", "extensionBasis"],
    ["진행 상태 근거", "statusBasis"],
    ["완료됐다고 기록할 근거", "completionBasis"],
    ["추가 메모", "note"],
    ["기록 담당자 *", "recordedBy"],
    ["요청일 (선택)", "requestedOn"],
    ["안내기한 (선택)", "dueOn"],
    ["연장 요청일 (선택)", "extensionRequestedOn"],
    ["연장 결과 기록일 (선택)", "extensionDecidedOn"],
    ["연장됐다고 기록한 기한 (선택)", "extendedDueOn"],
  ];
  for (const [label, key] of fields)
    await form.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  const selections = [
    ["절차 분류", "evaluation"],
    ["연장 상태 (담당자 기록)", "reported_allowed"],
    ["진행 상태 (담당자 기록)", "preparing"],
  ];
  for (const [label, value] of selections)
    await form.getByLabel(label, { exact: true }).selectOption(value);
  const confirmation = form.getByRole("checkbox");
  await confirmation.check();
  const save = () =>
    form.getByRole("button", { name: /^(담당자 절차 기록 저장|같은 내용으로 저장 확인)$/ });
  const errorText =
    "절차·안내기한의 저장 기록을 확인하지 못했습니다. 원래 회차·기한·근거와 요청 번호를 유지했습니다.";
  for (const mode of [
    "missing",
    "agency",
    "due",
    "extension",
    "status",
    "link",
    "digest",
    "nonce",
  ]) {
    patchMode = mode;
    await save().click();
    await page.getByText(errorText, { exact: true }).first().waitFor();
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    for (const [label, key] of fields) {
      assert.equal(await form.getByLabel(label, { exact: true }).inputValue(), prepared.raw[key]);
      assert.equal(await form.getByLabel(label, { exact: true }).isDisabled(), true);
    }
    for (const [label, value] of [
      ...selections,
      ["신청 회차의 현재 정보 *", prepared.input.applicationId],
      ["이 회차에 귀속된 기관 요청·통보의 최신 버전 *", prepared.input.agencyVersionId],
    ])
      assert.equal(await form.getByLabel(label, { exact: true }).inputValue(), value);
    assert.equal(await confirmation.isChecked(), true);
    assert.equal(await confirmation.isDisabled(), true);
    assert.equal(await save().isDisabled(), false);
    assert.deepEqual(company, original);
    await page
      .getByText(errorText, { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  record(
    "eight mismatched receipts rejected; exact cycle, agency version, deadline, extension, grounds, confirmation and original request preserved",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await save().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.screenshot({ path: path.join(output, "application-procedure-receipt-mobile.png") });
  patchMode = "exact";
  await save().click();
  await form.waitFor({ state: "hidden" });
  const latest = panel
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "새 절차 기록 · v2", exact: true }) });
  await latest.waitFor();
  for (const value of ["2026-11-03", "허용됐다고 기록", "대응 준비 중", prepared.raw.note.trim()])
    assert.ok((await latest.innerText()).includes(value));
  const accepted = company.applicationProcedures.at(-1);
  assert.equal(accepted.clientRequestId, commands[0].clientRequestId);
  assert.equal(accepted.extendedDueOn, prepared.input.extendedDueOn);
  assert.equal(accepted.status, "preparing");
  assert.equal(accepted.officialVerification, "unverified");
  assert.deepEqual(company.applicationProcedures[0], original.applicationProcedures[0]);
  await panel.getByText("과거 절차 버전 보기", { exact: true }).click();
  const prior = panel
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "이전 절차 기록 · v1", exact: true }) });
  await prior.waitFor();
  assert.ok((await prior.innerText()).includes("이전 절차 메모"));
  await prior.getByText("보관 당시 기관 원문 v1·추가 증빙", { exact: true }).click();
  assert.ok((await prior.innerText()).includes("이전 기관 요청 원문"));
  record(
    "exact v2 retains manual extension/status; prior v1 and original agency snapshot remain readable",
  );
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  await panel.getByRole("heading", { name: "새 절차 기록 · v2", exact: true }).waitFor();
  assert.equal(commands.length, 9);
  assert.equal(caseReads, 1);
  for (const key of Object.keys(original)) {
    if (["revision", "updatedAt", "applicationProcedures"].includes(key)) continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "v2 survives tab roundtrip; application, agency, tasks and company stage unchanged without official execution or automatic retry",
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

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "application procedure responses are synthetic memory only; dates, extension and status are manual test input, no official verification, legal deadline calculation, download, AI, API, SQL or institution execution",
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
