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
const scenario = "guided-evidence-invalid";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/manual-source-response.ts",
  "src/components/studio/guided-evidence-selection.tsx",
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/guided-evidence-invalid-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-guided-evidence-invalid-ui-"));
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
const fixtureEntry = path.join(output, "fixture-entry.ts");
await writeFile(
  fixtureEntry,
  `export {manualSourceFixture,manualId} from "${path.join(app, "scripts/fixtures/manual-source-receipt.ts").replaceAll("\\", "/")}";\nexport {serializeStudioAiInput,STUDIO_AI_INPUT_CHARACTER_LIMIT} from "${path.join(app, "src/lib/studio-ai-input.ts").replaceAll("\\", "/")}";\nexport {caseSchema} from "${path.join(app, "src/lib/studio-schema.ts").replaceAll("\\", "/")}";\nexport {guidedPreparationApproval} from "${path.join(app, "src/lib/studio-guided-preparation-state.ts").replaceAll("\\", "/")}";`,
);
const bundle = await rolldown({
  input: fixtureEntry,
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
const prepared = await fixture.manualSourceFixture();
const company = fixture.caseSchema.parse({
  ...prepared.company,
  profile: { ...prepared.company.profile, companyName: "합성 자료 선택 불일치 기업" },
  plans: [],
  analysis: null,
  selectedCandidateId: null,
  candidateSelections: [],
  guidedPreparationRuns: [],
  sources: [
    {
      ...prepared.company.sources[1],
      name: "첫 번째 중복 연결 자료",
      text: "  첫 자료 본문\n그대로 유지  ",
    },
    { ...prepared.company.sources[1], name: "두 번째 중복 연결 자료", text: "두 번째 다른 본문" },
    {
      ...prepared.company.sources[1],
      id: fixture.manualId(4),
      name: "고유 연결 자료",
      text: "  고유 본문\n끝 문장  ",
    },
  ],
});
const observedInputs = [];
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
const approval = fixture.guidedPreparationApproval(company, "synthetic-disabled");
const previewReads = 0;
let intakeReads = 0,
  caseReads = 0,
  preparationReads = 0;
const dialogAction = "dismiss";
const dialogs = [];
const diagnosticBlocks = [];
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
        if (u.pathname === `/api/studio/cases/${company.id}/source-intakes`) {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
          preparationReads++;
          return reply({ company: guided, active: false, aiConfigured: false, approval });
        }
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
      }
      if (
        serverMode === "dev" &&
        u.pathname === "/__nextjs_original-stack-frames" &&
        req.method() === "POST"
      ) {
        diagnosticBlocks.push(u.pathname);
        return route.abort();
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
  const materials = page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: /자료 올리기/ });
  await materials.click();
  const choose = page.getByRole("button", { name: "AI에 사용할 자료 선택", exact: true });
  await choose.click();
  const dialog = page.getByRole("dialog", { name: "AI에 사용할 자료 선택", exact: true });
  await dialog.waitFor();

  const rows = dialog.getByRole("list", { name: "AI 근거 선택 목록" }).locator(":scope > li");
  const boxes = dialog.getByRole("checkbox");
  const confirm = dialog.getByRole("button", { name: "선택 범위 확인", exact: true });
  const notice =
    "선택한 자료를 현재 목록과 정확히 연결하지 못해 입력량을 계산할 수 없습니다. 창을 닫고 자료 목록을 확인한 뒤 다시 선택해 주세요.";
  const alert = dialog.getByRole("alert").filter({ hasText: notice });
  const amount = dialog.locator("p").filter({ hasText: /^첫 분석 입력/ });
  function unchanged() {
    assert.deepEqual(company, original);
    assert.equal(commands.length, 0);
    assert.equal(previewReads, 0);
  }
  async function selections(expected) {
    assert.equal(await boxes.count(), 3);
    for (let i = 0; i < 3; i++) assert.equal(await boxes.nth(i).isChecked(), expected[i]);
  }
  async function invalid(expected) {
    await alert.waitFor();
    assert.equal(await alert.textContent(), notice);
    assert.equal(await amount.count(), 0);
    assert.equal(await confirm.isDisabled(), true);
    await selections(expected);
    unchanged();
    observedInputs.push({ valid: false, checked: expected });
  }
  async function valid(ids, expected) {
    await alert.waitFor({ state: "hidden" });
    const size = fixture.serializeStudioAiInput({
      ...company,
      sources: company.sources.filter((s) => ids.includes(s.id)),
    }).length;
    await amount
      .filter({ hasText: "첫 분석 입력 " + size.toLocaleString("ko-KR") + " / 240,000자" })
      .waitFor();
    assert.equal(await confirm.isEnabled(), true);
    await selections(expected);
    unchanged();
    observedInputs.push({ valid: true, ids, inputCharacters: size });
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, name) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await invalid([true, true, true]);
  for (let i = 0; i < 3; i++)
    assert.ok((await rows.nth(i).textContent()).includes(company.sources[i].name));
  await shot("evidence-invalid-initial-mobile.png", alert);
  record(
    "Ambiguous stored source IDs keep the existing scope-confirmation block, show an explicit calculation warning instead of an empty number, and preserve all sources without transmission",
  );
  await dialog.getByRole("button", { name: "회사 설명만 사용", exact: true }).click();
  await valid([], [false, false, false]);
  await boxes.nth(2).check();
  await valid([company.sources[2].id], [false, false, true]);
  await boxes.nth(0).focus();
  await boxes.nth(0).press("Space");
  await invalid([true, true, true]);
  await boxes.nth(1).focus();
  await boxes.nth(1).press("Space");
  await valid([company.sources[2].id], [false, false, true]);
  await shot("evidence-invalid-corrected-mobile.png", amount);
  record(
    "Explicit company-only or unique-source selections restore the original exact input calculation; reselecting the ambiguous ID shows the warning and clearing it retains the unique choice",
  );
  await dialog.getByRole("button", { name: "사용 가능한 자료 모두 선택", exact: true }).click();
  await invalid([true, true, true]);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await choose.click();
  await dialog.waitFor();
  await invalid([true, true, true]);
  await dialog.getByRole("button", { name: "회사 설명만 사용", exact: true }).click();
  await valid([], [false, false, false]);
  await shot("evidence-invalid-description-mobile.png", amount);
  assert.equal(caseReads, 1);
  assert.equal(dialogs.length, 0);
  unchanged();
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  record(
    "Select-all and explicit reopen preserve the original initial scope and expose the warning again; company-only remains available without automatic fixing, preview, consent or AI execution",
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
        observedInputs,
        dialogs,
        syntheticUploadPosts: 0,
        syntheticPatches: 0,
        commands,
        syntheticCompanyGets: caseReads,
        syntheticPreviewPosts: previewReads,
        syntheticIntakeGets: intakeReads,
        syntheticPreparationGets: preparationReads,
        actualOcr: 0,
        originalReads: 0,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "Ambiguous source IDs produce unavailable selected input; explicit warning and valid reselection, no preview, consent or API mutation.",
        diagnosticBlocks,
        duplicateKeyWarnings: network.filter((entry) => entry.console?.includes("same key")).length,
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
