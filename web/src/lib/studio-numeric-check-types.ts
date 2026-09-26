import { z } from "zod";
import { appealPreparationSchema } from "./studio-appeal-types";
import type { StudioCase } from "./studio-schema";

export const numericCheckLimits = {
  versions: 100,
  characters: 200_000,
  observations: 20,
  comparisons: 20,
  formulas: 20,
  sources: 10,
  plans: 10,
  originalBytes: 12 * 1024 * 1024,
  totalOriginalBytes: 24 * 1024 * 1024,
  requestBytes: 512 * 1024,
} as const;
export const numericUnitLabels = {
  unknown: "단위 미확인",
  KRW: "원",
  "thousand-KRW": "천원",
  "million-KRW": "백만원",
  item: "개",
  person: "명",
  hour: "시간",
  "KRW/item": "원/개",
  "KRW/person": "원/명",
  "item/hour": "개/시간",
  ratio: "배",
  percent: "%",
  custom: "기타 (표기 직접 입력)",
} as const;
export const numericBasisLabels = {
  reported: "자료에 기재된 수치",
  target: "목표 수치",
  assumption: "가정 수치",
  unknown: "실적·목표·가정 구분 미확인",
} as const;
export const numericOperationLabels = {
  sum: "합계",
  difference: "차이 (첫 값 - 둘째 값)",
  product: "곱 (두 값)",
  quotient: "나눗셈 (첫 값 / 둘째 값)",
  percentage: "비율 (첫 값 / 둘째 값 × 100)",
} as const;
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Boolean(value.trim()));
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(new Date(`${value}T00:00:00.000Z`).getTime()) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
export const numericPeriodSchema = z
  .object({
    kind: z.enum(["unknown", "point", "range", "not-applicable"]),
    start: z.string().max(10),
    end: z.string().max(10),
  })
  .strict()
  .refine(
    (period) =>
      period.kind === "point"
        ? validDate(period.start) && period.end === ""
        : period.kind === "range"
          ? validDate(period.start) && validDate(period.end) && period.start <= period.end
          : period.start === "" && period.end === "",
    "기준일·기간을 확인해 주세요. 미확인·기간 해당 없음은 날짜를 비워 둡니다.",
  );
// Explicit decimal transcription only: no exponent, evaluation, implicit units, or rounding.
export const numericLiteralPattern =
  /^[+-]?(?:0|[1-9]\d{0,17}|[1-9]\d{0,2}(?:,\d{3}){1,5})(?:\.\d{1,6})?$/;
export const numericReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source"),
      sourceId: uuid,
      sourceUpdatedAt: z.string().min(1).max(100),
      quote: nonblank(1500),
      locator: z.string().max(150),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan"),
      planId: uuid,
      sectionKey: nonblank(100),
      quote: nonblank(1500),
    })
    .strict(),
]);
export type NumericReference = z.infer<typeof numericReferenceSchema>;
export const numericObservationSchema = z
  .object({
    id: uuid,
    label: z.string().trim().min(1).max(200),
    valueText: z
      .string()
      .max(32)
      .refine(
        (value) => value === "" || numericLiteralPattern.test(value),
        "숫자는 원문의 부호·쉼표를 유지한 십진수로 입력해 주세요. 정수 18자리·소수 6자리 이내이며 미확인 값은 비워 둡니다.",
      ),
    unit: z.enum([
      "unknown",
      "KRW",
      "thousand-KRW",
      "million-KRW",
      "item",
      "person",
      "hour",
      "KRW/item",
      "KRW/person",
      "item/hour",
      "ratio",
      "percent",
      "custom",
    ]),
    customUnit: z.string().trim().max(60),
    period: numericPeriodSchema,
    basis: z.enum(["reported", "target", "assumption", "unknown"]),
    reference: numericReferenceSchema.nullable(),
    note: z.string().max(2000),
  })
  .strict()
  .refine(
    (item) => (item.unit === "custom" ? Boolean(item.customUnit) : item.customUnit === ""),
    "기타 단위의 정확한 표기만 입력해 주세요.",
  );
export type NumericObservation = z.infer<typeof numericObservationSchema>;
export const numericFormulaSchema = z
  .object({
    id: uuid,
    operation: z.enum(["sum", "difference", "product", "quotient", "percentage"]),
    operandIds: z
      .array(uuid)
      .min(2)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length),
    expectedId: uuid,
  })
  .strict()
  .refine(
    (value) => value.operation === "sum" || value.operandIds.length === 2,
    "합계 외 산식은 피연산값 2개를 선택해 주세요.",
  )
  .refine(
    (value) => !value.operandIds.includes(value.expectedId),
    "계산 대상과 대조할 값은 서로 다른 항목으로 선택해 주세요.",
  );
export type NumericFormula = z.infer<typeof numericFormulaSchema>;
const checkFields = {
  title: z.string().trim().min(1).max(300),
  observations: z
    .array(numericObservationSchema)
    .min(1)
    .max(numericCheckLimits.observations)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  comparisons: z
    .array(
      z
        .object({ id: uuid, leftId: uuid, rightId: uuid })
        .strict()
        .refine((value) => value.leftId !== value.rightId),
    )
    .max(numericCheckLimits.comparisons)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  formulas: z
    .array(numericFormulaSchema)
    .max(numericCheckLimits.formulas)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
};
export const numericCheckInputSchema = z
  .object({
    checkId: uuid.nullable(),
    previousVersionId: uuid.nullable(),
    ...checkFields,
    judgement: z
      .object({
        state: z.enum(["unreviewed", "needs-work", "reviewed"]),
        reviewer: z.string().trim().max(100),
        note: z.string().max(3000),
      })
      .strict(),
  })
  .strict()
  .refine((input) => (input.checkId === null) === (input.previousVersionId === null))
  .refine(
    (input) =>
      input.judgement.state === "unreviewed" ||
      (input.checkId !== null && Boolean(input.judgement.reviewer)),
    "최초 대조안은 미검토로 저장합니다. 후속 판단에는 담당자를 입력해 주세요.",
  )
  .refine((input) => {
    const ids = new Set(input.observations.map((item) => item.id));
    return (
      input.comparisons.every((item) => ids.has(item.leftId) && ids.has(item.rightId)) &&
      input.formulas.every(
        (item) => ids.has(item.expectedId) && item.operandIds.every((id) => ids.has(id)),
      )
    );
  }, "비교·산식에는 이 대조안에 포함된 수치만 선택해 주세요.");
export type NumericCheckInput = z.infer<typeof numericCheckInputSchema>;
export const numericCheckAppendMutationSchema = z
  .object({
    action: z.literal("append-numeric-check"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: uuid,
    check: numericCheckInputSchema,
  })
  .strict();
export const numericReasonLabels = {
  MISSING_VALUE: "수치 미확인",
  MISSING_REFERENCE: "정확한 원고·자료 인용 미연결",
  UNKNOWN_UNIT: "단위 미확인",
  UNKNOWN_PERIOD: "기간 미확인",
  UNKNOWN_BASIS: "실적·목표·가정 구분 미확인",
  UNIT_MISMATCH: "단위 표기 다름 · 자동 환산하지 않음",
  PERIOD_MISMATCH: "기준일·기간 다름",
  BASIS_MISMATCH: "자료 기재·목표·가정 구분 다름",
  UNSUPPORTED_UNIT_RULE: "이 산식의 단위 관계를 자동 확인할 수 없음",
  DIVISION_BY_ZERO: "0으로 나눌 수 없음",
} as const;
const reasonSchema = z.enum([
  "MISSING_VALUE",
  "MISSING_REFERENCE",
  "UNKNOWN_UNIT",
  "UNKNOWN_PERIOD",
  "UNKNOWN_BASIS",
  "UNIT_MISMATCH",
  "PERIOD_MISMATCH",
  "BASIS_MISMATCH",
  "UNSUPPORTED_UNIT_RULE",
  "DIVISION_BY_ZERO",
]);
export type NumericReason = z.infer<typeof reasonSchema>;
const exactValueSchema = z
  .object({
    numerator: z.string().regex(/^-?\d{1,120}$/),
    denominator: z.string().regex(/^[1-9]\d{0,119}$/),
    decimal: z.string().max(150).nullable(),
  })
  .strict();
export const numericEvaluationSchema = z
  .object({
    algorithm: z.literal("exact-decimal-v1"),
    comparisons: z
      .array(
        z
          .object({
            id: uuid,
            state: z.enum(["numeric-equal", "numeric-difference", "not-comparable"]),
            reasons: z.array(reasonSchema).max(10),
          })
          .strict(),
      )
      .max(numericCheckLimits.comparisons),
    formulas: z
      .array(
        z
          .object({
            id: uuid,
            state: z.enum([
              "arithmetic-equal",
              "arithmetic-difference",
              "not-comparable",
              "division-by-zero",
            ]),
            result: exactValueSchema.nullable(),
            reasons: z.array(reasonSchema).max(10),
          })
          .strict(),
      )
      .max(numericCheckLimits.formulas),
    unresolved: z
      .array(z.object({ observationId: uuid, reasons: z.array(reasonSchema).max(5) }).strict())
      .max(numericCheckLimits.observations),
    factVerification: z.literal("not-performed"),
  })
  .strict();
export type NumericEvaluation = z.infer<typeof numericEvaluationSchema>;
export const numericCheckSchema = z
  .object({
    id: uuid,
    checkId: uuid,
    previousVersionId: uuid.nullable(),
    version: z.number().int().positive().max(numericCheckLimits.versions),
    clientRequestId: uuid,
    inputDigest: hash,
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
    ...checkFields,
    sourceSnapshots: appealPreparationSchema.shape.sourceSnapshots,
    planSnapshots: appealPreparationSchema.shape.planSnapshots.max(numericCheckLimits.plans),
    evaluation: numericEvaluationSchema,
    judgement: z
      .object({
        state: z.enum(["unreviewed", "needs-work", "reviewed"]),
        reviewer: z.string().max(100),
        note: z.string().max(3000),
        recordedAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export type NumericCheck = z.infer<typeof numericCheckSchema>;

type Rational = { n: bigint; d: bigint };
const zero = BigInt(0),
  one = BigInt(1),
  ten = BigInt(10);
function rational(n: bigint, d: bigint): Rational {
  if (d === zero) throw new Error("Invalid rational denominator");
  if (d < zero) {
    n = -n;
    d = -d;
  }
  let a = n < zero ? -n : n,
    b = d;
  while (b !== zero) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return { n: n / a, d: d / a };
}
function parseDecimal(value: string): Rational {
  if (!numericLiteralPattern.test(value)) throw new Error("Invalid decimal literal");
  const cleaned = value.replaceAll(",", "");
  const negative = cleaned.startsWith("-");
  const [whole, fraction = ""] = cleaned.replace(/^[+-]/, "").split(".");
  return rational(
    BigInt(`${whole}${fraction}`) * (negative ? -one : one),
    ten ** BigInt(fraction.length),
  );
}
function exactOutput(value: Rational) {
  let remaining = value.d,
    twos = 0,
    fives = 0;
  while (remaining % BigInt(2) === zero) {
    remaining /= BigInt(2);
    twos++;
  }
  while (remaining % BigInt(5) === zero) {
    remaining /= BigInt(5);
    fives++;
  }
  const places = Math.max(twos, fives);
  let decimal: string | null = null;
  if (remaining === one && places <= 12) {
    const scaled = (value.n * ten ** BigInt(places)) / value.d;
    const digits = (scaled < zero ? -scaled : scaled).toString().padStart(places + 1, "0");
    decimal = `${scaled < zero ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
  }
  return { numerator: value.n.toString(), denominator: value.d.toString(), decimal };
}
const unitKey = (value: NumericObservation) =>
  value.unit === "custom" ? `custom:${value.customUnit}` : value.unit;
function incomplete(value: NumericObservation): NumericReason[] {
  const result: NumericReason[] = [];
  if (value.valueText === "") result.push("MISSING_VALUE");
  if (!value.reference) result.push("MISSING_REFERENCE");
  if (value.unit === "unknown") result.push("UNKNOWN_UNIT");
  if (value.period.kind === "unknown") result.push("UNKNOWN_PERIOD");
  if (value.basis === "unknown") result.push("UNKNOWN_BASIS");
  return result;
}
function comparable(values: NumericObservation[], units = true): NumericReason[] {
  const reasons = values.flatMap(incomplete);
  if (units && new Set(values.map(unitKey)).size > 1) reasons.push("UNIT_MISMATCH");
  if (new Set(values.map((value) => JSON.stringify(value.period))).size > 1)
    reasons.push("PERIOD_MISMATCH");
  if (new Set(values.map((value) => value.basis)).size > 1) reasons.push("BASIS_MISMATCH");
  return [...new Set(reasons)];
}
function outputUnit(
  operation: NumericFormula["operation"],
  values: NumericObservation[],
): string | null {
  const keys = values.map(unitKey);
  if (operation === "sum" || operation === "difference")
    return new Set(keys).size === 1 ? keys[0] : null;
  if (operation === "percentage") return keys[0] === keys[1] ? "percent" : null;
  if (operation === "product") {
    if (keys[0] === "ratio") return keys[1];
    if (keys[1] === "ratio") return keys[0];
    const pair = [...keys].sort().join("|");
    return (
      (
        { "KRW/item|item": "KRW", "KRW/person|person": "KRW", "hour|item/hour": "item" } as Record<
          string,
          string
        >
      )[pair] ?? null
    );
  }
  if (keys[0] === keys[1]) return "ratio";
  if (keys[1] === "ratio") return keys[0];
  return (
    (
      { "KRW|item": "KRW/item", "KRW|person": "KRW/person", "item|hour": "item/hour" } as Record<
        string,
        string
      >
    )[keys.join("|")] ?? null
  );
}

/** Calculates only the declared values/context. It never checks truth or infers units/periods. */
export function evaluateNumericCheck(
  input: Pick<NumericCheckInput, "observations" | "comparisons" | "formulas">,
): NumericEvaluation {
  const lookup = (id: string) => {
    const values = input.observations.filter((item) => item.id === id);
    if (values.length !== 1) throw new Error("Invalid numeric target");
    return values[0];
  };
  const comparisons: NumericEvaluation["comparisons"] = input.comparisons.map((comparison) => {
    const left = lookup(comparison.leftId),
      right = lookup(comparison.rightId);
    const reasons = comparable([left, right]);
    if (reasons.length) return { id: comparison.id, state: "not-comparable", reasons };
    const a = parseDecimal(left.valueText),
      b = parseDecimal(right.valueText);
    return {
      id: comparison.id,
      state: a.n * b.d === b.n * a.d ? "numeric-equal" : "numeric-difference",
      reasons: [],
    };
  });
  const formulas: NumericEvaluation["formulas"] = input.formulas.map((formula) => {
    const values = formula.operandIds.map(lookup),
      expected = lookup(formula.expectedId);
    const reasons = comparable([...values, expected], false);
    const output = outputUnit(formula.operation, values);
    if (output === null) reasons.push("UNSUPPORTED_UNIT_RULE");
    else if (output !== unitKey(expected)) reasons.push("UNIT_MISMATCH");
    if (reasons.length)
      return {
        id: formula.id,
        state: "not-comparable",
        result: null,
        reasons: [...new Set(reasons)],
      };
    const args = values.map((value) => parseDecimal(value.valueText));
    if (
      (formula.operation === "quotient" || formula.operation === "percentage") &&
      args[1].n === zero
    )
      return {
        id: formula.id,
        state: "division-by-zero",
        result: null,
        reasons: ["DIVISION_BY_ZERO"],
      };
    let result = args[0];
    if (formula.operation === "sum")
      for (const value of args.slice(1))
        result = rational(result.n * value.d + value.n * result.d, result.d * value.d);
    else if (formula.operation === "difference")
      result = rational(args[0].n * args[1].d - args[1].n * args[0].d, args[0].d * args[1].d);
    else if (formula.operation === "product")
      result = rational(args[0].n * args[1].n, args[0].d * args[1].d);
    else
      result = rational(
        args[0].n * args[1].d * (formula.operation === "percentage" ? BigInt(100) : one),
        args[0].d * args[1].n,
      );
    const target = parseDecimal(expected.valueText);
    return {
      id: formula.id,
      state:
        result.n * target.d === target.n * result.d ? "arithmetic-equal" : "arithmetic-difference",
      result: exactOutput(result),
      reasons: [],
    };
  });
  return {
    algorithm: "exact-decimal-v1",
    comparisons,
    formulas,
    unresolved: input.observations
      .map((value) => ({ observationId: value.id, reasons: incomplete(value) }))
      .filter((value) => value.reasons.length),
    factVerification: "not-performed",
  };
}

/** The transcription must be a whole token in the actual source, not a cropped quote of 100 as 10. */
export function numericLiteralOccurs(text: string, quote: string, value: string): boolean {
  if (!value || !numericLiteralPattern.test(value)) return false;
  let occurrence = -1;
  for (let count = 0; count < 1000; count++) {
    occurrence = text.indexOf(quote, occurrence + 1);
    if (occurrence < 0) return false;
    let within = -1;
    while ((within = quote.indexOf(value, within + 1)) >= 0) {
      const start = occurrence + within,
        end = start + value.length;
      const before = text.slice(0, start),
        after = text.slice(end);
      if (/[A-Za-z0-9.,+\-−]$/.test(before) || /^[A-Za-z0-9.,+\-−]/.test(after)) continue;
      if (
        /[+\-−－﹣△▲▵]\s*[$₩￦€¥£]?\s*$/.test(before) ||
        /\(\s*[$₩￦€¥£]?\s*$/.test(before) ||
        /^\s*[/⁄∕]/.test(after) ||
        /\d\s*[*/⁄∕~～–—]\s*[$₩￦€¥£]?\s*$/.test(before) ||
        /^\s*[*/⁄∕~～–—+\-−]\s*[$₩￦€¥£]?\s*[+\-−]?\d/.test(after) ||
        /\d\s*:\s*$/.test(before) ||
        /^\s*:\s*\d/.test(after)
      )
        continue;
      return true;
    }
  }
  return false;
}

/** Registered metadata and exact quotes only; original bytes were checked at save. */
export function numericCheckContext(
  company: Pick<StudioCase, "sources" | "plans">,
  record: NumericCheck,
) {
  const issues: string[] = [];
  let missing = false;
  for (const observation of record.observations) {
    const ref = observation.reference;
    if (!ref) continue;
    if (ref.kind === "source") {
      const matches = company.sources.filter((item) => item.id === ref.sourceId);
      const source = matches.length === 1 ? matches[0] : undefined;
      const snapshot = record.sourceSnapshots.find((item) => item.sourceId === ref.sourceId);
      if (!source || !snapshot) {
        missing = true;
        issues.push("연결한 자료를 고유하게 찾을 수 없습니다.");
      } else if (
        source.updatedAt !== ref.sourceUpdatedAt ||
        source.updatedAt !== snapshot.sourceUpdatedAt ||
        source.name !== snapshot.sourceName ||
        source.extraction !== snapshot.extraction ||
        source.extraction === "pending" ||
        source.originalName !== (snapshot.original?.originalName ?? null) ||
        source.mimeType !== (snapshot.original?.mimeType ?? null) ||
        !source.text.includes(ref.quote) ||
        (observation.valueText !== "" &&
          !numericLiteralOccurs(source.text, ref.quote, observation.valueText))
      )
        issues.push("연결한 자료·수치 인용이 변경되었습니다.");
    } else {
      const matches = company.plans.filter((item) => item.id === ref.planId);
      const plan = matches.length === 1 ? matches[0] : undefined;
      const sections = plan?.content.sections.filter((item) => item.key === ref.sectionKey);
      if (!plan) {
        missing = true;
        issues.push("연결한 원고 버전을 고유하게 찾을 수 없습니다.");
      } else if (
        sections?.length !== 1 ||
        plan.version !== record.planSnapshots.find((item) => item.planId === ref.planId)?.version ||
        !sections[0].content.includes(ref.quote) ||
        (observation.valueText !== "" &&
          !numericLiteralOccurs(sections[0].content, ref.quote, observation.valueText))
      )
        issues.push("연결한 원고 항목·수치 인용이 변경되었습니다.");
    }
  }
  const state = missing ? "missing" : issues.length ? "stale" : "current";
  return {
    state: state as "current" | "stale" | "missing",
    issues: [...new Set(issues)],
    judgementCurrent: state === "current" && record.judgement.state !== "unreviewed",
    originalCheck: "saved-only" as const,
  };
}
