import assert from "node:assert/strict";
import { tmpdir } from "node:os";
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
const temporaryRoot = await realpath(tmpdir());
const staging = await realpath(process.argv[2]);
const serverMode = process.argv[3] ?? "start";
const reservationsOnly = process.argv[4] === "reservations";
const bookingOnly = process.argv[4] === "booking";
const cancellationOnly = process.argv[4] === "cancellation";
const inputOnly = process.argv[4] === "input-preparation";

assert.ok(["start", "dev"].includes(serverMode));
const relative = path.relative(temporaryRoot, staging);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.match(path.basename(staging), /^venturepass-build-/);
assert.ok(!(await readdir(staging)).some((name) => name.startsWith(".env")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const file of [
  "src/components/studio/guided-workspace.tsx",
  "src/components/studio/claim-reviews.tsx",
  "src/components/studio/comparison-execution.tsx",
  "src/components/studio/comparison-reservations.tsx",
  "src/components/studio/comparison-input-preparation.tsx",
  "src/lib/studio-comparison-input-client.ts",
  "src/lib/studio-comparison-input-wire.ts",
  "src/components/studio/comparison-booking.tsx",
  "src/components/studio/comparison-booking-provider.tsx",
  "src/components/studio/comparison-cancellation.tsx",
  "src/components/studio/comparison-cancellation-provider.tsx",
  "src/lib/studio-comparison-cancellation-client.ts",
  "src/lib/studio-comparison-cancellation-wire.ts",
  "src/components/providers.tsx",
  "src/lib/studio-comparison-booking-client.ts",
  "src/lib/studio-comparison-booking-wire.ts",
  "src/lib/studio-comparison-reservations-client.ts",
  "src/lib/studio-comparison-reservations-wire.ts",
  "src/components/studio/public-claim-preview.tsx",
  "src/components/studio/comparison-execution-provider.tsx",
  "src/lib/studio-comparison-execution-client.ts",
  "src/lib/studio-comparison-review-http.ts",
  "src/lib/studio-comparison-review-catalog.ts",
  "scripts/fixtures/comparison-execution.ts",
  "scripts/comparison-execution-ui-validation.mjs",
])
  assert.equal(
    sha(await readFile(path.join(app, file))),
    sha(await readFile(path.join(staging, file))),
  );
const output = await mkdtemp(path.join(temporaryRoot, "venturepass-execution-ui-"));
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
async function listenSafe(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(20000 + Math.floor(Math.random() * 30000), "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw Error("No safe local port available");
}
await listenSafe(listener);
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
let origin;
const requireVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
const { rolldown } = await import(pathToFileURL(requireVitest.resolve("rolldown")).href);
const bundle = await rolldown({
  input: path.join(app, "scripts/fixtures/comparison-execution.ts"),
  cwd: app,
  platform: "browser",
  external: ["node:crypto"],
  tsconfig: path.join(app, "tsconfig.json"),
  plugins: [
    {
      name: "deny-fixture-activation",
      load(id) {
        if (id === "synthetic:server-only") return "export {};";
        if (id === "synthetic:vitest") return "export const vi={fn:value=>value};";
      },
      resolveId(source) {
        if (source === "server-only" || source === "vitest") return { id: "synthetic:" + source };
        if (
          source !== "node:crypto" &&
          source !== "./studio-engine-request-core" && // Inspected passive SHA/error primitives only.
          /openai|server-only|node:|storage|engine|provider-production|configuration-current/.test(
            source,
          )
        )
          throw Error("Forbidden fixture import: " + source);
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
const prepared = cancellationOnly
  ? fixture.comparisonCancellationFixture()
  : bookingOnly
    ? fixture.comparisonBookingFixture()
    : fixture.comparisonExecutionFixture();
const { company, session, status, preview } = prepared;
let cancellationCalls = [],
  cancelled = false,
  cancellationClose = 0;
let bookingMode = "missing",
  bookingCalls = [],
  bookingRecorded = false,
  bookingClose = 0;
async function assertPinnedReference(kind) {
  const receipt = kind === "booking" ? prepared.receipt : prepared.cancellationReceipt;
  const pending = JSON.parse(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      "venturepass.comparison-" + kind + ".v1",
    ),
  );
  assert.equal(pending.attempted, true);
  assert.deepEqual(pending.requestReference, {
    clientRequestId: receipt.clientRequestId,
    runId: receipt.runId,
  });
}
let historyOwnerMissing = false;
let catalogMode = "missing",
  catalogCalls = 0,
  catalogCleanupCalls = 0;
let inputMode = "missing",
  inputCalls = 0,
  inputCleanupCalls = 0,
  inputContent = "";
const oldRun = "4900300f-313a-4114-bbf5-5b0d33b7c824";
const catalog = {
  kind: "comparison-reservation-view",
  companyId: company.id,
  companyRevision: company.revision,
  inspectedAt: "2026-10-14T08:00:00.000Z",
  input: { status: "matched", runId: session.runId },
  reservations: [
    {
      runId: session.runId,
      companyRevision: company.revision,
      companyRevisionMatches: true,
      createdAt: "2026-10-14T07:59:00.000Z",
      expiresAt: "2026-10-14T08:09:00.000Z",
      reservationExpired: false,
      model: "synthetic-model",
      sectionKey: "problem",
      sectionTitle: "합성 현재 예약",
      currency: "USD",
      unitScale: 6,
      reservedUnits: "1250",
      latestEventKind: "reserved",
      history: {
        reservation: {
          clientRequestId: company.id,
          commandDigest: "a".repeat(64),
          recordedAt: "2026-10-14T07:59:00.000Z",
        },
        cancellation: null,
        finalizedAt: null,
      },
    },
    {
      runId: oldRun,
      companyRevision: company.revision + 1,
      companyRevisionMatches: false,
      createdAt: "2026-10-14T07:40:00.000Z",
      expiresAt: "2026-10-14T07:50:00.000Z",
      reservationExpired: true,
      model: "synthetic-model",
      sectionKey: "market",
      sectionTitle: "합성 과거 예약",
      currency: "USD",
      unitScale: 6,
      reservedUnits: "1250",
      latestEventKind: "finalized",
      history: {
        reservation: {
          clientRequestId: oldRun,
          commandDigest: "b".repeat(64),
          recordedAt: "2026-10-14T07:40:00.000Z",
        },
        cancellation: {
          clientRequestId: company.id,
          commandDigest: "c".repeat(64),
          recordedAt: "2026-10-14T07:45:00.000Z",
          releasedUnits: "1250",
        },
        finalizedAt: "2026-10-14T07:45:00.000Z",
      },
    },
  ],
  currentContextVerified: false,
  policiesVerified: false,
  transmissionAllowed: false,
  consentRecorded: false,
  runtimeObserved: false,
};
const postReview = status.postcapture.review;
status.postcapture.review = null;
let recordCalls = 0,
  settlementCalls = 0,
  postRecoveryCalls = 0;
const companies = [company],
  original = structuredClone(companies),
  name = company.profile.companyName;
let mode = "missing",
  executeCalls = 0,
  openCalls = 0,
  previewCalls = 0,
  inspectCalls = 0,
  closeCalls = 0,
  nextDialog = "dismiss";
const blockedDevDiagnostics = [],
  network = [],
  commands = [],
  unexpected = [],
  errors = [],
  checks = [],
  logs = [],
  dialogs = [];
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
  await listenSafe(proxy);
  origin = "http://127.0.0.1:" + proxy.address().port;
  context = await chromium.launchPersistentContext(path.join(output, "browser-profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 1000 },
    timezoneId: "Asia/Seoul",
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
      if (serverMode === "dev" && u.pathname === "/__nextjs_original-stack-frames") {
        blockedDevDiagnostics.push({ method: req.method(), path: u.pathname });
        return route.fulfill({ status: 503, body: "Synthetic offline diagnostics" });
      }
      const reply = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (
        inputOnly &&
        u.pathname === `/api/studio/cases/${company.id}/public-claim-comparison/input-preparation`
      ) {
        if (req.method() === "DELETE") {
          inputCleanupCalls++;
          assert.equal(req.postData(), null);
          return reply({ closed: true });
        }
        inputCalls++;
        assert.equal(req.method(), "POST");
        const selection = {
          companyId: company.id,
          companyRevision: company.revision,
          runId: session.runId,
        };
        assert.deepEqual(JSON.parse(req.postData()), selection);
        if (inputMode === "missing") return reply({ code: "NOT_CONFIGURED" }, 503);
        if (inputMode === "cleanup") return reply({ code: "CLEANUP_REQUIRED" }, 409);
        inputContent = JSON.stringify({
          inputVersion: 1,
          databaseInstanceId: company.id,
          settings: {
            ...selection,
            basis: { provenance: "official-reviewed" },
            usagePolicy: { provenance: "official-reviewed" },
          },
        });
        return reply({
          ...selection,
          kind: "comparison-input-download",
          runId: inputMode === "wrong-run" ? oldRun : session.runId,
          content: inputContent,
          sha256: inputMode === "wrong-hash" ? "b".repeat(64) : sha(inputContent),
          inspectedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + (inputMode === "expired" ? -1 : 60000)).toISOString(),
          reviewDigest: "a".repeat(64),
          model: "synthetic-model",
          transmissionAllowed: false,
          consentRecorded: false,
          runtimeObserved: false,
        });
      }
      if (
        (cancellationOnly || reservationsOnly) &&
        u.pathname === `/api/studio/cases/${company.id}/public-claim-comparison/cancellation`
      ) {
        const body = JSON.parse(req.postData());
        cancellationCalls.push(body.action);
        if (historyOwnerMissing && body.action === "inspect")
          return reply({ code: "OWNER_UNAVAILABLE" }, 404);
        if (reservationsOnly) return reply({ code: "OWNER_UNAVAILABLE" }, 404);
        assert.equal(req.method(), "POST");
        if (body.action === "open")
          assert.deepEqual(body.selection, prepared.cancellation.selection);
        if (body.action === "cancel") {
          assert.deepEqual(body.consent, {
            reviewDigest: prepared.cancellationReview.reviewDigest,
            cancelReservationAcknowledged: true,
            retainedEvidenceAcknowledged: true,
          });
          await assertPinnedReference("cancellation");
          cancelled = true;
          return route.abort();
        }
        const closing = body.action === "close" ? ++cancellationClose : 0;
        return reply({
          ...prepared.cancellation,
          registrationId: req.headers()["x-venturepass-comparison-cancellation"],
          status: closing
            ? closing === 1
              ? "draining"
              : "closed"
            : cancelled
              ? "recorded"
              : body.action === "review"
                ? "review"
                : "unused",
          review: body.action === "review" ? prepared.cancellationReview : null,
          clientRequestId: prepared.cancellationReceipt.clientRequestId,
          ...(cancelled
            ? {
                receipt: prepared.cancellationReceipt,
                clientRequestId: prepared.cancellationReceipt.clientRequestId,
              }
            : {}),
        });
      }
      if (
        bookingOnly &&
        u.pathname === `/api/studio/cases/${company.id}/public-claim-comparison/booking`
      ) {
        const body = JSON.parse(req.postData());
        bookingCalls.push(body.action);
        if (historyOwnerMissing && body.action === "inspect")
          return reply({ code: "OWNER_UNAVAILABLE" }, 404);
        assert.equal(req.method(), "POST");
        if (body.action === "open") {
          assert.deepEqual(body.selection, preview.command.selection);
          if (bookingMode === "missing") return reply({ code: "NOT_CONFIGURED" }, 503);
        }
        if (body.action === "reserve") {
          assert.equal(Object.values(body.consent).filter((value) => value === true).length, 5);
          assert.equal(body.consent.reviewDigest, prepared.review.reviewDigest);
          await assertPinnedReference("booking");
          bookingRecorded = true;
          return route.abort();
        }
        const closing = body.action === "close" ? ++bookingClose : 0;
        return reply({
          ...prepared.booking,
          registrationId: req.headers()["x-venturepass-comparison-booking"],
          status: closing
            ? closing === 1
              ? "draining"
              : "closed"
            : bookingRecorded
              ? "recorded"
              : body.action === "review"
                ? "review"
                : "unused",
          review: body.action === "review" ? prepared.review : null,
          clientRequestId: prepared.receipt.clientRequestId,
          runId: prepared.receipt.runId,
          ...(bookingRecorded
            ? {
                receipt: prepared.receipt,
                clientRequestId: prepared.receipt.clientRequestId,
                runId: prepared.receipt.runId,
              }
            : {}),
        });
      }
      if (
        u.pathname ===
        "/api/studio/cases/" + company.id + "/public-claim-comparison/reservations"
      ) {
        assert.equal(req.postData(), null);
        if (req.method() === "DELETE") {
          catalogCleanupCalls++;
          return reply({ closed: true });
        }
        assert.equal(req.method(), "GET");
        assert.equal(u.searchParams.get("revision"), String(company.revision));
        catalogCalls++;
        if (catalogMode === "missing") return reply({ code: "NOT_CONFIGURED" }, 503);
        if (catalogMode === "cleanup") return reply({ code: "CLEANUP_REQUIRED" }, 409);
        if (catalogMode === "empty")
          return reply({
            ...catalog,
            input: { status: "not-configured", runId: null },
            reservations: [],
          });
        return reply(catalog);
      }
      if (u.pathname === "/api/studio/cases/" + company.id + "/public-claim-comparison/execution") {
        assert.equal(req.method(), "POST");
        const body = JSON.parse(req.postData());
        commands.push(body.action);
        if (body.action === "open") {
          openCalls++;
          assert.equal(body.companyRevision, company.revision);
          if (mode === "missing")
            return reply(
              {
                kind: "comparison-execution-error",
                code: "OPEN_UNAVAILABLE",
                runtimeObserved: false,
              },
              503,
            );
          return reply(session);
        }
        assert.equal(req.headers()["x-venturepass-comparison-session"], session.sessionId);
        if (body.action === "preview") {
          previewCalls++;
          return reply({ ...status, prepared: prepared.prepared });
        }
        if (body.action === "execute") {
          executeCalls++;
          assert.equal(Object.values(body.consent).filter((x) => x === true).length, 7);
          return route.abort();
        }
        if (body.action === "inspect" || body.action === "recover") {
          inspectCalls++;
          return reply({ ...status, status: "attempted", outcome: "returned" });
        }
        if (body.action === "postcapture-preview") {
          status.postcapture.review = structuredClone(postReview);
          return reply({ ...status, status: "attempted", outcome: "returned" });
        }
        if (body.action === "record-result") {
          recordCalls++;
          assert.equal(body.reviewDigest, postReview.reviewDigest);
          status.postcapture.record = "recovery-required";
          status.postcapture.review = null;
          return route.abort();
        }
        if (body.action === "recover-postcapture") {
          postRecoveryCalls++;
          assert.equal(body.operation, "record-result");
          status.postcapture.record = "stored";
          postReview.comparisonRecorded = true;
          postReview.usageStatus = "unknown";
          postReview.units = null;
          return reply({ ...status, status: "attempted", outcome: "returned" });
        }
        if (body.action === "settle-finalize") {
          settlementCalls++;
          assert.equal(postReview.usageStatus, "known");
          status.postcapture.settlement = "stored";
          status.postcapture.review = null;
          postReview.costSettled = true;
          postReview.finalized = true;
          return reply({ ...status, status: "attempted", outcome: "returned" });
        }
        if (body.action === "close") {
          closeCalls++;
          return closeCalls === 1
            ? reply(
                {
                  kind: "comparison-execution-error",
                  code: "CLEANUP_REQUIRED",
                  runtimeObserved: false,
                },
                409,
              )
            : reply({ ...status, status: "closed", closed: true });
        }
        throw Error("unexpected execution action");
      }
      if (u.pathname === "/api/studio/cases/" + company.id + "/public-claim-comparison/preview") {
        assert.deepEqual(JSON.parse(req.postData()), preview.command);
        return reply(preview);
      }
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
          return reply(found);
        }
        if (u.pathname === "/api/studio/cases/" + company.id + "/source-intakes") {
          return reply({ company, activeItemIds: [] });
        }
        const guided = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/guided-preparation",
        );
        if (guided) {
          return reply({ company: guided, active: false, aiConfigured: false, approval: null });
        }
        const automation = companies.find(
          (value) => u.pathname === "/api/studio/cases/" + value.id + "/preparation-automation",
        );
        if (automation) return reply({ company: automation, active: false });
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
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/preparation-automation")),
    page.getByRole("button", { name: "상세 도구", exact: true }).click(),
  ]);
  await page.waitForFunction(() =>
    document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
  );
  await page.getByRole("tab", { name: /사업계획서/ }).click();
  const panel = page.getByRole("region", { name: "주장·근거 검토 기록", exact: true });
  async function openSection() {
    const section = page
      .getByRole("region", { name: "주장·근거 검토 기록", exact: true })
      .locator("details")
      .filter({
        has: page.locator("summary", {
          hasText: bookingOnly
            ? "공개 근거 비교 새 예약 (선택)"
            : "예약한 공개 근거 비교 실행 (선택)",
        }),
      })
      .first();
    await section.locator("summary").first().focus();
    await page.keyboard.press("Enter");
    return section;
  }
  const recordCheck = record;
  async function verifyPinnedHistory(kind) {
    const saved = await page.evaluate(
      (key) => sessionStorage.getItem(key),
      "venturepass.comparison-" + kind + ".v1",
    );
    const pending = JSON.parse(saved),
      receipt = kind === "booking" ? prepared.receipt : prepared.cancellationReceipt;
    historyOwnerMissing = true;
    await section
      .getByRole("button", {
        name: kind === "booking" ? "원래 예약 상태 조회" : "원래 취소 상태 조회",
        exact: true,
      })
      .click();
    await section.getByText(/현재 서버에서 원래.*연결을 찾지 못했습니다/).waitFor();
    if (kind === "booking") {
      const details = panel
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "예약한 공개 근거 비교 실행 (선택)" }) })
        .first();
      await details.locator("summary").first().focus();
      await page.keyboard.press("Enter");
    }
    catalogMode = "valid";
    catalog.inspectedAt = "2026-10-14T10:00:00.000Z";
    catalog.input = { status: "not-configured", runId: null };
    const row = catalog.reservations[0];
    row.runId = receipt.runId;
    row.reservationExpired = true;
    const record = {
      clientRequestId: receipt.clientRequestId,
      commandDigest: receipt.commandDigest,
      recordedAt: receipt.recordedAt,
    };
    if (kind === "booking") {
      row.createdAt = receipt.recordedAt;
      row.expiresAt = "2026-10-14T09:10:00.000Z";
      row.history.reservation = record;
    } else {
      row.latestEventKind = "finalized";
      row.history.cancellation = { ...record, releasedUnits: receipt.releasedUnits };
      row.history.finalizedAt = receipt.recordedAt;
    }
    const region = page.getByRole("region", { name: "회사별 기존 비교 예약", exact: true });
    const load = () =>
      region.getByRole("button", { name: "기존 예약 목록 불러오기", exact: true }).click();
    const match = () =>
      region.getByRole("button", { name: "미확인 요청 기록 대조", exact: true }).click();
    await load();
    await match();
    const result = region.getByRole("status", { name: "원래 요청 대조 결과", exact: true });
    await result.getByText(/요청과 저장된 기록이 일치합니다/).waitFor();
    assert.ok((await result.textContent()).includes(pending.requestReference.clientRequestId));
    await result.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, kind + "-history-match-mobile.png") });
    record.clientRequestId = company.id; // same run/section, different request must never match
    if (kind === "cancellation") row.history.cancellation.clientRequestId = oldRun;
    await load();
    assert.equal(await result.count(), 0);
    await match();
    await result.getByText(/이번 목록에서 원래.*찾지 못했습니다/).waitFor();
    assert.equal(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        "venturepass.comparison-" + kind + ".v1",
      ),
      saved,
    );
    historyOwnerMissing = false;
    recordCheck(
      kind +
        ": server identity persisted before write; lost reply/reload/missing owner matches exact history, rejects other nonce and retains attempted routing.",
    );

    const archive = () =>
      region
        .getByRole("button", {
          name: kind === "booking" ? "확인된 예약 요청 보관" : "확인된 취소 요청 보관",
          exact: true,
        })
        .click();
    const archiveMessage = region.getByRole("status", { name: "보관 처리 결과", exact: true });
    historyOwnerMissing = true;
    await archive();
    await archiveMessage.getByText(/요청을 보관하지 못했습니다/).waitFor();
    assert.equal(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        "venturepass.comparison-" + kind + ".v1",
      ),
      saved,
    );
    record.clientRequestId = receipt.clientRequestId;
    if (kind === "cancellation") row.history.cancellation.clientRequestId = receipt.clientRequestId;
    historyOwnerMissing = false;
    await archive();
    await archiveMessage.getByText(/원래 서버 연결이 남아/).waitFor();
    historyOwnerMissing = true;
    await archive();
    await archiveMessage.getByText(/요청을 이 탭에 보관했습니다/).waitFor();
    const stored = JSON.parse(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        "venturepass.comparison-" + kind + ".v1",
      ),
    );
    assert.equal(stored.version, 2);
    assert.equal(stored.active, null);
    assert.deepEqual(stored.archives[0].original, pending);
    recordCheck(
      kind +
        ": archive requires fresh owner absence and matching ledger; mismatched records and live owners keep active routing.",
    );
    const beforeReload = bookingCalls.length + cancellationCalls.length + catalogCalls;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
    );
    await page.getByRole("tab", { name: /사업계획서/ }).click();
    section = await openSection();
    if (kind === "booking") {
      const d = panel
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: "예약한 공개 근거 비교 실행 (선택)" }) })
        .first();
      await d.locator("summary").first().focus();
      await page.keyboard.press("Enter");
    }
    assert.equal(bookingCalls.length + cancellationCalls.length + catalogCalls, beforeReload);
    const archiveDetails = region
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "이 탭에 보관한 요청" }) })
      .first();
    await archiveDetails.locator("summary").click();
    await archiveDetails.getByRole("button", { name: "보관 기록 불러오기", exact: true }).click();
    const archivedList = archiveDetails.getByRole("list", {
      name: "보관한 요청 목록",
      exact: true,
    });
    await archivedList.getByText(new RegExp(pending.requestReference.clientRequestId)).waitFor();
    assert.equal(bookingCalls.length + cancellationCalls.length + catalogCalls, beforeReload);
    await archivedList.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, kind + "-archived-request-mobile.png") });
    historyOwnerMissing = false;
    if (kind === "booking") {
      bookingRecorded = false;
      bookingClose = 0;
      await section
        .getByLabel("새 예약의 저장 주장 버전", { exact: true })
        .selectOption(preview.command.selection.claimRecordId);
      for (const sourceId of preview.command.selection.sourceIds)
        await section
          .getByRole("checkbox", {
            name: company.sources.find((source) => source.id === sourceId).name,
            exact: true,
          })
          .check();
      await section.getByRole("button", { name: "예약 내용·비용 검토", exact: true }).click();
      await section.getByRole("region", { name: "새 예약 검토", exact: true }).waitFor();
    } else {
      cancelled = false;
      cancellationClose = 0;
      const nextRun = "f9527204-25bf-4136-9707-598d12dd16cf";
      row.runId = nextRun;
      row.latestEventKind = "reserved";
      row.history.cancellation = null;
      row.history.finalizedAt = null;
      prepared.cancellation.selection.runId = nextRun;
      prepared.cancellationReview.runId = nextRun;
      await load();
      await region.getByLabel("살펴볼 기존 예약", { exact: true }).selectOption(nextRun);
      await region.getByRole("button", { name: "선택 예약 취소 검토", exact: true }).click();
      await region.getByRole("region", { name: "취소 내용 검토", exact: true }).waitFor();
    }
    const next = JSON.parse(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        "venturepass.comparison-" + kind + ".v1",
      ),
    );
    assert.notEqual(next.active.registrationId, pending.registrationId);
    assert.equal(next.active.attempted, false);
    assert.deepEqual(next.archives, stored.archives);
    const closeName = kind === "booking" ? "예약 연결 정리" : "취소 연결 정리";
    await section.getByRole("button", { name: closeName, exact: true }).click();
    await section
      .getByText(kind === "booking" ? /원래 연결의 정리가 끝나지/ : /취소 연결 정리가 끝나지/)
      .waitFor();
    await section.getByRole("button", { name: closeName, exact: true }).click();
    await section
      .getByText(kind === "booking" ? /예약 연결을 정리했습니다/ : /취소 연결을 정리했습니다/)
      .waitFor();
    const final = JSON.parse(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        "venturepass.comparison-" + kind + ".v1",
      ),
    );
    assert.equal(final.active, null);
    assert.deepEqual(final.archives, stored.archives);
    assert.equal(
      (kind === "booking" ? bookingCalls : cancellationCalls).filter(
        (a) => a === (kind === "booking" ? "reserve" : "cancel"),
      ).length,
      1,
    );
    recordCheck(
      kind +
        ": archived evidence survives reload, explicit new review and failed-close retry; no second write or automatic fetch.",
    );
  }
  let section = await openSection();
  assert.equal(openCalls, 0);
  assert.equal(executeCalls, 0);
  if (inputOnly) {
    catalogMode = "valid";
    catalog.reservations[0].expiresAt = "2099-01-01T00:00:00.000Z";
    const reservations = section.getByRole("region", {
      name: "회사별 기존 비교 예약",
      exact: true,
    });
    await reservations
      .getByRole("button", { name: "기존 예약 목록 불러오기", exact: true })
      .click();
    const select = reservations.getByLabel("살펴볼 기존 예약", { exact: true });
    await select.selectOption(oldRun);
    assert.equal(
      await reservations
        .getByRole("button", { name: "선택한 예약의 입력 파일 준비", exact: true })
        .isDisabled(),
      true,
    );
    await select.selectOption(session.runId);
    let input = reservations.getByRole("region", { name: "실행 입력 파일 준비", exact: true });
    assert.equal(inputCalls, 0);
    const prepare = () =>
      input.getByRole("button", { name: "선택한 예약의 입력 파일 준비", exact: true }).click();
    await prepare();
    await input.getByText(/검토된 실행 준비 정책이 설정되지/).waitFor();
    inputMode = "cleanup";
    await prepare();
    await input.getByText(/이전 준비 연결의 정리/).waitFor();
    await input.getByRole("button", { name: "준비 연결 정리", exact: true }).click();
    await input.getByText(/준비 연결을 정리했습니다/).waitFor();
    for (const failure of ["wrong-run", "wrong-hash", "expired"]) {
      inputMode = failure;
      await prepare();
      await input.getByText(/입력 파일을 준비하지 못했습니다/).waitFor();
      assert.equal(
        await input.getByRole("button", { name: "입력 JSON 내려받기", exact: true }).count(),
        0,
      );
    }
    record(
      "Preparation rejects old/finalized selection, missing policy, incomplete cleanup, wrong run/hash and expired result; explicit requests only.",
    );
    inputMode = "valid";
    await prepare();
    const downloadButton = input.getByRole("button", { name: "입력 JSON 내려받기", exact: true });
    await downloadButton.waitFor();
    const downloadEvent = page.waitForEvent("download");
    await downloadButton.click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), `comparison-input-${session.runId}.json`);
    const target = path.join(output, "synthetic-input.json");
    await download.saveAs(target);
    assert.equal(await readFile(target, "utf8"), inputContent);
    await page.setViewportSize({ width: 390, height: 844 });
    await downloadButton.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const button of await input.getByRole("button").all())
      assert.ok((await button.boundingBox()).height >= 44);
    await page.screenshot({ path: path.join(output, "input-download-mobile.png") });
    record(
      "Explicit JSON download preserves exact selected identifiers and SHA; 390px layout and 44px controls.",
    );
    await select.selectOption(oldRun);
    await select.selectOption(session.runId);
    input = reservations.getByRole("region", { name: "실행 입력 파일 준비", exact: true });
    assert.equal(
      await input.getByRole("button", { name: "입력 JSON 내려받기", exact: true }).count(),
      0,
    );
    await section.locator("summary").first().click();
    section = await openSection();
    assert.equal(inputCalls, 6);
    assert.equal(inputCleanupCalls, 1);
    assert.equal(await section.getByLabel("살펴볼 기존 예약", { exact: true }).count(), 0);
    assert.equal(openCalls, 0);
    assert.equal(executeCalls, 0);
    record(
      "Changing selection and closing the workspace discard preparation, with no auto request or execution activation.",
    );
  } else if (cancellationOnly) {
    assert.equal(cancellationCalls.length, 0);
    catalogMode = "valid";
    async function selectForCancellation() {
      await section.getByRole("button", { name: "기존 예약 목록 불러오기", exact: true }).click();
      await section.getByLabel("살펴볼 기존 예약", { exact: true }).selectOption(session.runId);
    }
    await selectForCancellation();
    let cancellation = section.getByRole("region", { name: "미전송 비교 예약 취소", exact: true });
    await cancellation.getByRole("button", { name: "선택 예약 취소 검토", exact: true }).click();
    await cancellation.getByText("해제할 예산 보유 0.001250 USD", { exact: true }).waitFor();
    const consent = () =>
      cancellation.getByRole("region", { name: "취소 내용 검토" }).getByRole("checkbox");
    const cancelButton = () =>
      cancellation.getByRole("button", { name: "동의한 예약 취소 기록", exact: true });
    assert.equal(await consent().count(), 2);
    assert.equal(await cancelButton().isDisabled(), true);
    await consent().nth(0).check();
    assert.equal(await cancelButton().isDisabled(), true);
    await consent().nth(1).check();
    await page.setViewportSize({ width: 390, height: 844 });
    await cancellation.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const button of await cancellation.getByRole("button").all())
      assert.ok((await button.boundingBox()).height >= 44);
    await page.screenshot({ path: path.join(output, "cancellation-mobile.png") });
    await section.locator("summary").first().click();
    section = await openSection();
    assert.equal(await section.getByRole("region", { name: "취소 내용 검토" }).count(), 0);
    await selectForCancellation();
    cancellation = section.getByRole("region", { name: "미전송 비교 예약 취소", exact: true });
    await cancellation.getByRole("button", { name: "선택 예약 취소 검토", exact: true }).click();
    await consent().nth(0).waitFor();
    assert.equal(await consent().nth(0).isChecked(), false);
    assert.equal(await consent().nth(1).isChecked(), false);
    record(
      "Cancellation: explicit catalog selection, original reservation/version/release amount, two separate consents, fold invalidation and 390px layout.",
    );
    await consent().nth(0).check();
    await consent().nth(1).check();
    await cancelButton().click();
    await cancellation.getByText(/취소를 확인하지 못했습니다/).waitFor();
    const before = cancellationCalls.length;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
    );
    await page.getByRole("tab", { name: /사업계획서/ }).click();
    section = await openSection();
    cancellation = section.getByRole("region", { name: "미전송 비교 예약 취소", exact: true });
    assert.equal(cancellationCalls.length, before);
    await verifyPinnedHistory("cancellation");
  } else if (bookingOnly) {
    assert.equal(bookingCalls.length, 0);
    await section
      .getByLabel("새 예약의 저장 주장 버전", { exact: true })
      .selectOption(preview.command.selection.claimRecordId);
    for (const sourceId of preview.command.selection.sourceIds) {
      const name = company.sources.find((source) => source.id === sourceId).name;
      await section.getByRole("checkbox", { name, exact: true }).check();
    }
    const prepare = () =>
      section.getByRole("button", { name: "예약 내용·비용 검토", exact: true }).click();
    await prepare();
    await section.getByText(/예약용 검토 정책이 설정되지/).waitFor();
    bookingMode = "valid";
    await prepare();
    const review = section.getByRole("region", { name: "새 예약 검토", exact: true });
    await review.getByText("새 예약 상한 0.001250 USD", { exact: true }).waitFor();
    assert.ok((await review.textContent()).includes(company.claimReviews[0].claimQuote));
    const recordButton = review.getByRole("button", {
      name: "동의한 내용으로 예약 기록",
      exact: true,
    });
    assert.equal(await recordButton.isDisabled(), true);
    const consent = review.getByRole("checkbox");
    assert.equal(await consent.count(), 5);
    for (let i = 0; i < 4; i++) await consent.nth(i).check();
    assert.equal(await recordButton.isDisabled(), true);
    await consent.nth(4).check();
    assert.equal(await recordButton.isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await review.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    for (const button of await section.getByRole("button").all())
      assert.ok((await button.boundingBox()).height >= 44);
    await page.screenshot({ path: path.join(output, "booking-mobile.png") });
    await section.locator("summary").first().click();
    section = await openSection();
    assert.equal(await section.getByRole("region", { name: "새 예약 검토" }).count(), 0);
    await prepare();
    await section.getByRole("region", { name: "새 예약 검토" }).waitFor();
    for (const checkbox of await section
      .getByRole("region", { name: "새 예약 검토" })
      .getByRole("checkbox")
      .all())
      assert.equal(await checkbox.isChecked(), false);
    record(
      "Booking review: exact saved selection, missing policy, full input/cost/retention, five unchecked consents, fold invalidation and mobile layout.",
    );
    for (const checkbox of await section
      .getByRole("region", { name: "새 예약 검토" })
      .getByRole("checkbox")
      .all())
      await checkbox.check();
    await section.getByRole("button", { name: "동의한 내용으로 예약 기록", exact: true }).click();
    await section.getByText(/예약 상태를 확인하지 못했습니다/).waitFor();
    assert.equal(bookingCalls.filter((action) => action === "reserve").length, 1);
    const before = bookingCalls.length;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
    );
    await page.getByRole("tab", { name: /사업계획서/ }).click();
    section = await openSection();
    assert.equal(bookingCalls.length, before);
    await verifyPinnedHistory("booking");
  } else if (reservationsOnly) {
    const reservations = section.getByRole("region", {
      name: "회사별 기존 비교 예약",
      exact: true,
    });
    const load = () =>
      reservations.getByRole("button", { name: "기존 예약 목록 불러오기", exact: true }).click();
    assert.equal(catalogCalls, 0);
    await load();
    await reservations.getByText(/예약 조회 연결이 설정되지/).waitFor();
    catalogMode = "empty";
    await load();
    await reservations.getByText("이 회사에 기록된 비교 예약이 없습니다.").waitFor();
    catalogMode = "cleanup";
    await load();
    await reservations.getByText(/이전 예약 조회 연결의 정리/).waitFor();
    await reservations.getByRole("button", { name: "예약 조회 연결 정리", exact: true }).click();
    await reservations.getByText(/예약 조회 연결을 정리했습니다/).waitFor();
    catalogMode = "valid";
    await load();
    const select = reservations.getByLabel("살펴볼 기존 예약", { exact: true });
    await select.waitFor();
    assert.equal(await select.inputValue(), "");
    await select.selectOption(oldRun);
    await reservations.getByText(/선택한 예약은 현재 서버 실행 입력과 일치하지/).waitFor();
    await reservations.getByText(/조회 시점에 만료됨/).waitFor();
    await select.selectOption(session.runId);
    await reservations.getByText(/선택한 예약은 서버 실행 입력과 일치합니다/).waitFor();
    await reservations.getByText(/예약 당시 상한 0.001250 USD/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await select.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "reservations-mobile.png") });
    for (const button of await reservations.getByRole("button").all())
      assert.ok((await button.boundingBox()).height >= 44);
    await section.locator("summary").first().click();
    await reservations.waitFor({ state: "detached" });
    section = await openSection();
    await section.getByRole("region", { name: "회사별 기존 비교 예약", exact: true }).waitFor();
    assert.equal(await section.getByLabel("살펴볼 기존 예약", { exact: true }).count(), 0);
    assert.equal(catalogCalls, 4);
    assert.equal(catalogCleanupCalls, 1);
    assert.equal(openCalls, 0);
    assert.equal(executeCalls, 0);
    record(
      "Reservation catalog: missing/empty/cleanup, explicit selection and input match, stale expiry, close invalidation; no execution.",
    );
    const lostRouting = {
      version: 1,
      registrationId: company.id,
      selection: { companyId: company.id, companyRevision: company.revision, runId: oldRun },
      attempted: true,
    };
    await page.evaluate(
      (value) =>
        sessionStorage.setItem("venturepass.comparison-cancellation.v1", JSON.stringify(value)),
      lostRouting,
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#studio-panel-profile input")?.matches(":enabled"),
    );
    await page.getByRole("tab", { name: /사업계획서/ }).click();
    section = await openSection();
    assert.equal(catalogCalls, 4);
    assert.equal(cancellationCalls.length, 0);
    const cancellation = section.getByRole("region", {
      name: "미전송 비교 예약 취소",
      exact: true,
    });
    await cancellation.getByRole("button", { name: "원래 취소 상태 조회", exact: true }).click();
    await cancellation.getByText(/현재 서버에서 원래 취소 연결을 찾지 못했습니다/).waitFor();
    const reloadCatalog = () =>
      section.getByRole("button", { name: "기존 예약 목록 불러오기", exact: true }).click();
    await reloadCatalog();
    const currentSelect = section.getByLabel("살펴볼 기존 예약", { exact: true });
    assert.equal(await currentSelect.inputValue(), "");
    await currentSelect.selectOption(oldRun);
    const history = section.getByRole("region", { name: "저장된 예약·취소 기록", exact: true });
    await history.getByText("취소로 해제된 예산 보유 0.001250 USD", { exact: true }).waitFor();
    await history.getByText(`예약 요청 번호 ${oldRun}`, { exact: true }).waitFor();
    await history.getByText(`취소 요청 번호 ${company.id}`, { exact: true }).waitFor();
    await history.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "reservation-history-mobile.png") });
    await currentSelect.selectOption(session.runId);
    await history.getByText(/이번 원장 조회에서 취소 기록이 없습니다/).waitFor();
    assert.equal(await history.getByText(/취소로 해제된 예산/).count(), 0);
    catalog.reservations[1].history.cancellation = null;
    await reloadCatalog();
    await currentSelect.selectOption(oldRun);
    await history.getByText(/다른 절차로 종결된 기록이며 취소·환불을 뜻하지/).waitFor();
    assert.deepEqual(
      JSON.parse(
        await page.evaluate(() => sessionStorage.getItem("venturepass.comparison-cancellation.v1")),
      ),
      lostRouting,
    );
    assert.deepEqual(cancellationCalls, ["inspect"]);
    assert.equal(bookingCalls.length, 0);
    record(
      "Missing original owner after reload: explicit persisted receipt lookup distinguishes cancellation release from other finalization, retains unknown request routing and never resends.",
    );
  } else {
    await section.getByRole("button", { name: "실행 등록·기존 연결 확인", exact: true }).click();
    await section.getByText(/서버의 검토된 정책/).waitFor();
    await section.getByRole("button", { name: "확인된 연결 기록 비우기", exact: true }).click();
    mode = "valid";
    await section.getByRole("button", { name: "실행 등록·기존 연결 확인", exact: true }).click();
    await section.getByText(/실행을 등록했습니다/).waitFor();
    await section.getByRole("button", { name: "비용·전송 내용 확인", exact: true }).click();
    await section.getByText("기존 예약 상한 0.001250 USD", { exact: true }).waitFor();
    assert.ok((await section.textContent()).includes(company.claimReviews[0].claimQuote));
    assert.ok(
      (await section.textContent()).includes(
        "이 예약의 입력·응답 보관 범위는 위의 보관 안내를 따릅니다.",
      ),
    );
    assert.ok(!(await section.textContent()).includes("이 내용은 현재 창에만 남습니다."));
    assert.equal(await section.getByRole("checkbox").count(), 7);
    assert.equal(
      await section
        .getByRole("button", { name: "동의한 내용으로 1회 실행", exact: true })
        .isDisabled(),
      true,
    );
    record(
      "Explicit registration handles missing input and displays the exact input, reservation and seven unchecked consents.",
    );
    await section.getByRole("checkbox").first().check();
    await panel.getByRole("button", { name: "새 주장·근거 기록", exact: true }).click();
    await section.getByText(/원고·주장 편집 또는 저장을 마친/).waitFor();
    assert.equal(await section.getByRole("checkbox").count(), 0);
    nextDialog = "accept";
    await panel.getByRole("button", { name: "편집 취소", exact: true }).click();
    await section.getByRole("button", { name: "비용·전송 내용 확인", exact: true }).click();
    await section.getByText("기존 예약 상한 0.001250 USD", { exact: true }).waitFor();
    assert.equal(await section.getByRole("checkbox").first().isChecked(), false);
    assert.equal(executeCalls, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await section.locator("summary").first().scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({ path: path.join(output, "execution-mobile.png") });
    for (const button of await section.getByRole("button").all())
      assert.ok((await button.boundingBox()).height >= 44);
    await section
      .getByRole("heading", { name: "전송 전 비용·보관 안내", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "execution-cost-mobile.png") });
    await section.getByRole("checkbox").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "execution-consent-mobile.png") });
    for (let i = 0; i < 6; i++) await section.getByRole("checkbox").nth(i).check();
    const send = section.getByRole("button", { name: "동의한 내용으로 1회 실행", exact: true });
    assert.equal(await send.isDisabled(), true);
    await section.getByRole("checkbox").nth(6).focus();
    await page.keyboard.press("Space");
    assert.equal(await send.isEnabled(), true);
    await send.click();
    await section.getByText(/요청 결과를 확인하지 못했습니다/).waitFor();
    assert.equal(executeCalls, 1);
    record(
      "Editing clears consent; mobile and keyboard interaction require all seven checks before one explicit send.",
    );
    await section.getByRole("button", { name: "실행 상태 확인", exact: true }).click();
    await section.getByText(/실행 요청의 처리가 반환되었습니다/).waitFor();
    assert.equal(executeCalls, 1);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button").filter({ hasText: name }).first().click();
    await page.getByRole("button", { name: "상세 도구", exact: true }).click();
    await page.getByRole("tab", { name: /사업계획서/ }).click();
    section = await openSection();
    const before = openCalls;
    await section.getByRole("button", { name: "실행 등록·기존 연결 확인", exact: true }).click();
    await section.getByRole("button", { name: "실행 상태 확인", exact: true }).click();
    await section.getByText(/실행 요청의 처리가 반환되었습니다/).waitFor();
    assert.equal(openCalls, before);
    assert.equal(executeCalls, 1);
    assert.equal(await section.getByRole("checkbox").count(), 0);
    await section.getByRole("button", { name: "원래 실행 복구 확인", exact: true }).click();
    await section.getByText(/원래 실행의 복구 상태/).waitFor();
    await section.getByRole("button", { name: "최신 비용·보관 확인", exact: true }).click();
    await section.getByText("관측 사용량 기준 0.000123 USD", { exact: true }).waitFor();
    await section.getByRole("button", { name: "비교 의견 보관", exact: true }).click();
    await section.getByText(/요청 결과를 확인하지 못했습니다/).waitFor();
    assert.equal(recordCalls, 1);
    await section.getByRole("button", { name: "실행 상태 확인", exact: true }).click();
    await section.getByRole("button", { name: "의견 보관 원래 기록 확인", exact: true }).click();
    await section.getByText("의견 보관: 원래 기록 확인", { exact: true }).waitFor();
    await section.getByRole("button", { name: "최신 비용·보관 확인", exact: true }).click();
    await section.getByText(/사용량 미확인 — 비용 예약을 유지/).waitFor();
    assert.equal(
      await section
        .getByRole("button", { name: "표시된 비용 정산·기록 종결", exact: true })
        .isDisabled(),
      true,
    );
    postReview.usageStatus = "known";
    postReview.units = "123";
    await section.getByRole("button", { name: "최신 비용·보관 확인", exact: true }).click();
    await section.getByText("관측 사용량 기준 0.000123 USD", { exact: true }).waitFor();
    await section.getByRole("button", { name: "표시된 비용 정산·기록 종결", exact: true }).click();
    await section.getByText("비용 정산: 원래 기록 확인", { exact: true }).waitFor();
    await section.getByRole("button", { name: "최신 비용·보관 확인", exact: true }).click();
    await section
      .getByText("의견 보관 확인 · 비용 정산 확인 · 기록 종결 확인", { exact: true })
      .waitFor();
    assert.equal(recordCalls, 1);
    assert.equal(settlementCalls, 1);
    assert.equal(postRecoveryCalls, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await section
      .getByRole("region", { name: "응답 의견 보관과 비용 정산" })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: path.join(output, "postcapture-mobile.png") });
    record(
      "Captured opinion lost delivery recovers its original record; unknown usage holds cost, known usage settles once without resend.",
    );
    await section.getByRole("button", { name: "실행 연결 종료", exact: true }).click();
    await section.getByText(/요청 결과를 확인하지 못했습니다/).waitFor();
    await section.getByRole("button", { name: "실행 연결 종료", exact: true }).click();
    await section.getByText("실행 연결 종료를 확인했습니다.", { exact: true }).waitFor();
    await section.getByRole("button", { name: "확인된 연결 기록 비우기", exact: true }).click();
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("venturepass.comparison-execution.v1")),
      null,
    );
    record(
      "Lost delivery and reload keep original routing; explicit status, recovery and confirmed close never resend.",
    );
  }
  assert.deepEqual(companies, original);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(
    executeCalls,
    reservationsOnly || bookingOnly || cancellationOnly || inputOnly ? 0 : 1,
  );
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        checks,
        reservationsOnly,
        bookingOnly,
        cancellationOnly,
        inputOnly,
        inputCalls,
        inputCleanupCalls,
        cancellationCalls,
        bookingCalls,
        catalogCalls,
        catalogCleanupCalls,
        openCalls,
        previewCalls,
        executeCalls,
        recordCalls,
        settlementCalls,
        postRecoveryCalls,
        inspectCalls,
        closeCalls,
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
  console.log(JSON.stringify({ output, checks: checks.length, openCalls, executeCalls }));
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
