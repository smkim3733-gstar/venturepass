import type { z } from "zod";
import type { ProviderContextReservationBasis } from "../src/lib/studio-plan-quality-provider-reservation";
export type ProviderJson =
  null | boolean | number | string | ProviderJson[] | { [key: string]: ProviderJson };
export type ProviderCapturedResponse = Partial<
  Record<
    "id" | "_request_id" | "model" | "status" | "service_tier" | "usage" | "output",
    ProviderJson
  >
>;
type Channel = { kind: "field"; path: string[] } | { kind: "not-applicable"; basis: string };
export type ProviderUsagePolicy = {
  schemaVersion: 1;
  kind: "provider-usage-rate-policy";
  provenance: "synthetic-test" | "official-reviewed";
  financialBasisDigest: string;
  configuredModel: string;
  responseModels: string[];
  requestedTier: "default";
  responseTier: "default";
  inputPartition:
    | { kind: "equal-rates"; basis: string }
    | {
        kind: "disjoint-cache";
        aggregate: "input-includes-cache-read-and-write";
        cacheRead: Channel;
        cacheWrite: Channel;
        basis: string;
      };
  bandSelection:
    | { kind: "short-only"; basis: string }
    | { kind: "input-threshold"; threshold: number; basis: string };
  authority: {
    sourceUrl: string;
    documentDigest: string;
    reviewedAt: string;
    validUntil: string;
    excerpt: string;
  };
};
export type ProviderResponseMetadata = {
  configuredModel: string;
  requestedTier: "default";
  responseId: string | null;
  requestId: string | null;
  responseModel: string | null;
  responseTier: string | null;
  status: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
  };
};
export type ProviderUsageAssessment = {
  status: "known" | "unknown";
  kind: "usage-based-cost";
  units: string | null;
  currency: string | null;
  unitScale: number | null;
  normalized: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    reasoningOutputTokens: number | null;
  } | null;
  reasons: string[];
  violations: string[];
  policyDigest: string;
  financialBasisDigest: string;
};
export const providerUsagePolicySchema: z.ZodType<ProviderUsagePolicy>;
export const providerResponseMetadataSchema: z.ZodType<ProviderResponseMetadata>;
export const providerUsageAssessmentSchema: z.ZodType<ProviderUsageAssessment>;
export const providerObservationLimits: Readonly<{
  requestBytes: number;
  responseBytes: number;
  validatedBytes: number;
  finalBytes: number;
}>;
export function captureProviderResponse(raw: unknown): ProviderCapturedResponse;
export function freezeProviderValue<T>(value: T): T;
export function providerResponseMetadata(
  response: ProviderCapturedResponse,
  input: { configuredModel: string; requestedTier?: "default" },
): ProviderResponseMetadata;
export function validateProviderUsagePolicy(
  policy: ProviderUsagePolicy,
  financialBasis: ProviderContextReservationBasis,
): ProviderUsagePolicy;
export function assessProviderUsage(input: {
  response: ProviderCapturedResponse;
  policy: ProviderUsagePolicy;
  financialBasis: ProviderContextReservationBasis;
  phase: "generation" | "review";
}): ProviderUsageAssessment;
