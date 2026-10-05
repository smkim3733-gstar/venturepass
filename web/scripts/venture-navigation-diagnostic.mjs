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

// This bounded diagnostic uses the unchanged production UI/API and new synthetic data.
// The explicit build must be a current, environment-free build:local staging directory.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/venture-navigation-diagnostic.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-navigation-diagnostic-"));
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
  externalRequests = [];

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
  const owned = child;
  if (!owned) return;
  if (owned.exitCode !== null || owned.signalCode !== null) {
    child = undefined;
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Owned server failed to stop")), 10000);
    owned.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    owned.kill();
  });
  if (child === owned) child = undefined;
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

const first = fixture("합성 상세 진입 진단");
const bootstrap = new StudioStore(dataDirectory);
bootstrap.close();
const databaseFile = path.join(dataDirectory, "studio.sqlite");
const db = new DatabaseSync(databaseFile);
db.prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)").run(
  first.id,
  first.revision,
  first.revision,
  JSON.stringify(first),
);
db.close();
const beforeBytes = await readFile(databaseFile);
const diagnostics = [],
  writes = [];
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (r) => {
    const req = r.request();
    if (new URL(req.url()).origin !== origin) {
      externalRequests.push("blocked");
      return r.abort();
    }
    if (!["GET", "HEAD"].includes(req.method()))
      writes.push(req.method() + " " + new URL(req.url()).pathname);
    return r.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => {
    diagnostics.push({ dialog: d.message() });
    await d.dismiss();
  });
  await page.addInitScript(() => {
    window.__navigationTrace = [];
    for (const kind of ["pointerdown", "pointerup", "click"])
      document.addEventListener(
        kind,
        (e) => {
          const target = e.target instanceof Element ? e.target.closest("button") : null;
          window.__navigationTrace.push({
            kind,
            text: target?.textContent,
            role: target?.getAttribute("role"),
            selected: target?.getAttribute("aria-selected"),
            x: e.clientX,
            y: e.clientY,
          });
        },
        true,
      );
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(origin + "/studio", { waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: first.profile.companyName }).first().click();
    await page.getByRole("button", { name: "상세 도구", exact: true }).waitFor();
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    const tab = page.getByRole("tab", { name: /벤처인 연결$/ });
    await tab.waitFor();
    const before = await tab.boundingBox();
    await tab.click();
    let reached = true;
    try {
      await page
        .getByRole("region", { name: "MY벤처현황 읽기", exact: true })
        .waitFor({ timeout: 2500 });
    } catch {
      reached = false;
    }
    diagnostics.push({
      attempt,
      before,
      reached,
      selected: await tab.getAttribute("aria-selected"),
      trace: await page.evaluate(() => window.__navigationTrace),
    });
    if (!reached) {
      // A single explicit second diagnostic click distinguishes a missed DOM click from a rejected handler.
      // It is not a product retry and is recorded separately.
      await tab.click();
      let secondReached = true;
      try {
        await page
          .getByRole("region", { name: "MY벤처현황 읽기", exact: true })
          .waitFor({ timeout: 2500 });
      } catch {
        secondReached = false;
      }
      diagnostics.push({
        attempt,
        secondClick: true,
        reached: secondReached,
        trace: await page.evaluate(() => window.__navigationTrace),
      });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(writes, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  await context.close();
  context = undefined;
  await stop();
  assert.equal(digest(await readFile(databaseFile)), digest(beforeBytes));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ buildId, diagnostics, writes, errors }, null, 2),
  );
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
console.log(JSON.stringify({ output, diagnostics }));
