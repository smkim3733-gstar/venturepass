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
const scenario = "refresh-order";

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
  "scripts/refresh-order-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-refresh-order-ui-"));
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
let listReads=0,statusReads=0,caseReads=0,intakeReads=0;
let phase="initial-0";
const counts={},pending=[],explicitReads=[];
const connection=(connected)=>({aiConfigured:connected,model:"synthetic-disabled",storage:"local",supportedFiles:[".pdf",".txt"]});
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
        if (u.pathname === "/api/studio/status" || u.pathname === "/api/studio/cases") {
          const endpoint=u.pathname.endsWith("/status")?"status":"list";
          if(endpoint==="status")statusReads++;else listReads++;
          const counter=phase+":"+endpoint;counts[counter]=(counts[counter]??0)+1;
          if(phase.startsWith("initial"))return reply(endpoint==="status"?connection(false):{});
          if(phase==="recovery")return reply(endpoint==="status"?connection(false):{cases:[prepared.response.cases[1]]});
          const key=counter+":"+counts[counter];
          return await new Promise((resolve,reject)=>{
            const entry={key,phase,endpoint,attempt:counts[counter],released:false,complete:async(body,status=200)=>{
              entry.released=true;
              try {await route.fulfill({status,contentType:"application/json",headers:{"x-synthetic-read":key},body:JSON.stringify(body)});resolve();}
              catch(error){reject(error);throw error;}
            }};
            pending.push(entry);
          });
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

  const invalidMessage="기업 목록의 형식을 확인하지 못했습니다. 다시 불러와 주세요.";
  const retry=()=>page.getByRole("button",{name:"다시 불러오기",exact:true});
  const errorView=page.getByRole("heading",{name:"기업 목록을 확인하지 못했습니다",exact:true});
  const card=(index)=>page.getByRole("button").filter({hasText:companies[index].profile.companyName});
  const waitPending=async(attempt)=>{
    const deadline=Date.now()+5000;
    while(pending.filter(p=>p.phase===phase&&p.attempt===attempt).length!==2){if(Date.now()>deadline)throw Error("Missing paired pending reads");await new Promise(r=>setTimeout(r,20));}
  };
  const release=async(attempt,outcome)=>{
    const entries=pending.filter(p=>p.phase===phase&&p.attempt===attempt);assert.equal(entries.length,2);
    const responses=entries.map(e=>page.waitForResponse(r=>r.headers()["x-synthetic-read"]===e.key));
    await Promise.all(entries.map(e=>e.complete(e.endpoint==="status"?(outcome==="failure"?{error:"합성 마지막 조회 실패"}:connection(outcome==="latest")):{cases:outcome==="older"?[prepared.response.cases[0]]:prepared.response.cases},e.endpoint==="status"&&outcome==="failure"?500:200)));
    for(const response of await Promise.all(responses))await response.finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  const settings=async(expected)=>{
    await page.getByRole("button",{name:"설정",exact:true}).click();
    await page.getByRole("dialog").getByText(expected,{exact:true}).waitFor();
    await page.keyboard.press("Escape");await page.getByRole("dialog").waitFor({state:"hidden"});
  };
  const latest=async()=>{await card(0).waitFor();await card(1).waitFor();assert.equal(await retry().count(),0);await settings("AI 서비스가 연결되어 있습니다.");};
  const begin=async(wave)=>{
    phase="initial-"+wave;
    if(wave===0)await page.goto(origin+"/studio",{waitUntil:"networkidle",timeout:60000});else await page.reload({waitUntil:"networkidle"});
    await errorView.waitFor();await page.getByText(invalidMessage,{exact:true}).waitFor();
    phase="race-"+wave;
    await retry().click();explicitReads.push(phase+":1");await waitPending(1);
    await retry().click();explicitReads.push(phase+":2");await waitPending(2);
  };
  await begin(0);await release(2,"latest");await latest();await release(1,"older");await latest();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(output,"refresh-latest-success-mobile.png"),fullPage:true});
  record("a delayed earlier success cannot replace the newer two-company list or connected status after two explicit refresh requests");
  await begin(1);await release(2,"latest");await latest();await release(1,"failure");await latest();
  record("a delayed earlier HTTP failure cannot clear the newer connection state or restore an obsolete retry error");
  await begin(2);await release(1,"older");
  assert.equal(await errorView.isVisible(),true);assert.equal(await card(0).count(),0);assert.equal(await card(1).count(),0);
  await settings("AI 연결 상태를 확인하지 못했습니다.");
  await release(2,"failure");await page.getByText("합성 마지막 조회 실패",{exact:true}).waitFor();await errorView.waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(output,"refresh-latest-failure-mobile.png"),fullPage:true});
  phase="recovery";
  const recovery=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/studio/cases");await retry().click();explicitReads.push("recovery");await recovery;
  await card(1).waitFor();assert.equal(await card(0).count(),0);assert.equal(await retry().count(),0);
  await settings("AI 서비스를 아직 연결하지 않았습니다.");
  const initialReads=[0,1,2].map(i=>counts["initial-"+i+":list"]);
  assert.equal(explicitReads.length,7);assert.equal(listReads,initialReads.reduce((a,b)=>a+b,0)+7);assert.equal(statusReads,listReads);
  for(let i=0;i<3;i++){assert.equal(counts["race-"+i+":status"],2);assert.equal(counts["race-"+i+":list"],2);}
  assert.equal(caseReads,0);assert.equal(intakeReads,0);assert.ok(pending.every(p=>p.released));assert.deepEqual(companies,original);
  record("an earlier success is ignored while the newer request is pending; the newest failure stays retryable and one explicit retry accepts its own disconnected one-company result");
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
        explicitListRetries: explicitReads,
        responseOrder: pending.map(({key,released})=>({key,released})),
        phaseCounts:counts,
        writes: 0,
        automaticRetry: 0,
        continuousJourneys: 1,
        scenario,
        startingState:
          "Synthetic controlled response ordering for explicit paired status/list reads only; no actual status/list route, SQL, key or customer data read",
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
  for(const entry of pending)if(!entry.released)await entry.complete({error:"합성 검증 종료"},503).catch(()=>{});
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
