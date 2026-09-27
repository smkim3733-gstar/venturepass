import { z } from "zod";
import { caseSchema } from "./studio-schema";
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
  createProviderContextReservation,
  type ProviderContextReservationInput,
} from "./studio-plan-quality-provider-reservation";
import type {
  ProviderEnvironment,
  ProviderPreparation,
  ProviderContract,
  ProviderRetentionNotice,
} from "./studio-plan-quality-provider-types";
import {
  providerBudgetScope,
  providerDigest,
  providerRawDigest,
  providerWireDigest,
  providerPreparationSchema,
  validateProviderPreparation,
} from "../../scripts/local-data-quality-provider.mjs";
export {
  providerBudgetScope,
  providerDigest,
  providerRawDigest,
  providerWireDigest,
  providerStartDigestInput,
  providerCancelDigestInput,
  providerPolicyDigestInput,
  createProviderBudgetEvent,
  createProviderRun,
  createProviderRunEvent,
  createProviderReceipt,
  createProviderArtifact,
  validateProviderPreparation,
  validateProviderBudgetLedger,
  validateProviderRunLedger,
  inspectProviderLedger,
} from "../../scripts/local-data-quality-provider.mjs";

export type ProviderPreparationInput = {
  registry: CandidateRegistrySnapshot;
  candidateId: string;
  environment: ProviderEnvironment;
  preparedAt: string;
  expiresAt: string;
  financialInput: ProviderContextReservationInput;
  budget: ProviderPreparation["budget"];
  retention: ProviderRetentionNotice;
};
export type ProviderRequestReviewInput = {
  registry: CandidateRegistrySnapshot;
  candidateId: string;
  model: string;
  preparedAt: string;
};
export type ProviderRequestReview = Pick<
  ProviderPreparation,
  "scope" | "model" | "contract" | "generation" | "reviewTemplate"
>;
const requestReviewIdentitySchema = z
  .object({
    candidateId: z.string().min(1),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
    preparedAt: z.string().datetime(),
  })
  .strict();
const requestOptions = {
  service_tier: "default",
  truncation: "disabled",
  background: false,
  stream: false,
} as const;
export function getProviderExecutionContract(): ProviderContract {
  const value: Omit<ProviderContract, "contractDigest"> = {
    schemaVersion: 2,
    engineVersion: "plan-provider-reservation-v2",
    baseContract: getPlanExecutionContract(),
    requestOptions: { ...requestOptions },
    omittedFields: ["previous_response_id", "conversation", "tools", "context_management"],
    maxCalls: 2,
    maxRetries: 0,
    maxOutputTokens: 16000,
  };
  return { ...value, contractDigest: providerWireDigest(value) };
}

/** Exact request evidence only. No budget, approval, storage or provider capability is created. */
export function createProviderRequestReview(
  input: ProviderRequestReviewInput,
): ProviderRequestReview {
  const identity = requestReviewIdentitySchema.parse({
    candidateId: input.candidateId,
    model: input.model,
    preparedAt: input.preparedAt,
  });
  const registry = validateCandidateRegistrySnapshot(input.registry);
  const entry = registry.entries.find((item) => item.candidateId === identity.candidateId);
  const manifest = registry.manifest.find((item) => item.candidateId === identity.candidateId);
  if (!entry || !manifest) throw new Error("Provider candidate binding invalid");
  const source = candidateRegistryModelInput(entry);
  const company = caseSchema.parse({
    id: "00000000-0000-4000-8000-000000000002",
    profile: source.profile,
    sources: source.sources,
    analysis: null,
    selectedCandidateId: source.candidate.id,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: identity.preparedAt,
    updatedAt: identity.preparedAt,
  });
  const contract = getProviderExecutionContract();
  const generation = buildPlanGenerationRequest(company, source.candidate, identity.model);
  const template = buildPlanReviewTemplate(company, source.candidate, identity.model);
  const body = { ...generation.body, ...requestOptions };
  const review: Omit<ProviderPreparation["reviewTemplate"], "templateDigest"> = {
    ...template,
    schemaVersion: 2,
    contractDigest: contract.contractDigest,
    requestOptions: { ...requestOptions },
  };
  delete (review as Partial<ProviderPreparation["reviewTemplate"]>).templateDigest;
  return {
    scope: {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: entry.candidateId,
      sourceDigest: manifest.sourceDigest,
      candidateDigest: manifest.candidateDigest,
      modelInputDigest: manifest.modelInputDigest,
    },
    model: identity.model,
    contract,
    generation: {
      body,
      requestDigest: providerWireDigest(body),
      sha256: providerRawDigest(JSON.stringify(body)),
      inputChars: generation.inputChars,
    },
    reviewTemplate: { ...review, templateDigest: providerWireDigest(review) },
  };
}

/** Pure review payload; it creates no approval, reservation or provider capability. */
export function createProviderPreparation(input: ProviderPreparationInput): ProviderPreparation {
  const registry = validateCandidateRegistrySnapshot(input.registry);
  const financialBasis = createProviderContextReservation(input.financialInput);
  if (
    financialBasis.status !== "calculated-for-stated-conditions" ||
    !financialBasis.model ||
    input.financialInput.outputReservationTokens !== 16000 ||
    financialBasis.calculatedAt !== input.preparedAt ||
    financialBasis.evidenceMode !==
      (input.environment === "synthetic-test" ? "synthetic-test" : "official-reviewed") ||
    input.budget.scopeId !== providerBudgetScope(input.environment)
  )
    throw new Error("Provider financial scope invalid");
  const request = createProviderRequestReview({
    registry,
    candidateId: input.candidateId,
    model: financialBasis.model,
    preparedAt: input.preparedAt,
  });
  const value: Omit<ProviderPreparation, "preparationDigest"> = {
    schemaVersion: 2,
    kind: "provider-execution-preparation",
    environment: input.environment,
    preparedAt: input.preparedAt,
    expiresAt: input.expiresAt,
    scope: request.scope,
    model: request.model,
    contract: request.contract,
    generation: request.generation,
    reviewTemplate: request.reviewTemplate,
    financialBasis,
    financialBasisDigest: providerDigest(financialBasis),
    budget: structuredClone(input.budget),
    retention: structuredClone(input.retention),
    retentionDigest: providerDigest(input.retention),
    permissions: { dispatchAllowed: false, tokenFitVerified: false, accountAccessVerified: false },
  };
  const result = providerPreparationSchema.parse({
    ...value,
    preparationDigest: providerDigest(value),
  });
  return validateProviderPreparation(result, registry);
}

/** New writes rebind current builders and current time; archival reads never call this. */
export function validateNewProviderPreparation(
  value: ProviderPreparation,
  registry: CandidateRegistrySnapshot,
  now: string,
) {
  const p = validateProviderPreparation(value, registry);
  const time = Date.parse(now);
  if (!Number.isFinite(time) || time < Date.parse(p.preparedAt) || time >= Date.parse(p.expiresAt))
    throw new Error("Provider preparation expired");
  const f = p.financialBasis;
  const expected = createProviderPreparation({
    registry,
    candidateId: p.scope.candidateId,
    environment: p.environment,
    preparedAt: p.preparedAt,
    expiresAt: p.expiresAt,
    budget: p.budget,
    retention: p.retention,
    financialInput: {
      evidenceMode: f.evidenceMode!,
      model: f.model,
      calculatedAt: p.preparedAt,
      outputReservationTokens: 16000,
      conditions: f.conditions!,
      context: f.evidence.context,
      pricing: f.evidence.pricing,
    },
  });
  if (expected.preparationDigest !== p.preparationDigest)
    throw new Error("Provider preparation changed");
  return p;
}
