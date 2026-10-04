import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  "Usage: node scripts/guided-material-readiness-validation.mjs <build:local staging>",
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
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-material-readiness-"));
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

const name = "합성 자료 준비 현황";
let caseId;
const overview = () => page.getByRole("region", { name: "자료와 AI 입력 현황", exact: true });
const scope = () => overview().getByRole("list", { name: "현재 첫 분석 자료 범위" });
const writes = [],
  aiRequests = [];
async function snapshot() {
  return (await api("/api/studio/cases/" + caseId)).json();
}
async function reopen(label = name) {
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button").filter({ hasText: label }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "자료 올리기" })
    .click();
  await overview().waitFor();
}
async function showScope() {
  const summary = overview().getByText("AI 입력 범위와 용량 확인", { exact: true });
  if (!(await summary.locator("..").getAttribute("open"))) {
    // Empty-string open attributes need an explicit boolean check.
    if (!(await summary.locator("..").evaluate((element) => element.open))) await summary.click();
  }
}
async function intake(action) {
  const c = await snapshot(),
    item = c.sourceIntakes[0];
  return (
    await api("/api/studio/cases/" + caseId + "/source-intakes", {
      method: "POST",
      data: {
        revision: c.revision,
        clientRequestId: randomUUID(),
        itemId: item.id,
        expectedItemVersion: item.version,
        ...action,
      },
    })
  ).json();
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
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      externalRequests.push(request.url());
      return route.abort();
    }
    if (request.method() !== "GET") {
      writes.push({ url: url.pathname, method: request.method() });
      if (/guided-preparation|generate|analyze|provider-executions/.test(url.pathname)) {
        aiRequests.push(url.pathname);
        return route.abort();
      }
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/studio", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "회사 등록하고 시작", exact: true }).click();
  await page.locator("#new-company-name").fill(name);
  caseId = (
    await mutation(() =>
      page.getByRole("button", { name: "기업 작업공간 만들기", exact: true }).click(),
    )
  ).id;
  await overview().waitFor();
  assert.match(await overview().innerText(), /저장된 자료\s*0개/);
  assert.match(await overview().innerText(), /회사 설명을 적거나/);
  const empty = await snapshot();
  await api("/api/studio/cases/" + caseId, {
    method: "PATCH",
    data: {
      action: "profile",
      revision: empty.revision,
      profile: {
        ...empty.profile,
        technologySummary: "가상 센서 기술을 설명하는 합성 메모입니다. 실적은 미확인입니다.",
      },
    },
  });
  await reopen();
  assert.match(await overview().innerText(), /첨부 본문이 없어도 저장된 회사 설명/);
  await showScope();
  assert.equal(await scope().getByRole("listitem").count(), 0);
  record(
    "zero attachments show description-only start without factual acceptance or AI transmission",
  );

  const upload = page.getByRole("region", { name: "자료 업로드와 이어 올리기", exact: true });
  await upload.locator('input[type="file"]').setInputFiles([
    {
      name: "readiness.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await docx(1),
    },
    { name: "unread.pdf", mimeType: "application/pdf", buffer: pdf("Synthetic unread material") },
  ]);
  await upload.getByRole("button", { name: "선택 목록 마치기", exact: true }).waitFor();
  await upload.getByRole("button", { name: "선택 목록 마치기", exact: true }).click();
  await showScope();
  assert.match(await overview().innerText(), /본문 준비 필요\s*2개/);
  assert.equal(await scope().getByText("내용 제외 · 판독 대기", { exact: true }).count(), 2);
  const original = await snapshot();
  assert.ok(
    original.sources.every((source) => source.extraction === "pending" && source.text === ""),
  );
  record("stored PDF and Word originals stay out of AI body input");

  await intake({ action: "run-next", engine: "local-document" });
  await reopen();
  assert.match(await overview().innerText(), /판독 결과 확인 대기 1개/);
  const library = page.getByRole("region", { name: "저장된 자료 목록" });
  assert.ok(
    await library.getByText("판독 결과 보관 · 본문 채택 필요", { exact: true }).isVisible(),
  );
  await showScope();
  assert.equal(await scope().getByText("내용 제외 · 판독 대기", { exact: true }).count(), 2);
  const unreviewed = await snapshot(),
    beforeRead = JSON.stringify(unreviewed),
    beforeWrites = writes.length;
  await library.getByRole("button", { name: "자료 열기 · readiness.docx", exact: true }).click();
  await page.getByRole("region", { name: "복수파일 접수·판독 재개", exact: true }).waitFor();
  assert.equal(JSON.stringify(await snapshot()), beforeRead);
  assert.equal(writes.length, beforeWrites);
  record("local Word reading is unadopted; card opens existing review with zero new write");

  const item = unreviewed.sourceIntakes[0];
  assert.equal(item.result.content.kind, "plain");
  await intake({
    action: "adopt",
    resultId: item.result.id,
    sourceUpdatedAt: item.result.sourceUpdatedAt,
    originalSha256: item.result.originalSha256,
    text: item.result.content.text,
    reviewed: true,
  });
  await reopen();
  await showScope();
  assert.match(await overview().innerText(), /본문 있음\s*1개/);
  assert.equal(await scope().getByText("본문 포함", { exact: true }).count(), 1);
  assert.equal(await scope().getByText("내용 제외 · 판독 대기", { exact: true }).count(), 1);
  assert.doesNotMatch(await overview().innerText(), /판독 결과 확인 대기/);
  const adopted = await snapshot();
  const approval = (await api("/api/studio/cases/" + caseId + "/guided-preparation")).json();
  assert.deepEqual((await approval).approval.sourceIds, [adopted.sources[0].id]);
  assert.equal(adopted.sourceIntakes[0].result.reviewStatus, "unreviewed");
  assert.deepEqual(adopted.sources[1], original.sources[1]);
  record(
    "explicit synthetic adoption changes only the eligible body; original historical review state and other source remain",
  );

  // Separate synthetic company; 100 long bodies through the existing bounded API, never direct SQL.
  const manyProfile = {
    ...empty.profile,
    companyName: "합성 100개 장문 현황",
    technologySummary: "가상 대량 자료",
  };
  const many = await (
    await api("/api/studio/cases", { method: "POST", data: { profile: manyProfile } })
  ).json();
  const oldCase = caseId;
  caseId = many.id;
  let c = many;
  const at = new Date().toISOString();
  for (let i = 0; i < 100; i++) {
    c = await (
      await api("/api/studio/cases/" + caseId, {
        method: "PATCH",
        data: {
          action: "source",
          revision: c.revision,
          source: {
            id: randomUUID(),
            name: "장문 자료 " + (i + 1),
            kind: "technology",
            text: '"'.repeat(1250),
            originalName: null,
            mimeType: null,
            extraction: "manual",
            warnings: [],
            createdAt: at,
            updatedAt: at,
          },
        },
      })
    ).json();
  }
  const unchanged = JSON.stringify(c),
    beforeOverviewWrites = writes.length;
  await reopen(manyProfile.companyName);
  await showScope();
  assert.match(await overview().innerText(), /저장·접수 예약 100 \/ 100개/);
  assert.equal(await scope().getByRole("listitem").count(), 100);
  assert.ok(await overview().getByRole("alert").isVisible());
  assert.match(await overview().innerText(), /한도 초과/);
  await overview().getByText("같은 본문이 있는 자료 1묶음 확인", { exact: true }).click();
  assert.match(await overview().innerText(), /자동으로 제외하거나 중복 파일로 확정하지 않습니다/);
  await page.getByRole("searchbox", { name: "파일명·본문 검색" }).fill("자료 100");
  assert.equal(await scope().getByRole("listitem").count(), 100);
  assert.equal(JSON.stringify(await snapshot()), unchanged);
  assert.equal(writes.length, beforeOverviewWrites);
  record(
    "100 complete bodies show real serialized overage; search and duplicate disclosure never alter input or storage",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await overview().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: path.join(output, "material-readiness-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(aiRequests, []);
  assert.ok(!logs.join("").includes("ACCEPTANCE_EXTERNAL_FETCH_BLOCKED"));
  record("390px display has no overflow; existing API only, no AI/provider/external request");
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
        cases: [oldCase, caseId],
        sources: c.sources.length,
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
      ).slice(0, 4500),
    );
  }
  throw error;
} finally {
  await context?.close();
  await stop();
  await writeFile(path.join(output, "server.log"), logs.join(""));
}
