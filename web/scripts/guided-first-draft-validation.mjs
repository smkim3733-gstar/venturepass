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
assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-description-save.ts",
  "src/components/studio/guided-evidence-selection.tsx",
  "src/components/studio/guided-evidence-selection-state.ts",
  "src/components/studio/guided-preparation-ui.ts",
  "src/lib/studio-guided-preparation-types.ts",
  "src/lib/studio-guided-preparation-state.ts",
  "src/lib/studio-candidate-selection.ts",
])
  assert.equal(sha(await readFile(path.join(app, file))), sha(await readFile(path.join(staging, file))));
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-first-draft-ui-"));
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
const name = company.profile.companyName,
  caseId = company.id;
const network = [];
const previews = [];
let rejectFirstDescription = true;
const commands = [],
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
              stage: "preparing",
              revision: company.revision,
              createdAt: company.createdAt,
              updatedAt: company.updatedAt,
              sourceCount: company.sources.length,
              planCount: company.plans.length,
              pendingTaskCount: 0,
            },
          ],
        });
      if (u.pathname === root) return reply(company);
      if (u.pathname === root + "/source-intakes") return reply({ company, activeItemIds: [] });

      if (u.pathname === root + "/guided-preparation") return reply(fixture.status(company));
    }
    if (req.method() === "PATCH" && u.pathname === root) {
      const command = req.postDataJSON();
      commands.push(command);
      assert.equal(command.revision, company.revision);
      if (command.action === "profile") {
        assert.equal(company.revision, 0);
        assert.equal(command.profile.technologySummary, fixture.description);
        if (rejectFirstDescription) {
          rejectFirstDescription = false;
          return reply(company); // Schema-valid old response must not close the typed description.
        }
        company = { ...company, profile: command.profile, revision: 1,
          updatedAt: "2026-10-09T11:30:01.000Z" };
      } else if (command.action === "select-candidate") {
        assert.equal(company.plans.length, 0);
        company = fixture.select(company, command);
      } else throw Error("Unexpected synthetic mutation");
      return reply(company);
    }
    if (req.method() === "POST" && u.pathname === root + "/guided-preparation/preview") {
      const command = req.postDataJSON();
      previews.push(structuredClone(command));
      return reply(fixture.preview(company, command));
    }
    if (req.method() === "POST" && u.pathname === root + "/guided-preparation") {
      const command = req.postDataJSON();
      commands.push(command);
      assert.ok(["start", "continue"].includes(command.action));
      const result = fixture.prepare(company, command);
      company = result.company;
      return reply(result);
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
  await page.getByRole("button", { name: "자료 없이 회사 설명부터 시작", exact: true }).click();
  await page.getByLabel("현재 제공하는 서비스·기술과 고객", { exact: true }).fill(fixture.description);
  assert.equal(commands.length, 0);
  assert.deepEqual(company.sources, []);
  assert.deepEqual(company.plans, []);
  await page.getByRole("button", { name: "이 설명으로 시작하기", exact: true }).click();
  await page.getByRole("alert").filter({hasText:"입력한 회사 설명의 저장 응답을 확인하지 못했습니다."}).waitFor();
  assert.equal(await page.getByLabel("현재 제공하는 서비스·기술과 고객", {exact:true}).inputValue(), fixture.description);
  assert.equal(company.revision, 0);
  assert.equal(previews.length, 0);
  assert.deepEqual(commands.map(c=>c.action), ["profile"]);
  assert.equal(await page.getByRole("dialog").count(), 0);
  record("old profile acknowledgment retains the complete typed description and blocks preparation");
  await page.getByRole("button", { name: "이 설명으로 시작하기", exact: true }).click();
  const scope = page.getByRole("dialog", { name: "AI에 사용할 자료 선택", exact: true });
  await scope.waitFor();
  assert.equal(company.revision, 1);
  assert.equal(company.profile.technologySummary, fixture.description);
  assert.deepEqual(commands.map(c => c.action), ["profile", "profile"]);
  assert.ok((await scope.innerText()).includes("선택 0개"));
  assert.ok((await scope.innerText()).includes("0개를 선택하면 회사 설명만 사용합니다"));
  await scope.getByRole("button", { name: "선택 범위 확인", exact: true }).click();
  const approval = page.getByRole("dialog", { name: "이 자료로 AI가 계획서를 준비할까요?", exact: true });
  await approval.waitFor();
  assert.deepEqual(commands.map(c => c.action), ["profile", "profile"]);
  assert.ok((await approval.innerText()).includes("전송할 자료 0개 확인"));
  assert.ok((await approval.innerText()).includes("회사 설명·기업정보"));
  assert.deepEqual(company.plans, []);
  record("no attachments or manuscripts; saved description reaches zero-source preview and separate explicit consent");

  await approval.getByRole("button", { name: "허용하고 AI 준비 시작", exact: true }).click();
  await page.getByRole("heading", { name: "이 방향으로 계획서를 준비할까요?", exact: true }).waitFor();
  assert.equal(company.revision, 3);
  assert.deepEqual(company.plans, []);
  assert.equal(company.selectedCandidateId, null);
  const run = structuredClone(company.guidedPreparationRuns[0]);
  assert.equal(run.status, "awaiting_choice");
  assert.deepEqual(run.approval.sourceIds, []);
  assert.equal(run.approval.revision, 1);
  assert.equal(run.approval.profileIncluded, true);
  assert.equal(run.approval.businessNumberIncluded, false);
  assert.equal(await page.getByRole("button", { name: "이 주제로 작성", exact: true }).isDisabled(), true);
  record("explicit start carries the exact saved description approval; analysis waits for a manual topic choice");

  await page.getByLabel("이 주제가 우리 회사에 맞는 이유를 한 문장으로 알려 주세요", { exact: true })
    .fill("설명한 센서 기술의 계획을 정리하되 아직 없는 실적은 확인 필요로 남기기 위해 선택합니다.");
  await page.getByRole("button", { name: "이 주제로 작성", exact: true }).click();
  const overview = page.getByRole("region", { name: "현재 원고와 검토 상태", exact: true });
  await overview.waitFor();
  assert.equal(company.revision, 7);
  assert.equal(company.plans.length, 1);
  assert.equal(company.plans[0].version, 1);
  assert.equal(company.candidateSelections.length, 1);
  assert.equal(company.guidedPreparationRuns[0].id, run.id);
  assert.deepEqual(company.guidedPreparationRuns[0].approval, run.approval);
  assert.equal(company.guidedPreparationRuns[0].requests.length, 2);
  assert.equal(company.guidedPreparationRuns[0].planId, company.plans[0].id);
  assert.equal(company.plans[0].candidateId, company.candidateSelections[0].candidateId);
  assert.deepEqual(company.sources, []);
  assert.equal(company.profile.technologySummary, fixture.description);
  assert.ok((await overview.innerText()).includes("항목 확인 필요 10개"));
  assert.ok((await overview.innerText()).includes("전체 검토 미완료"));
  assert.equal(company.plans[0].confirmedAt, null);
  assert.ok(company.plans[0].content.sections.every(s => s.needsConfirmation &&
    s.evidence.every(e => e.sourceId === "profile" && e.quote === fixture.description)));
  const download = overview.getByRole("link", { name: "원고 v1 Word 내려받기", exact: true });
  await download.waitFor();
  assert.equal(new URL(await download.getAttribute("href"), origin).searchParams.get("planId"), company.plans[0].id);
  assert.equal(await page.getByRole("button", { name: "검토 마치고 신청 준비", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "저장 상태 확인", exact: true }).count(), 0);
  record("manual topic and original run continue to first v1; profile citations and unconfirmed review remain");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.waitForFunction(() => [...document.querySelectorAll("[data-sonner-toast]")].every(n => n.getAttribute("data-visible") !== "true"));
  await page.screenshot({ path: path.join(output, "first-draft-mobile.png"), fullPage: true });
  assert.deepEqual(commands.map(c => c.action), ["profile", "profile", "start", "select-candidate", "continue"]);
  assert.deepEqual(previews.map(p => p.sourceIds), previews.map(() => []));
  assert.deepEqual([...new Set(previews.map(p => p.revision))], [1, 3, 7]);
  assert.equal(previews.filter(p => p.revision === 1).length, 1);
  assert.deepEqual(commands[2].approval, run.approval);
  assert.equal(commands[4].runId, run.id);
  record("same mounted company displays mobile v1 and its download link without extra preparation or automatic confirmation");
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
        syntheticApiCommands: commands.length,
        syntheticExports: 0,
        syntheticScopePreviews: previews,
        continuousJourneys: 1,
        startingState:
          "one synthetic company, no description, sources, analysis or manuscripts; actual writers and provider never executed",
        commandActions: commands.map((c) => c.action),
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
  await writeFile(path.join(output, "cleanup.json"), JSON.stringify({
    childStopped: !child || child.exitCode !== null || child.signalCode !== null,
    unusedDataPresent: (await readdir(output)).includes("unused-data"),
    businessRouteObserved: /(?:GET|POST|PATCH|PUT|DELETE) \/api\//.test(logs.join("")),
    forbiddenServerFetch: logs.join("").includes("FORBIDDEN_SERVER_FETCH"),
  }, null, 2));
}
