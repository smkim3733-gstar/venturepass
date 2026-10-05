import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { StudioCase } from "./studio-schema";
import type { VentureConnectionStatus } from "./venturein-schema";
import type { VentureWorkflowStatus } from "./venturein-workflow";
import { decodeVentureMyStatus } from "./venturein-my-status";
import { myStatusFixture, myStatusExpected } from "./venturein-my-status-test-fixture";
import { readVentureMyResult, ventureMyReadFailure, ventureMyReadContext, ventureMyReadCommand } from "./venturein-my-status-view";
import { VentureinMyStatusPanel, VentureMyStatusResults } from "@/components/studio/venturein-my-status-panel";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const now = "2031-04-01T01:00:00.000Z";
function fixture() {
  const company = { id, revision: 4, profile: { companyName: "합성 회사" } } as StudioCase;
  const connection: VentureConnectionStatus = {
    account: { saved: true, revision: 2, maskedLoginId: "s***", updatedAt: now },
    session: { state: "connected_unmapped", startedAt: now, updatedAt: now, message: "합성" },
    preparation: { planId: null, planVersion: null, planTitle: null, sections: [], attachments: [], blockers: [] },
    credentialStorage: "unavailable", automaticSubmissionAvailable: false,
  };
  const workflow: VentureWorkflowStatus = {
    revision: 3, updatedAt: now, snapshot: null, draft: null, execution: null, originalFiles: [],
    accountRevision: 2, session: { ...connection.session },
    report: { scope: "local-preflight", caseId: id, snapshotId: null, planId: null,
      readyForLocalReview: false, inputReadiness: { ready: false, blockingIssues: [], deferredIssues: [] },
      automaticSubmissionAvailable: false,
      companyVerification: { status: "unverified", expectedBusinessNumber: "", observedBusinessNumbers: [], reason: "합성" },
      issues: [], textFields: [], attachments: [] },
    journey: { phase: "inspect", message: "합성", entries: [] },
  };
  const context = ventureMyReadContext(company, connection, workflow)!;
  const result = { ...context, format: "venturepass-my-status-read-v1", documentRevision: 1,
    scope: "company-screen", applicationAttribution: "unavailable-no-application-number",
    observation: { ...decodeVentureMyStatus(myStatusFixture(), { ...myStatusExpected, applicationNumber: null }), origin: "page-observation" } };
  return { company, connection, workflow, context, result };
}
it("copies exact context/command and keeps result rows separate without IO or mutation", () => {
  const f = fixture(), before = JSON.stringify(f);
  const result = readVentureMyResult(f.result, f.context);
  expect(ventureMyReadCommand(f.context)).toEqual({ action: "read-current-my-status",
    companyRevision: 4, accountRevision: 2, workflowRevision: 3, sessionStartedAt: now, confirmed: true });
  expect(result.observation.applications.rows.map(r => r.applicationNumber)).toEqual(["SYNTHETIC-REQUEST-A", "SYNTHETIC-REQUEST-B"]);
  expect(result.observation.target).toEqual({ state: "not-requested", applicationNumber: null, row: null });
  expect(JSON.stringify(f)).toBe(before);
  result.observation.applications.rows[0].resultText = "changed";
  expect(JSON.stringify(f)).toBe(before);
});
it.each(["company", "account", "saved", "session-state", "session-start", "invalid-start", "negative-version"] as const)(
  "does not prepare a command for mismatched %s", kind => {
    const f = fixture();
    if (kind === "company") f.workflow.report.caseId = other;
    if (kind === "account") f.workflow.accountRevision++;
    if (kind === "saved") f.connection.account.saved = false;
    if (kind === "session-state") f.workflow.session.state = "awaiting_auth";
    if (kind === "session-start") f.workflow.session.startedAt = "2032-04-01T01:00:00.000Z";
    if (kind === "invalid-start") { f.workflow.session.startedAt = null; f.connection.session.startedAt = null; }
    if (kind === "negative-version") f.company.revision = -1;
    expect(ventureMyReadContext(f.company, f.connection, f.workflow)).toBeNull();
});
it.each(["caseId", "companyRevision", "accountRevision", "workflowRevision", "sessionStartedAt"] as const)(
  "rejects a different original %s", key => {
    const f = fixture();
    const value = key === "caseId" ? other : key === "sessionStartedAt" ? "2032-04-01T01:00:00.000Z" : 99;
    expect(() => readVentureMyResult({ ...f.result, [key]: value }, f.context)).toThrow();
});
it.each([
  { origin: "supplied-observation" }, { officialStatusChecked: true }, { transmissionAllowed: true },
  { databaseChanged: true }, { receiptVerified: true }, { certificateApplicationLink: "verified" },
  { target: { state: "matched", applicationNumber: "SYNTHETIC-REQUEST-B", row: null } },
  { url: "https://www.smes.go.kr/venturein/myVntr/viewMyVntr?private=1" }, { secret: "PRIVATE" },
])("rejects authority/extra/supplied response %j", changed => {
  const f = fixture();
  expect(() => readVentureMyResult({ ...f.result, observation: { ...f.result.observation, ...changed } }, f.context)).toThrow();
});
it.each(["duplicate-app", "duplicate-cert", "masked-id", "oversized-cell", "oversized-list", "unsupported-with-rows", "extra-field"] as const)(
  "rejects ambiguous or excessive %s", kind => {
    const f = fixture(), o = f.result.observation;
    if (kind === "duplicate-app" && o.applications.state === "observed") o.applications.rows.push(o.applications.rows[0]);
    if (kind === "duplicate-cert" && o.certificates.state === "observed") o.certificates.rows.push(o.certificates.rows[0]);
    if (kind === "masked-id") o.applications.rows[0].applicationNumber = "MASK***";
    if (kind === "oversized-cell") o.applications.rows[0].resultText = "x".repeat(501);
    if (kind === "oversized-list") o.applications.rows = Array.from({ length: 101 }, (_, i) => ({ ...o.applications.rows[0], applicationNumber: String(i) }));
    if (kind === "unsupported-with-rows") Object.assign(o.applications, { state: "unsupported", reason: "unsupported-content" });
    if (kind === "extra-field") Object.assign(f.result, { credentials: "PRIVATE" });
    expect(() => readVentureMyResult(f.result, f.context)).toThrow();
});
it("SSR is collapsed, does not read/save, and renders no result or auto-approved controls", () => {
  const f = fixture(), spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("forbidden"));
  try {
    const html = renderToStaticMarkup(createElement(VentureinMyStatusPanel, { ...f, blocked: false }));
    expect(html).toContain("현재 MY벤처현황 한 번 읽기");
    expect(html).not.toMatch(/<details[^>]* open|SYNTHETIC-REQUEST|<input|<script/);
    expect(spy).not.toHaveBeenCalled();
    const unavailable = renderToStaticMarkup(createElement(VentureinMyStatusPanel, { ...f, blocked: true }));
    expect(unavailable).toMatch(/<button[^>]*disabled/);
  } finally { spy.mockRestore(); }
});
it("renders long observed strings inertly, without combining company/application/certificate outcomes", () => {
  const f = fixture();
  f.result.observation.applications.rows[0].resultText = '<img src="https://example.invalid/a" onerror="bad()"> & ' + "합성".repeat(150);
  const value = readVentureMyResult(f.result, f.context);
  const html = renderToStaticMarkup(createElement(VentureMyStatusResults, { value }));
  expect(html).toContain("&lt;img");
  expect(html).not.toMatch(/<img|<a |<script|<input/);
  expect(html).toContain("SYNTHETIC-REQUEST-A"); expect(html).toContain("SYNTHETIC-REQUEST-B");
  expect(html).toContain("SYNTHETIC-CERT-9"); expect(html).toContain("로컬 신청 회차 연결 미확인");
  expect(html).toContain("합성".repeat(150));
});
it.each([
  ["observed", "읽은 표에 표시된 행이 없습니다."],
  ["not-present", "화면에서 해당 표를 찾지 못했습니다."],
  ["unsupported", "지원하지 않거나 모호한 표 구조입니다."],
] as const)("distinguishes %s from official absence", (state, message) => {
  const f = fixture();
  const observation = { ...f.result.observation, applications: state === "unsupported"
    ? { state, rows: [], reason: "unsupported-content" } : { state, rows: [] } };
  const value = readVentureMyResult({ ...f.result, observation }, f.context);
  expect(renderToStaticMarkup(createElement(VentureMyStatusResults, { value }))).toContain(message);
});

it.each([
  ["UNSUPPORTED_PAGE", "읽기를 지원하지 않습니다"],
  ["MY_STATUS_SESSION_CHANGED", "이 읽기를 사용할 수 없습니다"],
  ["PRIVATE-SYNTHETIC-CUSTOMER-VALUE", "현재 창을 읽지 못했습니다"],
])("uses only fixed safe guidance for read failure %s", (code, expected) => {
  const text = ventureMyReadFailure(code);
  expect(text).toContain(expected); expect(text).not.toContain("PRIVATE");
});
