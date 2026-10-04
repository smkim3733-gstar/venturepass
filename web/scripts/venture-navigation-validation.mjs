import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// This acceptance run uses the actual production UI/API and a new synthetic data directory.
// The explicit build must be a current, environment-free build:local staging directory.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/venture-navigation-validation.mjs <build:local staging>",
);
const staging = await realpath(process.argv[2]);
const relativeBuild = path.relative(temporaryRoot, staging);
assert.ok(relativeBuild && !relativeBuild.startsWith("..") && !path.isAbsolute(relativeBuild));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(
  !(await readdir(staging)).some((name) => name.startsWith(".env")),
  "No environment files allowed",
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function compareTree(relative) {
  const entry = path.join(app, relative);
  for (const item of await readdir(entry, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), "Source symlinks are not allowed");
    const child = path.join(relative, item.name);
    if (item.isDirectory()) await compareTree(child);
    else
      assert.equal(
        digest(await readFile(path.join(staging, child))),
        digest(await readFile(path.join(app, child))),
        "Stale build source: " + child,
      );
  }
}
await compareTree("src");
await compareTree("public");
for (const name of ["next.config.ts", "package.json", "pnpm-lock.yaml"]) {
  assert.equal(
    digest(await readFile(path.join(staging, name))),
    digest(await readFile(path.join(app, name))),
    "Stale build input: " + name,
  );
}
const buildId = (await readFile(path.join(staging, ".next/BUILD_ID"), "utf8")).trim();
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-venture-navigation-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==="string"||input instanceof URL?input:input.url);if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname)){process.stderr.write("EXTERNAL_FETCH_BLOCKED\n");throw Error("External fetch forbidden");}return original(input,init);};`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
environment.OPENAI_API_KEY = "";
environment.KOSIS_API_KEY = "";
environment.OPENAI_MODEL = "synthetic-model";
delete environment.NODE_OPTIONS;
const nextCli = path.join(staging, "node_modules/next/dist/bin/next");
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = "http://127.0.0.1:" + port;
let child, context, page;
const logs = [],
  errors = [],
  externalRequests = [],
  checks = [];
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
async function start() {
  child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(guard).href,
      nextCli,
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: staging,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.on("data", (bytes) => logs.push(bytes.toString()));
  child.stderr.on("data", (bytes) => logs.push(bytes.toString()));
  let startupError;
  child.once("error", (error) => {
    startupError = error;
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error("Server exited: " + logs.join(""));
    try {
      const response = await fetch(origin + "/api/studio/status");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Isolated server did not become ready");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const owned = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned server failed to stop")), 10000);
    owned.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    owned.kill();
  });
}
async function api(url, options = {}) {
  const response = await context.request.fetch(origin + url, options);
  assert.ok(response.ok(), response.status() + " " + (await response.text()));
  return response;
}

// Synthetic-only imports. This script never reads the customer's database or .env files.
const sourceRoot = pathToFileURL(path.join(app, "src") + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && context.parentURL?.startsWith(sourceRoot)) {
        const target = new URL(`${specifier}.ts`, context.parentURL);
        if (target.href.startsWith(sourceRoot) && existsSync(target))
          return { url: target.href, shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith(".ts")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { StudioStore } = await import("../src/lib/studio-storage.ts");
const { caseSchema, emptyProfile } = await import("../src/lib/studio-schema.ts");
const { deriveGuidedFlow } = await import("../src/lib/studio-guided-flow.ts");
const { publicEvidenceExportFixture } =
  await import("../src/lib/studio-public-evidence-export-test-helpers.ts");
function fixture(name) {
  const { record: c, plan: p } = publicEvidenceExportFixture();
  c.profile = { ...emptyProfile(), companyName: name, businessNumber: "1234567890" };
  c.sources = [];
  c.stage = "preparing";
  c.tasks = [];
  p.confirmedAt = "2026-10-05T00:00:00.000Z";
  p.sourceRevision = c.revision;
  p.content.sections.forEach((s) => {
    s.needsConfirmation = false;
    s.evidence = [];
  });
  const candidate = {
    id: p.candidateId,
    title: "합성 방향",
    problem: "합성 문제",
    solution: "합성 해결",
    targetCustomer: "합성 고객",
    differentiation: "합성 차이",
    stage: "개발",
    businessModel: "합성 수익",
    recommendation: "합성 추천",
    evidence: [],
    gaps: [],
  };
  c.analysis = {
    summary: "합성 분석",
    facts: [],
    candidates: [candidate],
    questions: [],
    warnings: [],
    generatedAt: "2026-10-04T00:00:00.000Z",
    mode: "assisted",
    sourceRevision: c.revision,
  };
  c.selectedCandidateId = candidate.id;
  c.candidateSelections = [
    {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      recordedAt: "2026-10-04T00:00:00.000Z",
      origin: "manual",
      event: "selection",
      reason: "시험 설정",
      previousCandidateId: null,
      candidateId: candidate.id,
      analysisGeneratedAt: c.analysis.generatedAt,
      analysisSourceRevision: c.revision,
      analysisMode: "assisted",
      analysisDigest: "a".repeat(64),
      candidateDigest: "a".repeat(64),
      candidate,
      previousCandidate: null,
      previousContext: "none",
      previousRecordId: null,
    },
  ];
  const value = caseSchema.parse(c);
  assert.equal(deriveGuidedFlow(value).planReady, true);
  return value;
}
const first = fixture("합성 벤처인 연결 A"),
  second = fixture("합성 벤처인 연결 B");
const unready = fixture("합성 내부 확인 전");
unready.plans[0].confirmedAt = null;
const followup = fixture("합성 기관 결과 대기");
followup.stage = "evaluating";
const fixtures = [first, second, unready, followup];
const bootstrap = new StudioStore(dataDirectory);
bootstrap.close();
const databaseFile = path.join(dataDirectory, "studio.sqlite");
const db = new DatabaseSync(databaseFile);
try {
  for (const c of fixtures)
    db.prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)").run(
      c.id,
      c.revision,
      c.revision,
      JSON.stringify(c),
    );
} finally {
  db.close();
}
function rows() {
  const d = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return [
      "studio_cases",
      "venture_accounts",
      "venture_workflows",
      "studio_prepared_packages",
    ].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  } finally {
    d.close();
  }
}
const seedWorkflow = new StudioStore(dataDirectory);
try {
  seedWorkflow.saveVentureWorkflowEnvelope(
    second.id,
    0,
    JSON.stringify({
      snapshot: null,
      draft: null,
      history: [],
      execution: {
        id: randomUUID(),
        snapshotId: "past-synthetic-screen",
        status: "stopped",
        startedAt: "2026-10-05T00:00:00.000Z",
        finishedAt: null,
        completedFieldKeys: [],
        attachmentFieldKeys: [],
        attemptedFieldKey: "description",
        code: "INPUT_RESULT_UNKNOWN",
      },
    }),
  );
} finally {
  seedWorkflow.close();
}
const initialRows = rows(),
  writes = [],
  overviewReads = [];
const panel = () => page.getByRole("region", { name: "벤처인 연결 기록 요약" });
async function openCompany(c) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: c.profile.companyName }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "신청·진행" })
    .click();
}
const overviewPath = (c) => `**/api/studio/cases/${c.id}/venturein/overview`;
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== origin) {
      externalRequests.push(req.url());
      return route.abort();
    }
    if (!["GET", "HEAD"].includes(req.method())) writes.push(req.method() + " " + req.url());
    if (req.url().endsWith("/venturein/overview")) overviewReads.push(req.url());
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => {
    errors.push("Unexpected dialog");
    await d.dismiss();
  });

  await openCompany(first);
  const firstEntry = panel().getByRole("button", { name: "벤처인 연결 준비", exact: true });
  await firstEntry.evaluate((e) => {
    e.click();
    e.click();
  });
  const arrival = () => page.getByRole("region", { name: "간단 화면에서 이어가기" });
  async function focused(section) {
    await page.waitForFunction(
      (s) => document.activeElement?.getAttribute("data-venture-section") === s,
      section,
    );
  }
  await arrival().waitFor();
  await focused("account");
  assert.ok((await arrival().innerText()).includes(first.profile.companyName));
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "actual local records bind guided entry to account section; duplicate entry performs no login or writes",
  );

  await openCompany(second);
  await panel().getByRole("button", { name: "이전 입력 결과 확인", exact: true }).click();
  await arrival().waitFor();
  await focused("execution");
  await page.getByText("입력·첨부 결과 미확인", { exact: true }).waitFor();
  assert.ok((await arrival().innerText()).includes(second.profile.companyName));
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "stored unknown execution takes priority after lost session; opens original result without another request",
  );

  const base = await (await api("/api/studio/cases/" + first.id + "/venturein/overview")).json();
  const baseConnection = await (await api("/api/studio/cases/" + first.id + "/venturein")).json();
  const baseWorkflow = await (
    await api("/api/studio/cases/" + first.id + "/venturein/workflow")
  ).json();
  const time = "2026-10-05T00:00:00.000Z";
  const connection = {
    ...baseConnection,
    account: { saved: true, revision: 2, maskedLoginId: "synthetic***", updatedAt: time },
    session: {
      state: "connected_unmapped",
      startedAt: time,
      updatedAt: time,
      message: "합성 화면 연결",
    },
  };
  const field = {
    key: "description",
    kind: "textarea",
    type: "textarea",
    id: "description",
    name: "description",
    labels: ["합성 사업 설명"],
    required: false,
    maxLength: null,
    accept: null,
    multiple: false,
    disabled: false,
    readOnly: false,
    options: [],
  };
  const workflow = {
    ...baseWorkflow,
    revision: 3,
    accountRevision: 2,
    session: connection.session,
    snapshot: {
      caseId: first.id,
      accountRevision: 2,
      sessionStartedAt: time,
      screen: {
        id: "synthetic-screen",
        observedAt: time,
        url: "https://www.smes.go.kr/venturein/aply/v2",
        title: "합성 신청 화면",
        companyEvidence: [],
        fields: [field],
        warnings: [],
        truncated: false,
      },
    },
    journey: { phase: "map", message: "합성 항목 연결", entries: [] },
  };
  const overview = {
    ...base,
    accountSaved: true,
    accountRevision: 2,
    workflowRevision: 3,
    sessionState: connection.session.state,
    sessionUpdatedAt: time,
    screenObservedAt: time,
    phase: "map",
  };
  const connectionPath = "**/api/studio/cases/" + first.id + "/venturein";
  const workflowPath = "**/api/studio/cases/" + first.id + "/venturein/workflow";
  const fulfill = (r, data) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  await page.route(connectionPath, (r) => fulfill(r, connection));
  await page.route(overviewPath(first), (r) => fulfill(r, overview));
  await page.route(workflowPath, (r) => fulfill(r, workflow));
  await openCompany(first);
  await panel().getByRole("button", { name: "항목·첨부 연결 확인", exact: true }).click();
  await arrival().waitFor();
  await focused("mapping");
  await page.getByRole("region", { name: "신청 항목과 원고 연결" }).waitFor();
  assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "matching synthetic connected records focus existing mapping with no inspect, preview, save, approval or execution",
  );

  // The bookmark never adapts to different records. Existing controls keep their independent checks.
  for (const changed of [
    { revision: 4 },
    { accountRevision: 3 },
    { report: { ...workflow.report, caseId: second.id } },
  ]) {
    await page.unroute(workflowPath);
    await page.route(workflowPath, (r) => fulfill(r, { ...workflow, ...changed }));
    await openCompany(first);
    await panel().getByRole("button", { name: "항목·첨부 연결 확인", exact: true }).click();
    await arrival().getByRole("alert").waitFor();
    assert.ok((await arrival().innerText()).includes("이전 안내로 이동하지 않습니다"));
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-venture-section")),
      null,
    );
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "workflow/account/company changes refuse earlier destination without updating the bookmark",
  );

  await page.unroute(workflowPath);
  let release, started, handled;
  const began = new Promise((r) => {
    started = r;
  });
  const held = new Promise((r) => {
    release = r;
  });
  const completed = new Promise((r) => {
    handled = r;
  });
  await page.route(workflowPath, async (r) => {
    started();
    await held;
    try {
      await fulfill(r, workflow);
    } catch {
    } finally {
      handled();
    }
  });
  await openCompany(first);
  await panel().getByRole("button", { name: "항목·첨부 연결 확인", exact: true }).click();
  await began;
  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  await page.getByRole("button", { name: "기업 목록", exact: false }).click();
  await page.getByRole("button").filter({ hasText: second.profile.companyName }).first().click();
  release();
  await completed;
  await page.unroute(workflowPath);
  await page.unroute(connectionPath);
  await page.unroute(overviewPath(first));
  await panel().getByRole("button", { name: "이전 입력 결과 확인", exact: true }).waitFor();
  assert.equal(await arrival().count(), 0);
  await panel().getByRole("button", { name: "이전 입력 결과 확인", exact: true }).click();
  await arrival().waitFor();
  await focused("execution");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "navigation-390.png"), fullPage: true });
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  await stop();
  await start();
  await openCompany(second);
  assert.equal(await arrival().count(), 0);
  await panel().getByRole("button", { name: "이전 입력 결과 확인", exact: true }).click();
  await arrival().waitFor();
  await focused("execution");
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "closing and company switch ignore late workflow; 390px and restart retain original unknown record with zero writes",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        syntheticCases: 4,
        uiWrites: writes,
        actualExternalRequests: 0,
        actualAiCalls: 0,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, buildId, checks: checks.length }));
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 7000),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
