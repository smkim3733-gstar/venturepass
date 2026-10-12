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
const scenario = "studio-status";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/company-list-response.ts",
  "src/components/studio/studio-status-response.ts",
  "scripts/fixtures/company-list.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const validatorProvenance = {
  currentSha: sha(await readFile(fileURLToPath(import.meta.url))),
  preparedSha: sha(await readFile(path.join(staging, "scripts/studio-status-validation.mjs"))),
};
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-studio-status-ui-"));
await writeFile(path.join(output,"validator-used.mjs"), await readFile(fileURLToPath(import.meta.url)));
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
  input: path.join(app, "scripts/fixtures/company-list.ts"),
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
const prepared = await fixture.companyListFixture();
const companies = prepared.companies;
const original = structuredClone(companies);
let statusMode = "string",
  listReads = 0,
  statusReads = 0,
  caseReads = 0,
  intakeReads = 0;
let readPhase = "initial";
const listReadPhases = [], statusReadPhases = [], explicitReads = [];
const network = [],
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
        if (u.pathname === "/api/studio/status") {
          statusReads++;
          statusReadPhases.push(readPhase);
          if (statusMode === "http") return reply({error:"합성 연결 상태 불러오기 실패"},500);
          if (statusMode === "missing") return reply({});
          const body={aiConfigured:statusMode === "connected", model:"synthetic-disabled", storage:"local", supportedFiles:[".pdf",".txt"]};
          if(statusMode === "string") body.aiConfigured="false";
          if(statusMode === "files") body.supportedFiles=".pdf";
          if(statusMode === "storage") body.storage="cloud";
          return reply(body);
        }
        if (u.pathname === "/api/studio/cases") {
          listReads++;
          listReadPhases.push(readPhase);
          return reply(prepared.response);
        }
        const found = companies.find((c) => u.pathname === `/api/studio/cases/${c.id}`);
        if (found) {
          caseReads++;
          return reply(found);
        }
        for (const c of companies) {
          if (u.pathname === `/api/studio/cases/${c.id}/guided-preparation`)
            return reply({ company: c, active: false, aiConfigured: false, approval: null });
          if (u.pathname === `/api/studio/cases/${c.id}/preparation-automation`)
            return reply({ company: c, active: false });
          if (u.pathname === `/api/studio/cases/${c.id}/source-intakes`) {
            intakeReads++;
            return reply({ company: c, activeItemIds: [] });
          }
        }
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

  const invalidMessage="AI 연결 및 지원 형식 상태를 확인하지 못했습니다. 다시 불러와 주세요.";
  const settings=page.getByRole("dialog",{name:"AI 연결과 자료 보관",exact:true});
  const retry=()=>page.getByRole("button",{name:"다시 불러오기",exact:true});
  const showSettings=async()=>{
    await page.getByRole("button",{name:"설정",exact:true}).click();
    await settings.waitFor();
  };
  const checkUnknown=async()=>{
    await showSettings();
    await settings.getByText("AI 연결 상태를 확인하지 못했습니다.",{exact:true}).waitFor();
    assert.equal(await settings.getByText("AI 서비스가 연결되어 있습니다.",{exact:true}).count(),0);
    assert.equal(await settings.getByText("AI 서비스를 아직 연결하지 않았습니다.",{exact:true}).count(),0);
  };
  await page.goto(origin+"/studio",{waitUntil:"networkidle",timeout:60000});
  await checkUnknown();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await settings.screenshot({path:path.join(output,"studio-status-unknown-mobile.png")});
  await page.keyboard.press("Escape");
  await page.getByText(invalidMessage,{exact:true}).waitFor();
  for(const mode of ["files","missing","storage","http"]){
    statusMode=mode;explicitReads.push(mode);readPhase="retry-"+mode;
    await retry().click();
    await page.getByText(mode==="http"?"합성 연결 상태 불러오기 실패":invalidMessage,{exact:true}).waitFor();
    await checkUnknown();
    await page.keyboard.press("Escape");
    assert.deepEqual(companies,original);
  }
  record("malformed string flag, format list, missing fields, other storage and HTTP failure stay unverified with explicit retry");
  const modeDialog=page.getByRole("dialog",{name:"아이템 분석 방식 선택",exact:true});
  const aiChoice=()=>modeDialog.getByRole("button").filter({hasText:"AI 분석·자동 작성"});
  const submit=()=>modeDialog.getByRole("button",{name:"선택한 방식으로 분석",exact:true});
  const openDetails=async()=>{
    await page.getByRole("button").filter({hasText:companies[0].profile.companyName}).first().click();
    await page.getByRole("heading",{name:companies[0].profile.companyName,exact:true}).waitFor();
    const preparationResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/studio/cases/${companies[0].id}/preparation-automation` && response.request().method()==="GET");
    await page.getByRole("button",{name:"상세 도구",exact:true}).click();
    await preparationResponse;
    await page.waitForFunction(()=>document.querySelector("#studio-panel-profile input")?.matches(":enabled"));
    await page.getByRole("tab",{name:/아이템 분석/}).click();
    await page.waitForFunction(()=>document.getElementById("studio-tab-analysis")?.getAttribute("aria-selected")==="true");
    await page.getByRole("button",{name:/^(자료 다시 분석|아이템 분석 시작)$/}).click();
    await modeDialog.waitFor();
  };
  const sourceOptions=async(connected)=>{
    const intakeResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/studio/cases/${companies[0].id}/source-intakes` && response.request().method()==="GET");
    await page.getByRole("tab",{name:/자료함/}).click();
    await intakeResponse;
    await page.waitForFunction(()=>document.querySelector("#source-file")?.matches(":enabled"));
    assert.equal(await page.locator("#source-file").getAttribute("accept"),".pdf,.txt");
    assert.equal(await page.locator("#source-allow-ai").isDisabled(),!connected);
    assert.equal(await page.locator("#source-allow-ai").isChecked(),false);
  };
  statusMode="disconnected";explicitReads.push(statusMode);readPhase="retry-disconnected";
  await retry().click();
  await page.getByRole("heading",{name:"준비 중인 회사",exact:true}).waitFor();
  await showSettings();
  await settings.getByText("AI 서비스를 아직 연결하지 않았습니다.",{exact:true}).waitFor();
  await page.keyboard.press("Escape");
  await openDetails();
  assert.equal(await aiChoice().isDisabled(),true);
  assert.equal(await submit().isDisabled(),true);
  await modeDialog.getByRole("button").filter({hasText:"자료 기반 정리본"}).click();
  assert.equal(await submit().isDisabled(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await modeDialog.screenshot({path:path.join(output,"studio-status-disconnected-mobile.png")});
  await page.keyboard.press("Escape");
  await sourceOptions(false);
  record("valid explicit false keeps AI disabled, assisted mode selectable and supported format hints usable without running analysis");
  statusMode="connected";
  readPhase="reload";
  await page.reload({waitUntil:"networkidle"});
  await showSettings();
  await settings.getByText("AI 서비스가 연결되어 있습니다.",{exact:true}).waitFor();
  await page.keyboard.press("Escape");
  await openDetails();
  assert.equal(await aiChoice().isDisabled(),false);
  await aiChoice().click();
  assert.equal(await submit().isDisabled(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await modeDialog.screenshot({path:path.join(output,"studio-status-connected-mobile.png")});
  await page.keyboard.press("Escape");
  await sourceOptions(true);
  assert.deepEqual(companies,original);
  assert.equal(caseReads,2);
  const initialReads=["initial","reload"].map(phase=>listReadPhases.filter(value=>value===phase).length);
  for(const mode of explicitReads) assert.equal(listReadPhases.filter(value=>value==="retry-"+mode).length,1);
  assert.deepEqual(statusReadPhases,listReadPhases);
  assert.equal(listReads,initialReads.reduce((a,b)=>a+b,0)+5);
  assert.equal(statusReads,listReads);
  record("valid true enables existing AI choices without consent or execution; same synthetic companies and all data stay unchanged");
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
        syntheticPatches: 0,
        syntheticCompanyGets: caseReads,
        syntheticListGets: listReads,
        syntheticStatusGets: statusReads,
        syntheticIntakeGets: intakeReads,
        initialEffectListGets: initialReads,
        listReadPhases,
        statusReadPhases,
        explicitStatusRetries: explicitReads,
        writes: 0,
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        validatorProvenance,
        startingState:
          "Status flags and companies are synthetic memory only; no actual connection check, key read, generation, upload, SQL or external execution",
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
  console.log(JSON.stringify({ output, checks: checks.length, syntheticListGets: listReads }));
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
