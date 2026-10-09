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
assert.ok(["start", "dev"].includes(serverMode));
const scenario = process.argv[4] ?? "link";
assert.ok(["link", "summary"].includes(scenario));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-plan-review.tsx",
  "src/components/studio/plan-review-decisions.tsx",
  "scripts/fixtures/guided-review-link.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(
  path.join(
    temporaryRoot,
    scenario === "summary" ? "venturepass-review-summary-ui-" : "venturepass-review-link-ui-",
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
  input: path.join(app, "scripts/fixtures/guided-review-link.ts"),
  cwd: app,
  platform: "browser",
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      resolveId(source) {
        if (
          /openai|server-only|node:|storage|provider-production|configuration-current/.test(source)
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
  assert.deepEqual(chunk.imports, []);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
let company = fixture.reviewLinkCompany();
let replyMode = "exact",
  holdResponse = false,
  releaseResponse;
const name = company.profile.companyName,
  caseId = company.id;
const downloads = [];
const network = [];
const commands = [],
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
async function reopen() {
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
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
          aiConfigured: false,
          model: "synthetic-disabled",
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
              stage: "preparing",
              revision: company.revision,
              createdAt: company.createdAt,
              updatedAt: company.updatedAt,
              sourceCount: company.sources.length,
              planCount: company.plans.length,
              pendingTaskCount: 0,
            },
          ],
        });
      if (u.pathname === root) return reply(company);
      if (u.pathname === root + "/source-intakes") return reply({ company, activeItemIds: [] });
      if (u.pathname === root + "/guided-preparation")
        return reply({
          company,
          active: false,
          aiConfigured: false,
          approval: {
            caseId,
            revision: company.revision,
            provider: "OpenAI",
            model: "synthetic-disabled",
            inputFingerprint: "a".repeat(64),
            sourceIds: company.sources.map((s) => s.id),
            sourceNames: company.sources.map((s) => s.name),
            profileIncluded: true,
            businessNumberIncluded: false,
            originalFilesIncluded: false,
            derivedDraftIncluded: true,
            purpose: "analysis-plan-review",
          },
        });
      if (u.pathname === root + "/plan-supplements/execution")
        return reply({
          company,
          active: false,
          retainedCapture: false,
          executions: [],
          transmissionAllowed: false,
        });
    }
    if (req.method() === "PATCH" && u.pathname === root) {
      const command = req.postDataJSON();
      commands.push(command);
      assert.equal(command.revision, company.revision);
      assert.equal(command.action, "append-plan-review");
      const plan = company.plans.at(-1);
      assert.equal(command.decision.planId, plan.id);
      assert.equal(command.decision.planVersion, plan.version);
      assert.deepEqual(command.decision.finding, plan.review[command.decision.findingIndex]);
      if (holdResponse)
        await new Promise((resolve) => {
          releaseResponse = resolve;
        });
      company = { ...company, revision: company.revision + 1 };
      if (replyMode === "exact") {
        const id = "f0000000-0000-4000-8000-" + String(commands.length).padStart(12, "0");
        company.planReviewDecisions.push({
          ...command.decision,
          id,
          rootId: id,
          version: 1,
          clientRequestId: command.clientRequestId,
          inputDigest: "a".repeat(64),
          recordedAt: "2026-10-09T00:10:00.000Z",
          origin: "manual",
          reviewKey: "b".repeat(64),
          planContentSha256: "c".repeat(64),
          findingSha256: "d".repeat(64),
          planSourceRevision: plan.sourceRevision,
          evidenceRevision: company.revision - 1,
          evidenceFingerprint: "e".repeat(64),
          stale: true,
          staleReasons: ["plan-evidence-outdated"],
        });
      } else if (replyMode === "changed") {
        company.plans.push({
          ...structuredClone(plan),
          id: "a0000000-0000-4000-8000-000000000003",
          version: 3,
        });
      }
      return reply(company);
    }
    if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
      unexpected.push(u.pathname);
      return route.abort();
    }
    return route.continue();
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

  if (scenario === "summary") {
    const original = structuredClone(company.plans);
    const summary = (n) => page.getByLabel("의견 " + n + "의 최근 담당자 판단", { exact: true });
    const saveJudgement = async (status, reason, count) => {
      await page
        .getByRole("button", { name: "의견 3: 동일한 근거 대조 의견", exact: true })
        .click();
      assert.equal(
        await page.getByLabel("판단할 검토 의견 직접 선택", { exact: true }).inputValue(),
        "2",
      );
      await page.getByLabel("처리 상태", { exact: true }).selectOption(status);
      await page.getByLabel("판단 담당자 *", { exact: true }).fill("합성 검토 담당자");
      await page.getByLabel("확인한 내용과 판단 이유 *", { exact: true }).fill(reason);
      await page.getByRole("button", { name: "검토 판단 이력 저장", exact: true }).click();
      await page.getByText("원고 v2의 판단 이력 " + count + "개", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector("#plan-review-reviewer"));
      await page.getByRole("button", { name: "원고로 돌아가기", exact: true }).click();
    };
    await reopen();
    assert.equal(await summary(1).count(), 0); // Hidden info does not renumber original findings.
    assert.ok((await summary(2).innerText()).includes("담당자 판단 미기록"));
    assert.ok((await summary(3).innerText()).includes("담당자 판단 미기록"));
    assert.equal(commands.length, 0);
    await saveJudgement("deferred", "외부 근거 확인 전까지 보류합니다.", 1);
    assert.ok((await summary(3).innerText()).includes("최근 수동 판단: 보류"));
    assert.ok((await summary(3).innerText()).includes("합성 검토 담당자"));
    assert.ok((await summary(3).innerText()).includes("재검토 필요"));
    assert.ok(
      (await summary(3).innerText()).includes(
        "이 원고가 최신 근거를 반영했는지 다시 확인해야 합니다.",
      ),
    );
    assert.ok((await summary(2).innerText()).includes("담당자 판단 미기록"));
    assert.deepEqual(company.plans, original);
    record(
      "saved deferred judgement appears on its original index without reopening the form or affecting an identical opinion",
    );

    await saveJudgement("resolved", "담당자의 수동 해결 판단을 남깁니다.", 2);
    assert.ok((await summary(3).innerText()).includes("최근 수동 판단: 담당자 해결 판단"));
    assert.ok(!(await summary(3).innerText()).includes("최근 수동 판단: 보류"));
    assert.ok((await summary(3).innerText()).includes("재검토 필요"));
    assert.equal(commands[1].decision.previousRecordId, company.planReviewDecisions[0].id);
    assert.equal(company.planReviewDecisions.length, 2);
    assert.deepEqual(company.plans, original);
    assert.equal(company.plans.at(-1).confirmedAt, null);
    assert.equal(company.analysis, null);
    assert.equal(company.selectedCandidateId, null);
    assert.ok(
      (await page.getByRole("region", { name: "현재 원고와 검토 상태" }).innerText()).includes(
        "전체 검토 미완료",
      ),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-sonner-toast][data-visible="true"]').length === 0,
      undefined,
      { timeout: 15000 },
    );
    await page.getByRole("region", { name: "의견별 검토 판단 바로가기" }).scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "judgement-summary-mobile.png") });
    record(
      "latest manual resolution replaces the summary only; earlier history, stale warning and manuscript confirmation remain unchanged on mobile",
    );

    company.plans.push({
      ...structuredClone(company.plans.at(-1)),
      id: "a0000000-0000-4000-8000-000000000003",
      version: 3,
    });
    company.revision += 1;
    await reopen();
    await page.getByRole("heading", { name: "현재 원고 v3", exact: true }).waitFor();
    assert.ok((await summary(3).innerText()).includes("담당자 판단 미기록"));
    assert.ok((await summary(2).innerText()).includes("담당자 판단 미기록"));
    assert.equal(company.planReviewDecisions.length, 2);
    assert.equal(commands.length, 2);
    assert.deepEqual(company.plans.slice(0, 2), original);
    record(
      "new manuscript shows no judgement while preserving old-version records and performing no automatic write",
    );
  } else {
    await reopen();
    const panel = () => page.getByLabel("간단 원고 검토 판단", { exact: true });
    const choose = () => page.getByLabel("판단할 검토 의견 직접 선택", { exact: true });
    const save = () => page.getByRole("button", { name: "검토 판단 이력 저장", exact: true });
    const back = () => page.getByRole("button", { name: "원고로 돌아가기", exact: true });
    const original = structuredClone(company.plans);
    await page.getByRole("button", { name: "검토 의견 확인하기", exact: true }).click();
    await panel().waitFor();
    assert.equal(await choose().inputValue(), "");
    assert.equal(await page.getByLabel("판단 담당자 *", { exact: true }).count(), 0);
    assert.equal(commands.length, 0);
    await back().click();
    record("primary action opens the existing decision panel without auto-selecting or writing");

    await page.getByRole("button", { name: "의견 3: 동일한 근거 대조 의견", exact: true }).click();
    assert.equal(await choose().inputValue(), "2");
    assert.ok((await panel().innerText()).includes("두 번째 원래 근거를 대조하세요"));
    assert.equal(await page.getByLabel("처리 상태", { exact: true }).inputValue(), "pending");
    await page.getByLabel("처리 상태", { exact: true }).selectOption("deferred");
    await page.getByLabel("판단 담당자 *", { exact: true }).fill("합성 담당자");
    await page
      .getByLabel("확인한 내용과 판단 이유 *", { exact: true })
      .fill("추가 근거 대조 전까지 보류합니다.");
    record(
      "explicit opinion uses original index 2 despite a hidden info row and duplicate messages",
    );

    page.once("dialog", (d) => d.dismiss());
    await back().click();
    assert.equal(
      await page.getByLabel("확인한 내용과 판단 이유 *", { exact: true }).inputValue(),
      "추가 근거 대조 전까지 보류합니다.",
    );
    page.once("dialog", (d) => d.dismiss());
    await choose().selectOption("1");
    assert.equal(await choose().inputValue(), "2");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, "review-decision-mobile.png"),
      fullPage: true,
    });
    record("cancelled close or opinion switch preserves the draft and mobile form fits");

    holdResponse = true;
    await save().click();
    await page.waitForFunction(() => document.querySelector("#plan-review-finding")?.disabled);
    assert.equal(await back().isDisabled(), true);
    while (!releaseResponse) await new Promise((r) => setTimeout(r, 20));
    releaseResponse();
    holdResponse = false;
    await page.getByText("원고 v2의 판단 이력 1개", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#plan-review-reviewer"));
    assert.equal(commands[0].decision.findingIndex, 2);
    assert.equal(commands[0].decision.planId, original[1].id);
    assert.equal(commands[0].decision.planVersion, 2);
    assert.deepEqual(commands[0].decision.finding, original[1].review[2]);
    assert.equal(company.planReviewDecisions[0].status, "deferred");
    assert.deepEqual(company.plans, original);
    await back().click();
    assert.ok(
      (await page.getByRole("region", { name: "현재 원고와 검토 상태" }).innerText()).includes(
        "전체 검토 미완료",
      ),
    );
    record(
      "exact acknowledgement clears the draft only after pending save; deferred history leaves original versions unchanged",
    );

    await page.getByRole("button", { name: "의견 2: 동일한 근거 대조 의견", exact: true }).click();
    await page.getByLabel("처리 상태", { exact: true }).selectOption("resolved");
    await page.getByLabel("판단 담당자 *", { exact: true }).fill("합성 담당자");
    await page
      .getByLabel("확인한 내용과 판단 이유 *", { exact: true })
      .fill("담당자가 근거를 확인했다는 수동 판단");
    await save().click();
    await page.getByText("원고 v2의 판단 이력 2개", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#plan-review-reviewer"));
    assert.deepEqual(company.plans, original);
    assert.equal(company.analysis, null);
    assert.equal(company.selectedCandidateId, null);
    await back().click();
    assert.equal(
      await page.getByRole("button", { name: "검토 의견 확인하기", exact: true }).count(),
      1,
    );
    assert.equal(
      await page.getByRole("button", { name: "검토 마치고 신청 준비", exact: true }).count(),
      0,
    );
    record(
      "manual resolution records history without clearing the finding or whole-plan confirmation",
    );

    await page.getByRole("button", { name: "의견 3: 동일한 근거 대조 의견", exact: true }).click();
    assert.equal(await page.getByLabel("처리 상태", { exact: true }).inputValue(), "pending");
    await page.getByLabel("판단 담당자 *", { exact: true }).fill("미확인 담당자");
    await page
      .getByLabel("확인한 내용과 판단 이유 *", { exact: true })
      .fill("저장 응답이 없으면 유지할 입력");
    replyMode = "missing";
    await save().click();
    await page
      .getByText(
        "저장 결과를 확인하지 못했습니다. 작성 내용을 유지했습니다. 최신 이력을 확인해 주세요.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByLabel("판단 담당자 *", { exact: true }).inputValue(),
      "미확인 담당자",
    );
    assert.equal(commands[2].decision.previousRecordId, company.planReviewDecisions[0].id);
    await save().click();
    await page
      .getByText("원고나 자료가 바뀌었습니다. 최신 검토 의견을 다시 선택해 주세요.", {
        exact: true,
      })
      .waitFor();
    assert.equal(commands.length, 3);
    page.once("dialog", (d) => d.accept());
    await back().click();
    record(
      "missing receipt preserves input; changed revision blocks a fresh write and retains previous-record binding",
    );

    await page.getByRole("button", { name: "의견 2: 동일한 근거 대조 의견", exact: true }).click();
    await page.getByLabel("판단 담당자 *", { exact: true }).fill("원래 의견 담당자");
    await page
      .getByLabel("확인한 내용과 판단 이유 *", { exact: true })
      .fill("새 원고가 와도 보존할 입력");
    replyMode = "changed";
    await save().click();
    await page
      .getByText(
        "현재 회사나 원고가 바뀌었습니다. 작성 내용은 유지했습니다. 원고로 돌아가 최신 의견을 선택해 주세요.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByLabel("확인한 내용과 판단 이유 *", { exact: true }).inputValue(),
      "새 원고가 와도 보존할 입력",
    );
    assert.equal(await choose().isDisabled(), true);
    assert.equal(await save().isDisabled(), true);
    assert.ok((await panel().innerText()).includes("원고 v2"));
    page.once("dialog", (d) => d.accept());
    await back().click();
    await page.getByRole("heading", { name: "현재 원고 v3", exact: true }).waitFor();
    assert.deepEqual(company.plans.slice(0, 2), original);
    assert.equal(commands.length, 4);
    record(
      "new manuscript blocks stale judgement without replacing the draft; explicit return opens v3",
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(!logs.join("").includes("FORBIDDEN_SERVER_FETCH"));
  assert.equal((await readdir(output)).includes("unused-data"), false);
  assert.ok(!logs.join("").includes("GET /api/"));
  assert.ok(commands.every((c) => c.action === "append-plan-review"));
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        checks,
        syntheticApiCommands: commands.length,
        syntheticExports: downloads,
        startingState:
          "synthetic saved manuscript and judgement receipts; actual writer not executed",
        errors,
        unexpected,
        actualBusinessApi: 0,
        external: 0,
        sql: 0,
        sdk: 0,
        mode: serverMode,
        scenario,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ output, checks: checks.length, syntheticApiCommands: commands.length }),
  );
} catch (error) {
  console.log(JSON.stringify({ output, checks, downloads, unexpected, errors, network }));
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
}
