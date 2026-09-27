/** Synthetic fixtures for tests only. No production route imports this module. */
import { randomUUID } from "node:crypto";
import {
  createCandidateRegistrySource,
  candidateRegistryVersionDigest,
} from "./studio-plan-quality-candidate-registry";
import {
  candidateRegistryNotice,
  type CandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry-types";
import { createQualityActualPreparation } from "./studio-plan-quality-actual-preparation";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { sectionDefinitions, type PlanContent } from "./studio-schema";
import type {
  QualityActualBudget,
  QualityActualPrice,
  QualityActualTokens,
} from "./studio-plan-quality-actual-types";

export const actualTestNow = "2026-09-27T03:00:00.000Z";
export const actualTestModel = "synthetic-ledger-model";
export function actualTestRegistry(): CandidateRegistrySnapshot {
  const value: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
    ...createCandidateRegistrySource(),
    kind: "validation-candidate-set",
    version: 1,
    previousVersion: null,
    previousDigest: null,
    registeredAt: actualTestNow,
    clientRequestId: randomUUID(),
    notice: candidateRegistryNotice,
  };
  return { ...value, versionDigest: candidateRegistryVersionDigest(value) };
}
export function actualTestPreparation(
  registry: CandidateRegistrySnapshot,
  options: {
    candidateIndex?: number;
    preparedAt?: string;
    capUnits?: string;
    heldUnits?: string;
    ledgerDigest?: string;
    currency?: string;
    unitScale?: number;
  } = {},
) {
  const now = options.preparedAt ?? actualTestNow;
  const authority = {
    sourceUrl: "https://example.invalid/synthetic-ledger-test",
    documentDigest: digest({ fixture: "not actual provider evidence" }),
    retrievedAt: "2026-09-26T00:00:00.000Z",
    reviewedAt: "2026-09-26T01:00:00.000Z",
    validFrom: "2026-09-26T00:00:00.000Z",
    validUntil: "2026-09-28T00:00:00.000Z",
    reviewerId: "synthetic-test",
    excerpt: "합성 계산값입니다. 실제 공급자 가격·토큰 근거가 아닙니다.",
    applicability: "임시 합성 원장 시험만",
    validityPolicy: "합성 시험의 고정 시간 구간",
  };
  const base = {
    registry,
    candidateId: registry.entries[options.candidateIndex ?? 0].candidateId,
    model: actualTestModel,
    preparedAt: now,
    price: null,
    tokens: null,
    budget: null,
    environment: "synthetic-test" as const,
  };
  const view = createQualityActualPreparation(base),
    evidence = view.requestEvidence!;
  const price: QualityActualPrice = {
    provenance: "synthetic-test",
    provider: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: actualTestModel,
    authority,
    currency: options.currency ?? "TST",
    unitScale: options.unitScale ?? 6,
    inputRate: { units: "1", perTokens: 1000000 },
    outputRate: { units: "1", perTokens: 16000 },
    cachePolicy: "undiscounted",
    outputCoverage: "all-output-including-reasoning",
    additionalCharges: { kind: "none-verified" },
  };
  const tokens: QualityActualTokens = {
    provenance: "synthetic-test",
    provider: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: actualTestModel,
    authority,
    tokenizerId: "synthetic-bound",
    tokenizerVersion: "test-v1",
    contractDigest: view.engine.contractDigest,
    coverage: {
      system: true,
      user: true,
      structuredOutputSchema: true,
      messageFraming: true,
      providerOverhead: true,
    },
    assurance: "entire-request-upper-bound",
    generation: { requestDigest: evidence.generation.requestDigest, inputUpperBound: 10 },
    review: {
      templateDigest: evidence.reviewTemplate.templateDigest,
      inputUpperBound: 20,
      includesMaxGeneratedDraftTokens: 16000,
      includesDraftSerialization: true,
      derivation: "this-run-validated-generation-only",
    },
    maxInputTokens: 100000,
    maxOutputTokens: 16000,
    contextWindowTokens: 200000,
  };
  const budget: QualityActualBudget = {
    provenance: "synthetic-test",
    currency: price.currency,
    unitScale: price.unitScale,
    capUnits: options.capUnits ?? "1000000",
    unsettledUnits: options.heldUnits ?? "0",
    observedAt: now,
    validUntil: "2026-09-28T00:00:00.000Z",
    scope: "candidate-quality-executions",
    ledgerDigest: options.ledgerDigest ?? digest({ testLedger: true }),
  };
  return createQualityActualPreparation({ ...base, price, tokens, budget });
}
export function actualTestPlan(registry: CandidateRegistrySnapshot, index = 0): PlanContent {
  const source = registry.entries[index].input.sources[0];
  return {
    title: "합성 원장 검증 원고",
    summary: "합성 자료를 사용한 저장 순서 시험입니다.",
    sections: sectionDefinitions.map((section) => ({
      ...section,
      content: "합성 자료에 설명한 범위를 정리했습니다.",
      evidence: [{ sourceId: source.id, quote: source.text.slice(0, 150), locator: "합성 원문" }],
      needsConfirmation: false,
    })),
    actionItems: [],
    interviewQuestions: ["자료에 설명된 기술 범위를 대조해 주세요."],
  };
}
export function actualTestResponse(
  output: unknown,
  options: {
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    missingUsage?: boolean;
  } = {},
) {
  const input = options.inputTokens ?? 1,
    out = options.outputTokens ?? 1;
  return {
    id: "synthetic-response",
    _request_id: "synthetic-request",
    model: options.model ?? actualTestModel,
    status: "completed",
    ...(options.missingUsage
      ? {}
      : { usage: { input_tokens: input, output_tokens: out, total_tokens: input + out } }),
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  };
}
