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
const scenario = "profile-cancel";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/company-contacts.tsx",
  "src/components/studio/profile-editor.tsx",
  "scripts/fixtures/profile-receipt.ts",
  "scripts/profile-cancel-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-profile-cancel-ui-"));
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
  input: path.join(app, "scripts/fixtures/profile-receipt.ts"),
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
const prepared = await fixture.profileReceiptFixture();
const company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let previewReads = 0,
  intakeReads = 0,
  caseReads = 0;
let dialogAction = "dismiss";
let releaseSave;
const dialogs = [];
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
            aiConfigured: false,
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
        if (u.pathname === `/api/studio/cases/${company.id}/source-intakes`) {
          intakeReads++;
          return reply({ company, activeItemIds: [] });
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
        commands.push(req.postDataJSON());
        assert.equal(commands.length, 1, "Unexpected extra profile save");
        assert.deepEqual(commands[0], prepared.request);
        await new Promise((resolve) => {
          releaseSave = resolve;
        });
        return reply({ error: "합성 기업정보 저장 실패" }, 500);
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

  page.on("dialog", async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message(), action: dialogAction });
    if (dialogAction === "accept") await dialog.accept();
    else await dialog.dismiss();
  });
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({ hasText: name }).first().click();
  const readiness = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/preparation-automation"),
  );
  await page.getByRole("button", { name: "상세 도구", exact: true }).click();
  await readiness;
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  const fields = {
    companyName: "company-name",
    businessNumber: "business-number",
    industry: "industry",
    foundedOn: "founded-on",
    paidInCapital: "paid-in-capital",
    closingMonth: "closing-month",
    applicationDate: "application-date",
    applicationKind: "application-kind",
    technologySummary: "profile-technologySummary",
    patents: "profile-patents",
    customers: "profile-customers",
    team: "profile-team",
    financials: "profile-financials",
    developmentPlan: "profile-developmentPlan",
  };
  const input = (key) => page.locator("#" + fields[key]);
  const setProfile = async (profile) => {
    for (const key of Object.keys(fields)) {
      if (["closingMonth", "applicationKind"].includes(key))
        await input(key).selectOption(profile[key] ?? "");
      else await input(key).fill(profile[key] ?? "");
    }
  };
  const expectProfile = async (profile) => {
    for (const key of Object.keys(fields))
      assert.equal(await input(key).inputValue(), profile[key] ?? "", key);
  };
  const cancel = () => page.getByRole("button", { name: "기업정보 수정 취소", exact: true });
  const save = () => page.getByRole("button", { name: "기업정보 저장", exact: true });
  const contacts = page.getByRole("region", { name: "기업 연락처·신청 담당 역할", exact: true });
  const openContacts = () =>
    contacts.getByRole("button", { name: /연락 메모 새 버전 작성|연락처·담당 역할 기록/ });
  const expectGuard = (expected) =>
    page.waitForFunction((value) => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented === value;
    }, expected);
  const capture = async (name, target) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await target.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await target.screenshot({ path: path.join(output, name) });
  };
  await expectProfile(original.profile);
  await expectGuard(false);
  assert.equal(
    await cancel().count(),
    2,
    "Profile edits need cancel controls at both save locations",
  );
  assert.equal(await cancel().first().isDisabled(), true);
  await setProfile(prepared.request.profile);
  await expectGuard(true);
  assert.equal(await openContacts().isDisabled(), true);
  assert.equal(await cancel().first().isDisabled(), false);
  await cancel().first().click();
  assert.equal(dialogs.length, 1);
  await expectProfile(prepared.request.profile);
  await expectGuard(true);
  assert.equal(commands.length, 0);
  await capture("profile-cancel-fields-mobile.png", input("companyName").locator("../.."));
  await capture("profile-cancel-actions-mobile.png", cancel().last().locator(".."));
  dialogAction = "accept";
  await cancel().last().click();
  await expectGuard(false);
  await expectProfile(original.profile);
  assert.equal(await cancel().first().isDisabled(), true);
  assert.equal(await save().first().isDisabled(), true);
  assert.equal(await openContacts().isDisabled(), false);
  assert.equal(commands.length, 0);
  assert.deepEqual(company, original);
  record(
    "cancel dismissal retains every edited profile field; explicit acceptance restores loaded values and releases profile-only unsaved protection without a save request",
  );
  await openContacts().click();
  await expectGuard(true);
  await page.waitForFunction(() => document.querySelector("#company-name")?.matches(":disabled"));
  assert.equal(await save().first().isDisabled(), true);
  assert.equal(await cancel().first().isDisabled(), true);
  await expectProfile(original.profile);
  await contacts.getByRole("button", { name: "편집 취소", exact: true }).click();
  await expectGuard(false);
  await page.waitForFunction(() => document.querySelector("#company-name")?.matches(":enabled"));
  assert.equal(dialogs.length, 2);
  assert.equal(commands.length, 0);
  assert.deepEqual(company, original);
  record(
    "discarding profile edits enables contact notes; opening and closing an untouched contact editor preserves existing mutual edit protection without another confirmation or save",
  );
  await setProfile(prepared.request.profile);
  await expectGuard(true);
  const failed = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname.endsWith(company.id),
  );
  await save().first().click();
  const deadline = Date.now() + 5000;
  while (!releaseSave && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(releaseSave);
  await page.waitForFunction(() => document.querySelector("#company-name")?.matches(":disabled"));
  assert.equal(await cancel().first().isDisabled(), true);
  assert.equal(await cancel().last().isDisabled(), true);
  releaseSave();
  await failed;
  await page.getByText("합성 기업정보 저장 실패", { exact: true }).first().waitFor();
  await page.waitForFunction(() => document.querySelector("#company-name")?.matches(":enabled"));
  await expectProfile(prepared.request.profile);
  await expectGuard(true);
  assert.equal(await cancel().first().isDisabled(), false);
  await capture("profile-cancel-failure-mobile.png", cancel().first().locator(".."));
  await cancel().first().click();
  await expectGuard(false);
  await expectProfile(original.profile);
  assert.equal(await save().first().isDisabled(), true);
  assert.equal(await openContacts().isDisabled(), false);
  assert.equal(commands.length, 1);
  assert.deepEqual(company, original);
  assert.equal(caseReads, 1);
  assert.equal(intakeReads, 0);
  assert.equal(previewReads, 0);
  assert.equal(dialogs.length, 3);
  for (const d of dialogs)
    assert.equal(d.message, "기업정보 수정을 취소하고 화면에 불러온 내용으로 되돌릴까요?");
  record(
    "existing pending-save lock disables cancellation; synthetic HTTP failure preserves edits and explicit cancellation then restores loaded values without retry or company mutation",
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
        syntheticUploadPosts: 0,
        syntheticPatches: commands.length,
        commands,
        syntheticCompanyGets: caseReads,
        syntheticPreviewPosts: previewReads,
        syntheticIntakeGets: intakeReads,
        actualOcr: 0,
        originalReads: 0,

        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "Explicit profile reset, contact editor handoff and one held synthetic profile-save HTTP failure. No actual storage, SQL, AI or institution execution.",
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
  releaseSave?.();
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
