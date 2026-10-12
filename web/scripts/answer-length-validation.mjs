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
const scenario = "answer-length";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/guided-question-card.tsx",
  "src/components/studio/guided-plan-evidence.tsx",
  "scripts/fixtures/guided-answer-workflow.ts",
  "scripts/answer-length-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-answer-length-ui-"));
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
const fixtureEntry = path.join(output, "fixture-entry.mjs");
await writeFile(
  fixtureEntry,
  [
    "export { answerWorkflowCompany, answerWorkflowSource } from " +
      JSON.stringify(path.join(app, "scripts/fixtures/guided-answer-workflow.ts")) +
      ";",
    "export { guidedQuestionContexts, guidedAnswerText } from " +
      JSON.stringify(path.join(app, "src/components/studio/guided-question-context.ts")) +
      ";",
  ].join(String.fromCharCode(10)),
);
const bundle = await rolldown({
  input: fixtureEntry,
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
  assert.deepEqual(chunk.imports, []);
  assert.deepEqual(chunk.dynamicImports, []);
  fixture = await import(
    "data:text/javascript;base64," + Buffer.from(chunk.code).toString("base64")
  );
} finally {
  await bundle.close();
}
const company = fixture.answerWorkflowCompany();
company.profile.companyName = "합성 답변 글자 수 기업";
company.sources = [fixture.answerWorkflowSource()];
company.plans[0].content.interviewQuestions = Array.from(
  { length: 6 },
  (_, i) => "합성 준비 질문 " + (i + 1),
);
const questions = fixture.guidedQuestionContexts(company, company.plans[0]);
assert.equal(questions.length, 6);
let releasePatch, markPatchReceived;
const patchReceived = new Promise((resolve) => {
  markPatchReceived = resolve;
});
const heldPatch = new Promise((resolve) => {
  releasePatch = resolve;
});
const answers = {},
  links = {};
const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0,
  nextDialog = "dismiss";
const network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [],
  dialogs = [],
  focusChecks = [];
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
      if (req.method() === "GET") {
        if (u.pathname === "/api/studio/status")
          return reply({
            aiConfigured: true,
            model: "synthetic-disabled",
            storage: "local",
            supportedFiles: [],
          });
        if (u.pathname === "/api/studio/cases")
          return reply({
            cases: companies.map((value) => ({
              id: value.id,
              companyName: value.profile.companyName,
              industry: "",
              stage: value.stage,
              revision: value.revision,
              createdAt: value.createdAt,
              updatedAt: value.updatedAt,
              sourceCount: value.sources.length,
              planCount: value.plans.length,
              pendingTaskCount: 0,
            })),
          });
        const found = companies.find((value) => u.pathname === "/api/studio/cases/" + value.id);
        if (found) {
          caseReads++;
          return reply(found);
        }
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
          preparationReads++;
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        }
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
      }
      if (u.pathname === `/api/studio/cases/${company.id}` && req.method() === "PATCH") {
        const command = req.postDataJSON();
        commands.push(command);
        assert.equal(commands.length, 1);
        assert.equal(command.action, "source");
        assert.equal(command.revision, company.revision);
        assert.equal(command.source.name, "사업계획서 준비 답변");
        assert.equal(command.source.kind, "consultation");
        assert.equal(command.source.extraction, "manual");
        assert.equal(
          command.source.text,
          fixture.guidedAnswerText(company, questions, answers, links),
        );
        markPatchReceived();
        await heldPatch;
        return reply({ error: "합성 답변 저장 실패" }, 500);
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
  page.on("dialog", async (dialog) => {
    const action = nextDialog;
    nextDialog = "dismiss";
    dialogs.push({ message: dialog.message(), action });
    await dialog[action]();
  });
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

  await page
    .getByRole("navigation", { name: "신청 준비 3단계" })
    .getByRole("button", { name: "AI 계획서" })
    .click();
  await page.getByRole("button", { name: "필요한 질문에 답하기", exact: true }).click();
  const input = (i) => page.locator("#guided-answer-" + i);
  const count = (i) => page.locator("#guided-answer-" + i + "-length");
  const limitMessage = "입력 한도에 도달했습니다. 내용을 줄이면 더 입력할 수 있습니다.";
  async function check(i, value) {
    assert.equal(await input(i).inputValue(), value);
    assert.equal(await input(i).getAttribute("aria-describedby"), "guided-answer-" + i + "-length");
    assert.equal(await input(i).getAttribute("maxlength"), "5000");
    assert.equal(
      (await count(i).textContent()).trim(),
      "답변 " +
        value.length.toLocaleString("ko-KR") +
        " / 5,000자" +
        (value.length >= 5000 ? " · " + limitMessage : ""),
    );
  }
  async function shot(name, target) {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, name) });
  }
  const safe = () => {
    assert.deepEqual(companies, original);
    assert.equal(dialogs.length, 0);
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await count(0).waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('textarea[id^="guided-answer-"]').count(), 3);
  for (let i = 0; i < 3; i++) await check(i, "");
  const first = "  첫 답변\n둘째 줄 😀  ";
  await input(0).fill(first);
  answers[questions[0].id] = first;
  await check(0, first);
  await check(1, "");
  await page
    .getByRole("combobox", { name: /관련 계획서 항목/ })
    .first()
    .selectOption("development");
  const card = input(0).locator("..");
  await card
    .locator("summary")
    .filter({ hasText: /보관 자료 연결/ })
    .click();
  await card.getByRole("checkbox").check();
  links[questions[0].id] = { sectionKey: "development", sourceIds: [company.sources[0].id] };
  await check(0, first);
  safe();
  assert.equal(commands.length, 0);
  await shot("answer-length-draft-mobile.png", count(0));
  record(
    "zero and per-answer raw length include spaces, line breaks and UTF-16 emoji units; description points to the count and section/source choices do not change the answer",
  );

  const boundary = "가".repeat(5000);
  await input(0).fill(boundary);
  answers[questions[0].id] = boundary;
  await check(0, boundary);
  await input(0).press("Control+End");
  await input(0).press("x");
  await check(0, boundary);
  await shot("answer-length-limit-mobile.png", count(0));
  await input(0).press("Backspace");
  await check(0, boundary.slice(0, -1));
  await input(0).press("x");
  answers[questions[0].id] = boundary.slice(0, -1) + "x";
  await check(0, answers[questions[0].id]);
  await page.getByRole("button", { name: "남은 질문 3개 더 보기", exact: true }).click();
  assert.equal(await page.locator('textarea[id^="guided-answer-"]').count(), 6);
  for (let i = 1; i < 6; i++) await check(i, "");
  const sixth = "  마지막 답변\n보존할 메모  ";
  await input(5).fill(sixth);
  answers[questions[5].id] = sixth;
  await check(5, sixth);
  await check(0, answers[questions[0].id]);
  safe();
  assert.equal(commands.length, 0);
  record(
    "existing 5000-character browser limit stops further typing; deleting permits typing again, while opening more questions keeps each independent count and original answer",
  );

  await page.getByRole("button", { name: "지금은 없어요 · 나중에 답하기", exact: true }).click();
  await page.getByRole("button", { name: "보관한 답변 보기", exact: true }).click();
  await check(0, answers[questions[0].id]);
  await check(5, sixth);
  assert.equal(
    await page
      .getByRole("combobox", { name: /관련 계획서 항목/ })
      .first()
      .inputValue(),
    "development",
  );
  const returnedCard = input(0).locator("..");
  await returnedCard
    .locator("summary")
    .filter({ hasText: /보관 자료 연결/ })
    .click();
  assert.equal(await returnedCard.getByRole("checkbox").isChecked(), true);
  await page.getByRole("button", { name: "답변 보관하기", exact: true }).click();
  await page.getByText("답변을 보관하고 있습니다", { exact: true }).waitFor();
  await Promise.race([
    patchReceived,
    new Promise((_, reject) => setTimeout(() => reject(Error("PATCH not received")), 10000)),
  ]);
  assert.equal(commands.length, 1);
  assert.equal(await input(0).count(), 0);
  releasePatch();
  await page
    .getByText(
      "답변 저장 결과가 미확인입니다. 원래 답변과 연결 항목을 확인할 때까지 이 화면에 보관합니다.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "답변 저장 상태 확인", exact: true })
    .waitFor({ state: "visible" });
  await check(0, answers[questions[0].id]);
  await check(5, sixth);
  assert.equal(await input(0).evaluate((e) => e.readOnly), true);
  await shot("answer-length-pending-mobile.png", count(5));
  safe();
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  assert.equal(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
    true,
  );
  record(
    "deferring and reopening preserves all counts, answers and links; explicit synthetic failed save keeps raw drafts and counts behind the original pending-save protection without retry or recovery GET",
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
        syntheticPatches: commands.length,
        syntheticCompanyGets: caseReads,
        syntheticIntakeGets: intakeReads,
        syntheticPreparationGets: preparationReads,
        syntheticUploadPosts: 0,
        syntheticPreviewPosts: 0,
        commands,
        dialogs,
        focusChecks,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "per-question input length with existing 5000 limit, one synthetic failed PATCH, no actual save or AI",
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
  releasePatch();
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
