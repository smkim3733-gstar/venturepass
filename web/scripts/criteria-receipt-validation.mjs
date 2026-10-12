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
const scenario = "criteria-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/criteria-versions-ui.ts",
  "scripts/fixtures/criteria-receipt.ts",
  "scripts/criteria-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-criteria-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/criteria-receipt.ts"),
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
const prepared = await fixture.criteriaReceiptFixture();
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let pinBase;
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
        assert.ok(commands.length <= 16);
        const pinning = command.action === "pin-application-criteria";
        assert.ok(pinning || command.action === "append-criteria-version");
        const base = pinning ? pinBase : original;
        assert.equal(command.revision, base.revision);
        const { revision, clientRequestId, ...input } = command;
        void revision;
        const expected = pinning
          ? {
              ...fixture.criteriaReceiptPin(base, fixture.linkId(532)),
              recordedBy: "연결 담당",
              reason: "두 번째 회차에 새 조건 연결\n직접 확인한 수기 기록",
            }
          : prepared.input;
        assert.deepEqual(input, expected);
        const group = commands.filter((c) => c.action === command.action);
        if (group.length > 1) assert.deepEqual(command, group[0]);
        const result = await fixture.criteriaReceiptResult(
          base,
          input,
          clientRequestId,
          pinning ? fixture.linkId(534) : fixture.linkId(532),
        );
        const saved = pinning
          ? result.applicationCriteriaBindings.at(-1)
          : result.criteriaVersions.at(-1);
        if (patchMode === "missing") {
          if (pinning) result.applicationCriteriaBindings.pop();
          else result.criteriaVersions.pop();
        }
        if (patchMode === "digest") saved.inputDigest = "f".repeat(64);
        if (patchMode === "nonce") saved.clientRequestId = fixture.linkId(599);
        if (!pinning) {
          if (patchMode === "quote") saved.details.sources[1].quote = "다른 두 번째 출처 인용";
          if (patchMode === "document")
            saved.details.documents[1].alternativeCondition = "다른 대체자료 조건";
          if (patchMode === "order") saved.details.documents.reverse();
          if (patchMode === "hash") saved.contentSha256 = "f".repeat(64);
        } else {
          if (patchMode === "version") saved.criteriaVersionId = fixture.linkId(511);
          if (patchMode === "application") saved.applicationId = original.applications[0].id;
          if (patchMode === "snapshot")
            saved.applicationSnapshot.metadataVersionId = fixture.linkId(599);
          if (patchMode === "summary") saved.criteriaSummary.versionLabel = "다른 기준 표기";
        }
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
  const panel = page.getByRole("region", { name: "기준·서류 조건 버전", exact: true });
  await panel.getByRole("button", { name: "새 기준 버전으로 정정", exact: true }).click();
  const form = panel.getByRole("region", { name: "기준 버전 편집", exact: true });
  const topFields = [
    ["기준 제목 *", prepared.raw.details.title],
    ["내부 버전 표기 *", prepared.raw.details.versionLabel],
    ["적용 경로 (미확인 시 공란)", prepared.raw.details.applicationPath],
    ["담당자 확인일 (선택)", prepared.raw.details.checkedOn],
    ["기록 담당자 *", prepared.raw.recordedBy],
    ["기록·정정·연결 이유 *", prepared.raw.reason],
  ];
  for (const [label, value] of topFields) await form.getByLabel(label, { exact: true }).fill(value);
  const sourceFields = [
    ["출처 제목", "title"],
    ["출처 URL", "url"],
    ["해당 조건의 원문 인용", "quote"],
    ["확인 메모", "note"],
  ];
  const documentFields = [
    ["서류 이름 *", "name"],
    ["적용 대상", "appliesTo"],
    ["대상 기간", "period"],
    ["발급일 조건", "issueDateCondition"],
    ["대체자료 조건", "alternativeCondition"],
    ["자동연계 가능 안내 (실제 수신 결과 아님)", "autoLinkGuidance"],
    ["확인할 사항", "note"],
  ];
  const retained = [];
  for (const [prefix, fields, rows] of [
    ["출처", sourceFields, prepared.raw.details.sources],
    ["서류", documentFields, prepared.raw.details.documents],
  ])
    for (let i = 0; i < rows.length; i++)
      for (const [label, key] of fields) {
        const locator = form
          .getByRole("group", { name: prefix + " " + (i + 1), exact: true })
          .getByLabel(label, { exact: true });
        await locator.fill(rows[i][key]);
        retained.push([locator, rows[i][key]]);
      }
  for (const [label, value] of topFields)
    retained.push([form.getByLabel(label, { exact: true }), value]);
  await form.getByRole("checkbox").check();
  const errorText =
    "기준·회차 연결의 저장 기록을 확인하지 못했습니다. 원래 조건·선택과 요청 번호를 유지했습니다.";
  async function rejected(current, fields, modes, initialLabel, base) {
    for (const mode of modes) {
      patchMode = mode;
      const save = current.getByRole("button", {
        name: new RegExp("^(" + initialLabel + "|같은 내용으로 저장 확인)$"),
      });
      await save.click();
      await page.getByText(errorText, { exact: true }).first().waitFor();
      assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
      for (const [locator, value] of fields) {
        assert.equal(await locator.inputValue(), value);
        assert.equal(await locator.isDisabled(), true);
      }
      assert.equal(await current.getByRole("checkbox").isChecked(), true);
      assert.equal(await current.getByRole("checkbox").isDisabled(), true);
      assert.equal(await save.isDisabled(), false);
      assert.deepEqual(company, base);
      await page
        .getByText(errorText, { exact: true })
        .first()
        .waitFor({ state: "hidden", timeout: 15000 });
    }
  }
  await rejected(
    form,
    retained,
    ["missing", "quote", "document", "order", "hash", "digest", "nonce"],
    "기준 버전 저장",
    original,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.screenshot({ path: path.join(output, "criteria-receipt-mobile.png") });
  patchMode = "exact";
  await form.getByRole("button", { name: "같은 내용으로 저장 확인", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  await panel
    .getByRole("heading", { name: "새 참고 기준 · v2 · 변경 수기", exact: true })
    .waitFor();
  assert.deepEqual(company.criteriaVersions[0], original.criteriaVersions[0]);
  assert.deepEqual(company.applicationCriteriaBindings, original.applicationCriteriaBindings);
  assert.equal(
    company.applicationCriteriaContexts.find((v) => v.applicationId === original.applications[1].id)
      .context.status,
    "needs-review",
  );
  await panel.getByText("이 기준의 과거 버전 보기", { exact: true }).click();
  const prior = panel.locator("#criteria-version-" + fixture.linkId(511));
  await prior.waitFor();
  await prior.getByText("기입 출처 1: 이전 출처", { exact: true }).click();
  assert.ok((await prior.innerText()).includes("이전 원문 인용"));
  record(
    "seven mismatched criteria receipts rejected; raw source/document conditions retained; exact v2 preserves v1 and prior explicit pin",
  );
  await page.getByText("저장했습니다.", { exact: true }).waitFor({ state: "hidden" });
  pinBase = structuredClone(company);
  await panel.getByRole("button", { name: "회차에 기준 버전 연결", exact: true }).click();
  const pinForm = panel.getByRole("region", { name: "회차 기준 연결 편집", exact: true });
  const pinRaw = fixture.criteriaReceiptPin(pinBase, fixture.linkId(532));
  const pinFields = [
    ["신청 회차의 현재 정보 *", pinRaw.applicationId],
    ["연결할 정확한 기준 버전 *", pinRaw.criteriaVersionId],
    ["기록 담당자 *", pinRaw.recordedBy],
    ["기록·정정·연결 이유 *", pinRaw.reason],
  ];
  const pinRetained = [];
  for (const [label, value] of pinFields) {
    const locator = pinForm.getByLabel(label, { exact: true });
    if (label.startsWith("신청") || label.startsWith("연결할")) await locator.selectOption(value);
    else await locator.fill(value);
    pinRetained.push([locator, value]);
  }
  await pinForm.getByRole("checkbox").check();
  await rejected(
    pinForm,
    pinRetained,
    ["missing", "version", "application", "snapshot", "summary", "digest", "nonce"],
    "선택한 기준 버전을 회차에 연결",
    pinBase,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await panel.screenshot({ path: path.join(output, "criteria-pin-receipt-mobile.png") });
  patchMode = "exact";
  await pinForm.getByRole("button", { name: "같은 내용으로 저장 확인", exact: true }).click();
  await pinForm.waitFor({ state: "hidden" });
  await panel
    .getByRole("heading", { name: "회차 기준 연결 v2 · 새 참고 기준 · 기준 v2", exact: true })
    .waitFor();
  const accepted = company.applicationCriteriaBindings.at(-1);
  assert.equal(accepted.applicationId, original.applications[1].id);
  assert.equal(accepted.criteriaVersionId, fixture.linkId(532));
  assert.equal(accepted.officialVerification, "unverified");
  assert.deepEqual(company.applicationCriteriaBindings[0], original.applicationCriteriaBindings[0]);
  assert.equal(
    company.applicationCriteriaContexts.find((v) => v.applicationId === accepted.applicationId)
      .context.status,
    "pinned-unverified",
  );
  record(
    "seven mismatched pin receipts rejected with locked selections/confirmation intact; exact v2 pins selected criteria to second application only",
  );
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  await panel
    .getByRole("heading", { name: "회차 기준 연결 v2 · 새 참고 기준 · 기준 v2", exact: true })
    .waitFor();
  assert.equal(commands.length, 16);
  assert.equal(caseReads, 1);
  assert.notEqual(commands[0].clientRequestId, commands[8].clientRequestId);
  for (const key of Object.keys(original)) {
    if (
      [
        "revision",
        "updatedAt",
        "criteriaVersions",
        "applicationCriteriaBindings",
        "applicationCriteriaContexts",
      ].includes(key)
    )
      continue;
    assert.deepEqual(company[key], original[key]);
  }
  record(
    "both exact saved records survive tab roundtrip; company, applications, plans and agency history unchanged; no URL retrieval, export or automatic retry",
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
          "Criteria and application pin responses are synthetic memory only; sources/conditions are manual test input. No URL retrieval, download, official verification, AI, API, SQL or institution execution",
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
