import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderPreparation,
  createProviderRequestReview,
  getProviderExecutionContract,
  createVersionedProviderPreparationBuilder,
  validateNewProviderPreparation,
  type ProviderPreparationInput,
} from "./studio-plan-quality-provider-core";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { candidateRegistryVersionDigest } from "./studio-plan-quality-candidate-registry";
import {
  providerTestFinancialInput,
  providerTestExpires,
} from "./studio-plan-quality-provider-test-helpers";
import type {
  ProviderPreparation,
  VersionedProviderPreparation,
} from "./studio-plan-quality-provider-types";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import * as prompts from "./studio-engine-request-preparation";
import {
  providerDigest,
  providerWireDigest,
  providerRawDigest,
  validateProviderPreparation,
  validateVersionedProviderPreparation,
  validateVersionedProviderRequestEvidence,
  providerPreparationSchema,
  providerStartSchema,
  providerReservationRunSchema,
} from "../../scripts/local-data-quality-provider.mjs";
import { actualArchiveJsonSchemas } from "../../scripts/local-data-quality-actual.mjs";
import { z } from "zod";

const v1 = createVersionedProviderPreparationBuilder("plan-observation-v1");
const v2 = createVersionedProviderPreparationBuilder("plan-observation-v2");
function input(): ProviderPreparationInput {
  const registry = actualTestRegistry();
  registry.clientRequestId = "00000000-0000-4000-8000-000000000031";
  registry.versionDigest = candidateRegistryVersionDigest(registry);
  return {
    registry,
    candidateId: registry.entries[0].candidateId,
    environment: "synthetic-test",
    preparedAt: actualTestNow,
    expiresAt: providerTestExpires,
    financialInput: providerTestFinancialInput(),
    budget: {
      scopeId: "candidate-quality-provider-v2-synthetic",
      revision: 1,
      headDigest: "a".repeat(64),
      currency: "TST",
      unitScale: 6,
      capUnits: "100",
      heldUnits: "0",
      recognizedUnits: "0",
    },
    retention: {
      policyVersion: "synthetic-v2",
      notice: "Synthetic only; no provider call",
      sourceUrl: "https://example.invalid/retention",
      documentDigest: "b".repeat(64),
      reviewedAt: actualTestNow,
      validUntil: providerTestExpires,
    },
  };
}
const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function rehash(p: VersionedProviderPreparation) {
  p.contract.baseContract.contractDigest = providerWireDigest(
    omit(p.contract.baseContract, "contractDigest"),
  );
  p.contract.contractDigest = providerWireDigest(omit(p.contract, "contractDigest"));
  p.generation.requestDigest = providerWireDigest(p.generation.body);
  p.generation.sha256 = providerRawDigest(JSON.stringify(p.generation.body));
  p.generation.inputChars = p.generation.body.input.reduce((n, x) => n + x.content.length, 0);
  p.reviewTemplate.contractDigest = p.contract.contractDigest;
  p.reviewTemplate.templateDigest = providerWireDigest(omit(p.reviewTemplate, "templateDigest"));
  p.preparationDigest = providerDigest(omit(p, "preparationDigest"));
  return p;
}
const forbidden = vi.fn(() => {
  throw Error("Provider IO forbidden");
});
beforeEach(() => vi.stubGlobal("fetch", forbidden));
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("explicit provider preparation versions and passive archive readers", () => {
  it("preserves the pre-refactor v1 bytes and contract digests", async () => {
    const i = input(),
      p = createProviderPreparation(i);
    // Captured from HEAD 7e3c6ec's provider-core before this refactor.
    expect({
      contract: p.contract.contractDigest,
      generation: p.generation.requestDigest,
      generationBytes: p.generation.sha256,
      template: p.reviewTemplate.templateDigest,
      preparation: p.preparationDigest,
      preparationBytes: providerRawDigest(JSON.stringify(p)),
    }).toEqual({
      contract: "8aea9dead3e03a323d5a60be7daaec73ad10c9ae5a504e86b86ae2e132212648",
      generation: "247d1eb983f8cf935050fe28cd6e64ea2ca54d1f8d96f8542d8859553f4cdbcf",
      generationBytes: "5285ca79a1f44504ffd0d6cb33e9626212a1768c3ed3a415f1410e26e36c5235",
      template: "6d351c579620cac0142ab749c0f64962e04116f698931e623242146cd9102941",
      preparation: "bb6d6e228559cac243cb266d85c0ced9deb787b37bce9ac85f1ff2ba4e6887c5",
      preparationBytes: "1c55c826036c61ed1ee69ca01d1bc327a34007bcc26bd66501ec760edb65371b",
    });
    expect(JSON.stringify(v1.createPreparation(i))).toBe(JSON.stringify(p));
    expect(getProviderExecutionContract()).toEqual(v1.getContract());
    expect(
      createProviderRequestReview({
        registry: i.registry,
        candidateId: i.candidateId,
        model: p.model,
        preparedAt: i.preparedAt,
      }),
    ).toEqual(
      v1.createRequestReview({
        registry: i.registry,
        candidateId: i.candidateId,
        model: p.model,
        preparedAt: i.preparedAt,
      }),
    );
  });
  it.each(["plan-observation-v1", "plan-observation-v2"] as const)(
    "validates %s stored bytes without a clock or current builder",
    (version) => {
      const i = input(),
        builder = createVersionedProviderPreparationBuilder(version);
      const p = builder.createPreparation(i),
        bytes = JSON.stringify(p);
      vi.spyOn(prompts, "getPlanExecutionContractForVersion").mockImplementation(() => {
        throw Error("Current engine unavailable");
      });
      const parsed = validateVersionedProviderPreparation(JSON.parse(bytes), i.registry);
      expect(JSON.stringify(parsed)).toBe(bytes);
      const { scope, model, contract, generation, reviewTemplate } = p;
      expect(
        validateVersionedProviderRequestEvidence(
          { scope, model, contract, generation, reviewTemplate },
          i.registry,
        ),
      ).toEqual({ scope, model, contract, generation, reviewTemplate });
    },
  );
  it("accepts v2 paragraphs at the exact system/instruction boundary", () => {
    const i = input(),
      p = v2.createPreparation(i);
    expect(p.generation.body.input[0].content.lastIndexOf("\n\n")).toBeGreaterThan(2685);
    expect(p.reviewTemplate.systemMessage.content.lastIndexOf("\n\n")).toBeGreaterThan(2685);
    expect(v2.validateNewPreparation(p, i.registry, actualTestNow)).toEqual(p);
    expect(p.permissions).toEqual({
      dispatchAllowed: false,
      tokenFitVerified: false,
      accountAccessVerified: false,
    });
    expect(p.budget).toEqual(i.budget);
    expect(p.contract.maxCalls).toBe(2);
    expect(p.contract.maxRetries).toBe(0);
  });
  it("keeps old operational preparation/start and frozen archive schemas v1-only", () => {
    const i = input(),
      p = v2.createPreparation(i);
    expect(() => validateProviderPreparation(p, i.registry)).toThrow();
    expect(providerPreparationSchema.safeParse(p).success).toBe(false);
    const start = {
      clientRequestId: "00000000-0000-4000-8000-000000000032",
      expectedBudgetRevision: 1,
      expectedBudgetDigest: i.budget.headDigest,
      expectedScopeRunCount: 0,
      expectedGlobalRunCount: 0,
      preparation: p,
      approval: {
        provenance: "synthetic-test",
        approvedPreparationDigest: p.preparationDigest,
        approvedAt: actualTestNow,
        expiresAt: providerTestExpires,
        acknowledgedReservationOnly: true,
        acknowledgedFinancialBasisNotTokenFit: true,
        acknowledgedRetention: true,
        acknowledgedNoAutomaticRetry: true,
      },
    };
    expect(providerStartSchema.safeParse(start).success).toBe(false);
    const legacySchema = actualArchiveJsonSchemas.actualLedgerRunSchema as {
      properties: {
        preparation: { properties: { engine: Parameters<typeof z.fromJSONSchema>[0] } };
      };
    };
    const engine = legacySchema.properties.preparation.properties.engine;
    expect(z.fromJSONSchema(engine).safeParse(p.contract.baseContract).success).toBe(false);
    // Full legacy schema JSON still contains only the frozen v1 engine literal.
    const frozen = JSON.stringify(z.toJSONSchema(providerReservationRunSchema));
    expect(frozen).toContain("plan-observation-v1");
    expect(frozen).not.toContain("plan-observation-v2");
  });
  it("does not grant selected-version authority from a caller's valid preparation", () => {
    const i = input(),
      one = v1.createPreparation(i),
      two = v2.createPreparation(i);
    expect(() => v2.validateNewPreparation(one, i.registry, actualTestNow)).toThrow(
      "version mismatch",
    );
    expect(() => v1.validateNewPreparation(two, i.registry, actualTestNow)).toThrow(
      "version mismatch",
    );
    expect(() =>
      validateNewProviderPreparation(two as ProviderPreparation, i.registry, actualTestNow),
    ).toThrow("version mismatch");
  });
  it("preserves historical validity after expiry but rejects a new write", () => {
    const i = input(),
      p = v2.createPreparation(i);
    expect(validateVersionedProviderPreparation(p, i.registry)).toEqual(p);
    expect(() => v2.validateNewPreparation(p, i.registry, providerTestExpires)).toThrow("expired");
    expect(() => v2.validateNewPreparation(p, i.registry, "invalid-time")).toThrow("expired");
  });
  it.each(["plan-observation-v3", "", null, undefined])(
    "rejects unsupported version %s",
    (version) => {
      expect(() =>
        createVersionedProviderPreparationBuilder(version as PlanPromptVersion),
      ).toThrow();
    },
  );
  it("isolates returned contracts and preparations for interleaved versions", () => {
    const i = input(),
      p = v2.createPreparation(i),
      original = JSON.stringify(p);
    const contract = v2.getContract();
    contract.baseContract.phases[0].instructionDigest = "f".repeat(64);
    p.reviewTemplate.systemMessage.content = "tampered";
    p.budget.capUnits = "999";
    expect(v1.getContract().baseContract.engineVersion).toBe("plan-observation-v1");
    expect(JSON.stringify(v2.createPreparation(i))).toBe(original);
    expect(Object.isFrozen(v2)).toBe(true);
  });
  it("rejects relabelled v1 content as v2 even when all hashes are recalculated", () => {
    const i = input(),
      p = v1.createPreparation(i);
    p.contract.baseContract.engineVersion = "plan-observation-v2";
    expect(() => validateVersionedProviderPreparation(rehash(p), i.registry)).toThrow();
  });
  it("rejects a v1 review grafted onto a v2 generation after rehashing", () => {
    const i = input(),
      p = v2.createPreparation(i);
    p.reviewTemplate = v1.createPreparation(i).reviewTemplate;
    expect(() => validateVersionedProviderPreparation(rehash(p), i.registry)).toThrow();
  });
  const mutations: [string, (p: VersionedProviderPreparation) => void][] = [
    [
      "generation instruction",
      (p) => {
        p.generation.body.input[0].content += " changed";
      },
    ],
    [
      "review instruction",
      (p) => {
        p.reviewTemplate.systemMessage.content += " changed";
      },
    ],
    [
      "system boundary",
      (p) => {
        p.generation.body.input[0].content =
          p.generation.body.input[0].content.slice(0, 2685) +
          " " +
          p.generation.body.input[0].content.slice(2685);
      },
    ],
    [
      "format",
      (p) => {
        p.generation.body.text.format.schema = { type: "string" };
      },
    ],
    [
      "model",
      (p) => {
        p.generation.body.model = "foreign-model";
      },
    ],
    [
      "candidate",
      (p) => {
        const x = JSON.parse(p.generation.body.input[1].content);
        x.selectedCandidate.title = "foreign";
        p.generation.body.input[1].content = JSON.stringify(x);
      },
    ],
    [
      "tools",
      (p) => {
        Object.assign(p.generation.body, { tools: [] });
      },
    ],
    [
      "store",
      (p) => {
        Object.assign(p.generation.body, { store: true });
      },
    ],
    [
      "output limit",
      (p) => {
        Object.assign(p.generation.body, { max_output_tokens: 16001 });
      },
    ],
    [
      "phase hash",
      (p) => {
        p.contract.baseContract.phases[1].instructionDigest = "f".repeat(64);
      },
    ],
  ];
  it.each(mutations)("rejects rehashed %s tampering", (_, mutate) => {
    const i = input(),
      p = v2.createPreparation(i);
    mutate(p);
    expect(() => validateVersionedProviderPreparation(rehash(p), i.registry)).toThrow();
  });
});
