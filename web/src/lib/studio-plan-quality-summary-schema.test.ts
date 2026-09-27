import { describe, expect, it } from "vitest";
import { summarizePlanQualityEvaluations } from "./studio-plan-quality-evaluation";
import { planQualitySummarySchema } from "./studio-plan-quality-summary-schema";

describe("평가 화면의 집계 응답 검증", () => {
  it("실제 core의 미평가 50개와 미평가 분모를 그대로 읽는다", () => {
    const result = summarizePlanQualityEvaluations([]);
    expect(planQualitySummarySchema.parse(result)).toEqual(result);
  });
  it.each(["counts", "number", "duplicate", "missing", "needed", "scope", "claim"] as const)(
    "손상되거나 모순된 %s 집계를 성공 화면으로 채택하지 않는다",
    (kind) => {
      const result = summarizePlanQualityEvaluations([]);
      if (kind === "counts") result.counts.passed = 1;
      if (kind === "number") result.actualAiRecorded = 1;
      if (kind === "duplicate") result.cases[1] = structuredClone(result.cases[0]);
      if (kind === "missing") result.cases.pop();
      if (kind === "needed") result.evaluationNeeded.pop();
      if (kind === "scope")
        return expect(
          planQualitySummarySchema.safeParse({ ...result, launchQualification: "passed" }).success,
        ).toBe(false);
      if (kind === "claim") {
        result.cases[0].status = "passed";
        result.evaluationNeeded.shift();
        result.counts.unevaluated--;
        result.counts.passed++;
      }
      expect(planQualitySummarySchema.safeParse(result).success).toBe(false);
    },
  );
});
