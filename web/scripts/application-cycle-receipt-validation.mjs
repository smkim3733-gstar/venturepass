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
const scenario = "cycle-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/application-history.tsx",
  "src/components/studio/application-cycle-response.ts",
  "scripts/fixtures/guided-submission-read.ts",
  "scripts/application-cycle-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-cycle-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-submission-read.ts"),
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
let company = fixture.submissionReadCompany();
company.profile.companyName = "합성 회차 저장 확인 기업";
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
const cycleTitle = "  합성 새 회차  ",
  criteria = "  기준 문구 첫 줄\n기준 문구 둘째 줄  ",
  correctedTitle = "  합성 회차 정정  ";
let caseReads = 0,
  patchMode = "missing",
  created,
  corrected;
function saveCycle(base, command) {
  const next = structuredClone(base);
  const { revision, clientRequestId, ...canonical } = command;
  assert.equal(revision, base.revision);
  const receipt = {
    id: crypto.randomUUID(),
    clientRequestId,
    inputDigest: sha(JSON.stringify(canonical)),
    recordedAt: "2026-10-10T09:00:00.000Z",
    origin: "manual",
  };
  const details = {
    title: command.title,
    kind: command.kind,
    plannedOn: command.plannedOn,
    criteriaNote: command.criteriaNote,
    previousApplicationId: command.previousApplicationId,
  };
  if (command.action === "create-application")
    next.applications.push({
      ...receipt,
      ...details,
      companyAtCreation: {
        companyName: base.profile.companyName,
        businessNumber: base.profile.businessNumber,
      },
    });
  else
    next.applicationEvents.push({
      ...receipt,
      kind: "cycle-correction",
      applicationId: command.applicationId,
      previousVersionId: command.previousVersionId,
      details,
    });
  next.revision++;
  return next;
}
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
        assert.ok(commands.length <= 5);
        if (command.action === "create-application") {
          assert.equal(command.title, cycleTitle.trim());
          assert.equal(command.criteriaNote, criteria);
          assert.equal(command.kind, "renewal");
          assert.equal(command.plannedOn, "2026-10-25");
          assert.equal(command.previousApplicationId, original.applications[0].id);
          if (commands.length > 1) assert.deepEqual(command, commands[0]);
          created ??= saveCycle(original, command);
          if (patchMode === "missing")
            return reply({ ...original, revision: original.revision + 1 });
          if (patchMode === "title") {
            const wrong = structuredClone(created);
            wrong.applications.at(-1).title = "다른 요청 내용";
            return reply(wrong);
          }
          company = structuredClone(created);
        } else {
          assert.equal(command.action, "correct-application");
          assert.equal(command.title, correctedTitle.trim());
          assert.equal(command.applicationId, created.applications.at(-1).id);
          assert.equal(command.previousVersionId, created.applications.at(-1).id);
          if (commands.length === 5) assert.deepEqual(command, commands[3]);
          corrected ??= saveCycle(created, command);
          if (patchMode === "parent") {
            const wrong = structuredClone(corrected);
            wrong.applicationEvents.at(-1).previousVersionId = original.applications[0].id;
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
  const history = () => page.getByRole("region", { name: "신청 회차·제출 당시 이력", exact: true });
  await history().getByRole("button", { name: "신청 회차 등록", exact: true }).click();
  let editor = history().getByRole("region", { name: "신청 회차 등록", exact: true });
  await editor.getByLabel("회차 이름 *", { exact: true }).fill(cycleTitle);
  await editor.getByLabel("담당자 확인 구분", { exact: true }).selectOption("renewal");
  await editor.getByLabel("신청 예정일 (선택)", { exact: true }).fill("2026-10-25");
  await editor
    .getByLabel("이전 신청 회차 (선택)", { exact: true })
    .selectOption(original.applications[0].id);
  await editor.getByLabel("적용 기준·기준일 메모 (선택)", { exact: true }).fill(criteria);
  await editor.getByRole("button", { name: "담당자 기록 저장", exact: true }).click();
  const retry = () => editor.getByRole("button", { name: "같은 내용으로 저장 확인", exact: true });
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(await editor.getByLabel("회차 이름 *", { exact: true }).inputValue(), cycleTitle);
  assert.equal(
    await editor.getByLabel("적용 기준·기준일 메모 (선택)", { exact: true }).inputValue(),
    criteria,
  );
  assert.equal(await editor.getByLabel("회차 이름 *", { exact: true }).isDisabled(), true);
  assert.equal(await retry().isDisabled(), false);
  patchMode = "title";
  await retry().click();
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(await editor.getByLabel("회차 이름 *", { exact: true }).inputValue(), cycleTitle);
  assert.equal(
    await history().getByRole("heading", { name: "다른 요청 내용", exact: true }).count(),
    0,
  );
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
  record(
    "missing receipt and same-request different title are rejected before company acceptance/success, retaining original title/memo and an enabled explicit same-request retry",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await editor.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await editor.screenshot({ path: path.join(output, "cycle-receipt-mobile.png") });
  patchMode = "exact";
  await retry().click();
  await history().getByRole("heading", { name: cycleTitle.trim(), exact: true }).waitFor();
  assert.equal(await editor.count(), 0);
  assert.deepEqual(commands[2], commands[0]);
  assert.deepEqual(company.plans, original.plans);
  assert.deepEqual(company.applicationEvents, original.applicationEvents);
  assert.deepEqual(company.applications.slice(0, -1), original.applications);
  record(
    "exact create receipt closes the editor only after explicit retry, keeping the same request and all pre-existing cycles/events/manuscripts",
  );

  // Clear only old success notifications by waiting for their disappearance before the second command.
  await page
    .getByText("저장했습니다.", { exact: true })
    .waitFor({ state: "hidden", timeout: 15000 });
  const cycle = history().locator(
    'article[id="application-cycle-' + created.applications.at(-1).id + '"]',
  );
  await cycle.getByRole("button", { name: "회차 정보 정정", exact: true }).click();
  editor = history().getByRole("region", { name: "회차 정보 정정", exact: true });
  await editor.getByLabel("회차 이름 *", { exact: true }).fill(correctedTitle);
  patchMode = "parent";
  await editor.getByRole("button", { name: "담당자 기록 저장", exact: true }).click();
  await retry().waitFor();
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(
    await editor.getByLabel("회차 이름 *", { exact: true }).inputValue(),
    correctedTitle,
  );
  assert.equal(
    await history().getByRole("heading", { name: cycleTitle.trim(), exact: true }).count(),
    1,
  );
  patchMode = "exact";
  await retry().click();
  await history().getByRole("heading", { name: correctedTitle.trim(), exact: true }).waitFor();
  assert.equal(await editor.count(), 0);
  assert.deepEqual(commands[4], commands[3]);
  assert.notEqual(commands[0].clientRequestId, commands[3].clientRequestId);
  assert.deepEqual(company.applications, created.applications);
  assert.deepEqual(company.applicationEvents.slice(0, -1), original.applicationEvents);
  assert.deepEqual(company.plans, original.plans);
  assert.deepEqual(company.sources, original.sources);
  assert.equal(company.stage, original.stage);
  assert.equal(commands.length, 5);
  assert.equal(caseReads, 1);
  record(
    "correction with a different parent version is rejected; exact explicit retry accepts the original correction while preserving prior submission history, current manuscript and institutional stage",
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
          "cycle create/correction receipts are synthetic memory responses; explicit retries only, no real API, SQL or institution execution",
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
