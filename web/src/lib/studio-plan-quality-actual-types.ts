import { z } from "zod";
import { candidateRegistrySetId } from "./studio-plan-quality-candidate-registry-types";
import { engineExecutionContractSchema } from "./studio-engine-execution-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.string().regex(/^(0|[1-9]\d{0,39})$/);
const computedUint = z.string().regex(/^(0|[1-9]\d{0,79})$/);
const positiveTokens = z.number().int().positive().safe();
const date = z.string().datetime();
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const authority = z
  .object({
    sourceUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://")),
    documentDigest: hash,
    retrievedAt: date,
    reviewedAt: date,
    validFrom: date,
    validUntil: date,
    reviewerId: z.string().min(1).max(200),
    excerpt: z.string().min(1).max(10000),
    applicability: z.string().min(1).max(2000),
    validityPolicy: z.string().min(1).max(2000),
  })
  .strict();
const money = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  unitScale: z.number().int().min(0).max(12),
};
const rate = z.object({ units: uint, perTokens: positiveTokens }).strict();

/** Evidence supplied by a server-side reviewed adapter, never a pricing claim accepted from UI. */
export const qualityActualPriceSchema = z
  .object({
    provenance: z.enum(["official-reviewed", "synthetic-test"]),
    provider: z.literal("OpenAI"),
    endpoint: z.literal("https://api.openai.com/v1"),
    model,
    authority,
    ...money,
    inputRate: rate,
    outputRate: rate,
    cachePolicy: z.literal("undiscounted"),
    outputCoverage: z.literal("all-output-including-reasoning"),
    additionalCharges: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none-verified") }).strict(),
      z.object({ kind: z.literal("bounded-per-request"), units: uint }).strict(),
    ]),
  })
  .strict();

export const qualityActualTokensSchema = z
  .object({
    provenance: z.enum(["model-tokenizer-reviewed", "synthetic-test"]),
    provider: z.literal("OpenAI"),
    endpoint: z.literal("https://api.openai.com/v1"),
    model,
    authority,
    tokenizerId: z.string().min(1).max(200),
    tokenizerVersion: z.string().min(1).max(200),
    contractDigest: hash,
    coverage: z
      .object({
        system: z.literal(true),
        user: z.literal(true),
        structuredOutputSchema: z.literal(true),
        messageFraming: z.literal(true),
        providerOverhead: z.literal(true),
      })
      .strict(),
    assurance: z.literal("entire-request-upper-bound"),
    generation: z.object({ requestDigest: hash, inputUpperBound: positiveTokens }).strict(),
    review: z
      .object({
        templateDigest: hash,
        inputUpperBound: positiveTokens,
        includesMaxGeneratedDraftTokens: z.literal(16000),
        includesDraftSerialization: z.literal(true),
        derivation: z.literal("this-run-validated-generation-only"),
      })
      .strict(),
    maxInputTokens: positiveTokens,
    maxOutputTokens: positiveTokens,
    contextWindowTokens: positiveTokens,
  })
  .strict();

export const qualityActualBudgetSchema = z
  .object({
    provenance: z.enum(["reviewed-budget", "synthetic-test"]),
    ...money,
    capUnits: uint,
    unsettledUnits: uint,
    observedAt: date,
    validUntil: date,
    scope: z.literal("candidate-quality-executions"),
    ledgerDigest: hash,
  })
  .strict();

export const qualityActualBlockerMessages = {
  MODEL_NOT_SELECTED: "실제 전송에 사용할 모델을 선택하지 않았습니다.",
  PRICE_NOT_CONFIGURED: "공식 가격 근거와 적용 요율을 확인하지 않았습니다.",
  PRICE_INVALID: "가격 근거의 단위·통화·출력 범위·추가 과금 조건을 확인해 주세요.",
  PRICE_SCOPE_MISMATCH: "가격 근거의 제공자·목적지·모델이 준비안과 다릅니다.",
  PRICE_OUTDATED: "가격 근거의 확인 시각 또는 유효기간을 다시 확인해 주세요.",
  TOKEN_BOUND_NOT_CONFIGURED: "전체 요청을 포함하는 입력 토큰 상한을 확인하지 않았습니다.",
  TOKEN_BOUND_INVALID:
    "토큰 상한에 system·본문·schema·부가분과 검토 원고 전체가 포함되어야 합니다.",
  TOKEN_SCOPE_MISMATCH: "토큰 증빙의 모델·엔진·요청 본문 또는 검토 파생 범위가 다릅니다.",
  TOKEN_EVIDENCE_OUTDATED: "토큰 계산 근거의 확인 시각 또는 유효기간을 다시 확인해 주세요.",
  TOKEN_LIMIT_EXCEEDED: "생성 또는 검토 요청이 확인한 입력·출력·문맥 토큰 상한을 초과합니다.",
  BUDGET_NOT_CONFIGURED: "실행 총액 상한과 기존 미확인 비용을 확인하지 않았습니다.",
  BUDGET_INVALID: "예산의 통화·단위·미확인 금액 또는 조회 근거를 확인해 주세요.",
  BUDGET_SCOPE_MISMATCH: "예산과 가격 근거의 통화 또는 금액 단위가 다릅니다.",
  BUDGET_EXCEEDED: "최대 호출 비용과 기존 미확인 비용의 합이 지정한 총액 상한을 초과합니다.",
  SYNTHETIC_EVIDENCE_FORBIDDEN:
    "합성 시험용 가격·토큰·예산은 실제 실행 준비 근거로 사용할 수 없습니다.",
} as const;
export const qualityActualBlockerSchema = z
  .object({
    code: z.enum(
      Object.keys(qualityActualBlockerMessages) as [
        keyof typeof qualityActualBlockerMessages,
        ...Array<keyof typeof qualityActualBlockerMessages>,
      ],
    ),
    message: z.string().min(1).max(500),
  })
  .strict();
export const qualityActualExecutionBlocks = [
  "이번 준비 조회는 실행 승인을 기록하지 않습니다.",
  "비용 예약과 실제 실행 경로가 연결되지 않았습니다.",
] as const;
const formatSchema = z
  .object({
    type: z.literal("json_schema"),
    name: z.string().min(1),
    strict: z.literal(true),
    schema: z.record(z.string(), z.json()),
  })
  .strict();
const systemMessageSchema = z.object({ role: z.literal("system"), content: z.string() }).strict();
const requestBodySchema = z
  .object({
    model,
    store: z.literal(false),
    max_output_tokens: z.literal(16000),
    input: z.tuple([
      systemMessageSchema,
      z.object({ role: z.literal("user"), content: z.string() }).strict(),
    ]),
    text: z.object({ format: formatSchema }).strict(),
  })
  .strict();
const enginePlanPreparedRequestSchema = z
  .object({
    phase: z.literal("generation"),
    body: requestBodySchema,
    requestDigest: hash,
    inputChars: z.number().int().nonnegative().max(240000),
    contractDigest: hash,
  })
  .strict();
const enginePlanReviewTemplateSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.literal("review"),
    complete: z.literal(false),
    model,
    store: z.literal(false),
    max_output_tokens: z.literal(16000),
    systemMessage: systemMessageSchema,
    format: formatSchema,
    fixedUserContext: z.record(z.string(), z.json()),
    draftSlot: z
      .object({
        jsonPath: z.literal("$.draft"),
        rule: z.literal("this-run-validated-generation-only"),
        requiresValidatedEventBinding: z.literal(true),
      })
      .strict(),
    contractDigest: hash,
    templateDigest: hash,
  })
  .strict();
export const qualityActualRequestEvidenceSchema = z
  .object({
    generation: enginePlanPreparedRequestSchema,
    reviewTemplate: enginePlanReviewTemplateSchema,
    evidenceDigest: hash,
  })
  .strict();
export const qualityActualPreparationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("actual-ai-preparation-inspection"),
    environment: z.enum(["production", "synthetic-test"]),
    preparedAt: date,
    scope: z
      .object({
        setId: z.literal(candidateRegistrySetId),
        version: z.number().int().min(1).max(20),
        versionDigest: hash,
        registrySourceDigest: hash,
        manifestDigest: hash,
        candidateId: z
          .string()
          .regex(/^validation-candidate-[a-z0-9-]+$/)
          .max(120),
        label: z.string().min(1).max(200),
        sourceDigest: hash,
        candidateDigest: hash,
        modelInputDigest: hash,
      })
      .strict(),
    model: model.nullable(),
    provider: z.literal("OpenAI"),
    destination: z.literal("https://api.openai.com/v1"),
    purpose: z.literal("synthetic-candidate-generation-and-review"),
    engine: engineExecutionContractSchema,
    requestEvidence: qualityActualRequestEvidenceSchema.nullable(),
    evidence: z
      .object({
        price: qualityActualPriceSchema.nullable(),
        tokens: qualityActualTokensSchema.nullable(),
        budget: qualityActualBudgetSchema.nullable(),
      })
      .strict(),
    costs: z
      .object({
        ...money,
        generationUnits: computedUint,
        reviewUnits: computedUint,
        unsettledUnits: uint,
        totalUnits: computedUint,
        budgetUnits: uint,
        rounding: z.literal("ceil-each-rate-per-request"),
        meaning: z.literal("unreserved-upper-bound-not-a-bill"),
      })
      .strict()
      .nullable(),
    readiness: z.enum(["blocked", "calculation-ready"]),
    blockers: z.array(qualityActualBlockerSchema).max(30),
    executionBlocks: z.tuple([
      z.literal(qualityActualExecutionBlocks[0]),
      z.literal(qualityActualExecutionBlocks[1]),
    ]),
    executionAllowed: z.literal(false),
    approvalRecorded: z.literal(false),
    reservationRecorded: z.literal(false),
    humanAnswerKey: z.null(),
    independentHoldoutConfirmed: z.literal(false),
    performanceEvaluation: z.literal("not-performed"),
    preparationDigest: hash,
  })
  .strict()
  .superRefine((value, context) => {
    const codes = value.blockers.map((item) => item.code);
    const ready = value.readiness === "calculation-ready";
    const synthetic = Object.values(value.evidence).some(
      (item) => item?.provenance === "synthetic-test",
    );
    if (
      new Set(codes).size !== codes.length ||
      value.blockers.some((item) => item.message !== qualityActualBlockerMessages[item.code]) ||
      ready !== (value.blockers.length === 0) ||
      (value.model === null) !== (value.requestEvidence === null) ||
      (ready &&
        (!value.costs ||
          !value.evidence.price ||
          !value.evidence.tokens ||
          !value.evidence.budget ||
          !value.requestEvidence)) ||
      (value.environment === "production" &&
        synthetic &&
        (ready || value.costs !== null || !codes.includes("SYNTHETIC_EVIDENCE_FORBIDDEN")))
    )
      context.addIssue({
        code: "custom",
        message: "준비 조건 또는 시험 증빙의 출처가 일치하지 않습니다.",
      });
  });

export type QualityActualPrice = z.infer<typeof qualityActualPriceSchema>;
export type QualityActualTokens = z.infer<typeof qualityActualTokensSchema>;
export type QualityActualBudget = z.infer<typeof qualityActualBudgetSchema>;
export type QualityActualRequestEvidence = z.infer<typeof qualityActualRequestEvidenceSchema>;
export type QualityActualPreparation = z.infer<typeof qualityActualPreparationSchema>;
export type QualityActualBlockerCode = keyof typeof qualityActualBlockerMessages;
export function qualityActualPreparationDigestInput(
  value: Omit<QualityActualPreparation, "preparationDigest"> | QualityActualPreparation,
) {
  const { preparationDigest: _ignored, ...payload } = value as QualityActualPreparation;
  void _ignored;
  return payload;
}
export function qualityActualRequestEvidenceDigestInput(
  value: Omit<QualityActualRequestEvidence, "evidenceDigest"> | QualityActualRequestEvidence,
) {
  const { evidenceDigest: _ignored, ...payload } = value as QualityActualRequestEvidence;
  void _ignored;
  return payload;
}
export function qualityActualDownloadName(version: number, candidateId: string) {
  return `venturepass-actual-preparation-v${version}-${candidateId}.json`;
}
