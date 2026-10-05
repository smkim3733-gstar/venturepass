import "server-only";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  captureProviderResponse,
  providerUsageInputPartitionSchema,
  providerUsageBandSelectionSchema,
  assertProviderUsageRateRules,
  assessProviderUsageScalars,
  type ProviderUsageScalarPricing,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import {
  comparisonHashSchema as hash,
  comparisonBytes as bytes,
  comparisonPlanFail as fail,
  createComparisonFinancialBasis,
  comparisonPlanAuthority,
  type ComparisonFinancialBasis,
} from "./studio-public-claim-comparison-financial";
import {
  providerProposalSourceSchema,
  providerProposalSourceDigestInput,
} from "./studio-plan-quality-provider-review-types";
import { comparisonSha } from "./studio-public-claim-comparison-financial";
import type { PublicClaimComparisonRequestIdentity } from "./studio-public-claim-comparison-request-types";
import type { ComparisonTransmissionBasis } from "./studio-public-claim-comparison-transmission-types";

const text = z.string().min(1).max(2000);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
export const comparisonUsagePolicySchema = z
  .object({
    policyVersion: z.literal(1),
    kind: z.literal("public-comparison-usage-policy"),
    purpose: z.literal("compare-public-claim"),
    provenance: z.enum(["official-reviewed", "synthetic-test"]),
    financialBasisDigest: hash,
    requestIdentityDigest: hash,
    contractDigest: hash,
    configuredModel: model,
    requestedTier: z.null(),
    maxCalls: z.literal(1),
    automaticRetryLimit: z.literal(0),
    maxOutputTokens: z.literal(16000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    omissionsDigest: hash,
    responseModels: z.array(model).min(1).max(10),
    responseTiers: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/))
      .min(1)
      .max(10),
    modelMappingBasis: text,
    tierCoverageBasis: text,
    inputPartition: providerUsageInputPartitionSchema,
    bandSelection: providerUsageBandSelectionSchema,
    outputMeaning: z.literal("aggregate-output-includes-reasoning-no-addition"),
    authority: z
      .object({
        sources: z
          .array(z.object({ id: z.string().min(1).max(100), recordDigest: hash }).strict())
          .min(1)
          .max(24),
        reviewedAt: z.string().datetime(),
        validUntil: z.string().datetime(),
        explanation: text,
      })
      .strict(),
  })
  .strict();
export type ComparisonUsagePolicy = z.infer<typeof comparisonUsagePolicySchema>;
function same(a: unknown, b: unknown) {
  if (digest(a) !== digest(b)) fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
}
/** Rates only: do not cast the request into a legacy phase or default tier. */
function scalarPricing(f: ComparisonFinancialBasis): ProviderUsageScalarPricing {
  const channel = (
    c: ComparisonFinancialBasis["evidence"]["pricing"]["shortContext"]["cacheReadInput"],
  ) => (c.kind === "rate" ? c.rate : { applicability: "not-applicable" as const });
  const band = (b: ComparisonFinancialBasis["evidence"]["pricing"]["shortContext"]) => ({
    uncachedInput: b.uncachedInput,
    cacheReadInput: channel(b.cacheReadInput),
    cacheWriteInput: channel(b.cacheWriteInput),
    outputIncludingReasoning: b.outputIncludingReasoning,
  });
  const p = f.evidence.pricing;
  return {
    shortContext: band(p.shortContext),
    longContext:
      "kind" in p.longContext ? { applicability: "not-applicable" } : band(p.longContext),
  };
}
export function validateComparisonUsagePolicy(
  raw: unknown,
  f: ComparisonFinancialBasis,
  identity: PublicClaimComparisonRequestIdentity,
  transmission: ComparisonTransmissionBasis,
  environment: "production" | "synthetic-test",
  atRaw: string,
) {
  assertPublicComparisonDataOnly(raw, 32768);
  assertPublicComparisonDataOnly(f, 64 * 1024);
  assertPublicComparisonDataOnly(identity, 64 * 1024);
  assertPublicComparisonDataOnly(transmission, 64 * 1024);
  if (bytes(raw) > 32768) fail("PUBLIC_COMPARISON_PLAN_LIMIT");
  const p = comparisonUsagePolicySchema.parse(raw),
    at = z.string().datetime().parse(atRaw);
  same(
    f,
    createComparisonFinancialBasis(f.evidence, identity, f.model, environment, f.calculatedAt),
  );
  createComparisonFinancialBasis(f.evidence, identity, f.model, environment, at);
  if (
    p.financialBasisDigest !== f.basisDigest ||
    p.financialBasisDigest !== transmission.financialBasisDigest ||
    p.requestIdentityDigest !== digest(identity) ||
    p.contractDigest !== identity.contractDigest ||
    p.configuredModel !== f.model ||
    p.configuredModel !== transmission.model ||
    p.provenance !== f.evidence.provenance ||
    p.provenance !== transmission.provenance ||
    p.currency !== f.costs.currency ||
    p.unitScale !== f.costs.unitScale ||
    p.omissionsDigest !== digest(transmission.omissions) ||
    new Set(p.responseModels).size !== p.responseModels.length ||
    new Set(p.responseTiers).size !== p.responseTiers.length ||
    (environment === "production" && p.provenance !== "official-reviewed") ||
    Date.parse(p.authority.reviewedAt) > Date.parse(at) ||
    Date.parse(p.authority.validUntil) <= Date.parse(at) ||
    Date.parse(at) < Date.parse(f.calculatedAt)
  )
    fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
  const sources = new Map<string, ComparisonTransmissionBasis["sources"][number]>();
  for (const rawSource of [...f.evidence.sources, ...transmission.sources]) {
    const source = providerProposalSourceSchema.parse(rawSource);
    if (
      comparisonSha(source.excerpt) !== source.excerptSha256 ||
      digest(providerProposalSourceDigestInput(source)) !== source.recordDigest ||
      (source.digestKind === "body" && source.bodySha256 === null) ||
      (source.digestKind === "curated-record" && source.bodySha256 !== null) ||
      Date.parse(source.retrievedAt) > Date.parse(source.reviewedAt) ||
      Date.parse(source.reviewedAt) > Date.parse(at) ||
      Date.parse(at) >= Date.parse(source.validUntil)
    )
      fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
    const prior = sources.get(source.id);
    if (prior && prior.recordDigest !== source.recordDigest)
      fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
    sources.set(source.id, source);
  }
  const ids = new Set<string>();
  for (const ref of p.authority.sources) {
    const s = sources.get(ref.id);
    if (
      !s ||
      ids.has(ref.id) ||
      s.recordDigest !== ref.recordDigest ||
      Date.parse(s.reviewedAt) > Date.parse(p.authority.reviewedAt) ||
      Date.parse(s.validUntil) < Date.parse(p.authority.validUntil)
    )
      fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
    ids.add(ref.id);
  }
  const required = [
    ...f.evidence.pricing.sourceIds,
    ...Object.values(f.evidence.omissions).flatMap((x) => x.sourceIds),
    ...Object.values(transmission.omissions).flatMap((x) => x.sourceIds),
  ];
  if (required.some((id) => !ids.has(id))) fail("PUBLIC_COMPARISON_USAGE_POLICY_INVALID");
  assertProviderUsageRateRules(p, scalarPricing(f), f.evidence.context);
  return p;
}
/** As-of-dispatch calculation on the original canonical response. Never consult a current clock. */
export function assessComparisonUsage(input: {
  policy: unknown;
  financialBasis: ComparisonFinancialBasis;
  identity: PublicClaimComparisonRequestIdentity;
  transmission: ComparisonTransmissionBasis;
  environment: "production" | "synthetic-test";
  dispatchedAt: string;
  capture: unknown;
}) {
  const p = validateComparisonUsagePolicy(
    input.policy,
    input.financialBasis,
    input.identity,
    input.transmission,
    input.environment,
    input.dispatchedAt,
  );
  assertPublicComparisonDataOnly(input.capture, 4 * 1024 * 1024);
  const capture = captureProviderResponse(input.capture);
  same(capture, input.capture);
  const f = input.financialBasis;
  const result = assessProviderUsageScalars({
    response: capture,
    policy: p,
    pricing: scalarPricing(f),
    context: f.evidence.context,
    reservedUnits: f.costs.reservedUnits,
    currency: f.costs.currency,
    unitScale: f.costs.unitScale,
    policyDigest: digest(p),
    financialBasisDigest: f.basisDigest,
  });
  if (result.units !== null && !/^(0|[1-9][0-9]{0,29})$/.test(result.units))
    return {
      ...result,
      status: "unknown" as const,
      units: null,
      reasons: [...result.reasons, "COST_UNITS_LIMIT"],
      source: "supplied-usage-assessment" as const,
      owner: null,
      authority: comparisonPlanAuthority,
    };
  return {
    ...result,
    source: "supplied-usage-assessment" as const,
    owner: null,
    authority: comparisonPlanAuthority,
  };
}
