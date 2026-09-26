import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type SourceDocument } from "./studio-schema";
import {
  assertNumericCheckCapacity,
  buildNumericCheck,
  isNumericCheckReplay,
  numericCheckInputDigest,
} from "./studio-numeric-check";
import {
  evaluateNumericCheck,
  numericCheckContext,
  numericCheckInputSchema,
  numericLiteralOccurs,
  numericObservationSchema,
  type NumericCheckInput,
  type NumericObservation,
  type NumericFormula,
} from "./studio-numeric-check-types";

const now = "2026-09-25T00:00:00.000Z";
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function observation(
  valueText: string,
  unit: NumericObservation["unit"] = "item",
): NumericObservation {
  return {
    id: randomUUID(),
    label: "합성 수치",
    valueText,
    unit,
    customUnit: "",
    period: { kind: "range", start: "2025-01-01", end: "2025-12-31" },
    basis: "reported",
    reference: {
      kind: "plan",
      planId: randomUUID(),
      sectionKey: "technology",
      quote: valueText || "미확인",
    },
    note: "입력값의 진위는 확인하지 않음",
  };
}
function calculation(
  operation: NumericFormula["operation"],
  a: string,
  b: string,
  expected: string,
  units: NumericObservation["unit"][] = ["item", "item", "item"],
) {
  const observations = [
    observation(a, units[0]),
    observation(b, units[1]),
    observation(expected, units[2]),
  ];
  return evaluateNumericCheck({
    observations,
    comparisons: [],
    formulas: [
      {
        id: randomUUID(),
        operation,
        operandIds: observations.slice(0, 2).map((item) => item.id),
        expectedId: observations[2].id,
      },
    ],
  }).formulas[0];
}
function fixture() {
  const planId = randomUUID();
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 수치 대조 회사" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [
      {
        id: planId,
        version: 2,
        generatedAt: now,
        mode: "manual",
        candidateId: "fixture",
        sourceRevision: 0,
        content: {
          title: "합성 원고",
          summary: "수치 대조",
          sections: [
            {
              key: "technology",
              title: "시험",
              content: "수량 10개와 20개, 합계 30개입니다.",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: [],
        },
        review: [],
        confirmedAt: null,
      },
    ],
    tasks: [],
    stage: "preparing",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const observations = ["10", "20", "30"].map((value) => ({
    ...observation(value),
    reference: { kind: "plan" as const, planId, sectionKey: "technology", quote: `${value}개` },
  }));
  const input: NumericCheckInput = {
    checkId: null,
    previousVersionId: null,
    title: "합성 수량 대조",
    observations,
    comparisons: [{ id: randomUUID(), leftId: observations[0].id, rightId: observations[1].id }],
    formulas: [
      {
        id: randomUUID(),
        operation: "sum",
        operandIds: observations.slice(0, 2).map((item) => item.id),
        expectedId: observations[2].id,
      },
    ],
    judgement: { state: "unreviewed", reviewer: "", note: "" },
  };
  const reader = vi.fn<
    (sourceId: string) => { source: SourceDocument; buffer: Buffer; sha256: string }
  >(() => {
    throw new Error("Unexpected original read");
  });
  const build = (value = input) =>
    buildNumericCheck(
      company,
      numericCheckInputSchema.parse(value),
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: numericCheckInputDigest(value),
        recordedAt: now,
      },
      reader,
    );
  const next = (): NumericCheckInput => ({
    ...structuredClone(input),
    checkId: company.numericChecks[0].checkId,
    previousVersionId: company.numericChecks.at(-1)!.id,
  });
  const addSource = (original = false) => {
    const source: SourceDocument = {
      id: randomUUID(),
      name: "합성 실적 표",
      kind: "finance",
      text: "수량 10개입니다.",
      originalName: original ? "fixture.pdf" : null,
      mimeType: original ? "application/pdf" : null,
      extraction: "manual",
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    company.sources.push(source);
    input.observations[0].reference = {
      kind: "source",
      sourceId: source.id,
      sourceUpdatedAt: now,
      quote: "10개",
      locator: "1쪽",
    };
    const buffer = Buffer.from("synthetic original");
    reader.mockReturnValue({ source, buffer, sha256: hash(buffer) });
    return { source, buffer };
  };
  return { company, input, build, next, reader, addSource };
}
describe("정확한 십진 산술", () => {
  it.each([
    ["sum", "0.1", "0.2", "0.3", ["item", "item", "item"], "0.3"],
    ["difference", "1.01", "1", "0.01", ["item", "item", "item"], "0.01"],
    ["product", "100.25", "3", "300.75", ["KRW/item", "item", "KRW"], "300.75"],
    ["quotient", "1", "8", "0.125", ["item", "item", "ratio"], "0.125"],
    ["percentage", "1", "8", "12.5", ["item", "item", "percent"], "12.5"],
    [
      "sum",
      "999999999999999998",
      "1",
      "999999999999999999",
      ["KRW", "KRW", "KRW"],
      "999999999999999999",
    ],
    ["sum", "-0.1", "+0.1", "0", ["item", "item", "item"], "0"],
    ["product", "1,000", "2", "2,000", ["ratio", "KRW", "KRW"], "2000"],
  ] as const)("%s %s/%s exact", (operation, a, b, expected, units, decimal) => {
    expect(calculation(operation, a, b, expected, [...units])).toMatchObject({
      state: "arithmetic-equal",
      result: { decimal },
      reasons: [],
    });
  });
  it("does not round one third to match six decimal digits", () => {
    expect(calculation("quotient", "1", "3", "0.333333", ["item", "item", "ratio"])).toMatchObject({
      state: "arithmetic-difference",
      result: { numerator: "1", denominator: "3", decimal: null },
    });
  });
  it.each(["quotient", "percentage"] as const)("%s never divides by zero", (operation) => {
    expect(
      calculation(operation, "1", "-0.0", "0", [
        "item",
        "item",
        operation === "quotient" ? "ratio" : "percent",
      ]),
    ).toMatchObject({ state: "division-by-zero", result: null, reasons: ["DIVISION_BY_ZERO"] });
  });
  it("retains products beyond safe Number range without conversion", () => {
    const value = calculation("product", "999999999999999999", "999999999999999999", "1", [
      "ratio",
      "ratio",
      "ratio",
    ]);
    expect(value).toMatchObject({
      state: "arithmetic-difference",
      result: { numerator: "999999999999999998000000000000000001", denominator: "1" },
    });
  });
  it.each([
    ["product", ["item", "item", "item"]],
    ["product", ["percent", "KRW", "KRW"]],
    ["quotient", ["KRW", "hour", "KRW"]],
    ["sum", ["KRW", "thousand-KRW", "KRW"]],
  ] as const)("refuses unsupported %s unit relation %s", (operation, units) => {
    expect(calculation(operation, "1", "1", "1", [...units])).toMatchObject({
      state: "not-comparable",
      result: null,
    });
  });
  it("does not compare a calculated ratio with a percent without an explicit percentage operation", () => {
    expect(calculation("quotient", "1", "2", "0.5", ["item", "item", "percent"])).toMatchObject({
      state: "not-comparable",
      reasons: ["UNIT_MISMATCH"],
    });
  });
  it.each([
    "unknown-unit",
    "unknown-period",
    "unknown-basis",
    "unknown-value",
    "no-reference",
    "period-kind",
    "period-date",
    "basis",
    "custom-unit",
    "money-scale",
  ])("keeps equal numbers not comparable: %s", (kind) => {
    const left = observation("10"),
      right = observation("10");
    if (kind === "unknown-unit") left.unit = "unknown";
    if (kind === "unknown-period") left.period = { kind: "unknown", start: "", end: "" };
    if (kind === "unknown-basis") left.basis = "unknown";
    if (kind === "unknown-value") left.valueText = "";
    if (kind === "no-reference") left.reference = null;
    if (kind === "period-kind") left.period = { kind: "point", start: "2025-12-31", end: "" };
    if (kind === "period-date") left.period.start = "2025-02-01";
    if (kind === "basis") left.basis = "target";
    if (kind === "custom-unit") {
      left.unit = "custom";
      left.customUnit = "A단위";
      right.unit = "custom";
      right.customUnit = "B단위";
    }
    if (kind === "money-scale") {
      left.unit = "KRW";
      right.unit = "thousand-KRW";
    }
    const result = evaluateNumericCheck({
      observations: [left, right],
      comparisons: [{ id: randomUUID(), leftId: left.id, rightId: right.id }],
      formulas: [],
    });
    expect(result.comparisons[0].state).toBe("not-comparable");
    expect(result.factVerification).toBe("not-performed");
  });
  it("compares compatible transcriptions, never labels truth", () => {
    const left = observation("1,000.00"),
      right = observation("1000");
    left.unit = "custom";
    right.unit = "custom";
    left.customUnit = "동일 표기";
    right.customUnit = "동일 표기";
    const result = evaluateNumericCheck({
      observations: [left, right],
      comparisons: [{ id: randomUUID(), leftId: left.id, rightId: right.id }],
      formulas: [],
    });
    expect(result.comparisons[0].state).toBe("numeric-equal");
    expect(result.factVerification).toBe("not-performed");
  });
});
describe("원문 수치의 완전한 토큰 경계", () => {
  it.each([
    ["총 100원", "10", "10", false],
    ["총 100원", "100", "100", true],
    ["총 ₩100원", "₩100", "100", true],
    ["총 -100원", "100", "100", false],
    ["총 +100원", "100", "100", false],
    ["총 −100원", "100", "100", false],
    ["총 -₩100원", "100", "100", false],
    ["총 ₩-100원", "-100", "-100", true],
    ["총 -100원", "-100", "-100", true],
    ["금액 (100)", "100", "100", false],
    ["수치 0.10", "10", "10", false],
    ["수치 .10", "10", "10", false],
    ["수치 10.5", "10", "10", false],
    ["수치 1,000.00원", "1,000.00", "1,000.00", true],
    ["수치 1,000원", "000", "0", false],
    ["수치 1e3", "1", "1", false],
    ["수치 1e3", "3", "3", false],
    ["수치 100원 / 10개", "10", "10", true],
    ["수치 10%", "10%", "10", true],
    ["비율 1/2", "비율 1/2", "1", false],
    ["비율 1/2", "비율 1/2", "2", false],
    ["비율 1 / - 2", "1", "1", false],
    ["비율 1 / (2)", "1", "1", false],
    ["비율 1 ⁄ - 2", "1", "1", false],
    ["비율 1 ∕ (2)", "1", "1", false],
    ["비율 1 ⁄ 2", "1 ⁄ 2", "1", false],
    ["비율 1 ∕ 2", "1 ∕ 2", "2", false],
    ["차감 △10원", "10", "10", false],
    ["차감 ▲ ₩10원", "10", "10", false],
    ["차감 －10원", "10", "10", false],
    ["산식 10*2", "10*2", "10", false],
    ["기간 2025-01-01", "2025", "2025", false],
    ["수량 10~20개", "10~20", "10", false],
    ["비율 1:2", "1:2", "2", false],
    ["수량: 10개", "10개", "10", true],
    ["수치 0.000001", "0.000001", "0.000001", true],
  ])("%s quote %s = %s", (text, quote, value, expected) =>
    expect(numericLiteralOccurs(text, quote, value)).toBe(expected),
  );
  it.each([
    "1e3",
    "1+1",
    "Infinity",
    "NaN",
    " 10",
    "01",
    "1,00",
    "0.0000001",
    "1000000000000000000",
    "(100)",
  ])("rejects unsafe/noncanonical literal %s", (value) =>
    expect(numericObservationSchema.safeParse(observation(value)).success).toBe(false),
  );
  it.each([
    { kind: "point", start: "2025-02-29", end: "" },
    { kind: "range", start: "2025-02-01", end: "2025-01-01" },
    { kind: "unknown", start: "2025-01-01", end: "" },
    { kind: "not-applicable", start: "2025-01-01", end: "" },
  ])("rejects malformed period %j", (period) =>
    expect(numericObservationSchema.safeParse({ ...observation("1"), period }).success).toBe(false),
  );
});
describe("수치 대조 이력·근거 고정", () => {
  it("pins exact plans and keeps initial judgement unreviewed", () => {
    const f = fixture();
    const before = structuredClone(f.company);
    const record = f.build();
    expect(record).toMatchObject({
      version: 1,
      origin: "manual",
      judgement: { state: "unreviewed", recordedAt: null },
      evaluation: { factVerification: "not-performed" },
    });
    expect(record.planSnapshots[0]).toEqual({
      planId: f.company.plans[0].id,
      version: 2,
      contentSha256: hash(JSON.stringify(f.company.plans[0].content)),
    });
    expect(f.company).toEqual(before);
  });
  it.each([
    "first-judgement",
    "missing-reviewer",
    "duplicate-observation",
    "missing-target",
    "eval",
    "metadata",
  ])("rejects strict input %s", (kind) => {
    const f = fixture();
    const value = structuredClone(f.input) as NumericCheckInput & Record<string, unknown>;
    if (kind === "first-judgement") value.judgement.state = "reviewed";
    if (kind === "missing-reviewer") {
      value.checkId = randomUUID();
      value.previousVersionId = randomUUID();
      value.judgement.state = "needs-work";
    }
    if (kind === "duplicate-observation") value.observations.push(value.observations[0]);
    if (kind === "missing-target") value.formulas[0].expectedId = randomUUID();
    if (kind === "eval") value.formulas[0].operation = "eval" as NumericFormula["operation"];
    if (kind === "metadata") value.evaluation = { factVerification: "passed" };
    expect(numericCheckInputSchema.safeParse(value).success).toBe(false);
  });
  it("requires the latest root version but preserves past judgement", () => {
    const f = fixture();
    const first = f.build();
    f.company.numericChecks.push(first);
    const next = f.next();
    next.judgement = { state: "needs-work", reviewer: "가상 담당자", note: "원문 진위 별도" };
    const second = f.build(next);
    f.company.numericChecks.push(second);
    expect(second.version).toBe(2);
    expect(second.judgement.recordedAt).toBe(now);
    expect(f.company.numericChecks[0]).toEqual(first);
    expect(() => f.build(next)).toThrow(
      expect.objectContaining({ code: "NUMERIC_CHECK_VERSION_STALE" }),
    );
  });
  it.each([
    "foreign-source",
    "old-source",
    "pending",
    "quote",
    "cropped-number",
    "foreign-plan",
    "duplicate-section",
  ])("rejects %s before file reads", (kind) => {
    const f = fixture();
    const { source } = f.addSource(true);
    const ref = f.input.observations[0].reference!;
    if (kind === "foreign-source" && ref.kind === "source") ref.sourceId = randomUUID();
    if (kind === "old-source" && ref.kind === "source") ref.sourceUpdatedAt = "old";
    if (kind === "pending") source.extraction = "pending";
    if (kind === "quote") ref.quote = "없는 인용";
    if (kind === "cropped-number") {
      source.text = "수량 100개";
      ref.quote = "10";
    }
    if (kind === "foreign-plan")
      f.input.observations[1].reference = {
        kind: "plan",
        planId: randomUUID(),
        sectionKey: "technology",
        quote: "20개",
      };
    if (kind === "duplicate-section")
      f.company.plans[0].content.sections.push(
        structuredClone(f.company.plans[0].content.sections[0]),
      );
    expect(f.build).toThrow();
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("keeps explicitly missing numbers/references unverified instead of inventing evidence", () => {
    const f = fixture();
    f.input.observations[0].valueText = "";
    f.input.observations[0].reference = null;
    const record = f.build();
    expect(record.evaluation.formulas[0].state).toBe("not-comparable");
    expect(record.evaluation.unresolved[0].reasons).toEqual(["MISSING_VALUE", "MISSING_REFERENCE"]);
  });
  it("hashes originals twice and rejects same-size changes", () => {
    const f = fixture();
    const { source, buffer } = f.addSource(true);
    const changed = Buffer.alloc(buffer.length, 120);
    f.reader
      .mockReturnValueOnce({ source, buffer, sha256: hash(buffer) })
      .mockReturnValueOnce({ source, buffer: changed, sha256: hash(changed) });
    expect(f.build).toThrow(expect.objectContaining({ code: "NUMERIC_ORIGINAL_CHANGED" }));
    f.reader.mockReturnValue({ source, buffer, sha256: hash(buffer) });
    const first = f.build();
    f.company.numericChecks.push(first);
    f.reader.mockReturnValue({ source, buffer: changed, sha256: hash(changed) });
    expect(() => f.build(f.next())).toThrow(
      expect.objectContaining({ code: "NUMERIC_ORIGINAL_CHANGED" }),
    );
  });
  it("refuses same-ID plan mutation despite preserved selected numbers", () => {
    const f = fixture();
    f.company.numericChecks.push(f.build());
    f.company.plans[0].content.summary += "변경";
    expect(() => f.build(f.next())).toThrow(
      expect.objectContaining({ code: "NUMERIC_PLAN_CHANGED" }),
    );
  });
  it("marks changed sources stale without rewriting saved judgement", () => {
    const f = fixture();
    const { source } = f.addSource();
    f.company.numericChecks.push(f.build());
    const next = f.next();
    next.judgement = { state: "reviewed", reviewer: "담당자", note: "전사·산술만 확인" };
    const record = f.build(next);
    expect(numericCheckContext(f.company, record)).toMatchObject({
      state: "current",
      judgementCurrent: true,
      originalCheck: "saved-only",
    });
    source.updatedAt += "x";
    expect(numericCheckContext(f.company, record)).toMatchObject({
      state: "stale",
      judgementCurrent: false,
    });
    expect(record.judgement.state).toBe("reviewed");
  });
  it("preserves idempotency and rejects conflicts", () => {
    const record = fixture().build();
    expect(isNumericCheckReplay([record], record.clientRequestId, record.inputDigest)).toBe(true);
    expect(isNumericCheckReplay([record], randomUUID(), record.inputDigest)).toBe(false);
    expect(() => isNumericCheckReplay([record], record.clientRequestId, "b".repeat(64))).toThrow(
      expect.objectContaining({ code: "NUMERIC_CHECK_REQUEST_CONFLICT" }),
    );
  });
  it("refuses limits without trimming history", () => {
    const record = fixture().build();
    expect(() => assertNumericCheckCapacity(Array(101).fill(record))).toThrow(
      expect.objectContaining({ code: "NUMERIC_CHECK_LIMIT" }),
    );
    expect(() =>
      assertNumericCheckCapacity(Array(30).fill({ ...record, title: "x".repeat(10000) })),
    ).toThrow(expect.objectContaining({ code: "NUMERIC_CHECK_LIMIT" }));
  });
});
