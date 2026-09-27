import { z } from "zod";
import { caseSchema } from "./studio-schema";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  candidateRegistryModelInput,
  validateCandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import {
  buildPlanGenerationRequest,
  buildPlanReviewTemplate,
  getPlanExecutionContract,
} from "./studio-engine-request-preparation";
import {
  qualityActualBlockerMessages,
  qualityActualBudgetSchema,
  qualityActualExecutionBlocks,
  qualityActualPreparationDigestInput,
  qualityActualPreparationSchema,
  qualityActualPriceSchema,
  qualityActualRequestEvidenceSchema,
  qualityActualTokensSchema,
  type QualityActualBlockerCode,
  type QualityActualPreparation,
  type QualityActualRequestEvidence,
  type QualityActualTokens,
} from "./studio-plan-quality-actual-types";

export type QualityActualPreparationInput = {
  registry: CandidateRegistrySnapshot;
  candidateId: string;
  model: string | null;
  preparedAt: string;
  /** Internal evidence only. Production HTTP handlers must not accept these from clients. */
  price: unknown | null;
  tokens: unknown | null;
  budget: unknown | null;
  environment?: "production" | "synthetic-test";
};
/** The adapter must bound the complete wire request, not estimate tokens from character counts. */
export type QualityActualTokenAdapter = (input: {
  requestEvidence: QualityActualRequestEvidence;
  engine: QualityActualPreparation["engine"];
}) => unknown;
export function inspectQualityActualTokens(
  requestEvidence: QualityActualRequestEvidence,
  adapter: QualityActualTokenAdapter,
): QualityActualTokens {
  return qualityActualTokensSchema.parse(
    adapter({
      requestEvidence: structuredClone(qualityActualRequestEvidenceSchema.parse(requestEvidence)),
      engine: getPlanExecutionContract(),
    }),
  );
}
function currentAuthority(
  authority: { retrievedAt: string; reviewedAt: string; validFrom: string; validUntil: string },
  now: number,
) {
  const retrieved = Date.parse(authority.retrievedAt),
    reviewed = Date.parse(authority.reviewedAt);
  const from = Date.parse(authority.validFrom),
    until = Date.parse(authority.validUntil);
  return retrieved <= reviewed && reviewed <= now && from <= now && now < until && from < until;
}
const roundedRate = (tokens: number, units: string, perTokens: number) => {
  const denominator = BigInt(perTokens);
  return (BigInt(tokens) * BigInt(units) + denominator - BigInt(1)) / denominator;
};

/** Pure inspection. No key/configuration lookup, storage mutation, network request or execution approval. */
export function createQualityActualPreparation(
  input: QualityActualPreparationInput,
): QualityActualPreparation {
  const archived = validateCandidateRegistrySnapshot(input.registry);
  const preparedAt = z.string().datetime().parse(input.preparedAt);
  const environment = z
    .enum(["production", "synthetic-test"])
    .parse(input.environment ?? "production");
  const model = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
    .nullable()
    .parse(input.model);
  const now = Date.parse(preparedAt);
  const entry = archived.entries.find((item) => item.candidateId === input.candidateId);
  const manifest = archived.manifest.find((item) => item.candidateId === input.candidateId);
  if (!entry || !manifest) throw new Error("Quality actual preparation candidate mismatch");
  const engine = getPlanExecutionContract();
  const blockers: QualityActualPreparation["blockers"] = [];
  const block = (code: QualityActualBlockerCode) => {
    if (!blockers.some((item) => item.code === code))
      blockers.push({ code, message: qualityActualBlockerMessages[code] });
  };
  let requestEvidence: QualityActualRequestEvidence | null = null;
  if (model === null) block("MODEL_NOT_SELECTED");
  else {
    const modelInput = candidateRegistryModelInput(entry);
    const company = caseSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      profile: modelInput.profile,
      sources: modelInput.sources,
      analysis: null,
      selectedCandidateId: modelInput.candidate.id,
      plans: [],
      tasks: [],
      stage: "preparing",
      revision: 0,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    });
    const payload = {
      generation: buildPlanGenerationRequest(company, modelInput.candidate, model),
      reviewTemplate: buildPlanReviewTemplate(company, modelInput.candidate, model),
    };
    requestEvidence = qualityActualRequestEvidenceSchema.parse({
      ...payload,
      evidenceDigest: digest(payload),
    });
  }
  const priceParsed = qualityActualPriceSchema.safeParse(input.price);
  const tokenParsed = qualityActualTokensSchema.safeParse(input.tokens);
  const budgetParsed = qualityActualBudgetSchema.safeParse(input.budget);
  const price = priceParsed.success ? priceParsed.data : null;
  const tokens = tokenParsed.success ? tokenParsed.data : null;
  const budget = budgetParsed.success ? budgetParsed.data : null;
  if (input.price === null) block("PRICE_NOT_CONFIGURED");
  else if (!price) block("PRICE_INVALID");
  if (input.tokens === null) block("TOKEN_BOUND_NOT_CONFIGURED");
  else if (!tokens) block("TOKEN_BOUND_INVALID");
  if (input.budget === null) block("BUDGET_NOT_CONFIGURED");
  else if (!budget) block("BUDGET_INVALID");
  if (price) {
    if (
      price.model !== model ||
      price.provider !== engine.provider ||
      price.endpoint !== engine.endpoint
    )
      block("PRICE_SCOPE_MISMATCH");
    if (!currentAuthority(price.authority, now)) block("PRICE_OUTDATED");
  }
  if (tokens) {
    if (
      tokens.model !== model ||
      tokens.provider !== engine.provider ||
      tokens.endpoint !== engine.endpoint ||
      tokens.contractDigest !== engine.contractDigest ||
      !requestEvidence ||
      tokens.generation.requestDigest !== requestEvidence.generation.requestDigest ||
      tokens.review.templateDigest !== requestEvidence.reviewTemplate.templateDigest
    )
      block("TOKEN_SCOPE_MISMATCH");
    if (!currentAuthority(tokens.authority, now)) block("TOKEN_EVIDENCE_OUTDATED");
    if (
      tokens.maxOutputTokens < engine.maxOutputTokens ||
      [tokens.generation.inputUpperBound, tokens.review.inputUpperBound].some(
        (bound) =>
          bound > tokens.maxInputTokens ||
          BigInt(bound) + BigInt(engine.maxOutputTokens) > BigInt(tokens.contextWindowTokens),
      )
    )
      block("TOKEN_LIMIT_EXCEEDED");
  }
  if (budget) {
    if (
      Date.parse(budget.observedAt) > now ||
      Date.parse(budget.validUntil) <= now ||
      Date.parse(budget.observedAt) >= Date.parse(budget.validUntil)
    )
      block("BUDGET_INVALID");
    if (price && (budget.currency !== price.currency || budget.unitScale !== price.unitScale))
      block("BUDGET_SCOPE_MISMATCH");
  }
  if (
    environment === "production" &&
    [price, tokens, budget].some((value) => value?.provenance === "synthetic-test")
  )
    block("SYNTHETIC_EVIDENCE_FORBIDDEN");
  let costs: QualityActualPreparation["costs"] = null;
  if (blockers.length === 0 && price && tokens && budget) {
    const extra =
      price.additionalCharges.kind === "bounded-per-request"
        ? BigInt(price.additionalCharges.units)
        : BigInt(0);
    const maximum = (bound: number) =>
      roundedRate(bound, price.inputRate.units, price.inputRate.perTokens) +
      roundedRate(engine.maxOutputTokens, price.outputRate.units, price.outputRate.perTokens) +
      extra;
    const generation = maximum(tokens.generation.inputUpperBound),
      review = maximum(tokens.review.inputUpperBound);
    const total = generation + review + BigInt(budget.unsettledUnits);
    costs = {
      currency: price.currency,
      unitScale: price.unitScale,
      generationUnits: generation.toString(),
      reviewUnits: review.toString(),
      unsettledUnits: budget.unsettledUnits,
      totalUnits: total.toString(),
      budgetUnits: budget.capUnits,
      rounding: "ceil-each-rate-per-request",
      meaning: "unreserved-upper-bound-not-a-bill",
    };
    if (total > BigInt(budget.capUnits)) block("BUDGET_EXCEEDED");
  }
  const payload: Omit<QualityActualPreparation, "preparationDigest"> = {
    schemaVersion: 1,
    kind: "actual-ai-preparation-inspection",
    environment,
    preparedAt,
    scope: {
      setId: archived.setId,
      version: archived.version,
      versionDigest: archived.versionDigest,
      registrySourceDigest: archived.sourceDigest,
      manifestDigest: archived.manifestDigest,
      candidateId: entry.candidateId,
      label: entry.label,
      sourceDigest: manifest.sourceDigest,
      candidateDigest: manifest.candidateDigest,
      modelInputDigest: manifest.modelInputDigest,
    },
    model,
    provider: "OpenAI",
    destination: "https://api.openai.com/v1",
    purpose: "synthetic-candidate-generation-and-review",
    engine,
    requestEvidence,
    evidence: { price, tokens, budget },
    costs,
    readiness: blockers.length ? "blocked" : "calculation-ready",
    blockers,
    executionBlocks: [...qualityActualExecutionBlocks],
    executionAllowed: false,
    approvalRecorded: false,
    reservationRecorded: false,
    humanAnswerKey: null,
    independentHoldoutConfirmed: false,
    performanceEvaluation: "not-performed",
  };
  return qualityActualPreparationSchema.parse({
    ...payload,
    preparationDigest: digest(qualityActualPreparationDigestInput(payload)),
  });
}
/** Reconstruct against exact registered input and trusted current evidence; re-sealing edited JSON is insufficient. */
export function validateQualityActualPreparation(
  value: unknown,
  input: QualityActualPreparationInput,
) {
  const received = qualityActualPreparationSchema.parse(value);
  const expected = createQualityActualPreparation(input);
  if (digest(received) !== digest(expected))
    throw new Error("Quality actual preparation binding mismatch");
  return received;
}
