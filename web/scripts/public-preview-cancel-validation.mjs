import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
const temporaryRoot = await realpath(tmpdir());
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
const scenario = process.argv[4] ?? "preview";
assert.ok(["preview", "research"].includes(scenario));

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/public-claim-preview.tsx",
  "src/components/studio/public-research-links.tsx",
  "src/components/studio/claim-reviews.tsx",
  "src/components/studio/plan-editor.tsx",
  "scripts/fixtures/public-preview-cancel.ts",
  "scripts/public-preview-cancel-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-preview-cancel-ui-"));
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
  input: path.join(app, "scripts/fixtures/public-preview-cancel.ts"),
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
const { company, select } = fixture.previewCompanyFixture(2);
const original = structuredClone(company);
const name = company.profile.companyName,
  caseId = company.id;
let stateReads = 0;
const network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [];
let releasePreview;
let held = true;
let enteredPreview;
const firstEntered = new Promise((resolve) => {
  enteredPreview = resolve;
});
const researchCommands = [],
  researchReleases = new Map();
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
  if (scenario === "research")
    await context.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.syntheticSearchSignals = [];
      window.syntheticSearchResponses = [];
      // Deliberately return late responses despite cancellation to exercise ownership guards.
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.pathname !== "/api/studio/public-research/search")
          return originalFetch(input, init);
        const index = window.syntheticSearchSignals.push(init.signal);
        const response = await originalFetch(input, { ...init, signal: undefined });
        const readJson = response.json.bind(response);
        response.json = async () => {
          try {
            return await readJson();
          } finally {
            window.syntheticSearchResponses.push(index);
          }
        };
        return response;
      };
    });
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
        if (u.pathname === root) return reply(company);
        if (scenario === "research" && u.pathname === root + "/source-intakes")
          return reply({ company, activeItemIds: [] });
        if (u.pathname === root + "/preparation-automation") {
          stateReads++;
          return reply({ company, active: false });
        }
        if (u.pathname === root + "/guided-preparation")
          return reply({ company, active: false, aiConfigured: false, approval: null });
      }
      if (
        scenario === "research" &&
        req.method() === "POST" &&
        u.pathname === "/api/studio/public-research/search"
      ) {
        const command = req.postDataJSON();
        researchCommands.push(command);
        const index = researchCommands.length;
        assert.ok(index <= 6, "Only six explicit synthetic lookups");
        assert.deepEqual(command, { topic: index === 6 ? "manufacturing" : "services" });
        const result = await new Promise((resolve) => researchReleases.set(index, resolve));
        researchReleases.delete(index);
        if (result === "error") return reply({ error: "Synthetic late search error" }, 503);
        return reply({
          topic: command.topic,
          query: command.topic === "manufacturing" ? "제조업" : "서비스업",
          provider: "KOSIS 국가통계포털",
          status: "results",
          retrievedAt: "2026-10-14T00:00:00.000Z",
          page: 1,
          pageSize: 10,
          candidates:
            result === "empty"
              ? []
              : [
                  {
                    organizationId: "101",
                    tableId: "SYNTHETIC_SEARCH",
                    title: `합성 조회 ${index}`,
                    organization: "합성 제공기관",
                    periodStart: "",
                    periodEnd: "",
                    originalUrl:
                      "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=SYNTHETIC_SEARCH",
                  },
                ],
          originalRead: false,
          databaseChanged: false,
        });
      }
      if (req.method() === "POST" && u.pathname === root + "/public-claim-comparison/preview") {
        const command = req.postDataJSON();
        commands.push(structuredClone(command));
        assert.ok(commands.length <= 2, "Only two explicit preview requests; no automatic retry");
        assert.deepEqual(command, {
          requestVersion: "public-claim-comparison-request-v1",
          model: fixture.model,
          selection: { ...select(), sourceIds: [company.sources[0].id] },
        });
        if (held) {
          enteredPreview();
          await new Promise((resolve) => {
            releasePreview = resolve;
          });
          releasePreview = undefined;
        }
        return reply({ error: "Synthetic delayed preview unavailable" }, 503);
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
  if (scenario === "research") {
    await page
      .getByRole("navigation", { name: "신청 준비 3단계" })
      .getByRole("button", { name: /자료 올리기/ })
      .click();
    await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
    const panel = page.getByRole("region", { name: "공개 근거 후보 보관", exact: true });
    const title = panel.getByRole("textbox", { name: "공개 자료 제목", exact: true });
    const quote = panel.getByRole("textbox", { name: "원문 발췌" });
    await title.fill("보존할 미저장 제목");
    await quote.fill("  보존할 미저장 발췌\n회사 해당성 미확인  ");
    const summary = panel.getByText("공개 통계 찾기 (선택)", { exact: true });
    await summary.click();
    const topic = panel.getByLabel("찾을 공개 주제", { exact: true });
    await topic.selectOption("services");
    const lookup = panel.getByRole("button", { name: "공개 검색 후보 10개 조회", exact: true });
    const loading = panel.getByRole("button", { name: "공개 검색 후보 조회 중", exact: true });
    const results = panel.getByRole("region", { name: "KOSIS 검색 후보", exact: true });
    const begin = async (index) => {
      await lookup.click();
      await page.waitForFunction((n) => window.syntheticSearchSignals.length === n, index);
      const deadline = Date.now() + 10000;
      while (!researchReleases.has(index) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(researchReleases.has(index));
      assert.equal(await loading.isDisabled(), true);
    };
    const finish = async (index, mode = "results") => {
      researchReleases.get(index)(mode);
      await page.waitForFunction((n) => window.syntheticSearchResponses.includes(n), index);
      // Let the component's continuation and React commit run after the synthetic body read.
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
    };
    const wasAborted = (index) =>
      page.evaluate((n) => window.syntheticSearchSignals[n - 1].aborted, index);
    assert.deepEqual(researchCommands, []);
    await begin(1);
    await summary.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => window.syntheticSearchSignals[0].aborted);
    await summary.click();
    await panel.getByRole("status").filter({ hasText: "검색 결과 대기를 중단" }).waitFor();
    assert.equal(await lookup.isEnabled(), true);
    assert.equal(await topic.inputValue(), "services");
    assert.equal(researchCommands.length, 1);
    await begin(2);
    await finish(1);
    assert.equal(await results.count(), 0);
    assert.equal(await loading.isDisabled(), true);
    assert.equal(await wasAborted(2), false);
    await finish(2);
    await results.getByText("합성 조회 2", { exact: true }).waitFor();
    assert.equal(await results.getByText("합성 조회 1", { exact: true }).count(), 0);
    record(
      "keyboard collapse aborts search; reopening keeps the topic and late success cannot replace or release a newer explicit lookup",
    );
    await begin(3);
    await page.setViewportSize({ width: 390, height: 844 });
    const stop = panel.getByRole("button", { name: "검색 대기 중단", exact: true });
    await stop.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "research-cancel-mobile.png") });
    await stop.focus();
    await page.keyboard.press("Enter");
    await lookup.waitFor();
    assert.equal(await wasAborted(3), true);
    await begin(4);
    await finish(3, "error");
    assert.equal(await panel.getByRole("alert").count(), 0);
    assert.equal(await loading.isDisabled(), true);
    await finish(4);
    await results.getByText("합성 조회 4", { exact: true }).waitFor();
    record(
      "explicit stop works by keyboard at 390px; a late failure cannot create an error or unlock the new lookup",
    );
    await begin(5);
    await topic.selectOption("manufacturing");
    assert.equal(await wasAborted(5), true);
    await finish(5);
    assert.equal(await results.count(), 0);
    assert.equal(researchCommands.length, 5);
    await begin(6);
    await finish(6, "empty");
    await panel.getByRole("status").filter({ hasText: "검색 후보가 없습니다" }).waitFor();
    assert.equal(await title.inputValue(), "보존할 미저장 제목");
    assert.equal(await quote.inputValue(), "  보존할 미저장 발췌\n회사 해당성 미확인  ");
    assert.deepEqual(company, original);
    assert.deepEqual(commands, []);
    record(
      "topic changes and empty-result semantics remain intact; all unsaved evidence and stored records survive with no writes or automatic retry",
    );
  } else {
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    await page.locator("#studio-tab-plan").click();
    const stateButton = page.getByRole("button", { name: "연결 저장 상태 확인", exact: true });
    await stateButton.click({ trial: true });
    const area = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
    const box = area
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "공개 근거 비교 입력 미리보기 (선택)" }) });
    await box.locator(":scope > summary").click();
    const claim = box.getByRole("combobox");
    const model = box.getByRole("textbox");
    const preview = box.getByRole("button", { name: "선택 입력 미리보기", exact: true });
    const sources = box.getByRole("checkbox");
    await claim.selectOption(company.claimReviews[0].id);
    await sources.first().check();
    await model.fill(fixture.model);
    await preview.click();
    let enteredTimer;
    try {
      await Promise.race([
        firstEntered,
        new Promise((_, reject) => {
          enteredTimer = setTimeout(
            () => reject(Error("Synthetic preview route not reached")),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(enteredTimer);
    }
    await box.getByRole("button", { name: "로컬 미리보기 확인 중", exact: true }).waitFor();
    const readsBefore = stateReads;
    await stateButton.click();
    await stateButton.click({ trial: true });
    assert.equal(stateReads, readsBefore + 1);
    assert.equal(await box.evaluate((element) => element.open), true);
    assert.equal(await claim.inputValue(), company.claimReviews[0].id);
    assert.equal(await model.inputValue(), fixture.model);
    assert.equal(await sources.first().isChecked(), true);
    assert.equal(await sources.nth(1).isChecked(), false);
    assert.equal(
      await box.getByRole("button", { name: "로컬 미리보기 확인 중", exact: true }).count(),
      0,
      "Same-revision company refresh must release the canceled preview busy state",
    );
    assert.equal(await preview.isEnabled(), true);
    assert.equal(commands.length, 1);
    record(
      "same-revision explicit state read cancels pending preview and preserves exact choices with a ready retry button",
    );
    held = false;
    releasePreview();
    await page.waitForTimeout(200);
    assert.equal(
      await box.getByRole("alert").count(),
      0,
      "Canceled response cannot set a stale error",
    );
    assert.equal(await preview.isEnabled(), true);
    record("late canceled HTTP error is ignored without automatic retry");
    await preview.click();
    await box.getByRole("alert").waitFor();
    assert.equal(commands.length, 2);
    assert.equal(await preview.isEnabled(), true);
    assert.equal(await claim.inputValue(), company.claimReviews[0].id);
    assert.equal(await sources.first().isChecked(), true);
    assert.deepEqual(commands[1], commands[0]);
    assert.deepEqual(company, original);
    record(
      "explicit retry sends the preserved selection once; current HTTP failure releases the button without changing records",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await box.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await box.screenshot({ path: path.join(output, "preview-cancel-mobile.png") });
    record("mobile selection and retry controls remain usable");
  }
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
        syntheticPreviewPosts: commands.length,
        syntheticResearchPosts: researchCommands.length,
        scenario,
        syntheticStateReads: stateReads,
        syntheticWrites: 0,
        automaticRetry: 0,
        continuousJourneys: 1,
        startingState:
          scenario === "research"
            ? "actual guided app with held synthetic search responses; collapse/stop and newer reads; no SQL, SDK, writes or KOSIS calls"
            : "actual app and synthetic stored manuscript/review; delayed HTTP error canceled by explicit same-revision state read, retained choices, explicit retry; no SQL, SDK, writes or valid AI/preview response claim",
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
  releasePreview?.();
  for (const release of researchReleases.values()) release("empty");
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
