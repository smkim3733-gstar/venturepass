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
const scenario = "appeal-preparation-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/appeal-preparation.tsx",
  "src/components/studio/appeal-preparation-response.ts",
  "scripts/fixtures/appeal-preparation-receipt.ts",
  "scripts/appeal-preparation-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(
  path.join(temporaryRoot, "venturepass-appeal-preparation-receipt-ui-"),
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
const prepared = fixture.appealReceiptFixture();
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
        assert.equal(command.action, "append-appeal-preparation");
        assert.equal(command.revision, original.revision);
        assert.deepEqual(command.preparation, prepared.input);
        if (commands.length > 1) assert.deepEqual(command, commands[0]);
        const result = fixture.appealReceiptResult(
          original,
          command.preparation,
          command.clientRequestId,
        );
        const saved = result.appealPreparations.at(-1);
        if (patchMode === "missing") result.appealPreparations.pop();
        if (patchMode === "notice") saved.noticeVersionId = prepared.input.noticeRecordId;
        if (patchMode === "deadline") saved.deadlineOn = "2026-11-04";
        if (patchMode === "reason") saved.reasons[1].draft = "다른 소명";
        if (patchMode === "review") saved.review.reviewedAt = null;
        if (patchMode === "history") result.appealPreparations[0].intentNote = "변경된 과거";
        if (patchMode === "nonce") saved.clientRequestId = fixture.agencyId(199);
        if (patchMode === "order") saved.reasons.reverse();
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
  const panel = page.getByRole("region", { name: "결과 사유별 소명 준비", exact: true });
  await panel.getByRole("button", { name: "이 준비안 새 버전 작성", exact: true }).click();
  const fields = [
    ["준비안 제목 *", "title"],
    ["진행 판단 메모", "intentNote"],
    ["확인한 안내의 기한 (미확인은 비움)", "deadlineOn"],
    ["기한을 확인한 원문·근거", "deadlineNote"],
    ["내부 검토자 (검토 기록 시 필수)", "reviewer"],
    ["내부 검토 메모", "reviewNote"],
  ];
  for (const [label, key] of fields)
    await panel.getByLabel(label, { exact: true }).fill(prepared.raw[key]);
  await panel.getByLabel("진행 판단", { exact: true }).selectOption("not-pursuing");
  const reasonPanel = (i) => panel.getByRole("group", { name: `사유 ${i + 1}`, exact: true });
  const reasonFields = [
    ["기존 주장·설명", "claim"],
    ["추가 설명·보강이 필요한 사항", "gap"],
    ["이 사유에 대한 소명 초안", "draft"],
  ];
  for (let i = 0; i < 2; i++)
    for (const [label, key] of reasonFields)
      await reasonPanel(i).getByLabel(label, { exact: true }).fill(prepared.raw.reasons[i][key]);
  await panel.getByRole("checkbox").check();
  const save = () => panel.getByRole("button", { name: "새 버전으로 저장", exact: true });
  const errorText =
    "소명 준비의 저장 기록을 확인하지 못했습니다. 원래 입력과 요청 번호를 유지했습니다.";
  for (const mode of [
    "missing",
    "notice",
    "deadline",
    "reason",
    "review",
    "history",
    "nonce",
    "order",
  ]) {
    patchMode = mode;
    await save().click();
    await page.getByText(errorText, { exact: true }).first().waitFor();
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    for (const [label, key] of fields)
      assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), prepared.raw[key]);
    assert.equal(await panel.getByLabel("진행 판단", { exact: true }).inputValue(), "not-pursuing");
    assert.equal(await panel.getByRole("checkbox").isChecked(), true);
    for (let i = 0; i < 2; i++) {
      for (const [label, key] of reasonFields)
        assert.equal(
          await reasonPanel(i).getByLabel(label, { exact: true }).inputValue(),
          prepared.raw.reasons[i][key],
        );
      assert.equal(
        await reasonPanel(i)
          .getByLabel("대응할 사유를 위 원문 그대로 인용 *", { exact: true })
          .inputValue(),
        prepared.input.reasons[i].noticeQuote,
      );
      assert.equal(
        await reasonPanel(i).getByLabel("기존 원고 버전 연결 (선택)", { exact: true }).inputValue(),
        prepared.input.reasons[i].planClaim.planId,
      );
      assert.equal(
        await reasonPanel(i).getByLabel("원고 항목", { exact: true }).inputValue(),
        prepared.input.reasons[i].planClaim.sectionKey,
      );
      assert.equal(
        await reasonPanel(i)
          .getByLabel("선택 원고의 해당 부분 그대로 인용 *", { exact: true })
          .inputValue(),
        prepared.input.reasons[i].planClaim.quote,
      );
    }
    assert.equal(await save().isDisabled(), false);
    assert.deepEqual(company, original);
    await page
      .getByText(errorText, { exact: true })
      .first()
      .waitFor({ state: "hidden", timeout: 15000 });
  }
  record(
    "eight mismatched receipts rejected; original title, intent, deadline, two reasons, citations, review and nonce preserved",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await reasonPanel(1).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.screenshot({ path: path.join(output, "appeal-preparation-receipt-mobile.png") });
  patchMode = "exact";
  await save().click();
  await save().waitFor({ state: "hidden" });
  const latest = panel.getByRole("article", { name: "소명 준비 v2", exact: true });
  await latest.waitFor();
  await latest.getByText("사유·근거·소명·검토 기록 펼치기", { exact: true }).click();
  assert.ok((await latest.innerText()).includes(prepared.raw.reasons[1].draft));
  const accepted = company.appealPreparations.at(-1);
  assert.deepEqual(accepted.reasons, prepared.input.reasons);
  assert.equal(accepted.clientRequestId, commands[0].clientRequestId);
  assert.equal(accepted.noticeVersionId, prepared.input.noticeVersionId);
  assert.equal(accepted.intent, "not-pursuing");
  assert.equal(accepted.deadlineOn, prepared.raw.deadlineOn);
  assert.equal(accepted.review.reviewedAt, accepted.recordedAt);
  assert.deepEqual(company.appealPreparations[0], original.appealPreparations[0]);
  await panel.getByText("이전 준비 버전 1개", { exact: true }).click();
  const prior = panel.getByRole("article", { name: "소명 준비 v1", exact: true });
  await prior.getByText("사유·근거·소명·검토 기록 펼치기", { exact: true }).click();
  assert.ok((await prior.innerText()).includes("이전 소명 1"));
  record(
    "exact v2 accepts explicit decision and deadline against corrected notice; original v1 remains readable",
  );
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  await panel.getByRole("article", { name: "소명 준비 v2", exact: true }).waitFor();
  assert.equal(commands.length, 9);
  assert.equal(caseReads, 1);
  for (const key of Object.keys(original)) {
    if (["revision", "updatedAt", "appealPreparations"].includes(key)) continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "v2 survives tab roundtrip; unrelated company state preserved without institution action or automatic retry",
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
          "appeal preparation responses are synthetic memory only; explicit same-request retries, no answer registration, messaging, actual API, SQL or institution execution",
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
