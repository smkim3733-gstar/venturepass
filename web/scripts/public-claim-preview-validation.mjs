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
  "Usage: node scripts/public-claim-preview-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-claim-preview-"));
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
// Fixture setup writes only this new, isolated database.
const { StudioStore } = await import("../src/lib/studio-storage.ts");
const { emptyProfile } = await import("../src/lib/studio-schema.ts");
const { emptyPublicEvidence, preparePublicEvidence } =
  await import("../src/lib/studio-public-evidence.ts");
const { buildClaimReview, claimReviewInputDigest } =
  await import("../src/lib/studio-claim-review.ts");
const seedStore = new StudioStore(dataDirectory),
  now = "2026-10-05T11:00:00.000Z";
const companies = [];
for (let n = 0; n < 2; n++) {
  const c = seedStore.create({ ...emptyProfile(), companyName: "합성 공개 주장 화면 " + (n + 1) });
  c.plans = [
    {
      id: randomUUID(),
      version: 1,
      mode: "manual",
      candidateId: "synthetic",
      generatedAt: now,
      sourceRevision: 1,
      confirmedAt: null,
      content: {
        title: "합성 원고",
        summary: "PRIVATE_SUMMARY",
        sections: [
          {
            key: "market",
            title: "시장",
            content: "산업 통계는 2023년 표본이다. 회사 실적으로 확인하지 않았다.",
            evidence: [],
            needsConfirmation: true,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
      review: [],
    },
  ];
  for (let k = 0; k < 2; k++)
    c.sources.push(
      preparePublicEvidence(
        c,
        {
          ...emptyPublicEvidence,
          title: "합성 공개 발췌 " + (k + 1),
          url: "https://example.invalid/" + k,
          readOn: "2026-10-05",
          quote: "2023년 산업 표본이다. <script>alert(1)</script> " + "긴문자".repeat(600),
          period: "2023년",
          relevance: "수동 관련성",
          conflicts: "회사 해당성 미확인",
        },
        randomUUID(),
        now,
        true,
      ).command.source,
    );
  const input = {
    claimId: null,
    previousVersionId: null,
    planId: c.plans[0].id,
    planVersion: 1,
    sectionKey: "market",
    claimQuote: "산업 통계는 2023년 표본이다.",
    nature: "current-claim",
    references: c.sources.map((s) => ({
      sourceId: s.id,
      sourceUpdatedAt: s.updatedAt,
      quote: "2023년 산업 표본이다.",
      locator: "공개 발췌",
    })),
    contextNote: "PRIVATE_CONTEXT",
    owner: "합성 담당자",
    dueOn: "",
    nextCheck: "",
    method: "unreviewed",
    externalCheck: { target: "", content: "", occurredOn: "" },
    judgement: { state: "unreviewed", reviewer: "", reason: "", checkedOn: "" },
    numericReferences: [],
    planReviewReferences: [],
  };
  c.claimReviews = [0, 1].map(() =>
    buildClaimReview(
      c,
      input,
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: claimReviewInputDigest(input),
        recordedAt: now,
      },
      () => {
        throw Error("Original forbidden");
      },
    ),
  );
  seedStore.db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(c), c.id);
  companies.push(c);
}
seedStore.close();
function rows() {
  const db = new DatabaseSync(path.join(dataDirectory, "studio.sqlite"), { readOnly: true });
  try {
    return [
      "studio_cases",
      "venture_accounts",
      "venture_workflows",
      "studio_prepared_packages",
    ].map((t) => [t, db.prepare("SELECT * FROM " + t).all()]);
  } finally {
    db.close();
  }
}
const initialRows = rows(),
  posts = [],
  writes = [];
const area = () => page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
const box = () =>
  area()
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "공개 근거 비교 입력 미리보기 (선택)" }) })
    .first();
const result = () =>
  page.getByRole("region", { name: "공개 주장 비교 입력 미리보기", exact: true });
const button = () => box().getByRole("button", { name: "선택 입력 미리보기", exact: true });
let current = companies[0],
  hold = null,
  tamper = false,
  rejection = false;
async function openCompany(c) {
  current = c;
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: c.profile.companyName }).first().waitFor();
  await page.getByRole("button").filter({ hasText: c.profile.companyName }).first().click();
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("button", { name: "원고 버전·검토 의견 확인", exact: true }).click();
  await area().waitFor();
}
async function select() {
  await box().locator(":scope > summary").click();
  await box()
    .getByRole("combobox")
    .selectOption(current.claimReviews[0].id);
  await box().getByRole("checkbox").first().check();
  await box().getByLabel("미리보기 모델 식별자", { exact: true }).fill("synthetic-model");
}
async function request() {
  await button().click();
  await result().waitFor();
}
async function absent() {
  await page.waitForTimeout(200);
  assert.equal(await result().count(), 0);
}
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
  });
  context.setDefaultTimeout(20000);
  const routeRequest = async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin !== origin) {
      externalRequests.push(req.url());
      return route.abort();
    }
    if (u.pathname.endsWith("/public-claim-comparison/preview")) {
      posts.push(req.postDataJSON());
      if (rejection) {
        rejection = false;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: '{"error":"synthetic stale"}',
        });
      }
      const response = await route.fetch(),
        body = await response.json();
      if (hold) {
        const h = hold;
        h.entered();
        await h.promise;
      }
      if (tamper) {
        body.transmissionAllowed = true;
        tamper = false;
      }
      return route.fulfill({ response, json: body }).catch(() => {});
    }
    if (!["GET", "HEAD"].includes(req.method())) writes.push(req.method() + " " + u.pathname);
    return route.continue();
  };
  await context.route("**/*", routeRequest);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await openCompany(current);
  assert.equal(await box().evaluate((e) => e.open), false);
  assert.equal(posts.length, 0);
  await select();
  assert.equal(posts.length, 0);
  assert.equal(await box().getByRole("checkbox").nth(1).isChecked(), false);
  const before = posts.length;
  await button().dblclick();
  await result().waitFor();
  assert.equal(posts.length, before + 1);
  assert.deepEqual(posts.at(-1).selection.sourceIds, [current.sources[0].id]);
  assert.ok(!JSON.stringify(posts).includes("PRIVATE"));
  assert.ok((await result().innerText()).includes("회사 실적으로 확인하지 않았다."));
  assert.ok((await result().innerText()).includes(current.sources[1].id));
  assert.equal(await result().locator("script,a,img,iframe").count(), 0);
  assert.deepEqual(rows(), initialRows);
  record(
    "explicit version/source/model selection; double click creates one actual local preview, full context and excluded IDs, zero writes",
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await result().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "claim-preview-390.png") });
  record("inert long evidence and dates remain readable at 390px without horizontal overflow");
  await box().getByLabel("미리보기 모델 식별자", { exact: true }).fill("synthetic-other");
  await absent();
  await request();
  await box().getByRole("checkbox").nth(1).check();
  await absent();
  await request();
  await box()
    .getByRole("combobox")
    .selectOption(current.claimReviews[1].id);
  await absent();
  assert.equal(await box().getByRole("checkbox").first().isChecked(), false);
  record("model/source/claim changes discard preview and claim change clears source selection");
  await box().getByRole("checkbox").first().check();
  tamper = true;
  await button().click();
  await box().getByRole("alert").waitFor();
  await absent();
  rejection = true;
  await button().click();
  await box().getByRole("alert").waitFor();
  await absent();
  record("modified authority response and stale HTTP failure are refused without automatic retry");
  async function delay(action) {
    let release, entered;
    const promise = new Promise((r) => {
        release = r;
      }),
      seen = new Promise((r) => {
        entered = r;
      });
    hold = { promise, entered };
    await button().click();
    await seen;
    await action();
    hold = null;
    release();
    await absent();
  }
  await delay(() => box().getByLabel("미리보기 모델 식별자", { exact: true }).fill("late-input"));
  await delay(() => box().locator(":scope > summary").click());
  await box().locator(":scope > summary").click();
  await delay(() => area().getByRole("button", { name: "새 주장·근거 기록", exact: true }).click());
  assert.ok(await area().getByText("첫 주장 기록", { exact: true }).count());
  page.once("dialog", (d) => d.accept());
  await area().getByRole("button", { name: "편집 취소", exact: true }).click();
  assert.equal(await box().evaluate((e) => e.open), false);
  record(
    "late responses after editing input, closing or starting manual claim edit are discarded; existing edit stays available",
  );
  await select();
  await delay(() => openCompany(companies[1]));
  assert.equal(await box().evaluate((e) => e.open), false);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(writes, []);
  const count = posts.length;
  await context.close();
  context = null;
  await stop();
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile-reopen"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1100, height: 1000 },
  });
  await context.route("**/*", routeRequest);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await openCompany(companies[0]);
  assert.equal(await box().evaluate((e) => e.open), false);
  await box().locator(":scope > summary").click();
  assert.equal(await box().getByRole("combobox").inputValue(), "");
  assert.equal(posts.length, count);
  assert.deepEqual(rows(), initialRows);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_BLOCKED"));
  record(
    "company switch and server/page restart discard transient previews; all four SQLite tables and manual records unchanged",
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        localPreviewCommands: posts.length,
        writes,
        unchangedTables: 4,
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
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
