import { z } from "zod";
import { candidateRegistrySetId } from "./studio-plan-quality-candidate-registry-types";
import { qualityActualRequestEvidenceSchema } from "./studio-plan-quality-actual-types";
import { engineExecutionContractSchema } from "./studio-engine-execution-types";
import {
  providerReservationConditionsSchema,
  providerReservationContextSchema,
  providerReservationPricingSchema,
} from "./studio-plan-quality-provider-reservation";
import type {
  ProviderBudgetSnapshot,
  ProviderSnapshot,
} from "./studio-plan-quality-provider-types";

export const providerReviewLimits = { bodyBytes: 4096, maxCalls: 2, maxRetries: 0 } as const;
export const providerReviewNotice =
  "등록한 합성 후보의 운영 준비 조회본입니다. 실제 AI 호출·승인·비용 예약은 이루어지지 않습니다.";
export const providerLedgerNotice =
  "보관된 v2 원장의 읽기 전용 조회입니다. 합성 시험 기록은 실제 AI 성능·운영 금액의 증거가 아닙니다.";
export const providerReviewBlockerMessages = {
  MODEL_NOT_CONFIGURED: "운영 모델이 설정되지 않았습니다.",
  FINANCIAL_BASIS_NOT_CONFIGURED: "운영 요율·문맥·사용량 해석의 검토 근거가 설정되지 않았습니다.",
  BUDGET_NOT_CONFIGURED: "운영 통화·예산·한 건의 예약 한도가 설정되지 않았습니다.",
  RETENTION_NOT_CONFIGURED: "운영 보관 조건과 안내 근거가 설정되지 않았습니다.",
  ACCOUNT_ACCESS_NOT_CHECKED: "운영 인증 연결과 모델 사용 권한을 확인하지 않았습니다.",
  PRODUCTION_EXECUTION_DISABLED: "실제 AI 전송은 연결되지 않았습니다.",
} as const;
export const providerReviewBlockerCodes = [
  "MODEL_NOT_CONFIGURED",
  "FINANCIAL_BASIS_NOT_CONFIGURED",
  "BUDGET_NOT_CONFIGURED",
  "RETENTION_NOT_CONFIGURED",
  "ACCOUNT_ACCESS_NOT_CHECKED",
  "PRODUCTION_EXECUTION_DISABLED",
] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const providerReviewInputSchema = z
  .object({
    version: z.number().int().min(1).max(20),
    versionDigest: sha,
    candidateId: z
      .string()
      .regex(/^validation-candidate-[a-z0-9-]+$/)
      .max(120),
  })
  .strict();
export const providerReviewScopeSchema = providerReviewInputSchema
  .extend({
    setId: z.literal(candidateRegistrySetId),
    registrySourceDigest: sha,
    manifestDigest: sha,
    label: z.string().min(1).max(200),
    sourceDigest: sha,
    candidateDigest: sha,
    modelInputDigest: sha,
  })
  .strict();
/** Only the implemented missing-configuration state is accepted; no execution grant exists. */
export const providerReviewMissingViewSchema = z
  .object({
    viewVersion: z.literal(1),
    providerContractVersion: z.literal(2),
    state: z.literal("configuration-missing"),
    environment: z.literal("production"),
    inputProvenance: z.literal("registered-synthetic-candidate"),
    scope: providerReviewScopeSchema,
    inspectedAt: z.string().datetime(),
    model: z.null(),
    financialBasis: z.null(),
    budget: z.null(),
    retention: z.null(),
    preparation: z.null(),
    transmissionManifest: z.null(),
    accountAccess: z.literal("not-checked"),
    actualExecutionEnabled: z.literal(false),
    maxCalls: z.literal(2),
    maxRetries: z.literal(0),
    automaticRepair: z.literal(false),
    blockers: z
      .array(
        z
          .object({
            code: z.enum(providerReviewBlockerCodes),
            message: z.string(),
          })
          .strict(),
      )
      .length(providerReviewBlockerCodes.length),
    notice: z.literal(providerReviewNotice),
    viewDigest: sha,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.blockers.some(
        (item, i) =>
          item.code !== providerReviewBlockerCodes[i] ||
          item.message !== providerReviewBlockerMessages[item.code],
      )
    )
      context.addIssue({ code: "custom", message: "미설정 상태의 안내가 일치하지 않습니다." });
  });
export type ProviderReviewInput = z.infer<typeof providerReviewInputSchema>;
export type ProviderReviewMissingView = z.infer<typeof providerReviewMissingViewSchema>;
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const date = z.string().datetime();
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/);
const integer = z.number().int().nonnegative().safe();
const officialUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["openai.com", "www.openai.com", "developers.openai.com", "platform.openai.com"].includes(
        url.hostname,
      )
    );
  });
export const providerProposalSourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,100}$/),
    url: officialUrl,
    title: z.string().min(1).max(300),
    retrievedAt: date,
    reviewedAt: date,
    validUntil: date,
    excerpt: z.string().min(1).max(10000),
    excerptSha256: sha,
    bodySha256: sha.nullable(),
    digestKind: z.enum(["body", "curated-record"]),
    recordDigest: sha,
  })
  .strict();
export type ProviderProposalSource = z.infer<typeof providerProposalSourceSchema>;
export function providerProposalSourceDigestInput(
  value: Omit<ProviderProposalSource, "recordDigest"> | ProviderProposalSource,
) {
  const { recordDigest: _ignored, ...body } = value as ProviderProposalSource;
  void _ignored;
  return body;
}
export const providerProposedBudgetSchema = z
  .object({
    kind: z.literal("cumulative-budget-proposal"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    capUnits: units,
    status: z.literal("not-approved"),
    basis: z.string().min(1).max(2000),
  })
  .strict();
export const providerProposalRetentionSchema = z
  .object({
    policyVersion: z.string().min(1).max(100),
    notice: z.string().min(1).max(10000),
    sourceUrl: officialUrl,
    documentDigest: sha,
    reviewedAt: date,
    validUntil: date,
  })
  .strict();
const channel = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("field"),
      path: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/))
        .min(1)
        .max(5),
    })
    .strict(),
  z.object({ kind: z.literal("not-applicable"), basis: z.string().min(1).max(2000) }).strict(),
]);
export const providerProposalUsagePolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("provider-usage-rate-policy"),
    provenance: z.literal("official-reviewed"),
    financialBasisDigest: sha,
    configuredModel: model,
    responseModels: z.array(model).min(1).max(10),
    requestedTier: z.literal("default"),
    responseTier: z.literal("default"),
    inputPartition: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("equal-rates"), basis: z.string().min(1).max(2000) }).strict(),
      z
        .object({
          kind: z.literal("disjoint-cache"),
          aggregate: z.literal("input-includes-cache-read-and-write"),
          cacheRead: channel,
          cacheWrite: channel,
          basis: z.string().min(1).max(2000),
        })
        .strict(),
    ]),
    bandSelection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("short-only"), basis: z.string().min(1).max(2000) }).strict(),
      z
        .object({
          kind: z.literal("input-threshold"),
          threshold: integer.max(1_000_000_000),
          basis: z.string().min(1).max(2000),
        })
        .strict(),
    ]),
    authority: z
      .object({
        sourceUrl: officialUrl,
        documentDigest: sha,
        reviewedAt: date,
        validUntil: date,
        excerpt: z.string().min(1).max(2000),
      })
      .strict(),
  })
  .strict();
export const providerConfigurationProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("provider-configuration-proposal"),
    adoption: z.literal("not-adopted"),
    model,
    conditions: providerReservationConditionsSchema,
    outputReservationTokens: z.literal(16000),
    context: providerReservationContextSchema,
    pricing: providerReservationPricingSchema,
    retention: providerProposalRetentionSchema,
    usagePolicyTemplate: providerProposalUsagePolicySchema.omit({ financialBasisDigest: true }),
    proposedBudget: providerProposedBudgetSchema,
    sources: z.array(providerProposalSourceSchema).min(1).max(12),
    configurationDigest: sha,
  })
  .strict();
export type ProviderConfigurationProposal = z.infer<typeof providerConfigurationProposalSchema>;
export function providerConfigurationDigestInput(
  value: Omit<ProviderConfigurationProposal, "configurationDigest"> | ProviderConfigurationProposal,
) {
  const { configurationDigest: _ignored, ...body } = value as ProviderConfigurationProposal;
  void _ignored;
  return body;
}
const options = z
  .object({
    service_tier: z.literal("default"),
    truncation: z.literal("disabled"),
    background: z.literal(false),
    stream: z.literal(false),
  })
  .strict();
const requestScope = providerReviewInputSchema
  .extend({ sourceDigest: sha, candidateDigest: sha, modelInputDigest: sha })
  .strict();
export const providerRequestReviewSchema = z
  .object({
    scope: requestScope,
    model,
    contract: z
      .object({
        schemaVersion: z.literal(2),
        engineVersion: z.literal("plan-provider-reservation-v2"),
        baseContract: engineExecutionContractSchema,
        requestOptions: options,
        omittedFields: z.tuple([
          z.literal("previous_response_id"),
          z.literal("conversation"),
          z.literal("tools"),
          z.literal("context_management"),
        ]),
        maxCalls: z.literal(2),
        maxRetries: z.literal(0),
        maxOutputTokens: z.literal(16000),
        contractDigest: sha,
      })
      .strict(),
    generation: z
      .object({
        body: qualityActualRequestEvidenceSchema.shape.generation.shape.body
          .extend(options.shape)
          .strict(),
        requestDigest: sha,
        sha256: sha,
        inputChars: integer.max(240000),
      })
      .strict(),
    reviewTemplate: qualityActualRequestEvidenceSchema.shape.reviewTemplate
      .omit({ schemaVersion: true })
      .extend({ schemaVersion: z.literal(2), requestOptions: options })
      .strict(),
  })
  .strict();
const rate = z.object({ units, perTokens: z.number().int().positive().safe() }).strict();
const phaseCost = z
  .object({
    inputTokensReserved: integer,
    outputTokensReserved: integer,
    inputUnits: units,
    outputUnits: units,
    totalUnits: units,
  })
  .strict();
export const providerProposalFinancialBasisSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("provider-context-financial-reservation-basis"),
    status: z.literal("calculated-for-stated-conditions"),
    evidenceMode: z.literal("official-reviewed"),
    model,
    calculatedAt: date,
    conditions: providerReservationConditionsSchema,
    evidence: z
      .object({
        context: providerReservationContextSchema,
        pricing: providerReservationPricingSchema,
      })
      .strict(),
    basis: z.literal("full-context-input-plus-separate-output-reservation"),
    maxCalls: z.literal(2),
    retries: z.literal(0),
    costs: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitScale: z.number().int().min(0).max(12),
        maximumInputRate: z.object({ rate, selectedFrom: z.string().min(1) }).strict(),
        maximumOutputRate: z.object({ rate, selectedFrom: z.string().min(1) }).strict(),
        generation: phaseCost,
        review: phaseCost,
        totalUnits: units,
        rounding: z.literal("ceil-each-rate-per-request"),
      })
      .strict(),
    blockers: z.array(z.never()).length(0),
    authority: z
      .object({
        sourceAuthenticityIndependentlyVerified: z.literal(false),
        providerFailureChargeBoundVerified: z.literal(false),
        actualTokenCountMeasured: z.literal(false),
        contextFitVerified: z.literal(false),
        accountAccessVerified: z.literal(false),
        userApprovalRecorded: z.literal(false),
        operatingBudgetConfigured: z.literal(false),
        executionReady: z.literal(false),
        dispatchAllowed: z.literal(false),
        compatibleWithLegacyPreparation: z.literal(false),
      })
      .strict(),
    unobservedCostPolicy: z.literal("retain-reservation-no-automatic-retry"),
    limitations: z.array(z.string().min(1).max(2000)).min(1).max(20),
  })
  .strict();
export const providerProposalBlockerMessages = {
  CONFIGURATION_NOT_ADOPTED: "모델·근거는 검토 제안이며 운영 설정으로 채택되지 않았습니다.",
  BUDGET_NOT_CONFIGURED: providerReviewBlockerMessages.BUDGET_NOT_CONFIGURED,
  ACCOUNT_ACCESS_NOT_CHECKED: providerReviewBlockerMessages.ACCOUNT_ACCESS_NOT_CHECKED,
  PRODUCTION_EXECUTION_DISABLED: providerReviewBlockerMessages.PRODUCTION_EXECUTION_DISABLED,
} as const;
export const providerProposalBlockerCodes = [
  "CONFIGURATION_NOT_ADOPTED",
  "BUDGET_NOT_CONFIGURED",
  "ACCOUNT_ACCESS_NOT_CHECKED",
  "PRODUCTION_EXECUTION_DISABLED",
] as const;
export const providerReviewProposalViewSchema = z
  .object(providerReviewMissingViewSchema.shape)
  .omit({
    viewVersion: true,
    state: true,
    model: true,
    financialBasis: true,
    retention: true,
    blockers: true,
  })
  .extend({
    viewVersion: z.literal(2),
    state: z.literal("proposal-only"),
    model,
    financialBasis: providerProposalFinancialBasisSchema,
    retention: providerProposalRetentionSchema,
    proposal: z
      .object({
        configurationDigest: sha,
        adoption: z.literal("not-adopted"),
        requestReview: providerRequestReviewSchema,
        proposedBudget: providerProposedBudgetSchema,
        sources: z.array(providerProposalSourceSchema).min(1).max(12),
        usagePolicy: providerProposalUsagePolicySchema,
      })
      .strict(),
    blockers: z
      .array(z.object({ code: z.enum(providerProposalBlockerCodes), message: z.string() }).strict())
      .length(4),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.blockers.some(
        (item, i) =>
          item.code !== providerProposalBlockerCodes[i] ||
          item.message !== providerProposalBlockerMessages[item.code],
      )
    )
      context.addIssue({ code: "custom", message: "제안 상태의 안내가 일치하지 않습니다." });
  });
export type ProviderReviewProposalView = z.infer<typeof providerReviewProposalViewSchema>;
export const providerReviewViewSchema = z.union([
  providerReviewMissingViewSchema,
  providerReviewProposalViewSchema,
]);
export type ProviderReviewView = z.infer<typeof providerReviewViewSchema>;
export function providerProposalConfigurationDigestInput(value: ProviderReviewProposalView) {
  const { financialBasisDigest: _ignored, ...usagePolicyTemplate } = value.proposal.usagePolicy;
  void _ignored;
  return {
    schemaVersion: 1 as const,
    kind: "provider-configuration-proposal" as const,
    adoption: value.proposal.adoption,
    model: value.model,
    conditions: value.financialBasis.conditions,
    outputReservationTokens: 16000 as const,
    context: value.financialBasis.evidence.context,
    pricing: value.financialBasis.evidence.pricing,
    retention: value.retention,
    usagePolicyTemplate,
    proposedBudget: value.proposal.proposedBudget,
    sources: value.proposal.sources,
  };
}
export function providerReviewDigestInput(
  value: Omit<ProviderReviewView, "viewDigest"> | ProviderReviewView,
) {
  const { viewDigest: _digest, ...body } = value as ProviderReviewView;
  void _digest;
  return body;
}
export function providerReviewDownloadName(value: ProviderReviewView) {
  return `venturepass-provider-review-v${value.scope.version}-${value.scope.candidateId}-${value.viewDigest.slice(0, 12)}.json`;
}
export const providerLedgerArtifactKeySchema = z.enum([
  "generation-request",
  "generation-response",
  "generation-validated",
  "review-request",
  "review-response",
  "review-validated",
  "final-result",
]);
export type ProviderLedgerArtifactKey = z.infer<typeof providerLedgerArtifactKeySchema>;
export type ProviderLedgerOverview = {
  schemaVersion: 2;
  kind: "provider-ledger-overview";
  notice: typeof providerLedgerNotice;
  actualExecutionEnabled: false;
  budgets: { production: ProviderBudgetSnapshot | null; synthetic: ProviderBudgetSnapshot | null };
  executions: ProviderSnapshot[];
};
export function providerLedgerDownloadName(id: string, revision: number) {
  return `venturepass-provider-ledger-${id}-r${revision}.json`;
}
export function providerLedgerArtifactName(
  id: string,
  revision: number,
  key: ProviderLedgerArtifactKey,
) {
  return `venturepass-provider-ledger-${id}-r${revision}-${key}.json`;
}
