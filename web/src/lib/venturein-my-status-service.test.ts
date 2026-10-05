import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { emptyProfile } from "./studio-schema";
import type { VentureSessionStatus } from "./venturein-schema";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: null as StudioStore | null, decrypt: vi.fn() }));
vi.mock("@/lib/studio-storage", async (original) => ({
  ...(await original<typeof import("./studio-storage")>()), getStudioStore: () => state.store!,
}));
vi.mock("@/lib/venturein-vault", async (original) => ({
  ...(await original<typeof import("./venturein-vault")>()), readVentureAccount: state.decrypt,
}));
import * as route from "@/app/api/studio/cases/[caseId]/venturein/my-status/route";
import * as collector from "./venturein-my-status-collector";
import { readCurrentVentureMyStatus } from "./venturein-my-status-service";
import { getVentureSession } from "./venturein-runner";
import { ventureMyStatusUrl } from "./venturein-my-status";
import { myStatusExpected, myStatusHtml } from "./venturein-my-status-test-fixture";

// The production runner owns this process map. Seed only this isolated test's synthetic
// authenticated session; this is not a real login or evidence of authentication success.
type SyntheticSession = {
  status: VentureSessionStatus; cancelled: boolean; operationInProgress?: boolean;
  accountRevision?: number; authenticatedAt?: string; documentRevision: number;
  textInputTracking: true; browser: Browser; context: BrowserContext; page: Page;
};
const sessions = (globalThis as typeof globalThis & { __ventureinSessions: Map<string, SyntheticSession> }).__ventureinSessions;
let browser: Browser, context: BrowserContext, page: Page, session: SyntheticSession;
let dir: string, caseId: string, routed: number;
const tables = ["studio_cases", "venture_accounts", "venture_workflows", "studio_prepared_packages"];
function rows() {
  const db = new DatabaseSync(join(dir, "studio.sqlite"), { readOnly: true });
  try { return tables.map(t => db.prepare("SELECT * FROM " + t + " ORDER BY 1").all()); }
  finally { db.close(); }
}
const command = () => ({ action: "read-current-my-status", companyRevision: 0,
  accountRevision: 1, workflowRevision: 1, sessionStartedAt: session.status.startedAt!, confirmed: true });
function request(body: unknown = command(), suffix = "", origin = "http://localhost:3000") {
  return new Request(`http://localhost:3000/api/studio/cases/${caseId}/venturein/my-status${suffix}`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const read = (body: unknown = command()) => route.POST(request(body), { params: Promise.resolve({ caseId }) });
beforeAll(async () => { browser = await chromium.launch({ channel: "msedge", headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "venture-my-session-test-"));
  state.store = new StudioStore(dir);
  caseId = state.store.create({ ...emptyProfile(), companyName: "합성 읽기 회사", businessNumber: myStatusExpected.businessNumber }).id;
  state.store.saveVentureAccountEnvelope(caseId, 0, Buffer.from("synthetic-unusable-ciphertext"), "synthetic***");
  state.store.saveVentureWorkflowEnvelope(caseId, 0, JSON.stringify({ snapshot: null, draft: null, history: [] }));
  state.decrypt.mockReset().mockImplementation(() => { throw Error("Never decrypt for a read"); });
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("No external requests"); }));
  context = await browser.newContext({ serviceWorkers: "block" }); routed = 0;
  await context.route("**/*", async (r) => {
    routed++;
    if (!r.request().isNavigationRequest()) { await r.abort(); return; }
    await r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: myStatusHtml() });
  });
  page = await context.newPage();
  await page.goto(ventureMyStatusUrl + "?SYNTHETIC-PRIVATE-QUERY=1");
  const now = new Date().toISOString();
  session = { status: { state: "connected_unmapped", message: "synthetic", startedAt: now, updatedAt: now },
    cancelled: false, accountRevision: 1, authenticatedAt: now, documentRevision: 1,
    textInputTracking: true, browser, context, page };
  sessions.set(caseId, session);
  page.on("framenavigated", () => { session.documentRevision++; });
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled(); expect(state.decrypt).not.toHaveBeenCalled();
  sessions.delete(caseId);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await context?.close(); state.store?.close();
  const r = relative(resolve(tmpdir()), resolve(dir));
  if (!r.startsWith("venture-my-session-test-") || r.includes("..")) throw Error("Unsafe cleanup");
  rmSync(dir, { recursive: true, force: true });
});
it("reads real synthetic DOM through API/session/collector without DB, DOM, auth time or network changes", async () => {
  const before = rows(), html = await page.content(), originalSession = getVentureSession(caseId);
  const response = await read(), value = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(value).toMatchObject({ caseId, accountRevision: 1, companyRevision: 0, workflowRevision: 1,
    documentRevision: 1, scope: "company-screen", applicationAttribution: "unavailable-no-application-number",
    observation: { origin: "page-observation", target: { applicationNumber: null, state: "not-requested", row: null },
      officialStatusChecked: false, receiptVerified: false, databaseChanged: false, transmissionAllowed: false,
      certificateApplicationLink: "unverified" } });
  expect(value.observation.applications.rows).toHaveLength(2);
  expect(value.observation.certificates.rows).toHaveLength(1);
  expect(JSON.stringify(value)).not.toMatch(/PRIVATE|777-77|synthetic-unusable|synthetic\*|합성 읽기 회사|lastCheckedAt/);
  expect(rows()).toEqual(before); expect(await page.content()).toBe(html);
  expect(getVentureSession(caseId)).toEqual(originalSession); expect(routed).toBe(1);
  expect("GET" in route).toBe(false);
  state.store!.close(); state.store = new StudioStore(dir);
  expect(rows()).toEqual(before);
  sessions.delete(caseId);
  expect((await read()).status).toBe(409); expect(rows()).toEqual(before); expect(routed).toBe(1);
});
it.each(["companyRevision", "accountRevision", "workflowRevision", "sessionStartedAt"])(
  "rejects stale %s before reading any DOM", async (field) => {
    const spy = vi.spyOn(collector, "collectVentureMyStatus");
    const body = { ...command(), [field]: field === "sessionStartedAt" ? "2031-01-01T00:00:00.000Z" : 99 };
    const before = rows(); expect((await read(body)).status).toBe(409);
    expect(spy).not.toHaveBeenCalled(); expect(rows()).toEqual(before); expect(routed).toBe(1);
  });
it.each([
  { confirmed: false }, { applicationNumber: "SYNTHETIC-REQUEST-B" }, { receiptNumber: "SYNTHETIC-REQUEST-B" },
  { observation: { origin: "page-observation" } }, { businessNumber: "888-88-00002" },
  { credentials: { loginId: "PRIVATE" } }, { action: "start" }, { companyRevision: Number.MAX_SAFE_INTEGER + 1 },
])("rejects unauthorized request shape %j", async (extra) => {
  const spy = vi.spyOn(collector, "collectVentureMyStatus");
  expect((await read({ ...command(), ...extra })).status).toBe(400); expect(spy).not.toHaveBeenCalled();
});
it("rejects origin, query, media type, invalid JSON and over-limit bytes before collection", async () => {
  const spy = vi.spyOn(collector, "collectVentureMyStatus");
  const endpoint = request().url;
  const inputs = [request(command(), "?action=read"), request(command(), "", "https://example.invalid"),
    new Request(endpoint, { method: "POST", body: JSON.stringify(command()) }),
    new Request(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
    request({ ...command(), extra: "x".repeat(8192) })];
  for (const req of inputs) expect([400, 403, 413]).toContain((await route.POST(req, { params: Promise.resolve({ caseId }) })).status);
  expect(spy).not.toHaveBeenCalled();
});
it.each(["no-account-binding", "busy", "cancelled", "expired", "auth-missing", "auth-display-missing", "wrong-company", "unsupported-page"])(
  "does not navigate, retry login or collect a result for %s", async (kind) => {
    if (kind === "no-account-binding") delete session.accountRevision;
    if (kind === "busy") session.operationInProgress = true;
    if (kind === "cancelled") session.cancelled = true;
    if (kind === "expired") session.authenticatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    if (kind === "auth-missing") delete session.authenticatedAt;
    if (kind === "auth-display-missing") await page.locator('a[href$="logout"]').evaluate(e => e.remove());
    if (kind === "wrong-company") await page.locator("table td").first().evaluate(e => { e.textContent = "888-88-00002"; });
    if (kind === "unsupported-page") await page.goto("https://www.smes.go.kr/venturein/home/viewHome");
    const before = rows(), count = routed;
    const response = await read(); expect(response.status).toBe(409);
    expect(await response.text()).not.toMatch(/PRIVATE|777-77|888-88/);
    expect(rows()).toEqual(before); expect(routed).toBe(count);
  });
it("returns unsupported table states without guessing a receipt or application", async () => {
  await page.locator("#cert-scope").evaluate(e => { e.setAttribute("class", "unknown-layout"); });
  const response = await read(), value = await response.json();
  expect(response.status).toBe(200); expect(value.observation.certificates.state).toBe("unsupported");
  expect(value.observation.target.row).toBeNull(); expect(value.observation.receiptVerified).toBe(false);
});
it("holds the shared operation lock and copies the complete request before awaiting", async () => {
  const original = collector.collectVentureMyStatus;
  let release!: () => void;
  const spy = vi.spyOn(collector, "collectVentureMyStatus").mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve; }); return original(...args);
  });
  const body = command(), before = rows();
  const first = readCurrentVentureMyStatus(caseId, body);
  body.accountRevision = 99; body.sessionStartedAt = "changed";
  const duplicate = await read(); expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "VENTURE_BUSY" });
  release(); expect((await first).accountRevision).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1); expect(rows()).toEqual(before); expect(routed).toBe(1);
});
it.each(["account", "company", "workflow", "session", "document", "raw-url", "context"])(
  "discards a late observation when %s changes during the read", async (kind) => {
    const original = collector.collectVentureMyStatus;
    vi.spyOn(collector, "collectVentureMyStatus").mockImplementationOnce(async (...args) => {
      const observed = await original(...args);
      if (["account", "company", "workflow"].includes(kind)) {
        const other = new StudioStore(dir);
        try {
          if (kind === "account") other.saveVentureAccountEnvelope(caseId, 1, Buffer.from("new-synthetic-envelope"), "other***");
          if (kind === "company") other.mutate(caseId, { action: "profile", revision: 0,
            profile: { ...other.get(caseId).profile, paidInCapital: "10000000" } }, () => []);
          if (kind === "workflow") other.saveVentureWorkflowEnvelope(caseId, 1, JSON.stringify({ snapshot: null, draft: null, history: [] }));
        } finally { other.close(); }
      }
      if (kind === "session") sessions.set(caseId, { ...session });
      if (kind === "document") session.documentRevision++;
      if (kind === "raw-url") await page.evaluate(() => { history.replaceState(null, "", "?changed=1"); });
      if (kind === "context") session.context = {} as BrowserContext;
      return observed;
    });
    const response = await read(); expect(response.status).toBe(409);
    const value = await response.json(); expect(value).not.toHaveProperty("observation");
    expect(JSON.stringify(value)).not.toMatch(/SYNTHETIC-REQUEST|PRIVATE/);
    expect(routed).toBe(1); expect(session.operationInProgress).toBe(false);
  });
it("does not return low-level errors, retain observations or retry after a failed read", async () => {
  const spy = vi.spyOn(collector, "collectVentureMyStatus").mockRejectedValueOnce(Error("PRIVATE-CUSTOMER-URL"));
  const before = rows(); const response = await read();
  expect(response.status).toBe(409); expect(await response.text()).not.toContain("PRIVATE");
  expect(spy).toHaveBeenCalledTimes(1); expect(rows()).toEqual(before);
  expect((await read()).status).toBe(200); expect(spy).toHaveBeenCalledTimes(2);
});
