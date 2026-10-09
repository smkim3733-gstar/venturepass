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
  "src/lib/studio-guided-flow.ts",
  "src/lib/studio-export-docx.ts",
  "src/lib/studio-export.ts",
  "scripts/fixtures/guided-manuscript-review.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-manuscript-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-manuscript-review.ts"),
  cwd: app,
  platform: "browser",
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      resolveId(source) {
        if (
          /openai|server-only|node:|storage|provider-production|configuration-current/.test(source)
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
let company = fixture.manuscriptReviewCompany();
const initialPlan = structuredClone(company.plans),
  name = company.profile.companyName,
  caseId = company.id;
const downloads = [];
const network = [];
const commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [];
// Browser attachment downloads may bypass Playwright interception. The HTTP boundary
// must enforce isolation independently: only static UI requests reach Next.
const proxy = createHttpServer(async (req, res) => {
  const u = new URL(req.url, origin);
  const root = "/api/studio/cases/" + caseId;
  try {
    if (req.method === "GET" && u.pathname === root + "/export") {
      assert.equal(u.searchParams.get("format"), "docx");
      assert.deepEqual([...u.searchParams.keys()].sort(), ["format", "planId"]);
      const plan = company.plans.find((p) => p.id === u.searchParams.get("planId"));
      assert.ok(plan);
      assert.equal(plan.id, company.plans.at(-1).id);
      const bytes = Buffer.from(await fixture.exportPlanDocx(company, plan, false));
      downloads.push({ planId: plan.id, version: plan.version });
      res.writeHead(200, {
        "Content-Type": fixture.PLAN_DOCX_MIME,
        "Content-Disposition": 'attachment; filename="manuscript-v' + plan.version + '.docx"',
        "Content-Length": String(bytes.length),
      });
      res.end(bytes);
      return;
    }
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
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
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
          aiConfigured: false,
          model: "synthetic-disabled",
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
      if (u.pathname === root + "/guided-preparation")
        return reply({
          company,
          active: false,
          aiConfigured: false,
          approval: {
            caseId,
            revision: company.revision,
            provider: "OpenAI",
            model: "synthetic-disabled",
            inputFingerprint: "a".repeat(64),
            sourceIds: company.sources.map((s) => s.id),
            sourceNames: company.sources.map((s) => s.name),
            profileIncluded: true,
            businessNumberIncluded: false,
            originalFilesIncluded: false,
            derivedDraftIncluded: true,
            purpose: "analysis-plan-review",
          },
        });
      if (u.pathname === root + "/plan-supplements/execution")
        return reply({
          company,
          active: false,
          retainedCapture: false,
          executions: [],
          transmissionAllowed: false,
        });
    }
    if (req.method() === "GET" && u.pathname === root + "/export") return route.continue();
    if (req.method() === "PATCH" && u.pathname === root) {
      const command = req.postDataJSON();
      commands.push(command);
      assert.equal(command.revision, company.revision);
      assert.equal(command.action, "save-plan");
      const plan = company.plans.at(-1);
      assert.equal(command.planId, plan.id);
      const version = plan.version + 1;
      company = {
        ...company,
        revision: company.revision + 1,
        plans: [
          ...company.plans,
          {
            ...plan,
            id: "a0000000-0000-4000-8000-" + String(version).padStart(12, "0"),
            version,
            mode: "manual",
            generatedAt: "2026-10-09T00:0" + version + ":00.000Z",
            content: command.content,
            confirmedAt: null,
          },
        ],
      };
      return reply(company);
    }
    if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      unexpected.push(u.pathname);
      return route.abort();
    }
    return route.continue();
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

  await reopen();
  const overview = () => page.getByRole("region", { name: "현재 원고와 검토 상태" });
  async function download(version, expected) {
    const waiting = page.waitForEvent("download");
    await overview()
      .getByRole("link", { name: `원고 v${version} Word 내려받기`, exact: true })
      .click();
    const item = await waiting;
    const dest = path.join(output, `manuscript-v${version}-${downloads.length}.docx`);
    await item.saveAs(dest);
    const xml = await fixture.documentXml(await readFile(dest));
    assert.ok(xml.includes(`원고 버전 ${version}`));
    assert.ok(xml.includes(expected));
    assert.ok(xml.includes("미확인 — 변경 자료와 원고의 반영 범위 확인 필요"));
    assert.ok(!xml.includes("재작성 필요"));
    return xml;
  }
  await overview().waitFor();
  assert.ok((await overview().innerText()).includes("항목 확인 필요 1개"));
  assert.ok((await overview().innerText()).includes("전체 검토 미완료"));
  assert.equal(
    await page.getByRole("button", { name: "현재 자료로 다시 준비", exact: true }).count(),
    0,
  );
  const firstXml = await download(2, company.plans[1].content.sections[1].content);
  assert.ok(firstXml.includes("확인 필요"));
  assert.ok(!firstXml.includes(company.plans[0].content.sections[1].content));
  assert.deepEqual(company.plans, initialPlan);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "review-download-mobile.png"), fullPage: true });
  record(
    "saved supplement version and unresolved facts are visible and download as the exact v2 Word; mobile fits",
  );
  await page.getByRole("button", { name: "확인이 필요한 부분 보기", exact: true }).click();
  assert.equal(
    await page.getByLabel("기술 개발", { exact: true }).inputValue(),
    company.plans[1].content.sections[1].content,
  );
  const checkbox = () =>
    page.getByRole("checkbox", { name: "이 항목의 사실·수치·근거를 직접 확인했습니다." });
  assert.equal(await checkbox().isChecked(), false);
  assert.equal(await page.getByRole("link", { name: /Word 내려받기/ }).count(), 0);
  await page
    .getByLabel("기술 개발", { exact: true })
    .fill("수정 후에도 외부 시험 근거는 아직 확인 중입니다.");
  await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
  await overview().getByRole("heading", { name: "현재 원고 v3", exact: true }).waitFor();
  assert.equal(company.plans[2].content.sections[1].needsConfirmation, true);
  assert.equal(company.plans[2].confirmedAt, null);
  assert.deepEqual(company.plans.slice(0, 2), initialPlan);
  await download(3, company.plans[2].content.sections[1].content);
  record(
    "unconfirmed edit creates v3, retains earlier versions, and exports the newly saved content",
  );
  await page.getByRole("button", { name: "확인이 필요한 부분 보기", exact: true }).click();
  await checkbox().check();
  await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
  await overview().getByRole("heading", { name: "현재 원고 v4", exact: true }).waitFor();
  assert.equal(company.plans[3].content.sections[1].needsConfirmation, false);
  assert.equal(company.analysis, null);
  assert.equal(company.selectedCandidateId, null);
  assert.equal(company.plans[3].confirmedAt, null);
  assert.ok((await overview().innerText()).includes("전체 검토 미완료"));
  assert.equal(
    await page.getByRole("button", { name: "검토 마치고 신청 준비", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "자료·신청 방향 확인", exact: true }).count(),
    1,
  );
  await download(4, company.plans[3].content.sections[1].content);
  record(
    "explicit section check is not promoted to whole-plan confirmation or application readiness",
  );
  await reopen();
  await overview().getByRole("heading", { name: "현재 원고 v4", exact: true }).waitFor();
  assert.equal(
    await overview().getByRole("link", { name: "원고 v4 Word 내려받기", exact: true }).count(),
    1,
  );
  assert.equal(commands.length, 2);
  record(
    "reopening the saved synthetic state retains latest version and review state without regeneration",
  );
  await page.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  await page
    .getByLabel("외부 성능 시험은 어느 단계인가요?", { exact: true })
    .fill("아직 보관하지 않은 답변입니다.");
  await page.getByRole("button", { name: "지금은 없어요 · 나중에 답하기", exact: true }).click();
  await overview().getByRole("button", { name: "원고 v4 Word 내려받기", exact: true }).waitFor();
  assert.equal(
    await overview()
      .getByRole("button", { name: "원고 v4 Word 내려받기", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await overview().getByRole("link").count(), 0);
  await page.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  assert.equal(
    await page.getByLabel("외부 성능 시험은 어느 단계인가요?", { exact: true }).inputValue(),
    "아직 보관하지 않은 답변입니다.",
  );
  assert.equal(downloads.length, 3);
  record(
    "unsaved answer survives navigation and prevents a misleading saved-version download action",
  );
  company = fixture.manuscriptReviewCompany();
  company.plans[1].content.sections.forEach((s) => (s.needsConfirmation = false));
  company.plans[1].review = [
    {
      id: "synthetic-review",
      severity: "error",
      category: "confirmation",
      message: "근거 대조 필요",
      action: "근거를 대조하세요",
      sectionKey: "development",
      sourceIds: [],
    },
  ];
  await reopen();
  await page.getByRole("button", { name: "검토 의견 확인하기", exact: true }).waitFor();
  assert.ok((await overview().innerText()).includes("검토 의견 1개"));
  const findingXml = await download(2, company.plans[1].content.sections[1].content);
  assert.ok(findingXml.includes("근거를 대조하세요"));
  assert.equal(
    await page.getByRole("button", { name: "검토 마치고 신청 준비", exact: true }).count(),
    0,
  );
  record("blocking review remains visible in both screen and downloaded document");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(!logs.join("").includes("FORBIDDEN_SERVER_FETCH"));
  assert.equal((await readdir(output)).includes("unused-data"), false);
  assert.ok(!logs.join("").includes("GET /api/"));
  assert.ok(commands.every((c) => c.action === "save-plan"));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        checks,
        syntheticApiCommands: commands.length,
        syntheticExports: downloads,
        startingState: "synthetic post-adoption; actual adoption writer not executed",
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
  console.log(JSON.stringify({ output, checks, downloads, unexpected, errors, network }));
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
}
