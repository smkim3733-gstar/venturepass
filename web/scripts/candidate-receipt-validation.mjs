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
const scenario = "candidate-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/candidate-selection.tsx",
  "scripts/fixtures/guided-first-draft.ts",
  "scripts/candidate-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-candidate-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-first-draft.ts"),
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
  assert.deepEqual(chunk.imports, ["node:crypto"]);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
let company = fixture.firstDraftCompany();
company.profile.technologySummary = fixture.description;
company.revision = 2;
const candidate = {
  id: "synthetic-choice-a",
  title: "합성 설비 상태 확인",
  problem: "설비 점검의 어려움",
  solution: fixture.description,
  targetCustomer: "합성 제조사",
  differentiation: "확인 필요",
  stage: "구상",
  businessModel: "검토 필요",
  recommendation: "회사 설명과 연결된 후보",
  evidence: [{ sourceId: "profile", quote: fixture.description, locator: "technologySummary" }],
  gaps: ["시험 근거 확인"],
};
company.analysis = {
  summary: "합성 후보 비교",
  facts: [],
  candidates: [candidate, { ...candidate, id: "synthetic-choice-b", title: "합성 점검 기록 관리" }],
  questions: [],
  warnings: [],
  generatedAt: company.updatedAt,
  sourceRevision: 1,
  mode: "assisted",
};
const original = structuredClone(company),
  name = company.profile.companyName,
  caseId = company.id;
const edited = "  기존 인력으로 설비 상태를 설명할 수 있습니다.\n시험 근거는 추가 확인합니다.  ";
let saved,
  patchMode = "different-latest",
  caseReads = 0,
  intakeReads = 0,
  preparationReads = 0;
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
      const root = "/api/studio/cases/" + caseId;
      if (req.method() === "GET") {
        if (u.pathname === "/api/studio/status")
          return reply({
            aiConfigured: true,
            model: fixture.model,
            storage: "local",
            supportedFiles: [],
          });
        if (u.pathname === "/api/studio/cases")
          return reply({
            cases: [
              {
                id: caseId,
                companyName: name,
                industry: "",
                stage: company.stage,
                revision: company.revision,
                createdAt: company.createdAt,
                updatedAt: company.updatedAt,
                sourceCount: company.sources.length,
                planCount: company.plans.length,
                pendingTaskCount: 0,
              },
            ],
          });
        if (u.pathname === root) {
          caseReads++;
          return reply(company);
        }
        if (u.pathname === root + "/plan-supplements/execution")
          return reply({
            company,
            active: false,
            retainedCapture: false,
            executions: [],
            transmissionAllowed: false,
          });
        if (u.pathname === root + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        if (u.pathname === root + "/preparation-automation")
          return reply({ company, active: false });
        if (u.pathname === root + "/guided-preparation") {
          preparationReads++;
          return reply(fixture.status(company));
        }
      }
      if (req.method() === "PATCH" && u.pathname === root) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.ok(commands.length <= 2, "Only the two explicit attempts may send PATCH");
        assert.equal(command.action, "select-candidate");
        assert.equal(command.revision, original.revision);
        assert.equal(command.candidateId, candidate.id);
        assert.equal(command.reason, edited.trim());
        assert.equal(command.expectedSelectedCandidateId, null);
        if (commands.length === 2)
          assert.deepEqual(
            command,
            commands[0],
            "Explicit recovery must retain the complete original request",
          );
        saved = fixture.select(original, command);
        if (patchMode === "different-latest") {
          const wrong = structuredClone(saved);
          wrong.candidateSelections.push({
            ...wrong.candidateSelections[0],
            clientRequestId: "99999999-9999-4999-8999-999999999999",
            reason: "다른 요청의 이유",
          });
          return reply(wrong);
        }
        company = structuredClone(saved);
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
  await page.getByRole("tab", { name: /아이템 분석/ }).click();
  await page.getByRole("heading", { name: "우리 기업에 맞는 신청 아이템", exact: true }).waitFor();
  const panel = page.getByRole("tabpanel");
  const target = panel
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: candidate.title, exact: true }) })
    .first();
  await target.getByRole("button", { name: "이유를 적고 아이템 선택", exact: true }).click();
  const input = page.getByLabel("직접 선택한 이유 또는 정정 사유 *", { exact: true });
  await input.fill(edited);
  await page.getByRole("button", { name: "이유와 함께 이 아이템 선택", exact: true }).click();
  const inspect = page.getByRole("button", { name: "같은 요청으로 저장 결과 확인", exact: true });
  await inspect.waitFor();
  assert.equal(await input.inputValue(), edited);
  assert.equal(await input.isDisabled(), true);
  assert.equal(
    await page.getByText("다른 요청의 이유", { exact: true }).count(),
    0,
    "A rejected receipt must not replace company history",
  );
  assert.equal(
    await page.getByText("저장했습니다.", { exact: true }).count(),
    0,
    "No success notification for another latest request",
  );
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 1);
  assert.equal(
    await target.getByRole("button", { name: "이유를 적고 아이템 선택", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "자료 다시 분석", exact: true }).isDisabled(),
    true,
  );
  record(
    "different latest request sharing the original record ID is rejected before company acceptance or success notice; editor reason and original request are retained",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await inspect.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, "candidate-receipt-mobile.png"),
    fullPage: true,
  });
  patchMode = "exact";
  await inspect.click();
  await page.getByRole("button", { name: "선택 이유 추가·정정", exact: true }).waitFor();
  assert.equal(await input.count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "선택한 아이템으로 사업계획서 작성", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(commands.length, 2);
  assert.equal(caseReads, 1);
  assert.equal(company.candidateSelections.length, 1);
  assert.equal(company.candidateSelections[0].clientRequestId, commands[0].clientRequestId);
  assert.equal(company.candidateSelections[0].reason, edited.trim());
  assert.deepEqual(company.analysis, original.analysis);
  assert.deepEqual(company.sources, original.sources);
  assert.deepEqual(company.plans, original.plans);
  record(
    "explicit retry retains identical nonce/revision/candidate/reason, exact original receipt alone closes the editor; no automatic retry or AI execution",
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
        syntheticPreparationReads: preparationReads,
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "memory-only detailed selection receipt; existing explicit same-request retry, no actual storage or AI execution",
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
