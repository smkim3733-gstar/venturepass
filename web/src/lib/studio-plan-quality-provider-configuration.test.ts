import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { createProviderRequestReview } from "./studio-plan-quality-provider-core";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { createProviderContextReservation } from "./studio-plan-quality-provider-reservation";
import {
  getProviderConfigurationProposal,
  createProviderConfigurationProposalView,
  getProviderConfigurationExpiry,
} from "./studio-plan-quality-provider-configuration";
import {
  providerConfigurationDigestInput,
  providerProposalConfigurationDigestInput,
  providerProposalSourceDigestInput,
  providerReviewDigestInput,
  providerReviewViewSchema,
  type ProviderConfigurationProposal,
} from "./studio-plan-quality-provider-review-types";

const now = "2026-09-26T23:58:00.000Z";
const registry = actualTestRegistry();
const input = () => ({
  registry,
  candidateId: registry.entries[0].candidateId,
  inspectedAt: now,
  configuration: getProviderConfigurationProposal(),
});
const forbidden = vi.fn(() => {
  throw new Error("No external IO or keys");
});
let originalEnvironment: NodeJS.ProcessEnv;
beforeEach(() => {
  vi.stubGlobal("fetch", forbidden);
  originalEnvironment = process.env;
  process.env = new Proxy(originalEnvironment, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(OPENAI|VENTURE_DATA_DIR)/.test(key)) return forbidden();
      return Reflect.get(target, key, receiver);
    },
  });
});
afterEach(() => {
  process.env = originalEnvironment;
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function config() {
  const value = getProviderConfigurationProposal();
  if (!value) throw new Error("fixed proposal missing");
  return value;
}
function rehash(value: ProviderConfigurationProposal) {
  value.configurationDigest = digest(providerConfigurationDigestInput(value));
  return value;
}
function changed(change: (value: ProviderConfigurationProposal) => void) {
  const value = config();
  change(value);
  return createProviderConfigurationProposalView({ ...input(), configuration: rehash(value) });
}

describe("server-fixed official evidence proposal", () => {
  it("diagnoses the exact internal deadline without turning old evidence into a current proposal", () => {
    const configuration = config();
    const before = JSON.stringify(configuration);
    const validUntil = configuration.sources[0].validUntil;
    expect(getProviderConfigurationExpiry(input())).toBeNull();
    expect(getProviderConfigurationExpiry({ ...input(), inspectedAt: "invalid" })).toBeNull();
    for (const inspectedAt of [validUntil, "2030-01-01T00:00:00.000Z"]) {
      expect(getProviderConfigurationExpiry({ ...input(), configuration, inspectedAt })).toEqual({
        configurationDigest: configuration.configurationDigest,
        validUntil,
      });
      expect(
        createProviderConfigurationProposalView({ ...input(), configuration, inspectedAt }),
      ).toBeNull();
    }
    expect(JSON.stringify(configuration)).toBe(before);
  });
  it("uses the earliest source deadline and rejects evidence with no shared valid review time", () => {
    const configuration = config();
    const boundDigests = [
      configuration.context.authority.documentDigest,
      configuration.pricing.authority.documentDigest,
      configuration.retention.documentDigest,
      configuration.usagePolicyTemplate.authority.documentDigest,
    ];
    const source = configuration.sources.find((item) => !boundDigests.includes(item.recordDigest))!;
    source.validUntil = "2026-09-27T01:00:00.000Z";
    source.recordDigest = digest(providerProposalSourceDigestInput(source));
    rehash(configuration);
    expect(
      getProviderConfigurationExpiry({ ...input(), configuration, inspectedAt: source.validUntil }),
    ).toEqual({
      configurationDigest: configuration.configurationDigest,
      validUntil: source.validUntil,
    });
    source.validUntil = source.reviewedAt;
    source.recordDigest = digest(providerProposalSourceDigestInput(source));
    expect(
      getProviderConfigurationExpiry({
        ...input(),
        configuration: rehash(configuration),
        inspectedAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });
  it.each(["digest", "source", "synthetic", "model", "retention", "budget", "usage"])(
    "does not classify invalid %s evidence as merely expired",
    (mode) => {
      const configuration = config();
      if (mode === "source") configuration.sources[0].excerptSha256 = "0".repeat(64);
      if (mode === "synthetic") configuration.context.provenance = "synthetic-test";
      if (mode === "model") configuration.pricing.model = "different-model";
      if (mode === "retention") configuration.retention.documentDigest = "0".repeat(64);
      if (mode === "budget") configuration.proposedBudget.capUnits = "0";
      if (mode === "usage") configuration.usagePolicyTemplate.configuredModel = "different-model";
      rehash(configuration);
      if (mode === "digest") configuration.configurationDigest = "0".repeat(64);
      expect(
        getProviderConfigurationExpiry({
          ...input(),
          configuration,
          inspectedAt: "2030-01-01T00:00:00.000Z",
        }),
      ).toBeNull();
    },
  );
  it("keeps missing configurations and changed candidate bindings out of expiry diagnostics", () => {
    const expired = { ...input(), inspectedAt: "2030-01-01T00:00:00.000Z" };
    expect(getProviderConfigurationExpiry({ ...expired, configuration: null })).toBeNull();
    expect(
      getProviderConfigurationExpiry({ ...expired, candidateId: "validation-candidate-missing" }),
    ).toBeNull();
    const wrongRegistry = structuredClone(registry);
    wrongRegistry.versionDigest = "0".repeat(64);
    expect(getProviderConfigurationExpiry({ ...expired, registry: wrongRegistry })).toBeNull();
  });
  it("pins one candidate request and USD15 proposal without creating a budget, approval or grant", () => {
    const value = createProviderConfigurationProposalView(input());
    expect(value).not.toBeNull();
    if (!value) return;
    expect(providerReviewViewSchema.parse(value)).toEqual(value);
    expect(value).toMatchObject({
      viewVersion: 2,
      state: "proposal-only",
      model: "gpt-5.4-2026-03-05",
      budget: null,
      preparation: null,
      transmissionManifest: null,
      accountAccess: "not-checked",
      actualExecutionEnabled: false,
      proposal: {
        adoption: "not-adopted",
        proposedBudget: {
          currency: "USD",
          unitScale: 6,
          capUnits: "15000000",
          status: "not-approved",
        },
      },
    });
    expect(value.financialBasis.costs).toMatchObject({
      totalUnits: "11220000",
      generation: {
        inputTokensReserved: 1050000,
        outputTokensReserved: 16000,
        inputUnits: "5250000",
        outputUnits: "360000",
        totalUnits: "5610000",
      },
      review: { totalUnits: "5610000" },
    });
    expect(Object.values(value.financialBasis.authority).every((flag) => flag === false)).toBe(
      true,
    );
    expect(value.proposal.requestReview).toEqual(
      createProviderRequestReview({
        registry,
        candidateId: input().candidateId,
        model: value.model,
        preparedAt: now,
      }),
    );
    expect(value.proposal.requestReview.reviewTemplate.complete).toBe(false);
    expect(value.proposal.requestReview.reviewTemplate.draftSlot.rule).toBe(
      "this-run-validated-generation-only",
    );
    expect(value.viewDigest).toBe(digest(providerReviewDigestInput(value)));
    expect(value.proposal.configurationDigest).toBe(
      digest(providerProposalConfigurationDigestInput(value)),
    );
  });
  it("preserves curated source records and marks derived cache price rather than inventing page SHA", () => {
    const value = config();
    expect(value.sources).toHaveLength(7);
    for (const source of value.sources) {
      expect(source.bodySha256).toBeNull();
      expect(source.digestKind).toBe("curated-record");
      expect(source.excerptSha256).toBe(createHash("sha256").update(source.excerpt).digest("hex"));
      expect(source.recordDigest).toBe(digest(providerProposalSourceDigestInput(source)));
    }
    expect(value.sources[0].excerpt).toContain("산술 해석");
    expect(value.retention.notice).toContain("즉시 삭제나 ZDR 승인이 아니다");
    expect(value.retention.notice).toContain("24시간");
    expect(value.context.authority.freshnessPolicy).toContain("가격 고정 보장이 아니다");
  });
  it("produces an independent clone and uses exact selected candidate scope", () => {
    const first = config();
    first.model = "untrusted";
    expect(config().model).toBe("gpt-5.4-2026-03-05");
    const a = createProviderConfigurationProposalView(input())!;
    const b = createProviderConfigurationProposalView({
      ...input(),
      candidateId: registry.entries[1].candidateId,
    })!;
    expect(a.scope.candidateId).not.toBe(b.scope.candidateId);
    expect(a.proposal.requestReview.generation.sha256).not.toBe(
      b.proposal.requestReview.generation.sha256,
    );
    expect(a.proposal.configurationDigest).toBe(b.proposal.configurationDigest);
  });
  it("recomputes the financial result from complete frozen evidence", () => {
    const value = createProviderConfigurationProposalView(input())!;
    expect(value.financialBasis).toEqual(
      createProviderContextReservation({
        evidenceMode: "official-reviewed",
        model: value.model,
        calculatedAt: value.inspectedAt,
        conditions: value.financialBasis.conditions,
        outputReservationTokens: 16000,
        context: value.financialBasis.evidence.context,
        pricing: value.financialBasis.evidence.pricing,
      }),
    );
    expect(value.proposal.usagePolicy.financialBasisDigest).toBe(digest(value.financialBasis));
    expect(value.proposal.usagePolicy.responseModels).toEqual([value.model]);
  });
  it.each([null, {}, { model: "synthetic" }])(
    "does not manufacture a proposal from missing data",
    (configuration) => {
      expect(createProviderConfigurationProposalView({ ...input(), configuration })).toBeNull();
    },
  );
  it.each([
    "2026-09-26T23:53:00.000Z",
    "2026-09-27T23:57:59.000Z",
    "2030-01-01T00:00:00.000Z",
    "invalid",
  ])("rejects noncurrent evidence at %s", (inspectedAt) => {
    expect(createProviderConfigurationProposalView({ ...input(), inspectedAt })).toBeNull();
  });
  it.each(["context", "pricing"] as const)("never promotes synthetic %s provenance", (field) => {
    expect(
      changed((value) => {
        value[field].provenance = "synthetic-test";
      }),
    ).toBeNull();
  });
  it.each(["excerpt", "excerptSha256", "bodySha256", "recordDigest"] as const)(
    "rejects changed source %s even after outer resealing",
    (field) => {
      expect(
        changed((value) => {
          value.sources[0][field] = field === "excerpt" ? "changed evidence" : "0".repeat(64);
        }),
      ).toBeNull();
    },
  );
  it("rejects a fake body digest claim without fetched bytes", () => {
    expect(
      changed((value) => {
        value.sources[0].digestKind = "body";
        value.sources[0].recordDigest = digest(providerProposalSourceDigestInput(value.sources[0]));
      }),
    ).toBeNull();
  });
  it("rejects outer digest edits, duplicate source IDs and unbound authority", () => {
    const value = config();
    value.configurationDigest = "0".repeat(64);
    expect(
      createProviderConfigurationProposalView({ ...input(), configuration: value }),
    ).toBeNull();
    expect(
      changed((v) => {
        v.sources.push(v.sources[0]);
      }),
    ).toBeNull();
    expect(
      changed((v) => {
        v.retention.documentDigest = "0".repeat(64);
      }),
    ).toBeNull();
  });
  it.each(["context", "pricing"] as const)("rejects mismatched %s model or conditions", (field) => {
    expect(
      changed((v) => {
        v[field].model = "different-model";
      }),
    ).toBeNull();
    expect(
      changed((v) => {
        v[field].authority.reviewedAt = "2026-09-26T23:55:00.000Z";
      }),
    ).toBeNull();
  });
  it.each(["0", "11219999"])(
    "rejects budget proposal smaller than complete reservation: %s",
    (capUnits) => {
      expect(
        changed((v) => {
          v.proposedBudget.capUnits = capUnits;
        }),
      ).toBeNull();
    },
  );
  it("rejects currency, usage tier, response mapping and input scope mismatches", () => {
    expect(
      changed((v) => {
        v.proposedBudget.currency = "KRW";
      }),
    ).toBeNull();
    expect(
      changed((v) => {
        v.usagePolicyTemplate.configuredModel = "different-model";
      }),
    ).toBeNull();
    expect(
      createProviderConfigurationProposalView({
        ...input(),
        candidateId: "validation-candidate-missing",
      }),
    ).toBeNull();
    const badRegistry = structuredClone(registry);
    badRegistry.versionDigest = "0".repeat(64);
    expect(
      createProviderConfigurationProposalView({ ...input(), registry: badRegistry }),
    ).toBeNull();
  });
});
