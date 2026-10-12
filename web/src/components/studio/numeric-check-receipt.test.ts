import { describe, it, expect } from "vitest";
import { numericCheckSaveAcknowledged } from "./numeric-checks";
import { numericReceiptFixture, agencyId } from "../../../scripts/fixtures/numeric-check-receipt";
describe("수치 대조 응답 수락의 기존 요청 대조", () => {
  it("accepts matching values, period, units, formula, citations and judgement without mutating either input", () => {
    const { company, input, nonce, saved } = numericReceiptFixture();
    const before = JSON.stringify({ company, input, saved });
    expect(numericCheckSaveAcknowledged(saved, company.id, nonce, input)).toBe(true);
    expect(JSON.stringify({ company, input, saved })).toBe(before);
  });
  it.each([
    "missing",
    "nonce",
    "duplicate-nonce",
    "parent",
    "root",
    "version",
    "title",
    "value",
    "unit",
    "period",
    "basis",
    "quote",
    "plan",
    "note",
    "observation-order",
    "comparison",
    "formula",
    "operands",
    "expected",
    "judgement",
    "reviewer",
    "review-note",
  ])("rejects %s without replacing the submitted command", (kind) => {
    const { company, input, nonce, saved } = numericReceiptFixture();
    const before = JSON.stringify(input);
    const r = saved.numericChecks.at(-1)!;
    if (kind === "missing") saved.numericChecks.pop();
    if (kind === "nonce") r.clientRequestId = agencyId(299);
    if (kind === "duplicate-nonce") saved.numericChecks.push(structuredClone(r));
    if (kind === "parent") r.previousVersionId = agencyId(299);
    if (kind === "root") r.checkId = agencyId(299);
    if (kind === "version") r.version = 1;
    if (kind === "title") r.title = "다른 제목";
    if (kind === "value") r.observations[1].valueText = "2,300.26";
    if (kind === "unit") r.observations[1].unit = "person";
    if (kind === "period") r.observations[1].period.start = "2025-02-01";
    if (kind === "basis") r.observations[1].basis = "target";
    if (kind === "quote" && r.observations[1].reference)
      r.observations[1].reference.quote = "다른 인용";
    if (kind === "plan" && r.observations[1].reference?.kind === "plan")
      r.observations[1].reference.planId = agencyId(299);
    if (kind === "note") r.observations[1].note = "다른 메모";
    if (kind === "observation-order") r.observations.reverse();
    if (kind === "comparison") r.comparisons[0].rightId = r.observations[2].id;
    if (kind === "formula") r.formulas[0].operation = "difference";
    if (kind === "operands") r.formulas[0].operandIds.reverse();
    if (kind === "expected") r.formulas[0].expectedId = agencyId(299);
    if (kind === "judgement") r.judgement.state = "reviewed";
    if (kind === "reviewer") r.judgement.reviewer = "다른 담당자";
    if (kind === "review-note") r.judgement.note = "다른 판단 메모";
    expect(numericCheckSaveAcknowledged(saved, company.id, nonce, input)).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("rejects missing and different-company responses", () => {
    const { company, input, nonce, saved } = numericReceiptFixture();
    expect(numericCheckSaveAcknowledged(null, company.id, nonce, input)).toBe(false);
    saved.id = agencyId(299);
    expect(numericCheckSaveAcknowledged(saved, company.id, nonce, input)).toBe(false);
  });
});
