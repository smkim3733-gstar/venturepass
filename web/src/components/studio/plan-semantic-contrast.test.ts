import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupPlanReviewFindings, planLanguageSuggestions } from "@/lib/studio-plan-editorial";
import {
  semanticContrastCases,
  semanticContrastFixture,
} from "@/lib/studio-plan-semantic-test-fixture";
import { PlanLanguagePanel } from "./plan-language-panel";
import { PlanReviewPanel } from "./plan-review-panel";
import { PlanReviewDecisions, planReviewInputFor } from "./plan-review-decisions";

describe("hand-authored semantic contrasts: display and binding, not AI scoring", () => {
  for (const item of semanticContrastCases) {
    it(`${item.id}: preserves source, stored findings and individual decision identity`, () => {
      const { company, plan } = semanticContrastFixture(item.id);
      const original = JSON.stringify(company);
      const groups = groupPlanReviewFindings(plan.review);
      expect(groups.map((group) => group.indices)).toEqual(item.expected.displayGroups);
      expect(
        planLanguageSuggestions(plan.content)
          .map((advice) => advice.term)
          .sort(),
      ).toEqual([...item.expected.languageTerms].sort());
      const reviewHtml = renderToStaticMarkup(
        createElement(PlanReviewPanel, { plan, onSection() {} }),
      );
      const languageHtml = renderToStaticMarkup(
        createElement(PlanLanguagePanel, {
          content: plan.content,
          onSection() {},
        }),
      );
      const decisionsHtml = renderToStaticMarkup(
        createElement(PlanReviewDecisions, {
          company,
          plan,
          mutate: async () => null,
          blockedReason: "",
          onDirtyChange() {},
        }),
      );
      for (const { indices, finding } of groups) {
        expect(reviewHtml).toContain(finding.message);
        for (const index of indices) {
          const decision = planReviewInputFor(company, plan, index)!;
          expect(decision.findingIndex).toBe(index);
          expect(decision.finding).toEqual(plan.review[index]);
          expect(decision.status).toBe("pending");
          expect(decision.reason).toBe("");
          expect(decision.reviewer).toBe("");
          expect(decisionsHtml).toContain(`value="${index}"`);
        }
      }
      if (!plan.review.length) {
        expect(reviewHtml).toContain("사실과 증빙은 직접 확인");
        expect(decisionsHtml).not.toContain('id="plan-review-finding"');
      }
      if (!item.expected.languageTerms.length)
        expect(languageHtml).toContain("문장 의미와 사실관계는 별도로 확인");
      expect(plan.content.sections[0].evidence.map((evidence) => evidence.quote)).toEqual(
        item.sources.map((source) => source.text),
      );
      expect(plan.confirmedAt).toBeNull();
      expect(plan.content.sections[0].needsConfirmation).toBe(true);
      expect(JSON.stringify(company)).toBe(original);
    });
  }
  it("manual Korean edits affect advice without rewriting quoted labels, stored draft or flags", () => {
    const { company, plan } = semanticContrastFixture("K1");
    const original = JSON.stringify(company);
    const edited = structuredClone(plan.content);
    edited.sections[0].content = semanticContrastFixture("K2").item.draft;
    expect(planLanguageSuggestions(plan.content)).toHaveLength(4);
    expect(planLanguageSuggestions(edited)).toEqual([]);
    expect(edited.sections[0].evidence).toEqual(plan.content.sections[0].evidence);
    expect(edited.sections[0].evidence[0].quote).toContain(
      "documented / reported / planned / unverified",
    );
    expect(edited.sections[0].needsConfirmation).toBe(true);
    expect(JSON.stringify(company)).toBe(original);
  });
  it("semantic paraphrases and distinct criticisms both preserve two stored decisions; only exact duplicates group", () => {
    const paraphrases = semanticContrastFixture("R1").plan;
    const distinct = semanticContrastFixture("R2").plan;
    const identical = semanticContrastFixture("R0").plan;
    expect(groupPlanReviewFindings(paraphrases.review)).toHaveLength(2);
    expect(groupPlanReviewFindings(distinct.review)).toHaveLength(2);
    expect(groupPlanReviewFindings(identical.review).map((group) => group.indices)).toEqual([
      [0, 1],
    ]);
    expect(paraphrases.review).toHaveLength(2);
    expect(distinct.review).toHaveLength(2);
    expect(identical.review).toHaveLength(2);
  });
});
