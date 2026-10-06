import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const sdkForbidden = vi.hoisted(() => vi.fn(() => { throw Error("SDK construction forbidden"); }));
vi.mock("openai", () => ({ default: class { constructor() { sdkForbidden(); } } }));
vi.mock("openai/helpers/zod", async () => ({
  zodTextFormat: (await import("./studio-public-claim-comparison-format-test-fixture")).pinnedComparisonFormatFixture,
}));
vi.mock("openai/error", () => {
  class APIError extends Error {}
  return { APIError, APIConnectionError: class extends APIError {},
    APIConnectionTimeoutError: class extends APIError {}, APIUserAbortError: class extends APIError {} };
});
import { createRequire } from "node:module";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import { comparisonReviewSuccessWire, comparisonReviewErrorWire } from "./studio-public-claim-comparison-review-wire";
import type { ReviewMountFixture } from "../../scripts/comparison-review-react-browser";

let context: BrowserContext, page: Page, bundleText: string, data: ReviewMountFixture;
const errors: string[] = [], network: string[] = [];
const app = process.cwd();
const forbidden = /openai|server-only|node:|studio-storage|quality-store|comparison-database|review-handler|review-server|provider-production/;
beforeAll(async () => {
  const f = comparisonReviewTestFixture(), value = f.value();
  data = { snapshot: { id: value.resultIdentity.selection.companyId, revision: 7 },
    expected: { ...f.query, selection: structuredClone(value.resultIdentity.selection),
      binding: structuredClone(value.resultIdentity.binding), sectionKey: value.historical.prepared.input.section.key },
    query: f.query, success: comparisonReviewSuccessWire(f.query, value),
    error: comparisonReviewErrorWire("READ_BLOCKED") };
  const requireFromVitest = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
  const { rolldown } = await import(pathToFileURL(requireFromVitest.resolve("rolldown")).href);
  const bundle = await rolldown({
    input: path.join(app, "scripts/comparison-review-react-browser.tsx"), cwd: app, platform: "browser",
    tsconfig: path.join(app, "tsconfig.json"),
    transform: { define: { "process.env.NODE_ENV": '"development"' }, jsx: { runtime: "automatic" } },
    plugins: [{ name: "deny-runtime-activation",
      resolveId(source: string) { if (forbidden.test(source)) throw Error("Forbidden browser import: " + source); return null; },
    }],
    onwarn(warning: { code: string; message: string }, forward: (warning: unknown) => void) {
      if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes("use client")) return;
      forward(warning);
    },
  });
  try {
    const output = await bundle.generate({ format: "iife" });
    expect(output.output).toHaveLength(1);
    const chunk = output.output[0];
    expect(chunk.type).toBe("chunk"); expect(chunk.imports).toEqual([]); expect(chunk.dynamicImports).toEqual([]);
    const modules = Object.keys(chunk.modules);
    expect(modules.filter((id) => forbidden.test(id))).toEqual([]);
    expect(modules.some((id) => id.includes("react-dom-client.development.js"))).toBe(true);
    bundleText = chunk.code;
  } finally { await bundle.close(); }
  const temporaryRoot = path.resolve(app, "../../.venturepass-tools/build-temp");
  await mkdir(temporaryRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(temporaryRoot, "venturepass-review-react-"));
  context = await chromium.launchPersistentContext(path.join(temporary, "profile"), {
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true, serviceWorkers: "block", args: ["--disable-background-networking"],
  });
  await context.route("**/*", (route) => { network.push(route.request().url()); return route.abort(); });
}, 60000);
beforeEach(async () => {
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.setContent('<!doctype html><meta charset="utf-8"><title>Isolated synthetic React mount</title><div id="root"></div>');
  await page.evaluate(() => {
    const attempts: string[] = [];
    Object.assign(window, { networkAttempts: attempts });
    const deny = (name: string) => () => { attempts.push(name); throw Error("Network forbidden"); };
    Object.assign(window, { fetch: deny("fetch"), XMLHttpRequest: deny("XHR"), WebSocket: deny("WebSocket"), EventSource: deny("EventSource") });
    Object.defineProperty(navigator, "sendBeacon", { value: deny("beacon") });
  });
  await page.addScriptTag({ content: bundleText });
});
afterEach(async () => {
  expect(await page.evaluate(() => (window as unknown as { networkAttempts: string[] }).networkAttempts)).toEqual([]);
  expect(network).toEqual([]); expect(errors).toEqual([]); expect(sdkForbidden).not.toHaveBeenCalled();
  await page.close();
});
afterAll(async () => { await context?.close(); });
async function mount(mode: Parameters<Window["startReviewMount"]>[1] = "success") {
  await page.evaluate(({ data, mode }) => { window.reviewMount = window.startReviewMount(data, mode); }, { data, mode });
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"status":"ATTACHED"'));
}
const state = () => page.evaluate(() => window.reviewMount.snapshot());
const display = () => page.locator("#state").textContent().then((s) => JSON.parse(s!).display);
async function read() { await page.locator("#read").click(); }
async function result() { await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"result"')); }
async function empty() { await page.waitForFunction(() => !window.reviewMount.snapshot().retained.occupied); }

it("4I46 development StrictMode repeats actual layout/passive lifetimes without automatic requests or permanent close", async () => {
  await mount();
  const s = await state();
  expect(s.metrics).toMatchObject({ layoutSetup: 2, layoutCleanup: 1, passiveSetup: 2, passiveCleanup: 1,
    attach: 2, detach: 1, request: 0, prepare: 0, start: 0, close: 0, renderSideEffects: 0 });
  expect(s.metrics.renders).toBeGreaterThanOrEqual(4);
  await page.evaluate(() => window.reviewMount.update("same"));
  expect((await state()).metrics.request).toBe(0);
});
it("4I46 explicit click renders canonical immutable synthetic result and keeps every authority boundary", async () => {
  await mount(); await read(); await result();
  const shown = await display();
  expect(shown.result).toMatchObject({ source: "synthetic-comparison-stored-review", owner: null,
    runtimeObserved: false, historical: { currentContextVerified: false,
      result: { source: "supplied-response", evidenceOrigin: "manual-unverified" } } });
  expect(Object.values(shown.result.authority).every((value) => value === false)).toBe(true);
  expect((await state()).metrics).toMatchObject({ request: 1, queryMatches: 1, start: 1, renderSideEffects: 0, close: 0 });
  await page.locator("#release").click(); await empty(); expect(await display()).toBeNull();
});
it("4I46 repeated explicit clicks retain one pending call and wait for both original I/O completions", async () => {
  await mount("pending"); await read(); await read();
  expect((await state()).lastCode).toBe("BUSY"); expect((await state()).metrics.request).toBe(1);
  await page.evaluate(() => window.reviewMount.finishResponse());
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.responseCompleted);
  expect(await display()).toBeNull(); expect((await state()).retained.canForget).toBe(false);
  await page.evaluate(() => window.reviewMount.finishRequest()); await result();
});
it.each(["snapshot", "revision", "selection", "dirty", "blocked", "closed", "aborted"])(
  "4I46 current %s props hide completed display before commit and cannot revive an invalidated result", async (kind) => {
    await mount(); await read(); await result();
    const before = (await state()).renderLog.length;
    await page.evaluate((kind) => window.reviewMount.update(kind), kind);
    expect(await display()).toBeNull();
    expect((await state()).renderLog.slice(before).every((r) => r.display === null)).toBe(true);
    await page.evaluate(() => window.reviewMount.update("restore"));
    expect(await display()).toBeNull(); expect((await state()).metrics.request).toBe(1);
  });
it("4I46 discarded concurrent render suppresses its candidate without invalidating committed display", async () => {
  await mount(); await read(); await result();
  await page.evaluate(() => window.reviewMount.abandon());
  await page.waitForFunction(() => window.reviewMount.snapshot().renderLog.some((r) => r.dirty));
  expect((await state()).renderLog.filter((r) => r.dirty).every((r) => r.display === null)).toBe(true);
  expect((await display()).kind).toBe("result");
  await page.evaluate(() => window.reviewMount.update("restore")); await result();
  expect((await state()).metrics.renderSideEffects).toBe(0);
});
it("4I46 old callbacks after props commit cannot start or cancel the current view", async () => {
  await mount(); await page.evaluate(() => window.reviewMount.save());
  await page.evaluate(() => window.reviewMount.update("selection"));
  expect(await page.evaluate(() => window.reviewMount.oldRead())).toBe("STALE_VIEW");
  expect(await page.evaluate(() => window.reviewMount.oldCancel())).toBe(false);
  expect((await state()).metrics.request).toBe(0);
});
it("4I46 remount keeps the same pending slot while obsolete callbacks cannot affect its new token", async () => {
  await mount("pending"); await read(); await page.evaluate(() => window.reviewMount.save());
  await page.evaluate(() => window.reviewMount.remount());
  expect(await page.evaluate(() => window.reviewMount.oldRead())).toBe("STALE_VIEW");
  expect(await page.evaluate(() => window.reviewMount.oldCancel())).toBe(false);
  await read(); expect((await state()).lastCode).toBe("BUSY");
  expect((await state()).retained.occupied).toBe(true);
  expect((await state()).metrics).toMatchObject({ request: 1, close: 0 });
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await empty(); expect(await display()).toBeNull();
});
it.each(["child", "root"])("4I46 %s unmount cancels only its view and retains late original completion without a UI subscriber", async (kind) => {
  await mount("pending"); await read(); await page.evaluate((kind) => kind === "root" ? window.reviewMount.dispose() : window.reviewMount.unmount(), kind);
  expect((await state()).retained.occupied).toBe(true); expect((await state()).signalAborted).toBe(true);
  expect((await state()).metrics.close).toBe(0);
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await empty();
});
it("4I46 early error is visible with a pending request and parent close does not imply completion", async () => {
  await mount("error"); await read();
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"error"'));
  expect((await display()).code).toBe("READ_BLOCKED");
  await page.evaluate(() => window.reviewMount.parentClose());
  expect((await state()).retained).toMatchObject({ occupied: true, closed: true, canForget: false });
  await page.evaluate(() => window.reviewMount.finishRequest()); await empty();
});
it("4I46 cleanup failure stays retained after unmount and late completion", async () => {
  await mount("cleanup-failed"); await read();
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(true); });
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.requestCompleted);
  await page.evaluate(() => window.reviewMount.unmount());
  expect((await state()).retained).toMatchObject({ occupied: true, canForget: false });
});
it("4I46 missing request receipt stays unknown across parent close", async () => {
  await mount("unavailable"); await read();
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.io?.requestStatus === "unavailable");
  await page.evaluate(() => window.reviewMount.parentClose());
  expect((await state()).retained).toMatchObject({ occupied: true, canForget: false });
  expect((await state()).metrics.request).toBe(1);
});
it("4I46 missing injected request port reports unavailable without any fallback transport", async () => {
  await mount("unsupported"); await read();
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes("RESULT_UNAVAILABLE"));
  expect((await state()).metrics.request).toBe(0);
});
it.each(["connection", "missing"])("4I46 %s input never replaces the retained connection or resets pending I/O", async (kind) => {
  await mount("pending"); await read();
  await page.evaluate((kind) => window.reviewMount.update(kind), kind);
  expect(await display()).toBeNull();
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("STALE_VIEW");
  expect((await state()).metrics).toMatchObject({ request: 1, close: 0 });
  expect((await state()).retained.occupied).toBe(true);
});
it("4I46 unmount during prepare retains the original object and never starts its port", async () => {
  await mount("pending"); await page.evaluate(() => window.reviewMount.detachDuringPrepare());
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("STALE_VIEW");
  await empty(); expect((await state()).metrics).toMatchObject({ request: 0, start: 0, close: 0 });
});
it("4I46 synchronous prepare callback cannot reenter a second explicit start", async () => {
  await mount("pending"); await page.evaluate(() => window.reviewMount.reenterPrepare()); await read();
  expect((await state()).metrics).toMatchObject({ request: 1, prepare: 1, start: 1 });
});
it("4I46 repeat renders preserve the original subscription and perform no transport observation during render", async () => {
  await mount(); await read(); await result();
  const before = (await state()).metrics.subscribe;
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.reviewMount.update("same"));
  expect((await state()).metrics.subscribe).toBe(before);
  expect((await state()).metrics).toMatchObject({ renderSideEffects: 0, request: 1 });
});

it("4I46 initially missing screen stays unavailable without factory, attachment or request", async () => {
  await page.evaluate((data) => { window.reviewMount = window.startReviewMount(data, "missing-screen"); }, data);
  expect(await page.locator("#state").textContent()).toContain('"status":"UNAVAILABLE"');
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("STALE_VIEW");
  expect((await state()).metrics).toMatchObject({ attach: 0, prepare: 0, start: 0, request: 0 });
});
it("4I46 cancel hides display but pending original I/O remains until both completions", async () => {
  await mount("pending"); await read(); await page.locator("#cancel").click();
  expect((await state()).retained).toMatchObject({ occupied: true, canForget: false });
  expect(await display()).toBeNull();
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.canForget);
  await page.locator("#release").click(); await empty();
});
it("4I46 an early error is also hidden by current dirty props before its commit", async () => {
  await mount("error"); await read();
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"error"'));
  const before = (await state()).renderLog.length;
  await page.evaluate(() => window.reviewMount.update("dirty"));
  expect((await state()).renderLog.slice(before).every((r) => r.display === null)).toBe(true);
  expect((await state()).retained.canForget).toBe(false);
});

it("4I46 synchronous signal setup can unmount before prepare returns a handle without losing internal completion", async () => {
  await mount("pending"); await page.evaluate(() => window.reviewMount.detachDuringConstruction());
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("STALE_VIEW");
  await empty();
  expect((await state()).metrics).toMatchObject({ prepare: 1, start: 0, request: 0, close: 0 });
});
it("4I46 completed detached I/O is observed on later subscription without a repeated request", async () => {
  await mount("pending"); await read(); await page.evaluate(() => window.reviewMount.unmount());
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await empty();
  await page.evaluate(() => window.reviewMount.remount());
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"status":"ATTACHED"'));
  expect((await state()).retained).toMatchObject({ occupied: false, canForget: true });
  expect((await state()).metrics).toMatchObject({ request: 1, close: 0, renderSideEffects: 0 });
  expect(await display()).toBeNull();
});
