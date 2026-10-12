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
const scenario = "evidence-source-identity";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/manual-source-response.ts",
  "src/components/studio/evidence.tsx",
  "scripts/fixtures/analysis-result-receipt.ts",
  "scripts/evidence-source-identity-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-evidence-source-identity-ui-"));
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
  input: path.join(app, "scripts/fixtures/analysis-result-receipt.ts"),
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
const { company } = fixture.analysisResultReceiptFixture();
company.profile.companyName = "합성 근거 자료 연결 기업";
const ambiguousId = company.sources[0].id,
  uniqueId = company.sources[1].id;
company.sources[0].name = "같은 이름의 합성 자료";
company.sources[0].text = "임의로 선택하면 안 되는 첫 번째 합성 본문";
company.sources[1].name = "같은 이름의 합성 자료";
company.sources[1].text = "  고유 자료의 저장 본문\n내부 공백을  그대로 둡니다.  ";
company.sources.push({
  ...structuredClone(company.sources[0]),
  text: "임의로 선택하면 안 되는 두 번째 합성 본문",
});
company.analysis.candidates[0].evidence = [
  {
    sourceId: ambiguousId,
    quote: "  보존할 과거 인용\n현재 연결은 확인 전입니다.  ",
    locator: "중복 번호 연결",
  },
  { sourceId: uniqueId, quote: "고유 자료의 인용", locator: "고유 번호 연결" },
  {
    sourceId: "00000000-0000-4000-8000-000000000999",
    quote: "삭제된 자료의 인용도 보존",
    locator: "없는 자료 연결",
  },
  { sourceId: "profile", quote: "기업이 제공한 설명 인용", locator: "기업 설명 연결" },
];
company.candidateSelections = [];
const reversed = structuredClone(company);
reversed.id = "00000000-0000-4000-8000-000000000701";
reversed.profile.companyName = "합성 중복 자료 역순 기업";
reversed.sources.reverse();
const name = company.profile.companyName,
  companies = [company, reversed],
  original = structuredClone(companies);
let previewReads = 0,
  intakeReads = 0,
  caseReads = 0;
let dialogAction = "dismiss";

const dialogs = [];
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
            aiConfigured: false,
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
        const intake = companies.find(
          (value) => u.pathname === `/api/studio/cases/${value.id}/source-intakes`,
        );
        if (intake) {
          intakeReads++;
          return reply({ company: intake, activeItemIds: [] });
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

  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message(), action: dialogAction });
    if (dialogAction === "accept") await dialog.accept();
    else await dialog.dismiss();
  });
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  const readiness = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await readiness;
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /아이템 분석/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const evidence = () => page.locator("#studio-panel-analysis aside").first();
  const entry = (locator) =>
    evidence().locator(":scope > div > details").filter({ hasText: locator });
  const ambiguous = () => entry("중복 번호 연결");
  const unique = () => entry("고유 번호 연결");
  const noOverflow = async () =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  const capture = async (target, file) => {
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: path.join(output, file) });
  };
  await evidence().waitFor();
  assert.equal(await ambiguous().count(), 1);
  assert.match(
    await ambiguous().locator(":scope > summary").textContent(),
    /연결된 자료를 하나로 확인하지 못했습니다\./,
    "Ambiguous source IDs must not select the first source",
  );
  await ambiguous().locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await ambiguous().locator("blockquote").textContent(),
    company.analysis.candidates[0].evidence[0].quote,
  );
  assert.equal(await ambiguous().locator("details").count(), 0);
  for (const text of [company.sources[0].text, company.sources[2].text])
    assert.equal(await evidence().getByText(text, { exact: true }).count(), 0);
  const missing = entry("없는 자료 연결"),
    profile = entry("기업 설명 연결");
  await missing.locator(":scope > summary").click();
  assert.equal(
    await missing.locator("blockquote").textContent(),
    company.analysis.candidates[0].evidence[2].quote,
  );
  assert.equal(await missing.locator("details").count(), 0);
  await profile.locator(":scope > summary").click();
  assert.match(
    await profile.locator(":scope > summary").textContent(),
    /기업정보 · 기업이 제공한 설명/,
  );
  assert.equal(await profile.locator("details").count(), 0);
  await noOverflow();
  await capture(ambiguous(), "evidence-ambiguous-mobile.png");
  assert.equal(commands.length, 0);
  assert.equal(dialogs.length, 0);
  record(
    "Ambiguous source IDs expose no arbitrarily chosen source name/body, while original quotations, missing-source and profile references remain readable",
  );
  await unique().locator(":scope > summary").click();
  await unique().getByText("저장된 원문 보기", { exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await unique().locator("details > p").textContent(), company.sources[1].text);
  assert.match(await unique().locator(":scope > summary").textContent(), /같은 이름의 합성 자료/);
  await noOverflow();
  await capture(unique(), "evidence-unique-mobile.png");
  assert.deepEqual(companies, original);
  record(
    "A unique source ID still opens the exact stored text despite identical source names elsewhere; keyboard reading sends no writes",
  );
  await page.getByRole("button", { name: "선택 이유 기록", exact: true }).click();
  const reason = page.locator("#candidate-selection-reason"),
    draft = "  근거를 읽으며 작성한 이유\n아직 저장하지 않았습니다.  ";
  await reason.fill(draft);
  await ambiguous().locator(":scope > summary").click();
  await ambiguous().locator(":scope > summary").click();
  await unique().getByText("저장된 원문 보기", { exact: true }).click();
  assert.equal(await reason.inputValue(), draft);
  assert.equal(commands.length, 0);
  assert.equal(dialogs.length, 0);
  dialogAction = "accept";
  await page.getByRole("button", { name: "편집 취소", exact: true }).click();
  await reason.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: /기업정보/ }).click();
  await page.getByRole("tab", { name: /아이템 분석/ }).click();
  assert.equal(await ambiguous().locator("details").count(), 0);
  await page.getByRole("button", { name: "전체 기업", exact: true }).click();
  const ready = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button").filter({ hasText: reversed.profile.companyName }).first().click();
  await ready;
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /아이템 분석/ }).click();
  await ambiguous().waitFor();
  assert.match(
    await ambiguous().locator(":scope > summary").textContent(),
    /연결된 자료를 하나로 확인하지 못했습니다\./,
  );
  await ambiguous().locator(":scope > summary").click();
  assert.equal(await ambiguous().locator("details").count(), 0);
  assert.equal(
    await ambiguous().locator("blockquote").textContent(),
    company.analysis.candidates[0].evidence[0].quote,
  );
  await noOverflow();
  assert.equal(dialogs.length, 1);
  assert.equal(caseReads, 2);
  assert.equal(intakeReads, 0);
  assert.equal(previewReads, 0);
  assert.equal(commands.length, 0);
  assert.deepEqual(companies, original);
  record(
    "Reading preserves an unsaved reason; tab return and a separate company with reversed duplicate order keep ambiguity unresolved without changing either memory snapshot",
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
        dialogs,
        syntheticUploadPosts: 0,
        syntheticPatches: 0,
        commands,
        syntheticCompanyGets: caseReads,
        syntheticPreviewPosts: previewReads,
        syntheticIntakeGets: intakeReads,
        actualOcr: 0,
        originalReads: 0,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "Synthetic ambiguous/unique/missing/profile evidence references; duplicate source order is reversed in a second company; no selection records created or files selected. No server source, writer, SQL, AI or external execution.",
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
