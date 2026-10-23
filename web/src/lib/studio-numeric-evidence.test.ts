import { describe, expect, it } from "vitest";
import { unmatchedNumericEvidence } from "./studio-numeric-evidence";

describe("literal numeric evidence boundaries", () => {
  it.each([
    ["5억원", "15억원"],
    ["5%", "15%"],
    ["5명", "15명"],
    ["5건", "15건"],
    ["5개사", "15개사"],
    ["5배", "15배"],
    ["5억원", "1.5억원"],
    ["500만원", "1,500만원"],
    ["5%", "5%p"],
    ["5%p", "5%"],
    ["5%", "5%포인트"],
    ["100만원", "-100만원"],
    ["-100만원", "100만원"],
    ["100만원", "− 100만원"],
    ["100만원", "△100만원"],
    ["100만원", "(100만원)"],
    ["100만원", "- ₩ 100만원"],
  ])("does not match %s to the different notation %s", (claim, source) => {
    expect(unmatchedNumericEvidence(claim, [{ text: source, quote: source }])).toEqual([claim]);
  });

  it.each(["15억원", "1.5억원", "- 5억원", "△5억원", "(5억원)"])(
    "rejects a cropped quote from %s even though it is an exact substring",
    (text) => {
      expect(unmatchedNumericEvidence("5억원", [{ text, quote: "5억원" }])).toEqual(["5억원"]);
    },
  );

  it("accepts whitespace within a complete term without joining independent digits", () => {
    expect(
      unmatchedNumericEvidence("5 억 원, - 100 만 원, 2 백 만 원, 3 천 만 원", [
        { text: "5억원, -100만원, 2백만원, 3천만원", quote: "5억원, -100만원, 2백만원, 3천만원" },
      ]),
    ).toEqual([]);
    expect(unmatchedNumericEvidence("15억원", [{ text: "1 5억원", quote: "1 5억원" }])).toEqual([
      "15억원",
    ]);
  });

  it("requires the complete term including unit/suffix to be inside the chosen quote", () => {
    expect(unmatchedNumericEvidence("5%", [{ text: "5%p", quote: "5%" }])).toEqual(["5%"]);
    expect(unmatchedNumericEvidence("5억원", [{ text: "실적 5억원", quote: "실적 5억" }])).toEqual([
      "5억원",
    ]);
  });

  it("keeps comma-separated amounts distinct from comma-grouped digits", () => {
    const text = "5억원,6억원,1,500만원";
    expect(unmatchedNumericEvidence("5억원,6억원", [{ text, quote: text }])).toEqual([]);
    expect(unmatchedNumericEvidence("500만원", [{ text, quote: "500만원" }])).toEqual(["500만원"]);
  });

  it("uses full text for boundaries only and checks repeated quote occurrences", () => {
    const text = "15억원. 별도 사업의 매출은 5억원. 비용은 3억원.";
    expect(unmatchedNumericEvidence("5억원, 3억원", [{ text, quote: "5억원" }])).toEqual(["3억원"]);
    expect(unmatchedNumericEvidence("5억원", [{ text, quote: "없는 인용 5억원" }])).toEqual([
      "5억원",
    ]);
  });

  it("retains notation differences and leaves arithmetic, period and meaning to review", () => {
    const references = [{ text: "2024년 목표 1,000만원", quote: "2024년 목표 1,000만원" }];
    const before = structuredClone(references);
    expect(unmatchedNumericEvidence("2025년 실적 1,000만원", references)).toEqual([]);
    expect(unmatchedNumericEvidence("1000만원 및 0.1억원", references)).toEqual([
      "1000만원",
      "0.1억원",
    ]);
    expect(references).toEqual(before);
  });

  it("deduplicates whitespace-equivalent claims without matching absent or blank quotes", () => {
    expect(
      unmatchedNumericEvidence("5억원 / 5 억 원 / 5억원", [{ text: "5억원", quote: " " }]),
    ).toEqual(["5억원"]);
    expect(unmatchedNumericEvidence("일반 설명", [])).toEqual([]);
  });
});
