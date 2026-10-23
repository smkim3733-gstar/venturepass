import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { request as httpRequest } from "node:http";
import { prepareLocalBuild, localBuildEnvironment } from "./build-local.mjs";

// Only the unsynced, allowlisted copy gets an in-memory approval fixture. The real
// HTTP route/stream adapter is used; no operational runtime, key or data is acquired.
const reservationsOnly = process.argv[2] === "reservations";
const bookingOnly = process.argv[2] === "booking";
const cancellationOnly = process.argv[2] === "cancellation";
const inputOnly = process.argv[2] === "input-preparation";
const { staging, nextCli } = await prepareLocalBuild();
const output = await mkdtemp(
  join(
    tmpdir(),
    reservationsOnly ? "venturepass-reservations-http-" : "venturepass-execution-http-",
  ),
);
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const companyId = "16a6a2ec-90d5-4400-b139-ec04bb8f91bb",
  runId = "98d05f74-8527-4789-831c-6611e73bc9cc";
const endpoint = `/api/studio/cases/${companyId}/public-claim-comparison/${inputOnly ? "input-preparation" : cancellationOnly ? "cancellation" : bookingOnly ? "booking" : reservationsOnly ? "reservations" : "execution"}`;
const fixtureModule = join(
  staging,
  inputOnly
    ? "src/lib/studio-comparison-input-open.ts"
    : cancellationOnly
      ? "src/lib/studio-comparison-cancellation-open.ts"
      : bookingOnly
        ? "src/lib/studio-comparison-booking-open.ts"
        : reservationsOnly
          ? "src/lib/studio-comparison-reservations-open.ts"
          : "src/lib/studio-comparison-execution-open.ts",
);
await writeFile(
  fixtureModule,
  inputOnly
    ? `
import {createHash} from "node:crypto";
let opened=0;
export function openConfiguredInputPreparation(selection:any){
 const first=++opened===1;let closes=0,closed=false;
 process.stdout.write("SYNTHETIC_INPUT_OPEN\\n");
 return {
 prepare(){process.stdout.write("SYNTHETIC_INPUT_PREPARE\\n");},
 close(){process.stdout.write("SYNTHETIC_INPUT_CLOSE\\n");closed=!first || ++closes>2;return {closed};},
 download(){
 if(!closed)throw Error("cleanup incomplete");process.stdout.write("SYNTHETIC_INPUT_DOWNLOAD\\n");
 const content=JSON.stringify({inputVersion:1,databaseInstanceId:selection.companyId,settings:{...selection,basis:{provenance:"official-reviewed"},usagePolicy:{provenance:"official-reviewed"}}});
 return {...selection,kind:"comparison-input-download",inspectedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),
 reviewDigest:"a".repeat(64),model:"synthetic-model",content,sha256:createHash("sha256").update(content).digest("hex"),transmissionAllowed:false,consentRecorded:false,runtimeObserved:false};
 }};
}
`
    : cancellationOnly
      ? `
export function openConfiguredCancellation(selection: any) {
 process.stdout.write("SYNTHETIC_CANCELLATION_OPEN\\n");
 let phase="unused", closes=0,receipt=null; const hash="a".repeat(64);
 const inspect=()=>({status:phase,revoked:false,retained:phase!=="closed",clientRequestId:receipt?.clientRequestId??null,receipt,transmissionAllowed:false,runtimeObserved:false});
 return {inspect,revoke(){},review(){phase="review";process.stdout.write("SYNTHETIC_CANCELLATION_REVIEW\\n");
  return {...selection,reviewDigest:hash,reservationCompanyRevision:2,model:"synthetic-model",sectionTitle:"Synthetic selected section",currency:"USD",unitScale:6,releasedUnits:"1250",inspectedAt:"2026-10-14T09:40:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z",notice:"Synthetic cancellation only"};
 },cancel(){if(!receipt){process.stdout.write("SYNTHETIC_CANCELLATION_CANCEL\\n");receipt={...selection,clientRequestId:"923a7089-df07-44d7-8211-12871621d934",reviewDigest:hash,commandDigest:hash,recordDigest:hash,recordedAt:"2026-10-14T09:40:00.000Z",currency:"USD",unitScale:6,releasedUnits:"1250",cancelled:true,finalized:true,transmissionAllowed:false,refundVerified:false};}phase="recorded";return inspect();},
 recover(){process.stdout.write("SYNTHETIC_CANCELLATION_RECOVER\\n");return inspect();},
 close(){process.stdout.write("SYNTHETIC_CANCELLATION_CLOSE\\n");phase=++closes===1?"draining":"closed";return inspect();}
 };
}
`
      : bookingOnly
        ? `
export function openConfiguredBooking(selection: any) {
 process.stdout.write("SYNTHETIC_BOOKING_OPEN\\n");
 let phase="unused", closes=0,receipt=null; const hash="a".repeat(64);
 const inspect=()=>({source:"comparison-reservation-booking",status:phase,revoked:false,retained:phase!=="closed",clientRequestId:receipt?.clientRequestId??null,runId:receipt?.runId??null,receipt,transmissionAllowed:false,runtimeObserved:false});
 return {inspect,revoke(){},review(){phase="review";process.stdout.write("SYNTHETIC_BOOKING_REVIEW\\n");
  return {reviewDigest:hash,inspectedAt:"2026-10-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z",companyId:selection.companyId,companyRevision:selection.companyRevision,
   request:{requestVersion:"public-claim-comparison-request-v1",model:"synthetic-model",selection},
   identity:{requestVersion:"public-claim-comparison-request-v1",commandDigest:hash,preparationDigest:hash,contractDigest:hash,requestDigest:hash,rawBodySha256:hash,requestCharacters:1,requestUtf8Bytes:1},
   budget:{currency:"USD",unitScale:6,availableUnits:"100000",heldUnits:"0"},
   financialBasis:{costs:{currency:"USD",unitScale:6,reservedUnits:"1250",inputUnits:"1000",outputUnits:"250"},evidence:{sources:[{title:"Synthetic policy",url:"https://example.invalid/policy",excerpt:"Synthetic only",reviewedAt:"2026-10-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"}]}},
   retentionNotice:{localNotice:"Synthetic local retention",providerNotice:"Synthetic provider retention"},notice:{text:"Synthetic review only"}};
 },reserve(){if(!receipt){process.stdout.write("SYNTHETIC_BOOKING_RESERVE\\n");receipt={kind:"comparison-reservation-receipt",companyId:selection.companyId,companyRevision:selection.companyRevision,clientRequestId:"923a7089-df07-44d7-8211-12871621d934",runId:${JSON.stringify(runId)},reviewDigest:hash,commandDigest:hash,recordDigest:hash,recordedAt:"2026-10-14T09:00:00.000Z",acknowledgedReservationOnly:true,transmissionAllowed:false,transmissionConsentRecorded:false,runtimeObserved:false};}phase="recorded";return inspect();},
 recover(){process.stdout.write("SYNTHETIC_BOOKING_RECOVER\\n");return inspect();},
 close(){process.stdout.write("SYNTHETIC_BOOKING_CLOSE\\n");phase=++closes===1?"draining":"closed";return inspect();}
 };
}
`
        : reservationsOnly
          ? `
let opened = 0;
export function openConfiguredReservations(companyId: string, companyRevision: number) {
 if (companyId !== ${JSON.stringify(companyId)} || companyRevision !== 3) throw Error("synthetic selection");
 const first = ++opened === 1; let closes = 0;
 process.stdout.write("SYNTHETIC_CATALOG_OPEN\\n");
 return {
  list() { process.stdout.write("SYNTHETIC_CATALOG_LIST\\n"); return {kind:"comparison-reservation-view",companyId,companyRevision,
   inspectedAt:"2026-10-14T08:00:00.000Z",input:{status:"not-configured",runId:null},reservations:[{
    runId:${JSON.stringify(runId)},companyRevision:2,companyRevisionMatches:false,createdAt:"2026-10-14T07:40:00.000Z",expiresAt:"2026-10-14T07:50:00.000Z",reservationExpired:true,model:"synthetic-model",sectionKey:"market",sectionTitle:"Synthetic history",currency:"USD",unitScale:6,reservedUnits:"1250",latestEventKind:"finalized",
    history:{reservation:{clientRequestId:companyId,commandDigest:"a".repeat(64),recordedAt:"2026-10-14T07:40:00.000Z"},cancellation:{clientRequestId:${JSON.stringify(runId)},commandDigest:"b".repeat(64),recordedAt:"2026-10-14T07:45:00.000Z",releasedUnits:"1250"},finalizedAt:"2026-10-14T07:45:00.000Z"}}],
   currentContextVerified:false,policiesVerified:false,transmissionAllowed:false,consentRecorded:false,runtimeObserved:false}; },
  close() {process.stdout.write("SYNTHETIC_CATALOG_CLOSE\\n");return {closed: !first || ++closes > 2};}
 };
}
`
          : `
// Validation copy only; no real input file, policy, storage or provider.
export async function openConfiguredComparison(companyId: string, companyRevision: number) {
  if (companyId !== ${JSON.stringify(companyId)} || companyRevision !== 3) throw Error("synthetic selection");
  process.stdout.write("SYNTHETIC_OPEN\\n");
  let phase = "unused", ended = false, closeCalls = 0;
  const inspect = () => ({ status: phase, reviewDigest: null, selection: null,
    runtime: { service: ended ? { execution: { phase: "captured", capturePersisted: true,
      cleanupRequired: false, networkSettled: true, sdkSettled: true, ioSettled: true } } : null } });
  return { runId: ${JSON.stringify(runId)}, approval: {
    inspect,
    preview() { phase="reviewed";process.stdout.write("SYNTHETIC_PREVIEW\\n");
      return { review: { runId:${JSON.stringify(runId)}, request:{selection:{companyId,companyRevision}}},
        reservation:{label:"synthetic-only"} }; },
    async execute() { process.stdout.write("SYNTHETIC_EXECUTE\\n");phase="running";
      await new Promise(resolve=>setTimeout(resolve,100));ended=true;phase="attempted";return {}; },
    previewPostcapture() { process.stdout.write("SYNTHETIC_POSTPREVIEW\\n"); },
    writePostcapture(operation: string, reviewDigest: string) { if (reviewDigest !== "a".repeat(64)) throw Error("review mismatch"); process.stdout.write("SYNTHETIC_POSTWRITE\\n"); },
    recoverPostcapture(operation: string) { if(operation !== "record-result") throw Error("operation mismatch"); process.stdout.write("SYNTHETIC_POSTRECOVER\\n"); },
    recover() { process.stdout.write("SYNTHETIC_RECOVER\\n");return {}; },
    close() { process.stdout.write("SYNTHETIC_CLOSE\\n");phase=++closeCalls===1?"draining":"closed";return inspect(); }
  } };
}
`,
);
const guard = join(output, "guard.mjs");
await writeFile(
  guard,
  String.raw`
import {registerHooks} from "node:module";
registerHooks({resolve(specifier,context,next){
 if(specifier==="node:sqlite"||specifier==="openai"||specifier.startsWith("openai/")){
   process.stderr.write("FORBIDDEN_RUNTIME_IMPORT\n");throw Error("Forbidden runtime import");
 } return next(specifier,context);
}});
globalThis.fetch=async input=>{
 const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);
 if(url.href==="https://registry.npmjs.org/-/package/next/dist-tags")return new Response(null,{status:503});
 process.stderr.write("FORBIDDEN_SERVER_FETCH\n");throw Error("External fetch forbidden");
};
`,
);
const env = localBuildEnvironment(output);
for (const key of Object.keys(env))
  if (/OPENAI|KOSIS|API_KEY|TOKEN|SECRET|^VENTUREPASS_/i.test(key)) delete env[key];
env.NODE_ENV = "development";
env.NODE_OPTIONS = `--import=${pathToFileURL(guard).href}`;
const child = spawn(
  process.execPath,
  [nextCli, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: staging,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "",
  exited = false;
child.stdout.on("data", (bytes) => {
  log += bytes;
});
child.stderr.on("data", (bytes) => {
  log += bytes;
});
const exit = new Promise((resolve) =>
  child.once("exit", () => {
    exited = true;
    resolve();
  }),
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function call(body, sessionId = runId, extra = {}, method = "POST", query = "") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      origin + endpoint + query,
      {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          ...(payload === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(payload)) }),
          ...(sessionId
            ? {
                [cancellationOnly
                  ? "x-venturepass-comparison-cancellation"
                  : bookingOnly
                    ? "x-venturepass-comparison-booking"
                    : "x-venturepass-comparison-session"]: sessionId,
              }
            : {}),
          ...extra,
        },
        timeout: 60000,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 256 * 1024) request.destroy(Error("response limit"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(Error("request timeout")));
    request.end(payload);
  });
}
let passed = false;
try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (exited || Date.now() > deadline) throw Error("isolated server not ready");
    const ready = await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) break;
    await delay(100);
  }
  if (inputOnly) {
    const selection = { companyId, companyRevision: 3, runId };
    assert.equal((await call({ ...selection, policy: {} })).status, 400);
    assert.equal((await call(selection, null, { origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await call("x".repeat(8193))).status, 413);
    assert.equal((await call(selection)).value.code, "CLEANUP_REQUIRED");
    assert.equal((await call(selection)).status, 409);
    assert.equal((await call({}, null, {}, "DELETE")).status, 413);
    assert.equal((await call(undefined, null, {}, "DELETE")).value.closed, true);
    const result = await call(selection);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.value.content).settings, {
      ...selection,
      basis: { provenance: "official-reviewed" },
      usagePolicy: { provenance: "official-reviewed" },
    });
    assert.equal(result.value.transmissionAllowed, false);
    for (const [event, count] of [
      ["OPEN", 2],
      ["PREPARE", 2],
      ["CLOSE", 4],
      ["DOWNLOAD", 1],
    ])
      assert.equal(log.split("SYNTHETIC_INPUT_" + event + "\n").length - 1, count, event);
  } else if (cancellationOnly) {
    const selection = { companyId, companyRevision: 3, runId };
    assert.equal((await call({ action: "inspect" })).status, 404);
    assert.equal((await call({ action: "open", selection, policy: {} })).status, 400);
    assert.equal(
      (await call({ action: "open", selection }, runId, { origin: "https://foreign.invalid" }))
        .status,
      403,
    );
    assert.equal((await call("x".repeat(8193))).status, 413);
    assert.equal((await call({ action: "open", selection })).status, 200);
    assert.equal((await call({ action: "open", selection })).status, 200);
    assert.equal((await call({ action: "review" })).value.review.releasedUnits, "1250");
    const consent = {
      reviewDigest: "a".repeat(64),
      cancelReservationAcknowledged: true,
      retainedEvidenceAcknowledged: true,
    };
    assert.equal(
      (
        await call({
          action: "cancel",
          consent: { ...consent, retainedEvidenceAcknowledged: false },
        })
      ).status,
      400,
    );
    assert.equal((await call({ action: "cancel", consent })).value.receipt.runId, runId);
    assert.equal((await call({ action: "cancel", consent })).value.receipt.refundVerified, false);
    assert.equal((await call({ action: "recover" })).value.receipt.runId, runId);
    assert.equal((await call({ action: "close" })).value.status, "draining");
    assert.equal((await call({ action: "close" })).value.status, "closed");
    assert.equal((await call({ action: "inspect" })).value.status, "closed");
    for (const [event, count] of [
      ["OPEN", 1],
      ["REVIEW", 1],
      ["CANCEL", 1],
      ["RECOVER", 1],
      ["CLOSE", 2],
    ])
      assert.equal(log.split("SYNTHETIC_CANCELLATION_" + event + "\n").length - 1, count, event);
  } else if (bookingOnly) {
    const selection = {
      companyId,
      companyRevision: 3,
      claimRecordId: companyId,
      claimVersion: 1,
      claimInputDigest: "a".repeat(64),
      sourceIds: [companyId],
    };
    assert.equal((await call({ action: "inspect" })).status, 404);
    assert.equal((await call({ action: "open", selection, policy: {} })).status, 400);
    assert.equal(
      (await call({ action: "open", selection }, runId, { origin: "https://foreign.invalid" }))
        .status,
      403,
    );
    assert.equal((await call("x".repeat(8193))).status, 413);
    assert.equal((await call({ action: "open", selection })).status, 200);
    assert.equal((await call({ action: "open", selection })).status, 200);
    assert.equal((await call({ action: "review" })).value.review.costs.reservedUnits, "1250");
    const consent = {
      reviewDigest: "a".repeat(64),
      comparisonPurposeAcknowledged: true,
      selectedContentRetentionAcknowledged: true,
      currentBudgetReservationAcknowledged: true,
      financialBasisNotTokenFitAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
    };
    assert.equal(
      (
        await call({
          action: "reserve",
          consent: { ...consent, noAutomaticRetryAcknowledged: false },
        })
      ).status,
      400,
    );
    assert.equal((await call({ action: "reserve", consent })).value.receipt.runId, runId);
    assert.equal((await call({ action: "reserve", consent })).value.receipt.runId, runId);
    assert.equal((await call({ action: "recover" })).value.receipt.runId, runId);
    assert.equal((await call({ action: "close" })).value.status, "draining");
    assert.equal((await call({ action: "close" })).value.status, "closed");
    assert.equal((await call({ action: "inspect" })).value.status, "closed");
    for (const [event, count] of [
      ["OPEN", 1],
      ["REVIEW", 1],
      ["RESERVE", 1],
      ["RECOVER", 1],
      ["CLOSE", 2],
    ])
      assert.equal(log.split("SYNTHETIC_BOOKING_" + event + "\n").length - 1, count, event);
  } else if (reservationsOnly) {
    const get = (query = "?revision=3", headers = {}) =>
      call(undefined, null, headers, "GET", query);
    assert.equal((await get("?revision=3&runId=" + runId)).status, 400);
    assert.equal((await get("?revision=3&revision=3")).status, 400);
    assert.equal((await get("?revision=3", { origin: "https://foreign.example" })).status, 403);
    assert.equal((await get()).value.code, "CLEANUP_REQUIRED");
    assert.equal((await get()).status, 409);
    assert.equal((await call({}, null, {}, "DELETE")).status, 400);
    assert.equal((await call(undefined, null, {}, "DELETE")).value.closed, true);
    const result = await get();
    assert.equal(result.status, 200);
    assert.equal(result.value.reservations.length, 1);
    assert.equal(result.value.reservations[0].history.cancellation.releasedUnits, "1250");
    assert.equal(result.value.transmissionAllowed, false);
    for (const [event, count] of [
      ["OPEN", 2],
      ["LIST", 2],
      ["CLOSE", 4],
    ])
      assert.equal(log.split(`SYNTHETIC_CATALOG_${event}\n`).length - 1, count, event);
  } else {
    assert.equal((await call({ action: "inspect" })).status, 404);
    const open = {
      action: "open",
      companyRevision: 3,
      clientRequestId: "923a7089-df07-44d7-8211-12871621d934",
    };
    assert.equal((await call({ ...open, basis: {} }, null)).status, 400);
    const registered = await call(open, null);
    assert.equal(registered.status, 200);
    const ticket = registered.value.sessionId;
    assert.ok(ticket);
    assert.deepEqual((await call(open, null)).value, registered.value);
    assert.equal((await call({ ...open, clientRequestId: runId }, null)).status, 409);
    assert.equal(
      (await call({ action: "inspect" }, ticket, { origin: "https://example.com" })).status,
      403,
    );
    assert.equal((await call("x".repeat(8193), ticket)).status, 413);
    assert.equal((await call({ action: "preview", policy: {} }, ticket)).status, 400);
    const preview = await call({ action: "preview" }, ticket);
    assert.equal(preview.status, 200);
    assert.equal(preview.value.prepared.reservation.label, "synthetic-only");
    const consent = {
      clientRequestId: "ef7f6e8c-d3e7-48cb-9828-626c2b2291b9",
      reviewDigest: "a".repeat(64),
      externalTransmissionAcknowledged: true,
      comparisonPurposeAcknowledged: true,
      singleCallAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
      unknownCostHoldAcknowledged: true,
      noResendAcknowledged: true,
      localRetentionAcknowledged: true,
    };
    assert.equal((await call({ action: "execute", consent }, ticket)).status, 202);
    let state;
    for (let i = 0; i < 50; i++) {
      state = await call({ action: "inspect" }, ticket);
      if (state.value.outcome === "returned") break;
      await delay(100);
    }
    assert.equal(state.value.outcome, "returned");
    assert.equal(state.value.runtimeObserved, false);
    assert.equal((await call({ action: "execute", consent }, ticket)).value.outcome, "returned");
    assert.equal((await call({ action: "recover" }, ticket)).status, 200);
    assert.equal(
      (await call({ action: "record-result", reviewDigest: "a".repeat(64), units: "0" }, ticket))
        .status,
      400,
    );
    assert.equal((await call({ action: "postcapture-preview" }, ticket)).status, 200);
    assert.equal(
      (await call({ action: "record-result", reviewDigest: "a".repeat(64) }, ticket)).status,
      200,
    );
    assert.equal(
      (await call({ action: "settle-finalize", reviewDigest: "a".repeat(64) }, ticket)).status,
      200,
    );
    assert.equal(
      (await call({ action: "recover-postcapture", operation: "record-result" }, ticket)).status,
      200,
    );
    assert.equal((await call({ action: "close" }, ticket)).value.code, "CLEANUP_REQUIRED");
    assert.equal((await call({ action: "close" }, ticket)).value.closed, true);
    assert.equal((await call({ action: "close" }, ticket)).value.closed, true);
    assert.equal((await call({ action: "execute", consent }, ticket)).value.code, "SESSION_CLOSED");
    for (const [event, count] of [
      ["OPEN", 1],
      ["PREVIEW", 1],
      ["EXECUTE", 1],
      ["RECOVER", 1],
      ["CLOSE", 2],
      ["POSTPREVIEW", 1],
      ["POSTWRITE", 2],
      ["POSTRECOVER", 1],
    ])
      assert.equal(log.split(`SYNTHETIC_${event}\n`).length - 1, count, event);
  }
  assert.ok(!/FORBIDDEN_|Unhandled|uncaught/i.test(log));
  passed = true;
} finally {
  if (!exited) child.kill();
  await Promise.race([
    exit,
    delay(10000).then(() => {
      if (!exited) throw Error("isolated server exit unconfirmed");
    }),
  ]);
  await writeFile(join(output, "server.log"), log);
  const files = await readdir(output),
    staged = await readdir(staging);
  assert.ok(!files.includes(".venture-pass-build-data"));
  assert.ok(
    !staged.some(
      (name) =>
        name.startsWith(".env") || name === ".venture-pass" || name === ".venture-pass-build-data",
    ),
  );
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        passed,
        reservationsOnly,
        bookingOnly,
        cancellationOnly,
        inputOnly,
        staging,
        exited,
        dataCreated: false,
        scope:
          "synthetic registered owner through actual Next HTTP; no SQL, SDK or external network",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, staging, output, exited }));
}
