import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  planReviewDecisionSchema,
  type PlanReviewDecisionInput,
} from "@/lib/studio-plan-review-types";
import {
  PlanReviewDecisions,
  planReviewInputFor,
  planReviewSaveAcknowledged,
} from "./plan-review-decisions";

function company(): StudioCase {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 검토 기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    revision: 1,
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    plans: [
      {
        id: randomUUID(),
        version: 1,
        generatedAt: "2026-09-25T00:00:00.000Z",
        mode: "manual",
        candidateId: "fixture",
        sourceRevision: 1,
        content: {
          title: "합성 원고",
          summary: "",
          sections: [],
          actionItems: [],
          interviewQuestions: [],
        },
        confirmedAt: null,
        review: [
          {
            id: "review-0",
            severity: "error",
            category: "confirmation",
            message: "사실 확인 필요",
            action: "정확한 근거 대조",
            sectionKey: null,
            sourceIds: [],
          },
        ],
      },
    ],
  });
}
function addDecision(state: StudioCase, overrides: Partial<PlanReviewDecisionInput> = {}) {
  const input = {
    ...planReviewInputFor(state, state.plans[0], 0)!,
    status: "resolved" as const,
    reviewer: "합성 담당자",
    reason: "추가 근거를 확인했다는 담당자 판단",
    ...overrides,
  };
  const id = randomUUID();
  const record = planReviewDecisionSchema.parse({
    ...input,
    id,
    rootId: id,
    version: 1,
    clientRequestId: randomUUID(),
    inputDigest: "a".repeat(64),
    recordedAt: "2026-09-25T00:00:00.000Z",
    origin: "manual",
    reviewKey: "b".repeat(64),
    planContentSha256: "c".repeat(64),
    findingSha256: "d".repeat(64),
    planSourceRevision: 1,
    evidenceRevision: 1,
    evidenceFingerprint: "e".repeat(64),
    stale: false,
    staleReasons: [],
  });
  state.planReviewDecisions.push(record);
  return { input, record };
}
function render(state: StudioCase, blockedReason = "") {
  return renderToStaticMarkup(
    createElement(PlanReviewDecisions, {
      company: state,
      plan: state.plans[0],
      mutate: vi.fn(),
      blockedReason,
      onDirtyChange: vi.fn(),
    }),
  );
}
describe("검토 의견 처리 UI", () => {
  it("starts without a selected opinion and does not mark a judgement as plan confirmation", () => {
    const state = company();
    const html = render(state);
    expect(html).toContain('value="" selected=""');
    expect(html).toContain("검토 완료 제한은 그대로 유지");
    expect(html).not.toContain('id="plan-review-reviewer"');
    expect(state.plans[0].confirmedAt).toBeNull();
  });
  it("starts every judgement with explicit reviewer and reason instead of carrying forward resolution", () => {
    const state = company();
    const { record } = addDecision(state);
    const next = planReviewInputFor(state, state.plans[0], 0)!;
    expect(next.previousRecordId).toBe(record.id);
    expect(next.status).toBe("pending");
    expect(next.reviewer).toBe("");
    expect(next.reason).toBe("");
    next.finding.message = "편집된 사본";
    expect(state.plans[0].review[0].message).toBe("사실 확인 필요");
  });
  it("does not bind a reused finding id with a different message to an earlier decision", () => {
    const state = company();
    addDecision(state);
    state.plans[0].review[0].message = "정정된 의견";
    expect(planReviewInputFor(state, state.plans[0], 0)!.previousRecordId).toBeNull();
    expect(planReviewInputFor(state, state.plans[0], 9)).toBeNull();
  });
  it("shows stale evidence and immutable old judgement together without treating resolution as success", () => {
    const state = company();
    const { record } = addDecision(state);
    record.stale = true;
    record.staleReasons = ["evidence-changed"];
    const html = render(state);
    expect(html).toContain("담당자 해결 판단");
    expect(html).toContain("재검토 필요");
    expect(html).toContain("검토 당시 등록 자료 또는 근거 버전이 달라졌습니다");
    expect(html).toContain(record.reason);
    expect(html).toContain(record.planContentSha256);
    expect(state.plans[0].review[0].severity).toBe("error");
  });
  it("blocks selection during manuscript editing and shows empty opinions accurately", () => {
    const state = company();
    expect(render(state, "원고 편집 중")).toMatch(/<select[^>]*disabled=""/);
    state.plans[0].review = [];
    expect(render(state)).toContain("현재 저장 원고에 표시된 검토 의견이 없습니다");
    expect(render(state)).not.toContain('id="plan-review-finding"');
  });
  it("preserves historical versions and safely renders user supplied text", () => {
    const state = company();
    const { record } = addDecision(state, { reason: "<script>합성</script>" });
    state.planReviewDecisions.push({
      ...record,
      id: randomUUID(),
      version: 2,
      previousRecordId: record.id,
      status: "deferred",
      reason: "추가 확인",
    });
    const html = render(state);
    expect(html).toContain("판단 이력 2개");
    expect(html).toContain("판단 v1");
    expect(html).toContain("판단 v2");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("accepts only an exact single saved company, nonce, opinion and payload acknowledgement", () => {
    const state = company();
    const { record, input } = addDecision(state);
    const ack = (saved: StudioCase | null) =>
      planReviewSaveAcknowledged(saved, state.id, record.clientRequestId, input);
    expect(ack(state)).toBe(true);
    expect(ack(null)).toBe(false);
    expect(ack({ ...state, id: randomUUID() })).toBe(false);
    expect(ack({ ...state, planReviewDecisions: [record, record] })).toBe(false);
    for (const change of [
      { status: "deferred" },
      { planVersion: 2 },
      { findingIndex: 1 },
      { reviewer: "다른 담당자" },
      { reason: "다른 이유" },
      { previousRecordId: randomUUID() },
      { clientRequestId: randomUUID() },
      { finding: { ...record.finding, message: "다른 의견" } },
    ]) {
      const modified = structuredClone(state);
      modified.planReviewDecisions[0] = { ...record, ...change } as typeof record;
      expect(ack(modified)).toBe(false);
    }
  });
});
