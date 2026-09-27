import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { aiConstructor } = vi.hoisted(() => ({ aiConstructor: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      aiConstructor();
      throw new Error("합성 품질 회귀에서는 외부 AI 호출을 허용하지 않습니다.");
    }
  },
}));

import { reviewPlan } from "./studio-engine";
import {
  candidateSchema,
  caseSchema,
  planContentSchema,
  sectionDefinitions,
} from "./studio-schema";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";

const cases = createPlanQualityFixtures();
const semanticOnlyIds = cases
  .filter(
    (fixture) =>
      fixture.semanticRubric.expectedDisposition !== "reviewable" &&
      fixture.deterministicExpectation.requiredFindings.length === 0,
  )
  .map((fixture) => fixture.id);

describe("고정 합성 사업계획서 품질 입력 세트", () => {
  it("50개 고유 사례를 회사·후보·원고 입력과 분리된 평가 기대로 제공한다", () => {
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(new Set(cases.map((item) => item.company.id)).size).toBe(cases.length);
    for (const fixture of cases) {
      expect(fixture.synthetic).toBe(true);
      expect(caseSchema.safeParse(fixture.company).success, fixture.id).toBe(true);
      expect(candidateSchema.safeParse(fixture.candidate).success, fixture.id).toBe(true);
      expect(planContentSchema.safeParse(fixture.plan).success, fixture.id).toBe(true);
      expect(fixture.semanticRubric.expectedChecks.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.semanticRubric.ruleGateLimitation.length, fixture.id).toBeGreaterThan(20);
      expect(fixture.company.sources.every((source) => source.originalName === null)).toBe(true);
      expect(fixture.company.profile.businessNumber).toBe("");
    }
  });

  it("이름·번호만 바꾼 복제 사례 없이 실제 원고 또는 근거 입력이 서로 다르다", () => {
    const inputs = cases.map((fixture) =>
      JSON.stringify({
        profile: fixture.company.profile,
        sources: fixture.company.sources.map(({ name, text, extraction }) => ({
          name,
          text,
          extraction,
        })),
        candidate: fixture.candidate,
        plan: fixture.plan,
      }),
    );
    expect(new Set(inputs).size).toBe(50);
    expect(semanticOnlyIds.length).toBeGreaterThanOrEqual(25);
  });

  it("같은 입력을 재현하며 호출별 사본은 서로 영향을 주지 않는다", () => {
    const first = createPlanQualityFixtures();
    const second = createPlanQualityFixtures();
    expect(first).toEqual(second);
    first[0].company.profile.technologySummary = "변경한 합성 문장";
    first[0].plan.sections[0].content = "변경한 합성 원고";
    first[0].candidate.gaps.push("추가한 합성 질문");
    expect(second).toEqual(createPlanQualityFixtures());
  });

  it("충분한 입력의 기준 사례는 모든 작성 항목을 포함하고 형식·인용 규칙을 통과한다", () => {
    const fixture = cases.find((item) => item.id === "sufficient-scoped-draft")!;
    expect(fixture.plan.sections.map((item) => item.key)).toEqual(
      sectionDefinitions.map((item) => item.key),
    );
    const findings = reviewPlan(fixture.company, fixture.plan);
    expect(findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(fixture.semanticRubric.expectedDisposition).toBe("reviewable");
    expect(fixture.semanticRubric.ruleGateLimitation).toContain("공식 적합성은 별도 검토");
  });

  it.each(cases)("$id: 기존 결정론 검사의 기대 동작만 검증한다", (fixture) => {
    const before = structuredClone(fixture);
    const findings = reviewPlan(fixture.company, fixture.plan);
    for (const expected of fixture.deterministicExpectation.requiredFindings) {
      expect(findings, `${fixture.id}: ${expected.category}`).toEqual(
        expect.arrayContaining([expect.objectContaining(expected)]),
      );
    }
    for (const category of fixture.deterministicExpectation.forbiddenCategories) {
      expect(
        findings.some((finding) => finding.category === category),
        `${fixture.id}: ${category}`,
      ).toBe(false);
    }
    if (fixture.deterministicExpectation.errorCount !== undefined) {
      expect(
        findings.filter((finding) => finding.severity === "error"),
        fixture.id,
      ).toHaveLength(fixture.deterministicExpectation.errorCount);
    }
    expect(findings.some((finding) => finding.category === "review-scope")).toBe(true);
    expect(fixture).toEqual(before);
    expect(aiConstructor).not.toHaveBeenCalled();
  });

  it.each(semanticOnlyIds)(
    "%s: 정확한 인용이 있어도 의미상 수정 기대를 규칙 통과와 구분한다",
    (id) => {
      const fixture = cases.find((item) => item.id === id)!;
      const findings = reviewPlan(fixture.company, fixture.plan);
      expect(findings.some((finding) => finding.severity === "error")).toBe(false);
      expect(findings.some((finding) => finding.category === "invalid-reference")).toBe(false);
      expect(fixture.semanticRubric.expectedDisposition).not.toBe("reviewable");
      expect(fixture.semanticRubric.expectedChecks.length).toBeGreaterThan(0);
      // The expected semantic decision remains a rubric; no model or human result is fabricated.
      expect(fixture).not.toHaveProperty("semanticReviewResult");
      expect(fixture).not.toHaveProperty("approvalProbability");
    },
  );

  it("같은 수치의 기간·주체·목표·부호 오류는 문자열 수치 검사가 못 찾는 한계로 기록한다", () => {
    for (const id of [
      "outdated-financial-period",
      "unverified-growth-as-result",
      "loss-flipped-to-profit",
      "quarterly-result-as-annual",
      "contractors-counted-as-employees",
      "survey-interest-as-market-share",
      "negative-cash-sign-removed",
      "exclusive-percentages-exceed-total",
    ]) {
      const fixture = cases.find((item) => item.id === id)!;
      expect(
        reviewPlan(fixture.company, fixture.plan).some(
          (finding) => finding.category === "numeric-evidence",
        ),
        id,
      ).toBe(false);
      expect(fixture.semanticRubric.expectedDisposition).not.toBe("reviewable");
    }
  });

  it("정상적인 단위 변환은 문자 경고가 생겨도 의미 검토에서 금액 오류로 취급하지 않는다", () => {
    const fixture = cases.find((item) => item.id === "equivalent-unit-conversion")!;
    expect(reviewPlan(fixture.company, fixture.plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "numeric-evidence",
          severity: "warning",
          sectionKey: "funding",
        }),
      ]),
    );
    expect(fixture.semanticRubric.expectedDisposition).toBe("reviewable");
    expect(fixture.semanticRubric.ruleGateLimitation).toContain("거짓 양성");
  });

  it("판독 전 원본·오독·삭제된 자료는 유효 인용으로 인정하지 않는다", () => {
    for (const id of [
      "ocr-bad-quote",
      "unreviewed-original-reference",
      "deleted-source-reference",
      "empty-reference-quote",
      "quote-bound-to-wrong-file",
      "invented-profile-reference",
    ]) {
      const fixture = cases.find((item) => item.id === id)!;
      expect(
        reviewPlan(fixture.company, fixture.plan).some(
          (finding) => finding.category === "invalid-reference" && finding.severity === "error",
        ),
        id,
      ).toBe(true);
    }
    expect(aiConstructor).not.toHaveBeenCalled();
  });
});
