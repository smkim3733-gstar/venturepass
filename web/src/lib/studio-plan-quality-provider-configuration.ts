import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-current";
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
  type ProviderReviewExpiredView,
} from "./studio-plan-quality-provider-review-types";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
/** Current server evidence only; historical readers use their archived records. */
export function getProviderConfigurationProposal(): ProviderConfigurationProposal | null {
  return readFixedProviderConfiguration();
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
 * Invalid/expired evidence cannot create a proposal; expiry diagnostics are separate.
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

/** Diagnose time expiry only after the complete proposal was valid at a shared review time. */
export function getProviderConfigurationExpiry(
  input: Parameters<typeof createProviderConfigurationProposalView>[0],
): ProviderReviewExpiredView["expiry"] | null {
  const parsed = providerConfigurationProposalSchema.safeParse(input.configuration);
  const now = Date.parse(input.inspectedAt);
  if (!parsed.success || !Number.isFinite(now)) return null;
  const configuration = parsed.data;
  const firstDeadline = Math.min(
    ...configuration.sources.map((source) => Date.parse(source.validUntil)),
  );
  const lastReview = Math.max(
    ...configuration.sources.map((source) => Date.parse(source.reviewedAt)),
  );
  if (now < firstDeadline || lastReview >= firstDeadline) return null;
  // Reuse every hash, provenance, source binding, model, rate and request check.
  // This historical inspection is never returned as a current proposal or grant.
  if (
    !createProviderConfigurationProposalView({
      ...input,
      configuration,
      inspectedAt: new Date(lastReview).toISOString(),
    })
  )
    return null;
  return {
    configurationDigest: configuration.configurationDigest,
    validUntil: new Date(firstDeadline).toISOString(),
  };
}
