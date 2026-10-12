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
const scenario = "numeric-check-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/numeric-checks.tsx",
  "scripts/fixtures/numeric-check-receipt.ts",
  "scripts/numeric-check-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-numeric-check-receipt-ui-"));
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
const prepared = fixture.numericReceiptFixture();
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
        assert.ok(commands.length <= 8);
        assert.equal(command.action, "append-numeric-check");
        assert.equal(command.revision, original.revision);
        assert.deepEqual(command.check, prepared.input);
        if (commands.length > 1) assert.deepEqual(command, commands[0]);
        const result = fixture.numericReceiptResult(
          original,
          command.check,
          command.clientRequestId,
        );
        const saved = result.numericChecks.at(-1);
        if (patchMode === "missing") result.numericChecks.pop();
        if (patchMode === "value") saved.observations[1].valueText = "2,300.26";
        if (patchMode === "unit") saved.observations[1].unit = "person";
        if (patchMode === "period") saved.observations[1].period.start = "2025-02-01";
        if (patchMode === "formula") saved.formulas[0].operandIds.reverse();
        if (patchMode === "judgement") saved.judgement.state = "reviewed";
        if (patchMode === "nonce") saved.clientRequestId = fixture.agencyId(299);
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
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  const panel = page.getByRole("region", { name: "기간·단위·산식 수치 대조", exact: true });
  await panel.getByRole("button", { name: "이 대조안의 새 버전 작성", exact: true }).click();
  const fields = [
    ["대조안 제목 *", "title"],
    ["판단 담당자", "reviewer"],
    ["판단 메모·미해결 사항", "reviewNote"],
  ];
  for (const [label, key] of fields)
    await panel.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  const observation = (i) => panel.getByRole("group", { name: `관측 수치 ${i + 1}`, exact: true });
  const obsFields = [
    ["수치 이름 *", "label"],
    ["원문 숫자 표기 (미확인은 비움)", "valueText"],
    ["출처 해석·범위·가정 메모 (수동)", "note"],
    ["수치가 포함된 원문 그대로 인용 *", "quote"],
  ];
  for (let i = 0; i < 3; i++)
    for (const [label, key] of obsFields)
      await observation(i)
        .getByLabel(label, { exact: true })
        .fill(prepared.raw.observations[i][key]);
  await panel.getByLabel("이번 버전의 내부 판단", { exact: true }).selectOption("needs-work");
  const save = () => panel.getByRole("button", { name: "수치 대조 버전 저장", exact: true });
  const errorText =
    "수치 대조의 저장 기록을 확인하지 못했습니다. 원래 수치·산식과 요청 번호를 유지했습니다.";
  for (const mode of ["missing", "value", "unit", "period", "formula", "judgement", "nonce"]) {
    patchMode = mode;
    await save().click();
    await page.getByText(errorText, { exact: true }).first().waitFor();
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    for (const [label, key] of fields)
      assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), prepared.raw[key]);
    assert.equal(
      await panel.getByLabel("이번 버전의 내부 판단", { exact: true }).inputValue(),
      "needs-work",
    );
    for (let i = 0; i < 3; i++) {
      for (const [label, key] of obsFields)
        assert.equal(
          await observation(i).getByLabel(label, { exact: true }).inputValue(),
          prepared.raw.observations[i][key],
        );
      for (const [label, value] of [
        ["단위 직접 확인", "item"],
        ["자료 기재·목표·가정 구분", "reported"],
        ["기준일·기간", "range"],
        ["시작일 *", "2025-01-01"],
        ["종료일 *", "2025-12-31"],
        ["정확한 인용 연결", "plan"],
        ["저장 원고 버전 *", prepared.input.observations[i].reference.planId],
        ["원고 항목 *", prepared.input.observations[i].reference.sectionKey],
      ])
        assert.equal(await observation(i).getByLabel(label, { exact: true }).inputValue(), value);
    }
    const pair = panel.getByRole("group", { name: "비교쌍 1", exact: true });
    assert.equal(
      await pair.getByLabel("왼쪽 수치", { exact: true }).inputValue(),
      prepared.input.comparisons[0].leftId,
    );
    assert.equal(
      await pair.getByLabel("오른쪽 수치", { exact: true }).inputValue(),
      prepared.input.comparisons[0].rightId,
    );
    const formula = panel.getByRole("group", { name: "산식 1", exact: true });
    assert.equal(
      await formula
        .getByLabel("연산 (변경하면 피연산값 선택 초기화)", { exact: true })
        .inputValue(),
      "sum",
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        await formula.getByLabel(`피연산값 ${i + 1}`, { exact: true }).inputValue(),
        prepared.input.formulas[0].operandIds[i],
      );
    assert.equal(
      await formula.getByLabel("계산 결과와 대조할 별도 입력값", { exact: true }).inputValue(),
      prepared.input.formulas[0].expectedId,
    );
    assert.equal(await save().isDisabled(), false);
    assert.deepEqual(company, original);
    await page
      .getByText(errorText, { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  record(
    "seven mismatched receipts rejected; all three raw numbers, units, periods, citations, formula, judgement and nonce preserved",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await observation(2).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.screenshot({ path: path.join(output, "numeric-check-receipt-mobile.png") });
  patchMode = "exact";
  await save().click();
  await save().waitFor({ state: "hidden" });
  const latest = panel.getByRole("article", { name: "수치 대조 v2", exact: true });
  await latest.waitFor();
  await latest.getByText("저장 수치·정확한 인용·원고/원본 SHA·판단 메모", { exact: true }).click();
  assert.ok((await latest.innerText()).includes("3,500.75"));
  assert.ok((await latest.innerText()).includes("보완 필요로 기록"));
  const accepted = company.numericChecks.at(-1);
  assert.deepEqual(accepted.observations, prepared.input.observations);
  assert.deepEqual(accepted.formulas, prepared.input.formulas);
  assert.deepEqual(accepted.comparisons, prepared.input.comparisons);
  assert.equal(accepted.clientRequestId, commands[0].clientRequestId);
  assert.equal(accepted.evaluation.formulas[0].state, "arithmetic-equal");
  assert.equal(accepted.evaluation.formulas[0].result.decimal, "3500.75");
  assert.equal(accepted.judgement.state, "needs-work");
  assert.deepEqual(company.numericChecks[0], original.numericChecks[0]);
  await panel.getByText("이전 수치 대조 버전 1개", { exact: true }).click();
  const prior = panel.getByRole("article", { name: "수치 대조 v1", exact: true });
  await prior.getByText("저장 수치·정확한 인용·원고/원본 SHA·판단 메모", { exact: true }).click();
  assert.ok((await prior.innerText()).includes("이전 수치 대조"));
  record("exact v2 retains entered decimal notation and needs-work judgement; v1 stays readable");
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  await panel.getByRole("article", { name: "수치 대조 v2", exact: true }).waitFor();
  assert.equal(commands.length, 8);
  assert.equal(caseReads, 1);
  for (const key of Object.keys(original)) {
    if (["revision", "updatedAt", "numericChecks"].includes(key)) continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "v2 survives tab roundtrip; original plan and company preserved, no AI, download or automatic retry",
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
          "numeric check responses are synthetic memory only; explicit same-request retries, no download, AI, actual API, SQL or institution execution",
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
