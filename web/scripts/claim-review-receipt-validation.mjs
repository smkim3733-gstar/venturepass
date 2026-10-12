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
const scenario = "claim-review-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/claim-reviews.tsx",
  "scripts/fixtures/claim-review-receipt.ts",
  "scripts/claim-review-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-claim-review-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/claim-review-receipt.ts"),
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
const prepared = fixture.claimReceiptFixture();
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
        assert.equal(command.action, "append-claim-review");
        assert.equal(command.revision, original.revision);
        assert.deepEqual(command.claim, prepared.input);
        if (commands.length > 1) assert.deepEqual(command, commands[0]);
        const result = fixture.claimReceiptResult(original, command.claim, command.clientRequestId);
        const saved = result.claimReviews.at(-1);
        if (patchMode === "missing") result.claimReviews.pop();
        if (patchMode === "quote") saved.claimQuote = "다른 주장";
        if (patchMode === "due") saved.dueOn = "2026-11-04";
        if (patchMode === "external") saved.externalCheck.content = "다른 수기 확인 내용";
        if (patchMode === "auxiliary") saved.numericReferences[1].version = 1;
        if (patchMode === "judgement") saved.judgement.state = "consistent";
        if (patchMode === "nonce") saved.clientRequestId = fixture.agencyId(399);
        if (patchMode === "order") saved.numericReferences.reverse();
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
  const panel = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
  await panel
    .getByRole("button", { name: "이 주장 v1에서 새 검토 버전 작성", exact: true })
    .click();
  const fields = [
    ["주장 문장을 원문 그대로 인용 *", "claimQuote"],
    ["기업·기간·단위·범위 해석 메모", "contextNote"],
    ["확인 담당자 (수동 기록)", "owner"],
    ["직접 정한 확인 기한 (미확인은 비움)", "dueOn"],
    ["다음 확인 사항", "nextCheck"],
    ["직접 확인한 외부 대상 (미확인은 비움)", "target"],
    ["외부에서 확인했다고 기록한 내용", "content"],
    ["외부 확인일 (직접 입력)", "occurredOn"],
  ];
  for (const [label, key] of fields)
    await panel.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  await panel.getByLabel("주장 성격 (담당자 분류)", { exact: true }).selectOption("assumption");
  await panel.getByLabel("검토 방식", { exact: true }).selectOption("multiple");
  const auxiliary = panel.getByLabel("수치 대조 참고 버전 (최대 10개)", { exact: true });
  await auxiliary.selectOption(prepared.input.numericReferences.map((r) => r.id));
  const judgementFields = [
    ["판단자", "reviewer"],
    ["판단 이유", "reason"],
    ["판단 확인일 (직접 입력)", "checkedOn"],
  ];
  for (const [label, key] of judgementFields)
    await panel.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  await panel.getByLabel("이번 버전의 담당자 판단", { exact: true }).selectOption("insufficient");
  const save = () => panel.getByRole("button", { name: "주장 검토 새 버전 저장", exact: true });
  const errorText =
    "주장·근거 검토의 저장 기록을 확인하지 못했습니다. 원래 인용·판단과 요청 번호를 유지했습니다.";
  for (const mode of [
    "missing",
    "quote",
    "due",
    "external",
    "auxiliary",
    "judgement",
    "nonce",
    "order",
  ]) {
    patchMode = mode;
    await save().click();
    await page.getByText(errorText, { exact: true }).first().waitFor();
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    for (const [label, key] of [...fields, ...judgementFields])
      assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), prepared.raw[key]);
    for (const [label, value] of [
      ["주장 성격 (담당자 분류)", "assumption"],
      ["검토 방식", "multiple"],
      ["이번 버전의 담당자 판단", "insufficient"],
      ["저장 원고 버전 직접 선택 *", prepared.input.planId],
      ["고유 원고 항목 *", prepared.input.sectionKey],
    ])
      assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), value);
    assert.deepEqual(
      await auxiliary.evaluate((el) => Array.from(el.selectedOptions, (o) => o.value)),
      prepared.input.numericReferences.map((r) => r.id),
    );
    assert.equal(await save().isDisabled(), false);
    assert.deepEqual(company, original);
    await page
      .getByText(errorText, { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  record(
    "eight mismatched receipts rejected; original claim quote, owner, deadline, manual check, auxiliary versions, judgement and nonce preserved",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await auxiliary.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.screenshot({ path: path.join(output, "claim-review-receipt-mobile.png") });
  patchMode = "exact";
  await save().click();
  await save().waitFor({ state: "hidden" });
  const latest = panel.getByRole("article", { name: "주장 검토 v2", exact: true });
  await latest.waitFor();
  assert.ok((await latest.innerText()).includes(prepared.raw.claimQuote));
  assert.ok((await latest.innerText()).includes("근거 부족 (담당자)"));
  assert.ok((await latest.innerText()).includes(prepared.raw.content.trim()));
  const accepted = company.claimReviews.at(-1);
  assert.equal(accepted.claimQuote, prepared.input.claimQuote);
  assert.deepEqual(accepted.externalCheck, prepared.input.externalCheck);
  assert.deepEqual(accepted.numericReferences, prepared.input.numericReferences);
  assert.equal(accepted.clientRequestId, commands[0].clientRequestId);
  assert.equal(accepted.judgement.state, "insufficient");
  assert.deepEqual(company.claimReviews[0], original.claimReviews[0]);
  await panel.getByText("과거 주장 검토 1개 버전", { exact: true }).click();
  const prior = panel.getByRole("article", { name: "주장 검토 v1", exact: true });
  await prior.waitFor();
  assert.ok((await prior.innerText()).includes("이전 해석 메모"));
  record(
    "exact v2 retains insufficient-evidence judgement and exact auxiliary references; original v1 remains readable",
  );
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  await panel.getByRole("article", { name: "주장 검토 v2", exact: true }).waitFor();
  assert.equal(commands.length, 9);
  assert.equal(caseReads, 1);
  for (const key of Object.keys(original)) {
    if (["revision", "updatedAt", "claimReviews"].includes(key)) continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "v2 survives tab roundtrip; original company, plans and numeric history preserved without external verification or automatic retry",
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
          "claim review responses are synthetic memory only; manual external-check fields are test text, no actual external verification, download, AI, API, SQL or institution execution",
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
