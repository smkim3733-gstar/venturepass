import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-ai", () => ({ getAiStatus: forbidden }));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden }));
import {
  createCandidateRegistrySource,
  candidateRegistryVersionDigest,
} from "./studio-plan-quality-candidate-registry";
import {
  candidateRegistryNotice,
  type CandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry-types";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  createQualityActualPreparation,
  inspectQualityActualTokens,
  validateQualityActualPreparation,
  type QualityActualPreparationInput,
} from "./studio-plan-quality-actual-preparation";
import {
  qualityActualPreparationDigestInput,
  qualityActualPreparationSchema,
  qualityActualRequestEvidenceDigestInput,
  type QualityActualBudget,
  type QualityActualPrice,
  type QualityActualTokens,
} from "./studio-plan-quality-actual-types";

const now = "2026-09-27T03:00:00.000Z";
const model = "synthetic-test-model-001";
const payload: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
  ...createCandidateRegistrySource(),
  kind: "validation-candidate-set" as const,
  version: 1,
  previousVersion: null,
  previousDigest: null,
  registeredAt: "2026-09-26T03:00:00.000Z",
  clientRequestId: "a75c8462-dc84-4d32-b743-da6581f2f4dd",
  notice: candidateRegistryNotice,
};
const registry: CandidateRegistrySnapshot = {
  ...payload,
  versionDigest: candidateRegistryVersionDigest(payload),
};
const authority = {
  sourceUrl: "https://example.invalid/synthetic-pricing-not-a-provider",
  documentDigest: digest({ synthetic: "not real pricing" }),
  retrievedAt: "2026-09-26T00:00:00.000Z",
  reviewedAt: "2026-09-26T01:00:00.000Z",
  validFrom: "2026-09-26T00:00:00.000Z",
  validUntil: "2026-09-28T00:00:00.000Z",
  reviewerId: "synthetic-reviewer",
  excerpt: "합성 계산 시험값이며 실제 공급자 가격이 아닙니다.",
  applicability: "합성모델/합성API/할인없음/전체출력/추가요금없음",
  validityPolicy: "시험용 고정 구간",
};
function base(): QualityActualPreparationInput {
  return {
    registry: structuredClone(registry),
    candidateId: registry.entries[0].candidateId,
    model,
    preparedAt: now,
    price: null,
    tokens: null,
    budget: null,
  };
}
function configured() {
  const input = base();
  const preview = createQualityActualPreparation(input);
  const evidence = preview.requestEvidence!;
  const price: QualityActualPrice = {
    provenance: "synthetic-test",
    provider: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model,
    authority: structuredClone(authority),
    currency: "TST",
    unitScale: 6,
    inputRate: { units: "7", perTokens: 3 },
    outputRate: { units: "11", perTokens: 7000 },
    cachePolicy: "undiscounted",
    outputCoverage: "all-output-including-reasoning",
    additionalCharges: { kind: "bounded-per-request", units: "2" },
  };
  const tokens: QualityActualTokens = {
    provenance: "synthetic-test",
    provider: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model,
    authority: structuredClone(authority),
    tokenizerId: "synthetic-bound",
    tokenizerVersion: "test-v1",
    contractDigest: preview.engine.contractDigest,
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
      inputUpperBound: 13,
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
    currency: "TST",
    unitScale: 6,
    capUnits: "118",
    unsettledUnits: "7",
    observedAt: now,
    validUntil: "2026-09-27T03:10:00.000Z",
    scope: "candidate-quality-executions",
    ledgerDigest: digest({ synthetic: "unsettled seven" }),
  };
  return { ...input, environment: "synthetic-test" as const, price, tokens, budget };
}
const codes = (input: QualityActualPreparationInput) =>
  createQualityActualPreparation(input).blockers.map((item) => item.code);
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("actual AI preparation inspection, no execution", () => {
  it("keeps model, price, tokens and budget genuinely unknown by default", () => {
    const actual = createQualityActualPreparation({ ...base(), model: null });
    expect(actual.blockers.map((item) => item.code)).toEqual([
      "MODEL_NOT_SELECTED",
      "PRICE_NOT_CONFIGURED",
      "TOKEN_BOUND_NOT_CONFIGURED",
      "BUDGET_NOT_CONFIGURED",
    ]);
    expect(actual.requestEvidence).toBeNull();
    expect(actual.costs).toBeNull();
    expect(actual.executionAllowed).toBe(false);
    expect(actual.approvalRecorded).toBe(false);
    expect(actual.reservationRecorded).toBe(false);
    expect(actual.executionBlocks).toHaveLength(2);
  });
  it("pins exact registered generation JSON and incomplete review derivation, not author hints", () => {
    const input = base(),
      before = structuredClone(input);
    const actual = createQualityActualPreparation(input),
      evidence = actual.requestEvidence!;
    expect(input).toEqual(before);
    expect(actual.scope.versionDigest).toBe(registry.versionDigest);
    expect(evidence.generation.body.model).toBe(model);
    expect(evidence.generation.body.input.map((item) => item.role)).toEqual(["system", "user"]);
    expect(evidence.generation.body.text.format.name).toBe("business_plan");
    expect(evidence.reviewTemplate).toMatchObject({
      complete: false,
      phase: "review",
      draftSlot: {
        requiresValidatedEventBinding: true,
        rule: "this-run-validated-generation-only",
      },
    });
    expect(evidence.reviewTemplate).not.toHaveProperty("requestDigest");
    expect(evidence.reviewTemplate.fixedUserContext).not.toHaveProperty("draft");
    const body = JSON.stringify(evidence);
    expect(body).not.toContain('"authoringNotes"');
    expect(body).not.toContain('"challengeTags"');
    expect(body).not.toContain('"reviewerMetadata"');
    expect(actual.engine).toMatchObject({ maxCalls: 2, repair: false, maxRetries: 0 });
    expect(actual.humanAnswerKey).toBeNull();
    expect(actual.performanceEvaluation).toBe("not-performed");
    expect(actual.independentHoldoutConfirmed).toBe(false);
  });
  it("calculates each rate with exact upward rounding including uncertain earlier costs", () => {
    const actual = createQualityActualPreparation(configured());
    // ceil(10*7/3)+ceil(16000*11/7000)+2=52; review=31+26+2=59; old unknown=7.
    expect(actual.costs).toEqual({
      currency: "TST",
      unitScale: 6,
      generationUnits: "52",
      reviewUnits: "59",
      unsettledUnits: "7",
      totalUnits: "118",
      budgetUnits: "118",
      rounding: "ceil-each-rate-per-request",
      meaning: "unreserved-upper-bound-not-a-bill",
    });
    expect(actual.readiness).toBe("calculation-ready");
    expect(actual.executionAllowed).toBe(false);
    expect(actual.reservationRecorded).toBe(false);
  });
  it("blocks one-unit budget excess and never drops the unsettled reservation", () => {
    const input = configured();
    input.budget.capUnits = "117";
    const actual = createQualityActualPreparation(input);
    expect(actual.blockers.map((item) => item.code)).toContain("BUDGET_EXCEEDED");
    expect(actual.costs?.totalUnits).toBe("118");
    expect(actual.readiness).toBe("blocked");
  });
  it("supports amounts beyond Number precision without changing units", () => {
    const input = configured();
    input.price.inputRate = { units: "9007199254740993", perTokens: 1 };
    input.price.outputRate.units = "0";
    input.price.additionalCharges = { kind: "none-verified" };
    input.budget.capUnits = "999999999999999999999999999999";
    expect(createQualityActualPreparation(input).costs?.totalUnits).toBe(
      (BigInt("9007199254740993") * BigInt(23) + BigInt(7)).toString(),
    );
  });
  it("forbids synthetic prices and token bounds from entering production-ready costs", () => {
    const input = configured(),
      actual = createQualityActualPreparation({ ...input, environment: "production" });
    expect(actual.readiness).toBe("blocked");
    expect(actual.costs).toBeNull();
    expect(actual.blockers.map((item) => item.code)).toContain("SYNTHETIC_EVIDENCE_FORBIDDEN");
    expect(actual.evidence.price?.provenance).toBe("synthetic-test");
  });
  it.each(["price", "tokens", "budget"] as const)(
    "rejects even one synthetic %s in production",
    (field) => {
      const input = configured();
      input.price.provenance = "official-reviewed";
      input.tokens.provenance = "model-tokenizer-reviewed";
      input.budget.provenance = "reviewed-budget";
      input[field].provenance = "synthetic-test";
      expect(codes({ ...input, environment: "production" })).toContain(
        "SYNTHETIC_EVIDENCE_FORBIDDEN",
      );
    },
  );
  it.each([
    [
      "missing rate unit",
      (input: ReturnType<typeof configured>) => {
        input.price.inputRate.perTokens = 0;
      },
      "PRICE_INVALID",
    ],
    [
      "discount assumption",
      (input: ReturnType<typeof configured>) => {
        Object.assign(input.price, { cachePolicy: "assume-cached" });
      },
      "PRICE_INVALID",
    ],
    [
      "unknown extra fee",
      (input: ReturnType<typeof configured>) => {
        Object.assign(input.price, { additionalCharges: { kind: "unknown" } });
      },
      "PRICE_INVALID",
    ],
    [
      "wrong price model",
      (input: ReturnType<typeof configured>) => {
        input.price.model = "another-model";
      },
      "PRICE_SCOPE_MISMATCH",
    ],
    [
      "stale price",
      (input: ReturnType<typeof configured>) => {
        input.price.authority.validUntil = now;
      },
      "PRICE_OUTDATED",
    ],
    [
      "future retrieval",
      (input: ReturnType<typeof configured>) => {
        input.price.authority.retrievedAt = "2026-09-29T00:00:00.000Z";
      },
      "PRICE_OUTDATED",
    ],
    [
      "wrong currency",
      (input: ReturnType<typeof configured>) => {
        input.budget.currency = "USD";
      },
      "BUDGET_SCOPE_MISMATCH",
    ],
    [
      "wrong scale",
      (input: ReturnType<typeof configured>) => {
        input.budget.unitScale = 3;
      },
      "BUDGET_SCOPE_MISMATCH",
    ],
    [
      "stale budget",
      (input: ReturnType<typeof configured>) => {
        input.budget.validUntil = now;
      },
      "BUDGET_INVALID",
    ],
    [
      "negative unknown costs",
      (input: ReturnType<typeof configured>) => {
        input.budget.unsettledUnits = "-1";
      },
      "BUDGET_INVALID",
    ],
  ])("blocks %s", (_title, mutate, code) => {
    const input = configured();
    (mutate as (value: ReturnType<typeof configured>) => void)(input);
    expect(codes(input)).toContain(code);
    expect(createQualityActualPreparation(input).costs).toBeNull();
  });
  it.each([
    "system",
    "user",
    "structuredOutputSchema",
    "messageFraming",
    "providerOverhead",
  ] as const)("requires token coverage for %s", (field) => {
    const input = configured();
    Object.assign(input.tokens.coverage, { [field]: false });
    expect(codes(input)).toContain("TOKEN_BOUND_INVALID");
  });
  it.each([
    [
      "token model",
      (input: ReturnType<typeof configured>) => {
        input.tokens.model = "wrong-model";
      },
      "TOKEN_SCOPE_MISMATCH",
    ],
    [
      "generation body",
      (input: ReturnType<typeof configured>) => {
        input.tokens.generation.requestDigest = "a".repeat(64);
      },
      "TOKEN_SCOPE_MISMATCH",
    ],
    [
      "review template",
      (input: ReturnType<typeof configured>) => {
        input.tokens.review.templateDigest = "b".repeat(64);
      },
      "TOKEN_SCOPE_MISMATCH",
    ],
    [
      "engine",
      (input: ReturnType<typeof configured>) => {
        input.tokens.contractDigest = "c".repeat(64);
      },
      "TOKEN_SCOPE_MISMATCH",
    ],
    [
      "input limit",
      (input: ReturnType<typeof configured>) => {
        input.tokens.maxInputTokens = 12;
      },
      "TOKEN_LIMIT_EXCEEDED",
    ],
    [
      "output limit",
      (input: ReturnType<typeof configured>) => {
        input.tokens.maxOutputTokens = 15999;
      },
      "TOKEN_LIMIT_EXCEEDED",
    ],
    [
      "context limit",
      (input: ReturnType<typeof configured>) => {
        input.tokens.contextWindowTokens = 16012;
      },
      "TOKEN_LIMIT_EXCEEDED",
    ],
    [
      "expired tokenizer",
      (input: ReturnType<typeof configured>) => {
        input.tokens.authority.validUntil = now;
      },
      "TOKEN_EVIDENCE_OUTDATED",
    ],
    [
      "draft serialization",
      (input: ReturnType<typeof configured>) => {
        Object.assign(input.tokens.review, { includesDraftSerialization: false });
      },
      "TOKEN_BOUND_INVALID",
    ],
  ])("rejects mismatched %s", (_title, mutate, code) => {
    const input = configured();
    (mutate as (value: ReturnType<typeof configured>) => void)(input);
    expect(codes(input)).toContain(code);
  });
  it("passes complete structured input to an isolated synthetic token adapter", () => {
    const input = configured(),
      evidence = createQualityActualPreparation(input).requestEvidence!;
    const before = structuredClone(evidence);
    const tokens = inspectQualityActualTokens(evidence, (received) => {
      expect(received.requestEvidence.generation.body.text.format.schema).toHaveProperty(
        "properties",
      );
      expect(received.requestEvidence.reviewTemplate.draftSlot.requiresValidatedEventBinding).toBe(
        true,
      );
      received.requestEvidence.generation.body.input[0].content = "adapter mutation";
      return input.tokens;
    });
    expect(evidence).toEqual(before);
    expect(tokens).toEqual(input.tokens);
  });
  it("revalidates exact pinned inputs, not only caller-resealed hashes", () => {
    const input = configured(),
      actual = createQualityActualPreparation(input);
    expect(validateQualityActualPreparation(actual, input)).toEqual(actual);
    const edited = structuredClone(actual);
    edited.requestEvidence!.generation.body.input[1].content = "different supplied content";
    edited.requestEvidence!.generation.requestDigest = digest(
      edited.requestEvidence!.generation.body,
    );
    edited.requestEvidence!.evidenceDigest = digest(
      qualityActualRequestEvidenceDigestInput(edited.requestEvidence!),
    );
    edited.preparationDigest = digest(qualityActualPreparationDigestInput(edited));
    expect(() => validateQualityActualPreparation(edited, input)).toThrow(/binding mismatch/);
  });
  it("rejects current model/candidate/engine changes and tampered registered content", () => {
    const input = base(),
      actual = createQualityActualPreparation(input);
    expect(() =>
      validateQualityActualPreparation(actual, { ...input, model: "different-model" }),
    ).toThrow();
    expect(() =>
      validateQualityActualPreparation(actual, {
        ...input,
        candidateId: registry.entries[1].candidateId,
      }),
    ).toThrow();
    const changed = structuredClone(actual);
    changed.engine.contractDigest = "a".repeat(64);
    changed.preparationDigest = digest(qualityActualPreparationDigestInput(changed));
    expect(() => validateQualityActualPreparation(changed, input)).toThrow();
    input.registry.entries[0].input.sources[0].text = "edited after registration";
    expect(() => createQualityActualPreparation(input)).toThrow();
  });
  it("keeps exact preview JSON and evidence excerpts in the digest without recording approval", () => {
    const input = configured(),
      first = createQualityActualPreparation(input);
    expect(JSON.stringify(createQualityActualPreparation(input))).toBe(JSON.stringify(first));
    input.price.authority.excerpt += " extra condition";
    expect(createQualityActualPreparation(input).preparationDigest).not.toBe(
      first.preparationDigest,
    );
    expect(() =>
      qualityActualPreparationSchema.parse({ ...first, executionAllowed: true }),
    ).toThrow();
    expect(() =>
      qualityActualPreparationSchema.parse({ ...first, approvalRecorded: true }),
    ).toThrow();
    expect(() =>
      qualityActualPreparationSchema.parse({ ...first, reservationRecorded: true }),
    ).toThrow();
    expect(() =>
      qualityActualPreparationSchema.parse({ ...first, environment: "production" }),
    ).toThrow();
  });
  it.each([" model", "model ", "", "model/alias", "한글모델"])(
    "does not normalize an unapproved model %s",
    (value) => {
      expect(() => createQualityActualPreparation({ ...base(), model: value })).toThrow();
    },
  );
});
