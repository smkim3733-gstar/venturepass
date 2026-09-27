import { describe, expect, it } from "vitest";
import { createProviderContextReservation } from "./studio-plan-quality-provider-reservation";
import { providerTestFinancialInput } from "./studio-plan-quality-provider-test-helpers";
import { providerDigest } from "./studio-plan-quality-provider-core";
import {
  assessProviderUsage,
  captureProviderResponse,
  providerResponseMetadata,
  validateProviderUsagePolicy,
  providerObservationLimits,
  type ProviderUsagePolicy,
} from "../../scripts/local-data-quality-provider-usage.mjs";

function fixture(partitioned = false) {
  const input = providerTestFinancialInput();
  if (partitioned) {
    const pricing = input.pricing as { shortContext: unknown };
    pricing.shortContext = {
      uncachedInput: { units: "3", perTokens: 10 },
      cacheReadInput: { units: "1", perTokens: 10 },
      cacheWriteInput: { units: "5", perTokens: 10 },
      outputIncludingReasoning: { units: "2", perTokens: 10 },
    };
  }
  const basis = createProviderContextReservation(input);
  const policy: ProviderUsagePolicy = {
    schemaVersion: 1,
    kind: "provider-usage-rate-policy",
    provenance: "synthetic-test",
    financialBasisDigest: providerDigest(basis),
    configuredModel: basis.model!,
    responseModels: [basis.model!],
    requestedTier: "default",
    responseTier: "default",
    inputPartition: partitioned
      ? {
          kind: "disjoint-cache",
          aggregate: "input-includes-cache-read-and-write",
          cacheRead: { kind: "field", path: ["input_tokens_details", "cached_tokens"] },
          cacheWrite: { kind: "field", path: ["input_tokens_details", "synthetic_write_tokens"] },
          basis: "명시한 합성 응답의 중복 없는 입력 분류",
        }
      : { kind: "equal-rates", basis: "합성 단일 입력 요율이며 모든 캐시 분류의 요율도 동일" },
    bandSelection: { kind: "short-only", basis: "합성 가격표는 긴 문맥 요율을 적용하지 않음" },
    authority: {
      sourceUrl: "https://example.invalid/synthetic-usage-contract",
      documentDigest: "c".repeat(64),
      reviewedAt: "2026-09-26T01:00:00.000Z",
      validUntil: "2026-09-28T00:00:00.000Z",
      excerpt: "실제 공급자 청구계약이 아닌 합성 시험",
    },
  };
  const response = {
    id: "synthetic-response",
    _request_id: "synthetic-request",
    model: basis.model!,
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 5, synthetic_write_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
    output: [],
  };
  return {
    basis,
    policy,
    response,
    assess: () =>
      assessProviderUsage({ response, policy, financialBasis: basis, phase: "generation" }),
  };
}

describe("v2 provider usage evidence", () => {
  it("preserves tier and every usage detail without credentials or SDK objects", () => {
    const s = fixture(),
      raw = {
        ...s.response,
        headers: { authorization: "forbidden" },
        client: {
          toJSON() {
            throw new Error("no");
          },
        },
      };
    const captured = captureProviderResponse(raw);
    expect(captured).toEqual(s.response);
    expect(captured.usage).not.toBe(raw.usage);
    expect(Object.isFrozen(captured.usage)).toBe(true);
    raw.usage.total_tokens = 999;
    expect(providerResponseMetadata(captured, { configuredModel: s.basis.model! })).toMatchObject({
      responseTier: "default",
      usage: { totalTokens: 30 },
    });
  });
  it("retains malformed output for durable evidence before domain validation", () => {
    const s = fixture();
    expect(captureProviderResponse({ ...s.response, output: null }).output).toBeNull();
    expect(captureProviderResponse({ ...s.response, output: undefined }).output).toBeUndefined();
  });
  it("never evaluates an allowlisted accessor or toJSON", () => {
    let calls = 0;
    const raw = {
      ...fixture().response,
      get usage() {
        calls++;
        return {};
      },
    };
    expect(() => captureProviderResponse(raw)).toThrow();
    expect(calls).toBe(0);
    const usage = {
      toJSON() {
        calls++;
        return {};
      },
    };
    expect(() => captureProviderResponse({ ...fixture().response, usage })).toThrow();
    expect(calls).toBe(0);
  });
  it("rejects cyclic, non-finite and oversized evidence with no truncation", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const usage of [
      circular,
      { x: Infinity },
      { x: BigInt(1) },
      { x: "x".repeat(providerObservationLimits.responseBytes) },
    ])
      expect(() => captureProviderResponse({ ...fixture().response, usage })).toThrow();
  });
  it("uses equal rate proof without fabricating missing cache counts", () => {
    const s = fixture();
    delete (s.response.usage as Partial<typeof s.response.usage>).input_tokens_details;
    const result = s.assess();
    expect(result).toMatchObject({
      status: "known",
      units: "2",
      normalized: { cachedInputTokens: null, cacheWriteInputTokens: null },
    });
  });
  it("uses explicit cache write path and rounds each price component once per request", () => {
    const s = fixture(true);
    expect(s.assess()).toMatchObject({
      status: "known",
      units: "9",
      normalized: {
        inputTokens: 20,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 3,
        reasoningOutputTokens: 2,
      },
    });
  });
  it.each([
    ["model", null],
    ["service_tier", undefined],
    ["service_tier", "flex"],
    ["model", "unapproved-model"],
  ])("retains unknown for unobserved or mismatched %s", (key, value) => {
    const s = fixture();
    Object.assign(s.response, { [key]: value });
    expect(s.assess()).toMatchObject({ status: "unknown", units: null });
  });
  it.each([
    { input_tokens: undefined },
    { output_tokens: undefined },
    { total_tokens: undefined },
    { total_tokens: 31 },
    { input_tokens: -1 },
    { input_tokens: 1.5 },
    { input_tokens_details: { cached_tokens: 21 } },
    { output_tokens_details: { reasoning_tokens: 11 } },
    { output_tokens_details: { reasoning_tokens: null } },
  ])("does not charge guessed totals or inconsistent details %j", (change) => {
    const s = fixture();
    Object.assign(s.response.usage, change);
    expect(s.assess()).toMatchObject({ status: "unknown", units: null });
  });
  it("missing cache write is not zero; explicit zero is observed", () => {
    const s = fixture(true);
    delete (
      s.response.usage.input_tokens_details as Partial<typeof s.response.usage.input_tokens_details>
    ).synthetic_write_tokens;
    expect(s.assess().status).toBe("unknown");
    s.response.usage.input_tokens_details.synthetic_write_tokens = 0;
    expect(s.assess().status).toBe("known");
  });
  it("rejects overlapping cache partitions", () => {
    const s = fixture(true);
    s.response.usage.input_tokens_details.synthetic_write_tokens = 19;
    expect(s.assess()).toMatchObject({
      status: "unknown",
      units: null,
      reasons: ["CACHE_PARTITION_INCONSISTENT"],
    });
  });
  it("preserves known cost despite incomplete status, request limits or reservation excess", () => {
    const s = fixture();
    s.response.status = "incomplete";
    Object.assign(s.response.usage, {
      input_tokens: 1_000_000,
      output_tokens: 32_000,
      total_tokens: 1_032_000,
    });
    const result = s.assess();
    expect(result).toMatchObject({ status: "known", units: "2" });
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "INPUT_LIMIT_EXCEEDED",
        "OUTPUT_LIMIT_EXCEEDED",
        "CONTEXT_LIMIT_EXCEEDED",
      ]),
    );
    s.response.usage.input_tokens = 10_000_000;
    s.response.usage.total_tokens = 10_032_000;
    expect(s.assess()).toMatchObject({
      status: "known",
      units: "11",
      violations: expect.arrayContaining(["RESERVATION_EXCEEDED"]),
    });
  });
  it("chooses long context using only an explicit input threshold", () => {
    const s = fixture(true),
      pricing = s.basis.evidence.pricing!;
    pricing.longContext = {
      ...pricing.shortContext,
      uncachedInput: { units: "10", perTokens: 10 },
    };
    s.policy.financialBasisDigest = providerDigest(s.basis);
    s.policy.bandSelection = {
      kind: "input-threshold",
      threshold: 10,
      basis: "합성 입력20은 경계10초과",
    };
    expect(s.assess()).toMatchObject({ status: "known", units: "17" });
  });
  it.each([
    "digest",
    "model",
    "source",
    "expiry",
    "cache-rate",
    "aggregate-path",
    "duplicate-path",
    "unmapped-band",
  ] as const)("rejects invalid %s policy before transmission", (kind) => {
    const s = fixture(kind === "aggregate-path" || kind === "duplicate-path");
    if (kind === "digest") s.policy.financialBasisDigest = "0".repeat(64);
    if (kind === "model") s.policy.configuredModel = "other";
    if (kind === "source") s.policy.provenance = "official-reviewed";
    if (kind === "expiry") s.policy.authority.validUntil = s.basis.calculatedAt!;
    if (kind === "cache-rate") {
      s.basis.evidence.pricing!.shortContext.cacheWriteInput = { units: "20", perTokens: 1 };
      s.policy.financialBasisDigest = providerDigest(s.basis);
    }
    if (s.policy.inputPartition.kind === "disjoint-cache") {
      if (kind === "aggregate-path")
        s.policy.inputPartition.cacheWrite = { kind: "field", path: ["input_tokens"] };
      if (kind === "duplicate-path")
        s.policy.inputPartition.cacheWrite = s.policy.inputPartition.cacheRead;
    }
    if (kind === "unmapped-band")
      s.policy.bandSelection = {
        kind: "input-threshold",
        threshold: 10,
        basis: "존재하지 않는 합성 긴문맥 가격",
      };
    expect(() => validateProviderUsagePolicy(s.policy, s.basis)).toThrow();
  });
  it("does not mutate policy, response or financial evidence", () => {
    const s = fixture(true),
      before = JSON.stringify(s);
    s.assess();
    expect(JSON.stringify(s)).toBe(before);
  });
});
