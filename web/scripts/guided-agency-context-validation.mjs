import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
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
  "Usage: node scripts/guided-agency-context-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-guided-agency-context-"));
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
const { guidedAgencyContextFixture } =
  await import("../src/lib/studio-guided-agency-context-test-helpers.ts");
const { currentApplicationLinks } = await import("../src/lib/studio-application-types.ts");
const first = guidedAgencyContextFixture(),
  second = guidedAgencyContextFixture(),
  broken = guidedAgencyContextFixture();
first.company.profile.companyName = "합성 기관 귀속 A";
second.company.profile.companyName = "합성 기관 귀속 B";
broken.company.profile.companyName = "합성 기관 귀속 확인 필요";
const prior = currentApplicationLinks(second.company)[0];
second.apply({
  action: "correct-application-agency-link",
  previousLinkEventId: prior.id,
  fromApplicationId: prior.applicationId,
  toApplicationId: second.company.applications[1].id,
  recordId: second.request.id,
  note: "합성 회차 변경",
});
second.apply({
  action: "link-application-agency",
  applicationId: second.company.applications[0].id,
  recordId: second.notice.id,
  note: "합성 납부 기록 연결",
});
const payment = currentApplicationLinks(second.company).find(
  (item) => item.chainRootId === second.notice.id,
);
second.apply({
  action: "correct-application-agency-link",
  previousLinkEventId: payment.id,
  fromApplicationId: payment.applicationId,
  toApplicationId: null,
  recordId: second.notice.id,
  note: "합성 연결 해제",
});
second.company.applications[1].title = "긴 신청 회차 이름 ".repeat(10);
const brokenPrior = currentApplicationLinks(broken.company)[0];
broken.apply({
  action: "correct-application-agency-link",
  previousLinkEventId: brokenPrior.id,
  fromApplicationId: brokenPrior.applicationId,
  toApplicationId: broken.company.applications[1].id,
  recordId: broken.request.id,
  note: "손상 경계의 합성 기록",
});
broken.company.applicationEvents.at(-1).chainRootId = broken.notice.id;
const fixtures = [first, second, broken].map((f) => caseSchema.parse(f.company));
const bootstrap = new StudioStore(dataDirectory);
bootstrap.close();
const databaseFile = path.join(dataDirectory, "studio.sqlite"),
  db = new DatabaseSync(databaseFile);
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
const summary = () => page.getByRole("region", { name: "신청 진행 기록 요약" });
const contexts = () => summary().getByLabel("기관 기록의 신청 회차 연결", { exact: true });
async function openCompany(f) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: f.company.profile.companyName }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "신청·진행" })
    .click();
  await summary().waitFor();
}
async function focusId(id) {
  await page.waitForFunction((value) => document.activeElement?.id === value, id);
}
async function details() {
  await contexts().first().locator("summary").click();
}
async function back() {
  await page.getByRole("button", { name: "간단 화면", exact: true }).click();
  await summary().waitFor();
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
  page.on("dialog", async (d) => {
    errors.push("Unexpected dialog");
    await d.dismiss();
  });
  const initialResponses = new Map();
  for (const c of fixtures) {
    const response = await (await api("/api/studio/cases/" + c.id)).json();
    for (const key of Object.keys(c)) assert.deepEqual(response[key], c[key]);
    initialResponses.set(c.id, response);
  }
  await openCompany(first);
  assert.ok((await contexts().first().innerText()).includes(first.company.applications[0].title));
  assert.equal(
    await contexts()
      .first()
      .locator("details")
      .evaluate((e) => e.open),
    false,
  );
  assert.ok((await summary().innerText()).includes("공식 사이트 자동 조회 미연결"));
  await details();
  assert.ok(
    (await contexts().first().innerText()).includes("연결 기준: 요청 v1 · 이 안내의 원문: 요청 v2"),
  );
  const fixedButton = contexts()
    .first()
    .getByRole("button", { name: "연결 당시 원문 보기 (요청 v1)", exact: true });
  await fixedButton.evaluate((e) => {
    e.click();
    e.click();
  });
  await focusId("agency-record-" + first.request.id);
  assert.ok((await page.locator(":focus").innerText()).includes(first.request.body));
  assert.equal(await page.locator('[id="agency-record-' + first.request.id + '"]').count(), 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "current request v2 retains assignment to v1; explicit duplicate read opens original v1 once without response preparation or writes",
  );

  await back();
  assert.equal(
    await contexts()
      .first()
      .locator("details")
      .evaluate((e) => e.open),
    false,
  );
  await details();
  await contexts()
    .first()
    .getByRole("button", { name: "이 안내의 원문 보기 (요청 v2)", exact: true })
    .click();
  await focusId("agency-record-" + first.corrected.id);
  assert.ok((await page.locator(":focus").innerText()).includes(first.corrected.body));
  await back();
  await details();
  await contexts()
    .first()
    .getByRole("button", { name: "연결된 회차 기록 보기", exact: true })
    .click();
  await focusId("application-cycle-" + first.company.applications[0].id);
  await back();
  await summary().locator("summary").filter({ hasText: "함께 보관한 안내·업무" }).click();
  assert.ok((await contexts().nth(1).innerText()).includes("신청 회차 미지정"));
  await contexts().nth(1).locator("summary").click();
  assert.equal(
    await contexts()
      .nth(1)
      .getByRole("button", { name: "연결된 회차 기록 보기", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "current original and exact application open separately; unassigned payment never chooses a recent application",
  );

  await page.getByRole("button", { name: "기업 목록", exact: false }).click();
  await page
    .getByRole("button")
    .filter({ hasText: second.company.profile.companyName })
    .first()
    .click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "신청·진행" })
    .click();
  await details();
  assert.ok((await contexts().first().innerText()).includes("다른 회차로 변경"));
  assert.ok((await contexts().first().innerText()).includes(second.company.applications[1].title));
  await contexts()
    .first()
    .getByRole("button", { name: "연결된 회차 기록 보기", exact: true })
    .click();
  await focusId("application-cycle-" + second.company.applications[1].id);
  assert.equal(await page.locator('[id="agency-record-' + first.request.id + '"]').count(), 0);
  await back();
  await summary().locator("summary").filter({ hasText: "함께 보관한 안내·업무" }).click();
  await contexts().nth(1).locator("summary").click();
  assert.ok((await contexts().nth(1).innerText()).includes("신청 회차 연결 해제 기록"));
  assert.equal(
    await contexts()
      .nth(1)
      .getByRole("button", { name: "연결된 회차 기록 보기", exact: true })
      .count(),
    0,
  );
  await contexts()
    .nth(1)
    .getByRole("button", { name: "이 안내의 원문 보기 (통보 v1)", exact: true })
    .click();
  await focusId("agency-record-" + second.notice.id);
  assert.deepEqual(writes, []);
  assert.deepEqual(rows(), initialRows);
  record(
    "company switch and reassignment use exact second cycle; released payment keeps original notice and no inferred application",
  );

  await openCompany(broken);
  assert.ok((await contexts().first().innerText()).includes("신청 회차 연결 확인 필요"));
  await details();
  assert.equal(
    await contexts()
      .first()
      .getByRole("button", { name: "연결된 회차 기록 보기", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await contexts()
      .first()
      .getByRole("button", { name: /연결 당시 원문 보기/ })
      .count(),
    0,
  );
  await contexts()
    .first()
    .getByRole("button", { name: "이 안내의 원문 보기 (요청 v2)", exact: true })
    .click();
  await focusId("agency-record-" + broken.corrected.id);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "damaged reassignment stays unknown without reverting to old application; coherent original remains readable with no repair",
  );

  await openCompany(second);
  await page.setViewportSize({ width: 390, height: 844 });
  await details();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "agency-context-390.png"), fullPage: true });
  await stop();
  await start();
  await openCompany(first);
  assert.equal(
    await contexts()
      .first()
      .locator("details")
      .evaluate((e) => e.open),
    false,
  );
  await details();
  await contexts()
    .first()
    .getByRole("button", { name: "연결 당시 원문 보기 (요청 v1)", exact: true })
    .click();
  await focusId("agency-record-" + first.request.id);
  for (const c of fixtures)
    assert.deepEqual(
      await (await api("/api/studio/cases/" + c.id)).json(),
      initialResponses.get(c.id),
    );
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "390px long assignment fits and reload uses GET only; all original case responses and four database tables remain unchanged",
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
      ).slice(-8500),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
