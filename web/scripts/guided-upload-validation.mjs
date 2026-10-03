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
  "Usage: node scripts/guided-upload-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-guided-upload-"));
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

const name = "합성 업로드 확인 · PDF와 워드 16개";
let caseId;
async function materials() {
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button")
    .first()
    .click();
}
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await materials();
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
const requests = [];
let loseResponse = false;
let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
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
  await context.route("**/api/studio/cases/*/sources", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataBuffer();
    assert.ok(body.includes(Buffer.from('name="allowAi"\r\n\r\nfalse')));
    requests.push(route.request().url());
    if (requests.length === 1) await firstGate;
    if (loseResponse) {
      loseResponse = false;
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      return route.abort("failed");
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  let aiWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /guided-preparation|source-intakes|extract|analyze|generate/.test(request.url())
    )
      aiWrites++;
  });
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  assert.equal((await (await api("/api/studio/status")).json()).aiConfigured, false);
  assert.deepEqual((await (await api("/api/studio/cases")).json()).cases, []);
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  const company = await mutation(() =>
    page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
  );
  caseId = company.id;
  await page.getByRole("heading", { name: "저장된 자료 0개", exact: true }).waitFor();
  record("empty storage is explicit before selection");
  const files = [];
  for (let index = 1; index <= 8; index++) {
    files.push({
      name: "합성-PDF-" + index + ".pdf",
      mimeType: "application/pdf",
      buffer: pdf(index === 1 ? "" : "Synthetic PDF original " + index),
    });
    files.push({
      name: "합성-워드-" + index + ".docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await docx(index),
    });
  }
  const input = () => page.getByLabel("회사 자료 파일 선택", { exact: true });
  const receipt = () => page.getByRole("region", { name: "이번 업로드 결과", exact: true });
  const inventory = () => page.getByRole("region", { name: "저장된 자료 목록", exact: true });
  await input().setInputFiles(files);
  await receipt().getByRole("heading", { name: "이번에 선택한 자료 16개" }).waitFor();
  assert.equal(await receipt().getByRole("listitem").count(), 16);
  assert.ok((await receipt().innerText()).includes("저장 중"));
  assert.ok((await receipt().innerText()).includes("전송 대기"));
  releaseFirst();
  await page
    .getByRole("heading", { name: "저장된 자료 16개", exact: true })
    .waitFor({ timeout: 45000 });
  assert.match(await receipt().getByRole("status").innerText(), /저장 완료 16개 · 저장 실패 0개/);
  assert.equal(requests.length, 17, "16 files + exactly one known NO_TEXT original-only fallback");
  assert.equal(await inventory().getByRole("listitem").count(), 12);
  await inventory().getByRole("button", { name: "자료 더 보기 (4개 남음)", exact: true }).click();
  assert.equal(await inventory().getByRole("listitem").count(), 16);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page
      .getByRole("navigation", { name: "신청 준비 3단계" })
      .getByRole("button")
      .first()
      .getAttribute("aria-current"),
    "step",
  );
  const stored = await (await api("/api/studio/cases/" + caseId)).json();
  assert.equal(stored.sources.length, 16);
  assert.equal(stored.sources.filter((item) => item.extraction === "pending").length, 1);
  assert.equal(stored.sources.filter((item) => item.text.trim()).length, 15);
  for (const file of files) {
    const source = stored.sources.find((item) => item.originalName === file.name);
    assert.ok(source);
    const original = await (
      await api("/api/studio/cases/" + caseId + "/sources/" + source.id)
    ).body();
    assert.deepEqual(original, file.buffer);
  }
  record(
    "16 mixed PDFs/DOCX saved with exact originals and separate pending-body status; stays on results",
  );
  const downloadPromise = page.waitForEvent("download");
  await inventory()
    .getByRole("link", { name: /원본 내려받기.*합성-PDF-1/ })
    .click();
  const download = await downloadPromise;
  assert.deepEqual(await readFile(await download.path()), files[0].buffer);
  await page.screenshot({ path: path.join(output, "sixteen-saved.png"), fullPage: true });
  await reopen();
  assert.equal(await receipt().count(), 0);
  assert.equal(await inventory().getByRole("listitem").count(), 12);
  record("original download and inventory survive a browser reload");
  const beforeBrowse = JSON.stringify(await (await api("/api/studio/cases/" + caseId)).json());
  await inventory().getByRole("searchbox", { name: "파일명·본문 검색" }).fill("합성-워드-3");
  assert.equal(await inventory().getByRole("listitem").count(), 1);
  assert.ok((await inventory().innerText()).includes("합성 워드 시험 3"));
  await inventory()
    .getByRole("searchbox", { name: "파일명·본문 검색" })
    .fill("Synthetic PDF original 5");
  assert.equal(await inventory().getByRole("listitem").count(), 1);
  assert.ok((await inventory().innerText()).includes("합성-PDF-5.pdf"));
  await inventory().getByRole("searchbox", { name: "파일명·본문 검색" }).fill("");
  await inventory().getByRole("combobox", { name: "자료 상태 필터" }).selectOption("pending");
  assert.equal(await inventory().getByRole("listitem").count(), 1);
  assert.ok((await inventory().innerText()).includes("합성-PDF-1.pdf"));
  await inventory()
    .getByRole("button", { name: "자료 열기 · 합성-PDF-1.pdf", exact: true })
    .click();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await inventory().getByRole("searchbox", { name: "파일명·본문 검색" }).fill("없는 파일");
  assert.ok((await inventory().innerText()).includes("조건에 맞는 자료가 없습니다"));
  await inventory().getByRole("searchbox", { name: "파일명·본문 검색" }).fill("");
  assert.equal(
    JSON.stringify(await (await api("/api/studio/cases/" + caseId)).json()),
    beforeBrowse,
  );
  assert.equal(requests.length, 17);
  await inventory().getByRole("combobox", { name: "자료 상태 필터" }).selectOption("all");
  await page.screenshot({ path: path.join(output, "attachment-cards.png"), fullPage: true });
  record(
    "attachment cards search by filename/body, filter pending text, and open review without changing data or AI scope",
  );
  await input().setInputFiles([
    {
      name: "추가정상.pdf",
      mimeType: "application/pdf",
      buffer: pdf("Additional synthetic original"),
    },
    {
      name: "손상워드.docx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("PKgarbage"),
    },
    { name: "아직전송안함.pdf", mimeType: "application/pdf", buffer: pdf("Should never be sent") },
  ]);
  await page.getByRole("alert").filter({ hasText: "손상워드.docx" }).waitFor();
  assert.match(
    await receipt().getByRole("status").innerText(),
    /저장 완료 1개 · 저장 실패 1개 · 확인 필요 0개 · 전송하지 않음 1개/,
  );
  assert.equal(requests.length, 19);
  assert.equal(await inventory().getByRole("listitem").count(), 12);
  await page.screenshot({ path: path.join(output, "partial-failure.png"), fullPage: true });
  record("partial success retains saved files and names the failed and never-sent files");
  const beforeUnknown = requests.length;
  loseResponse = true;
  await input().setInputFiles([
    {
      name: "응답유실.pdf",
      mimeType: "application/pdf",
      buffer: pdf("Stored before response loss"),
    },
    { name: "대기워드.docx", mimeType: "application/octet-stream", buffer: await docx(99) },
  ]);
  await page.getByRole("button", { name: "저장 상태 확인", exact: true }).waitFor();
  assert.match(
    await receipt().getByRole("status").innerText(),
    /저장 완료 0개 · 저장 실패 0개 · 확인 필요 1개 · 전송하지 않음 1개/,
  );
  await page.getByRole("button", { name: "저장 상태 확인", exact: true }).click();
  await page.getByRole("heading", { name: "저장된 자료 18개", exact: true }).waitFor();
  assert.ok((await inventory().innerText()).includes("응답유실.pdf"));
  assert.equal(requests.length, beforeUnknown + 1, "No uncertain upload retry");
  record(
    "response lost after actual storage is uncertain, then read-only reconciliation shows the original without retry",
  );
  await input().setInputFiles([
    { name: "위장.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF") },
  ]);
  await page.getByRole("alert").filter({ hasText: "위장.pdf" }).waitFor();
  assert.match(await receipt().getByRole("status").innerText(), /저장 완료 0개 · 저장 실패 1개/);
  assert.equal(
    requests.length,
    beforeUnknown + 2,
    "Damaged PDF cannot fall back to original storage",
  );
  assert.equal(await inventory().getByRole("listitem").count(), 12);
  record("damaged PDF remains a failure, not NO_TEXT original fallback");
  await input().setInputFiles([
    { name: "과거형식.doc", mimeType: "application/msword", buffer: Buffer.from("old word") },
  ]);
  await page.getByRole("alert").filter({ hasText: "과거형식.doc" }).waitFor();
  assert.match(await receipt().getByRole("status").innerText(), /저장 완료 0개 · 저장 실패 1개/);
  const beforeEmpty = requests.length;
  await input().setInputFiles([
    { name: "빈파일.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) },
  ]);
  await page.getByRole("alert").filter({ hasText: "내용이 있는 파일" }).waitFor();
  assert.match(await receipt().getByRole("status").innerText(), /전송하지 않음 1개/);
  assert.equal(requests.length, beforeEmpty);
  record("unsupported Word is explicit and empty-file preflight sends nothing");
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, "mobile overflow: " + overflow);
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(aiWrites, 0);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record("mobile layout fits, no browser errors, AI writes or external requests");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        buildId,
        staging,
        dataDirectory,
        caseId,
        checks,
        actualProviderCalls: 0,
        sourcePosts: requests.length,
        savedSources: 18,
        customerDataUsed: false,
      },
      null,
      2,
    ),
  );
  console.log("Upload report: " + path.join(output, "report.json"));
} catch (error) {
  if (page) {
    await writeFile(
      path.join(output, "failure-ui.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { passed: false, buildId, checks, error: String(error), errors, externalRequests },
      null,
      2,
    ),
  );
  console.error("Failed acceptance retained: " + output);
  throw error;
} finally {
  if (context) await context.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
