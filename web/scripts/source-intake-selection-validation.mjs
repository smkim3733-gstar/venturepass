import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// This acceptance run uses the actual production UI/API and a new synthetic data directory.
// The explicit build must be a current, environment-free build:local staging directory.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
assert.equal(
  process.argv.length,
  3,
  "Usage: node scripts/source-intake-selection-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-intake-selection-"));
const dataDirectory = path.join(output, "synthetic-data");
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  `const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    process.stderr.write("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED\\n");
    throw new Error("External fetch disabled for local acceptance");
  }
  return original(input, init);
};`,
);
const environment = localBuildEnvironment(output);
environment.VENTURE_DATA_DIR = dataDirectory;
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
async function mutation(action) {
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes("/api/studio/cases") &&
      ["POST", "PATCH"].includes(response.request().method()),
    { timeout: 20000 },
  );
  const [response] = await Promise.all([pending, action()]);
  assert.ok(response.ok(), response.status() + " " + (await response.text()));
  return response.json();
}

function pdf(text) {
  const stream = text ? "BT /F1 12 Tf 40 200 Td (" + text + ") Tj ET" : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += index + 1 + " 0 obj\n" + value + "\nendobj\n";
  }
  const xref = Buffer.byteLength(result);
  result += "xref\n0 " + offsets.length + "\n0000000000 65535 f \n";
  result += offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
    .join("");
  result +=
    "trailer\n<< /Size " + offsets.length + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return Buffer.from(result);
}
async function docx(index) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>합성 워드 시험 ' +
      index +
      " 실제 고객 자료가 아닙니다.</w:t></w:r></w:p></w:body></w:document>",
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const name = "합성 중단·재선택 검증";
let caseId;
const writes = [];
let loseSecondResponse = true;
const files = [
  { name: "first.pdf", mimeType: "application/pdf", buffer: pdf("First synthetic original") },
  {
    name: "second.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await docx(2),
  },
  { name: "third.pdf", mimeType: "application/pdf", buffer: pdf("Third synthetic original A") },
];
const panel = () => page.getByRole("region", { name: "복수파일 접수·판독 재개", exact: true });
async function details() {
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("tab", { name: /자료함/ }).click();
  await panel().getByRole("button", { name: "저장 상태 확인", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const field = document.querySelector(
      '[aria-label="복수파일 접수·판독 재개"] input[type="file"]',
    );
    return field && !field.matches(":disabled");
  });
}
async function snapshot() {
  return (await api("/api/studio/cases/" + caseId)).json();
}
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1360, height: 1000 },
    acceptDownloads: true,
  });
  context.setDefaultTimeout(20000);
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await context.route("**/source-intakes**", async (route) => {
    const request = route.request();
    if (!["POST", "PUT"].includes(request.method())) return route.fallback();
    writes.push({ method: request.method(), url: request.url() });
    if (request.method() === "POST") assert.equal(request.postDataJSON().action, "create");
    if (
      request.method() === "PUT" &&
      writes.filter((w) => w.method === "PUT").length === 2 &&
      loseSecondResponse
    ) {
      loseSecondResponse = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      return route.abort("failed");
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  assert.equal((await (await api("/api/studio/status")).json()).aiConfigured, false);
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  const company = await mutation(() =>
    page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
  );
  caseId = company.id;
  await details();
  await panel()
    .getByLabel("여러 원본 파일 선택 (외부 AI 미전송)", { exact: true })
    .setInputFiles(files);
  await panel()
    .getByRole("button", { name: "지원 가능한 3개 원본 순차 접수", exact: true })
    .click();
  await panel().getByRole("button", { name: "같은 요청으로 결과 확인", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('[aria-label="복수파일 접수·판독 재개"] button').matches(":disabled"),
  );
  const interrupted = await snapshot();
  assert.equal(interrupted.sources.length, 2);
  assert.equal(interrupted.sourceIntakes.length, 3);
  for (const [i, item] of interrupted.sourceIntakes.entries())
    assert.equal(item.declared.sha256, digest(files[i].buffer));
  assert.equal(writes.filter((w) => w.method === "PUT").length, 2);
  record("UI hashes PDF/DOCX before declaration; lost second response stops third transfer");
  await panel().getByRole("button", { name: "같은 요청으로 결과 확인", exact: true }).click();
  await panel().getByText("저장 상태를 확인했습니다.", { exact: false }).count();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "같은 요청으로 결과 확인",
      ),
  );
  assert.equal(writes.filter((w) => w.method === "PUT").length, 2);
  assert.deepEqual(await snapshot(), interrupted);
  record("original receipt reconciles lost response with GET and zero new PUT");
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("about:blank");
  await stop();
  await start();
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await details();
  assert.match(
    await panel().getByLabel("접수 원본 보관 요약").innerText(),
    /원본 보관 2개.*다시 선택·접수 1개.*상태 확인 0개/,
  );
  assert.deepEqual(await snapshot(), interrupted);
  assert.equal(await panel().getByText("파일 다시 선택 필요", { exact: true }).count(), 1);
  record(
    "server restart and browser reload preserve originals and require remaining File reselection",
  );
  const reselect = panel().getByLabel("미접수 원본 다시 선택", { exact: true });
  const mismatch = { ...files[2], buffer: pdf("Third synthetic original B") };
  assert.equal(mismatch.buffer.length, files[2].buffer.length);
  const count = writes.length;
  await reselect.setInputFiles(mismatch);
  await panel().getByRole("button", { name: "이 원본 접수", exact: true }).click();
  await panel().getByText("처음 선택한 파일과 내용이 다릅니다.", { exact: false }).waitFor();
  assert.equal(writes.length, count);
  assert.deepEqual(await snapshot(), interrupted);
  record("same-name equal-size different PDF is rejected in browser before any PUT");
  await reselect.setInputFiles(files[2]);
  const complete = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && response.url().includes("/source-intakes/"),
  );
  await panel().getByRole("button", { name: "이 원본 접수", exact: true }).click();
  assert.equal((await complete).status(), 200);
  await panel().getByLabel("접수 원본 보관 요약").filter({ hasText: "원본 보관 3개" }).waitFor();
  const final = await snapshot();
  assert.equal(final.sources.length, 3);
  assert.deepEqual(final.sourceIntakes.slice(0, 2), interrupted.sourceIntakes.slice(0, 2));
  for (const [i, item] of final.sourceIntakes.entries()) {
    const original = await api(`/api/studio/cases/${caseId}/sources/${item.sourceId}`);
    assert.deepEqual(await original.body(), files[i].buffer);
    assert.equal(final.sources[i].text, "");
  }
  record(
    "only the exact remaining file is stored; all originals stay unchanged and bodies unreviewed",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await panel().scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await page.screenshot({ path: path.join(output, "reselection-mobile.png"), fullPage: true });
  assert.equal(externalRequests.length, 0);
  assert.deepEqual(errors, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record("390px display, no external request, no parser or AI execution");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { buildId, checks, writes, externalRequests, errors, sourceCount: final.sources.length },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, buildId, checks: checks.length, sourceCount: final.sources.length }),
  );
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
      ).slice(0, 4500),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
