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
  "Usage: node scripts/venture-disclosure-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-venture-disclosure-"));
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
first.sources = [publicEvidenceExportFixture().record.sources[0]];
first.sources[0].updatedAt = first.plans[0].generatedAt;
caseSchema.parse(first);
assert.equal(deriveGuidedFlow(first).planReady, true);
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
  let expectedDialog = false;
  let dialogCount = 0;
  page.on("dialog", async (d) => {
    if (!expectedDialog) errors.push("Unexpected dialog");
    else dialogCount++;
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
  const disclosure = (name) => page.locator(`details[data-venture-disclosure="${name}"]`);
  async function openSections() {
    return page.locator("details[data-venture-disclosure]").evaluateAll((nodes) =>
      nodes
        .filter((node) => node.open)
        .map((node) => node.dataset.ventureDisclosure)
        .sort(),
    );
  }
  assert.deepEqual(await openSections(), ["account"]);
  const login = page.locator("#venture-login-id");
  const password = page.locator("#venture-password");
  await login.fill("synthetic-not-saved");
  await password.fill("synthetic-password-not-saved");
  const loginNode = await login.elementHandle();
  const passwordNode = await password.elementHandle();
  await disclosure("account").locator("summary").first().click();
  assert.deepEqual(await openSections(), []);
  assert.equal(await login.inputValue(), "synthetic-not-saved");
  assert.ok(
    (await disclosure("account").locator("summary").innerText()).includes("미저장 입력 있음"),
  );
  await disclosure("account").locator("summary").first().focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await openSections(), ["account"]);
  assert.equal(
    await loginNode.evaluate((e) => e === document.querySelector("#venture-login-id")),
    true,
  );
  assert.equal(
    await passwordNode.evaluate((e) => e === document.querySelector("#venture-password")),
    true,
  );
  assert.equal(await password.inputValue(), "synthetic-password-not-saved");
  expectedDialog = true;
  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#venture-login-id")?.value === "synthetic-not-saved",
  );
  assert.equal(dialogCount, 1);
  expectedDialog = false;
  await arrival().getByRole("button", { name: "모든 단계 펼치기", exact: true }).click();
  assert.equal((await openSections()).length, 8);
  assert.equal(await login.inputValue(), "synthetic-not-saved");
  await login.fill("");
  await password.fill("");
  assert.equal((await openSections()).length, 8);
  assert.ok((await arrival().innerText()).includes(first.profile.companyName));
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "account-only entry; keyboard/native toggles and expand-all preserve identical input DOM, dirty guard and values; no writes",
  );

  await openCompany(second);
  await panel().getByRole("button", { name: "이전 입력 결과 확인", exact: true }).click();
  await arrival().waitFor();
  await focused("execution");
  assert.deepEqual(await openSections(), ["execution"]);
  const executionNode = await page.locator('[data-venture-section="execution"]').elementHandle();
  await disclosure("execution").locator("summary").first().click();
  assert.deepEqual(await openSections(), []);
  assert.ok(
    (await disclosure("execution").locator("summary").innerText()).includes("이전 결과 확인 필요"),
  );
  await disclosure("execution").locator("summary").first().click();
  assert.equal(
    await executionNode.evaluate(
      (e) => e === document.querySelector('[data-venture-section="execution"]'),
    ),
    true,
  );
  await page.getByText("입력·첨부 결과 미확인", { exact: true }).waitFor();
  assert.ok((await arrival().innerText()).includes(second.profile.companyName));
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "unknown execution opens independently; collapse retains original record and visible uncertainty summary with no new request",
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
  const fileField = {
    ...field,
    key: "attachment",
    kind: "file",
    type: "file",
    id: "attachment",
    name: "attachment",
    labels: ["합성 첨부"],
    accept: ".pdf",
    multiple: true,
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
        fields: [field, fileField],
        warnings: [],
        truncated: false,
      },
    },
    originalFiles: [
      {
        sourceId: first.sources[0].id,
        exists: true,
        originalName: "합성 원본.pdf",
        sizeBytes: 123,
        mimeType: "application/pdf",
      },
    ],
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

  assert.deepEqual(await openSections(), ["attachments", "mapping"]);
  const mapping = page.getByRole("region", { name: "신청 항목과 원고 연결" });
  await mapping.locator("select").selectOption("profile:companyName");
  await mapping.locator('input[type="checkbox"]').check();
  const selectNode = await mapping.locator("select").elementHandle();
  const checkNode = await mapping.locator('input[type="checkbox"]').elementHandle();
  const files = page.getByRole("region", { name: "첨부 항목과 원본 연결" });
  await files.locator("select").selectOption(first.sources[0].id);
  await files.locator('input[type="checkbox"]').check();
  const fileNodes = await files.locator('input[type="checkbox"]').elementHandles();
  await disclosure("mapping").locator("summary").first().click();
  await disclosure("attachments").locator("summary").first().click();
  assert.deepEqual(await openSections(), []);
  await page.getByText("저장하지 않은 항목·첨부 연결이 있습니다.", { exact: false }).waitFor();
  await disclosure("review").locator("summary").first().click();
  assert.deepEqual(await openSections(), ["review"]);
  await disclosure("mapping").locator("summary").first().click();
  await disclosure("attachments").locator("summary").first().click();
  assert.equal(await mapping.locator("select").inputValue(), "profile:companyName");
  assert.equal(await mapping.locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(
    await selectNode.evaluate((e) => e.isConnected && e.value === "profile:companyName"),
    true,
  );
  assert.equal(await checkNode.evaluate((e) => e.isConnected && e.checked), true);
  assert.equal(await fileNodes[0].evaluate((e) => e.isConnected && e.checked), true);
  assert.equal(await files.locator("select").inputValue(), first.sources[0].id);
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "mapping and attachment selections/confirmations survive collapse and unrelated rerenders; dirty warning remains visible; writes zero",
  );

  await page.getByRole("button", { name: "변경 취소", exact: true }).click();
  await page
    .getByText("저장하지 않은 항목·첨부 연결이 있습니다.", { exact: false })
    .waitFor({ state: "hidden" });

  // A synthetic prepared-package comparison and review exercise the real approval component.
  // Routes below return fixtures; no official screen is read and execute is never permitted.
  const mockReviewActions = [];
  const currentPlan = first.plans.at(-1);
  const selectedText = [
    {
      fieldKey: field.key,
      label: field.labels[0],
      source: { kind: "profile", property: "companyName" },
      value: first.profile.companyName,
      characterCount: first.profile.companyName.length,
      maxLength: null,
      required: false,
      confirmed: true,
    },
  ];
  const readyWorkflow = {
    ...workflow,
    draft: {
      caseId: first.id,
      snapshotId: workflow.snapshot.screen.id,
      sessionStartedAt: time,
      accountRevision: 2,
      companyRevision: first.revision,
      planId: currentPlan.id,
      planVersion: currentPlan.version,
      textMappings: [{ fieldKey: field.key, source: selectedText[0].source, confirmed: true }],
      attachmentMappings: [],
    },
    report: {
      ...workflow.report,
      textFields: selectedText,
      attachments: [],
      inputReadiness: { ready: true, blockingIssues: [], deferredIssues: [] },
    },
    journey: { phase: "execute", message: "합성 검토 준비", entries: [] },
  };
  const selected = {
    id: randomUUID(),
    version: 1,
    caseId: first.id,
    caseRevision: first.revision,
    clientRequestId: randomUUID(),
    createdAt: time,
    scope: "local-preparation-only",
    planId: currentPlan.id,
    planVersion: currentPlan.version,
    planTitle: currentPlan.content.title,
    planContentSha256: digest(JSON.stringify(currentPlan.content)),
    sourceIds: [],
    zipSha256: digest("synthetic package"),
    sizeBytes: 200,
    draft: true,
    draftReasons: ["합성 준비본"],
    storedReviewCount: 0,
    currentRuleReviewCount: 0,
    confirmedAt: null,
  };
  const binding = {
    version: 1,
    scope: "selected-prepared-fields",
    caseId: first.id,
    companyRevision: first.revision,
    package: {
      id: selected.id,
      version: 1,
      caseRevision: first.revision,
      createdAt: time,
      zipSha256: selected.zipSha256,
      zipSizeBytes: 200,
    },
    plan: {
      id: selected.planId,
      version: selected.planVersion,
      contentSha256: selected.planContentSha256,
    },
    targets: [
      {
        kind: "text",
        fieldKey: field.key,
        source: selectedText[0].source,
        characterCount: selectedText[0].characterCount,
        valueSha256: digest(selectedText[0].value),
      },
    ],
  };
  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sorted(value[key])]),
      );
    return value;
  }
  const bindingDigest = digest(JSON.stringify(sorted(binding)));
  const comparisonContext = {
    caseId: first.id,
    workflowRevision: 3,
    companyRevision: first.revision,
    accountRevision: 2,
    snapshotId: workflow.snapshot.screen.id,
    sessionStartedAt: time,
  };
  const comparison = {
    ...comparisonContext,
    preparedPackage: selected,
    result: {
      scope: "selected-prepared-fields",
      matched: true,
      issues: [],
      packageDraft: true,
      companyRevisionChanged: false,
      binding,
      digest: bindingDigest,
    },
  };
  const review = {
    ...comparisonContext,
    scope: "selected-fields",
    submissionReady: false,
    remainingIssues: [],
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    destination: workflow.snapshot.screen.url,
    companyName: first.profile.companyName,
    fields: selectedText,
    fieldCount: 1,
    attachments: [],
    attachmentCount: 0,
    totalAttachmentBytes: 0,
    preparedPackage: {
      binding,
      digest: bindingDigest,
      packageDraft: true,
      companyRevisionChanged: false,
    },
  };
  const packagePath = "**/api/studio/cases/" + first.id + "/prepared-packages";
  const executionPath = workflowPath + "/execution";
  await page.unroute(workflowPath);
  await page.unroute(overviewPath(first));
  await page.route(workflowPath, (r) => fulfill(r, readyWorkflow));
  await page.route(overviewPath(first), (r) => fulfill(r, { ...overview, phase: "execute" }));
  await page.route(packagePath, (r) =>
    fulfill(r, { caseId: first.id, caseRevision: first.revision, packages: [selected] }),
  );
  await page.route(executionPath, (r) => {
    const action = r.request().postDataJSON().action;
    mockReviewActions.push(action);
    assert.ok(["compare-prepared-package", "prepare"].includes(action), "No execution allowed");
    return fulfill(r, action === "prepare" ? { review } : { preparedComparison: comparison });
  });
  await openCompany(first);
  await panel().getByRole("button").filter({ hasText: "입력" }).click();
  await arrival().waitFor();
  await focused("execution");
  assert.deepEqual(await openSections(), ["execution"]);
  await page.getByRole("button", { name: "준비본 목록 읽기", exact: true }).click();
  await disclosure("execution").locator("select").selectOption(selected.id);
  await page.getByRole("button", { name: "준비본과 선택 항목 대조", exact: true }).click();
  await page.getByRole("button", { name: "입력·첨부 검토안 준비", exact: true }).click();
  const approval = page.getByRole("region", { name: "공식 화면 입력·첨부 승인", exact: true });
  await approval.waitFor();
  await approval.locator('input[type="checkbox"]').check();
  const approvedNode = await approval.locator('input[type="checkbox"]').elementHandle();
  const reviewText = await approval.innerText();
  const beforeToggleActions = [...mockReviewActions];
  await disclosure("execution").locator("summary").first().click();
  await disclosure("account").locator("summary").first().click();
  await disclosure("account").locator("summary").first().click();
  await disclosure("execution").locator("summary").first().click();
  assert.equal(await approval.innerText(), reviewText);
  assert.equal(await approvedNode.evaluate((e) => e.isConnected && e.checked), true);
  assert.equal(await approval.locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(
    await approval
      .getByRole("button", { name: "승인한 입력·첨부 1회 실행", exact: true })
      .isEnabled(),
    true,
  );
  assert.deepEqual(mockReviewActions, beforeToggleActions);
  assert.deepEqual(mockReviewActions, ["compare-prepared-package", "prepare"]);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "synthetic prepared comparison/review and separate checked consent survive folding with same DOM; no execute or repeat prepare",
  );
  await page.unroute(packagePath);
  await page.unroute(executionPath);
  await page.unroute(overviewPath(first));
  await page.route(overviewPath(first), (r) => fulfill(r, overview));

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
    assert.equal((await openSections()).length, 8);
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
  assert.deepEqual(await openSections(), ["execution"]);
  await page.screenshot({ path: path.join(output, "disclosure-390.png"), fullPage: true });
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
        mockReviewActions,
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
