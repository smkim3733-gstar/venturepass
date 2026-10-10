import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { localBuildEnvironment } from "./build-local.mjs";

// Actual app UI; all business APIs are fulfilled with synthetic, in-memory state.
// No server business route, SQL, SDK, key, customer record or external service is used.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await realpath(path.resolve(app, "../../.venturepass-tools/build-temp"));
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
const scenario = process.argv[4] ?? "section";
assert.ok(["section", "overview", "reentry", "resume"].includes(scenario));

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/manual-plan-save.ts",
  "src/components/studio/manual-plan-recovery.ts",
  "src/components/studio/use-manual-plan-save.ts",
  "src/components/studio/plan-editor.tsx",
  "scripts/fixtures/public-preview-cancel.ts",
  "scripts/guided-manual-save-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(
  path.join(
    temporaryRoot,
    scenario === "resume"
      ? "venturepass-manual-resume-ui-"
      : scenario === "reentry"
        ? "venturepass-manual-reentry-ui-"
        : scenario === "overview"
          ? "venturepass-plan-overview-ui-"
          : "venturepass-manual-save-ui-",
  ),
);
const guard = path.join(output, "network-guard.mjs");
await writeFile(
  guard,
  String.raw`
import { registerHooks } from "node:module";
registerHooks({resolve(specifier,context,next){if(specifier==="node:sqlite"||specifier==="openai")throw Error("Forbidden runtime import");return next(specifier,context);}});
globalThis.fetch=async(input)=>{
 const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);
 if(url.href==="https://registry.npmjs.org/-/package/next/dist-tags")return new Response(null,{status:503});
 process.stderr.write("FORBIDDEN_SERVER_FETCH\n");throw Error("Server fetch forbidden");
};
`,
);
const environment = localBuildEnvironment(output);
for (const key of Object.keys(environment))
  if (/OPENAI|KOSIS|API_KEY|TOKEN|SECRET/i.test(key)) delete environment[key];
environment.NODE_ENV = serverMode === "dev" ? "development" : "production";
environment.VENTURE_DATA_DIR = path.join(output, "unused-data");
delete environment.NODE_OPTIONS;
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
let origin;
const requireVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "scripts/fixtures/public-preview-cancel.ts"),
  cwd: app,
  platform: "browser",
  external: ["node:crypto"],
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      resolveId(source) {
        if (
          source !== "node:crypto" &&
          /openai|server-only|node:|storage|engine|provider-production|configuration-current/.test(
            source,
          )
        )
          throw Error("Forbidden fixture import");
        return null;
      },
    },
  ],
});
let fixture;
try {
  const generated = await bundle.generate({ format: "esm" });
  assert.equal(generated.output.length, 1);
  const chunk = generated.output[0];
  assert.equal(chunk.type, "chunk");
  assert.deepEqual(chunk.imports, ["node:crypto"]);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
let { company } = fixture.previewCompanyFixture(2);
company.profile.companyName = "합성 원고 수정 저장 검증";
const original = structuredClone(company);
const name = company.profile.companyName,
  caseId = company.id;
const basePlan = company.plans.at(-1);
const text = "직접 고친 합성 본문입니다. 숫자는 27이며 실제 고객 자료가 아닙니다.";
const overviewTitle = "직접 정리한 합성 사업계획서 제목";
const overviewSummary =
  "사용자가 수정한 합성 핵심 요약입니다.\n항목의 근거와 확인 필요 표시는 그대로 유지합니다.";
let resumeReceiptText, otherTab;
let saved,
  readMode = "initial",
  caseReads = 0,
  intakeReads = 0;
const network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [];
// Browser attachment downloads may bypass Playwright interception. The HTTP boundary
// must enforce isolation independently: only static UI requests reach Next.
const proxy = createHttpServer(async (req, res) => {
  const u = new URL(req.url, origin);
  try {
    if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method)) {
      unexpected.push("proxy blocked " + u.pathname);
      res.writeHead(403);
      res.end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:" + port },
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  } catch {
    errors.push("synthetic proxy failure");
    res.writeHead(500);
    res.end();
  }
});
const developmentSockets = new Set();
proxy.on("upgrade", (req, socket, head) => {
  if (serverMode !== "dev" || new URL(req.url, origin).pathname !== "/_next/hmr") {
    unexpected.push("blocked websocket");
    socket.destroy();
    return;
  }
  const upstream = connect({ host: "127.0.0.1", port }, () => {
    const headers = { ...req.headers, host: "127.0.0.1:" + port };
    upstream.write(
      req.method +
        " " +
        req.url +
        " HTTP/1.1\r\n" +
        Object.entries(headers)
          .map(([k, v]) => k + ": " + v)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  developmentSockets.add(socket);
  developmentSockets.add(upstream);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.on("close", () => {
    developmentSockets.delete(socket);
    upstream.destroy();
  });
  upstream.on("close", () => {
    developmentSockets.delete(upstream);
    socket.destroy();
  });
});
const record = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
let child, context, page;
async function start() {
  child = spawn(
    process.execPath,
    [
      "--max-old-space-size=3072",
      "--import",
      pathToFileURL(guard).href,
      path.join(staging, "node_modules/next/dist/bin/next"),
      serverMode,
      ...(serverMode === "dev" ? ["--webpack"] : []),
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: staging, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  child.stdout.on("data", (b) => logs.push(b.toString()));
  child.stderr.on("data", (b) => logs.push(b.toString()));
  let startupError;
  child.once("error", (e) => {
    startupError = e;
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw Error("Child stopped");
    if (logs.join("").includes("Ready in")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Ready timeout");
}
try {
  await start();
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  origin = "http://127.0.0.1:" + proxy.address().port;
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
  });
  context.setDefaultTimeout(30000);
  await context.route("**/*", async (route) => {
    try {
      const req = route.request(),
        u = new URL(req.url());
      if (u.origin !== origin) {
        unexpected.push("external");
        return route.abort();
      }
      const reply = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      const root = "/api/studio/cases/" + caseId;
      if (req.method() === "GET") {
        if (u.pathname === "/api/studio/status")
          return reply({
            aiConfigured: true,
            model: fixture.model,
            storage: "local",
            supportedFiles: [],
          });
        if (u.pathname === "/api/studio/cases")
          return reply({
            cases: [
              {
                id: caseId,
                companyName: name,
                industry: "",
                stage: company.stage,
                revision: company.revision,
                createdAt: company.createdAt,
                updatedAt: company.updatedAt,
                sourceCount: company.sources.length,
                planCount: company.plans.length,
                pendingTaskCount: 0,
              },
            ],
          });
        if (u.pathname === root) {
          caseReads++;
          if (scenario === "resume" && readMode === "stale") return reply(original);
          if (scenario === "resume" && readMode === "race") {
            await otherTab.evaluate(({ key, value }) => localStorage.setItem(key, value), {
              key: "venturepass:manual-plan:v1:" + caseId,
              value: resumeReceiptText,
            });
            readMode = "initial";
            return reply(company);
          }
          if (readMode === "foreign")
            return reply({ ...saved, id: "99999999-9999-4999-8999-999999999999" });
          if (readMode === "wrong") {
            const wrong = structuredClone(saved);
            if (scenario !== "section") wrong.plans.at(-1).content.title = "다른 제목";
            else wrong.plans.at(-1).content.sections[0].content = "다른 수정 본문";
            return reply(wrong);
          }
          if (readMode === "exact") {
            company = structuredClone(saved);
            return reply(company);
          }
          return reply(company);
        }
        if (scenario !== "section" && u.pathname === root + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        if (u.pathname === root + "/preparation-automation") {
          return reply({ company, active: false });
        }
        if (u.pathname === root + "/guided-preparation")
          return reply({ company, active: false, aiConfigured: false, approval: null });
      }
      if (req.method() === "PATCH" && u.pathname === root) {
        const command = req.postDataJSON();
        commands.push(structuredClone(command));
        if (scenario === "resume") {
          const count = commands.length;
          assert.ok(count <= 4, "Four different explicit edits only");
          const previous = company.plans.at(-1);
          assert.equal(command.action, "save-plan");
          assert.equal(command.planId, previous.id);
          assert.equal(command.revision, company.revision);
          const expected =
            count === 1 || count === 4
              ? {
                  ...previous.content,
                  title: overviewTitle + (count === 4 ? " 이어쓰기" : ""),
                  summary: overviewSummary + (count === 4 ? " 이어쓰기" : ""),
                }
              : {
                  ...previous.content,
                  sections: previous.content.sections.map((section, index) =>
                    index === 0
                      ? {
                          ...section,
                          content: text + (count === 3 ? " 다른 창 추가" : ""),
                          needsConfirmation: true,
                        }
                      : section,
                  ),
                };
          assert.deepEqual(command.content, expected);
          saved = structuredClone(company);
          saved.revision++;
          saved.plans.push({
            ...structuredClone(previous),
            id: crypto.randomUUID(),
            version: previous.version + 1,
            generatedAt: new Date().toISOString(),
            mode: "manual",
            confirmedAt: null,
            content: command.content,
          });
          if (count === 1 || count === 3)
            return reply({ ...company, revision: company.revision + 1 });
          company = structuredClone(saved);
          return reply(company);
        }
        assert.ok(
          commands.length <= (scenario !== "section" ? 1 : 2),
          "Only explicit manual saves",
        );
        assert.equal(command.action, "save-plan");
        const previous = company.plans.at(-1);
        assert.equal(command.planId, previous.id);
        assert.equal(command.revision, company.revision);
        assert.deepEqual(
          command.content,
          scenario !== "section"
            ? { ...previous.content, title: overviewTitle, summary: overviewSummary }
            : {
                ...previous.content,
                sections: previous.content.sections.map((section, index) =>
                  index === 0
                    ? {
                        ...section,
                        content: text + (commands.length === 2 ? " 추가 수정" : ""),
                        needsConfirmation: commands.length !== 2,
                      }
                    : section,
                ),
              },
        );
        saved = structuredClone(company);
        saved.revision++;
        saved.plans.push({
          ...structuredClone(previous),
          id: crypto.randomUUID(),
          version: previous.version + 1,
          generatedAt: new Date().toISOString(),
          mode: "manual",
          confirmedAt: null,
          content: command.content,
        });
        if (commands.length === 1) {
          if (scenario !== "section") {
            const wrong = structuredClone(saved);
            wrong.plans.at(-1).content.summary = "다른 핵심 요약";
            return reply(wrong);
          }
          return reply({ ...company, revision: company.revision + 1 });
        }
        company = structuredClone(saved);
        return reply(company);
      }
      if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
        unexpected.push(u.pathname);
        return route.abort();
      }
      return await route.continue();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Synthetic route failure");
      await route.abort().catch(() => {});
    }
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") network.push({ console: e.text().slice(0, 500) });
  });
  page.on("response", (r) => {
    if (r.status() >= 400) network.push({ status: r.status(), path: new URL(r.url()).pathname });
  });
  page.on("requestfailed", (r) =>
    network.push({ failed: r.failure()?.errorText, path: new URL(r.url()).pathname }),
  );
  page.on("request", (r) => network.push({ request: new URL(r.url()).pathname }));

  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page.getByRole("button", { name: "내용 고치기", exact: true }).waitFor();
  if (scenario === "resume") {
    const key = "venturepass:manual-plan:v1:" + caseId;
    const btn = (tab, name) => tab.getByRole("button", { name, exact: true });
    const input = page.locator("#guided-section");
    const verified = () =>
      page.getByRole("checkbox", {
        name: "이 항목의 사실·수치·근거를 직접 확인했습니다.",
        exact: true,
      });
    const resume = () => btn(page, "최신 원고에서 입력 이어쓰기");
    const inspect = () => btn(page, "수정본 저장 상태 확인");
    async function openOther() {
      otherTab = await context.newPage();
      otherTab.on("pageerror", (e) => errors.push(e.message));
      await otherTab.goto(origin + "/studio", { waitUntil: "networkidle" });
      await otherTab.getByRole("button").filter({ hasText: name }).first().click();
      await btn(otherTab, "내용 고치기").waitFor();
    }
    await btn(page, "내용 고치기").click();
    await input.fill(text);
    await verified().check();
    await openOther();
    await btn(otherTab, "제목·요약 고치기").click();
    await otherTab.getByLabel("사업계획서 제목", { exact: true }).fill(overviewTitle);
    await otherTab.getByLabel("핵심 요약", { exact: true }).fill(overviewSummary);
    await btn(otherTab, "수정 반영하기").click();
    await btn(otherTab, "수정본 저장 상태 확인").click({ trial: true });
    resumeReceiptText = await otherTab.evaluate((key) => localStorage.getItem(key), key);
    assert.ok(resumeReceiptText);
    await inspect().click({ trial: true });
    readMode = "exact";
    await inspect().click();
    await resume().waitFor();
    await resume().click({ trial: true });
    assert.equal(await input.inputValue(), text);
    assert.equal(await btn(page, "수정 반영하기").isDisabled(), true);
    assert.equal(commands.length, 1);
    record(
      "another tab's saved title/summary is confirmed while this tab's section input stays retained and unsaved",
    );

    readMode = "stale";
    const beforeStale = caseReads;
    await resume().click();
    await page.getByText("최신 원고를 확인하지 못했습니다.", { exact: false }).waitFor();
    await resume().click({ trial: true });
    assert.equal(caseReads, beforeStale + 1);
    assert.equal(await input.inputValue(), text);
    assert.equal(await btn(page, "수정 반영하기").isDisabled(), true);
    await page.evaluate((key) => {
      const get = Storage.prototype.getItem;
      window.restoreResumeRead = () => {
        Storage.prototype.getItem = get;
      };
      Storage.prototype.getItem = function (k) {
        if (k === key) throw Error("synthetic read failure");
        return get.call(this, k);
      };
    }, key);
    const beforeReadFailure = caseReads;
    await resume().click();
    await btn(page, "수정본 복구 기록 다시 확인").waitFor();
    assert.equal(caseReads, beforeReadFailure);
    assert.equal(commands.length, 1);
    await page.evaluate(() => window.restoreResumeRead());
    await btn(page, "수정본 복구 기록 다시 확인").click();
    await resume().click({ trial: true });
    record(
      "stale GET and browser read failure preserve the original edit base and never send a save",
    );

    readMode = "race";
    await resume().click();
    await inspect().waitFor();
    await inspect().click({ trial: true });
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), resumeReceiptText);
    assert.equal(await input.inputValue(), text);
    assert.equal(await btn(page, "수정 반영하기").isDisabled(), true);
    readMode = "exact";
    await inspect().click();
    await resume().click({ trial: true });
    assert.equal(commands.length, 1);
    record(
      "a synthetic identity arriving during GET blocks rebasing and remains intact until its separate exact confirmation",
    );

    readMode = "initial";
    await resume().click();
    await btn(page, "수정 반영하기").click({ trial: true });
    assert.equal(await resume().count(), 0);
    assert.equal(await input.inputValue(), text);
    assert.equal(await verified().isChecked(), false);
    assert.equal(commands.length, 1);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
    await page.setViewportSize({ width: 390, height: 844 });
    await input.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "manual-resume-mobile.png"), fullPage: true });
    await btn(page, "수정 반영하기").click();
    await btn(page, "내용 고치기").waitFor();
    assert.equal(commands.length, 2);
    assert.equal(company.plans.at(-1).content.title, overviewTitle);
    assert.equal(company.plans.at(-1).content.summary, overviewSummary);
    assert.equal(company.plans.at(-1).content.sections[0].content, text);
    assert.equal(company.plans.at(-1).content.sections[0].needsConfirmation, true);
    assert.equal(company.plans.at(-1).confirmedAt, null);
    record(
      "explicit section continuation clears fact confirmation, preserves the latest overview and saves only after the user's separate click",
    );

    await otherTab.close();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await btn(page, "제목·요약 고치기").click();
    await page.getByLabel("사업계획서 제목", { exact: true }).fill(overviewTitle + " 이어쓰기");
    await page.getByLabel("핵심 요약", { exact: true }).fill(overviewSummary + " 이어쓰기");
    await openOther();
    await btn(otherTab, "내용 고치기").click();
    await otherTab.locator("#guided-section").fill(text + " 다른 창 추가");
    await btn(otherTab, "수정 반영하기").click();
    await btn(otherTab, "수정본 저장 상태 확인").click({ trial: true });
    readMode = "exact";
    await inspect().click();
    await resume().click({ trial: true });
    const beforeOverviewResume = caseReads;
    readMode = "initial";
    await resume().click();
    await btn(page, "수정 반영하기").click({ trial: true });
    assert.equal(caseReads, beforeOverviewResume + 1);
    assert.equal(commands.length, 3);
    assert.equal(
      await page.getByLabel("사업계획서 제목", { exact: true }).inputValue(),
      overviewTitle + " 이어쓰기",
    );
    assert.equal(
      await page.getByLabel("핵심 요약", { exact: true }).inputValue(),
      overviewSummary + " 이어쓰기",
    );
    const before = structuredClone(company.plans);
    await btn(page, "수정 반영하기").click();
    await btn(page, "내용 고치기").waitFor();
    assert.equal(commands.length, 4);
    assert.deepEqual(company.plans.slice(0, -1), before);
    assert.deepEqual(company.plans.at(-1).content.sections, before.at(-1).content.sections);
    assert.equal(company.plans.at(-1).confirmedAt, null);
    assert.equal(
      await page
        .getByRole("link", {
          name: "원고 v" + company.plans.at(-1).version + " Word 내려받기",
          exact: true,
        })
        .getAttribute("href"),
      "/api/studio/cases/" + caseId + "/export?planId=" + company.plans.at(-1).id + "&format=docx",
    );
    await otherTab.close();
    assert.deepEqual(company.plans.slice(0, original.plans.length), original.plans);
    record(
      "overview continuation preserves both retained fields and the other tab's latest sections, previous versions and exact Word target",
    );
  } else if (scenario === "reentry") {
    const key = `venturepass:manual-plan:v1:${caseId}`;
    await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).click();
    await page.getByRole("textbox", { name: "사업계획서 제목", exact: true }).fill(overviewTitle);
    await page.getByRole("textbox", { name: "핵심 요약", exact: true }).fill(overviewSummary);
    await page.evaluate((key) => {
      const originalSet = Storage.prototype.setItem;
      window.restoreManualStorage = () => {
        Storage.prototype.setItem = originalSet;
      };
      Storage.prototype.setItem = function (k, value) {
        if (k === key) throw Error("synthetic quota failure");
        return originalSet.call(this, k, value);
      };
    }, key);
    await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
    await page
      .getByText("브라우저에서 수정본 복구 기록을 읽거나 보관하지 못했습니다.", { exact: false })
      .waitFor();
    assert.equal(commands.length, 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
    assert.equal(
      await page.getByRole("textbox", { name: "핵심 요약", exact: true }).inputValue(),
      overviewSummary,
    );
    await page.evaluate(() => window.restoreManualStorage());
    record("browser write failure blocks transmission and preserves the unsent edit");

    await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
    const inspectButton = () =>
      page.getByRole("button", { name: "수정본 저장 상태 확인", exact: true });
    await inspectButton().waitFor();
    await inspectButton().click({ trial: true });
    const receiptText = await page.evaluate((key) => localStorage.getItem(key), key);
    assert.ok(receiptText);
    const receipt = JSON.parse(receiptText);
    assert.deepEqual(
      Object.keys(receipt).sort(),
      [
        "format",
        "caseId",
        "planId",
        "revision",
        "nextVersion",
        "previousDigest",
        "contentDigest",
      ].sort(),
    );
    for (const body of [
      overviewTitle,
      overviewSummary,
      basePlan.content.title,
      basePlan.content.summary,
    ])
      if (body) assert.equal(receiptText.includes(body), false);
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 1);
    record(
      "only minimal identity and digests persist before the one explicit PATCH; a mismatched summary stays pending",
    );

    page.once("dialog", (dialog) => dialog.accept());
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await inspectButton().waitFor();
    await inspectButton().click({ trial: true });
    assert.equal(await page.getByRole("textbox", { name: "핵심 요약", exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "상세 도구", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "자료 올리기", exact: false }).isDisabled(),
      true,
    );
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 2);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), receiptText);
    await page.close();
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/studio", { waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await inspectButton().waitFor();
    await inspectButton().click({ trial: true });
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 3);
    assert.equal(
      await page.getByRole("textbox", { name: "사업계획서 제목", exact: true }).count(),
      0,
    );
    record(
      "actual reload and closing/reopening a tab restore the same pending identity without text replication or automatic GET recovery",
    );

    await page.evaluate(
      ({ key, receipt }) =>
        localStorage.setItem(
          key,
          JSON.stringify({ ...receipt, caseId: "99999999-9999-4999-8999-999999999999" }),
        ),
      { key, receipt },
    );
    await inspectButton().click();
    const reread = page.getByRole("button", { name: "수정본 복구 기록 다시 확인", exact: true });
    await reread.waitFor();
    assert.equal(caseReads, 3, "foreign browser record is rejected before GET");
    assert.equal(commands.length, 1);
    await page.evaluate(({ key, receiptText }) => localStorage.setItem(key, receiptText), {
      key,
      receiptText,
    });
    await reread.click();
    await inspectButton().click({ trial: true });
    readMode = "wrong";
    await inspectButton().click();
    await inspectButton().click({ trial: true });
    assert.equal(caseReads, 4);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), receiptText);
    record(
      "a foreign browser record and another returned title cannot clear the original pending save",
    );

    const lockTab = await context.newPage();
    await lockTab.goto(origin + "/studio", { waitUntil: "networkidle" });
    await lockTab.evaluate(async (key) => {
      let entered;
      const ready = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        window.releaseManualLock = resolve;
      });
      window.manualLockTask = navigator.locks.request(key, async () => {
        entered();
        await gate;
      });
      await ready;
    }, key);
    await inspectButton().click();
    await page
      .getByText("다른 창에서 이 회사의 수정본을 저장하거나 확인 중입니다.", { exact: false })
      .waitFor();
    assert.equal(caseReads, 4);
    assert.equal(commands.length, 1);
    await lockTab.evaluate(async () => {
      window.releaseManualLock();
      await window.manualLockTask;
    });
    await lockTab.close();
    record(
      "another tab's real browser lock blocks concurrent recovery without sending or clearing the record",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await inspectButton().scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "manual-reentry-mobile.png"), fullPage: true });
    readMode = "exact";
    await inspectButton().click();
    await page.getByRole("button", { name: "제목·요약 고치기", exact: true }).waitFor();
    await page.getByRole("heading", { name: overviewTitle, exact: true }).waitFor();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 5);
    assert.deepEqual(company.plans.slice(0, -1), original.plans);
    assert.deepEqual(company.plans.at(-1).content, {
      ...basePlan.content,
      title: overviewTitle,
      summary: overviewSummary,
    });
    assert.equal(company.plans.at(-1).confirmedAt, null);
    assert.equal(
      await page
        .getByRole("link", { name: `원고 v${basePlan.version + 1} Word 내려받기`, exact: true })
        .getAttribute("href"),
      `/api/studio/cases/${caseId}/export?planId=${company.plans.at(-1).id}&format=docx`,
    );
    record(
      "only exact prior-manuscript and new-version matching clears the receipt and restores the current plan",
    );

    await page.getByRole("button", { name: "공개 근거 보완", exact: true }).click();
    const publicInput = page.getByLabel("공개 자료 제목", { exact: true });
    await publicInput.fill("다른 입력창의 미저장 합성 제목");
    const notificationTab = await context.newPage();
    await notificationTab.goto(origin + "/studio", { waitUntil: "networkidle" });
    // Deliver the retained synthetic identity as a browser event; this is not another save.
    await notificationTab.evaluate(
      ({ key, receiptText }) => localStorage.setItem(key, receiptText),
      { key, receiptText },
    );
    await inspectButton().waitFor();
    await inspectButton().click({ trial: true });
    assert.equal(await publicInput.count(), 1, "the child editor must remain mounted");
    assert.equal(await publicInput.isVisible(), false);
    assert.equal(await publicInput.inputValue(), "다른 입력창의 미저장 합성 제목");
    await inspectButton().click();
    await publicInput.waitFor({ state: "visible" });
    assert.equal(await publicInput.inputValue(), "다른 입력창의 미저장 합성 제목");
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 6);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null);
    await notificationTab.close();
    record(
      "a received synthetic identity hides an already open child editor without discarding its unsaved input; exact confirmation reveals it unchanged",
    );
  } else if (scenario === "overview") {
    const open = page.getByRole("button", { name: "제목·요약 고치기", exact: true });
    assert.equal(await open.count(), 1, "Guided title and summary editing must be reachable");
    await open.click();
    const titleInput = page.getByRole("textbox", { name: "사업계획서 제목", exact: true });
    const summaryInput = page.getByRole("textbox", { name: "핵심 요약", exact: true });
    assert.equal(await titleInput.inputValue(), basePlan.content.title);
    assert.equal(await summaryInput.inputValue(), basePlan.content.summary);
    assert.equal(await titleInput.getAttribute("maxlength"), "300");
    assert.equal(await summaryInput.getAttribute("maxlength"), "6000");
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "이 항목의 사실·수치·근거를 직접 확인했습니다.",
          exact: true,
        })
        .count(),
      0,
    );
    await titleInput.fill(overviewTitle);
    await summaryInput.fill(overviewSummary);
    const cancel = page.getByRole("button", { name: "수정 취소", exact: true });
    page.once("dialog", (dialog) => dialog.dismiss());
    await cancel.click();
    assert.equal(await titleInput.inputValue(), overviewTitle);
    assert.equal(await summaryInput.inputValue(), overviewSummary);
    record(
      "title and summary are editable with contract limits; dismissing cancellation preserves both inputs",
    );
    await page.getByRole("button", { name: "자료 올리기", exact: false }).click();
    await page.getByRole("button", { name: "AI 계획서", exact: false }).click();
    assert.equal(await titleInput.inputValue(), overviewTitle);
    assert.equal(await summaryInput.inputValue(), overviewSummary);
    assert.equal(commands.length, 0);
    page.once("dialog", (dialog) => dialog.accept());
    await cancel.click();
    await open.click();
    assert.equal(await titleInput.inputValue(), basePlan.content.title);
    assert.equal(await summaryInput.inputValue(), basePlan.content.summary);
    assert.equal(commands.length, 0);
    record(
      "step navigation preserves inputs; explicit cancellation discards the local edit without saving",
    );
    await titleInput.fill(overviewTitle);
    await summaryInput.fill(overviewSummary);
    await page.setViewportSize({ width: 390, height: 844 });
    await summaryInput.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, "plan-overview-edit-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
    const inspect = page.getByRole("button", { name: "수정본 저장 상태 확인", exact: true });
    await inspect.waitFor();
    assert.equal(await titleInput.inputValue(), overviewTitle);
    assert.equal(await summaryInput.inputValue(), overviewSummary);
    assert.equal(await titleInput.getAttribute("readonly"), "");
    assert.equal(await summaryInput.getAttribute("readonly"), "");
    for (const name of ["수정 취소", "수정 반영하기", "상세 도구"]) {
      assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
    }
    assert.equal(
      await page.getByRole("button", { name: "자료 올리기", exact: false }).isDisabled(),
      true,
    );
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 1);
    record(
      "a saved version with another summary keeps the original input pending and prevents leaving or resending",
    );
    readMode = "wrong";
    await inspect.click();
    await inspect.click({ trial: true });
    assert.equal(await titleInput.inputValue(), overviewTitle);
    assert.equal(await summaryInput.inputValue(), overviewSummary);
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 2);
    record("explicit recovery rejects another title without resending or losing either input");
    readMode = "exact";
    await inspect.click();
    await open.waitFor();
    assert.equal(await titleInput.count(), 0);
    await page.getByRole("heading", { name: overviewTitle, exact: true }).waitFor();
    await page.getByText(overviewSummary, { exact: true }).waitFor();
    assert.deepEqual(company.plans.slice(0, -1), original.plans);
    assert.deepEqual(company.plans.at(-1).content, {
      ...basePlan.content,
      title: overviewTitle,
      summary: overviewSummary,
    });
    assert.equal(company.plans.at(-1).confirmedAt, null);
    assert.equal(company.plans.at(-1).mode, "manual");
    assert.equal(company.plans.at(-1).version, basePlan.version + 1);
    assert.equal(
      await page
        .getByRole("link", { name: `원고 v${basePlan.version + 1} Word 내려받기`, exact: true })
        .getAttribute("href"),
      `/api/studio/cases/${caseId}/export?planId=${company.plans.at(-1).id}&format=docx`,
    );
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 3);
    await open.click();
    assert.equal(await titleInput.inputValue(), overviewTitle);
    assert.equal(await summaryInput.inputValue(), overviewSummary);
    await cancel.click();
    record(
      "exact version confirmation displays and reopens the edited overview, preserving prior plans, all sections and their confirmation flags",
    );
  } else {
    await page.getByRole("button", { name: "내용 고치기", exact: true }).click();
    const input = page.locator("#guided-section");
    await input.fill(text);
    await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
    // Wait for the request to finish, then prove the editor is still present.
    await page.getByRole("button", { name: "AI 계획서", exact: false }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(
      await input.count(),
      1,
      "A response without the edited new plan must not close the editor",
    );
    assert.equal(await input.inputValue(), text);
    const inspect = page.getByRole("button", { name: "수정본 저장 상태 확인", exact: true });
    await inspect.waitFor();
    assert.equal(
      await page.getByRole("button", { name: "수정 취소", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "수정 반영하기", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "상세 도구", exact: true }).isDisabled(),
      true,
    );
    assert.equal(await input.getAttribute("readonly"), "");
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 1, "No automatic GET or PATCH");
    record(
      "missing revised manuscript response preserves input and blocks leaving or resending without success notice",
    );
    for (const mode of ["foreign", "wrong"]) {
      readMode = mode;
      const before = caseReads;
      await inspect.click();
      await inspect.click({ trial: true });
      assert.equal(caseReads, before + 1);
      assert.equal(await input.inputValue(), text);
      assert.equal(
        await page.getByRole("button", { name: "수정 반영하기", exact: true }).isDisabled(),
        true,
      );
      assert.equal(commands.length, 1);
    }
    record(
      "explicit GET rejects another company and a new version with different text, keeping the original edit",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await inspect.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, "manual-save-recovery-mobile.png"),
      fullPage: true,
    });
    readMode = "exact";
    await inspect.click();
    await page.getByRole("button", { name: "내용 고치기", exact: true }).waitFor();
    assert.equal(await input.count(), 0);
    assert.equal(commands.length, 1);
    assert.equal(caseReads, 4);
    assert.deepEqual(company.plans.slice(0, -1), original.plans);
    assert.equal(company.plans.at(-1).content.sections[0].content, text);
    assert.equal(company.plans.at(-1).content.sections[0].needsConfirmation, true);
    assert.equal(company.plans.at(-1).confirmedAt, null);
    assert.equal(
      await page
        .getByRole("link", { name: `원고 v${basePlan.version + 1} Word 내려받기`, exact: true })
        .getAttribute("href"),
      `/api/studio/cases/${caseId}/export?planId=${company.plans.at(-1).id}&format=docx`,
    );
    record(
      "exact matching new manual version releases recovery; old plans, unconfirmed status and exact download target remain",
    );
    await page.getByRole("button", { name: "내용 고치기", exact: true }).click();
    await input.fill(text + " 추가 수정");
    await page
      .getByRole("checkbox", { name: "이 항목의 사실·수치·근거를 직접 확인했습니다.", exact: true })
      .check();
    await page.getByRole("button", { name: "수정 반영하기", exact: true }).click();
    await page.getByRole("button", { name: "내용 고치기", exact: true }).waitFor();
    assert.equal(commands.length, 2);
    assert.equal(caseReads, 4);
    assert.deepEqual(company.plans.slice(0, -2), original.plans);
    assert.equal(company.plans.at(-1).content.sections[0].needsConfirmation, false);
    assert.equal(company.plans.at(-1).confirmedAt, null);
    record(
      "a separate explicitly saved edit accepts its exact PATCH response; per-section confirmation never confirms the whole plan",
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(!logs.join("").includes("FORBIDDEN_SERVER_FETCH"));
  assert.equal((await readdir(output)).includes("unused-data"), false);
  assert.ok(!logs.join("").includes("GET /api/"));

  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        checks,
        syntheticPatches: commands.length,
        syntheticCompanyGets: caseReads,
        syntheticIntakeGets: intakeReads,
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          scenario === "resume"
            ? "two actual tabs, retained section/overview edits, explicit latest GET and separate manual saves; in-memory synthetic responses only"
            : scenario === "reentry"
              ? "actual reload and tab re-entry, storage failure, mismatches and exact GET; identity-only journal, in-memory synthetic server"
              : scenario !== "section"
                ? "guided title/summary edit, cancel/navigation, mismatched response and explicit exact GET; synthetic in-memory storage only"
                : "actual guided app with synthetic plan; wrong PATCH response, explicit GET recovery and separate explicit save; no actual storage or request receipt attribution",
        errors,
        unexpected,
        actualBusinessApi: 0,
        external: 0,
        sql: 0,
        sdk: 0,
        mode: serverMode,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, checks: checks.length, syntheticApiCommands: commands.length }),
  );
} catch (error) {
  console.log(JSON.stringify({ output, checks, unexpected, errors, network }));
  if (page)
    await page
      .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  for (const socket of developmentSockets) socket.destroy();
  proxy.closeAllConnections();
  if (proxy.listening) await new Promise((resolve) => proxy.close(resolve));
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Owned child failed to stop")), 10000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  await writeFile(path.join(output, "server.log"), logs.join(""));
  await writeFile(
    path.join(output, "cleanup.json"),
    JSON.stringify(
      {
        childStopped: !child || child.exitCode !== null || child.signalCode !== null,
        unusedDataPresent: (await readdir(output)).includes("unused-data"),
        businessRouteObserved: /(?:GET|POST|PATCH|PUT|DELETE) \/api\//.test(logs.join("")),
        forbiddenServerFetch: logs.join("").includes("FORBIDDEN_SERVER_FETCH"),
      },
      null,
      2,
    ),
  );
}
