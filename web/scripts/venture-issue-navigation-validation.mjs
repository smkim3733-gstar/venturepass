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
const scenario = "venture-issue-navigation";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/venturein-workflow-panel.tsx",
  "src/components/studio/venturein-issue-navigation.ts",
  "scripts/fixtures/claim-review-receipt.ts",
  "scripts/venture-issue-navigation-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-venture-issue-ui-"));
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
company.profile.companyName = "합성 신청 준비 항목 이동 기업";
company.sources.push({
  id: fixture.agencyId(590),
  name: "합성 연결 자료",
  originalName: "합성 연결 자료.pdf",
  kind: "technology",
  text: "실제 원본이 없는 화면 대조용 합성 자료",
  mimeType: "application/pdf",
  extraction: "local",
  warnings: [],
  createdAt: "2026-10-14T01:00:00.000Z",
  updatedAt: "2026-10-14T01:00:00.000Z",
});
const latestPlan = company.plans.at(-1);
const time = "2026-10-14T01:00:00.000Z";
const connection = {
  account: { saved: true, revision: 2, maskedLoginId: "synthetic***", updatedAt: time },
  session: {
    state: "connected_unmapped",
    startedAt: time,
    updatedAt: time,
    message: "합성 연결 상태",
  },
  preparation: {
    planId: latestPlan.id,
    planVersion: latestPlan.version,
    planTitle: latestPlan.content.title,
    sections: latestPlan.content.sections,
    attachments: [],
    blockers: [],
  },
  credentialStorage: "unavailable",
  automaticSubmissionAvailable: false,
};
const field = (key, kind = "textarea") => ({
  key,
  kind,
  type: kind,
  id: key,
  name: key,
  labels: [kind === "file" ? "합성 첨부" : "같은 합성 항목"],
  required: true,
  maxLength: null,
  accept: kind === "file" ? ".pdf" : null,
  multiple: false,
  disabled: false,
  readOnly: false,
  options: [],
});
const textA = field("first"),
  textB = field("second"),
  fileA = field("file", "file");
const unsupported = {
  ...field("agreement"),
  kind: "input",
  type: "checkbox",
  labels: ["합성 동의"],
};
const issues = [
  {
    code: "REQUIRED_FIELD_UNMAPPED",
    severity: "error",
    fieldKey: "first",
    message: "첫 번째 합성 항목 연결 필요",
  },
  {
    code: "MAPPING_UNCONFIRMED",
    severity: "error",
    fieldKey: "second",
    message: "둘째 합성 항목의 연결 확인 필요",
  },
  {
    code: "REQUIRED_FIELD_UNMAPPED",
    severity: "error",
    fieldKey: "file",
    message: "합성 첨부 원본 연결 필요",
  },
  {
    code: "AGREEMENT_REQUIRES_USER",
    severity: "warning",
    fieldKey: "agreement",
    message: "합성 동의 직접 확인",
  },
  { code: "UNKNOWN_FIELD", severity: "error", fieldKey: "gone", message: "사라진 합성 항목" },
  { code: "PLAN_UNCONFIRMED", severity: "warning", message: "원고 검토 필요" },
];
const workflow = {
  revision: 3,
  updatedAt: time,
  accountRevision: 2,
  session: connection.session,
  snapshot: {
    caseId: company.id,
    accountRevision: 2,
    sessionStartedAt: time,
    screen: {
      id: "synthetic-screen",
      observedAt: time,
      url: "https://www.smes.go.kr/venturein/aply/v2",
      title: "합성 신청 화면",
      companyEvidence: [],
      fields: [textA, fileA, textB, unsupported],
      warnings: [],
      truncated: false,
    },
  },
  draft: {
    caseId: company.id,
    snapshotId: "synthetic-screen",
    sessionStartedAt: time,
    accountRevision: 2,
    companyRevision: company.revision,
    planId: latestPlan.id,
    planVersion: latestPlan.version,
    textMappings: [
      { fieldKey: "second", source: { kind: "profile", property: "customers" }, confirmed: false },
    ],
    attachmentMappings: [],
  },
  report: {
    scope: "local-preflight",
    caseId: company.id,
    snapshotId: "synthetic-screen",
    planId: latestPlan.id,
    readyForLocalReview: false,
    automaticSubmissionAvailable: false,
    companyVerification: null,
    inputReadiness: { ready: false, blockingIssues: [issues[1]], deferredIssues: [] },
    issues,
    textFields: [],
    attachments: [],
  },
  originalFiles: [
    {
      sourceId: company.sources[0].id,
      exists: true,
      originalName: company.sources[0].originalName,
      sizeBytes: 123,
      mimeType: "application/pdf",
    },
  ],
  execution: null,
  journey: { phase: "review", message: "합성 점검 보완", entries: [] },
};
const originalWorkflow = structuredClone(workflow);
let connectionReads = 0,
  workflowReads = 0;
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
        if (u.pathname === "/api/studio/cases/" + company.id + "/venturein") {
          connectionReads++;
          return reply(connection);
        }
        if (u.pathname === "/api/studio/cases/" + company.id + "/venturein/workflow") {
          workflowReads++;
          return reply(workflow);
        }
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
  await page.getByRole("tab", { name: /벤처인 연결/ }).click();
  await page.waitForFunction(() => document.querySelector("#venture-text-1")?.matches(":enabled"));
  const review = page.getByRole("region", {
    name: "선택 입력 준비와 전체 제출 전 점검",
    exact: true,
  });
  const selected = page.getByRole("region", { name: "선택 항목 입력 준비", exact: true });
  const firstIssue = review
    .getByRole("listitem")
    .filter({ hasText: "첫 번째 합성 항목 연결 필요" });
  const fileIssue = review.getByRole("listitem").filter({ hasText: "합성 첨부 원본 연결 필요" });
  const state = () =>
    page
      .locator(
        '[aria-label="신청서와 첨부자료 연결"] select, [aria-label="신청서와 첨부자료 연결"] input',
      )
      .evaluateAll((nodes) => nodes.map((n) => ({ id: n.id, value: n.value, checked: n.checked })));
  const focus = async (id) => page.waitForFunction((id) => document.activeElement?.id === id, id);
  const initial = await state();
  const beforeReads = { connectionReads, workflowReads, caseReads };
  for (const section of ["mapping", "attachments"])
    await page.locator('details[data-venture-disclosure="' + section + '"] > summary').click();
  const secondJump = selected.getByRole("button", {
    name: "같은 합성 항목 연결 항목 확인",
    exact: true,
  });
  await secondJump.focus();
  await secondJump.press("Enter");
  await focus("venture-text-1");
  assert.equal(
    await page.locator('details[data-venture-disclosure="mapping"]').getAttribute("open"),
    "",
  );
  assert.equal(
    await page.locator('details[data-venture-disclosure="attachments"]').getAttribute("open"),
    null,
  );
  assert.deepEqual(await state(), initial);
  for (const message of ["합성 동의 직접 확인", "사라진 합성 항목", "원고 검토 필요"])
    assert.equal(
      await review.getByRole("listitem").filter({ hasText: message }).getByRole("button").count(),
      0,
    );
  record(
    "Keyboard Enter opens the exact second field with identical labels; unsupported, missing and global issues do not target another input; no edits or API calls",
  );

  await firstIssue.getByRole("button").click();
  await focus("venture-text-0");
  await page.locator("#venture-text-0").selectOption("profile:companyName");
  await page.locator("#venture-text-0").locator("..").getByRole("checkbox").check();
  const dirtyState = await state();
  await page.locator('details[data-venture-disclosure="mapping"] > summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  const fileJump = fileIssue.getByRole("button");
  await fileJump.focus();
  await fileJump.press("Space");
  await focus("venture-file-0");
  assert.deepEqual(await state(), dirtyState);
  await page.waitForFunction(() => {
    const r = document.querySelector("#venture-file-0").getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await page.screenshot({ path: path.join(output, "attachment-mobile.png") });
  await page.locator("#venture-file-0").selectOption(company.sources[0].id);
  const bothDirty = await state();
  await secondJump.click();
  await focus("venture-text-1");
  assert.deepEqual(await state(), bothDirty);
  assert.equal(
    await review.getByRole("button", { name: "연결 저장하고 점검", exact: true }).isEnabled(),
    true,
  );
  record(
    "390px keyboard Space opens attachment selection, preserves unsaved text/confirmation and file choices, and returns to the exact text field without saving",
  );

  await page.locator("#venture-login-id").fill("  synthetic-unsaved-id  ");
  assert.equal(await secondJump.isDisabled(), true);
  assert.equal(await firstIssue.getByRole("button").isDisabled(), true);
  assert.equal(await fileJump.isDisabled(), true);
  assert.deepEqual(await state(), bothDirty);
  await page.locator("#venture-login-id").fill("");
  assert.equal(await secondJump.isEnabled(), true);
  await secondJump.click();
  await focus("venture-text-1");
  assert.deepEqual(await state(), bothDirty);
  assert.deepEqual({ connectionReads, workflowReads, caseReads }, beforeReads);
  assert.deepEqual(companies, original);
  assert.deepEqual(workflow, originalWorkflow);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(commands, []);
  record(
    "Unsaved account edits block navigation until cleared; all pending choices and stored company/workflow remain unchanged with zero business writes",
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
          "synthetic saved preflight issues, exact local mapping navigation, unsaved choices preserved",
        syntheticConnectionGets: connectionReads,
        syntheticWorkflowGets: workflowReads,
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
