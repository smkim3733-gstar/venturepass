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
const scenario = "reference-labels";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/appeal-preparation.tsx",
  "src/components/studio/claim-reviews.tsx",
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/reference-labels-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-reference-labels-ui-"));
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
  input: path.join(app, "scripts/fixtures/manual-source-receipt.ts"),
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
const company = fixture.manualSourceFixture().company;
company.profile.companyName = "합성 근거 자료 구분 기업";
const pending = structuredClone(company.sources[0]),
  base = structuredClone(company.sources[1]);
const sources = [
  {
    ...base,
    id: fixture.manualId(11),
    name: "같은 이름 자료",
    kind: "technology",
    originalName: "<b>first</b>-" + "abcdefghij".repeat(9) + ".pdf",
    mimeType: "application/pdf",
    text: "  첫째 본문\n다른 기술 자료  ",
  },
  {
    ...base,
    id: fixture.manualId(12),
    name: "같은 이름 자료",
    kind: "finance",
    originalName: "MONTHLY.TXT",
    mimeType: "text/plain",
    text: "  둘째 본문\n다른 재무 자료  ",
  },
  {
    ...pending,
    id: fixture.manualId(13),
    name: "같은 이름 자료",
    kind: "patent",
    originalName: "pending-original.pdf",
  },
  {
    ...base,
    id: fixture.manualId(14),
    name: "파일 없는 자료",
    kind: "consultation",
    text: "  직접 보관한 합성 메모\n마지막 문장  ",
  },
];
company.sources = sources;
const kinds = ["기술·제품", "재무·자금", "특허·지식재산", "상담·녹취"];
const metadata = sources.map(
  (source, i) => kinds[i] + " · " + (source.originalName || "원본 파일명 없음"),
);
const labels = sources.map((source, i) => source.name + " · " + metadata[i]);
assert.equal(new Set(sources.map((source) => source.id)).size, 4);

const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0,
  nextDialog = "dismiss";
const network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [],
  dialogs = [];
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
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
          preparationReads++;
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        }
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
  page.on("dialog", async (dialog) => {
    const action = nextDialog;
    nextDialog = "dismiss";
    dialogs.push({ message: dialog.message(), action });
    await dialog[action]();
  });
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
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  const panel = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
  await panel.getByRole("button", { name: "새 주장·근거 기록", exact: true }).click();
  const editor = panel.getByRole("group", { name: "첫 주장 기록", exact: true });
  const refs = editor.getByRole("group", { name: "대조할 등록 자료", exact: true });
  const chooser = refs.getByLabel("연결할 자료", { exact: true });
  await chooser.waitFor();
  const cards = () => refs.locator(":scope > div");
  const claim = editor.getByLabel("주장 문장을 원문 그대로 인용 *", { exact: true });
  const owner = editor.getByLabel("확인 담당자 (수동 기록)", { exact: true });
  const contextNote = editor.getByLabel("기업·기간·단위·범위 해석 메모", { exact: true });
  const quote = (i) =>
    cards().nth(i).getByLabel("등록 본문 그대로 인용 (원본만 연결하면 비움)", { exact: true });
  const locator = (i) => cards().nth(i).getByLabel("쪽·위치 (선택)", { exact: true });
  const body = (i) => cards().nth(i).locator("pre");
  async function preserved() {
    assert.equal(await claim.inputValue(), "  주장 초안\n아직 미검토  ");
    assert.equal(await owner.inputValue(), "  합성 담당자  ");
    assert.equal(await contextNote.inputValue(), "  확인 범위\n보존 메모  ");
    assert.equal(await quote(0).inputValue(), "  첫째 인용\n보존  ");
    assert.equal(await locator(0).inputValue(), "  첫째 2쪽  ");
    await page.waitForFunction(
      () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      },
      null,
      { timeout: 10000 },
    );
    assert.equal(await chooser.inputValue(), "");
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.equal(dialogs.length, 0);
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const control of [refs, chooser, target]) {
      const box = await control.boundingBox();
      assert.ok(
        box && box.x >= 0 && box.x + box.width <= 391,
        "reference controls fit mobile viewport",
      );
    }
    await page.screenshot({ path: path.join(output, "reference-labels-" + name + "-mobile.png") });
  }
  await claim.fill("  주장 초안\n아직 미검토  ");
  await owner.fill("  합성 담당자  ");
  await contextNote.fill("  확인 범위\n보존 메모  ");
  assert.deepEqual(await chooser.locator("option").allTextContents(), ["자료 선택", ...labels]);
  assert.equal(await cards().count(), 0);
  await chooser.selectOption({ label: labels[0] });
  assert.equal(await cards().count(), 1);
  await cards().nth(0).getByText(metadata[0], { exact: true }).waitFor();
  assert.equal(await chooser.locator('option[value="' + sources[0].id + '"]').isDisabled(), true);
  assert.equal(await refs.locator("b").count(), 0);
  await quote(0).fill("  첫째 인용\n보존  ");
  await locator(0).fill("  첫째 2쪽  ");
  await cards().nth(0).getByText("등록 본문 대조", { exact: true }).click();
  assert.equal(await body(0).textContent(), sources[0].text);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("first", cards().nth(0).getByText(metadata[0], { exact: true }));
  await preserved();
  record(
    "Source options include exact names, kinds and original filenames; the first same-name source retains its own ID/body/quote, literal HTML-looking long filename, and wrapped selected-card metadata",
  );

  await chooser.selectOption({ label: labels[1] });
  assert.equal(await cards().count(), 2);
  await cards().nth(1).getByText(metadata[1], { exact: true }).waitFor();
  await quote(1).fill("  둘째 인용\n보존  ");
  await locator(1).fill("  둘째 3쪽  ");
  await cards().nth(1).getByText("등록 본문 대조", { exact: true }).click();
  assert.equal(await body(1).textContent(), sources[1].text);
  await cards().nth(0).getByText("등록 본문 대조", { exact: true }).click();
  await cards().nth(0).getByText("등록 본문 대조", { exact: true }).click();
  assert.equal(await body(0).textContent(), sources[0].text);
  assert.equal(await quote(1).inputValue(), "  둘째 인용\n보존  ");
  assert.equal(await locator(1).inputValue(), "  둘째 3쪽  ");
  assert.equal(await chooser.locator('option[value="' + sources[1].id + '"]').isDisabled(), true);
  await preserved();
  await shot("second", cards().nth(1).getByText(metadata[1], { exact: true }));
  record(
    "The second same-name source is separately chosen by its financial kind and filename, with its own body/quote/location and ID; adding and reading it keeps the first citation and claim inputs intact",
  );

  await chooser.selectOption({ label: labels[2] });
  await cards().nth(2).getByText(metadata[2], { exact: true }).waitFor();
  await cards().nth(2).getByText("등록 본문 대조", { exact: true }).click();
  assert.equal(await body(2).textContent(), "본문 확인 필요 · 원본 파일만 연결할 수 있습니다.");
  assert.equal(await quote(2).inputValue(), "");
  await shot("pending", cards().nth(2).getByText(metadata[2], { exact: true }));
  await chooser.selectOption({ label: labels[3] });
  await cards().nth(3).getByText(metadata[3], { exact: true }).waitFor();
  await cards().nth(3).getByText("등록 본문 대조", { exact: true }).click();
  assert.equal(await body(3).textContent(), sources[3].text);
  assert.equal(await cards().count(), 4);
  for (const source of sources)
    assert.equal(await chooser.locator('option[value="' + source.id + '"]').isDisabled(), true);
  assert.equal(await quote(1).inputValue(), "  둘째 인용\n보존  ");
  assert.equal(await locator(1).inputValue(), "  둘째 3쪽  ");
  await preserved();
  await shot("no-file", cards().nth(3).getByText(metadata[3], { exact: true }));
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 1);
  record(
    "Pending original keeps its existing body-warning and empty citation; a source without an original filename explicitly shows that absence and its registered text, while all four selected IDs remain disabled and no request is sent",
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
        syntheticPreparationGets: preparationReads,
        syntheticUploadPosts: 0,
        syntheticPreviewPosts: 0,
        commands,
        dialogs,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "shared source-reference labels in new claim editor; same-name sources and pending/no-file memory variants; no API mutation",
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
