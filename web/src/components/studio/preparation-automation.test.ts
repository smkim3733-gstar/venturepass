import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  canRequestPreparationAutomation,
  type PreparationAutomationBatch,
  type PreparationAutomationEvent,
} from "@/lib/studio-preparation-automation-types";
import { preparationAutomationRequestDigest } from "@/lib/studio-preparation-automation";
import {
  automationAcknowledged,
  automationActionKey,
  automationChoiceAction,
  automationFailureRejected,
  automationInputDigest,
  automationNextAction,
  automationPendingEvents,
  automationReconcile,
  automationResponse,
  automationSnapshot,
  sendAutomationRequest,
  type AutomationInput,
  type AutomationPending,
} from "./preparation-automation-ui";
import {
  PreparationAutomationPanel,
  PreparationAutomationBatchView,
  automationStatusLabels,
} from "./preparation-automation-panel";
import { PreparationPanel } from "./preparation-panel";

vi.mock("server-only", () => ({}));
const id = "11111111-1111-4111-8111-111111111111";
const nonce = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const settingId = "55555555-5555-4555-8555-555555555555";
const runId = "66666666-6666-4666-8666-666666666666";
const extraId = "77777777-7777-4777-8777-777777777777";
const hash = "a".repeat(64);
const now = "2026-09-26T00:00:00.000Z";
const company = (): StudioCase =>
  caseSchema.parse({
    id,
    revision: 10,
    profile: { ...emptyProfile(), companyName: "가상 연결 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    createdAt: now,
    updatedAt: now,
  });
function enabled() {
  const next = company();
  next.preparationAutomation.caseId = id;
  next.preparationAutomation.settings = [
    {
      id: settingId,
      clientRequestId: settingId,
      inputDigest: hash,
      version: 1,
      enabled: true,
      baselineFingerprint: hash,
      at: now,
    },
  ];
  return next;
}
function event(overrides: Partial<PreparationAutomationEvent> = {}): PreparationAutomationEvent {
  return {
    id: eventId,
    kind: "profile",
    targetId: id,
    targetVersion: "10",
    change: "updated",
    sourceReadiness: null,
    beforeSha256: hash,
    afterSha256: hash,
    changeDigest: hash,
    settingVersion: 1,
    companyRevision: 10,
    at: now,
    ...overrides,
  };
}
function batch(overrides: Partial<PreparationAutomationBatch> = {}): PreparationAutomationBatch {
  return {
    id: batchId,
    settingVersion: 1,
    inputFingerprint: hash,
    eventIds: [eventId],
    pendingSourceIds: [],
    agencyRecordIds: [],
    status: "awaiting_review",
    code: null,
    command: null,
    preparationRunId: null,
    requests: [{ clientRequestId: nonce, digest: hash, preparationRequestId: null }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
async function pending(input: Partial<AutomationInput> = {}): Promise<AutomationPending> {
  const request = {
    action: "run-pending",
    revision: 10,
    clientRequestId: nonce,
    expectedSettingVersion: 1,
    ...input,
  } as AutomationInput;
  return { companyId: id, input: request, digest: await automationInputDigest(request) };
}
function acknowledged(request: AutomationPending) {
  const next = enabled();
  next.revision = 12;
  if (request.input.action === "set-preparation-automation") {
    next.preparationAutomation.settings.push({
      id: extraId,
      clientRequestId: nonce,
      inputDigest: request.digest,
      version: request.input.expectedSettingVersion + 1,
      enabled: request.input.enabled,
      baselineFingerprint: hash,
      at: now,
    });
  } else {
    next.preparationAutomation.batches = [
      batch({
        requests: [{ clientRequestId: nonce, digest: request.digest, preparationRequestId: null }],
      }),
    ];
  }
  return next;
}
function chosen() {
  const next = enabled();
  next.analysis = {
    summary: "가상 요약",
    generatedAt: now,
    sourceRevision: 1,
    mode: "assisted",
    facts: [],
    questions: [],
    warnings: [],
    candidates: [
      {
        id: "choice",
        title: "가상 후보",
        problem: "문제",
        solution: "해결",
        targetCustomer: "고객",
        differentiation: "검토",
        stage: "개발",
        businessModel: "판매",
        recommendation: "검토 필요",
        evidence: [],
        gaps: [],
      },
    ],
  };
  next.selectedCandidateId = "choice";
  next.candidateSelections = [
    {
      id: extraId,
      clientRequestId: extraId,
      inputDigest: hash,
      recordedAt: now,
      origin: "manual",
      event: "selection",
      reason: "가상 근거 확인",
      previousCandidateId: null,
      candidateId: "choice",
      analysisGeneratedAt: now,
      analysisSourceRevision: 1,
      analysisMode: "assisted",
      analysisDigest: hash,
      candidateDigest: hash,
      candidate: structuredClone(next.analysis.candidates[0]),
      previousCandidate: null,
      previousContext: "none",
      previousRecordId: null,
    },
  ];
  next.preparationRuns = [
    {
      id: runId,
      mode: "assisted",
      inputFingerprint: hash,
      criteriaVersion: "test",
      sourceRevision: 1,
      createdAt: now,
      updatedAt: now,
      status: "awaiting_choice",
      phase: "choice",
      stale: false,
      code: null,
      diagnosisId: null,
      analysisDigest: hash,
      candidates: [{ id: "choice", digest: hash }],
      selectedCandidateId: null,
      selectedCandidateDigest: null,
      planId: null,
      planDigest: null,
      steps: [],
      requests: [{ clientRequestId: extraId, digest: hash }],
    },
  ];
  next.preparationAutomation.batches = [
    batch({ status: "awaiting_choice", preparationRunId: runId }),
  ];
  return next;
}

describe("automatic preparation admission", () => {
  it("legacy is off and enabling produces no retroactive work", () => {
    expect(automationNextAction(company())).toBeNull();
    expect(automationNextAction(enabled())).toBeNull();
  });
  it("coalesces only current permission unassigned events", () => {
    const next = enabled();
    next.preparationAutomation.events = [
      event(),
      event({ id: extraId, kind: "source", sourceReadiness: "pending" }),
      event({ id: nonce, settingVersion: 0 }),
    ];
    expect(automationPendingEvents(next).map((item) => item.id)).toEqual([eventId, extraId]);
    expect(automationNextAction(next)).toEqual({ action: "run-pending" });
    next.preparationAutomation.batches = [batch({ eventIds: [eventId, extraId] })];
    expect(automationNextAction(next)).toBeNull();
  });
  it.each(["running", "failed"] as const)("never auto resumes %s", (status) => {
    const next = enabled();
    next.preparationAutomation.events = [event()];
    next.preparationAutomation.batches = [batch({ status, eventIds: [extraId] })];
    expect(automationNextAction(next)).toBeNull();
  });
  it("stops at overflow or another company's state", () => {
    const next = enabled();
    next.preparationAutomation.events = [event()];
    next.preparationAutomation.overflow = { at: now, companyRevision: 10, changeDigest: hash };
    expect(automationNextAction(next)).toBeNull();
    next.preparationAutomation.overflow = null;
    next.preparationAutomation.caseId = extraId;
    expect(automationNextAction(next)).toBeNull();
  });
  it("does not turn a refreshed revision into a retry key", () => {
    const next = enabled();
    next.preparationAutomation.events = [event()];
    const before = automationActionKey(next, { action: "run-pending" });
    next.revision++;
    expect(automationActionKey(next, { action: "run-pending" })).toBe(before);
    next.preparationAutomation.events.push(event({ id: extraId }));
    expect(automationActionKey(next, { action: "run-pending" })).not.toBe(before);
  });
  it("continues only a current explicitly reasoned choice", () => {
    const next = chosen();
    expect(automationNextAction(next)).toEqual({
      action: "continue-batch",
      batchId,
      candidateId: "choice",
      candidateDigest: hash,
    });
    next.candidateSelections = [];
    expect(automationNextAction(next)).toBeNull();
  });
  it.each(["stale", "missing", "changed", "duplicate", "old-setting"])(
    "rejects %s choice context",
    (mode) => {
      const next = chosen();
      if (mode === "stale") next.preparationRuns[0].stale = true;
      if (mode === "missing") next.preparationRuns = [];
      if (mode === "changed") next.analysis!.candidates[0].title = "새 후보";
      if (mode === "duplicate") next.preparationRuns.push(next.preparationRuns[0]);
      if (mode === "old-setting") next.preparationAutomation.batches[0].settingVersion = 0;
      expect(automationChoiceAction(next, next.preparationAutomation.batches[0])).toBeNull();
    },
  );
  const admission = {
    enabled: true,
    overflow: false,
    sameCompanyRevision: true,
    visible: true,
    dirty: false,
    busy: false,
    officialInput: false,
  };
  it.each([
    "enabled",
    "overflow",
    "sameCompanyRevision",
    "visible",
    "dirty",
    "busy",
    "officialInput",
  ] as const)("blocks unsafe %s admission", (field) => {
    expect(canRequestPreparationAutomation({ ...admission, [field]: !admission[field] })).toBe(
      false,
    );
  });
});

describe("immutable request and response reconciliation", () => {
  it("sends exact immutable POST only once even when response is lost", async () => {
    const request = await pending();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("lost"));
    await expect(sendAutomationRequest(request, transport)).rejects.toThrow("lost");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe(`/api/studio/cases/${id}/preparation-automation`);
    expect(transport.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual(request.input);
  });
  it("uses case PATCH only for the exact setting toggle", async () => {
    const request = await pending({ action: "set-preparation-automation", enabled: false });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(acknowledged(request)));
    const response = await sendAutomationRequest(request, transport);
    expect(transport.mock.calls[0][0]).toBe(`/api/studio/cases/${id}`);
    expect(transport.mock.calls[0][1]?.method).toBe("PATCH");
    expect(automationResponse(response.value, request)).not.toBeNull();
  });
  it.each([400, 403, 409, 413, 415, 422])(
    "classifies pre-check %s but accepted checkpoint wins",
    (status) => {
      expect(automationFailureRejected(status, { code: "TEST" })).toBe(true);
      expect(automationFailureRejected(status, { accepted: true })).toBe(false);
    },
  );
  it("keeps unknown server failure ambiguous unless server proves rejection", () => {
    expect(automationFailureRejected(500, {})).toBe(false);
    expect(automationFailureRejected(500, { accepted: false })).toBe(true);
  });
  it.each([
    { action: "run-pending" },
    { action: "resume-batch", batchId },
    { action: "continue-batch", batchId, candidateId: "choice", candidateDigest: hash },
    { action: "set-preparation-automation", enabled: false },
  ] as const)("browser digest matches server for $action", async (action) => {
    const request = await pending(action);
    expect(request.digest).toBe(preparationAutomationRequestDigest(request.input));
    expect(
      await automationInputDigest({ ...request.input, revision: 999, clientRequestId: extraId }),
    ).toBe(request.digest);
  });
  it("accepts exact batch and refuses a different response batch", async () => {
    const request = await pending();
    const next = acknowledged(request);
    expect(
      automationResponse({ company: next, batch: next.preparationAutomation.batches[0] }, request)
        ?.id,
    ).toBe(id);
    const other = batch({
      id: extraId,
      requests: [{ clientRequestId: extraId, digest: hash, preparationRequestId: null }],
    });
    next.preparationAutomation.batches.push(other);
    expect(automationResponse({ company: next, batch: other }, request)).toBeNull();
  });
  it.each(["digest", "nonce", "company", "revision", "duplicate", "setting", "target"])(
    "refuses altered %s receipt",
    async (mode) => {
      const request = await pending({ action: "resume-batch", batchId });
      const next = acknowledged(request);
      if (mode === "digest")
        next.preparationAutomation.batches[0].requests[0].digest = "b".repeat(64);
      if (mode === "nonce")
        next.preparationAutomation.batches[0].requests[0].clientRequestId = extraId;
      if (mode === "company") next.id = extraId;
      if (mode === "revision") next.revision = 9;
      if (mode === "duplicate")
        next.preparationAutomation.batches[0].requests.push(
          next.preparationAutomation.batches[0].requests[0],
        );
      if (mode === "setting") next.preparationAutomation.caseId = extraId;
      if (mode === "target") next.preparationAutomation.batches[0].id = extraId;
      expect(automationAcknowledged(next, request)).toBe(false);
    },
  );
  it("settings require exact requested value and next version", async () => {
    const request = await pending({ action: "set-preparation-automation", enabled: false });
    const next = acknowledged(request);
    expect(automationResponse(next, request)?.id).toBe(id);
    next.preparationAutomation.settings.at(-1)!.enabled = true;
    expect(automationResponse(next, request)).toBeNull();
    next.preparationAutomation.settings.at(-1)!.enabled = false;
    next.preparationAutomation.settings.at(-1)!.version = 5;
    expect(automationResponse(next, request)).toBeNull();
  });
  it("later off does not restore an earlier acknowledged on", async () => {
    const request = await pending({ action: "set-preparation-automation", enabled: true });
    const next = acknowledged(request);
    next.preparationAutomation.settings.push({
      ...next.preparationAutomation.settings.at(-1)!,
      id: runId,
      clientRequestId: runId,
      version: 3,
      enabled: false,
    });
    expect(automationResponse(next, request)?.preparationAutomation.settings.at(-1)?.enabled).toBe(
      false,
    );
  });
  it("GET durable ACK wins over a reported rejection", async () => {
    const request = await pending();
    const next = acknowledged(request);
    expect(automationReconcile(next, false, request, true)).toBe("acknowledged");
    expect(automationReconcile(next, true, request, false)).toBe("acknowledged");
  });
  it("missing receipt never proves a network request failed", async () => {
    const request = await pending();
    const next = enabled();
    expect(automationReconcile(next, false, request, false)).toBe("unknown");
    expect(automationReconcile(next, true, request, true)).toBe("unknown");
    expect(automationReconcile(next, false, request, true)).toBe("rejected");
  });
  it("conflicting durable receipt never unlocks even definite rejection", async () => {
    const request = await pending();
    const next = acknowledged(request);
    next.preparationAutomation.batches[0].requests[0].digest = hash;
    expect(automationReconcile(next, false, request, true)).toBe("unknown");
  });
  it.each(["foreign", "older", "active-missing", "bad-body", "duplicate"])(
    "rejects %s GET snapshot",
    (mode) => {
      const next = enabled();
      const raw: Record<string, unknown> = { company: next, active: false };
      if (mode === "foreign") next.id = extraId;
      if (mode === "older") next.revision = 9;
      if (mode === "active-missing") delete raw.active;
      if (mode === "bad-body") raw.company = {};
      if (mode === "duplicate")
        next.preparationAutomation.settings.push(next.preparationAutomation.settings[0]);
      expect(automationSnapshot(raw, { id, revision: 10 })).toBeNull();
    },
  );
});

describe("local-only preparation UI", () => {
  function render(next = company(), extras = {}) {
    const callbacks = {
      onBusyChange: vi.fn(),
      onCompany: vi.fn(),
      onUnsettledChange: vi.fn(),
      goTo: vi.fn(),
    };
    return {
      callbacks,
      html: renderToStaticMarkup(
        createElement(PreparationAutomationPanel, {
          company: next,
          dirty: false,
          busy: false,
          suspended: false,
          manualUnsettled: false,
          ...callbacks,
          ...extras,
        }),
      ),
    };
  }
  it("SSR stays off, unchecked and executes nothing", () => {
    const request = vi.spyOn(globalThis, "fetch");
    const { html, callbacks } = render();
    expect(html).toContain("연결 꺼짐 · 기본값");
    expect(html).not.toContain('checked=""');
    expect(html).toContain("켜기 이후");
    expect(html).toContain("화면을 닫으면 새 자동 작업을 시작하지 않습니다");
    expect(html).toContain("이미 시작한 로컬 작업은 저장 상태에서 확인합니다");
    expect(html).toContain("외부 AI 전송");
    expect(html).toContain("벤처인 입력·제출은 포함하지 않습니다");
    expect(request).not.toHaveBeenCalled();
    Object.values(callbacks).forEach((callback) => expect(callback).not.toHaveBeenCalled());
    request.mockRestore();
  });
  it("saved on is explicitly labeled with manual boundaries", () => {
    expect(render(enabled()).html).toContain("연결 켜짐");
    expect(render(enabled()).html).toContain("기관 답변 발송");
  });
  it.each(["dirty", "suspended", "manualUnsettled"])("explains %s pause", (field) => {
    expect(render(enabled(), { [field]: true }).html).toContain("자동 연결을 보류합니다");
  });
  it.each(Object.keys(automationStatusLabels) as PreparationAutomationBatch["status"][])(
    "labels %s without granting review",
    (status) => {
      const html = renderToStaticMarkup(
        createElement(PreparationAutomationBatchView, {
          company: enabled(),
          batch: batch({ status, pendingSourceIds: [eventId], agencyRecordIds: [extraId] }),
        }),
      );
      expect(html).toContain(automationStatusLabels[status]);
      expect(html).toContain("본문 검토를 완료하지 않습니다");
      expect(html).toContain("기관 처리 상태를 자동 확정하지 않습니다");
    },
  );
  it("automation unsettled blocks manual execution but preserves read refresh", () => {
    const html = renderToStaticMarkup(
      createElement(PreparationPanel, {
        company: company(),
        dirty: false,
        busy: false,
        externalBusy: true,
        onBusyChange: vi.fn(),
        onCompany: vi.fn(),
        goTo: vi.fn(),
      }),
    );
    const buttons = [...html.matchAll(/<button[^>]*>.*?<\/button>/g)].map((match) => match[0]);
    expect(buttons.find((button) => button.includes("로컬 준비 이어가기"))).toContain(
      'disabled=""',
    );
    expect(buttons.find((button) => button.includes("저장 상태 확인"))).not.toContain(
      'disabled=""',
    );
  });
});
