/** Synthetic-only fixtures. No route or production transport imports this module. */
import { randomUUID } from "node:crypto";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import type { ProviderRun } from "./studio-plan-quality-provider-types";
import type { ProviderExecutionCommand } from "./studio-plan-quality-provider-execution-types";
import type { ProviderUsagePolicy } from "../../scripts/local-data-quality-provider-usage.mjs";
import { createProviderTransmissionManifest } from "../../scripts/local-data-quality-provider-execution.mjs";
import { actualTestNow, actualTestResponse } from "./studio-plan-quality-actual-test-helpers";
import { providerTestExpires } from "./studio-plan-quality-provider-test-helpers";

export function providerExecutionTestPolicy(run: ProviderRun): ProviderUsagePolicy {
  return {
    schemaVersion: 1,
    kind: "provider-usage-rate-policy",
    provenance: "synthetic-test",
    financialBasisDigest: run.preparation.financialBasisDigest,
    configuredModel: run.preparation.model,
    responseModels: [run.preparation.model],
    requestedTier: "default",
    responseTier: "default",
    inputPartition: { kind: "equal-rates", basis: "합성 입력·캐시 읽기·쓰기 요율이 동일합니다." },
    bandSelection: { kind: "short-only", basis: "합성 단일 문맥 요율만 사용합니다." },
    authority: {
      sourceUrl: "https://example.invalid/synthetic-usage",
      documentDigest: "c".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
      excerpt: "실제 요율과 무관한 합성 사용량 분류 계약입니다.",
    },
  };
}
export function providerExecutionTestApproval(
  store: PlanQualityStore,
  id: string,
): ProviderExecutionCommand<"transmission-approved"> {
  const run = store.providerGet(id).run,
    budget = store.providerBudgetGet();
  const manifest = createProviderTransmissionManifest(run, providerExecutionTestPolicy(run));
  return {
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    payload: {
      kind: "transmission-approved",
      manifest,
      provenance: "synthetic-test",
      approvedAt: actualTestNow,
      expiresAt: providerTestExpires,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: run.preparation.retentionDigest,
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
  };
}
export function providerExecutionTestResponse(
  output: unknown,
  options: Parameters<typeof actualTestResponse>[1] = {},
) {
  return {
    ...actualTestResponse(output, { model: "synthetic-provider-model", ...options }),
    service_tier: "default",
  };
}
