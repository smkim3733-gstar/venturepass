import { createHash } from "node:crypto";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { createProviderRequestReview } from "./studio-plan-quality-provider-core";
import { createProviderContextReservation } from "./studio-plan-quality-provider-reservation";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { validateProviderUsagePolicy } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerConfigurationProposalSchema,
  providerConfigurationDigestInput,
  providerProposalSourceDigestInput,
  providerReviewProposalViewSchema,
  providerReviewNotice,
  providerProposalBlockerCodes,
  providerProposalBlockerMessages,
  type ProviderConfigurationProposal,
  type ProviderProposalSource,
  type ProviderReviewProposalView,
} from "./studio-plan-quality-provider-review-types";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const reviewedAt = "2026-09-26T23:57:59.000Z";
const validUntil = "2026-09-27T23:57:59.000Z";
const retrievedAt = "2026-09-26T23:54:00.000Z";
/** Curated evidence, not fetched HTTP bytes. See 기획/품질평가_운영모델_공식근거_검토.md. */
function source(id: string, url: string, title: string, excerpt: string): ProviderProposalSource {
  const value: Omit<ProviderProposalSource, "recordDigest"> = {
    id,
    url,
    title,
    retrievedAt,
    reviewedAt,
    validUntil,
    excerpt,
    excerptSha256: sha(excerpt),
    bodySha256: null,
    digestKind: "curated-record",
  };
  return { ...value, recordDigest: digest(providerProposalSourceDigestInput(value)) };
}
const sources = [
  source(
    "gpt-54-model",
    "https://developers.openai.com/api/docs/models/gpt-5.4",
    "GPT-5.4 모델·문맥·요율",
    "검토 스냅샷 gpt-5.4-2026-03-05. 문맥 1,050,000·출력 128,000 토큰, Responses·Structured Outputs 지원. 일반 입력/캐시 읽기/출력은 1M당 USD 2.50/0.25/15.00. 입력 272,000 초과 시 입력 2배·출력 1.5배. 장문 캐시 읽기 USD 0.50은 입력 배율을 적용한 산술 해석이며 별도 가격 행의 직접 인용이 아니다.",
  ),
  source(
    "context-window",
    "https://developers.openai.com/api/docs/guides/conversation-state",
    "문맥·응답 저장",
    "문맥은 한 요청의 입력·출력·추론을 포함한다. 전체 문맥을 입력에 예약하고 출력을 별도 더하는 계산은 금융 과대예약이며 실제 요청 적합성을 증명하지 않는다. store:false는 응답 재조회용 저장 조건이며 모든 보관을 제거하는 약속이 아니다.",
  ),
  source(
    "cache-pricing",
    "https://developers.openai.com/api/docs/guides/prompt-caching",
    "캐시 요율·사용량 해석",
    "GPT-5.6 이전 모델은 추가 캐시 쓰기 과금이 없다. GPT-5.4 정책은 입력 총량에서 캐시 읽기를 제외한 입력에 일반 입력 요율을 적용한다. 별도 쓰기 과금 없음은 물리적 캐시 쓰기나 cache_write_tokens 값이 0이라는 뜻이 아니다. 원래 사용량은 보존한다.",
  ),
  source(
    "responses-api",
    "https://developers.openai.com/api/reference/cli/resources/responses/methods/create",
    "Responses 요청·사용량",
    "service_tier:default는 Standard 처리 요청이며 실제 응답 tier는 다를 수 있다. max_output_tokens는 보이는 출력과 추론을 포함한다. truncation:disabled에서 문맥을 초과하면 오류가 날 수 있으므로 적합성을 보장하지 않는다. 사용량의 입력·출력·총량과 캐시 내역을 별도로 대조한다.",
  ),
  source(
    "reasoning-cost",
    "https://developers.openai.com/api/docs/guides/reasoning",
    "추론·출력 비용",
    "추론 토큰은 출력 요율에 포함된다. output_tokens에 reasoning_tokens를 다시 더하지 않는다. 출력 한도에 도달해 보이는 원고가 없더라도 비용이 발생할 수 있으므로 원고 검증 실패를 무료로 간주하지 않는다.",
  ),
  source(
    "data-retention",
    "https://developers.openai.com/api/docs/guides/your-data",
    "공급자 데이터 보관 조건",
    "store:false는 모든 데이터의 즉시 삭제나 ZDR 승인이 아니다. 기본 악용 방지 로그에 입력·응답이 포함될 수 있으며 통상 최대 30일, 법률·안전상 예외가 있다. ZDR 미설정 조직의 지원 모델에서는 확장 캐시의 암호화 KV가 최대 24시간 남을 수 있다. 계정의 특별 보관 설정은 확인하지 않았다.",
  ),
  source(
    "long-context-pricing",
    "https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4",
    "장문 처리 조건",
    "제안 범위는 기본 Global 목적지와 Standard 처리다. 입력 272K 초과 장문 요율을 확인하며, 지역·다른 처리 등급의 가산을 이 제안에 혼합하지 않는다. 실제 계정의 처리 조건·이용 권한은 별도 확인해야 한다.",
  ),
];
const authority = (index: number) => ({
  sourceUrl: sources[index].url,
  documentDigest: sources[index].recordDigest,
  retrievedAt,
  reviewedAt,
  validUntil,
  freshnessPolicy: "공식 자료 열람 후 내부 24시간 재확인 기한. 공급자의 가격 고정 보장이 아니다.",
  reviewerId: "venturepass-official-proposal-review-2026-09-27",
  excerpt: sources[index].excerpt,
});
const conditions: ProviderConfigurationProposal["conditions"] = {
  provider: "OpenAI",
  endpoint: "https://api.openai.com/v1",
  api: "responses",
  modality: "text-only",
  tools: "none",
  tokenCountingEndpoint: "none",
  serviceTier: "default",
  processing: "standard",
  destination: "global",
  store: false,
  truncation: "disabled",
  previousResponse: "none",
  conversation: "none",
  compaction: "none",
  background: false,
  stream: false,
  maxCalls: 2,
  retries: 0,
};
const fixedProposal: Omit<ProviderConfigurationProposal, "configurationDigest"> = {
  schemaVersion: 1,
  kind: "provider-configuration-proposal",
  adoption: "not-adopted",
  model: "gpt-5.4-2026-03-05",
  conditions,
  outputReservationTokens: 16000,
  context: {
    provenance: "official-reviewed",
    model: "gpt-5.4-2026-03-05",
    conditions,
    authority: authority(0),
    contextWindowTokens: 1050000,
    contextCoverage: "input-plus-output-including-reasoning",
    maxOutputTokens: 128000,
  },
  pricing: {
    provenance: "official-reviewed",
    model: "gpt-5.4-2026-03-05",
    conditions,
    authority: authority(0),
    currency: "USD",
    unitScale: 6,
    rateMeaning: "all-in-replacement-rates-not-additive-surcharges",
    shortContext: {
      uncachedInput: { units: "2500000", perTokens: 1000000 },
      cacheReadInput: { units: "250000", perTokens: 1000000 },
      cacheWriteInput: { applicability: "not-applicable", explanation: sources[2].excerpt },
      outputIncludingReasoning: { units: "15000000", perTokens: 1000000 },
    },
    longContext: {
      uncachedInput: { units: "5000000", perTokens: 1000000 },
      cacheReadInput: { units: "500000", perTokens: 1000000 },
      cacheWriteInput: { applicability: "not-applicable", explanation: sources[2].excerpt },
      outputIncludingReasoning: { units: "22500000", perTokens: 1000000 },
    },
    additionalCharges: {
      applicability: "none-under-stated-conditions",
      explanation:
        "텍스트 전용·도구 없음·Global·Standard 제안 범위다. 이 모델의 추가 캐시 쓰기 과금은 없으며 다른 처리 등급·지역 조건은 제안 대상에서 제외한다. 모든 실패의 청구 상한은 확인하지 않았다.",
    },
  },
  retention: {
    policyVersion: "gpt-54-proposal-2026-09-27",
    notice: sources[5].excerpt,
    sourceUrl: sources[5].url,
    documentDigest: sources[5].recordDigest,
    reviewedAt,
    validUntil,
  },
  usagePolicyTemplate: {
    schemaVersion: 1,
    kind: "provider-usage-rate-policy",
    provenance: "official-reviewed",
    configuredModel: "gpt-5.4-2026-03-05",
    responseModels: ["gpt-5.4-2026-03-05"],
    requestedTier: "default",
    responseTier: "default",
    inputPartition: {
      kind: "disjoint-cache",
      aggregate: "input-includes-cache-read-and-write",
      cacheRead: { kind: "field", path: ["input_tokens_details", "cached_tokens"] },
      cacheWrite: { kind: "not-applicable", basis: sources[2].excerpt },
      basis:
        "총입력에서 캐시 읽기를 뺀 입력은 일반 요율로 계산한다. 추가 쓰기 과금 없음은 쓰기 토큰 0의 관측이 아니다. 응답 원문을 보존하고 필요한 사용량 누락 시 미확인 비용으로 남긴다.",
    },
    bandSelection: {
      kind: "input-threshold",
      threshold: 272000,
      basis:
        "입력 272,000 초과만 장문 입력 2배·출력 1.5배. 긴 캐시 읽기 요율은 입력 배율을 적용한 산술 해석이다.",
    },
    authority: {
      sourceUrl: sources[2].url,
      documentDigest: sources[2].recordDigest,
      reviewedAt,
      validUntil,
      excerpt: sources[2].excerpt,
    },
  },
  proposedBudget: {
    kind: "cumulative-budget-proposal",
    currency: "USD",
    unitScale: 6,
    capUnits: "15000000",
    status: "not-approved",
    basis:
      "고정 합성 후보 한 건 시험의 초기 누적 USD 15 제안. 보수적 2회 예약 USD 11.22를 포함한다. 이미 사용·미정산된 금액은 차감해야 하며 재실행마다 한도가 새로 생기지 않는다. 예산 설정·예약·승인은 아니다.",
  },
  sources,
};
/** Server-fixed proposal only. No production adoption, key lookup, remote read or write. */
export function getProviderConfigurationProposal(): ProviderConfigurationProposal | null {
  return providerConfigurationProposalSchema.parse({
    ...fixedProposal,
    configurationDigest: digest(providerConfigurationDigestInput(fixedProposal)),
  });
}
function validSource(source: ProviderProposalSource, now: number) {
  return (
    source.excerptSha256 === sha(source.excerpt) &&
    source.recordDigest === digest(providerProposalSourceDigestInput(source)) &&
    (source.digestKind !== "body" || source.bodySha256 !== null) &&
    Date.parse(source.retrievedAt) <= Date.parse(source.reviewedAt) &&
    Date.parse(source.reviewedAt) <= now &&
    now < Date.parse(source.validUntil)
  );
}
function sourceBinding(
  configuration: ProviderConfigurationProposal,
  authority: {
    sourceUrl: string;
    documentDigest: string;
    reviewedAt: string;
    validUntil: string;
    retrievedAt?: string;
    excerpt?: string;
  },
) {
  return configuration.sources.some(
    (source) =>
      source.url === authority.sourceUrl &&
      (source.digestKind === "body" ? source.bodySha256 : source.recordDigest) ===
        authority.documentDigest &&
      source.reviewedAt === authority.reviewedAt &&
      source.validUntil === authority.validUntil &&
      (authority.retrievedAt === undefined || authority.retrievedAt === source.retrievedAt) &&
      (authority.excerpt === undefined || authority.excerpt === source.excerpt),
  );
}

/**
 * Pure/test-injectable inspection factory. The HTTP caller supplies only the fixed
 * server proposal. Synthetic provenance can never produce this production view.
 * Invalid/expired proposal evidence falls back to the unchanged missing view.
 */
export function createProviderConfigurationProposalView(input: {
  registry: CandidateRegistrySnapshot;
  candidateId: string;
  inspectedAt: string;
  configuration: unknown;
}): ProviderReviewProposalView | null {
  const parsed = providerConfigurationProposalSchema.safeParse(input.configuration);
  const now = Date.parse(input.inspectedAt);
  if (!parsed.success || !Number.isFinite(now)) return null;
  const config = parsed.data;
  if (
    config.configurationDigest !== digest(providerConfigurationDigestInput(config)) ||
    new Set(config.sources.map((source) => source.id)).size !== config.sources.length ||
    config.sources.some((source) => !validSource(source, now)) ||
    config.context.provenance !== "official-reviewed" ||
    config.pricing.provenance !== "official-reviewed" ||
    config.context.model !== config.model ||
    config.pricing.model !== config.model ||
    !same(config.context.conditions, config.conditions) ||
    !same(config.pricing.conditions, config.conditions) ||
    !sourceBinding(config, config.context.authority) ||
    !sourceBinding(config, config.pricing.authority) ||
    !sourceBinding(config, config.retention) ||
    !sourceBinding(config, config.usagePolicyTemplate.authority)
  )
    return null;
  const financialBasis = createProviderContextReservation({
    evidenceMode: "official-reviewed",
    model: config.model,
    calculatedAt: input.inspectedAt,
    outputReservationTokens: config.outputReservationTokens,
    conditions: config.conditions,
    context: config.context,
    pricing: config.pricing,
  });
  if (
    financialBasis.status !== "calculated-for-stated-conditions" ||
    !financialBasis.costs ||
    config.proposedBudget.currency !== financialBasis.costs.currency ||
    config.proposedBudget.unitScale !== financialBasis.costs.unitScale ||
    BigInt(config.proposedBudget.capUnits) < BigInt(financialBasis.costs.totalUnits) ||
    BigInt(config.proposedBudget.capUnits) === BigInt(0) ||
    config.usagePolicyTemplate.configuredModel !== config.model
  )
    return null;
  try {
    const usagePolicy = validateProviderUsagePolicy(
      { ...config.usagePolicyTemplate, financialBasisDigest: digest(financialBasis) },
      financialBasis,
    );
    const requestReview = createProviderRequestReview({
      registry: input.registry,
      candidateId: input.candidateId,
      model: config.model,
      preparedAt: input.inspectedAt,
    });
    const manifest = input.registry.manifest.find(
      (entry) => entry.candidateId === input.candidateId,
    );
    if (!manifest) return null;
    const view = {
      viewVersion: 2 as const,
      providerContractVersion: 2 as const,
      state: "proposal-only" as const,
      environment: "production" as const,
      inputProvenance: "registered-synthetic-candidate" as const,
      scope: {
        ...requestReview.scope,
        setId: input.registry.setId,
        registrySourceDigest: input.registry.sourceDigest,
        manifestDigest: input.registry.manifestDigest,
        label: manifest.label,
      },
      inspectedAt: input.inspectedAt,
      model: config.model,
      financialBasis,
      budget: null,
      retention: config.retention,
      preparation: null,
      transmissionManifest: null,
      accountAccess: "not-checked" as const,
      actualExecutionEnabled: false as const,
      maxCalls: 2 as const,
      maxRetries: 0 as const,
      automaticRepair: false as const,
      proposal: {
        configurationDigest: config.configurationDigest,
        adoption: "not-adopted" as const,
        requestReview,
        proposedBudget: config.proposedBudget,
        sources: config.sources,
        usagePolicy,
      },
      blockers: providerProposalBlockerCodes.map((code) => ({
        code,
        message: providerProposalBlockerMessages[code],
      })),
      notice: providerReviewNotice,
    };
    // Parse before returning; neither a loosely shaped future branch nor a grant is accepted.
    return providerReviewProposalViewSchema.parse({ ...view, viewDigest: digest(view) });
  } catch {
    return null;
  }
}
