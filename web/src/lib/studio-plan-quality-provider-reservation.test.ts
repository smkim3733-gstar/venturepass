import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderContextReservation,
  type ProviderContextReservationInput,
  type ProviderReservationConditions,
  type ProviderReservationContext,
  type ProviderReservationPricing,
} from "./studio-plan-quality-provider-reservation";

const forbidden = vi.fn(() => {
  throw new Error("No IO in financial basis calculator");
});
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function fixture() {
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
    sourceUrl: "https://example.invalid/synthetic-only",
    documentDigest: "a".repeat(64),
    retrievedAt: "2026-09-26T00:00:00.000Z",
    reviewedAt: "2026-09-26T01:00:00.000Z",
    validUntil: "2026-09-28T00:00:00.000Z",
    freshnessPolicy: "합성 계산 시험의 내부 최신성 기한",
    reviewerId: "synthetic-reviewer",
    excerpt: "실제 모델이나 가격을 뜻하지 않는 합성 시험값입니다.",
  };
  const base = {
    model: "synthetic-context-model",
    provenance: "synthetic-test" as const,
    conditions,
    authority,
  };
  const context: ProviderReservationContext = {
    ...structuredClone(base),
    contextWindowTokens: 10,
    maxOutputTokens: 4,
    contextCoverage: "input-plus-output-including-reasoning",
  };
  const pricing: ProviderReservationPricing = {
    ...structuredClone(base),
    currency: "TST",
    unitScale: 6,
    rateMeaning: "all-in-replacement-rates-not-additive-surcharges",
    shortContext: {
      uncachedInput: { units: "3", perTokens: 2 },
      cacheReadInput: { units: "9", perTokens: 1000 },
      cacheWriteInput: { units: "2", perTokens: 1 },
      outputIncludingReasoning: { units: "7", perTokens: 3 },
    },
    longContext: {
      uncachedInput: { units: "4", perTokens: 3 },
      cacheReadInput: { units: "1", perTokens: 1 },
      cacheWriteInput: { units: "11", perTokens: 4 },
      outputIncludingReasoning: { units: "5", perTokens: 3 },
    },
    additionalCharges: {
      applicability: "none-under-stated-conditions",
      explanation: "합성 시험 조건에 별도 가산 없음",
    },
  };
  return {
    evidenceMode: "synthetic-test" as const,
    model: base.model,
    calculatedAt: "2026-09-27T03:00:00.000Z",
    outputReservationTokens: 3,
    conditions: structuredClone(conditions),
    context,
    pricing,
  };
}
function expectBlocked(value: ProviderContextReservationInput, code: string) {
  const result = createProviderContextReservation(value);
  expect(result.status).toBe("blocked");
  expect(result.costs).toBeNull();
  expect(result.blockers.map((item) => item.code)).toContain(code);
  expect(Object.values(result.authority).every((value) => value === false)).toBe(true);
}

describe("separate context-based financial reservation basis", () => {
  it("requires all-in cache write rates and refuses additive surcharge inputs", () => {
    const input = fixture();
    input.pricing.longContext = {
      applicability: "not-applicable",
      explanation: "합성 동일 문맥 요율",
    };
    input.pricing.shortContext.uncachedInput = { units: "2", perTokens: 1 };
    input.pricing.shortContext.cacheWriteInput = { units: "3", perTokens: 1 };
    const result = createProviderContextReservation(input);
    expect(result.costs!.maximumInputRate.selectedFrom).toBe("shortContext.cacheWriteInput");
    expect(result.costs!.generation.inputUnits).toBe("30");
    expectBlocked(
      { ...input, pricing: { ...input.pricing, rateMeaning: "additive-write-surcharge" } },
      "PRICING_INVALID",
    );
  });
  it("uses full C and separate O, maximum fractional rates, and two per-request ceilings without claiming fit", () => {
    const input = fixture(),
      before = structuredClone(input),
      result = createProviderContextReservation(input);
    expect(result.status).toBe("calculated-for-stated-conditions");
    expect(result.costs).toMatchObject({
      maximumInputRate: { selectedFrom: "longContext.cacheWriteInput" },
      maximumOutputRate: { selectedFrom: "shortContext.outputIncludingReasoning" },
      generation: {
        inputTokensReserved: 10,
        outputTokensReserved: 3,
        inputUnits: "28",
        outputUnits: "7",
        totalUnits: "35",
      },
      review: { inputUnits: "28", outputUnits: "7", totalUnits: "35" },
      totalUnits: "70",
    });
    expect(10 + 3).toBeGreaterThan(input.context.contextWindowTokens);
    expect(result).toMatchObject({
      schemaVersion: 2,
      kind: "provider-context-financial-reservation-basis",
      maxCalls: 2,
      retries: 0,
      unobservedCostPolicy: "retain-reservation-no-automatic-retry",
    });
    expect(Object.values(result.authority).every((value) => value === false)).toBe(true);
    expect(input).toEqual(before);
  });
  it("rounds input and output separately for each request instead of rounding combined costs", () => {
    const input = fixture();
    input.context.contextWindowTokens = 1;
    input.context.maxOutputTokens = 1;
    input.outputReservationTokens = 1;
    input.pricing.longContext = {
      applicability: "not-applicable",
      explanation: "합성 시험에 별도 문맥 요율 없음",
    };
    input.pricing.shortContext = {
      uncachedInput: { units: "1", perTokens: 3 },
      cacheReadInput: { units: "1", perTokens: 3 },
      cacheWriteInput: { units: "1", perTokens: 3 },
      outputIncludingReasoning: { units: "1", perTokens: 3 },
    };
    expect(createProviderContextReservation(input).costs).toMatchObject({
      generation: { inputUnits: "1", outputUnits: "1", totalUnits: "2" },
      review: { totalUnits: "2" },
      totalUnits: "4",
    });
  });
  it("compares rational rates without floating point or inconsistent token denominators", () => {
    const input = fixture();
    input.pricing.shortContext.uncachedInput = { units: "9007199254740993", perTokens: 7 };
    const result = createProviderContextReservation(input);
    expect(result.costs!.maximumInputRate.selectedFrom).toBe("shortContext.uncachedInput");
    expect(result.costs!.generation.inputUnits).toBe("12867427506772848");
  });
  it("distinguishes reviewed zero rates from missing rates without granting execution readiness", () => {
    const input = fixture();
    input.pricing.longContext = { applicability: "not-applicable", explanation: "합성 동일 요율" };
    input.pricing.shortContext = {
      uncachedInput: { units: "0", perTokens: 1 },
      cacheReadInput: { units: "0", perTokens: 1 },
      cacheWriteInput: { units: "0", perTokens: 1 },
      outputIncludingReasoning: { units: "0", perTokens: 1 },
    };
    const result = createProviderContextReservation(input);
    expect(result.costs!.totalUnits).toBe("0");
    expect(result.authority.executionReady).toBe(false);
    expectBlocked(
      {
        ...input,
        pricing: {
          ...input.pricing,
          shortContext: { ...input.pricing.shortContext, cacheWriteInput: null },
        },
      },
      "PRICING_INVALID",
    );
  });
  it("accepts an explicitly evidenced non-applicable cache channel without adding a separate surcharge", () => {
    const input = fixture();
    input.pricing.longContext = {
      applicability: "not-applicable",
      explanation: "별도 장문 요율 없는 합성 조건",
    };
    input.pricing.shortContext.cacheWriteInput = {
      applicability: "not-applicable",
      explanation: "합성 기본 입력 요율에 포함됨",
    };
    input.pricing.shortContext.cacheReadInput = {
      applicability: "not-applicable",
      explanation: "합성 조건에 캐시 읽기 없음",
    };
    const result = createProviderContextReservation(input);
    expect(result.costs!.generation.inputUnits).toBe("15");
    expect(result.costs!.totalUnits).toBe("44");
  });
  it.each(["context", "pricing"] as const)(
    "keeps missing %s blocked rather than treating it as free",
    (key) => {
      expectBlocked(
        { ...fixture(), [key]: null },
        key === "context" ? "CONTEXT_MISSING" : "PRICING_MISSING",
      );
    },
  );
  it("requires an explicit model and never chooses a provider default", () =>
    expectBlocked({ ...fixture(), model: null }, "MODEL_REQUIRED"));
  it.each(["context", "pricing"] as const)("rejects a different model in %s evidence", (key) => {
    const input = fixture();
    input[key].model = "different-model";
    expectBlocked(input, "EVIDENCE_SCOPE_MISMATCH");
  });
  it("cannot relabel synthetic evidence as official", () =>
    expectBlocked({ ...fixture(), evidenceMode: "official-reviewed" }, "EVIDENCE_SCOPE_MISMATCH"));
  it.each(["https://openai.com.evil.invalid/pricing", "https://example.invalid/pricing"])(
    "requires exact official source host: %s",
    (url) => {
      const input = fixture();
      const official = {
        ...input,
        evidenceMode: "official-reviewed" as const,
        context: {
          ...input.context,
          provenance: "official-reviewed" as const,
          authority: { ...input.context.authority, sourceUrl: url },
        },
        pricing: {
          ...input.pricing,
          provenance: "official-reviewed" as const,
          authority: { ...input.pricing.authority, sourceUrl: url },
        },
      };
      expectBlocked(official, "OFFICIAL_SOURCE_REQUIRED");
    },
  );
  it("labels caller-supplied official evidence as unverified even when its host is official", () => {
    const input = fixture();
    const result = createProviderContextReservation({
      ...input,
      evidenceMode: "official-reviewed",
      context: {
        ...input.context,
        provenance: "official-reviewed",
        authority: {
          ...input.context.authority,
          sourceUrl: "https://developers.openai.com/api/docs/models/synthetic-fixture",
        },
      },
      pricing: {
        ...input.pricing,
        provenance: "official-reviewed",
        authority: { ...input.pricing.authority, sourceUrl: "https://openai.com/api/pricing/" },
      },
    });
    expect(result.status).toBe("calculated-for-stated-conditions");
    expect(result.authority.sourceAuthenticityIndependentlyVerified).toBe(false);
    expect(result.authority.providerFailureChargeBoundVerified).toBe(false);
  });
  it.each([
    ["retrievedAt", "2026-09-27T04:00:00.000Z"],
    ["reviewedAt", "2026-09-27T04:00:00.000Z"],
    ["validUntil", "2026-09-27T03:00:00.000Z"],
    ["validUntil", "2026-09-25T03:00:00.000Z"],
  ] as const)("rejects invalid evidence chronology %s=%s", (key, value) => {
    const input = fixture();
    input.pricing.authority[key] = value;
    expectBlocked(input, "EVIDENCE_TIME_INVALID");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric output bound %s",
    (outputReservationTokens) =>
      expectBlocked({ ...fixture(), outputReservationTokens }, "INVALID_INPUT"),
  );
  it("rejects an output reservation above the official output limit", () =>
    expectBlocked({ ...fixture(), outputReservationTokens: 5 }, "OUTPUT_LIMIT_EXCEEDED"));
  it("rejects inconsistent official context and output maxima", () => {
    const input = fixture();
    input.context.maxOutputTokens = 11;
    expectBlocked(input, "OUTPUT_LIMIT_EXCEEDED");
  });
  it.each(["-1", "1.25", "01", "", "9".repeat(41)])(
    "rejects ambiguous or overflowing rate units %s",
    (units) => {
      const input = fixture();
      input.pricing.shortContext.uncachedInput.units = units;
      expectBlocked(input, "PRICING_INVALID");
    },
  );
  it.each([
    ["serviceTier", "flex"],
    ["destination", "regional"],
    ["truncation", "auto"],
    ["store", true],
    ["tools", "web_search"],
    ["modality", "image"],
    ["maxCalls", 3],
    ["retries", 1],
    ["tokenCountingEndpoint", "responses/input_tokens"],
    ["previousResponse", "response-id"],
    ["conversation", "conversation-id"],
    ["compaction", "automatic"],
    ["background", true],
    ["stream", true],
  ])("rejects a different request condition %s", (key, value) => {
    const input = fixture();
    expectBlocked(
      { ...input, conditions: { ...input.conditions, [key as string]: value } },
      "INVALID_INPUT",
    );
  });
  it("requires all context/cache rates and explicit explanations for non-applicability", () => {
    const input = fixture();
    expectBlocked(
      { ...input, pricing: { ...input.pricing, longContext: null } },
      "PRICING_INVALID",
    );
    expectBlocked(
      {
        ...input,
        pricing: {
          ...input.pricing,
          longContext: { applicability: "not-applicable", explanation: " " },
        },
      },
      "PRICING_INVALID",
    );
  });
});
