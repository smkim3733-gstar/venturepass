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
const scenario = "visit-answer-cancel";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/visit-answers.tsx",
  "src/components/studio/visit-answer-response.ts",
  "scripts/fixtures/visit-answer-receipt.ts",
  "scripts/visit-answer-cancel-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-visit-answer-cancel-ui-"));
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
  input: path.join(app, "scripts/fixtures/visit-answer-receipt.ts"),
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
const prepared = fixture.visitReceiptFixture();
const company = prepared.company;
company.profile.companyName = "합성 실사 답변 취소 기업";
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let caseReads = 0,
  intakeReads = 0,
  preparationReads = 0;
let releasePatch, observePatch;
const patchObserved = new Promise((resolve) => {
  observePatch = resolve;
});
const patchGate = new Promise((resolve) => {
  releasePatch = resolve;
});
const dialogs = [];
let acceptDialog = false;
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
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
          preparationReads++;
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        }
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          intakeReads++;
          return reply({ company, intakes: [] });
        }
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
      }
      if (req.method() === "PATCH" && u.pathname === "/api/studio/cases/" + company.id) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.equal(commands.length, 1);
        assert.equal(command.action, "append-visit-answer");
        assert.equal(command.revision, original.revision);
        assert.deepEqual(command.answer, prepared.input);
        assert.match(command.clientRequestId, /^[0-9a-f-]{36}$/);
        observePatch();
        await patchGate;
        return reply({ error: "합성 답변 저장 실패" }, 500);
      }
      if (u.pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method())) {
        unexpected.push(u.pathname);
        return route.abort();
      }
      return await route.continue();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Synthetic route failure");
      observePatch();
      await route.abort().catch(() => {});
    }
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: acceptDialog });
    await (acceptDialog ? dialog.accept() : dialog.dismiss());
  });
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
  const readiness = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await readiness;
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const panel = page.getByRole("region", { name: "실사 모의 답변 기록", exact: true });
  const cancel = () => panel.getByRole("button", { name: "편집 취소", exact: true });
  const answer = panel.getByLabel("담당자 모의 답변 (최대 10,000자)", { exact: true });
  const role = panel.getByLabel("응답자 역할", { exact: true });
  const respondent = panel.getByLabel("응답자 이름", { exact: true });
  const followup = panel.getByLabel("추가 자료·후속 확인", { exact: true });
  const save = () => panel.getByRole("button", { name: "답변 버전 저장", exact: true });
  const pairPanel = (i) =>
    panel
      .locator("fieldset")
      .filter({
        has: page.getByText("인용 대조 " + (i + 1), { exact: true }),
      })
      .last();
  const openNew = async () => {
    await panel
      .getByLabel("기준 원고 버전 직접 선택", { exact: true })
      .selectOption(company.plans.at(-1).id);
    await panel.getByLabel("원고의 예상 질문 직접 선택", { exact: true }).selectOption("0");
    await panel.getByRole("button", { name: "미검토 답변 작성 시작", exact: true }).click();
    await answer.waitFor();
  };
  const openExisting = async () => {
    await panel.getByRole("button", { name: "이 답변에서 새 버전 작성", exact: true }).click();
    await answer.waitFor();
  };
  const dirty = async (expected) => {
    await page.waitForFunction(
      (value) => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented === value;
      },
      expected,
      { timeout: 10000 },
    );
  };
  const cancelWith = async (accepted) => {
    const count = dialogs.length;
    acceptDialog = accepted;
    await cancel().focus();
    await page.keyboard.press("Enter");
    assert.equal(dialogs.length, count + 1);
    assert.deepEqual(dialogs.at(-1), {
      type: "confirm",
      message: "저장하지 않은 실사 모의 답변과 인용·검토 입력을 취소할까요?",
      accepted,
    });
  };
  const capture = async (label, target) => {
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "visit-cancel-" + label + "-mobile.png") });
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await openNew();
  await cancel().click();
  await answer.waitFor({ state: "hidden" });
  assert.equal(dialogs.length, 0);
  await dirty(false);
  await openNew();
  const raw = {
    name: "  새 응답자  ",
    answer: "  작성한 모의 답변\n둘째 줄  ",
    note: "  추가 확인\n메모  ",
    quote: "  인용 초안\n줄바꿈  ",
  };
  await role.selectOption("technical");
  await respondent.fill(raw.name);
  await answer.fill(raw.answer);
  await followup.fill(raw.note);
  await panel.getByRole("button", { name: "답변·원고/자료 인용 대조 추가", exact: true }).click();
  await pairPanel(0).getByLabel("작성한 답변에서 그대로 인용 *", { exact: true }).fill(raw.quote);
  const newSnapshot = async () => {
    assert.equal(await role.inputValue(), "technical");
    assert.equal(await respondent.inputValue(), raw.name);
    assert.equal(await answer.inputValue(), raw.answer);
    assert.equal(await followup.inputValue(), raw.note);
    assert.equal(
      await pairPanel(0).getByLabel("작성한 답변에서 그대로 인용 *", { exact: true }).inputValue(),
      raw.quote,
    );
    await dirty(true);
    assert.deepEqual(company, original);
    assert.equal(commands.length, 0);
  };
  await cancelWith(false);
  await newSnapshot();
  await capture("new", answer);
  await cancelWith(true);
  await answer.waitFor({ state: "hidden" });
  await dirty(false);
  record(
    "new answer cancellation preserves raw answer, respondent, follow-up and citation on rejection; acceptance closes without saving",
  );

  await openNew();
  assert.equal(await answer.inputValue(), "");
  await role.selectOption("other");
  await cancelWith(false);
  assert.equal(await role.inputValue(), "other");
  await role.selectOption("representative");
  const beforeClean = dialogs.length;
  await cancel().click();
  await answer.waitFor({ state: "hidden" });
  assert.equal(dialogs.length, beforeClean);
  await openExisting();
  assert.equal(await answer.inputValue(), original.visitAnswers[0].answerText);
  await cancel().click();
  await answer.waitFor({ state: "hidden" });
  assert.equal(dialogs.length, beforeClean);
  await openExisting();
  const review = panel.getByRole("checkbox");
  await review.check();
  await cancelWith(false);
  assert.equal(await review.isChecked(), true);
  assert.equal(await answer.inputValue(), original.visitAnswers[0].answerText);
  await capture("review", review);
  await review.uncheck();
  const beforeRevert = dialogs.length;
  await cancel().click();
  await answer.waitFor({ state: "hidden" });
  assert.equal(dialogs.length, beforeRevert);
  await dirty(false);
  record(
    "role-only and review-only edits are protected; untouched and exactly reverted new or existing drafts close without confirmation",
  );

  await openExisting();
  await role.selectOption("technical");
  await respondent.fill(prepared.raw.respondentName);
  await answer.fill(prepared.raw.answerText);
  await followup.fill(prepared.raw.followUpNote);
  for (let i = 0; i < 2; i++) {
    await pairPanel(i)
      .getByLabel("작성한 답변에서 그대로 인용 *", { exact: true })
      .fill(prepared.input.pairs[i].answerQuote);
    await pairPanel(i)
      .getByLabel("기간·단위·대상·실적/계획 구분 메모 (수동)", { exact: true })
      .fill(prepared.input.pairs[i].contextNote);
  }
  await panel.getByLabel("검토 담당자", { exact: true }).fill(prepared.raw.reviewer);
  await panel.getByLabel("검토 메모·미해결 사항", { exact: true }).fill(prepared.raw.reviewNote);
  await review.check();
  const existingSnapshot = async () => {
    assert.equal(await role.inputValue(), "technical");
    assert.equal(await respondent.inputValue(), prepared.raw.respondentName);
    assert.equal(await answer.inputValue(), prepared.raw.answerText);
    assert.equal(await followup.inputValue(), prepared.raw.followUpNote);
    assert.equal(
      await panel.getByLabel("검토 담당자", { exact: true }).inputValue(),
      prepared.raw.reviewer,
    );
    assert.equal(
      await panel.getByLabel("검토 메모·미해결 사항", { exact: true }).inputValue(),
      prepared.raw.reviewNote,
    );
    assert.equal(await review.isChecked(), true);
    for (let i = 0; i < 2; i++) {
      assert.equal(
        await pairPanel(i)
          .getByLabel("작성한 답변에서 그대로 인용 *", { exact: true })
          .inputValue(),
        prepared.input.pairs[i].answerQuote,
      );
      assert.equal(
        await pairPanel(i).getByLabel("위 원고 항목 그대로 인용 *", { exact: true }).inputValue(),
        prepared.input.pairs[i].planReference.quote,
      );
      assert.equal(
        await pairPanel(i)
          .getByLabel("기간·단위·대상·실적/계획 구분 메모 (수동)", { exact: true })
          .inputValue(),
        prepared.input.pairs[i].contextNote,
      );
    }
    await dirty(true);
    assert.deepEqual(company, original);
  };
  await save().click();
  await patchObserved;
  assert.deepEqual(errors, []);
  await page.waitForFunction(
    () => document.getElementById("visit-answer-text")?.matches(":disabled"),
    null,
    { timeout: 10000 },
  );
  assert.equal(commands.length, 1);
  assert.equal(await cancel().isDisabled(), true);
  await existingSnapshot();
  releasePatch();
  await panel
    .getByText(
      "저장을 확인하지 못했습니다. 입력은 유지합니다. 같은 내용으로 다시 확인하거나 최신 기록을 확인해 주세요.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await cancel().isDisabled(), false);
  await cancelWith(false);
  await existingSnapshot();
  await capture("failure", answer);
  await cancelWith(true);
  await answer.waitFor({ state: "hidden" });
  await dirty(false);
  await openExisting();
  assert.equal(await answer.inputValue(), original.visitAnswers[0].answerText);
  assert.equal(await respondent.inputValue(), original.visitAnswers[0].respondentName);
  assert.equal(await review.isChecked(), false);
  assert.equal(await panel.getByLabel("검토 담당자", { exact: true }).inputValue(), "");
  for (let i = 0; i < 2; i++)
    assert.equal(
      await pairPanel(i)
        .getByLabel("기간·단위·대상·실적/계획 구분 메모 (수동)", { exact: true })
        .inputValue(),
      original.visitAnswers[0].pairs[i].contextNote,
    );
  const finalCount = dialogs.length;
  await cancel().click();
  await answer.waitFor({ state: "hidden" });
  await dirty(false);
  assert.equal(dialogs.length, finalCount);
  assert.equal(dialogs.length, 6);
  assert.equal(commands.length, 1);
  assert.equal(caseReads, 1);
  assert.deepEqual(company, original);
  record(
    "pending save keeps cancellation disabled; synthetic failure and rejected cancellation preserve all inputs, accepted cancellation reopens the original saved answer",
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
        dialogs,
        commands,
        syntheticIntakeGets: intakeReads,
        syntheticPreparationGets: preparationReads,
        syntheticPatches: commands.length,
        syntheticCompanyGets: caseReads,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "unchanged pure visit-answer fixture with a synthetic company name; no app-created records; one explicit held PATCH returns HTTP500",
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
