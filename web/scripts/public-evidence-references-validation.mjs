import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import mammoth from "mammoth";
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
  "Usage: node scripts/public-evidence-references-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-public-evidence-references-"));
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
const { publicEvidenceExportEntries, PUBLIC_EVIDENCE_EXPORT_NOTICE } =
  await import("../src/lib/studio-public-evidence-export.ts");
const fixtures = Array.from({ length: 5 }, () => publicEvidenceExportFixture());
fixtures.forEach((f, index) => {
  f.record.profile.companyName = `합성 공개 인용 화면 ${index + 1}`;
});
const main = fixtures[0];
const next = structuredClone(main.plan);
next.id = randomUUID();
next.version = 2;
next.content.sections[0].evidence[0].quote = "현재 보관 발췌에 없는 새 인용문";
main.record.plans.push(next);
fixtures[1].draft.url = "https://example.invalid/" + "a".repeat(1900);
fixtures[1].draft.relevance =
  '<img src="https://example.invalid/pixel" onerror="alert(1)">\n<script>alert(1)</script>';
fixtures[1].draft.conflicts = "긴 메모 ".repeat(450);
fixtures[1].source.text = publicEvidenceText(fixtures[1].draft);
fixtures[2].source.text = fixtures[2].source.text.replace("[원문 발췌 끝]", "edited boundary");
fixtures[3].source.extraction = "pending";
fixtures[3].source.text = "";
fixtures[4].source.name = "일반 회사 메모";
fixtures[4].source.text = "회사 메모의 임의 URL https://example.invalid/ordinary";
const bootstrap = new StudioStore(dataDirectory);
bootstrap.close();
const databaseFile = path.join(dataDirectory, "studio.sqlite");
const db = new DatabaseSync(databaseFile);
try {
  for (const f of fixtures) {
    const c = caseSchema.parse(f.record);
    db.prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)").run(
      c.id,
      c.revision,
      c.revision,
      JSON.stringify(c),
    );
  }
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
const box = (version) =>
  page.locator(`details[aria-label="공개 근거 출처 확인 · 원고 v${version}"]`);
async function openCompany(f) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: f.record.profile.companyName }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: /^기준·근거 보기$/ })
    .click();
}
async function readBox(c, plan) {
  const panel = box(plan.version);
  await panel.waitFor({ state: "attached" });
  assert.equal(await panel.evaluate((e) => e.open), false);
  await panel.locator(":scope > summary").click();
  assert.ok((await panel.innerText()).includes(PUBLIC_EVIDENCE_EXPORT_NOTICE));
  const entries = publicEvidenceExportEntries(c, plan);
  assert.equal(await panel.locator("article").count(), entries.length);
  for (let i = 0; i < entries.length; i++) {
    const article = panel.locator("article").nth(i);
    assert.equal(await article.locator("h4").textContent(), entries[i].title);
    assert.deepEqual(await article.locator("div > p").allTextContents(), entries[i].lines);
  }
  assert.equal(await panel.locator("a,img,script,iframe,input,button").count(), 0);
  return panel;
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
    if (!["GET", "HEAD"].includes(req.method())) writes.push(req.method() + " " + req.url());
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (dialog) => {
    errors.push("Unexpected dialog: " + dialog.message());
    await dialog.dismiss();
  });
  await openCompany(main);
  let panel = await readBox(main.record, next);
  assert.ok((await panel.innerText()).includes("같은 문구를 찾지 못함"));
  await panel.locator(":scope > summary").click();
  await panel.locator(":scope > summary").click();
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "guided evidence is collapsed initially; repeated expansion shows exact export projection without writes or external access",
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  assert.equal(
    await page.getByRole("tab", { name: /사업계획서/ }).getAttribute("aria-selected"),
    "true",
  );
  await page.getByLabel("작성 이력", { exact: true }).selectOption(main.plan.id);
  panel = await readBox(main.record, main.plan);
  assert.ok((await panel.innerText()).includes("같은 문구 있음"));
  assert.ok(!(await panel.innerText()).includes("같은 문구를 찾지 못함"));
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "원고 v1 Word 내려받기", exact: true }).click(),
  ]);
  assert.equal(await download.failure(), null);
  await download.saveAs(path.join(output, "selected-v1.docx"));
  const text = (
    await mammoth.extractRawText({ buffer: await readFile(path.join(output, "selected-v1.docx")) })
  ).value;
  for (const e of publicEvidenceExportEntries(main.record, main.plan))
    for (const line of e.lines) assert.ok(text.includes(line), line);
  await page.getByLabel("작성 이력", { exact: true }).selectOption(next.id);
  panel = await readBox(main.record, next);
  assert.ok((await panel.innerText()).includes("같은 문구를 찾지 못함"));
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "actual historical/current selection resets disclosure and matches the selected Word source appendix, with no mutation",
  );
  await openCompany(fixtures[1]);
  panel = await readBox(fixtures[1].record, fixtures[1].plan);
  assert.ok((await panel.innerText()).includes(fixtures[1].draft.url));
  assert.ok((await panel.innerText()).includes(fixtures[1].draft.conflicts));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "long-390.png"), fullPage: true });
  await panel.screenshot({ path: path.join(output, "long-evidence.png") });
  record(
    "long URL, multiline hostile markup and full notes remain inert visible text at 390px without overflow",
  );
  await openCompany(fixtures[2]);
  panel = await readBox(fixtures[2].record, fixtures[2].plan);
  assert.ok((await panel.innerText()).includes("형식·경계를 확인하지 못했습니다"));
  assert.ok(!(await panel.innerText()).includes(fixtures[2].draft.url));
  await openCompany(fixtures[3]);
  panel = await readBox(fixtures[3].record, fixtures[3].plan);
  assert.ok((await panel.innerText()).includes("형식 확인 필요"));
  assert.ok(!(await panel.innerText()).includes("같은 문구 있음"));
  await openCompany(fixtures[4]);
  assert.equal(await box(1).count(), 0);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  record(
    "company switching drops old metadata; malformed and pending sources stay unresolved; ordinary URLs are not public evidence",
  );
  // One explicit synthetic source edit through the existing writer. Viewing remains read-only.
  const newText = publicEvidenceText({
    ...main.draft,
    url: "https://example.invalid/revised",
    quote: "수정된 현재 보관 발췌입니다.",
    publishedOn: "",
    period: "",
    readOn: "2026-10-04",
  });
  const changed = await (
    await api(`/api/studio/cases/${main.record.id}`, {
      method: "PATCH",
      data: {
        action: "source",
        revision: main.record.revision,
        source: { ...main.source, text: newText, updatedAt: "2026-10-05T01:00:00Z" },
      },
    })
  ).json();
  assert.equal(changed.revision, main.record.revision + 1);
  for (const plan of main.record.plans) {
    const saved = changed.plans.find((p) => p.id === plan.id);
    assert.deepEqual(saved.content, plan.content);
    assert.equal(saved.confirmedAt, null);
  }
  const afterEditRows = rows();
  await openCompany(main);
  panel = await readBox(
    changed,
    changed.plans.find((p) => p.id === next.id),
  );
  assert.ok((await panel.innerText()).includes("https://example.invalid/revised"));
  assert.ok(!(await panel.innerText()).includes(main.draft.url));
  assert.ok((await panel.innerText()).includes("발행일 (원문 표기 기록): 미확인"));
  assert.ok((await panel.innerText()).includes("같은 문구를 찾지 못함"));
  await page.screenshot({ path: path.join(output, "changed-390.png"), fullPage: true });
  await stop();
  await start();
  await openCompany(main);
  await readBox(
    changed,
    changed.plans.find((p) => p.id === next.id),
  );
  assert.deepEqual(rows(), afterEditRows);
  assert.deepEqual(await (await api(`/api/studio/cases/${main.record.id}`)).json(), changed);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(writes, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "explicit source edit preserves manuscript content, shows current unknown dates, and survives restart with read-only views",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        syntheticSeedCases: 5,
        syntheticSourceWrites: 1,
        uiWriteRequests: writes,
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
