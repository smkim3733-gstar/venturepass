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
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/lib/studio-guided-flow.ts",
  "src/lib/studio-export-docx.ts",
  "src/lib/studio-export.ts",
  "src/components/studio/plan-supplement-panel.tsx",
  "src/components/studio/plan-supplement-ui.ts",
  "src/components/studio/guided-plan-review.tsx",
  "src/components/studio/plan-review-decisions.tsx",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-core-journey-ui-"));
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
  input: path.join(app, "scripts/fixtures/guided-core-journey.ts"),
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
let company = fixture.journeyCompany();
const initialPlan = structuredClone(company.plans),
  name = company.profile.companyName,
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
  const root = "/api/studio/cases/" + caseId;
  try {
    if (req.method === "GET" && u.pathname === root + "/export") {
      assert.equal(u.searchParams.get("format"), "docx");
      assert.deepEqual([...u.searchParams.keys()].sort(), ["format", "planId"]);
      const plan = company.plans.find((p) => p.id === u.searchParams.get("planId"));
      assert.ok(plan);
      assert.equal(plan.id, company.plans.at(-1).id);
      const bytes = Buffer.from(await fixture.exportPlanDocx(company, plan, false));
      downloads.push({ planId: plan.id, version: plan.version });
      res.writeHead(200, {
        "Content-Type": fixture.PLAN_DOCX_MIME,
        "Content-Disposition": 'attachment; filename="manuscript-v' + plan.version + '.docx"',
        "Content-Length": String(bytes.length),
      });
      res.end(bytes);
      return;
    }
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
        return reply(fixture.status(company));
      if (u.pathname === root + "/plan-supplements/adoption")
        return reply(fixture.adoptionAudit(company));
      if (u.pathname === root + "/export") return route.continue();
    }

    if (req.method() === "PATCH" && u.pathname === root) {
      const command = req.postDataJSON();
      commands.push(command);
      assert.equal(command.revision, company.revision);
      if (command.action === "source") {
        assert.equal(company.sources.length, 0);
        company = {
          ...company,
          revision: company.revision + 1,
          sources: [
            {
              ...command.source,
              createdAt: "2026-10-09T01:00:00.000Z",
              updatedAt: "2026-10-09T01:00:00.000Z",
            },
          ],
        };
      } else if (command.action === "append-plan-review") {
        assert.equal(command.decision.planId, company.plans.at(-1).id);
        assert.equal(command.decision.planVersion, 2);
        company = fixture.decision(company, command);
      } else throw Error("Unexpected synthetic mutation");
      return reply(company);
    }
    if (req.method() === "POST" && u.pathname === root + "/plan-supplements/execution") {
      const command = req.postDataJSON();
      commands.push(command);
      if (command.action === "prepare-ai") return reply(fixture.preview(company, command.input));
      assert.equal(command.action, "propose-section");
      assert.equal(command.approved, true);
      company = fixture.completeProposal(company, command);
      return reply(fixture.status(company));
    }
    if (req.method() === "POST" && u.pathname === root + "/plan-supplements/adoption") {
      const command = req.postDataJSON();
      commands.push(command);
      if (command.action === "prepare-adoption")
        return reply(
          fixture.preparePlanSupplementAdoption(company, command.revision, command.executionId),
        );
      assert.equal(command.action, "adopt-section-supplement");
      assert.equal(command.confirmed, true);
      company = fixture.adopt(company, command);
      return reply(fixture.status(company));
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

  await reopen(); // The only navigation/reset: every following step uses this same mounted company.
  assert.equal(company.revision, 4);
  await page.getByRole("button", { name: /답변·메모·보완 자료 연결/ }).click();
  await page.getByLabel(fixture.answerQuestion, { exact: true }).fill(fixture.answer);
  await page
    .getByRole("combobox", { name: /관련 계획서 항목/ })
    .nth(1)
    .selectOption("development");
  await page.getByRole("button", { name: "답변 보관하기", exact: true }).click();
  const handoff = page.getByRole("region", { name: "저장한 답변으로 원고 보완", exact: true });
  await handoff.waitFor();
  assert.equal(company.sources.length, 1);
  const sourceId = company.sources[0].id;
  assert.ok(company.sources[0].text.includes(fixture.answer));
  await handoff.getByRole("button", { name: "이 답변으로 항목 수정안 만들기" }).click();
  const panel = page.getByRole("region", { name: "한 항목 보완 수정안", exact: true });
  await panel.waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="한 항목 보완 수정안"] fieldset')?.disabled,
  );
  assert.equal(commands.length, 1);
  await panel.getByRole("button", { name: "전송 범위 확인", exact: true }).click();
  const transmit = page.getByRole("region", { name: "수정안 전송 동의", exact: true });
  await transmit.waitFor();
  const input = commands[1].input;
  assert.equal(input.target.planId, initialPlan[0].id);
  assert.equal(input.target.questionIndex, 1);
  assert.equal(input.sectionKey, "development");
  assert.deepEqual(
    input.sourceSelections.map((s) => s.sourceId),
    [sourceId],
  );
  assert.equal(input.revision, 5);
  assert.equal(await transmit.getByRole("checkbox").isChecked(), false);
  const propose = transmit.getByRole("button", { name: "동의하고 수정안 만들기", exact: true });
  assert.equal(await propose.isDisabled(), true);
  record("saved answer, original question and section continue into exact selected-source preview");

  await transmit.getByRole("checkbox").check();
  await propose.click();
  await panel.getByRole("button", { name: "현재 원고와 비교", exact: true }).click();
  const compare = page.getByRole("region", { name: "수정 전후 비교", exact: true });
  await compare.waitFor();
  assert.equal(company.revision, 7);
  assert.equal(company.plans.length, 1);
  assert.deepEqual(company.plans, initialPlan);
  assert.equal(await compare.getByRole("checkbox").isChecked(), false);
  const adopt = compare.getByRole("button", {
    name: "비교한 수정안을 새 버전으로 저장",
    exact: true,
  });
  assert.equal(await adopt.isDisabled(), true);
  assert.ok((await compare.innerText()).includes(fixture.revisedText));
  assert.ok((await compare.innerText()).includes(fixture.answer));
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem("venturepass:plan-supplement:v1:" + id),
      caseId,
    ),
    null,
  );
  record(
    "separate transmission consent permits one synthetic response; comparison preserves v1 and requires adoption consent",
  );

  await compare.getByRole("checkbox").check();
  await adopt.click();
  await page
    .getByText("새 버전 v2에 저장했습니다. 이전 원고는 그대로 보관되어 있습니다.", { exact: true })
    .waitFor();
  assert.equal(company.plans.length, 2);
  assert.deepEqual(company.plans[0], initialPlan[0]);
  const adoptedPlan = structuredClone(company.plans[1]);
  const section = adoptedPlan.content.sections.find((s) => s.key === "development");
  assert.equal(section.content, fixture.revisedText);
  assert.equal(section.needsConfirmation, true);
  assert.equal(section.evidence[0].sourceId, sourceId);
  assert.equal(section.evidence[0].quote, fixture.answer);
  assert.equal(company.planSupplementAdoptions[0].planId, adoptedPlan.id);
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem("venturepass:plan-supplement:v1:" + id),
      caseId,
    ),
    null,
  );
  await panel.getByRole("button", { name: "계획서로 돌아가기", exact: true }).click();
  await page.getByRole("heading", { name: "현재 원고 v2", exact: true }).waitFor();
  record(
    "exact adoption receipt clears pending command; returning from comparison opens the new v2 with answer citation",
  );

  await page.getByRole("button", { name: "의견 1: 외부 시험 근거 확인 필요", exact: true }).click();
  const decision = page.getByLabel("간단 원고 검토 판단", { exact: true });
  await decision.waitFor();
  assert.equal(
    await page.getByLabel("판단할 검토 의견 직접 선택", { exact: true }).inputValue(),
    "0",
  );
  assert.ok((await decision.innerText()).includes("원고 v2"));
  await page.getByLabel("처리 상태", { exact: true }).selectOption("deferred");
  await page.getByLabel("판단 담당자 *", { exact: true }).fill("합성 검토 담당자");
  await page
    .getByLabel("확인한 내용과 판단 이유 *", { exact: true })
    .fill("외부 시험 결과가 없어 근거 확인 전까지 보류합니다.");
  await page.getByRole("button", { name: "검토 판단 이력 저장", exact: true }).click();
  await page.getByText("원고 v2의 판단 이력 1개", { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("#plan-review-reviewer"));
  assert.equal(company.planReviewDecisions.length, 1);
  assert.equal(company.planReviewDecisions[0].planId, adoptedPlan.id);
  assert.equal(company.planReviewDecisions[0].status, "deferred");
  assert.deepEqual(company.plans[1], adoptedPlan);
  await page.getByRole("button", { name: "원고로 돌아가기", exact: true }).click();
  const overview = page.getByRole("region", { name: "현재 원고와 검토 상태", exact: true });
  await overview.waitFor();
  assert.ok((await overview.innerText()).includes("항목 확인 필요 1개"));
  assert.ok((await overview.innerText()).includes("전체 검토 미완료"));
  assert.equal(company.plans[1].confirmedAt, null);
  assert.equal(company.analysis, null);
  assert.equal(company.selectedCandidateId, null);
  record(
    "v2 original finding opens directly; explicit deferred judgment retains manuscript and unconfirmed state",
  );

  const waiting = page.waitForEvent("download");
  await overview.getByRole("link", { name: "원고 v2 Word 내려받기", exact: true }).click();
  const item = await waiting;
  const destination = path.join(output, "journey-v2.docx");
  await item.saveAs(destination);
  const xml = await fixture.documentXml(await readFile(destination));
  for (const text of [
    "원고 버전 2",
    fixture.revisedText,
    fixture.answer,
    "외부 시험 근거 확인 필요",
    "확인 필요",
    initialPlan[0].content.sections[0].content,
  ])
    assert.ok(xml.includes(text), "Missing document text: " + text);
  assert.ok(
    !xml.includes(initialPlan[0].content.sections.find((s) => s.key === "development").content),
  );
  assert.deepEqual(downloads, [{ planId: adoptedPlan.id, version: 2 }]);
  assert.deepEqual(company.plans, [initialPlan[0], adoptedPlan]);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: path.join(output, "continuous-journey-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(
    commands.map((c) => c.action),
    [
      "source",
      "prepare-ai",
      "propose-section",
      "prepare-adoption",
      "adopt-section-supplement",
      "append-plan-review",
    ],
  );
  record(
    "the same session downloads v2 Word with revised paragraph, exact answer citation and unresolved review",
  );
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
        syntheticApiCommands: commands.length,
        syntheticExports: downloads,
        continuousJourneys: 1,
        startingState:
          "one synthetic company, v1 with no answer sources; actual writers and provider never executed",
        commandActions: commands.map((c) => c.action),
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
