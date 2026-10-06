import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
const staging = await realpath(process.argv[2]);
const mode = process.argv[3] ?? "dev";
assert.ok(["dev", "start"].includes(mode));
assert.ok(path.relative(temporaryRoot, staging) && !path.relative(temporaryRoot, staging).startsWith(".."));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function compareTree(relative) {
  for (const item of await readdir(path.join(app, relative), { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink());
    const child = path.join(relative, item.name);
    if (item.isDirectory()) await compareTree(child);
    else assert.equal(hash(await readFile(path.join(app, child))), hash(await readFile(path.join(staging, child))), child);
  }
}
await compareTree("src");
const fixture = JSON.parse(await readFile(path.join(app, "src/lib/fixtures/comparison-review-example.json"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(app, "src/lib/fixtures/comparison-review-example-provenance.json"), "utf8"));
assert.equal(provenance.kind, "synthetic-sql13-export");
assert.equal(provenance.wireSha256, hash(JSON.stringify(fixture)));
assert.equal(provenance.runId, fixture.query.runId);
assert.equal(provenance.dispatchCommandDigest, fixture.query.dispatchCommandDigest);

// Test-only decoder bundle: validate synthetic state variants without loading
// server data, SDK helpers, SQLite or operational acquisition modules.
const requireFromVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireFromVitest.resolve("rolldown")).href);
const decoderBundle = await rolldown({
  input: path.join(app, "src/lib/studio-public-claim-comparison-review-wire.ts"), cwd: app,
  platform: "browser", tsconfig: path.join(app, "tsconfig.json"),
  plugins: [{ name: "deny-activation", resolveId(source) {
    if (/openai|server-only|node:|storage|quality-store|comparison-database|provider-production|review-handler|review-server/.test(source))
      throw Error("Forbidden decoder import: " + source);
    return null;
  } }],
});
let stateDecoder;
try {
  const output = await decoderBundle.generate({ format: "esm" });
  assert.equal(output.output.length, 1);
  const chunk = output.output[0];
  assert.equal(chunk.type, "chunk");
  assert.deepEqual(chunk.imports, []); assert.deepEqual(chunk.dynamicImports, []);
  stateDecoder = await import("data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64"));
} finally { await decoderBundle.close(); }
const stateCases = [
  [
    "comparison-rejected",
    "저장된 응답이 비교 검증을 통과하지 못해 표시할 의견이 없습니다."
  ],
  [
    "response-incomplete",
    "저장된 응답이 완료되지 않아 표시할 비교 의견이 없습니다."
  ],
  [
    "response-unsupported",
    "저장된 응답 형식이 지원 범위와 맞지 않아 표시할 비교 의견이 없습니다."
  ],
  [
    "model-mismatch",
    "저장된 응답의 모델이 원래 요청과 일치하지 않아 표시할 비교 의견이 없습니다."
  ]
].map(([state, message]) => {
  const result = structuredClone(fixture.result);
  result.historical.result.state = state;
  result.historical.result.comparison = null;
  const body = stateDecoder.comparisonReviewSuccessWire(fixture.query, result);
  assert.deepEqual(stateDecoder.decodeComparisonReviewWire(body, 200, fixture.query), result);
  return { state, message, body };
});

const endpoint = "/api/studio/cases/" + fixture.result.resultIdentity.selection.companyId + "/public-claim-comparison/stored-review";
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-review-app-"));
const guard = path.join(output, "network-guard.mjs");
await writeFile(guard, 'const f=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==="string"||input instanceof URL?input:input.url);if(!["127.0.0.1","localhost","[::1]"].includes(u.hostname))throw Error("EXTERNAL_FETCH_FORBIDDEN");return f(input,init);};');
const environment = localBuildEnvironment(output);
environment.NODE_ENV = mode === "dev" ? "development" : "production";
environment.OPENAI_API_KEY = ""; environment.KOSIS_API_KEY = "";
delete environment.NODE_OPTIONS;
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const origin = "http://127.0.0.1:" + port, logs = [], errors = [], external = [], posts = [], checks = [];
let child, context, page;
function record(name) { checks.push(name); console.log("PASS " + name); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// Test synchronization only: SSR markup can be visible before React attaches
// the event handler. Inspect readiness without clicking or creating an owner.
async function waitForExampleHydration(target) {
  await target.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "합성 예제 시작");
    return button && Object.keys(button).some((key) => key.startsWith("__reactProps$") &&
      typeof button[key]?.onClick === "function");
  });
}

try {
  child = spawn(process.execPath, ["--import", pathToFileURL(guard).href,
    path.join(staging, "node_modules/next/dist/bin/next"), mode,
    ...(mode === "dev" ? ["--webpack"] : []), "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: staging, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (b) => logs.push(b.toString()));
  child.stderr.on("data", (b) => logs.push(b.toString()));
  const deadline = Date.now() + 60000;
  while (!logs.join("").includes("Ready in")) {
    assert.equal(child.exitCode, null, logs.join(""));
    if (Date.now() > deadline) throw Error("App startup timeout: " + logs.join(""));
    await delay(200);
  }
  context = await chromium.launchPersistentContext(path.join(output, "profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true, serviceWorkers: "block", args: ["--disable-background-networking"],
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    // Navigation into the existing studio must not load its SDK-bearing status
    // module or initialize a store. Only the new example API uses real HTTP.
    if (url.pathname === "/api/studio/status") return route.fulfill({ status: 200,
      contentType: "application/json", body: JSON.stringify({ aiConfigured: false,
        model: "synthetic-disabled", storage: "local", supportedFiles: [] }) });
    if (url.pathname === "/api/studio/cases") return route.fulfill({ status: 200,
      contentType: "application/json", body: '{"cases":[]}' });
    if (url.pathname.startsWith("/api/") && url.pathname !== endpoint) {
      external.push("UNEXPECTED_LOCAL_API:" + url.pathname); return route.abort();
    }
    return route.continue();
  });
  context.on("page", (opened) => opened.on("pageerror", (e) => errors.push(e.message)));
  page = await context.newPage();
  page.on("request", (r) => { if (r.method() === "POST") posts.push({ path: new URL(r.url()).pathname, body: r.postData() }); });
  await page.goto(origin + "/studio/review-example", { waitUntil: "networkidle", timeout: 90000 });
  await page.getByRole("heading", { name: "공개 근거 검토 예제", exact: true }).waitFor();
  assert.match(await page.getByTestId("example-provenance").innerText(), /합성 저장 결과의 시점 고정 사본/);
  assert.equal(posts.length, 0);
  await waitForExampleHydration(page);
  await page.getByRole("button", { name: "합성 예제 시작", exact: true }).click();
  await page.getByRole("button", { name: "검토 결과 읽기", exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((b) => b.textContent === "검토 결과 읽기")?.disabled);
  assert.equal(posts.length, 0);
  record("real app hydration and explicit holder creation send no read request");
  await page.getByRole("button", { name: "검토 결과 읽기", exact: true }).click();
  await page.getByTestId("example-result").waitFor();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { path: endpoint, body: JSON.stringify(fixture.query) });
  record("real loopback POST renders the fixed synthetic result through the existing receiver");
  const displayed = page.getByTestId("example-result");
  const opinion = fixture.result.historical.result.comparison.comparison;
  assert.equal(await displayed.getByRole("heading", { name: "저장된 검토 의견", exact: true }).count(), 1);
  assert.equal(await displayed.getByTestId("overall-relation").textContent(), "전체 판단: 판단 유보");
  assert.equal(await displayed.getByTestId("overall-reason").textContent(), opinion.overall.reason);
  for (const source of fixture.result.historical.prepared.input.selectedEvidence) {
    const row = displayed.locator('[data-source-id="' + source.sourceId + '"]');
    const stored = opinion.evidence.find((e) => e.sourceId === source.sourceId);
    assert.equal(await row.getByRole("heading", { name: source.metadata.title, exact: true }).count(), 1);
    assert.equal(await row.getByText(stored.reason, { exact: true }).count(), 1);
    assert.deepEqual(await row.locator("blockquote").allTextContents(), stored.quotes);
    assert.equal(await row.getByTestId("next-check").textContent(), stored.nextCheck || "저장된 추가 확인 메모가 없습니다.");
    assert.equal(await row.getByTestId("source-excerpt").isVisible(), false);
    await row.locator("summary").click();
    assert.equal(await row.getByTestId("source-excerpt").textContent(), source.excerpt);
    assert.equal(await row.getByTestId("source-excerpt").isVisible(), true);
  }
  assert.equal(posts.length, 1);
  record("4I52 original stored opinions and matching source excerpts render without additional HTTP");
  await page.screenshot({ path: path.join(output, "result-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await displayed.getByTestId("overall-reason").textContent(), opinion.overall.reason);
  await page.screenshot({ path: path.join(output, "result-mobile.png"), fullPage: true });
  assert.equal(posts.length, 1);
  record("4I52 expanded opinion and original excerpt remain readable on mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "표시 비우기", exact: true }).click();
  assert.equal(await page.getByTestId("example-result").count(), 0);
  assert.equal(posts.length, 1);
  await page.getByRole("button", { name: "검토 결과 읽기", exact: true }).click();
  await page.getByTestId("example-result").waitFor();
  assert.equal(posts.length, 2);
  record("explicit release and next explicit read reuse the original holder");
  await page.getByRole("link", { name: "스튜디오로 돌아가기", exact: true }).click();
  await page.waitForURL(origin + "/studio");
  await page.getByRole("button", { name: "다른 메뉴 열기", exact: true }).click();
  await page.getByRole("link", { name: "공개 근거 검토 예제", exact: true }).click();
  await page.waitForURL(origin + "/studio/review-example");
  assert.equal(await page.getByRole("button", { name: "합성 예제 시작", exact: true }).count(), 0);
  assert.equal(await page.getByTestId("example-result").count(), 0);
  assert.equal(posts.filter((p) => p.path === endpoint).length, 2);
  await page.getByRole("button", { name: "검토 결과 읽기", exact: true }).click();
  await page.getByTestId("example-result").waitFor();
  record("actual route navigation retains one holder and requires a new explicit read");
  await page.getByRole("button", { name: "예제 종료", exact: true }).click();
  await page.getByText("예제가 종료되었습니다. 이 창에서는 새 읽기를 시작하지 않습니다.", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("example-result").count(), 0);
  assert.equal(await page.getByRole("button", { name: "검토 결과 읽기", exact: true }).isDisabled(), true);
  record("terminal notification clears actual DOM and stops admission");
  await page.getByRole("link", { name: "스튜디오로 돌아가기", exact: true }).click();
  await page.waitForURL(origin + "/studio");
  await page.getByRole("button", { name: "다른 메뉴 열기", exact: true }).click();
  await page.getByRole("link", { name: "공개 근거 검토 예제", exact: true }).click();
  await page.waitForURL(origin + "/studio/review-example");
  await page.getByText("예제가 종료되었습니다. 이 창에서는 새 읽기를 시작하지 않습니다.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "합성 예제 시작", exact: true }).count(), 0);
  assert.equal(posts.filter((p) => p.path === endpoint).length, 3);
  record("navigation after close cannot create a replacement holder");
  // Isolated new page/root: simulate an unknown transport receipt only in this browser test.
  const failure = await context.newPage();
  await failure.route("**" + endpoint, (route) => route.fulfill({ status: 500,
    contentType: "application/json", body: JSON.stringify({ wireVersion: 1, kind: "public-comparison-stored-review-error", code: "READ_FAILED" }) }));
  await failure.goto(origin + "/studio/review-example", { waitUntil: "networkidle" });
  await waitForExampleHydration(failure);
  await failure.getByRole("button", { name: "합성 예제 시작", exact: true }).click();
  await failure.getByRole("button", { name: "검토 결과 읽기", exact: true }).click();
  await failure.getByRole("region", { name: "합성 검토 결과" }).getByRole("alert").waitFor();
  assert.equal(await failure.getByRole("button", { name: "검토 결과 읽기", exact: true }).isDisabled(), true);
  await failure.getByRole("button", { name: "예제 종료", exact: true }).click();
  await failure.getByText("예제가 종료되었습니다. 이 창에서는 새 읽기를 시작하지 않습니다.", { exact: true }).waitFor();
  assert.equal(await failure.getByRole("region", { name: "합성 검토 결과" }).getByRole("alert").count(), 0);
  await failure.close();
  record("synthetic missing receipt holds the slot and close clears the error");
  // New page/root for responsive layout; no read on load.
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(origin + "/studio/review-example", { waitUntil: "networkidle" });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: path.join(output, "example-mobile.png"), fullPage: true });
  await mobile.close();
  record("mobile layout has no horizontal overflow");

  // These four browser-injected variants are strict-wire-checked synthetic
  // presentation inputs. They are not the committed SQL13 export or real API reads.
  const syntheticStatePosts = [];
  for (const scenario of stateCases) {
    const statePage = await context.newPage();
    let statePosts = 0;
    await statePage.route("**" + endpoint, (route) => {
      assert.equal(route.request().method(), "POST");
      assert.equal(route.request().postData(), JSON.stringify(fixture.query));
      statePosts++;
      syntheticStatePosts.push({ state: scenario.state, path: endpoint });
      return route.fulfill({ status: 200, contentType: "application/json",
        headers: { "x-venturepass-example-request": "complete" }, body: scenario.body });
    });
    await statePage.goto(origin + "/studio/review-example", { waitUntil: "networkidle" });
    await waitForExampleHydration(statePage);
  await statePage.getByRole("button", { name: "합성 예제 시작", exact: true }).click();
    assert.equal(statePosts, 0);
    assert.equal(await statePage.getByTestId("example-result-state").count(), 0);
    await statePage.getByRole("button", { name: "검토 결과 읽기", exact: true }).click();
    await statePage.getByTestId("example-result-state").waitFor();
    await statePage.getByText("저장 결과 읽기를 마쳤습니다.", { exact: true }).waitFor();
    assert.equal(await statePage.getByTestId("stored-state-message").textContent(), scenario.message);
    assert.equal(await statePage.getByTestId("example-result").count(), 0);
    assert.equal(await statePage.getByRole("region", { name: "합성 검토 결과" }).getByRole("alert").count(), 0);
    assert.equal(statePosts, 1);
    if (scenario.state === "response-incomplete") {
      await statePage.screenshot({ path: path.join(output, "stored-state-desktop.png"), fullPage: true });
      await statePage.setViewportSize({ width: 390, height: 844 });
      assert.equal(await statePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await statePage.screenshot({ path: path.join(output, "stored-state-mobile.png"), fullPage: true });
    }
    await statePage.getByRole("button", { name: "표시 비우기", exact: true }).click();
    assert.equal(await statePage.getByTestId("example-result-state").count(), 0);
    assert.equal(await statePage.getByText("저장 결과 읽기를 마쳤습니다.", { exact: true }).count(), 0);
    assert.equal(statePosts, 1);
    await statePage.getByRole("button", { name: "검토 결과 읽기", exact: true }).click();
    await statePage.getByTestId("example-result-state").waitFor();
    assert.equal(statePosts, 2);
    await statePage.getByRole("button", { name: "예제 종료", exact: true }).click();
    await statePage.getByText("예제가 종료되었습니다. 이 창에서는 새 읽기를 시작하지 않습니다.", { exact: true }).waitFor();
    assert.equal(await statePage.getByTestId("example-result-state").count(), 0);
    assert.equal(await statePage.getByRole("button", { name: "검토 결과 읽기", exact: true }).isDisabled(), true);
    assert.equal(statePosts, 2);
    await statePage.close();
    record("4I53 injected " + scenario.state + " reports stored state and clears on release/close");
  }

  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.ok(!logs.join("").includes("EXTERNAL_FETCH_FORBIDDEN"));
  // Only the fixed example API may receive POSTs in this acceptance run.
  assert.ok(posts.every((p) => p.path === endpoint));
  await writeFile(path.join(output, "report.json"), JSON.stringify({ checks, posts, syntheticStatePosts, errors, external, mode, staging }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output, readPosts: posts.length, setupPosts: 0, interceptedErrors: 1, interceptedStates: syntheticStatePosts.length, external: 0, pageErrors: 0 }));
} catch (error) {
  await writeFile(path.join(output, "failure.txt"), logs.join("") + "\n" + JSON.stringify({ errors, external }) + "\n" + String(error) +
    "\n" + (await page?.locator("body").innerText().catch(() => "")));
  await page?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error("Validation diagnostics: " + output);
  throw error;
} finally {
  await context?.close();
  if (child?.exitCode === null) {
    const ended = new Promise((r) => child.once("exit", r)); child.kill(); await ended;
  }
}
