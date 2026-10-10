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
const scenario = "agency-record-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/agency-records.tsx",
  "src/components/studio/agency-record-response.ts",
  "scripts/fixtures/agency-record-receipt.ts",
  "scripts/agency-record-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-agency-record-receipt-ui-"));
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
let company = fixture.agencyReceiptCompany();
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
const title = "  원래 요청 제목  ",
  body = "  원래 요청 첫 문장\n둘째 문장  ",
  note = "  원래 보관 메모\n둘째 줄  ",
  correctedBody = "  통보 정정 원문\n다음 줄  ";
let caseReads = 0,
  patchMode = "body",
  created,
  corrected;
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
        assert.ok(commands.length <= 6);
        assert.equal(command.action, "append-agency-record");
        if (command.record.kind === "request") {
          assert.equal(command.record.title, title.trim());
          assert.equal(command.record.body, body.trim());
          assert.equal(command.record.note, note);
          assert.equal(command.record.institution, "합성 평가기관");
          assert.equal(command.record.dueOn, "2026-10-25");
          assert.deepEqual(command.record.sourceIds, []);
          if (commands.length > 1) assert.deepEqual(command, commands[0]);
          created ??= fixture.agencyReceiptResult(original, command);
          if (patchMode !== "exact") {
            const wrong = structuredClone(created);
            if (patchMode === "body") wrong.agencyRecords.at(-1).body = "다른 요청 원문";
            else wrong.agencyRecords.at(-1).dueOn = "2026-10-26";
            return reply(wrong);
          }
          company = structuredClone(created);
        } else {
          assert.equal(command.record.kind, "notice-correction");
          assert.equal(command.record.body, correctedBody.trim());
          assert.equal(command.record.noticeRecordId, original.agencyRecords[0].id);
          assert.equal(command.record.previousVersionId, original.agencyRecords[1].id);
          if (commands.length > 4) assert.deepEqual(command, commands[3]);
          corrected ??= fixture.agencyReceiptResult(created, command, fixture.agencyId(4));
          if (patchMode !== "exact") {
            const wrong = structuredClone(corrected);
            if (patchMode === "parent")
              wrong.agencyRecords.at(-1).previousVersionId = original.agencyRecords[0].id;
            else wrong.agencyRecords.at(-1).details.receiptNumber = "다른 접수번호";
            return reply(wrong);
          }
          company = structuredClone(corrected);
        }
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
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const history = () =>
    page.getByRole("region", { name: "기관 요청·답변·통보와 원본 증빙", exact: true });
  await history().getByRole("button", { name: "기관 요청 기록 추가", exact: true }).click();
  let editor = history()
    .locator("fieldset")
    .filter({ has: page.getByRole("heading", { name: "새 기관 요청 기록", exact: true }) })
    .first();
  await editor.getByLabel("기록 제목 *", { exact: true }).fill(title);
  await editor.getByLabel("기관명 *", { exact: true }).fill("합성 평가기관");
  await editor.getByLabel("담당자 기입 기한 (선택)", { exact: true }).fill("2026-10-25");
  await editor.getByLabel("요청 원문·정정 내용 *", { exact: true }).fill(body);
  await editor.getByLabel("기록·정정 근거 메모", { exact: true }).fill(note);
  await editor.getByRole("button", { name: "로컬 기록 저장", exact: true }).click();
  const retry = () => editor.getByRole("button", { name: "같은 내용으로 저장 확인", exact: true });
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(
    await editor.getByLabel("요청 원문·정정 내용 *", { exact: true }).inputValue(),
    body,
  );
  assert.equal(await editor.getByLabel("기록 제목 *", { exact: true }).inputValue(), title);
  assert.equal(await editor.getByLabel("기록·정정 근거 메모", { exact: true }).inputValue(), note);
  assert.equal(await editor.getByLabel("기록 제목 *", { exact: true }).isDisabled(), true);
  assert.equal(await retry().isDisabled(), false);
  patchMode = "due";
  await retry().click();
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(
    await editor.getByLabel("담당자 기입 기한 (선택)", { exact: true }).inputValue(),
    "2026-10-25",
  );
  assert.deepEqual(commands[1], commands[0]);
  record(
    "different request text and due date are rejected before acceptance; raw title/body/note and the original request remain, fields lock and explicit retry stays available",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await editor.screenshot({ path: path.join(output, "agency-record-receipt-mobile.png") });
  patchMode = "exact";
  await retry().click();
  await editor.waitFor({ state: "hidden" });
  await history().getByText("원래 요청 제목 · 합성 평가기관 · 요청 v1", { exact: true }).waitFor();
  assert.deepEqual(commands[2], commands[0]);
  record(
    "exact request receipt closes only after explicit same-request confirmation while preserving institutional stage and earlier notice versions",
  );
  await page
    .getByText("저장했습니다.", { exact: true })
    .waitFor({ state: "hidden", timeout: 15000 });
  await history().getByRole("button", { name: "통보 정정 기록 추가", exact: true }).click();
  editor = history()
    .locator("fieldset")
    .filter({ has: page.getByRole("heading", { name: "통보 정정 기록 추가", exact: true }) })
    .first();
  await editor.getByLabel("통보 원문·정정 내용 *", { exact: true }).fill(correctedBody);
  patchMode = "parent";
  await editor.getByRole("button", { name: "로컬 기록 저장", exact: true }).click();
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(
    await editor.getByLabel("통보 원문·정정 내용 *", { exact: true }).inputValue(),
    correctedBody,
  );
  patchMode = "details";
  await retry().click();
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  patchMode = "exact";
  await retry().click();
  await editor.waitFor({ state: "hidden" });
  assert.deepEqual(commands[4], commands[3]);
  assert.deepEqual(commands[5], commands[3]);
  assert.notEqual(commands[0].clientRequestId, commands[3].clientRequestId);
  assert.equal(commands.length, 6);
  assert.equal(caseReads, 1);
  assert.deepEqual(company.agencyRecords.slice(0, -2), original.agencyRecords);
  for (const key of ["applications", "applicationEvents", "plans", "sources", "tasks", "stage"])
    assert.deepEqual(company[key], original[key]);
  assert.equal(company.agencyRecords.at(-1).version, 3);
  record(
    "wrong notice correction parent and receipt detail are rejected; exact original correction is accepted without rewriting prior notices, manuscripts, tasks or application history",
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
          "agency request/notice correction receipts are synthetic memory responses; explicit retries only, no real API, SQL or institution execution",
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
