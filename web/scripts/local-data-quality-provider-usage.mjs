import { z } from "zod";
import { providerDigest } from "./local-data-quality-provider.mjs";

const object = (shape) => z.object(shape).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(2000);
const count = z.number().int().nonnegative().safe().max(1_000_000_000);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const path = z
  .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/))
  .min(1)
  .max(5);
const channel = z.discriminatedUnion("kind", [
  object({ kind: z.literal("field"), path }),
  object({ kind: z.literal("not-applicable"), basis: text }),
]);
export const providerUsagePolicySchema = object({
  schemaVersion: z.literal(1),
  kind: z.literal("provider-usage-rate-policy"),
  provenance: z.enum(["synthetic-test", "official-reviewed"]),
  financialBasisDigest: hash,
  configuredModel: model,
  responseModels: z.array(model).min(1).max(10),
  requestedTier: z.literal("default"),
  responseTier: z.literal("default"),
  inputPartition: z.discriminatedUnion("kind", [
    object({ kind: z.literal("equal-rates"), basis: text }),
    object({
      kind: z.literal("disjoint-cache"),
      aggregate: z.literal("input-includes-cache-read-and-write"),
      cacheRead: channel,
      cacheWrite: channel,
      basis: text,
    }),
  ]),
  bandSelection: z.discriminatedUnion("kind", [
    object({ kind: z.literal("short-only"), basis: text }),
    object({ kind: z.literal("input-threshold"), threshold: count, basis: text }),
  ]),
  authority: object({
    sourceUrl: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return u.protocol === "https:" && !u.username && !u.password && !u.port;
      }),
    documentDigest: hash,
    reviewedAt: z.string().datetime(),
    validUntil: z.string().datetime(),
    excerpt: text,
  }),
});

export const providerResponseMetadataSchema = object({
  configuredModel: model,
  requestedTier: z.literal("default"),
  responseId: z.string().min(1).max(500).nullable(),
  requestId: z.string().min(1).max(500).nullable(),
  responseModel: z.string().min(1).max(200).nullable(),
  responseTier: z.string().min(1).max(100).nullable(),
  status: z.string().min(1).max(100).nullable(),
  usage: object({
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    totalTokens: count.nullable(),
    cachedInputTokens: count.nullable(),
    reasoningOutputTokens: count.nullable(),
  }),
});
const normalized = object({
  inputTokens: count,
  outputTokens: count,
  totalTokens: count,
  cachedInputTokens: count.nullable(),
  cacheWriteInputTokens: count.nullable(),
  reasoningOutputTokens: count.nullable(),
});
export const providerUsageAssessmentSchema = object({
  status: z.enum(["known", "unknown"]),
  kind: z.literal("usage-based-cost"),
  units: z
    .string()
    .regex(/^(0|[1-9]\d{0,79})$/)
    .nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  unitScale: z.number().int().min(0).max(12).nullable(),
  normalized: normalized.nullable(),
  reasons: z.array(z.string().min(1).max(100)).max(20),
  violations: z.array(z.string().min(1).max(100)).max(10),
  policyDigest: hash,
  financialBasisDigest: hash,
});
export const providerObservationLimits = Object.freeze({
  requestBytes: 2 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  validatedBytes: 2 * 1024 * 1024,
  finalBytes: 4 * 1024 * 1024,
});
const own = (value, key) => {
  if (!value || typeof value !== "object") return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) return undefined;
  if (!("value" in d)) throw new Error("PROVIDER_RESPONSE_NOT_JSON");
  return d.value;
};
export function freezeProviderValue(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) freezeProviderValue(v);
    Object.freeze(value);
  }
  return value;
}
/** Copy only allowed SDK JSON synchronously. Never invoke accessors or toJSON. */
export function captureProviderResponse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("PROVIDER_RESPONSE_NOT_JSON");
  let used = 0;
  const ancestors = new Set();
  const add = (n) => {
    used += n;
    if (used > providerObservationLimits.responseBytes)
      throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
  };
  const copy = (value, depth = 0) => {
    if (depth > 100) throw new Error("PROVIDER_RESPONSE_NOT_JSON");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      add(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (!value || typeof value !== "object" || ancestors.has(value))
      throw new Error("PROVIDER_RESPONSE_NOT_JSON");
    const proto = Object.getPrototypeOf(value);
    if (
      (!Array.isArray(value) && proto !== Object.prototype && proto !== null) ||
      Object.getOwnPropertySymbols(value).some(
        (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable,
      )
    )
      throw new Error("PROVIDER_RESPONSE_NOT_JSON");
    ancestors.add(value);
    add(2);
    let out;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error("PROVIDER_RESPONSE_NOT_JSON");
      out = Array.from({ length: value.length }, (_, i) => {
        if (i) add(1);
        return copy(own(value, String(i)), depth + 1);
      });
    } else {
      out = {};
      Object.keys(value).forEach((key, i) => {
        add(Buffer.byteLength(JSON.stringify(key)) + 1 + (i ? 1 : 0));
        Object.defineProperty(out, key, {
          value: copy(own(value, key), depth + 1),
          enumerable: true,
        });
      });
    }
    ancestors.delete(value);
    return out;
  };
  const result = {};
  for (const key of ["id", "_request_id", "model", "status", "service_tier", "usage", "output"]) {
    const value = own(raw, key);
    if (value !== undefined) result[key] = copy(value);
  }
  // Malformed/missing output is still valuable response and cost evidence.
  const body = JSON.stringify({ captureKind: "sdk-response-json-v2", response: result });
  if (Buffer.byteLength(body) > providerObservationLimits.responseBytes)
    throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
  return freezeProviderValue(result);
}
const record = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const number = (v) => (count.safeParse(v).success ? v : null);
const string = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
export function providerResponseMetadata(response, { configuredModel, requestedTier = "default" }) {
  const r = record(response),
    u = record(r.usage);
  return providerResponseMetadataSchema.parse({
    configuredModel,
    requestedTier,
    responseId: string(r.id, 500),
    requestId: string(r._request_id, 500),
    responseModel: string(r.model, 200),
    responseTier: string(r.service_tier, 100),
    status: string(r.status, 100),
    usage: {
      inputTokens: number(u.input_tokens),
      outputTokens: number(u.output_tokens),
      totalTokens: number(u.total_tokens),
      cachedInputTokens: number(record(u.input_tokens_details).cached_tokens),
      reasoningOutputTokens: number(record(u.output_tokens_details).reasoning_tokens),
    },
  });
}
const getPath = (value, keys) => keys.reduce((v, key) => own(v, key), value);
const rateEqual = (a, b) =>
  BigInt(a.units) * BigInt(b.perTokens) === BigInt(b.units) * BigInt(a.perTokens);
const ceil = (tokens, rate) =>
  (BigInt(tokens) * BigInt(rate.units) + BigInt(rate.perTokens) - 1n) / BigInt(rate.perTokens);

/** Validate the complete pinned rate/normalization policy before any transmission. */
export function validateProviderUsagePolicy(raw, financialBasis) {
  const p = providerUsagePolicySchema.parse(raw),
    f = financialBasis;
  const invalid = () => {
    throw new Error("PROVIDER_USAGE_POLICY_INVALID");
  };
  if (
    !f ||
    f.status !== "calculated-for-stated-conditions" ||
    !f.evidence?.pricing ||
    !f.evidence?.context ||
    !f.costs ||
    f.model !== p.configuredModel ||
    f.evidenceMode !== p.provenance ||
    providerDigest(f) !== p.financialBasisDigest ||
    !Number.isFinite(Date.parse(f.calculatedAt)) ||
    Date.parse(p.authority.reviewedAt) > Date.parse(f.calculatedAt) ||
    Date.parse(p.authority.validUntil) <= Date.parse(f.calculatedAt) ||
    new Set(p.responseModels).size !== p.responseModels.length
  )
    invalid();
  if (
    p.provenance === "official-reviewed" &&
    !["openai.com", "www.openai.com", "developers.openai.com", "platform.openai.com"].includes(
      new URL(p.authority.sourceUrl).hostname,
    )
  )
    invalid();
  const pricing = f.evidence.pricing;
  if (
    pricing.rateMeaning !== "all-in-replacement-rates-not-additive-surcharges" ||
    pricing.model !== p.configuredModel ||
    pricing.currency !== f.costs.currency ||
    pricing.unitScale !== f.costs.unitScale
  )
    invalid();
  const bands = [pricing.shortContext];
  if (p.bandSelection.kind === "short-only") {
    if (pricing.longContext.applicability !== "not-applicable") invalid();
  } else {
    if (
      pricing.longContext.applicability === "not-applicable" ||
      p.bandSelection.threshold >= f.evidence.context.contextWindowTokens
    )
      invalid();
    bands.push(pricing.longContext);
  }
  for (const band of bands) {
    if (p.inputPartition.kind === "equal-rates") {
      for (const rate of [band.cacheReadInput, band.cacheWriteInput])
        if (!rate.applicability && !rateEqual(rate, band.uncachedInput)) invalid();
    } else {
      const fields = [];
      for (const [rule, rate] of [
        [p.inputPartition.cacheRead, band.cacheReadInput],
        [p.inputPartition.cacheWrite, band.cacheWriteInput],
      ]) {
        if ((rule.kind === "not-applicable") !== (rate.applicability === "not-applicable"))
          invalid();
        if (rule.kind === "field") {
          if (
            rule.path.some((key) =>
              [
                "__proto__",
                "constructor",
                "prototype",
                "input_tokens",
                "output_tokens",
                "total_tokens",
                "output_tokens_details",
                "reasoning_tokens",
              ].includes(key),
            )
          )
            invalid();
          fields.push(rule.path);
        }
      }
      if (
        fields.length === 2 &&
        fields[0]
          .slice(0, Math.min(fields[0].length, fields[1].length))
          .every((key, i) => key === fields[1][i])
      )
        invalid();
    }
  }
  return p;
}

/** No pricing fetch, token inference, current-clock lookup or billing claim. */
export function assessProviderUsage({ response, policy: rawPolicy, financialBasis, phase }) {
  const policy = validateProviderUsagePolicy(rawPolicy, financialBasis);
  const result = {
    status: "unknown",
    kind: "usage-based-cost",
    units: null,
    currency: financialBasis?.costs?.currency ?? null,
    unitScale: financialBasis?.costs?.unitScale ?? null,
    normalized: null,
    reasons: [],
    violations: [],
    policyDigest: providerDigest(policy),
    financialBasisDigest: providerDigest(financialBasis),
  };
  const unknown = (reason) => {
    result.reasons.push(reason);
    return providerUsageAssessmentSchema.parse(result);
  };
  const f = financialBasis,
    pricing = f?.evidence?.pricing,
    context = f?.evidence?.context;
  if (
    !["generation", "review"].includes(phase) ||
    !pricing ||
    !context ||
    !f.costs ||
    f.status !== "calculated-for-stated-conditions" ||
    f.model !== policy.configuredModel ||
    f.evidenceMode !== policy.provenance ||
    result.financialBasisDigest !== policy.financialBasisDigest ||
    !Number.isFinite(Date.parse(f.calculatedAt)) ||
    Date.parse(policy.authority.reviewedAt) > Date.parse(f.calculatedAt) ||
    Date.parse(policy.authority.validUntil) <= Date.parse(f.calculatedAt) ||
    pricing.rateMeaning !== "all-in-replacement-rates-not-additive-surcharges"
  )
    return unknown("POLICY_SCOPE_MISMATCH");
  const meta = providerResponseMetadata(response, policy);
  if (!meta.responseModel || !policy.responseModels.includes(meta.responseModel))
    return unknown("RESPONSE_MODEL_UNOBSERVED_OR_UNMAPPED");
  if (meta.responseTier !== policy.responseTier)
    return unknown("RESPONSE_TIER_UNOBSERVED_OR_MISMATCHED");
  const u = meta.usage;
  if (u.inputTokens === null || u.outputTokens === null || u.totalTokens === null)
    return unknown("USAGE_TOTALS_UNOBSERVED");
  if (u.inputTokens + u.outputTokens !== u.totalTokens) return unknown("USAGE_TOTALS_INCONSISTENT");
  const rawUsage = record(record(response).usage),
    details = record(rawUsage.input_tokens_details),
    outputDetails = record(rawUsage.output_tokens_details);
  if (
    (Object.hasOwn(details, "cached_tokens") && u.cachedInputTokens === null) ||
    (Object.hasOwn(outputDetails, "reasoning_tokens") && u.reasoningOutputTokens === null) ||
    (u.cachedInputTokens !== null && u.cachedInputTokens > u.inputTokens) ||
    (u.reasoningOutputTokens !== null && u.reasoningOutputTokens > u.outputTokens)
  )
    return unknown("USAGE_DETAILS_INCONSISTENT");
  let band;
  if (policy.bandSelection.kind === "short-only") {
    if (pricing.longContext.applicability !== "not-applicable")
      return unknown("CONTEXT_RATE_RULE_MISSING");
    band = pricing.shortContext;
  } else {
    if (pricing.longContext.applicability === "not-applicable")
      return unknown("CONTEXT_RATE_RULE_MISMATCHED");
    band =
      u.inputTokens > policy.bandSelection.threshold ? pricing.longContext : pricing.shortContext;
  }
  let inputCost = 0n,
    read = u.cachedInputTokens,
    write = null;
  if (policy.inputPartition.kind === "equal-rates") {
    if (
      u.cachedInputTokens !== null &&
      u.cachedInputTokens > 0 &&
      band.cacheReadInput.applicability === "not-applicable"
    )
      return unknown("CACHE_COUNTS_UNOBSERVED_OR_RULE_MISMATCHED");
    const rates = [band.uncachedInput, band.cacheReadInput, band.cacheWriteInput].filter(
      (r) => !r.applicability,
    );
    if (rates.some((r) => !rateEqual(r, band.uncachedInput)))
      return unknown("CACHE_CLASSIFICATION_REQUIRED");
    inputCost = ceil(u.inputTokens, band.uncachedInput);
  } else {
    const partition = policy.inputPartition;
    if (
      partition.cacheRead.kind === "field" &&
      partition.cacheWrite.kind === "field" &&
      providerDigest(partition.cacheRead.path) === providerDigest(partition.cacheWrite.path)
    )
      return unknown("CACHE_PATHS_OVERLAP");
    const channelCount = (rule, rate) => {
      if (rule.kind === "not-applicable") return rate.applicability === "not-applicable" ? 0 : null;
      if (rate.applicability === "not-applicable") return null;
      return number(getPath(rawUsage, rule.path));
    };
    read = channelCount(partition.cacheRead, band.cacheReadInput);
    write = channelCount(partition.cacheWrite, band.cacheWriteInput);
    if (read === null || write === null)
      return unknown("CACHE_COUNTS_UNOBSERVED_OR_RULE_MISMATCHED");
    if (
      read + write > u.inputTokens ||
      (u.cachedInputTokens !== null && read !== u.cachedInputTokens)
    )
      return unknown("CACHE_PARTITION_INCONSISTENT");
    inputCost =
      ceil(u.inputTokens - read - write, band.uncachedInput) +
      (read ? ceil(read, band.cacheReadInput) : 0n) +
      (write ? ceil(write, band.cacheWriteInput) : 0n);
  }
  result.normalized = { ...u, cacheWriteInputTokens: write, cachedInputTokens: read };
  const cost = inputCost + ceil(u.outputTokens, band.outputIncludingReasoning);
  result.status = "known";
  result.units = cost.toString();
  if (u.inputTokens > context.contextWindowTokens) result.violations.push("INPUT_LIMIT_EXCEEDED");
  if (u.outputTokens > 16000 || u.outputTokens > context.maxOutputTokens)
    result.violations.push("OUTPUT_LIMIT_EXCEEDED");
  if (u.totalTokens > context.contextWindowTokens) result.violations.push("CONTEXT_LIMIT_EXCEEDED");
  if (cost > BigInt(f.costs[phase].totalUnits)) result.violations.push("RESERVATION_EXCEEDED");
  return providerUsageAssessmentSchema.parse(result);
}
