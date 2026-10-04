import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { StudioCase } from "./studio-schema";
import type { VentureConnectionStatus } from "./venturein-schema";
import type { VentureWorkflowStatus } from "./venturein-workflow";
import type { VentureOverview } from "./venturein-overview-types";
import { resolveVentureGuidedNavigation } from "./venturein-guided-navigation";
import { VentureinGuidedEntry } from "@/components/studio/venturein-guided-entry";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-05T00:00:00.000Z";
function fixture() {
  const company = { id, revision: 4, profile: { companyName: "합성 안내 기업" } } as StudioCase;
  const connection: VentureConnectionStatus = {
    account: { saved: true, revision: 2, maskedLoginId: "s***", updatedAt: now },
    session: { state: "connected_unmapped", startedAt: now, updatedAt: now, message: "합성" },
    preparation: {
      planId: null,
      planVersion: null,
      planTitle: null,
      sections: [],
      attachments: [],
      blockers: [],
    },
    credentialStorage: "unavailable",
    automaticSubmissionAvailable: false,
  };
  const workflow: VentureWorkflowStatus = {
    revision: 3,
    updatedAt: now,
    snapshot: null,
    draft: null,
    execution: null,
    originalFiles: [],
    accountRevision: 2,
    session: { ...connection.session },
    report: {
      scope: "local-preflight",
      caseId: id,
      snapshotId: null,
      planId: null,
      readyForLocalReview: false,
      inputReadiness: { ready: false, blockingIssues: [], deferredIssues: [] },
      automaticSubmissionAvailable: false,
      companyVerification: {
        status: "unverified",
        expectedBusinessNumber: "",
        observedBusinessNumbers: [],
        reason: "합성",
      },
      issues: [],
      textFields: [],
      attachments: [],
    },
    journey: { phase: "inspect", message: "합성", entries: [] },
  };
  const target: VentureOverview = {
    caseId: id,
    companyRevision: 4,
    workflowRevision: 3,
    accountRevision: 2,
    accountSaved: true,
    sessionState: connection.session.state,
    sessionUpdatedAt: now,
    screenObservedAt: null,
    phase: "inspect",
    previousInputNeedsCheck: false,
    readAt: now,
    automaticSubmissionAvailable: false,
    officialStatusChecked: false,
    transmissionAllowed: false,
  };
  return { company, connection, workflow, target };
}
it.each([
  ["connect", "login"],
  ["inspect", "company"],
  ["map", "mapping"],
  ["review", "review"],
  ["execute", "execution"],
  ["verify", "execution"],
  ["handoff", "journey"],
] as const)("maps %s only to existing %s region without mutation or IO", (phase, section) => {
  const f = fixture();
  f.workflow.journey.phase = phase;
  f.target.phase = phase;
  const before = JSON.stringify(f);
  expect(
    resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow),
  ).toMatchObject({ valid: true, section });
  expect(JSON.stringify(f)).toBe(before);
});
it("prior uncertain execution is shown before disconnected login or account entry", () => {
  const f = fixture();
  f.connection.account.saved = false;
  f.target.accountSaved = false;
  f.connection.session.state = "idle";
  f.workflow.session.state = "idle";
  f.target.sessionState = "idle";
  f.workflow.journey.phase = "connect";
  f.target.phase = "connect";
  f.workflow.execution = {
    id: other,
    snapshotId: "past",
    status: "stopped",
    startedAt: now,
    finishedAt: null,
    completedFieldKeys: [],
    attachmentFieldKeys: [],
    attemptedFieldKey: "a",
    code: "INPUT_RESULT_UNKNOWN",
  };
  f.target.previousInputNeedsCheck = true;
  expect(
    resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow),
  ).toMatchObject({ valid: true, section: "execution" });
});
it("missing account and saved-but-disconnected account have different destinations", () => {
  const f = fixture();
  f.connection.account.saved = false;
  f.target.accountSaved = false;
  expect(
    resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow),
  ).toMatchObject({ valid: true, section: "account" });
  f.connection.account.saved = true;
  f.target.accountSaved = true;
  f.connection.session.state = "awaiting_auth";
  f.workflow.session.state = "awaiting_auth";
  f.target.sessionState = "awaiting_auth";
  expect(
    resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow),
  ).toMatchObject({ valid: true, section: "login" });
});
it.each([
  "company",
  "revision",
  "workflow",
  "account",
  "saved",
  "workflow-account",
  "session",
  "session-time",
  "workflow-session",
  "session-start",
  "report-company",
  "phase",
  "uncertain",
  "permission",
  "extra",
] as const)("declines changed %s without selecting another destination", (change) => {
  const f = fixture();
  switch (change) {
    case "company":
      f.company.id = other;
      break;
    case "revision":
      f.company.revision++;
      break;
    case "workflow":
      f.workflow.revision++;
      break;
    case "account":
      f.connection.account.revision++;
      break;
    case "saved":
      f.connection.account.saved = false;
      break;
    case "workflow-account":
      f.workflow.accountRevision++;
      break;
    case "session":
      f.connection.session.state = "idle";
      break;
    case "session-time":
      f.connection.session.updatedAt = null;
      break;
    case "workflow-session":
      f.workflow.session.state = "idle";
      break;
    case "session-start":
      f.workflow.session.startedAt = null;
      break;
    case "report-company":
      f.workflow.report.caseId = other;
      break;
    case "phase":
      f.workflow.journey.phase = "handoff";
      break;
    case "uncertain":
      f.target.previousInputNeedsCheck = true;
      break;
    case "permission":
      Object.assign(f.target, { transmissionAllowed: true });
      break;
    case "extra":
      Object.assign(f.target, { command: "start" });
      break;
  }
  const before = JSON.stringify(f);
  const result = resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow);
  expect(result.valid).toBe(false);
  expect(result).not.toHaveProperty("section");
  expect(JSON.stringify(f)).toBe(before);
});
it("checks saved screen and draft company identities as well as observation time", () => {
  const f = fixture();
  f.workflow.snapshot = {
    caseId: id,
    accountRevision: 2,
    sessionStartedAt: now,
    screen: {
      id: "s",
      observedAt: now,
      url: "https://www.smes.go.kr/venturein/aply/v2",
      title: "합성",
      fields: [],
      companyEvidence: [],
      truncated: false,
      warnings: [],
    },
  };
  f.target.screenObservedAt = now;
  expect(resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow).valid).toBe(
    true,
  );
  f.workflow.snapshot.caseId = other;
  expect(resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow).valid).toBe(
    false,
  );
  f.workflow.snapshot.caseId = id;
  f.target.screenObservedAt = null;
  expect(resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow).valid).toBe(
    false,
  );
  f.target.screenObservedAt = now;
  f.workflow.draft = {
    caseId: other,
    snapshotId: "s",
    companyRevision: 4,
    accountRevision: 2,
    sessionStartedAt: now,
    planId: null,
    planVersion: null,
    textMappings: [],
    attachmentMappings: [],
  };
  expect(resolveVentureGuidedNavigation(f.target, f.company, f.connection, f.workflow).valid).toBe(
    false,
  );
});
it("SSR displays local identity and mismatch only; creates no command, link or request", () => {
  const f = fixture();
  const guard = vi.fn(() => {
    throw Error("no fetch");
  });
  vi.stubGlobal("fetch", guard);
  try {
    const root = createRef<HTMLDivElement>();
    const html = renderToStaticMarkup(createElement(VentureinGuidedEntry, { ...f, root }));
    expect(html).toContain("합성 안내 기업");
    expect(html).toContain("s***");
    expect(html).toContain("실행하지 않았습니다");
    expect(html).not.toMatch(/<button|<a |<input|<script/);
    f.target.workflowRevision++;
    const changed = renderToStaticMarkup(createElement(VentureinGuidedEntry, { ...f, root }));
    expect(changed).toContain('role="alert"');
    expect(changed).not.toContain("이어서 확인할 부분:");
    expect(guard).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
