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
const scenario = "workflow-task-receipt";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/workflow-panel.tsx",
  "src/components/studio/workflow-task-response.ts",
  "scripts/fixtures/workflow-task-receipt.ts",
  "scripts/workflow-task-receipt-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-workflow-task-receipt-ui-"));
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
  input: path.join(app, "scripts/fixtures/workflow-task-receipt.ts"),
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
const prepared = fixture.workflowTaskFixture();
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let caseReads = 0,
  patchMode = "notes",
  updated,
  completed;
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
        if (guided)
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
      }
      if (req.method() === "PATCH" && u.pathname === "/api/studio/cases/" + company.id) {
        const command = req.postDataJSON();
        commands.push(command);
        assert.ok(commands.length <= 5);
        assert.equal(command.action, "task");
        if (commands.length <= 3) {
          assert.equal(command.revision, original.revision);
          assert.equal(command.task.title, prepared.request.task.title.trim());
          assert.equal(command.task.notes, prepared.request.task.notes);
          assert.equal(command.task.owners.review, prepared.request.task.owners.review.trim());
          assert.equal(command.task.processing.stage, "reviewing");
          assert.deepEqual(
            command.task.processing.planRefs,
            original.tasks.at(-1).processing.planRefs,
          );
          assert.deepEqual(command.task.agencyOrigin, original.tasks.at(-1).agencyOrigin);
          if (commands.length > 1) assert.deepEqual(command, commands[0]);
          updated ??= fixture.workflowTaskResult(original, command);
          const result = structuredClone(updated);
          if (patchMode === "notes") result.tasks.at(-1).notes = "다른 저장 메모";
          if (patchMode === "owner") result.tasks.at(-1).owners.review = "다른 검토 담당자";
          if (patchMode !== "exact") return reply(result);
          company = result;
        } else {
          assert.equal(command.revision, updated.revision);
          assert.deepEqual(command.task, { ...updated.tasks.at(-1), status: "done" });
          if (commands.length > 4) assert.deepEqual(command, commands[3]);
          completed ??= fixture.workflowTaskResult(updated, command);
          const result = structuredClone(completed);
          if (patchMode === "status") {
            result.tasks.at(-1).status = "pending";
            return reply(result);
          }
          company = result;
        }
        companies[0] = company;
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
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await page.getByRole("tab", { name: /진행 관리/ }).click();
  const item = () => page.locator("#workflow-task-" + prepared.request.task.id);
  const editor = () => page.getByRole("region", { name: "업무 편집", exact: true });
  const originalTask = original.tasks.at(-1);
  await item()
    .getByRole("button", { name: originalTask.title + " 수정", exact: true })
    .click();
  await editor().getByLabel("업무 제목 *", { exact: true }).fill(prepared.request.task.title);
  await editor().getByLabel("마감일", { exact: true }).fill(prepared.request.task.dueDate);
  await editor().getByLabel("요청 내용·메모", { exact: true }).fill(prepared.request.task.notes);
  await editor()
    .getByLabel("자료 준비 담당자", { exact: true })
    .fill(prepared.request.task.owners.materials);
  await editor()
    .getByLabel("작성 담당자", { exact: true })
    .fill(prepared.request.task.owners.writing);
  await editor()
    .getByLabel("최종 내용 확인 담당자", { exact: true })
    .fill(prepared.request.task.owners.review);
  await editor().getByLabel("담당자 기록 단계", { exact: true }).selectOption("reviewing");
  const errorText =
    "업무 변경 내용의 저장 결과를 확인하지 못했습니다. 원래 업무 입력과 상태를 유지했습니다.";
  for (const mode of ["notes", "owner"]) {
    patchMode = mode;
    await editor().getByRole("button", { name: "업무 저장", exact: true }).click();
    await page.getByText(errorText, { exact: true }).first().waitFor();
    assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
    assert.equal(
      await editor().getByLabel("업무 제목 *", { exact: true }).inputValue(),
      prepared.request.task.title,
    );
    assert.equal(
      await editor().getByLabel("요청 내용·메모", { exact: true }).inputValue(),
      prepared.request.task.notes,
    );
    assert.equal(
      await editor().getByLabel("최종 내용 확인 담당자", { exact: true }).inputValue(),
      prepared.request.task.owners.review,
    );
    assert.equal(
      await editor().getByRole("button", { name: "업무 저장", exact: true }).isDisabled(),
      false,
    );
    assert.equal(
      await item().getByRole("heading", { name: originalTask.title, exact: true }).count(),
      1,
    );
    assert.deepEqual(company, original);
  }
  assert.equal(commands.length, 2);
  record(
    "other notes and owner are rejected before company acceptance or success; original raw title, multiline notes, owner names and processing/reference selections remain",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await editor().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await editor().screenshot({ path: path.join(output, "workflow-task-receipt-mobile.png") });
  patchMode = "exact";
  await editor().getByRole("button", { name: "업무 저장", exact: true }).click();
  await item()
    .getByRole("heading", { name: prepared.request.task.title.trim(), exact: true })
    .waitFor();
  assert.deepEqual(commands[1], commands[0]);
  assert.deepEqual(commands[2], commands[0]);
  assert.deepEqual(company.tasks[0], original.tasks[0]);
  assert.deepEqual(company.tasks.at(-1).agencyOrigin, originalTask.agencyOrigin);
  page.once("dialog", (dialog) => dialog.accept());
  await editor().getByRole("button", { name: "업무 편집 취소", exact: true }).click();
  await editor().waitFor({ state: "hidden" });
  record(
    "exact canonical edit is accepted while retaining the original agency request and other task; cancelling the remaining local editor does not undo the saved edit",
  );
  await page
    .getByText("저장했습니다.", { exact: true })
    .waitFor({ state: "hidden", timeout: 15000 });
  const complete = () =>
    item().getByRole("button", {
      name: prepared.request.task.title.trim() + " 완료 처리",
      exact: true,
    });
  patchMode = "status";
  await complete().click();
  await page.getByText(errorText, { exact: true }).first().waitFor();
  assert.equal(await complete().count(), 1);
  assert.equal(await page.getByText("저장했습니다.", { exact: true }).count(), 0);
  assert.equal(company.tasks.at(-1).status, "pending");
  patchMode = "exact";
  await complete().click();
  await item()
    .getByRole("button", { name: prepared.request.task.title.trim() + " 다시 진행", exact: true })
    .waitFor();
  assert.deepEqual(commands[4], commands[3]);
  assert.equal(commands.length, 5);
  assert.equal(caseReads, 1);
  assert.equal(company.tasks.at(-1).status, "done");
  for (const key of Object.keys(original).filter((key) => !["tasks", "revision"].includes(key)))
    assert.deepEqual(company[key], original[key]);
  assert.deepEqual(company.tasks.slice(0, -1), original.tasks.slice(0, -1));
  record(
    "unchanged completion response is rejected; only explicit exact completion updates the task while manuscripts, original agency records and official progress stage remain unchanged",
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

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "task edits and completion responses are synthetic memory only; existing explicit save actions, no automatic retry or real API, SQL or institution execution",
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
