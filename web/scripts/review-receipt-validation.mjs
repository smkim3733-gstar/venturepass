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
const scenario = "review-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/plan-review-decisions.tsx",
  "src/components/studio/guided-plan-review.tsx",
  "scripts/fixtures/guided-review-link.ts",
  "scripts/review-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-review-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-review-link.ts"),
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
const company = fixture.reviewLinkCompany();
company.profile.companyName = "합성 검토 판단 응답 기업";
const companies = [company],
  original = structuredClone(company),
  name = company.profile.companyName;
let replyMode = "missing";
let caseReads = 0;
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
        assert.equal(command.action, "append-plan-review");
        assert.equal(command.revision, original.revision);
        const plan = original.plans.at(-1);
        assert.equal(command.decision.planId, plan.id);
        assert.equal(command.decision.planVersion, plan.version);
        assert.deepEqual(command.decision.finding, plan.review[2]);
        const next = structuredClone(original);
        next.revision += 1;
        const id = "f0000000-0000-4000-8000-000000000001";
        if (replyMode !== "missing")
          next.planReviewDecisions.push({
            ...command.decision,
            id,
            rootId: id,
            version: 1,
            clientRequestId:
              replyMode === "nonce"
                ? "f0000000-0000-4000-8000-000000000002"
                : command.clientRequestId,
            reason: replyMode === "reason" ? "잘못된 응답의 다른 판단" : command.decision.reason,
            inputDigest: "a".repeat(64),
            recordedAt: "2026-10-10T00:10:00.000Z",
            origin: "manual",
            reviewKey: "b".repeat(64),
            planContentSha256: "c".repeat(64),
            findingSha256: "d".repeat(64),
            planSourceRevision: plan.sourceRevision,
            evidenceRevision: original.revision,
            evidenceFingerprint: "e".repeat(64),
            stale: true,
            staleReasons: ["plan-evidence-outdated"],
          });
        if (replyMode === "exact") Object.assign(company, next);
        return reply(next);
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
  await page.getByRole("button", { name: "의견 3: 동일한 근거 대조 의견", exact: true }).waitFor();
  await page.getByRole("button", { name: "의견 3: 동일한 근거 대조 의견", exact: true }).click();
  const panel = page.getByRole("region", { name: "검토 의견 처리 이력", exact: true });
  const reviewer = page.getByLabel("판단 담당자 *", { exact: true });
  const reason = page.getByLabel("확인한 내용과 판단 이유 *", { exact: true });
  const save = page.getByRole("button", { name: "검토 판단 이력 저장", exact: true });
  const originalReason = "  원래 근거를 확인하기 전까지\n담당자 판단을 보류합니다.  ";
  const originalReviewer = "  합성 검토 담당자  ";
  assert.equal(
    await page.getByLabel("판단할 검토 의견 직접 선택", { exact: true }).inputValue(),
    "2",
  );
  await page.getByLabel("처리 상태", { exact: true }).selectOption("deferred");
  await reviewer.fill(originalReviewer);
  await reason.fill(originalReason);

  async function rejectSave(mode, count) {
    replyMode = mode;
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PATCH"),
      save.click(),
    ]);
    await page.waitForFunction(
      () =>
        !!document.querySelector("#plan-review-reviewer") &&
        !document.querySelector("#plan-review-reviewer").matches(":disabled"),
    );
    // Wait for the specific response cycle, not an arbitrary delay.
    await page
      .getByText(
        "저장 결과를 확인하지 못했습니다. 작성 내용을 유지했습니다. 최신 이력을 확인해 주세요.",
        { exact: true },
      )
      .waitFor();
    assert.equal(commands.length, count);
    assert.equal(await page.locator('[data-sonner-toast][data-type="success"]').count(), 0);
    assert.equal(await reviewer.inputValue(), originalReviewer);
    assert.equal(await reason.inputValue(), originalReason);
    assert.equal(await save.isEnabled(), true);
    assert.equal(await page.getByLabel("처리 상태", { exact: true }).inputValue(), "deferred");
    assert.ok(!(await panel.innerText()).includes("잘못된 응답의 다른 판단"));
    assert.equal(await page.getByText("원고 v2의 판단 이력 1개", { exact: true }).count(), 0);
    assert.deepEqual(company, original);
    assert.equal(caseReads, 1);
  }
  await rejectSave("missing", 1);
  record(
    "missing judgement response is rejected before parent update or success notification; original reason, reviewer, opinion and request remain available",
  );

  await rejectSave("reason", 2);
  await rejectSave("nonce", 3);
  for (const command of commands.slice(1)) assert.deepEqual(command, commands[0]);
  assert.equal(commands[0].decision.reason, originalReason.trim());
  assert.equal(commands[0].decision.reviewer, originalReviewer.trim());
  assert.equal(commands[0].decision.findingIndex, 2);
  assert.deepEqual(commands[0].decision.finding, original.plans.at(-1).review[2]);
  assert.equal(commands[0].revision, original.revision);
  await page.setViewportSize({ width: 390, height: 844 });
  await reason.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "review-receipt-mobile.png"), fullPage: true });
  record(
    "different reason and request identifier are rejected on explicit unchanged retries; raw inputs and original request survive on mobile",
  );

  replyMode = "exact";
  await save.click();
  await page.getByText("원고 v2의 판단 이력 1개", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("#plan-review-reviewer"));
  assert.equal(commands.length, 4);
  for (const command of commands.slice(1)) assert.deepEqual(command, commands[0]);
  assert.equal(await page.locator('[data-sonner-toast][data-type="success"]').count(), 1);
  assert.deepEqual(company.plans, original.plans);
  assert.deepEqual(company.sources, original.sources);
  assert.deepEqual(company.analysis, original.analysis);
  assert.equal(company.planReviewDecisions.length, 1);
  assert.equal(company.plans.at(-1).confirmedAt, null);
  await page.getByRole("button", { name: "원고로 돌아가기", exact: true }).click();
  const summary = page.getByLabel("의견 3의 최근 담당자 판단", { exact: true });
  assert.ok((await summary.innerText()).includes("최근 수동 판단: 보류"));
  assert.ok((await summary.innerText()).includes("합성 검토 담당자"));
  assert.ok((await summary.innerText()).includes("재검토 필요"));
  assert.ok(
    (await page.getByLabel("의견 2의 최근 담당자 판단", { exact: true }).innerText()).includes(
      "담당자 판단 미기록",
    ),
  );
  assert.ok(
    (await page.getByRole("region", { name: "현재 원고와 검토 상태" }).innerText()).includes(
      "전체 검토 미완료",
    ),
  );
  assert.equal(caseReads, 1);
  record(
    "only the exact original judgement is accepted on explicit retry; one manual record appears at its original opinion without confirming or altering the manuscript",
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
          "manual judgement acknowledgement before parent state acceptance; in-memory responses and explicit same-request retries only, no AI",
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
