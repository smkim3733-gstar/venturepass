import { describe, expect, it } from "vitest";
import {
  detailedPlanConfirmationFixture,
  detailedPlanConfirmationResult,
} from "../../../scripts/fixtures/detailed-plan-confirmation";
import { planConfirmationSnapshot } from "./plan-confirmation";
function fixture() {
  const { company } = detailedPlanConfirmationFixture();
  const pending = { company, planId: company.plans[0].id };
  return { pending, next: detailedPlanConfirmationResult(company, pending.planId) };
}
describe("상세 도구의 명시적으로 선택한 과거 원고 확인", () => {
  it("과거 원고는 명시 옵션에서만 수락하며 원래 회사·요청을 바꾸지 않는다", () => {
    const { pending, next } = fixture();
    const original = structuredClone(pending);
    expect(() => planConfirmationSnapshot(next, pending)).toThrow();
    expect(planConfirmationSnapshot(next, pending, { allowHistorical: true })).toEqual(next);
    expect(pending).toEqual(original);
    expect(next.plans[1]).toEqual(original.company.plans[1]);
  });
  it("상세 옵션에서도 최신 원고의 기존 대조를 유지한다", () => {
    const { company } = detailedPlanConfirmationFixture();
    const pending = { company, planId: company.plans[1].id };
    const next = detailedPlanConfirmationResult(company, pending.planId);
    expect(planConfirmationSnapshot(next, pending, { allowHistorical: true })).toEqual(
      planConfirmationSnapshot(next, pending),
    );
  });
  it.each([
    "missing",
    "other-target",
    "body",
    "newer-history",
    "context",
    "confirmation",
    "error",
    "already-confirmed",
  ])("과거 원고 선택이 %s 불일치를 허용하지 않는다", (mode) => {
    const { pending, next } = fixture();
    const old = next.plans[0];
    if (mode === "missing") old.confirmedAt = null;
    if (mode === "other-target") {
      next.plans[1].confirmedAt = old.confirmedAt;
      old.confirmedAt = null;
    }
    if (mode === "body") old.content.sections[1].content += "변경";
    if (mode === "newer-history") next.plans[1].content.summary += "변경";
    if (mode === "context") next.analysis!.summary += "변경";
    if (mode === "confirmation") old.content.sections[1].needsConfirmation = true;
    if (mode === "error") old.review[0].severity = "error";
    if (mode === "already-confirmed") pending.company.plans[0].confirmedAt = old.confirmedAt;
    expect(() => planConfirmationSnapshot(next, pending, { allowHistorical: true })).toThrow();
  });
});
