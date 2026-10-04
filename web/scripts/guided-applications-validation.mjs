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
  "Usage: node scripts/guided-applications-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-guided-applications-"));
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
const { caseSchema } = await import("../src/lib/studio-schema.ts");
const { guidedApplicationsFixture } =
  await import("../src/lib/studio-guided-applications-test-helpers.ts");
const { isApplicationSubmission } = await import("../src/lib/studio-application-types.ts");
const { company: first, apply } = guidedApplicationsFixture();
first.profile.companyName = "합성 회차·제출 A";
const original = first.applicationEvents.find(isApplicationSubmission);
const receiptId = randomUUID();
const receipt = {
  id: receiptId,
  clientRequestId: randomUUID(),
  inputDigest: "a".repeat(64),
  origin: "manual",
  kind: "notice",
  noticeRecordId: receiptId,
  previousVersionId: null,
  version: 1,
  recordedAt: "2026-09-03T00:00:00.000Z",
  institution: "합성 기관",
  title: "합성 접수 안내",
  body: "처음 기록한 합성 접수 원문",
  occurredOn: "2026-09-03",
  note: "",
  evidence: [],
  details: {
    category: "receipt",
    receiptNumber: "SYNTHETIC-RECEIPT-V1",
    receivedOn: "2026-09-03",
    statusText: "담당자 기록",
  },
};
first.agencyRecords.push(receipt);
apply({
  action: "link-application-agency",
  applicationId: first.applications[0].id,
  recordId: receipt.id,
  note: "합성 연결",
});
const newPlan = structuredClone(first.plans[0]);
newPlan.id = randomUUID();
newPlan.version = 2;
newPlan.content.summary = "합성 수동 수정 보존";
first.plans.push(newPlan);
apply({
  action: "correct-application-submission",
  applicationId: first.applications[0].id,
  submissionRecordId: original.id,
  previousVersionId: original.id,
  planId: newPlan.id,
  sourceIds: [],
  taskIds: [],
  receiptRecordId: receipt.id,
  occurredOn: "2026-09-04",
  recordedBy: "합성 기록 담당자",
  note: "새 원고로 제출했다고 정정",
});
const current = first.applicationEvents.filter(isApplicationSubmission).at(-1);
first.agencyRecords.push({
  ...receipt,
  id: randomUUID(),
  clientRequestId: randomUUID(),
  kind: "notice-correction",
  previousVersionId: receipt.id,
  version: 2,
  details: { ...receipt.details, receiptNumber: "SYNTHETIC-LATER-V2" },
});
const { company: second } = guidedApplicationsFixture();
second.profile.companyName = "합성 회차·제출 B";
second.applicationEvents = [];
second.applications[0].title = "긴 합성 회차 이름 ".repeat(10);
const fixtures = [first, second].map((item) => caseSchema.parse(item));
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
const initialRows = rows(),
  writes = [];
const panel = () => page.getByLabel("신청 회차·제출 기록 요약", { exact: true });
async function openCompany(c) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: c.profile.companyName }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "신청·진행" })
    .click();
  await panel().waitFor();
}
async function focusId(id) {
  await page.waitForFunction((value) => document.activeElement?.id === value, id);
}
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
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  let expectedDialog = false,
    dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    if (!expectedDialog) errors.push("Unexpected dialog");
    await d.dismiss();
  });
  const initialResponses = new Map();
  for (const c of fixtures) {
    const response = await (await api("/api/studio/cases/" + c.id)).json();
    // GET adds applicationCriteriaContexts; keep the complete response, not only its stored fields.
    for (const key of Object.keys(c)) assert.deepEqual(response[key], c[key]);
    assert.ok(Array.isArray(response.applicationCriteriaContexts));
    initialResponses.set(c.id, response);
  }
  await openCompany(first);
  assert.equal(await panel().evaluate((e) => e.open), false);
  await panel().locator("summary").click();
  assert.ok((await panel().innerText()).includes("공식 확인 시각 없음"));
  assert.ok((await panel().innerText()).includes("당시 원고 v2"));
  assert.ok((await panel().innerText()).includes("기록 v2"));
  assert.ok((await panel().innerText()).includes("기관 확인 미실시"));
  assert.equal(
    await panel().getByRole("button", { name: "이 회차 기록 보기", exact: true }).count(),
    2,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "collapsed manual summary separates two cycles, corrected submission date and saved time; no automatic request or write",
  );

  await panel().getByRole("button", { name: "이 회차 기록 보기", exact: true }).nth(1).click();
  await focusId("application-cycle-" + first.applications[1].id);
  assert.ok((await page.locator(":focus").innerText()).includes("합성 재확인 신청"));
  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  assert.equal(await panel().evaluate((e) => e.open), false);
  await panel().locator("summary").click();
  await panel()
    .getByRole("button", { name: "이 제출 기록의 원고·접수 근거 보기", exact: true })
    .evaluate((e) => {
      e.click();
      e.click();
    });
  await focusId("application-submission-" + current.id);
  assert.equal(await page.locator('[id="application-submission-' + current.id + '"]').count(), 1);
  const exact = page.locator('[id="application-submission-' + current.id + '"]');
  assert.ok((await exact.innerText()).includes("원고 v2"));
  // Open the existing receipt disclosure and retain its original recorded version.
  const summaries = await exact.locator("summary").allTextContents();
  const receiptSummary = summaries.find((text) => text.includes("접수"));
  assert.ok(receiptSummary);
  await exact.getByText(receiptSummary, { exact: true }).click();
  assert.ok((await exact.innerText()).includes("SYNTHETIC-RECEIPT-V1"));
  assert.ok(!(await exact.innerText()).includes("SYNTHETIC-LATER-V2"));
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "cycle and exact corrected submission destinations focus once; duplicate click preserves fixed old receipt and manual plan snapshot",
  );

  const stage = page.getByLabel("현재 진행 단계", { exact: true });
  await stage.selectOption("visit");
  expectedDialog = true;
  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  assert.equal(dialogs, 1);
  expectedDialog = false;
  assert.equal(await stage.inputValue(), "visit");
  await stage.selectOption(first.stage);
  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  await page.getByRole("button", { name: "기업 목록", exact: false }).click();
  await page.getByRole("button").filter({ hasText: second.profile.companyName }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "신청·진행" })
    .click();
  await panel().locator("summary").click();
  assert.equal(
    await panel()
      .getByRole("button", { name: "이 제출 기록의 원고·접수 근거 보기", exact: true })
      .count(),
    0,
  );
  assert.ok((await panel().innerText()).includes("실제 미제출을 증명하지 않습니다"));
  assert.ok(
    (await page.getByText("마지막 기록", { exact: true }).locator("..").innerText()).includes(
      "(한국시간)",
    ),
  );
  await panel().getByRole("button", { name: "이 회차 기록 보기", exact: true }).first().click();
  await focusId("application-cycle-" + second.applications[0].id);
  assert.equal(await page.locator('[id="application-submission-' + current.id + '"]').count(), 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "existing unsaved stage guard preserves edits; explicit company switch never retains first company's navigation",
  );

  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel().locator("summary").click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "applications-390.png"), fullPage: true });
  await stop();
  await start();
  await openCompany(first);
  assert.equal(await panel().evaluate((e) => e.open), false);
  await panel().locator("summary").click();
  await panel()
    .getByRole("button", { name: "이 제출 기록의 원고·접수 근거 보기", exact: true })
    .click();
  await focusId("application-submission-" + current.id);
  for (const c of fixtures)
    assert.deepEqual(
      await (await api("/api/studio/cases/" + c.id)).json(),
      initialResponses.get(c.id),
    );
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "390px long title fits; server and browser reload keep exact snapshots and all four database tables with GET only",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        syntheticCases: fixtures.length,
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
      ).slice(-9000),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
