import { expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => {
  throw Error("SQL forbidden");
});
vi.mock("openai", () => {
  throw Error("SDK forbidden");
});
import { manualSourceFixture, manualId } from "../../scripts/fixtures/manual-source-receipt";
import { numericLiteralAt, type NumericObservation } from "./studio-numeric-check-types";
import {
  applyNumericSuggestion,
  numericSuggestionBasis,
  numericSuggestions,
  prepareNumericSuggestions,
} from "./studio-numeric-suggestions";

function fixture() {
  const { company } = manualSourceFixture();
  const source = company.sources[1];
  source.text = "첫 수량 1,200.50개\n둘째 수량 1,200.50개와 증감 -25.5개";
  const value: NumericObservation = {
    id: manualId(9),
    label: "직접 쓴 이름",
    valueText: "",
    unit: "unknown",
    customUnit: "",
    period: { kind: "unknown", start: "", end: "" },
    basis: "unknown",
    note: "직접 쓴 메모",
    reference: {
      kind: "source",
      sourceId: source.id,
      sourceUpdatedAt: source.updatedAt,
      quote: "",
      locator: "직접 쓴 위치",
    },
  };
  return { company, source, value };
}
it("keeps exact signed/grouped decimals and separate occurrences with contextual quotes", () => {
  const { source } = fixture();
  const result = numericSuggestions(source.text);
  expect(result.candidates.map((c) => [c.valueText, c.line])).toEqual([
    ["1,200.50", 1],
    ["1,200.50", 2],
    ["-25.5", 2],
  ]);
  expect(new Set(result.candidates.map((c) => c.id)).size).toBe(3);
  for (const c of result.candidates) {
    expect(source.text.slice(c.start, c.end)).toBe(c.valueText);
    expect(source.text.slice(c.quoteStart, c.quoteStart + c.quote.length)).toBe(c.quote);
  }
  expect(result.limited).toBe(false);
});
it.each([
  "1e3",
  "ID123",
  "01",
  "1,23",
  "1.1234567",
  "1234567890123456789",
  ".5",
  "1.2.3",
  "(120)",
  "（120）",
  "△120",
  "−120",
  "－120",
  "±120",
  "- 120",
  "- ₩120",
  "1/2",
  "1 : 2",
  "10~20",
  "10–20",
  "10 + 20",
  "10 +20",
  "10 -20",
  "2026-10-14",
])("does not turn unsupported notation %s into a partial number", (text) => {
  expect(numericSuggestions(text).candidates).toEqual([]);
});
it("bounds context, preserves literal markup and never turns UTF-16 positions into page coordinates", () => {
  const text = "😀<script>不実行</script> " + "가".repeat(200) + " 123개 " + "나".repeat(200);
  const c = numericSuggestions(text).candidates[0];
  expect(c.quote.length).toBeLessThanOrEqual(163);
  expect(text.slice(c.start, c.end)).toBe("123");
  expect(c.quoteStart).toBe(c.start - 80);
});
it("reports the candidate limit without clipping a number and refuses oversized source text", () => {
  const text = Array.from({ length: 101 }, (_, i) => `수량 ${i}개`).join("\n");
  expect(numericSuggestions(text)).toMatchObject({ limited: true });
  expect(numericSuggestions(text).candidates).toHaveLength(100);
  expect(numericSuggestions("가".repeat(200000)).limited).toBe(false);
  expect(() => numericSuggestions("가".repeat(200001))).toThrow(/200,000/);
});
it("checks an exact occurrence instead of accepting another identical number", () => {
  const text = "x10 앞 10개";
  expect(numericLiteralAt(text, 1, "10")).toBe(false);
  expect(numericLiteralAt(text, text.lastIndexOf("10"), "10")).toBe(true);
  expect(numericLiteralAt(text, -1, "10")).toBe(false);
  expect(numericLiteralAt(text, 0.5, "10")).toBe(false);
});
it("copies just the selected number and quote; nothing is saved, inferred or mutated", () => {
  const { company, value } = fixture(),
    before = structuredClone({ company, value });
  const prepared = prepareNumericSuggestions(company, value);
  const choice = prepared.candidates[1];
  const next = applyNumericSuggestion(company, value, prepared, choice.id, false);
  expect(next).toEqual({
    ...value,
    valueText: choice.valueText,
    reference: { ...value.reference, quote: choice.quote },
  });
  expect({ company, value }).toEqual(before);
  expect(next.unit).toBe("unknown");
  expect(next.period.kind).toBe("unknown");
  expect(next.basis).toBe("unknown");
});
it("requires explicit replacement and preserves independently entered fields", () => {
  const { company, value } = fixture();
  value.valueText = "99";
  value.reference!.quote = "以前の記録";
  value.unit = "item";
  value.basis = "target";
  value.period = { kind: "point", start: "2026-10-14", end: "" };
  const prepared = prepareNumericSuggestions(company, value),
    choice = prepared.candidates[0];
  expect(() => applyNumericSuggestion(company, value, prepared, choice.id, false)).toThrow(/기존/);
  const next = applyNumericSuggestion(company, value, prepared, choice.id, true);
  expect({ ...next, valueText: value.valueText, reference: value.reference }).toEqual(value);
  expect(next.reference).toEqual({ ...value.reference, quote: choice.quote });
});
it("supports the exact old plan even when a newer plan exists", () => {
  const { company, value } = fixture();
  const plan = company.plans[0];
  plan.content.sections[0].content = "원래 원고의 수량 25개";
  const next = structuredClone(plan);
  next.id = manualId(90);
  next.version++;
  company.plans.push(next);
  value.reference = {
    kind: "plan",
    planId: plan.id,
    sectionKey: plan.content.sections[0].key,
    quote: "",
  };
  const prepared = prepareNumericSuggestions(company, value);
  const result = applyNumericSuggestion(company, value, prepared, prepared.candidates[0].id, false);
  expect(result.valueText).toBe("25");
  expect(result.reference).toMatchObject({ planId: plan.id });
});
it.each([
  "company",
  "revision",
  "observation",
  "text",
  "updated",
  "pending",
  "missing",
  "duplicate",
  "other-reference",
])("rejects a stale source suggestion after %s changes", (kind) => {
  const { company, source, value } = fixture();
  const prepared = prepareNumericSuggestions(company, value);
  if (kind === "company") company.id = manualId(40);
  if (kind === "revision") company.revision++;
  if (kind === "observation") value.id = manualId(40);
  if (kind === "text") source.text += " changed";
  if (kind === "updated") source.updatedAt = "2026-10-14T00:00:00.000Z";
  if (kind === "pending") source.extraction = "pending";
  if (kind === "missing") company.sources = [];
  if (kind === "duplicate") company.sources.push(structuredClone(source));
  if (kind === "other-reference") value.reference = null;
  const before = structuredClone({ company, value });
  expect(() =>
    applyNumericSuggestion(company, value, prepared, prepared.candidates[0].id, false),
  ).toThrow();
  expect({ company, value }).toEqual(before);
});
it.each(["version", "text", "duplicate-plan", "duplicate-section", "missing-section"])(
  "rejects changed or ambiguous saved plan %s",
  (kind) => {
    const { company, value } = fixture(),
      plan = company.plans[0];
    plan.content.sections[0].content = "수량 10개";
    value.reference = {
      kind: "plan",
      planId: plan.id,
      sectionKey: plan.content.sections[0].key,
      quote: "",
    };
    const prepared = prepareNumericSuggestions(company, value);
    if (kind === "version") plan.version++;
    if (kind === "text") plan.content.sections[0].content += " 변경";
    if (kind === "duplicate-plan") company.plans.push(structuredClone(plan));
    if (kind === "duplicate-section")
      plan.content.sections.push(structuredClone(plan.content.sections[0]));
    if (kind === "missing-section") plan.content.sections = [];
    expect(() =>
      applyNumericSuggestion(company, value, prepared, prepared.candidates[0].id, false),
    ).toThrow();
  },
);
it("rederives candidates and rejects an invented position", () => {
  const { company, value } = fixture(),
    prepared = prepareNumericSuggestions(company, value);
  const id = prepared.candidates[0].id;
  prepared.candidates[0].valueText = "999";
  prepared.candidates[0].quote = "invented";
  expect(applyNumericSuggestion(company, value, prepared, id, false).valueText).toBe("1,200.50");
  expect(() => applyNumericSuggestion(company, value, prepared, "0:1", false)).toThrow();
  value.reference = null;
  expect(numericSuggestionBasis(company, value)).toBeNull();
});
