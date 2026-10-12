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
const scenario = "company-list-visibility";

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
  "scripts/fixtures/company-list-visibility.ts",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const validatorProvenance = {
  currentSha: sha(await readFile(fileURLToPath(import.meta.url))),
  preparedSha: sha(await readFile(path.join(staging, "scripts/company-list-visibility-validation.mjs"))),
};
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-company-list-visibility-ui-"));
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
  input: path.join(app, "scripts/fixtures/company-list-visibility.ts"),
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
const prepared = await fixture.companyListVisibilityFixture();
const companies = prepared.companies;
const original = structuredClone(companies);
let listMode="both", listReads=0, statusReads=0, caseReads=0, intakeReads=0;
const listReadPhases=[];
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
          return reply({aiConfigured:false,model:"synthetic-disabled",storage:"local",supportedFiles:[".pdf",".txt"]});
        }
        if (u.pathname === "/api/studio/cases") {
          listReads++;listReadPhases.push(listMode);
          return reply({cases:listMode==="both"?prepared.response.cases:prepared.response.cases.slice(0,1)});
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

  const first=companies[0].profile.companyName, second=companies[1].profile.companyName;
  const simpleList=()=>page.getByRole("region",{name:"준비 중인 회사",exact:true});
  const simpleCard=name=>simpleList().getByRole("button").filter({hasText:name});
  const detailedCard=name=>page.getByRole("button",{name,exact:true});
  const prepResponse=()=>page.waitForResponse(response=>new URL(response.url()).pathname===`/api/studio/cases/${companies[0].id}/preparation-automation` && response.request().method()==="GET");
  const profileReady=()=>page.waitForFunction(()=>document.querySelector("#studio-panel-profile input")?.matches(":enabled"));
  const showDetail=async()=>{
    const ready=prepResponse();
    await page.getByRole("button",{name:"상세 도구",exact:true}).click();
    await ready;await profileReady();
  };
  const openDetailed=async()=>{
    const ready=prepResponse();await detailedCard(first).click();await ready;await profileReady();
  };
  const returnSimple=async()=>{
    await page.getByRole("button",{name:"간단 화면",exact:true}).click();
    await page.getByRole("button",{name:"기업 목록",exact:true}).click();
    await simpleList().waitFor();
  };
  await page.goto(origin+"/studio",{waitUntil:"networkidle",timeout:60000});
  await simpleCard(first).waitFor();await simpleCard(second).waitFor();
  await simpleCard(first).click();await showDetail();
  await page.getByRole("button",{name:"전체 기업",exact:true}).click();
  await page.locator("#case-attention-filter").selectOption("overdue");
  await detailedCard(first).waitFor();
  assert.equal(await detailedCard(second).count(),0);
  await openDetailed();await returnSimple();
  await simpleCard(second).waitFor();
  assert.equal(await simpleList().getByRole("button").count(),2);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await simpleList().screenshot({path:path.join(output,"company-list-all-mobile.png")});
  record("guided list shows both companies despite retained detailed overdue filter; no company state or task date changes");

  const search=()=>page.getByRole("textbox",{name:"기업명 검색",exact:true});
  await search().fill("  찾을 수 없는 합성 이름  ");
  await page.getByText("이름에 맞는 회사를 찾지 못했습니다.",{exact:true}).waitFor();
  assert.equal(await simpleList().getByRole("button").count(),0);
  assert.equal(await search().inputValue(),"  찾을 수 없는 합성 이름  ");
  await search().fill(first);await simpleCard(first).waitFor();
  assert.equal(await simpleCard(second).count(),0);
  await simpleCard(first).click();await showDetail();
  await page.getByRole("button",{name:"전체 기업",exact:true}).click();
  assert.equal(await page.locator("#case-attention-filter").inputValue(),"overdue");
  assert.equal(await page.getByRole("textbox",{name:"기업 작업공간 검색",exact:true}).inputValue(),first);
  await page.getByRole("textbox",{name:"기업 작업공간 검색",exact:true}).fill("");
  assert.equal(await detailedCard(second).count(),0);
  await page.locator("#case-attention-filter").selectOption("all");
  await detailedCard(second).waitFor();
  record("guided name search and empty result stay editable; returning to detail preserves the chosen attention filter until explicitly cleared");

  listMode="one";
  await page.reload({waitUntil:"networkidle"});
  await simpleCard(first).waitFor();
  assert.equal(await simpleCard(second).count(),0);
  assert.equal(await search().count(),0);
  await simpleCard(first).click();await showDetail();
  await page.getByRole("button",{name:"전체 기업",exact:true}).click();
  await page.getByRole("textbox",{name:"기업 작업공간 검색",exact:true}).fill("  합성 기술  ");
  await openDetailed();await returnSimple();
  await search().waitFor();
  assert.equal(await search().inputValue(),"  합성 기술  ");
  await search().fill("없는 회사");
  await page.getByText("이름에 맞는 회사를 찾지 못했습니다.",{exact:true}).waitFor();
  assert.equal(await simpleList().getByRole("button").count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(output,"company-list-one-search-mobile.png"),fullPage:true});
  await search().fill("");
  await simpleCard(first).waitFor();
  assert.equal(await search().count(),0);
  assert.equal(await simpleList().getByRole("button").count(),1);
  assert.deepEqual(companies,original);
  assert.equal(caseReads,5);
  assert.equal(statusReads,listReads);
  assert.equal(intakeReads,0);
  record("single-company guided list retains a carried search so the user can change or clear it; empty search restores the company and minimal view");
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
        listReadPhases,
        explicitPageReloads: 1,
        writes: 0,
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        validatorProvenance,
        startingState:
          "Two synthetic companies; second list response intentionally contains one company while both memory records remain unchanged. No deletion, writer, AI or external execution.",
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
