import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { planClaimSummaryFixture } from "../../scripts/fixtures/plan-claim-summary";
import { manualId } from "../../scripts/fixtures/manual-source-receipt";
import { planClaimSummary } from "./studio-plan-claim-summary";
import { PlanClaimSummary } from "../components/studio/plan-claim-summary";

vi.mock("node:sqlite", () => {
  throw Error("No SQL in a saved-plan summary");
});
vi.mock("openai", () => {
  throw Error("No AI in a saved-plan summary");
});
const setup = () => {
  const company = planClaimSummaryFixture();
  const plan = company.plans.at(-1)!;
  return { company, plan, read: () => planClaimSummary(company, plan.id, plan.version) };
};
describe("saved manuscript claim review summary", () => {
  it("separates human judgement from stale evidence and preserves all data", () => {
    const { company, read } = setup();
    const before = structuredClone(company);
    const result = read();
    expect(result.counts).toEqual({
      missing: 0,
      stale: 1,
      unreviewed: 1,
      conflict: 1,
      insufficient: 1,
      consistent: 1,
    });
    expect(result.entries.map((entry) => entry.status)).toEqual([
      "stale",
      "unreviewed",
      "conflict",
      "insufficient",
      "consistent",
    ]);
    expect(company).toEqual(before);
  });
  it("uses the highest version for this manuscript regardless of array order", () => {
    const { company, read } = setup();
    const previous = company.claimReviews[0];
    company.claimReviews.unshift({
      ...structuredClone(previous),
      id: manualId(300),
      previousVersionId: previous.id,
      version: 2,
      judgement: { ...previous.judgement, state: "conflict" },
    });
    expect(read().counts.conflict).toBe(2);
    expect(read().counts.consistent).toBe(0);
    expect(read().entries).toHaveLength(5);
  });
  it("keeps this manuscript's record when a claim later moves to another manuscript", () => {
    const { company, plan, read } = setup();
    const other = { ...structuredClone(plan), id: manualId(400), version: plan.version + 1 };
    company.plans.push(other);
    company.claimReviews.push({
      ...structuredClone(company.claimReviews[0]),
      id: manualId(300),
      version: 2,
      planId: other.id,
      planVersion: other.version,
    });
    const selected = read().entries.find(
      (entry) => entry.record.id === company.claimReviews[0].id,
    )!;
    expect(selected.laterElsewhere).toBe(true);
    expect(selected.record.version).toBe(1);
    expect(planClaimSummary(company, other.id, other.version).entries).toHaveLength(1);
  });
  it("never inherits another manuscript's judgements when this one has no records", () => {
    const { company, plan } = setup();
    const other = { ...structuredClone(plan), id: manualId(400), version: plan.version + 1 };
    company.plans.push(other);
    expect(planClaimSummary(company, other.id, other.version).entries).toEqual([]);
  });
  it.each(["missing", "duplicate", "version"])("does not summarize a %s manuscript", (mode) => {
    const { company, plan, read } = setup();
    if (mode === "missing") company.plans = [];
    if (mode === "duplicate") company.plans.push(structuredClone(plan));
    if (mode === "version")
      company.plans = company.plans.map((p) => ({ ...p, version: p.version + 1 }));
    expect(read()).toMatchObject({ available: false, entries: [] });
  });
  it.each(["id", "version"])("does not choose an ambiguous record %s", (mode) => {
    const { company, read } = setup();
    company.claimReviews.push({
      ...structuredClone(company.claimReviews[0]),
      ...(mode === "version" ? { id: manualId(300) } : {}),
    });
    expect(read().ambiguous).toBe(1);
    expect(read().counts.consistent).toBe(0);
  });
  it.each(["source", "quote", "section", "planVersion"])(
    "rechecks the saved %s connection",
    (mode) => {
      const { company, plan, read } = setup();
      if (mode === "source") company.sources = [];
      if (mode === "quote") plan.content.sections[0].content = "변경된 합성 문장";
      if (mode === "section") plan.content.sections = [];
      if (mode === "planVersion") company.claimReviews[0].planVersion++;
      const entry = read().entries.find((item) => item.record.id === company.claimReviews[0].id)!;
      expect(entry.status).toBe(mode === "source" ? "missing" : "stale");
      expect(entry.issues.length).toBeGreaterThan(0);
      expect(entry.record.judgement.state).toBe("consistent");
    },
  );
  it("shows counts, manual owner/next step, limits and blocked reading without opening a record", () => {
    const { company, plan } = setup();
    const html = renderToStaticMarkup(
      createElement(PlanClaimSummary, { company, plan, blocked: true }),
    );
    expect(html).toContain("연결 재확인 필요 1건");
    expect(html).toContain("충돌 발견 (담당자) 1건");
    expect(html).toContain("미저장 수정과 기록하지 않은 문장은 포함하지 않습니다");
    expect(html).toContain("합성 확인 담당자");
    expect(html).toContain("현재 증빙을 확인한 뒤 직접 판단");
    expect(html.match(/disabled=""/g)).toHaveLength(5);
    expect(html).not.toContain('aria-label="선택한 주장 검토 기록"');
  });
  it("does not present no records as successful fact checking", () => {
    const { company, plan } = setup();
    company.claimReviews = [];
    const html = renderToStaticMarkup(createElement(PlanClaimSummary, { company, plan }));
    expect(html).toContain("확인할 내용이 없다는 뜻은 아닙니다");
    expect(html).not.toContain("이 주장 기록 보기");
  });
});
