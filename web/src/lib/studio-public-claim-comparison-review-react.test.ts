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
import { comparisonReviewSuccessWire, comparisonReviewErrorWire, type ComparisonReviewWireResult } from "./studio-public-claim-comparison-review-wire";
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

async function closedDisplay() {
  await page.waitForFunction(() => {
    const raw = document.querySelector("#state")?.textContent;
    if (!raw) return false;
    const value = JSON.parse(raw);
    return value.status === "NOT_ATTACHED" && value.display === null && value.canPrepare === false;
  });
}
it.each(["success", "error"] as const)("4I48 parentClose alone clears the displayed %s without props update or forced render", async (mode) => {
  await mount(mode); await read();
  if (mode === "success") await result();
  else await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"error"'));
  const before = await state();
  expect(await display()).not.toBeNull();
  await page.evaluate(() => window.reviewMount.parentClose());
  await closedDisplay();
  const after = await state();
  expect(after.frameOpen).toBe(true);
  expect(after.metrics).toMatchObject({ rendersRequested: before.metrics.rendersRequested,
    terminalNotifications: 1, request: 1, prepare: 1, start: 1, renderSideEffects: 0 });
  expect(after.retained.closed).toBe(true);
  if (mode === "error") {
    expect(after.retained).toMatchObject({ occupied: true, canForget: false });
    await page.evaluate(() => window.reviewMount.finishRequest()); await empty();
    expect((await state()).metrics.terminalNotifications).toBe(1);
  }
});
it("4I48 terminal UI notice does not release pending original I/O or resubscribe after late completion", async () => {
  await mount("pending"); await read(); await page.evaluate(() => window.reviewMount.parentClose()); await closedDisplay();
  const before = await state();
  expect(before.retained).toMatchObject({ closed: true, occupied: true, canForget: false });
  expect(before.signalAborted).toBe(true);
  await page.evaluate(() => window.reviewMount.finishResponse());
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.responseCompleted);
  expect((await state()).retained.occupied).toBe(true);
  await page.evaluate(() => window.reviewMount.finishRequest()); await empty();
  expect((await state()).metrics).toMatchObject({ notifications: before.metrics.notifications,
    subscribe: before.metrics.subscribe, request: 1, terminalNotifications: 1 });
  expect(await display()).toBeNull();
});
it.each(["cleanup-failed", "unavailable"] as const)("4I48 %s remains retained after visible terminal closure", async (mode) => {
  await mount(mode); await read();
  if (mode === "cleanup-failed") {
    await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(true); });
    await page.waitForFunction(() => window.reviewMount.snapshot().retained.requestCompleted);
  } else await page.waitForFunction(() => window.reviewMount.snapshot().retained.io?.requestStatus === "unavailable");
  await page.evaluate(() => window.reviewMount.parentClose()); await closedDisplay();
  expect((await state()).retained).toMatchObject({ closed: true, occupied: true, canForget: false });
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("CLOSED");
  expect((await state()).metrics).toMatchObject({ request: 1, terminalNotifications: 1 });
});
it.each(["child", "root"])("4I48 close followed by immediate %s unmount cancels its terminal subscription but retains the original call", async (kind) => {
  await mount("pending"); await read();
  await page.evaluate((kind) => {
    window.reviewMount.parentClose();
    if (kind === "root") window.reviewMount.dispose(); else window.reviewMount.unmount();
  }, kind);
  expect(await page.locator("#state").count()).toBe(0);
  expect((await state()).metrics.terminalNotifications).toBe(0);
  expect((await state()).retained).toMatchObject({ closed: true, occupied: true });
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await empty(); expect((await state()).metrics.request).toBe(1);
});
it("4I48 close before React subscription does not attach a replacement or create a request", async () => {
  await page.evaluate((data) => { window.reviewMount = window.startReviewMount(data, "close-on-attach"); }, data);
  await closedDisplay();
  expect((await state()).metrics).toMatchObject({ request: 0, prepare: 0, start: 0, close: 1, terminalNotifications: 0 });
  expect((await state()).retained).toMatchObject({ closed: true, occupied: false });
});
it.each(["prepare", "construction"])("4I48 close during %s never starts another request or loses hidden completion", async (kind) => {
  await mount("pending");
  await page.evaluate((kind) => kind === "prepare" ? window.reviewMount.closeDuringPrepare() : window.reviewMount.closeDuringConstruction(), kind);
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("CLOSED");
  await closedDisplay(); await empty();
  expect((await state()).metrics).toMatchObject({ request: 0, prepare: 1,
    start: kind === "prepare" ? 1 : 0, close: 1, terminalNotifications: 1 });
});
it("4I48 repeated parent close and later StrictMode remount cannot create a fresh holder or resurrect display", async () => {
  await mount("pending"); await read(); await page.evaluate(() => window.reviewMount.parentClose()); await closedDisplay();
  await page.evaluate(() => { window.reviewMount.parentClose(); window.reviewMount.parentClose(); });
  expect((await state()).metrics.terminalNotifications).toBe(1);
  await page.evaluate(() => window.reviewMount.remount()); await closedDisplay();
  expect(await page.evaluate(() => window.reviewMount.read())).toBe("STALE_VIEW");
  expect((await state()).retained).toMatchObject({ closed: true, occupied: true, canForget: false });
  expect((await state()).metrics).toMatchObject({ request: 1, terminalNotifications: 1, renderSideEffects: 0 });
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await empty(); expect(await display()).toBeNull();
});

/** 4I52 variants are synthetic presentation tests, never SQL export provenance. */
async function mount52(change?: (value: ComparisonReviewWireResult) => void, count = 1,
  mode: Parameters<Window["startReviewMount"]>[1] = "success") {
  const f = comparisonReviewTestFixture(count), value = f.value();
  change?.(value);
  const wire = comparisonReviewSuccessWire(f.query, value);
  const fixture = { snapshot: { id: value.resultIdentity.selection.companyId, revision: 7 },
    expected: { ...f.query, selection: value.resultIdentity.selection, binding: value.resultIdentity.binding,
      sectionKey: value.historical.prepared.input.section.key }, query: f.query,
    success: wire, error: comparisonReviewErrorWire("READ_BLOCKED") };
  await page.evaluate(({ fixture, mode }) => { window.reviewMount = window.startReviewMount(fixture, mode); }, { fixture, mode });
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"status":"ATTACHED"'));
  return value;
}
const opinion52 = (value: Awaited<ReturnType<typeof mount52>>) => value.historical.result.comparison!.comparison;
it.each([
  ["provided-text-support", "제공된 발췌가 뒷받침함"],
  ["provided-text-conflict", "제공된 발췌와 상충함"],
  ["insufficient", "근거 부족"],
  ["undetermined", "판단 유보"],
] as const)("4I52 displays the stored %s relation and exact overall/evidence reasons", async (relation, label) => {
  const value = await mount52((value) => {
    const opinion = opinion52(value);
    opinion.overall = { relation, reason: "Overall <script>alert(1)</script>\n原文 그대로" };
    opinion.evidence[0].relation = relation;
    opinion.evidence[0].reason = "Evidence & original\n수치 0";
  });
  expect(await page.getByTestId("example-result").count()).toBe(0);
  expect((await state()).metrics.request).toBe(0);
  await read(); await result();
  expect(await page.getByTestId("overall-relation").textContent()).toBe("전체 판단: " + label);
  expect(await page.getByTestId("overall-reason").textContent()).toBe(opinion52(value).overall.reason);
  const evidence = page.locator('[data-source-id="' + opinion52(value).evidence[0].sourceId + '"]');
  expect(await evidence.getByText("근거 판단: " + label, { exact: true }).count()).toBe(1);
  expect(await evidence.getByText(opinion52(value).evidence[0].reason, { exact: true }).count()).toBe(1);
  expect(await page.getByTestId("example-result").locator("script").count()).toBe(0);
  expect((await state()).metrics).toMatchObject({ request: 1, renderSideEffects: 0 });
});
it("4I52 reversed opinions retain each original source title, excerpt, quote and note by sourceId", async () => {
  const value = await mount52((value) => {
    const opinion = opinion52(value);
    opinion.evidence.forEach((e, i) => { e.reason = "원래 근거 " + i; e.nextCheck = "  Note " + i + "\n原文  "; });
    opinion.evidence.reverse();
    opinion.checks = [
      { dimension: "period", sourceIds: [opinion.evidence[0].sourceId], message: "기간 메모 원문" },
      { dimension: "other", sourceIds: [], message: "전체 메모 원문" },
    ];
  }, 2);
  await read(); await result();
  for (const source of value.historical.prepared.input.selectedEvidence) {
    const evidence = page.locator('[data-source-id="' + source.sourceId + '"]');
    const stored = opinion52(value).evidence.find((e) => e.sourceId === source.sourceId)!;
    expect(await evidence.getByRole("heading", { name: source.metadata.title, exact: true }).count()).toBe(1);
    expect(await evidence.locator("blockquote").allTextContents()).toEqual(stored.quotes);
    expect(await evidence.getByTestId("next-check").textContent()).toBe(stored.nextCheck);
    expect(await evidence.getByTestId("source-excerpt").isVisible()).toBe(false);
    await evidence.locator("summary").click();
    expect(await evidence.getByTestId("source-excerpt").isVisible()).toBe(true);
    expect(await evidence.getByTestId("source-excerpt").textContent()).toBe(source.excerpt);
  }
  const source = value.historical.prepared.input.selectedEvidence.find((e) => e.sourceId === opinion52(value).checks[0].sourceIds[0])!;
  expect(await page.getByText("기간 · " + source.metadata.title, { exact: true }).count()).toBe(1);
  expect(await page.getByText("기타 · 전체 근거", { exact: true }).count()).toBe(1);
  expect((await state()).metrics.request).toBe(1);
});
it.each(["", " \n\t"])( "4I52 blank stored note %j creates no invented next action or quote", async (nextCheck) => {
  await mount52((value) => { const e = opinion52(value).evidence[0]; e.nextCheck = nextCheck; e.quotes = []; });
  await read(); await result();
  expect(await page.getByTestId("next-check").textContent()).toBe("저장된 추가 확인 메모가 없습니다.");
  expect(await page.getByTestId("example-result").locator("blockquote").count()).toBe(0);
  expect(await page.getByRole("region", { name: "검토 시 확인할 항목" }).count()).toBe(0);
  expect(await page.getByTestId("example-result").textContent()).not.toContain("다음 확인: 원문 출처");
});
it("4I52 long stored reasons and notes are preserved without truncation or added requests", async () => {
  const value = await mount52((value) => {
    opinion52(value).overall.reason = "原".repeat(2000);
    opinion52(value).evidence[0].nextCheck = "확".repeat(1998) + "\n끝";
  });
  await read(); await result();
  expect(await page.getByTestId("overall-reason").textContent()).toBe(opinion52(value).overall.reason);
  expect(await page.getByTestId("next-check").textContent()).toBe(opinion52(value).evidence[0].nextCheck);
  expect((await state()).metrics.request).toBe(1);
});
it.each(["unknown-source", "duplicate-source", "foreign-quote", "unknown-check"] as const)(
  "4I52 invalid %s response cannot display a mismatched opinion", async (fault) => {
    const f = comparisonReviewTestFixture(2), value = f.value();
    const wire = JSON.parse(comparisonReviewSuccessWire(f.query, value));
    const opinion = wire.result.historical.result.comparison.comparison;
    if (fault === "unknown-source") opinion.evidence[0].sourceId = "00000000-0000-4000-8000-000000000000";
    if (fault === "duplicate-source") opinion.evidence[0].sourceId = opinion.evidence[1].sourceId;
    if (fault === "foreign-quote") opinion.evidence[0].quotes = ["존재하지 않는 인용"];
    if (fault === "unknown-check") opinion.checks = [{ dimension: "other",
      sourceIds: ["00000000-0000-4000-8000-000000000000"], message: "근거 없음" }];
    const fixture = { ...data, snapshot: { id: value.resultIdentity.selection.companyId, revision: 7 },
      expected: { ...f.query, selection: value.resultIdentity.selection, binding: value.resultIdentity.binding,
        sectionKey: value.historical.prepared.input.section.key }, query: f.query, success: JSON.stringify(wire) };
    await page.evaluate((fixture) => { window.reviewMount = window.startReviewMount(fixture, "success"); }, fixture);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"status":"ATTACHED"'));
    await read();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"error"'));
    expect(await page.getByTestId("example-result").count()).toBe(0);
    expect((await state()).metrics.request).toBe(1);
});
it.each(["snapshot", "revision", "selection", "dirty", "blocked", "closed", "aborted"])(
  "4I52 current %s change removes the full opinion DOM without rereading", async (kind) => {
    await mount52(); await read(); await result();
    expect(await page.getByTestId("example-result").count()).toBe(1);
    await page.evaluate((kind) => window.reviewMount.update(kind), kind);
    expect(await page.getByTestId("example-result").count()).toBe(0);
    await page.evaluate(() => window.reviewMount.update("restore"));
    expect(await page.getByTestId("example-result").count()).toBe(0);
    expect((await state()).metrics).toMatchObject({ request: 1, renderSideEffects: 0 });
});
it("4I52 parent close removes all opinion text without changing parent props", async () => {
  await mount52(); await read(); await result();
  const before = await state();
  expect(await page.getByTestId("example-result").count()).toBe(1);
  await page.evaluate(() => window.reviewMount.parentClose()); await closedDisplay();
  expect(await page.getByTestId("example-result").count()).toBe(0);
  expect((await state()).frameOpen).toBe(true);
  expect((await state()).metrics).toMatchObject({ request: 1, rendersRequested: before.metrics.rendersRequested,
    terminalNotifications: 1, renderSideEffects: 0 });
});

const noOpinionCases53 = [
  [
    "comparison-rejected",
    "저장된 응답이 비교 검증을 통과하지 못해 표시할 의견이 없습니다."
  ],
  [
    "response-incomplete",
    "저장된 응답이 완료되지 않아 표시할 비교 의견이 없습니다."
  ],
  [
    "response-unsupported",
    "저장된 응답 형식이 지원 범위와 맞지 않아 표시할 비교 의견이 없습니다."
  ],
  [
    "model-mismatch",
    "저장된 응답의 모델이 원래 요청과 일치하지 않아 표시할 비교 의견이 없습니다."
  ]
] as const;
type NoOpinionState53 = (typeof noOpinionCases53)[number][0];
async function mount53(storedState: NoOpinionState53 = "comparison-rejected",
  mode: Parameters<Window["startReviewMount"]>[1] = "success") {
  return mount52((value) => {
    value.historical.result.state = storedState;
    value.historical.result.comparison = null;
  }, 1, mode);
}
it.each(noOpinionCases53)("4I53 accepted %s shows stored status without invented opinion or automatic request", async (storedState, message) => {
  const original = await mount53(storedState);
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  expect((await state()).metrics).toMatchObject({ request: 0, layoutSetup: 2, layoutCleanup: 1 });
  await read(); await result();
  expect(await page.getByTestId("stored-state-message").textContent()).toBe(message);
  expect(await page.getByTestId("example-result").count()).toBe(0);
  expect(await page.getByTestId("example-result-state").locator("blockquote,button,a").count()).toBe(0);
  expect((await display()).result).toEqual(original);
  expect((await state()).metrics).toMatchObject({ request: 1, queryMatches: 1, renderSideEffects: 0 });
  const before = await state();
  await page.evaluate(() => window.reviewMount.parentClose()); await closedDisplay();
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  expect((await state()).frameOpen).toBe(true);
  expect((await state()).metrics).toMatchObject({ request: 1, terminalNotifications: 1,
    rendersRequested: before.metrics.rendersRequested });
});
it.each(["snapshot", "revision", "selection", "dirty", "blocked", "closed", "aborted"])(
  "4I53 current %s change removes stored no-opinion notice before commit without rereading", async (kind) => {
    await mount53("model-mismatch"); await read(); await result();
    const before = (await state()).renderLog.length;
    expect(await page.getByTestId("example-result-state").count()).toBe(1);
    await page.evaluate((kind) => window.reviewMount.update(kind), kind);
    expect(await page.getByTestId("example-result-state").count()).toBe(0);
    expect((await state()).renderLog.slice(before).every((r) => r.display === null)).toBe(true);
    await page.evaluate(() => window.reviewMount.update("restore"));
    expect(await page.getByTestId("example-result-state").count()).toBe(0);
    expect((await state()).metrics.request).toBe(1);
});
it("4I53 release clears a stored no-opinion notice without another request", async () => {
  await mount53("response-unsupported"); await read(); await result();
  expect(await page.getByTestId("example-result-state").count()).toBe(1);
  await page.locator("#release").click(); await empty();
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  expect((await state()).metrics.request).toBe(1);
});
it("4I53 pending no-opinion response is not displayed until original request completion", async () => {
  await mount53("response-incomplete", "pending"); await read();
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  await page.evaluate(() => window.reviewMount.finishResponse());
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.responseCompleted);
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  expect((await state()).retained).toMatchObject({ occupied: true, canForget: false });
  await page.evaluate(() => window.reviewMount.finishRequest()); await result();
  expect(await page.getByTestId("stored-state-message").textContent()).toBe(noOpinionCases53[1][1]);
  expect((await state()).metrics.request).toBe(1);
});
it("4I53 cancellation retains pending I/O and late no-opinion response cannot resurrect the notice", async () => {
  await mount53("response-incomplete", "pending"); await read();
  await page.locator("#cancel").click();
  expect((await state()).retained).toMatchObject({ occupied: true, canForget: false });
  await page.evaluate(() => { window.reviewMount.finishResponse(); window.reviewMount.finishRequest(); });
  await page.waitForFunction(() => window.reviewMount.snapshot().retained.canForget);
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  expect(await display()).toBeNull();
  expect((await state()).metrics.request).toBe(1);
});
it.each(["comparison-rejected", "response-incomplete", "response-unsupported", "model-mismatch",
  "ready-without-opinion", "unknown-state"] as const)(
  "4I53 malformed %s wire cannot masquerade as accepted stored status", async (fault) => {
    const f = comparisonReviewTestFixture(), value = f.value();
    const wire = JSON.parse(comparisonReviewSuccessWire(f.query, value));
    if (fault === "ready-without-opinion") wire.result.historical.result.comparison = null;
    else wire.result.historical.result.state = fault; // Deliberately invalid: non-ready still has an opinion.
    const fixture = { ...data, snapshot: { id: value.resultIdentity.selection.companyId, revision: 7 },
      expected: { ...f.query, selection: value.resultIdentity.selection, binding: value.resultIdentity.binding,
        sectionKey: value.historical.prepared.input.section.key }, query: f.query, success: JSON.stringify(wire) };
    await page.evaluate((fixture) => { window.reviewMount = window.startReviewMount(fixture, "success"); }, fixture);
    await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"status":"ATTACHED"'));
    await read();
    await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"error"'));
    expect(await page.getByTestId("example-result-state").count()).toBe(0);
    expect(await page.getByTestId("example-result").count()).toBe(0);
    expect((await state()).metrics.request).toBe(1);
});
it("4I53 a transport error is not shown as a stored no-opinion state and retains unknown I/O", async () => {
  await mount53("response-incomplete", "error"); await read();
  await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"kind":"error"'));
  expect(await page.getByTestId("example-result-state").count()).toBe(0);
  expect((await state()).retained).toMatchObject({ occupied: true, canForget: false });
  await page.evaluate(() => window.reviewMount.parentClose()); await closedDisplay();
  expect((await state()).retained.occupied).toBe(true);
  await page.evaluate(() => window.reviewMount.finishRequest()); await empty();
  expect((await state()).metrics.request).toBe(1);
});
