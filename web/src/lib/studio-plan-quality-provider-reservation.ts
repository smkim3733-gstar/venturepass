import { z } from "zod";

const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const tokenCount = z.number().int().positive().safe().max(1_000_000_000);
const units = z.string().regex(/^(0|[1-9]\d{0,39})$/);
const rateSchema = z.object({ units, perTokens: tokenCount }).strict();
const notApplicableSchema = z
  .object({
    applicability: z.literal("not-applicable"),
    explanation: z.string().trim().min(1).max(2000),
  })
  .strict();
const optionalRateSchema = z.union([rateSchema, notApplicableSchema]);
const bandSchema = z
  .object({
    uncachedInput: rateSchema,
    cacheReadInput: optionalRateSchema,
    cacheWriteInput: optionalRateSchema,
    outputIncludingReasoning: rateSchema,
  })
  .strict();
export const providerReservationConditionsSchema = z
  .object({
    provider: z.literal("OpenAI"),
    endpoint: z.literal("https://api.openai.com/v1"),
    api: z.literal("responses"),
    modality: z.literal("text-only"),
    tools: z.literal("none"),
    tokenCountingEndpoint: z.literal("none"),
    serviceTier: z.literal("default"),
    processing: z.literal("standard"),
    destination: z.literal("global"),
    store: z.literal(false),
    truncation: z.literal("disabled"),
    previousResponse: z.literal("none"),
    conversation: z.literal("none"),
    compaction: z.literal("none"),
    background: z.literal(false),
    stream: z.literal(false),
    maxCalls: z.literal(2),
    retries: z.literal(0),
  })
  .strict();
const authoritySchema = z
  .object({
    sourceUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password && !url.port;
        } catch {
          return false;
        }
      }),
    documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: z.string().datetime(),
    reviewedAt: z.string().datetime(),
    validUntil: z.string().datetime(),
    // Internal freshness deadline, never a claimed provider guarantee of stable prices.
    freshnessPolicy: z.string().trim().min(1).max(2000),
    reviewerId: z.string().trim().min(1).max(200),
    excerpt: z.string().trim().min(1).max(10000),
  })
  .strict();
const evidenceBase = {
  provenance: z.enum(["official-reviewed", "synthetic-test"]),
  model: modelSchema,
  conditions: providerReservationConditionsSchema,
  authority: authoritySchema,
};
export const providerReservationContextSchema = z
  .object({
    ...evidenceBase,
    contextWindowTokens: tokenCount,
    contextCoverage: z.literal("input-plus-output-including-reasoning"),
    maxOutputTokens: tokenCount,
  })
  .strict();
export const providerReservationPricingSchema = z
  .object({
    ...evidenceBase,
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    // If a source quotes an additive write fee, the fixed evidence adapter must
    // add it to the applicable base input rate before supplying this contract.
    rateMeaning: z.literal("all-in-replacement-rates-not-additive-surcharges"),
    shortContext: bandSchema,
    longContext: z.union([bandSchema, notApplicableSchema]),
    additionalCharges: z
      .object({
        applicability: z.literal("none-under-stated-conditions"),
        explanation: z.string().trim().min(1).max(2000),
      })
      .strict(),
  })
  .strict();
const envelopeSchema = z
  .object({
    evidenceMode: z.enum(["official-reviewed", "synthetic-test"]),
    model: modelSchema.nullable(),
    calculatedAt: z.string().datetime(),
    outputReservationTokens: tokenCount,
    conditions: providerReservationConditionsSchema,
    context: z.unknown(),
    pricing: z.unknown(),
  })
  .strict();
export type ProviderReservationContext = z.infer<typeof providerReservationContextSchema>;
export type ProviderReservationPricing = z.infer<typeof providerReservationPricingSchema>;
export type ProviderReservationConditions = z.infer<typeof providerReservationConditionsSchema>;
export type ProviderContextReservationInput = z.infer<typeof envelopeSchema>;
export type ProviderReservationRate = z.infer<typeof rateSchema>;
export const providerReservationBlockerMessages = {
  INVALID_INPUT: "계산 시각·출력 상한·고정 요청 조건을 확인해 주세요.",
  MODEL_REQUIRED: "예약 기준을 적용할 모델을 명시해 주세요.",
  CONTEXT_MISSING: "공식 문맥·출력 상한 근거가 없습니다.",
  CONTEXT_INVALID: "문맥 상한 근거의 구조와 적용 범위를 확인해 주세요.",
  PRICING_MISSING: "적용 가능한 입력·출력 요율 근거가 없습니다.",
  PRICING_INVALID: "요율·정수 단위·적용 없음 근거를 모두 확인해 주세요.",
  EVIDENCE_SCOPE_MISMATCH: "모델·요청 조건·증빙 출처가 계산 범위와 다릅니다.",
  EVIDENCE_TIME_INVALID: "증빙 확인 시각 또는 내부 최신성 기한을 확인해 주세요.",
  OFFICIAL_SOURCE_REQUIRED: "공식 증빙은 허용한 OpenAI 공식 주소여야 합니다.",
  OUTPUT_LIMIT_EXCEEDED: "명시한 출력 예약이 공식 출력 또는 문맥 상한을 초과합니다.",
} as const;
type Blocker = { code: keyof typeof providerReservationBlockerMessages; message: string };
type Costs = {
  currency: string;
  unitScale: number;
  maximumInputRate: { rate: ProviderReservationRate; selectedFrom: string };
  maximumOutputRate: { rate: ProviderReservationRate; selectedFrom: string };
  generation: {
    inputTokensReserved: number;
    outputTokensReserved: number;
    inputUnits: string;
    outputUnits: string;
    totalUnits: string;
  };
  review: {
    inputTokensReserved: number;
    outputTokensReserved: number;
    inputUnits: string;
    outputUnits: string;
    totalUnits: string;
  };
  totalUnits: string;
  rounding: "ceil-each-rate-per-request";
};
export type ProviderContextReservationBasis = {
  schemaVersion: 2;
  kind: "provider-context-financial-reservation-basis";
  status: "blocked" | "calculated-for-stated-conditions";
  evidenceMode: "official-reviewed" | "synthetic-test" | null;
  model: string | null;
  calculatedAt: string | null;
  conditions: ProviderReservationConditions | null;
  evidence: {
    context: ProviderReservationContext | null;
    pricing: ProviderReservationPricing | null;
  };
  basis: "full-context-input-plus-separate-output-reservation";
  maxCalls: 2;
  retries: 0;
  costs: Costs | null;
  blockers: Blocker[];
  authority: {
    sourceAuthenticityIndependentlyVerified: false;
    providerFailureChargeBoundVerified: false;
    actualTokenCountMeasured: false;
    contextFitVerified: false;
    accountAccessVerified: false;
    userApprovalRecorded: false;
    operatingBudgetConfigured: false;
    executionReady: false;
    dispatchAllowed: false;
    compatibleWithLegacyPreparation: false;
  };
  unobservedCostPolicy: "retain-reservation-no-automatic-retry";
  limitations: string[];
};

const officialHosts = new Set([
  "openai.com",
  "www.openai.com",
  "developers.openai.com",
  "platform.openai.com",
]);
function currentAuthority(value: z.infer<typeof authoritySchema>, now: number) {
  return (
    Date.parse(value.retrievedAt) <= Date.parse(value.reviewedAt) &&
    Date.parse(value.reviewedAt) <= now &&
    now < Date.parse(value.validUntil)
  );
}
function highest(values: Array<{ rate: ProviderReservationRate; selectedFrom: string }>) {
  return values.reduce((best, item) =>
    BigInt(item.rate.units) * BigInt(best.rate.perTokens) >
    BigInt(best.rate.units) * BigInt(item.rate.perTokens)
      ? item
      : best,
  );
}
function ceilRate(tokens: number, rate: ProviderReservationRate) {
  const divisor = BigInt(rate.perTokens);
  return (BigInt(tokens) * BigInt(rate.units) + divisor - BigInt(1)) / divisor;
}

/**
 * Pure arithmetic over server-fixed caller evidence. Provenance strings and official
 * URLs are scope checks, not independent source authentication. C is a financial
 * input reservation; adding O deliberately over-reserves and proves no request fit.
 * Never convert this v2 basis into A's token evidence, B/C1 v1 approval or dispatch.
 */
export function createProviderContextReservation(
  value: ProviderContextReservationInput,
): ProviderContextReservationBasis {
  const result: ProviderContextReservationBasis = {
    schemaVersion: 2,
    kind: "provider-context-financial-reservation-basis",
    status: "blocked",
    evidenceMode: null,
    model: null,
    calculatedAt: null,
    conditions: null,
    evidence: { context: null, pricing: null },
    basis: "full-context-input-plus-separate-output-reservation",
    maxCalls: 2,
    retries: 0,
    costs: null,
    blockers: [],
    authority: {
      sourceAuthenticityIndependentlyVerified: false,
      providerFailureChargeBoundVerified: false,
      actualTokenCountMeasured: false,
      contextFitVerified: false,
      accountAccessVerified: false,
      userApprovalRecorded: false,
      operatingBudgetConfigured: false,
      executionReady: false,
      dispatchAllowed: false,
      compatibleWithLegacyPreparation: false,
    },
    unobservedCostPolicy: "retain-reservation-no-automatic-retry",
    limitations: [
      "고정된 조건의 금융 예약 계산이며 실제 견적·청구 상한 보장·운영 예산·실행 승인이 아닙니다.",
      "전체 문맥 C를 입력으로, 명시 출력 O를 별도로 예약합니다. C+O가 문맥보다 커도 요청 적합성을 뜻하지 않습니다.",
      "토큰 실측·계정 권한·사용자 승인을 확인하지 않았습니다. 별도 토큰 계산 API도 호출하지 않습니다.",
      "공식 주소와 reviewed 표시는 호출자가 제공한 증빙입니다. 이 함수는 출처 진위와 내용의 완전성을 독립 검증하지 않습니다.",
      "validUntil은 내부 최신성 정책의 기한입니다. 공급자의 가격 고정 약속이 아닙니다.",
      "실패·불완전 응답·전송 단절의 청구 상한은 확인하지 않았습니다. 미확인 비용 예약은 유지하며 자동 재시도하지 않습니다.",
    ],
  };
  const block = (code: Blocker["code"]) => {
    if (!result.blockers.some((item) => item.code === code))
      result.blockers.push({ code, message: providerReservationBlockerMessages[code] });
  };
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) {
    block("INVALID_INPUT");
    return result;
  }
  const input = parsed.data;
  result.evidenceMode = input.evidenceMode;
  result.model = input.model;
  result.calculatedAt = input.calculatedAt;
  result.conditions = input.conditions;
  if (input.model === null) block("MODEL_REQUIRED");
  const context = providerReservationContextSchema.safeParse(input.context);
  const pricing = providerReservationPricingSchema.safeParse(input.pricing);
  if (!context.success) block(input.context == null ? "CONTEXT_MISSING" : "CONTEXT_INVALID");
  if (!pricing.success) block(input.pricing == null ? "PRICING_MISSING" : "PRICING_INVALID");
  result.evidence.context = context.success ? context.data : null;
  result.evidence.pricing = pricing.success ? pricing.data : null;
  for (const evidence of [result.evidence.context, result.evidence.pricing]) {
    if (!evidence) continue;
    if (
      evidence.model !== input.model ||
      evidence.provenance !== input.evidenceMode ||
      JSON.stringify(evidence.conditions) !== JSON.stringify(input.conditions)
    )
      block("EVIDENCE_SCOPE_MISMATCH");
    if (!currentAuthority(evidence.authority, Date.parse(input.calculatedAt)))
      block("EVIDENCE_TIME_INVALID");
    if (
      evidence.provenance === "official-reviewed" &&
      !officialHosts.has(new URL(evidence.authority.sourceUrl).hostname)
    )
      block("OFFICIAL_SOURCE_REQUIRED");
  }
  if (
    context.success &&
    (input.outputReservationTokens > context.data.maxOutputTokens ||
      input.outputReservationTokens > context.data.contextWindowTokens ||
      context.data.maxOutputTokens > context.data.contextWindowTokens)
  )
    block("OUTPUT_LIMIT_EXCEEDED");
  if (result.blockers.length || !context.success || !pricing.success) return result;
  const inputs: Array<{ rate: ProviderReservationRate; selectedFrom: string }> = [];
  const outputs: typeof inputs = [];
  for (const bandName of ["shortContext", "longContext"] as const) {
    const band = pricing.data[bandName];
    if ("applicability" in band) continue;
    for (const channel of ["uncachedInput", "cacheReadInput", "cacheWriteInput"] as const) {
      const rate = band[channel];
      if (!("applicability" in rate)) inputs.push({ rate, selectedFrom: `${bandName}.${channel}` });
    }
    outputs.push({
      rate: band.outputIncludingReasoning,
      selectedFrom: `${bandName}.outputIncludingReasoning`,
    });
  }
  const maximumInputRate = highest(inputs),
    maximumOutputRate = highest(outputs);
  const inputCost = ceilRate(context.data.contextWindowTokens, maximumInputRate.rate);
  const outputCost = ceilRate(input.outputReservationTokens, maximumOutputRate.rate);
  const phase = {
    inputTokensReserved: context.data.contextWindowTokens,
    outputTokensReserved: input.outputReservationTokens,
    inputUnits: inputCost.toString(),
    outputUnits: outputCost.toString(),
    totalUnits: (inputCost + outputCost).toString(),
  };
  result.costs = {
    currency: pricing.data.currency,
    unitScale: pricing.data.unitScale,
    maximumInputRate,
    maximumOutputRate,
    generation: { ...phase },
    review: { ...phase },
    totalUnits: ((inputCost + outputCost) * BigInt(2)).toString(),
    rounding: "ceil-each-rate-per-request",
  };
  result.status = "calculated-for-stated-conditions";
  return result;
}
