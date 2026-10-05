import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import {
  highestReservationRate,
  ceilReservationRate,
} from "./studio-plan-quality-provider-reservation";
import {
  providerProposalSourceSchema,
  providerProposalSourceDigestInput,
} from "./studio-plan-quality-provider-review-types";
import {
  publicClaimComparisonRequestIdentitySchema,
  publicClaimComparisonRequestPins,
} from "./studio-public-claim-comparison-request-types";

export const comparisonPlanAuthority = Object.freeze({
  approvalVerified: false,
  humanConsentVerified: false,
  priceAuthenticityVerified: false,
  contextFitVerified: false,
  transactionCommitVerified: false,
  providerExecutionObserved: false,
  budgetWrite: false,
  databaseWrite: false,
  dispatchAllowed: false,
} as const);
export const comparisonHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().positive().safe().max(1_000_000_000);
const units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const rate = z.object({ units, perTokens: count }).strict();
const omitted = z
  .object({
    interpretation: z.literal("omitted-all-applicable-outcomes-bounded"),
    sourceIds: z.array(z.string().min(1).max(100)).min(1).max(12),
    explanation: z.string().min(1).max(2000),
  })
  .strict();
const channel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rate"), rate }).strict(),
  z
    .object({ kind: z.literal("not-applicable"), explanation: z.string().min(1).max(2000) })
    .strict(),
]);
const band = z
  .object({
    uncachedInput: rate,
    cacheReadInput: channel,
    cacheWriteInput: channel,
    outputIncludingReasoning: rate,
  })
  .strict();
export const comparisonFinancialEvidenceSchema = z
  .object({
    evidenceVersion: z.literal(1),
    purpose: z.literal("compare-public-claim"),
    provenance: z.enum(["official-reviewed", "synthetic-test"]),
    model,
    requestVersion: z.literal("public-claim-comparison-request-v1"),
    contractDigest: comparisonHashSchema,
    destination: z.literal("https://api.openai.com/v1/responses"),
    store: z.literal(false),
    requestedTier: z.null(),
    maxCalls: z.literal(1),
    automaticRetryLimit: z.literal(0),
    maxOutputTokens: z.literal(16000),
    omissions: z
      .object({ service_tier: omitted, truncation: omitted, background: omitted, stream: omitted })
      .strict(),
    context: z
      .object({
        contextWindowTokens: count,
        maxOutputTokens: count,
        coverage: z.literal("input-plus-output-including-reasoning"),
        sourceIds: z.array(z.string().min(1).max(100)).min(1).max(12),
      })
      .strict(),
    pricing: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitScale: z.number().int().min(0).max(12),
        rateMeaning: z.literal("all-in-replacement-rates-not-additive-surcharges"),
        shortContext: band,
        longContext: z.union([
          band,
          z
            .object({ kind: z.literal("not-applicable"), explanation: z.string().min(1).max(2000) })
            .strict(),
        ]),
        additionalCharges: z
          .object({
            kind: z.literal("none-under-stated-and-omitted-conditions"),
            explanation: z.string().min(1).max(2000),
          })
          .strict(),
        sourceIds: z.array(z.string().min(1).max(100)).min(1).max(12),
      })
      .strict(),
    retention: z
      .object({
        policyVersion: z.string().min(1).max(100),
        localNotice: z.string().min(1).max(10000),
        providerNotice: z.string().min(1).max(10000),
        localArtifacts: z.tuple([
          z.literal("comparison-context"),
          z.literal("comparison-request"),
          z.literal("comparison-response"),
          z.literal("comparison-validated"),
          z.literal("final-result"),
        ]),
        survivesCompanyChanges: z.literal(true),
        storeFalseIsNoRetentionGuarantee: z.literal(false),
        sourceIds: z.array(z.string().min(1).max(100)).min(1).max(12),
      })
      .strict(),
    sources: z.array(providerProposalSourceSchema).min(1).max(12),
  })
  .strict();
export type ComparisonFinancialEvidence = z.infer<typeof comparisonFinancialEvidenceSchema>;
export const comparisonConsentNotice = Object.freeze({
  noticeVersion: 1,
  text: "공개 주장 한 개와 직접 선택한 공개 발췌·수동 메타데이터의 비교를 위해 표시된 요청/선택 문맥을 로컬 원장에 보관하고 현재 예산에서 표시된 금액을 예약합니다. 회사 변경·삭제 뒤에도 원장 증거는 남습니다. 예약 상한은 토큰 적합성이나 사실 확인이 아니며 자동 재시도는 없습니다. 외부 전송은 별도 승인해야 합니다.",
});
export function comparisonPlanFail(code = "PUBLIC_COMPARISON_PLAN_INVALID"): never {
  throw new Error(code);
}
export const comparisonSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const comparisonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Only supplied evidence/one-request arithmetic. No current prices, model discovery or authority. */
export function createComparisonFinancialBasis(
  raw: unknown,
  identityRaw: unknown,
  requestedModel: string,
  environment: "production" | "synthetic-test",
  at: string,
) {
  assertPublicComparisonDataOnly(raw, 64 * 1024);
  assertPublicComparisonDataOnly(identityRaw, 8192);
  if (comparisonBytes(raw) > 64 * 1024) comparisonPlanFail("PUBLIC_COMPARISON_PLAN_LIMIT");
  z.enum(["production", "synthetic-test"]).parse(environment);
  const evidence = comparisonFinancialEvidenceSchema.parse(raw);
  const identity = publicClaimComparisonRequestIdentitySchema.parse(identityRaw);
  const now = z.string().datetime().parse(at);
  if (
    evidence.model !== requestedModel ||
    evidence.contractDigest !== identity.contractDigest ||
    identity.contractDigest !== publicClaimComparisonRequestPins.contractDigest ||
    evidence.context.contextWindowTokens < 16000 ||
    evidence.context.maxOutputTokens < 16000 ||
    (environment === "production" && evidence.provenance !== "official-reviewed")
  )
    comparisonPlanFail("PUBLIC_COMPARISON_FINANCIAL_BASIS");
  const ids = new Set<string>();
  for (const s of evidence.sources) {
    if (
      ids.has(s.id) ||
      comparisonSha(s.excerpt) !== s.excerptSha256 ||
      digest(providerProposalSourceDigestInput(s)) !== s.recordDigest ||
      (s.digestKind === "body" && s.bodySha256 === null) ||
      (s.digestKind === "curated-record" && s.bodySha256 !== null) ||
      Date.parse(s.retrievedAt) > Date.parse(s.reviewedAt) ||
      Date.parse(s.reviewedAt) > Date.parse(now) ||
      Date.parse(now) >= Date.parse(s.validUntil)
    )
      comparisonPlanFail("PUBLIC_COMPARISON_FINANCIAL_BASIS");
    ids.add(s.id);
  }
  const referenced = new Set<string>();
  for (const list of [
    ...Object.values(evidence.omissions).map((v) => v.sourceIds),
    evidence.context.sourceIds,
    evidence.pricing.sourceIds,
    evidence.retention.sourceIds,
  ]) {
    if (new Set(list).size !== list.length || list.some((id) => !ids.has(id)))
      comparisonPlanFail("PUBLIC_COMPARISON_FINANCIAL_BASIS");
    list.forEach((id) => referenced.add(id));
  }
  if (referenced.size !== ids.size) comparisonPlanFail("PUBLIC_COMPARISON_FINANCIAL_BASIS");
  const inputs: Array<{ rate: z.infer<typeof rate>; selectedFrom: string }> = [];
  const outputs: typeof inputs = [];
  for (const [name, b] of Object.entries({
    shortContext: evidence.pricing.shortContext,
    longContext: evidence.pricing.longContext,
  })) {
    if ("kind" in b) continue;
    inputs.push({ rate: b.uncachedInput, selectedFrom: name + ".uncachedInput" });
    for (const key of ["cacheReadInput", "cacheWriteInput"] as const)
      if (b[key].kind === "rate")
        inputs.push({ rate: b[key].rate, selectedFrom: name + "." + key });
    outputs.push({
      rate: b.outputIncludingReasoning,
      selectedFrom: name + ".outputIncludingReasoning",
    });
  }
  const inputRate = highestReservationRate(inputs),
    outputRate = highestReservationRate(outputs);
  const inputUnits = ceilReservationRate(evidence.context.contextWindowTokens, inputRate.rate);
  const outputUnits = ceilReservationRate(16000, outputRate.rate);
  const reservedUnits = units.parse((inputUnits + outputUnits).toString());
  if (BigInt(reservedUnits) <= BigInt(0)) comparisonPlanFail("PUBLIC_COMPARISON_FINANCIAL_BASIS");
  const body = {
    financialBasisVersion: 1 as const,
    kind: "public-comparison-reservation-basis" as const,
    source: "supplied-financial-basis" as const,
    requestIdentityDigest: digest(identity),
    model: requestedModel,
    calculatedAt: now,
    requestedTier: null,
    maxCalls: 1 as const,
    evidence,
    costs: {
      currency: evidence.pricing.currency,
      unitScale: evidence.pricing.unitScale,
      inputTokensReserved: evidence.context.contextWindowTokens,
      outputTokensReserved: 16000 as const,
      maximumInputRate: inputRate,
      maximumOutputRate: outputRate,
      inputUnits: inputUnits.toString(),
      outputUnits: outputUnits.toString(),
      reservedUnits,
      rounding: "ceil-each-rate-per-request" as const,
    },
    validUntil: new Date(
      Math.min(...evidence.sources.map((s) => Date.parse(s.validUntil))),
    ).toISOString(),
    authority: comparisonPlanAuthority,
  };
  return { ...body, basisDigest: digest(body) };
}
export type ComparisonFinancialBasis = ReturnType<typeof createComparisonFinancialBasis>;
