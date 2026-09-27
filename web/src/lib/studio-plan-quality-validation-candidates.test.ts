import { describe, expect, it } from "vitest";
import { candidateSchema, caseSchema } from "./studio-schema";
import {
  createPlanQualityValidationCandidates,
  planQualityValidationCandidateSchema,
  validationCandidateChallenges,
  validationCandidateSectors,
} from "./studio-plan-quality-validation-candidates";

// Schema and corpus composition only. Do not import the generation/review engine or tune it here.
const candidates = createPlanQualityValidationCandidates();

describe("독립 품질검증용 후보의 형식·분포", () => {
  it("12개 모두 AI 작성 검증용 후보이며 정답·성능·독립성 확정이 없다", () => {
    expect(candidates).toHaveLength(12);
    for (const value of candidates) {
      expect(value).toMatchObject({
        synthetic: true,
        status: "validation-candidate",
        authoredBy: "ai",
        humanAnswerKey: null,
        independentHoldoutConfirmed: false,
        performanceEvaluation: "not-performed",
        catalogRegistration: "not-registered",
      });
    }
  });

  it.each(candidates)("$id: 회사·주제·후보 schema가 유효하다", (value) => {
    expect(planQualityValidationCandidateSchema.safeParse(value).success).toBe(true);
    expect(caseSchema.safeParse(value.company).success).toBe(true);
    expect(candidateSchema.safeParse(value.candidate).success).toBe(true);
    expect(value.company.profile.applicationKind).toBe(value.applicationKind);
    expect(value.company.sources.length).toBeGreaterThanOrEqual(4);
    expect(
      value.company.sources.every(
        (source) => source.originalName === null && source.mimeType === null,
      ),
    ).toBe(true);
    expect(value.company.profile.businessNumber).toBe("");
    expect(value.company.analysis).toBeNull();
    expect(value.company.plans).toEqual([]);
    expect(value.company.selectedCandidateId).toBeNull();
  });

  it.each(
    validationCandidateSectors.flatMap((sector) =>
      (["new", "renewal"] as const).map((applicationKind) => ({ sector, applicationKind })),
    ),
  )("$sector × $applicationKind에 서로 다른 후보 두 개를 둔다", ({ sector, applicationKind }) => {
    const group = candidates.filter(
      (value) => value.sector === sector && value.applicationKind === applicationKind,
    );
    expect(group).toHaveLength(2);
    expect(new Set(group.map((value) => value.company.id)).size).toBe(2);
    expect(new Set(group.map((value) => value.candidate.title)).size).toBe(2);
    expect(group.map((value) => value.materialDesign)).toContain("connected-narrative");
    expect(group.some((value) => value.materialDesign !== "connected-narrative")).toBe(true);
  });

  it("회사·기술·원자료가 이름이나 번호만 바꾼 복제 구성이 아니다", () => {
    for (const values of [
      candidates.map((value) => value.id),
      candidates.map((value) => value.company.id),
      candidates.map((value) => value.company.profile.companyName),
      candidates.map((value) => value.candidate.id),
      candidates.map((value) => value.candidate.solution),
      candidates.map((value) => value.candidate.problem),
      candidates.map((value) => value.company.sources.map((source) => source.text).join("\n")),
    ])
      expect(new Set(values).size).toBe(12);
    const sourceIds = candidates.flatMap((value) =>
      value.company.sources.map((source) => source.id),
    );
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
  });

  it("요청된 자료 조건 태그를 포함하되 성능 기대값은 만들지 않는다", () => {
    const tags = new Set(candidates.flatMap((value) => value.challengeTags));
    expect([...tags].sort()).toEqual([...validationCandidateChallenges].sort());
    expect(
      candidates.filter((value) => value.materialDesign === "connected-narrative"),
    ).toHaveLength(6);
    expect(candidates.filter((value) => value.materialDesign === "intentional-gap")).toHaveLength(
      3,
    );
    expect(
      candidates.filter((value) => value.materialDesign === "intentional-conflict"),
    ).toHaveLength(3);
    for (const value of candidates) {
      expect(value).not.toHaveProperty("deterministicExpectation");
      expect(value).not.toHaveProperty("semanticReviewResult");
      expect(value).not.toHaveProperty("expectedPass");
      expect(value).not.toHaveProperty("expectedDisposition");
    }
  });

  it("같은 후보 입력을 재현하고 반환값 변경이 원래 후보에 영향을 주지 않는다", () => {
    const first = createPlanQualityValidationCandidates();
    const second = createPlanQualityValidationCandidates();
    expect(first).toEqual(second);
    first[0].company.profile.companyName = "변경";
    first[0].company.sources[0].text = "변경";
    first[0].challengeTags.push("missing-material");
    first[0].authoringNotes.push("추가 메모");
    expect(second).toEqual(createPlanQualityValidationCandidates());
  });
});
