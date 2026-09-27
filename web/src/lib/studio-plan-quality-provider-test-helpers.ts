/** Synthetic fixtures only. Never imported by application routes. */
import { randomUUID } from "node:crypto";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import {
  createProviderPreparation,
  providerBudgetScope,
} from "./studio-plan-quality-provider-core";
import type {
  ProviderContextReservationInput,
  ProviderReservationConditions,
} from "./studio-plan-quality-provider-reservation";
import type { ProviderStart } from "./studio-plan-quality-provider-types";
export const providerTestExpires = "2026-09-28T00:00:00.000Z";
export function providerTestFinancialInput(): ProviderContextReservationInput {
  const conditions: ProviderReservationConditions = {
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
  const authority = {
    sourceUrl: "https://example.invalid/synthetic-provider",
    documentDigest: "a".repeat(64),
    retrievedAt: "2026-09-26T00:00:00.000Z",
    reviewedAt: "2026-09-26T01:00:00.000Z",
    validUntil: providerTestExpires,
    freshnessPolicy: "합성 검증의 내부 만료 구간",
    reviewerId: "synthetic-test",
    excerpt: "실제 요금이나 토큰 수가 아닌 합성 시험값",
  };
  const base = {
    model: "synthetic-provider-model",
    provenance: "synthetic-test" as const,
    conditions,
    authority,
  };
  const rate = { units: "1", perTokens: 1000000 };
  return {
    evidenceMode: "synthetic-test",
    model: base.model,
    calculatedAt: actualTestNow,
    outputReservationTokens: 16000,
    conditions,
    context: {
      ...base,
      contextWindowTokens: 20000,
      maxOutputTokens: 16000,
      contextCoverage: "input-plus-output-including-reasoning",
    },
    pricing: {
      ...base,
      currency: "TST",
      unitScale: 6,
      rateMeaning: "all-in-replacement-rates-not-additive-surcharges",
      shortContext: {
        uncachedInput: rate,
        cacheReadInput: rate,
        cacheWriteInput: rate,
        outputIncludingReasoning: rate,
      },
      longContext: { applicability: "not-applicable", explanation: "합성 단일 요율" },
      additionalCharges: {
        applicability: "none-under-stated-conditions",
        explanation: "합성 검증만",
      },
    },
  };
}
export function providerTestConfigure(store: PlanQualityStore, capUnits = "100") {
  return store.providerBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: {
      environment: "synthetic-test",
      provenance: "synthetic-test",
      currency: "TST",
      unitScale: 6,
      capUnits,
    },
  });
}
export function providerTestStartInput(store: PlanQualityStore, index = 0): ProviderStart {
  const registry = store.candidateRegistryGet(1),
    budget = store.providerBudgetGet();
  const preparation = createProviderPreparation({
    registry,
    candidateId: registry.entries[index].candidateId,
    environment: "synthetic-test",
    preparedAt: actualTestNow,
    expiresAt: providerTestExpires,
    financialInput: providerTestFinancialInput(),
    budget: {
      scopeId: providerBudgetScope("synthetic-test"),
      revision: budget.revision,
      headDigest: budget.headDigest!,
      currency: budget.currency!,
      unitScale: budget.unitScale!,
      capUnits: budget.capUnits,
      heldUnits: budget.heldUnits,
      recognizedUnits: budget.recognizedUnits,
    },
    retention: {
      policyVersion: "synthetic-v2",
      notice: "합성 검증용 보관 조건. 실제 공급자 전송 또는 무보관 보장이 아닙니다.",
      sourceUrl: "https://example.invalid/synthetic-retention",
      documentDigest: "b".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
    },
  });
  return {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    expectedScopeRunCount: store
      .providerList()
      .executions.filter((v) => v.run.environment === "synthetic-test").length,
    expectedGlobalRunCount:
      store.actualList().executions.length + store.providerList().executions.length,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      approvedAt: actualTestNow,
      expiresAt: providerTestExpires,
      acknowledgedReservationOnly: true,
      acknowledgedFinancialBasisNotTokenFit: true,
      acknowledgedRetention: true,
      acknowledgedNoAutomaticRetry: true,
    },
  };
}
