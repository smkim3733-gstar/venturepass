import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile } from "./studio-schema";
import {
  assertPlanReviewCapacity,
  buildPlanReviewDecision,
  isPlanReviewReplay,
  planReviewInputDigest,
  refreshPlanReviewStaleness,
} from "./studio-plan-review";
import {
  latestPlanReviewDecision,
  planReviewDecisionInputSchema,
  type PlanReviewDecisionInput,
} from "./studio-plan-review-types";
import { planConflicts } from "./studio-evidence-history";

const now = "2026-09-25T00:00:00.000Z";
function fixture() {
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 검토 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plans: [
      {
        id: randomUUID(),
        version: 1,
        mode: "manual",
        candidateId: "fixture",
        generatedAt: now,
        sourceRevision: 1,
        confirmedAt: null,
        content: {
          title: "합성 원고",
          summary: "미확인",
          sections: [],
          actionItems: [],
          interviewQuestions: [],
        },
        review: [
          {
            id: "review-1",
            severity: "error",
            category: "contradiction",
            message: "숫자가 다름",
            action: "원문 확인",
            sectionKey: null,
            sourceIds: [],
          },
        ],
      },
    ],
  });
  const plan = company.plans[0];
  const input: PlanReviewDecisionInput = {
    planId: plan.id,
    planVersion: 1,
    findingIndex: 0,
    finding: structuredClone(plan.review[0]),
    previousRecordId: null,
    status: "deferred",
    reason: "추가 자료를 기다립니다.",
    reviewer: "담당자",
  };
  const build = (value = input, evidenceRevision = 1) =>
    buildPlanReviewDecision(company, value, evidenceRevision, {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: planReviewInputDigest(value),
      recordedAt: now,
    });
  return { company, plan, input, build };
}
describe("원고 검토 판단 이력", () => {
  it("판단만 추가하고 원고·검토·확정상태를 변경하지 않는다", () => {
    const { company, plan, build } = fixture();
    const before = structuredClone(company);
    const record = build();
    expect(company).toEqual(before);
    expect(record).toMatchObject({
      origin: "manual",
      status: "deferred",
      version: 1,
      evidenceRevision: 1,
    });
    expect(record.rootId).toBe(record.id);
    expect(record.finding).toEqual(plan.review[0]);
    expect(record.planContentSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("해결·재확인도 최신 이전기록에 추가하고 과거 기록을 유지한다", () => {
    const { company, plan, input, build } = fixture();
    const first = build();
    company.planReviewDecisions.push(first);
    const next = build({
      ...input,
      previousRecordId: first.id,
      status: "resolved",
      reason: "원본을 대조했습니다.",
    });
    company.planReviewDecisions.push(next);
    const reopened = build({
      ...input,
      previousRecordId: next.id,
      status: "pending",
      reason: "추가 질문이 생겼습니다.",
    });
    expect(reopened).toMatchObject({ rootId: first.id, version: 3 });
    expect(company.planReviewDecisions[0]).toEqual(first);
    expect(latestPlanReviewDecision(company.planReviewDecisions, plan, 0)?.id).toBe(next.id);
    expect(() => build(input)).toThrow(
      expect.objectContaining({ code: "PLAN_REVIEW_VERSION_STALE" }),
    );
  });
  it("인덱스와 내용으로 같은 review ID 재사용 및 정렬 변경을 구분한다", () => {
    const { company, plan, input, build } = fixture();
    company.planReviewDecisions.push(build());
    plan.review[0].message = "다른 의견";
    expect(() => build()).toThrow(expect.objectContaining({ code: "PLAN_REVIEW_FINDING_CHANGED" }));
    expect(latestPlanReviewDecision(company.planReviewDecisions, plan, 0)).toBeNull();
    const updated = build({ ...input, finding: structuredClone(plan.review[0]) });
    expect(updated.version).toBe(1);
    expect(updated.reviewKey).not.toBe(company.planReviewDecisions[0].reviewKey);
  });
  it.each(["planVersion", "findingIndex", "finding"] as const)("%s 변경을 거부한다", (field) => {
    const { input, build } = fixture();
    const next = structuredClone(input);
    if (field === "planVersion") next.planVersion = 2;
    if (field === "findingIndex") next.findingIndex = 1;
    if (field === "finding") next.finding.action = "변경";
    expect(() => build(next)).toThrow();
  });
  it("같은 plan ID 본문 변조와 다른 회사 원고를 거부한다", () => {
    const { company, plan, input, build } = fixture();
    company.planReviewDecisions.push(build());
    expect(
      planConflicts(company, { planId: plan.id, version: 1, contentSha256: "f".repeat(64) }),
    ).toBe(true);
    plan.content.summary = "변조";
    expect(() => build({ ...input, previousRecordId: company.planReviewDecisions[0].id })).toThrow(
      expect.objectContaining({ code: "PLAN_REVIEW_PLAN_CHANGED" }),
    );
    expect(() => build({ ...input, planId: randomUUID() })).toThrow(
      expect.objectContaining({ code: "PLAN_REVIEW_PLAN_NOT_FOUND" }),
    );
  });
  it.each(["profile", "source", "revision", "plan", "finding", "missing"] as const)(
    "%s 변경을 조회 현재성에 반영하고 판단은 보존한다",
    (change) => {
      const { company, plan, build } = fixture();
      const record = build();
      company.planReviewDecisions.push(record);
      refreshPlanReviewStaleness(company, 1);
      expect(record.stale).toBe(false);
      if (change === "profile") company.profile.technologySummary = "변경";
      if (change === "source")
        company.sources.push({
          id: randomUUID(),
          name: "자료",
          kind: "other",
          text: "원문",
          originalName: null,
          mimeType: null,
          extraction: "manual",
          warnings: [],
          createdAt: now,
          updatedAt: now,
        });
      if (change === "plan") plan.content.summary = "변경";
      if (change === "finding") plan.review[0].message = "새 의견";
      if (change === "missing") company.plans = [];
      refreshPlanReviewStaleness(company, change === "revision" ? 2 : 1);
      expect(record.stale).toBe(true);
      expect(record.staleReasons.length).toBeGreaterThan(0);
      expect(record).toMatchObject({
        status: "deferred",
        reason: "추가 자료를 기다립니다.",
        reviewer: "담당자",
      });
    },
  );
  it("새 원고가 있어도 같은 이전 원고 기록을 새 원고로 이동하지 않는다", () => {
    const { company, plan, build } = fixture();
    company.planReviewDecisions.push(build());
    const next = { ...structuredClone(plan), id: randomUUID(), version: 2 };
    company.plans.push(next);
    expect(latestPlanReviewDecision(company.planReviewDecisions, next, 0)).toBeNull();
  });
  it("nonce payload digest는 정규화하고 달라진 내용을 거부한다", () => {
    const { input, build } = fixture();
    const saved = build();
    expect(planReviewInputDigest({ ...input, reason: `  ${input.reason}  ` })).toBe(
      saved.inputDigest,
    );
    expect(isPlanReviewReplay([saved], saved.clientRequestId, saved.inputDigest)).toBe(true);
    expect(isPlanReviewReplay([saved], randomUUID(), saved.inputDigest)).toBe(false);
    expect(() => isPlanReviewReplay([saved], saved.clientRequestId, "0".repeat(64))).toThrow(
      expect.objectContaining({ code: "PLAN_REVIEW_REQUEST_CONFLICT" }),
    );
  });
  it("서버 필드 주입, 빈 판단자/이유와 범위 초과를 거부한다", () => {
    const { input } = fixture();
    for (const value of [
      { ...input, recordedAt: now },
      { ...input, status: "confirmed" },
      { ...input, reviewer: " " },
      { ...input, reason: " " },
      { ...input, findingIndex: 200 },
      { ...input, finding: { ...input.finding, resolved: true } },
    ])
      expect(planReviewDecisionInputSchema.safeParse(value).success).toBe(false);
  });
  it("건수·전체보관량 한도는 이전 기록을 자르지 않고 거부한다", () => {
    const { build } = fixture();
    const saved = build();
    expect(() => assertPlanReviewCapacity(Array.from({ length: 201 }, () => saved))).toThrow(
      expect.objectContaining({ code: "PLAN_REVIEW_LIMIT" }),
    );
    expect(() =>
      assertPlanReviewCapacity(
        Array.from({ length: 100 }, () => ({ ...saved, reason: "가".repeat(3000) })),
      ),
    ).toThrow(expect.objectContaining({ code: "PLAN_REVIEW_LIMIT" }));
  });
});
