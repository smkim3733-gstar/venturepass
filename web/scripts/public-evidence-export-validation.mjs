import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import mammoth from "mammoth";
import JSZip from "jszip";
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
  "Usage: node scripts/public-evidence-export-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-public-evidence-export-"));
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
const { publicEvidenceExportFixture } =
  await import("../src/lib/studio-public-evidence-export-test-helpers.ts");
const { StudioStore } = await import("../src/lib/studio-storage.ts");
const { caseSchema } = await import("../src/lib/studio-schema.ts");
const { publicEvidenceText } = await import("../src/lib/studio-public-evidence.ts");
const fixtures = [
  publicEvidenceExportFixture(),
  publicEvidenceExportFixture(),
  publicEvidenceExportFixture(),
];
fixtures.forEach((fixture, index) => {
  fixture.record.profile.companyName += ` ${index + 1}`;
});
const main = fixtures[0];
const second = structuredClone(main.plan);
second.id = randomUUID();
second.version = 2;
second.content.summary = "직접 편집한 최신 요약을 보존합니다.";
second.content.sections[1].content += " 수동 추가 문장입니다.";
main.record.plans.push(second);
main.record.sources.push({
  ...structuredClone(main.source),
  id: randomUUID(),
  name: "미인용 공개 후보",
  text: publicEvidenceText({
    ...main.draft,
    url: "https://example.invalid/PRIVATE_UNCITED_URL",
    title: "미인용 공개 후보",
  }),
});
fixtures[1].draft.url = "https://example.invalid/" + "long-path-".repeat(160);
fixtures[1].draft.relevance = "담당자 관련성 메모를 그대로 보존합니다. ".repeat(100);
fixtures[1].draft.conflicts = "다른 시점의 자료와 비교가 필요합니다. ".repeat(100);
fixtures[1].source.text = publicEvidenceText(fixtures[1].draft);
fixtures[2].source.text = fixtures[2].source.text.replace("[원문 발췌 끝]", "[경계가 수정된 기록]");
const bootstrap = new StudioStore(dataDirectory);
bootstrap.close();
const databaseFile = path.join(dataDirectory, "studio.sqlite");
const db = new DatabaseSync(databaseFile);
try {
  for (const f of fixtures) {
    const checked = caseSchema.parse(f.record);
    db.prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)").run(
      checked.id,
      checked.revision,
      checked.revision,
      JSON.stringify(checked),
    );
  }
} finally {
  db.close();
}
function rows() {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return [
      "studio_cases",
      "venture_accounts",
      "venture_workflows",
      "studio_prepared_packages",
    ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  } finally {
    db.close();
  }
}
async function documentParts(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  return Promise.all(
    Object.keys(zip.files)
      .sort()
      .map(async (name) => ({
        name,
        hash: digest((await zip.file(name)?.async("nodebuffer")) ?? Buffer.alloc(0)),
      })),
  );
}
const initialRows = rows(),
  writeRequests = [];
async function docxFor(f, plan, label) {
  const response = await api(
    `/api/studio/cases/${f.record.id}/export?planId=${plan.id}&format=docx`,
  );
  assert.match(response.headers()["content-type"], /wordprocessingml/);
  assert.match(response.headers()["content-disposition"], /^attachment;/);
  const bytes = await response.body();
  assert.equal(Number(response.headers()["content-length"]), bytes.length);
  await writeFile(path.join(output, label + ".docx"), bytes);
  const text = (await mammoth.extractRawText({ buffer: bytes })).value;
  return { bytes, text };
}
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
    acceptDownloads: true,
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== origin) {
      externalRequests.push(req.url());
      return route.abort();
    }
    if (!["GET", "HEAD"].includes(req.method()))
      writeRequests.push({ url: req.url(), method: req.method() });
    return route.continue();
  });
  const old = await docxFor(main, main.plan, "historical");
  const current = await docxFor(main, second, "current");
  for (const result of [old, current]) {
    assert.ok(result.text.includes(main.draft.url));
    for (const value of [
      main.draft.publishedOn,
      main.draft.period,
      main.draft.readOn,
      "별도 확인 필요",
      "같은 문구 있음",
      "사실 검증은 아님",
      "원고 작성 당시",
    ])
      assert.ok(result.text.includes(value), value);
    assert.ok(!result.text.includes("PRIVATE_UNCITED_URL"));
    assert.ok(result.text.includes(main.plan.content.sections[1].content));
  }
  assert.ok(old.text.includes(main.plan.content.summary));
  assert.ok(!old.text.includes(second.content.summary));
  assert.ok(current.text.includes(second.content.summary));
  const markdown = await (
    await api(`/api/studio/cases/${main.record.id}/export?planId=${main.plan.id}`)
  ).text();
  assert.ok(markdown.includes("공개 근거 출처 확인"));
  assert.ok(markdown.includes("원고 작성 당시"));
  assert.ok(!markdown.includes("PRIVATE_UNCITED_URL"));
  assert.deepEqual(rows(), initialRows);
  record(
    "historical/current API downloads distinguish manual dates and preserve complete original rows; cited candidates only",
  );
  const long = await docxFor(fixtures[1], fixtures[1].plan, "long-notes");
  for (const value of [
    fixtures[1].draft.url,
    fixtures[1].draft.relevance,
    fixtures[1].draft.conflicts,
  ])
    assert.ok(long.text.includes(value));
  const malformed = await docxFor(fixtures[2], fixtures[2].plan, "unreadable-record");
  assert.ok(malformed.text.includes("형식·경계를 확인하지 못했습니다"));
  assert.ok(!malformed.text.includes(fixtures[2].draft.url));
  record(
    "long URL and multiline notes retained; changed manual boundaries yield unknown metadata without inference",
  );
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page
    .getByRole("button")
    .filter({ hasText: main.record.profile.companyName })
    .first()
    .click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
  await page.locator("summary").filter({ hasText: "추가 자료·AI 다시 작성·내려받기" }).click();
  await page.getByRole("button", { name: "원고·첨부 보관 및 내려받기", exact: true }).click();
  const link = page.getByRole("link", { name: "원고 v2 Word 내려받기", exact: true });
  await link.waitFor();
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  assert.equal(await download.failure(), null);
  await download.saveAs(path.join(output, "browser-download.docx"));
  assert.deepEqual(
    await documentParts(await readFile(path.join(output, "browser-download.docx"))),
    await documentParts(current.bytes),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "download-390.png"), fullPage: true });
  assert.deepEqual(writeRequests, []);
  record(
    "actual Word download link matches every API document part; 390px fits; download performs no writes or AI",
  );
  const before = await (await api(`/api/studio/cases/${main.record.id}`)).json();
  await stop();
  await start();
  await page.reload({ waitUntil: "networkidle" });
  assert.deepEqual(await (await api(`/api/studio/cases/${main.record.id}`)).json(), before);
  const restarted = await docxFor(main, main.plan, "historical-after-restart");
  assert.deepEqual(await documentParts(restarted.bytes), await documentParts(old.bytes));
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(writeRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "server/browser restart preserves selected historical document parts and all four database tables",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        caseId: main.record.id,
        rowsPreserved: true,
        documentHashes: {
          old: digest(old.bytes),
          current: digest(current.bytes),
          long: digest(long.bytes),
        },
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
      ).slice(0, 6000),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
