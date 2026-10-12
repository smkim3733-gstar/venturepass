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
const scenario = "manual-save-file-choice";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/studio-workspace.tsx",
  "src/components/studio/manual-source-response.ts",
  "src/components/studio/sources-panel.tsx",
  "scripts/fixtures/manual-source-receipt.ts",
  "scripts/manual-save-file-choice-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-manual-save-file-choice-ui-"));
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
  input: path.join(app, "scripts/fixtures/manual-source-receipt.ts"),
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
const prepared = await fixture.manualSourceFixture();
let company = prepared.company;
const original = structuredClone(company),
  name = company.profile.companyName,
  companies = [company];
let previewReads = 0, intakeReads = 0, caseReads = 0;
let dialogAction = "dismiss";
let phase = "new", patchMode = "exact";
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
        const command=req.postDataJSON();
        commands.push({phase,command:structuredClone(command)});
        assert.equal(command.action,"source");assert.equal(command.revision,company.revision);
        assert.ok(commands.length<=5,"Unexpected manual save");
        if(patchMode === "transport") return reply({error:"합성 직접 저장 응답 실패"},500);
        company=fixture.manualSourceResult(company,command.source);companies[0]=company;
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

  page.on("dialog", async (dialog) => {
    dialogs.push({type:dialog.type(),message:dialog.message(),action:dialogAction});
    if(dialogAction === "accept") await dialog.accept(); else await dialog.dismiss();
  });
  await page.goto(origin + "/studio", { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button").filter({hasText:name}).first().click();
  const readiness=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith("/preparation-automation"));
  await page.getByRole("button",{name:"상세 도구",exact:true}).click();
  await readiness;
  await page.waitForFunction(()=>document.querySelector("#studio-panel-profile input")?.matches(":enabled"));
  const intakeReady=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith("/source-intakes"));
  await page.getByRole("tab",{name:/자료/}).click();await intakeReady;
  await page.waitForFunction(()=>document.querySelector("#source-file")?.matches(":enabled"));
  const form=page.getByRole("region",{name:"자료 편집",exact:true});
  const open=()=>page.getByRole("button",{name:"텍스트 자료 추가",exact:true}).click();
  const file=page.locator("#source-file"), fileKind=page.locator("#file-kind"), originalOnly=page.locator("#source-original-only"), ai=page.locator("#source-allow-ai");
  const nameInput=()=>form.getByLabel("자료 제목",{exact:true}), textInput=()=>form.getByLabel("자료 내용",{exact:true}), kindInput=()=>form.getByLabel("분류",{exact:true});
  const save=()=>form.getByRole("button",{name:"자료 저장",exact:true}).click();
  const payload={name:"함께 선택한 합성 원본.png",mimeType:"image/png",buffer:Buffer.from([137,80,78,71,13,10,26,10,67,72,79,73,67,69])};
  const confirmText="선택한 파일은 업로드하지 않고, 저장이 완료되면 파일 선택을 해제합니다. 텍스트 자료만 저장할까요?";
  const selected=async()=>{
    const actual=await file.evaluate(async input=>{const f=input.files?.[0];return f?{name:f.name,type:f.type,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}:null;});
    assert.deepEqual(actual,{name:payload.name,type:payload.mimeType,bytes:Array.from(payload.buffer)});
    assert.equal(await fileKind.inputValue(),"finance");assert.equal(await originalOnly.isChecked(),true);assert.equal(await ai.isChecked(),false);assert.equal(await ai.isDisabled(),true);
  };
  const capture=async(name)=>{
    await page.setViewportSize({width:390,height:844});await form.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await form.screenshot({path:path.join(output,name)});
    await page.locator("#source-file").scrollIntoViewIfNeeded();
    await page.locator("#source-file").locator("..").screenshot({path:path.join(output,name.replace("draft","file"))});
  };
  const preserved=async(expected)=>{
    assert.equal(await nameInput().inputValue(),expected.name);assert.equal(await textInput().inputValue(),expected.text);assert.equal(await kindInput().inputValue(),expected.kind);
    await selected();assert.equal(await form.getByRole("button",{name:"자료 저장",exact:true}).isEnabled(),true);
  };
  const saveResponse=async()=>{
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/studio/cases/"+company.id&&r.request().method()==="PATCH");
    await save();return await response;
  };
  for(const [index,draft] of [
    {name:"  파일 선택과 함께 새 자료  ",kind:"patent",text:"  새 직접 입력 본문\n  파일은 아직 업로드하지 않았습니다.  "},
    {name:"  기존 자료의 수정본  ",kind:"consultation",text:"  기존 자료 수정 본문\n  선택 파일과 별개인 내용입니다.  "},
  ].entries()){
    phase=index===0?"new":"existing";
    const before=structuredClone(company),beforeCommands=commands.length,beforeDialogs=dialogs.length;
    if(index===0)await open();else await page.getByRole("button",{name:"기존 자료 수정",exact:true}).click();
    await nameInput().fill(draft.name);await kindInput().selectOption(draft.kind);await textInput().fill(draft.text);
    await originalOnly.check();await fileKind.selectOption("finance");await file.setInputFiles(payload);await selected();
    dialogAction="dismiss";await save();
    assert.equal(dialogs.length,beforeDialogs+1,"manual save with pending file must ask before sending");
    assert.equal(dialogs.at(-1).message,confirmText);assert.equal(commands.length,beforeCommands);assert.deepEqual(company,before);await preserved(draft);
    patchMode="transport";dialogAction="accept";
    assert.equal((await saveResponse()).status(),500);
    await page.getByText("합성 직접 저장 응답 실패",{exact:true}).first().waitFor();
    await page.waitForFunction(()=>document.querySelector("#source-file")?.matches(":enabled"));
    assert.equal(commands.length,beforeCommands+1);assert.deepEqual(company,before);await preserved(draft);
    await capture("manual-save-"+phase+"-draft-mobile.png");
    patchMode="exact";assert.equal((await saveResponse()).status(),200);await form.waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.querySelector("#source-file")?.matches(":enabled"));
    assert.equal(dialogs.length,beforeDialogs+3);assert.equal(commands.length,beforeCommands+2);
    assert.deepEqual(commands[beforeCommands].command,commands[beforeCommands+1].command);
    const sent=commands.at(-1).command.source;
    assert.equal(sent.name,draft.name.trim());assert.equal(sent.kind,draft.kind);assert.equal(sent.text,draft.text);
    assert.equal(await file.evaluate(input=>input.files.length),0);assert.equal(await file.inputValue(),"");
    assert.equal(await page.getByRole("button",{name:"자료 업로드",exact:true}).isDisabled(),true);
    const saved=company.sources.find(source=>source.id===sent.id);assert.ok(saved);assert.equal(saved.text,draft.text);
    await page.getByRole("button",{name:saved.name+" 수정",exact:true}).waitFor();
    const {sources:oldSources,revision:oldRevision,updatedAt:oldUpdated,analysis:oldAnalysis,selectedCandidateId:oldCandidate,plans:oldPlans,...oldRest}=before;
    const {sources:newSources,revision:newRevision,updatedAt:newUpdated,analysis:newAnalysis,selectedCandidateId:newCandidate,plans:newPlans,...newRest}=company;
    assert.deepEqual(oldRest,newRest);assert.equal(newRevision,oldRevision+1);assert.notEqual(newUpdated,oldUpdated);assert.equal(newAnalysis,null);assert.equal(newCandidate,null);
    assert.deepEqual(newPlans,oldPlans.map(plan=>({...plan,confirmedAt:null})));
    assert.deepEqual(newSources.filter(source=>source.id!==sent.id),oldSources.filter(source=>source.id!==sent.id));
    assert.equal(newSources.length,oldSources.length+(index===0?1:0));
    void oldAnalysis;void oldCandidate;
    record(phase+" manual source save asks before discarding pending file selection; cancellation sends nothing, failure preserves draft/file/options, explicit retry saves text only");
  }
  const beforeNoFile=structuredClone(company),dialogCount=dialogs.length;
  phase="without-file";await page.getByRole("button",{name:"기존 자료의 수정본 수정",exact:true}).click();
  const finalText="  파일 선택 없는 마지막 수정\n  직접 입력 원문을 보존합니다.  ";await textInput().fill(finalText);
  assert.equal((await saveResponse()).status(),200);await form.waitFor({state:"hidden"});assert.equal(dialogs.length,dialogCount);assert.equal(commands.length,5);
  const finalId=commands.at(-1).command.source.id;
  assert.equal(company.sources.find(source=>source.id===finalId).text,finalText);
  assert.deepEqual(company.sources.filter(source=>source.id!==finalId),beforeNoFile.sources.filter(source=>source.id!==finalId));
  await page.getByRole("tab",{name:/기업정보/}).click();
  const intakeAgain=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith("/source-intakes"));
  await page.getByRole("tab",{name:/자료/}).click();await intakeAgain;
  await page.getByRole("button",{name:"기존 자료의 수정본 수정",exact:true}).waitFor();
  await page.getByRole("button",{name:"파일 선택과 함께 새 자료 수정",exact:true}).waitFor();
  assert.equal(await form.count(),0);assert.equal(company.sources.length,3);assert.deepEqual(company.sources[0],original.sources[0]);assert.equal(caseReads,1);assert.equal(previewReads,0);
  assert.deepEqual(dialogs.map(d=>d.action),["dismiss","accept","accept","dismiss","accept","accept"]);
  assert.ok(dialogs.every(d=>d.type==="confirm"&&d.message===confirmText));
  record("without a pending file the existing save has no extra prompt; two manual sources remain after tab round trip with no upload, OCR or automatic retry");
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
          "Synthetic manual saves with pending in-memory file selection and two HTTP failures. No upload/extraction/OCR/SQL/AI/institution execution; browser payload, not native OS picker.",
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
