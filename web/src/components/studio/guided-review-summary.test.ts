import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { planReviewDecisionSchema, type PlanReviewDecision } from "@/lib/studio-plan-review-types";
import { reviewLinkCompany } from "../../../scripts/fixtures/guided-review-link";
import { GuidedReviewDecisionSummary } from "./guided-plan-review";
const company = () => reviewLinkCompany();
function record(value = company(), change: Partial<PlanReviewDecision> = {}) {
  const plan = value.plans.at(-1)!;
  const id = "f0000000-0000-4000-8000-000000000001";
  return planReviewDecisionSchema.parse({
    planId: plan.id,
    planVersion: plan.version,
    findingIndex: 2,
    finding: plan.review[2],
    previousRecordId: null,
    status: "deferred",
    reason: "합성 근거 대기",
    reviewer: "합성 담당자",
    id,
    rootId: id,
    version: 1,
    clientRequestId: id,
    inputDigest: "a".repeat(64),
    recordedAt: "2026-10-09T01:00:00.000Z",
    origin: "manual",
    reviewKey: "b".repeat(64),
    planContentSha256: "c".repeat(64),
    findingSha256: "d".repeat(64),
    planSourceRevision: 2,
    evidenceRevision: 5,
    evidenceFingerprint: "e".repeat(64),
    stale: true,
    staleReasons: ["plan-evidence-outdated"],
    ...change,
  });
}
function render(value = company(), index = 2) {
  return renderToStaticMarkup(
    createElement(GuidedReviewDecisionSummary, {
      company: value,
      plan: value.plans.at(-1)!,
      findingIndex: index,
    }),
  );
}
describe("guided latest manual judgement summary", () => {
  it("shows an explicit unrecorded state instead of guessing pending or resolved", () => {
    expect(render()).toContain("담당자 판단 미기록");
    expect(render()).not.toContain("최근 수동 판단");
  });
  it.each([
    ["pending", "확인 필요"],
    ["deferred", "보류"],
    ["resolved", "담당자 해결 판단"],
  ] as const)(
    "shows saved %s as a manual judgement while preserving all manuscript state",
    (status, label) => {
      const value = company();
      value.planReviewDecisions = [record(value, { status })];
      const original = structuredClone(value);
      const html = render(value);
      expect(html).toContain("최근 수동 판단: " + label);
      expect(html).toContain("합성 담당자");
      expect(html).toContain("재검토 필요");
      expect(html).toContain("이 원고가 최신 근거를 반영했는지 다시 확인해야 합니다.");
      expect(html).not.toContain("검토 완료");
      expect(value).toEqual(original);
    },
  );
  it("uses the last matching record, not the timestamp or an older resolved entry", () => {
    const value = company();
    value.planReviewDecisions = [
      record(value, { status: "resolved", recordedAt: "2026-10-10T01:00:00.000Z" }),
      record(value, { status: "pending", reviewer: "최근 담당자", version: 2 }),
    ];
    const html = render(value);
    expect(html).toContain("최근 수동 판단: 확인 필요");
    expect(html).toContain("최근 담당자");
    expect(html).not.toContain("담당자 해결 판단");
  });
  it.each(["plan", "version", "index", "finding"] as const)("excludes another %s", (kind) => {
    const value = company(),
      saved = record(value);
    if (kind === "plan") saved.planId = value.plans[0].id;
    if (kind === "version") saved.planVersion = 1;
    if (kind === "index") saved.findingIndex = 1;
    if (kind === "finding") saved.finding = { ...saved.finding, action: "다른 조치" };
    value.planReviewDecisions = [saved];
    expect(render(value)).toContain("담당자 판단 미기록");
  });
  it("keeps original index after info filtering and identical displayed messages", () => {
    const value = company();
    value.planReviewDecisions = [record(value)];
    expect(render(value, 1)).toContain("담당자 판단 미기록");
    expect(render(value, 2)).toContain("최근 수동 판단: 보류");
    expect(render(value, 2)).toContain("의견 3의 최근 담당자 판단");
  });
  it("shows supplied non-stale status without claiming factual confirmation", () => {
    const value = company();
    value.planReviewDecisions = [record(value, { stale: false, staleReasons: [] })];
    const html = render(value);
    expect(html).toContain("저장 기준 유지");
    expect(html).not.toContain("재검토 필요");
    expect(html).not.toContain("사실 확인 완료");
  });
  it("preserves all supplied stale reasons and escapes reviewer markup", () => {
    const value = company();
    value.planReviewDecisions = [
      record(value, {
        reviewer: "<script>unsafe</script>",
        staleReasons: ["evidence-changed", "plan-evidence-outdated"],
      }),
    ];
    const html = render(value);
    expect(html).toContain("검토 당시 등록 자료 또는 근거 버전이 달라졌습니다.");
    expect(html).toContain("이 원고가 최신 근거를 반영했는지 다시 확인해야 합니다.");
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("reads only current company props and performs no fetch when replacing the company", () => {
    const fetch = vi.fn(() => {
      throw Error("Forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const first = company();
      first.planReviewDecisions = [record(first)];
      expect(render(first)).toContain("최근 수동 판단: 보류");
      const second = company();
      second.id = "c0000000-0000-4000-8000-000000000002";
      expect(render(second)).toContain("담당자 판단 미기록");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
