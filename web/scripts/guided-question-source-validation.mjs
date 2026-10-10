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
const scenario = "question-source";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-question-card.tsx",
  "scripts/fixtures/guided-answer-workflow.ts",
  "scripts/guided-question-source-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-question-source-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-answer-workflow.ts"),
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
let company = fixture.answerWorkflowCompany();
const bodies = [
  "  첫 번째 자료는 내부 시험 메모입니다.\n외부 시험 결과가 아닙니다.  ",
  "  두 번째 자료의 정확한 본문입니다.\n<script>window.questionSourceInjected=true</script>\n" +
    "긴 합성 본문을 끝까지 보존합니다.\n".repeat(30) +
    "두 번째 자료 끝.  ",
  "",
  "",
];
company.sources = bodies.map((text, index) => ({
  ...fixture.answerWorkflowSource(),
  id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  name: index < 2 ? "동일한 자료 이름" : index === 2 ? "본문 없는 파일" : "빈 메모",
  kind: "technology",
  originalName: index < 2 ? `원래자료${index + 1}.txt` : null,
  text,
  extraction: index === 2 ? "pending" : "manual",
}));
const original = structuredClone(company),
  name = company.profile.companyName,
  caseId = company.id;
const edited = "  답변 원문을 유지합니다.\n외부 시험은 아직 계획 단계입니다.  ";
let caseReads = 0,
  intakeReads = 0;
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
            model: "gpt-5.4",
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
        if (u.pathname === root + "/guided-preparation")
          return reply({ company, active: false, aiConfigured: false, approval: null });
      }
      if (req.method() === "PATCH" && u.pathname === root) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.equal(commands.length, 1, "No automatic or repeated answer save");
        assert.equal(command.action, "source");
        assert.equal(command.revision, original.revision);
        assert.equal(command.source.name, "사업계획서 준비 답변");
        assert.equal(command.source.kind, "consultation");
        assert.equal(command.source.extraction, "manual");
        assert.ok(command.source.text.includes(edited.trim()));
        assert.ok(command.source.text.includes(fixture.answerQuestion));
        assert.ok(command.source.text.includes("(development)"));
        assert.ok(command.source.text.includes(original.sources[1].id));
        for (const source of [original.sources[0], ...original.sources.slice(2)])
          assert.ok(!command.source.text.includes(source.id));
        for (const body of bodies.filter(Boolean)) assert.ok(!command.source.text.includes(body));
        company = structuredClone(company);
        company.revision++;
        company.sources.push(command.source);
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
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: /AI 계획서/ })
    .click();
  await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
  await page.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  const input = page.getByLabel(fixture.answerQuestion, { exact: true });
  const section = page.getByRole("combobox", { name: /관련 계획서 항목/ }).nth(1);
  const save = page.getByRole("button", { name: "답변 보관하기", exact: true });
  await input.fill(edited);
  await section.selectOption("development");
  const links = page
    .locator("details")
    .filter({ has: page.locator(":scope > summary").filter({ hasText: /^보관 자료 연결/ }) })
    .nth(1);
  await links.locator(":scope > summary").click();
  const boxes = links.getByRole("checkbox");
  assert.equal(await boxes.count(), 4);
  const preview = (n) => links.locator(`details[aria-label="자료 ${n} 저장된 본문"]`);
  for (const n of [1, 2]) {
    await preview(n).locator("summary").click();
    const text = preview(n).locator("p.whitespace-pre-wrap");
    await text.waitFor();
    assert.equal(await text.textContent(), bodies[n - 1]);
    assert.equal(
      await preview(n)
        .getByText(`자료 종류: 기술·제품 · 원래 파일: 원래자료${n}.txt`, { exact: true })
        .count(),
      1,
    );
    assert.equal(await boxes.nth(n - 1).isChecked(), false);
  }
  assert.equal(await preview(2).locator("script").count(), 0);
  assert.equal(await page.evaluate(() => window.questionSourceInjected), undefined);
  assert.equal(await input.inputValue(), edited);
  assert.equal(await section.inputValue(), "development");
  assert.equal(commands.length, 0);
  assert.equal(caseReads, 1);
  record(
    "same-name documents expose exact separate stored bodies and original names without selecting, executing markup or changing answer/section",
  );
  await preview(3).locator("summary").click();
  await preview(3).getByText("저장된 본문이 없습니다.", { exact: true }).waitFor();
  await preview(4).locator("summary").click();
  await preview(4).getByText("저장된 본문이 없습니다.", { exact: true }).waitFor();
  await preview(3).getByText("본문 판독·채택 전 자료입니다.", { exact: false }).waitFor();
  assert.deepEqual(await boxes.evaluateAll((nodes) => nodes.map((n) => n.checked)), [
    false,
    false,
    false,
    false,
  ]);
  assert.deepEqual(company, original);
  record(
    "empty and not-adopted documents show their status, and reading never adopts text or selects evidence",
  );
  await boxes.nth(1).check();
  await preview(1).locator("summary").click();
  await links.locator(":scope > summary").click();
  await links.locator(":scope > summary").click();
  assert.deepEqual(await boxes.evaluateAll((nodes) => nodes.map((n) => n.checked)), [
    false,
    true,
    false,
    false,
  ]);
  assert.equal(await input.inputValue(), edited);
  assert.equal(await section.inputValue(), "development");
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(2).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "question-source-mobile.png"), fullPage: true });
  assert.equal(commands.length, 0);
  assert.equal(caseReads, 1);
  record(
    "explicit selection stays on the second document while previews are closed/reopened and answer input survives mobile reading without writes",
  );
  await save.click();
  await page.getByRole("region", { name: "저장한 답변으로 원고 보완", exact: true }).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 1);
  assert.deepEqual(company.sources.slice(0, 4), original.sources);
  assert.deepEqual(company.plans, original.plans);
  assert.deepEqual(company.analysis, original.analysis);
  assert.equal(company.sources[4].id, commands[0].source.id);
  record(
    "one explicit answer save retains only the selected document identity and original question/section without copying its body or changing manuscript",
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
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "memory-only question source reading and one explicit answer save; no real document reading, SQL or AI",
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
