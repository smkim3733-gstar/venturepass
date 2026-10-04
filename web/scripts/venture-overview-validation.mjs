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
  "Usage: node scripts/venture-overview-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-venture-overview-"));
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
  await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).waitFor();
  assert.equal(
    await panel()
      .locator("details")
      .evaluate((e) => e.open),
    false,
  );
  assert.ok((await panel().innerText()).includes("공식 접수 상태는 조회하지 않았습니다"));
  assert.equal(overviewReads.length, 1);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "actual local GET is case-bound; one primary entry, no automatic login, remote read or database mutation",
  );

  // Explicit refresh, duplicate click, unavailable response, then correct read. No implicit retry.
  let calls = 0;
  await page.route(overviewPath(first), async (r) => {
    calls++;
    await r.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "합성 조회 실패" }),
    });
  });
  const refresh = panel().getByRole("button", { name: "연결 기록 다시 확인", exact: true });
  await refresh.evaluate((e) => {
    e.click();
    e.click();
  });
  await panel().getByRole("alert").waitFor();
  assert.equal(calls, 1);
  assert.equal(
    await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).count(),
    0,
  );
  await page.unroute(overviewPath(first));
  await refresh.click();
  await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).waitFor();
  const base = await (await api("/api/studio/cases/" + first.id + "/venturein/overview")).json();
  record(
    "duplicate refresh is one GET; failed reads remove old navigation and require explicit reread",
  );

  // Simulated status shapes use only overview responses; no real login or agency operation.
  const variants = [
    { sessionState: "awaiting_auth", label: "로그인 연결 이어서 보기" },
    { sessionState: "connected_unmapped", phase: "handoff", label: "공식 화면 확인하기" },
    { sessionState: "idle", previousInputNeedsCheck: true, label: "이전 입력 결과 확인" },
  ];
  for (const variant of variants) {
    const { label, ...fields } = variant;
    await page.route(overviewPath(first), (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...base, ...fields }),
      }),
    );
    await refresh.click();
    await panel().getByRole("button", { name: label, exact: true }).waitFor();
    assert.ok(!(await panel().innerText()).includes("접수 완료로 확인"));
    await page.unroute(overviewPath(first));
  }
  await refresh.click();
  await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).click();
  await page.getByText("벤처인 계정 연결과 제출 준비", { exact: true }).waitFor();
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "synthetic auth/completed-input/unknown-input states stay distinct; entry opens existing connection UI without starting login",
  );

  await openCompany(first);
  await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).waitFor();
  // Wrong company/revision must not be accepted as a current summary.
  for (const changed of [{ caseId: second.id }, { companyRevision: first.revision + 1 }]) {
    await page.route(overviewPath(first), (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...base, ...changed }),
      }),
    );
    await panel().getByRole("button", { name: "연결 기록 다시 확인", exact: true }).click();
    await panel().getByRole("alert").waitFor();
    assert.equal(
      await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).count(),
      0,
    );
    await page.unroute(overviewPath(first));
  }
  let release;
  let sent;
  const started = new Promise((r) => {
    sent = r;
  });
  const held = new Promise((r) => {
    release = r;
  });
  let done;
  const handled = new Promise((r) => {
    done = r;
  });
  await page.route(overviewPath(first), async (r) => {
    sent();
    await held;
    try {
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...base, previousInputNeedsCheck: true }),
      });
    } catch {
    } finally {
      done();
    }
  });
  await panel().getByRole("button", { name: "연결 기록 다시 확인", exact: true }).click();
  await started;
  await page.getByRole("button", { name: "기업 목록", exact: false }).click();
  await page.getByRole("button").filter({ hasText: second.profile.companyName }).first().click();
  await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).waitFor();
  release();
  await handled;
  await page.unroute(overviewPath(first));
  assert.equal(
    await panel().getByRole("button", { name: "이전 입력 결과 확인", exact: true }).count(),
    0,
  );
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "wrong company/revision is rejected and a late prior-company response never replaces the new company",
  );

  await panel().locator("summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "overview-390.png"), fullPage: true });
  const link = panel().getByRole("link", { name: "벤처인 공식 확인절차 열기", exact: true });
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await link.getAttribute("referrerpolicy"), "no-referrer");
  // Intercept the public popup for an isolated UI check; never send this fixture to the real site.
  let publicHeaders;
  await context.route("https://www.smes.go.kr/venturein/institution/processGuide", async (r) => {
    publicHeaders = r.request().headers();
    await r.fulfill({ status: 200, contentType: "text/html", body: "<h1>합성 공식 절차</h1>" });
  });
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await popup.waitForLoadState();
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.ok(!publicHeaders.referer);
  await popup.close();
  await openCompany(unready);
  assert.equal(await panel().count(), 0);
  await openCompany(followup);
  assert.equal(await panel().count(), 0);
  assert.ok((await page.locator("body").innerText()).includes("사용자 기록"));
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  await stop();
  await start();
  await openCompany(second);
  await panel().getByRole("button", { name: "벤처인 연결 준비", exact: true }).waitFor();
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "390px layout, safe explicit public link, unreviewed-plan/followup precedence and restart remain read-only",
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
