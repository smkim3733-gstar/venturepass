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
  "Usage: node scripts/guided-bulk-upload-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-guided-bulk-"));
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

const name = "합성 간단 대량 접수";
let caseId, holdRelease, holdEntered;
let holdPutTen = true,
  loseBefore = false,
  loseAfter = false,
  blockReads = false,
  refuseCreate = false,
  holdCreate = false;
const writes = [],
  aiRequests = [];
const files = await Promise.all(
  Array.from({ length: 11 }, async (_, i) =>
    i % 2
      ? {
          name: `bulk-${i}.docx`,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buffer: await docx(i),
        }
      : {
          name: `bulk-${i}.pdf`,
          mimeType: "application/pdf",
          buffer: pdf(`Synthetic original ${String(i).padStart(2, "0")} A`),
        },
  ),
);
const panel = () => page.getByRole("region", { name: "자료 업로드와 이어 올리기", exact: true });
const queueKey = () => `venturepass:intake-bulk-queue:v1:${caseId}`;
const outboxKey = () => `venturepass:intake-upload-outbox:v1:${caseId}`;
async function snapshot() {
  return (await api("/api/studio/cases/" + caseId)).json();
}
async function ready() {
  await page.waitForFunction(() => {
    const section = document.querySelector('[aria-label="자료 업로드와 이어 올리기"]');
    const input = section?.querySelector('input[type="file"]');
    return input && !input.disabled;
  });
}
async function idle() {
  await page.waitForFunction(() => {
    const section = document.querySelector('[aria-label="자료 업로드와 이어 올리기"]');
    return (
      section &&
      ![...section.querySelectorAll("button")].find((b) => b.textContent === "저장 상태 확인")
        ?.disabled
    );
  });
}
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await ready();
}
async function selectNewCompany(label) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "기업 추가", exact: true }).click();
  await page.locator("#new-company-name").fill(label);
  caseId = (
    await mutation(() =>
      page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
    )
  ).id;
  await ready();
}
try {
  await start();
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    viewport: { width: 1360, height: 1000 },
    acceptDownloads: true,
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    if (
      /\/(prepare|generate|analyze|provider-executions)(\/|$)/.test(
        new URL(route.request().url()).pathname,
      )
    )
      aiRequests.push(route.request().url());
    return route.continue();
  });
  await context.route("**/source-intakes**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" && blockReads) return route.abort("failed");
    if (!["POST", "PUT"].includes(request.method())) return route.fallback();
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    const nonce =
      body?.clientRequestId ??
      /name="clientRequestId"\r\n\r\n([^\r\n]+)/.exec(
        request.postDataBuffer().toString("utf8"),
      )?.[1];
    assert.ok(nonce);
    writes.push({ method: request.method(), url: request.url(), nonce, action: body?.action });
    if (body) assert.equal(body.action, "create", "UI must not auto-run/adopt extracted text");
    if (body && refuseCreate) {
      refuseCreate = false;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTAKE_VERSION_CONFLICT", accepted: false }),
      });
    }
    if (request.method() === "PUT" && loseBefore) {
      loseBefore = false;
      return route.abort("failed");
    }
    if (request.method() === "PUT" && loseAfter) {
      loseAfter = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      blockReads = true;
      return route.abort("failed");
    }
    if (
      (body && holdCreate) ||
      (request.method() === "PUT" &&
        holdPutTen &&
        writes.filter((w) => w.method === "PUT").length === 10)
    ) {
      holdCreate = false;
      holdPutTen = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const wait = new Promise((resolve) => {
        holdRelease = resolve;
      });
      holdEntered?.();
      await wait;
      return route.fulfill({ response });
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  assert.equal((await (await api("/api/studio/status")).json()).aiConfigured, false);
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  caseId = (
    await mutation(() =>
      page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
    )
  ).id;
  await ready();
  const paused = new Promise((resolve) => {
    holdEntered = resolve;
  });
  // Actual drag/drop uses the same browser File objects as ordinary selection.
  const transfer = await page.evaluateHandle(
    (inputs) => {
      const dt = new DataTransfer();
      for (const file of inputs)
        dt.items.add(
          new File([Uint8Array.from(atob(file.bytes), (x) => x.charCodeAt(0))], file.name, {
            type: file.mimeType,
          }),
        );
      return dt;
    },
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      bytes: file.buffer.toString("base64"),
    })),
  );
  await panel()
    .locator('[aria-label="자료 파일 끌어놓기"]')
    .dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await panel().getByRole("heading", { name: "이번에 선택한 자료 11개" }).waitFor();
  await Promise.race([
    paused,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(Error("First batch hold was not reached")), 90000);
      timeout.unref();
    }),
  ]);
  const savedSelection = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    queueKey(),
  );
  assert.equal(savedSelection.files.length, 11);
  assert.equal(savedSelection.batches.length, 2);
  assert.equal(writes.filter((w) => w.method === "POST").length, 1);
  const other = await context.newPage();
  other.on("pageerror", (error) => errors.push(error.message));
  await other.goto(origin + "/studio", { waitUntil: "networkidle" });
  await other.getByRole("button").filter({ hasText: name }).first().click();
  await other
    .getByText("다른 화면에서 이 회사의 자료를 처리하고 있습니다.", { exact: false })
    .waitFor();
  assert.equal(writes.length, 11);
  await other.close();
  record("drag shows all eleven file cards; a second tab cannot transmit during the queue lock");
  await panel().getByRole("button", { name: "현재 파일 뒤 일시 중단", exact: true }).click();
  holdRelease();
  await idle();
  await panel().getByRole("status").filter({ hasText: "원본 저장됨 10개" }).waitFor();
  const firstBatch = await snapshot();
  assert.equal(firstBatch.sources.length, 10);
  assert.equal(firstBatch.sourceIntakes.length, 10);
  record("pause waits for current original and stops before the second batch");
  await page.goto("about:blank");
  await stop();
  await start();
  const count = writes.length;
  await reopen();
  assert.equal(writes.length, count);
  await panel().getByRole("button", { name: "남은 파일 다시 선택", exact: true }).waitFor();
  assert.deepEqual(await snapshot(), firstBatch);
  record(
    "server restart and page reload use GET only and preserve ten originals plus one remaining identity",
  );
  const mismatch = { ...files[10], buffer: pdf("Synthetic original 10 B") };
  assert.equal(mismatch.buffer.length, files[10].buffer.length);
  await panel()
    .getByLabel("남은 회사 자료 파일 다시 선택", { exact: true })
    .setInputFiles(mismatch);
  await panel().getByRole("alert").filter({ hasText: "이름·크기·내용" }).waitFor();
  await idle();
  assert.equal(writes.length, count);
  assert.deepEqual(await snapshot(), firstBatch);
  record("wrong equal-size PDF is rejected before a second batch declaration or PUT");
  loseBefore = true;
  await panel()
    .getByLabel("남은 회사 자료 파일 다시 선택", { exact: true })
    .setInputFiles(files[10]);
  await panel().getByRole("alert").waitFor();
  await idle();
  const pending = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), outboxKey());
  const originalNonce = pending.request.input.clientRequestId,
    countBeforeReload = writes.length;
  await reopen();
  assert.equal(writes.length, countBeforeReload);
  assert.equal((await snapshot()).sources.length, 10);
  assert.equal(
    (await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), outboxKey())).request.input
      .clientRequestId,
    originalNonce,
  );
  record("unobserved PUT survives reload with its exact command and no invented File");
  loseAfter = true;
  await panel()
    .getByLabel("남은 회사 자료 파일 다시 선택", { exact: true })
    .setInputFiles(files[10]);
  await panel().getByRole("alert").waitFor();
  await idle();
  assert.equal(writes.at(-1).nonce, originalNonce);
  assert.ok(await page.evaluate((key) => localStorage.getItem(key), outboxKey()));
  await page.goto("about:blank");
  await stop();
  await start();
  blockReads = false;
  const savedCount = writes.length;
  await reopen();
  await panel().getByRole("button", { name: "본문 확인·판독", exact: true }).waitFor();
  assert.equal(writes.length, savedCount);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), outboxKey()), null);
  const final = await snapshot();
  assert.equal(final.sources.length, 11);
  assert.deepEqual(final.sourceIntakes.slice(0, 10), firstBatch.sourceIntakes);
  assert.deepEqual(final.sources.slice(0, 10), firstBatch.sources);
  for (const [i, item] of final.sourceIntakes.entries()) {
    assert.deepEqual(
      await (await api(`/api/studio/cases/${caseId}/sources/${item.sourceId}`)).body(),
      files[i].buffer,
    );
    assert.equal(final.sources[i].text, "");
    assert.equal(final.sources[i].extraction, "pending");
  }
  record(
    "lost committed response recovers by GET only; all eleven PDF/DOCX originals remain exact and unreviewed",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await panel().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, "bulk-mobile.png"), fullPage: true });
  await panel().getByRole("button", { name: "선택 목록 닫기", exact: true }).click();
  await ready();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), queueKey()), null);
  assert.deepEqual(await snapshot(), final);
  await panel().getByRole("button", { name: "본문 확인·판독과 접수 상세", exact: true }).click();
  await page.getByRole("region", { name: "복수파일 접수·판독 재개", exact: true }).waitFor();
  assert.equal(writes.length, savedCount);
  record(
    "closing completed cards keeps originals; explicit review link opens existing intake tools without auto-adoption",
  );
  await selectNewCompany("합성 거절 표시 검증");
  refuseCreate = true;
  await panel().getByLabel("회사 자료 파일 선택", { exact: true }).setInputFiles(files[0]);
  await panel().getByText("접수 거절 · 전송 중단", { exact: true }).waitFor();
  await idle();
  assert.equal((await snapshot()).sourceIntakes.length, 0);
  const refusalCount = writes.length;
  await panel().getByRole("button", { name: "선택 목록 마치기", exact: true }).click();
  await ready();
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), queueKey()), null);
  assert.equal(writes.length, refusalCount);
  record("first directly refused declaration is shown and closes explicitly without a replay");
  await selectNewCompany("합성 부분 취소 검증");
  holdCreate = true;
  const declared = new Promise((resolve) => {
    holdEntered = resolve;
  });
  await panel().getByLabel("회사 자료 파일 선택", { exact: true }).setInputFiles(files.slice(0, 2));
  await Promise.race([
    declared,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(Error("Declaration hold was not reached")), 30000);
      timeout.unref();
    }),
  ]);
  await panel().getByRole("button", { name: "현재 파일 뒤 일시 중단", exact: true }).click();
  holdRelease();
  await idle();
  const reserved = await snapshot(),
    item = reserved.sourceIntakes[0];
  await api(`/api/studio/cases/${caseId}/source-intakes`, {
    method: "POST",
    data: {
      action: "cancel-awaiting-original",
      revision: reserved.revision,
      clientRequestId: crypto.randomUUID(),
      itemId: item.id,
      expectedItemVersion: item.version,
      confirmed: true,
    },
  });
  await panel().getByRole("button", { name: "저장 상태 확인", exact: true }).click();
  await idle();
  await panel().getByText("접수 취소됨", { exact: true }).waitFor();
  const cancelled = await snapshot(),
    beforeClose = writes.length;
  await panel().getByRole("button", { name: "선택 목록 마치기", exact: true }).click();
  await ready();
  assert.deepEqual(await snapshot(), cancelled);
  assert.equal(writes.length, beforeClose);
  assert.equal(cancelled.sourceIntakes.length, 2);
  assert.equal(cancelled.sourceIntakes[1].phase, "awaiting_original");
  record(
    "partial cancellation stops upload; closing metadata preserves cancellation history and the remaining reservation",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(aiRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record("390px has no overflow; no external or paid AI request and no customer data");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        buildId,
        checks,
        writes,
        externalRequests,
        aiRequests,
        errors,
        sourceCount: final.sources.length,
      },
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
  holdRelease?.();
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
