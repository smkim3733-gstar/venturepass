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
const scenario = "claim-context";

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
  "scripts/fixtures/claim-review-receipt.ts",
  "scripts/claim-context-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-claim-context-ui-"));
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
  input: path.join(app, "scripts/fixtures/claim-review-receipt.ts"),
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
const company = fixture.claimReceiptFixture().company;
company.profile.companyName = "합성 주장 원고 전환 기업";
const planA = company.plans.at(-1);
const sectionA = planA.content.sections[0].key;
const sectionB = "synthetic-second";
planA.content.sections.push({
  ...structuredClone(planA.content.sections[0]),
  key: sectionB,
  title: "다른 합성 항목",
  content: "  둘째 합성 항목\n원문 그대로  ",
});
const planB = structuredClone(planA);
planB.id = fixture.agencyId(380);
planB.version = planA.version + 1;
planB.content.title = "다른 합성 저장 원고";
company.plans.push(planB);
const decisionId = fixture.agencyId(381);
const finding = {
  id: "synthetic-context",
  severity: "warning",
  category: "evidence",
  message: "전환 대조용 합성 검토 의견",
  action: "직접 검토 필요",
  sectionKey: sectionA,
  sourceIds: [],
};
const findingIndex = planA.review.length;
planA.review.push(finding);
company.planReviewDecisions.push({
  id: decisionId,
  rootId: decisionId,
  version: 1,
  clientRequestId: fixture.agencyId(382),
  planId: planA.id,
  planVersion: planA.version,
  findingIndex,
  finding,
  previousRecordId: null,
  status: "deferred",
  reason: "합성 보류 이유",
  reviewer: "합성 검토자",
  inputDigest: "c".repeat(64),
  recordedAt: "2026-10-12T20:00:00.000Z",
  origin: "manual",
  reviewKey: "a".repeat(64),
  planContentSha256: "b".repeat(64),
  findingSha256: "c".repeat(64),
  planSourceRevision: 0,
  evidenceRevision: 0,
  evidenceFingerprint: "d".repeat(64),
  stale: true,
  staleReasons: ["evidence-changed"],
});

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
  let editor = panel.getByRole("group", { name: "첫 주장 기록", exact: true });
  const control = (name) => editor.getByLabel(name, { exact: true });
  const plans = () => control("저장 원고 버전 직접 선택 *");
  const sections = () => control("고유 원고 항목 *");
  const quote = () => control("주장 문장을 원문 그대로 인용 *");
  const reviews = () => control("선택한 원고의 검토 판단 버전 (최대 10개)");
  const numeric = () => control("수치 대조 참고 버전 (최대 10개)");
  const planMessage = "작성한 주장 인용과 원고 검토 연결을 비우고 원고 버전을 변경할까요?";
  const sectionMessage = "작성한 주장 인용을 비우고 원고 항목을 변경할까요?";
  const selectValues = (el) =>
    el.locator("option:checked").evaluateAll((nodes) => nodes.map((n) => n.value));
  async function choose(el, value, message, action) {
    const count = dialogs.length;
    nextDialog = action;
    await el.selectOption(value);
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), { message, action });
  }
  async function unchanged() {
    assert.deepEqual(companies, original);
    assert.equal(commands.length, 0);
    assert.equal(await control("확인 담당자 (수동 기록)").inputValue(), "  합성 담당자  ");
    assert.equal(
      await control("기업·기간·단위·범위 해석 메모").inputValue(),
      "  확인 범위\n남는 메모  ",
    );
    await page.waitForFunction(
      () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      },
      null,
      { timeout: 10000 },
    );
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const el of [plans(), sections(), quote()]) {
      const box = await el.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 391, "claim controls fit mobile");
    }
    await page.screenshot({ path: path.join(output, "claim-context-" + name + "-mobile.png") });
  }
  await plans().selectOption(planA.id);
  await sections().selectOption(sectionA);
  assert.equal(dialogs.length, 0);
  await quote().fill("  새 주장 인용\n보존할 원문  ");
  await control("확인 담당자 (수동 기록)").fill("  합성 담당자  ");
  await control("기업·기간·단위·범위 해석 메모").fill("  확인 범위\n남는 메모  ");
  await numeric().selectOption(company.numericChecks[0].id);
  await choose(sections(), sectionB, sectionMessage, "dismiss");
  assert.equal(await sections().inputValue(), sectionA);
  assert.equal(await quote().inputValue(), "  새 주장 인용\n보존할 원문  ");
  await unchanged();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("section-kept", quote());
  await choose(sections(), sectionB, sectionMessage, "accept");
  assert.equal(await quote().inputValue(), "");
  assert.equal(await sections().inputValue(), sectionB);
  const noExtra = dialogs.length;
  await sections().selectOption(sectionA);
  assert.equal(dialogs.length, noExtra);
  await quote().fill(" \n ");
  await choose(sections(), "", sectionMessage, "dismiss");
  assert.equal(await quote().inputValue(), " \n ");
  await choose(sections(), "", sectionMessage, "accept");
  assert.equal(await sections().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  await unchanged();
  record(
    "Section change and unlink ask before clearing normal or whitespace-only claim quote; rejection preserves exact input, acceptance clears only the prior quote, and empty-quote change needs no confirmation",
  );

  await sections().selectOption(sectionA);
  await reviews().selectOption(decisionId);
  await choose(plans(), planB.id, planMessage, "dismiss");
  assert.equal(await plans().inputValue(), planA.id);
  assert.deepEqual(await selectValues(reviews()), [decisionId]);
  assert.equal(await quote().inputValue(), "");
  await shot("review-kept", reviews());
  await choose(plans(), planB.id, planMessage, "accept");
  assert.equal(await plans().inputValue(), planB.id);
  assert.equal(await sections().inputValue(), "");
  assert.deepEqual(await selectValues(reviews()), []);
  assert.deepEqual(await selectValues(numeric()), [company.numericChecks[0].id]);
  await unchanged();
  const blankVersionCount = dialogs.length;
  await plans().selectOption(planA.id);
  assert.equal(dialogs.length, blankVersionCount);
  await sections().selectOption(sectionA);
  await reviews().selectOption(decisionId);
  await quote().fill("  버전 변경 전\n남겨 둔 주장  ");
  await choose(plans(), "", planMessage, "dismiss");
  assert.equal(await plans().inputValue(), planA.id);
  assert.equal(await quote().inputValue(), "  버전 변경 전\n남겨 둔 주장  ");
  assert.deepEqual(await selectValues(reviews()), [decisionId]);
  await choose(plans(), "", planMessage, "accept");
  assert.equal(await plans().inputValue(), "");
  assert.equal(await quote().inputValue(), "");
  assert.equal(await sections().inputValue(), "");
  assert.deepEqual(await selectValues(reviews()), []);
  await unchanged();
  record(
    "Version change protects a selected review reference even with an empty quote; acceptance clears quote/review links and resets the new-claim section while preserving numeric references and other inputs",
  );

  nextDialog = "accept";
  const cancelCount = dialogs.length;
  await editor.getByRole("button", { name: "편집 취소", exact: true }).click();
  assert.equal(dialogs.length, cancelCount + 1);
  assert.deepEqual(dialogs.at(-1), {
    message: "저장하지 않은 주장 검토 편집을 취소할까요?",
    action: "accept",
  });
  await panel
    .getByRole("button", { name: "이 주장 v1에서 새 검토 버전 작성", exact: true })
    .click();
  editor = panel.getByRole("group", {
    name: "기존 주장 새 버전 · 판단 미검토로 시작",
    exact: true,
  });
  assert.equal(await sections().isDisabled(), true);
  assert.equal(await sections().inputValue(), sectionA);
  const savedQuote = company.claimReviews[0].claimQuote;
  assert.equal(await quote().inputValue(), savedQuote);
  await control("확인 담당자 (수동 기록)").fill("  합성 담당자  ");
  await control("기업·기간·단위·범위 해석 메모").fill("  확인 범위\n남는 메모  ");
  await reviews().selectOption(decisionId);
  await control("이번 버전의 담당자 판단").selectOption("insufficient");
  await control("판단자").fill("  판단 담당자  ");
  await control("판단 이유").fill("  판단 원문\n보존  ");
  await control("판단 확인일 (직접 입력)").fill("2026-10-12");
  await choose(plans(), planB.id, planMessage, "dismiss");
  assert.equal(await quote().inputValue(), savedQuote);
  assert.equal(await plans().inputValue(), planA.id);
  assert.deepEqual(await selectValues(reviews()), [decisionId]);
  assert.equal(await control("이번 버전의 담당자 판단").inputValue(), "insufficient");
  assert.equal(await control("판단자").inputValue(), "  판단 담당자  ");
  assert.equal(await control("판단 이유").inputValue(), "  판단 원문\n보존  ");
  assert.equal(await control("판단 확인일 (직접 입력)").inputValue(), "2026-10-12");
  await unchanged();
  await shot("existing-kept", quote());
  await choose(plans(), planB.id, planMessage, "accept");
  assert.equal(await sections().inputValue(), sectionA);
  assert.equal(await sections().isDisabled(), true);
  assert.equal(await quote().inputValue(), "");
  assert.deepEqual(await selectValues(reviews()), []);
  assert.equal(await control("이번 버전의 담당자 판단").inputValue(), "unreviewed");
  for (const label of ["판단자", "판단 이유", "판단 확인일 (직접 입력)"])
    assert.equal(await control(label).inputValue(), "");
  await unchanged();
  await shot("existing-changed", quote());
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  assert.equal(dialogs.length, 11);
  record(
    "An existing claim keeps its fixed section key; rejecting a version change preserves quote, review link and full judgement, while acceptance uses the original judgement reset without saving or changing the stored company",
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
          "claim plan and section transition guards; synthetic versions/review links, fixed existing claim; no API mutation",
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
