import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actualTestRegistry } from "@/lib/studio-plan-quality-actual-test-helpers";
import {
  createProviderRequestReview,
  providerWireDigest,
} from "@/lib/studio-plan-quality-provider-core";
import {
  createProviderConfigurationProposalView,
  getProviderConfigurationProposal,
} from "@/lib/studio-plan-quality-provider-configuration";
import {
  providerProposalConfigurationDigestInput,
  providerProposalSourceDigestInput,
  providerReviewDigestInput,
  type ProviderReviewProposalView,
} from "@/lib/studio-plan-quality-provider-review-types";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import { candidateRegistryDigest as digest } from "./quality-candidate-registry-ui";
import { qualityProviderReview, qualityProviderReviewArchive } from "./quality-provider-review-ui";

const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External access forbidden");
  }),
);
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("@/lib/studio-storage", () => ({ getStudioStore: forbidden }));
const inspectedAt = "2026-09-27T03:00:00.000Z";
const rawSha = (text: string) => createHash("sha256").update(text).digest("hex");
let registry: CandidateRegistrySnapshot;
const views: ProviderReviewProposalView[] = [];
const clone = <T>(value: T): T => structuredClone(value);
const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
async function sealView(value: ProviderReviewProposalView) {
  value.viewDigest = await digest(providerReviewDigestInput(value));
  return value;
}
async function sealConfiguration(value: ProviderReviewProposalView) {
  value.proposal.configurationDigest = await digest(
    providerProposalConfigurationDigestInput(value),
  );
  return sealView(value);
}
async function sealRequest(value: ProviderReviewProposalView) {
  const request = value.proposal.requestReview;
  request.generation.requestDigest = providerWireDigest(request.generation.body);
  request.generation.sha256 = rawSha(JSON.stringify(request.generation.body));
  request.generation.inputChars = request.generation.body.input.reduce(
    (sum, part) => sum + part.content.length,
    0,
  );
  request.reviewTemplate.templateDigest = providerWireDigest(
    omit(request.reviewTemplate, "templateDigest"),
  );
  return sealView(value);
}
const inspect = (value: ProviderReviewProposalView) =>
  qualityProviderReview(value, registry, value.scope.candidateId);
beforeAll(() => {
  vi.stubGlobal("fetch", forbidden);
  registry = actualTestRegistry();
  for (const entry of registry.entries) {
    const value = createProviderConfigurationProposalView({
      registry,
      candidateId: entry.candidateId,
      inspectedAt,
      configuration: getProviderConfigurationProposal(),
    });
    if (!value)
      throw new Error(
        "The server-fixed proposal fixture must be valid at its pinned inspection time",
      );
    views.push(value);
  }
});
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.useRealTimers();
});
afterAll(() => vi.unstubAllGlobals());

describe("provider proposal-only browser binding", () => {
  it.each(Array.from({ length: 12 }, (_, index) => index))(
    "accepts exact server request evidence for registered synthetic candidate %i",
    async (index) => {
      const view = views[index];
      expect(await inspect(view)).toEqual(view);
      expect(view.proposal.requestReview).toEqual(
        createProviderRequestReview({
          registry,
          candidateId: view.scope.candidateId,
          model: view.model,
          preparedAt: inspectedAt,
        }),
      );
    },
  );
  it("keeps past review JSON readable using inspectedAt and never invents budget or execution authority", async () => {
    const before = clone(views[0]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2035-01-01T00:00:00.000Z"));
    const value = await inspect(views[0]);
    expect(value).toEqual(before);
    expect(value).toMatchObject({
      budget: null,
      preparation: null,
      transmissionManifest: null,
      actualExecutionEnabled: false,
      accountAccess: "not-checked",
      maxCalls: 2,
      maxRetries: 0,
    });
    const archive = await qualityProviderReviewArchive(value, registry, value.scope.candidateId);
    expect(JSON.parse(archive.text)).toEqual(before);
    expect(archive.filename).toContain(value.viewDigest.slice(0, 12));
  });
  it("distinguishes curated evidence records from unavailable HTTP body hashes", async () => {
    const view = await inspect(views[0]);
    if (view.state !== "proposal-only") throw new Error("Invalid fixture");
    expect(
      view.proposal.sources.every(
        (source) => source.bodySha256 === null && source.digestKind === "curated-record",
      ),
    ).toBe(true);
    expect(view.financialBasis.authority.sourceAuthenticityIndependentlyVerified).toBe(false);
  });
  it("rejects a response for a different selected candidate even if its complete digest is valid", async () => {
    await expect(
      qualityProviderReview(views[0], registry, views[1].scope.candidateId),
    ).rejects.toThrow();
  });
  it.each(["version", "source", "model"])(
    "rejects mismatched inner request %s scope after resealing the outer view",
    async (kind) => {
      const view = clone(views[0]);
      if (kind === "version") view.proposal.requestReview.scope.versionDigest = "a".repeat(64);
      if (kind === "source") view.proposal.requestReview.scope.sourceDigest = "a".repeat(64);
      if (kind === "model") view.proposal.requestReview.model = "another-model";
      await expect(inspect(await sealView(view))).rejects.toThrow();
    },
  );
  it.each(["configuration", "financial-policy"])("rejects a changed %s digest", async (kind) => {
    const view = clone(views[0]);
    if (kind === "configuration") view.proposal.configurationDigest = "a".repeat(64);
    else view.proposal.usagePolicy.financialBasisDigest = "a".repeat(64);
    await expect(inspect(await sealView(view))).rejects.toThrow();
  });
  it.each(["excerpt", "record", "body-label", "expired", "duplicate"])(
    "rejects resealed source %s mismatch",
    async (kind) => {
      const view = clone(views[0]);
      const source = view.proposal.sources[1];
      if (kind === "excerpt") source.excerpt += " changed";
      if (kind === "record") source.recordDigest = "a".repeat(64);
      if (kind === "body-label") source.digestKind = "body";
      if (kind === "expired") source.validUntil = inspectedAt;
      if (kind === "duplicate") view.proposal.sources.push(clone(source));
      if (kind !== "record")
        source.recordDigest = await digest(providerProposalSourceDigestInput(source));
      await expect(inspect(await sealConfiguration(view))).rejects.toThrow();
    },
  );
  it.each(["retention", "usage"])(
    "rejects %s authority detached from source records",
    async (kind) => {
      const view = clone(views[0]);
      if (kind === "retention") view.retention.documentDigest = "a".repeat(64);
      else view.proposal.usagePolicy.authority.documentDigest = "a".repeat(64);
      await expect(inspect(await sealConfiguration(view))).rejects.toThrow();
    },
  );
  it("recomputes full-context financial reservation instead of trusting resealed totals", async () => {
    const view = clone(views[0]);
    view.financialBasis.costs.generation.totalUnits = "0";
    view.financialBasis.costs.totalUnits = "0";
    view.proposal.usagePolicy.financialBasisDigest = await digest(view.financialBasis);
    await expect(inspect(await sealConfiguration(view))).rejects.toThrow();
  });
  it.each(["currency", "unit", "cap", "zero", "policy-model", "duplicate-model"])(
    "rejects proposal financial binding %s",
    async (kind) => {
      const view = clone(views[0]);
      if (kind === "currency") view.proposal.proposedBudget.currency = "TST";
      if (kind === "unit") view.proposal.proposedBudget.unitScale += 1;
      if (kind === "cap") view.proposal.proposedBudget.capUnits = "1";
      if (kind === "zero") view.proposal.proposedBudget.capUnits = "0";
      if (kind === "policy-model") view.proposal.usagePolicy.configuredModel = "another-model";
      if (kind === "duplicate-model")
        view.proposal.usagePolicy.responseModels.push(view.proposal.usagePolicy.responseModels[0]);
      await expect(inspect(await sealConfiguration(view))).rejects.toThrow();
    },
  );
  it.each(["profile", "source", "candidate", "context", "draft", "sections"])(
    "rejects rehashed generation input %s changes",
    async (kind) => {
      const view = clone(views[0]);
      const input = JSON.parse(view.proposal.requestReview.generation.body.input[1].content);
      if (kind === "profile") input.profile.companyName = "다른 합성 기업";
      if (kind === "source") input.sources[0].text += " unsupported";
      if (kind === "candidate") input.selectedCandidate = registry.entries[1].input.candidate;
      if (kind === "context") input.preparationContext = "unrelated";
      if (kind === "draft") input.draft = { title: "invented draft" };
      if (kind === "sections") input.sectionDefinitions = [];
      view.proposal.requestReview.generation.body.input[1].content = JSON.stringify(input);
      await expect(inspect(await sealRequest(view))).rejects.toThrow();
    },
  );
  it("rejects a rehashed review template with another candidate or premature draft", async () => {
    const view = clone(views[0]);
    view.proposal.requestReview.reviewTemplate.fixedUserContext.selectedCandidate =
      registry.entries[1].input.candidate;
    view.proposal.requestReview.reviewTemplate.fixedUserContext.draft = {
      title: "premature draft",
    };
    await expect(inspect(await sealRequest(view))).rejects.toThrow();
  });
  it.each(["raw", "wire", "template", "contract", "character-count"])(
    "keeps %s evidence distinct and exact",
    async (kind) => {
      const view = clone(views[0]);
      const r = view.proposal.requestReview;
      if (kind === "raw") r.generation.sha256 = r.generation.requestDigest;
      if (kind === "wire") r.generation.requestDigest = r.generation.sha256;
      if (kind === "template")
        r.reviewTemplate.templateDigest = rawSha(
          JSON.stringify(omit(r.reviewTemplate, "templateDigest")),
        );
      if (kind === "contract")
        r.reviewTemplate.contractDigest = r.contract.baseContract.contractDigest;
      if (kind === "character-count") r.generation.inputChars += 1;
      await expect(inspect(await sealView(view))).rejects.toThrow();
    },
  );
  it.each(["system", "instruction", "format"])(
    "rejects resealed %s content inconsistent with the declared engine contract",
    async (kind) => {
      const view = clone(views[0]);
      const r = view.proposal.requestReview;
      if (kind === "system")
        r.generation.body.input[0].content = "changed\n" + r.generation.body.input[0].content;
      if (kind === "instruction") r.reviewTemplate.systemMessage.content += " changed";
      if (kind === "format") r.generation.body.text.format.schema.additionalProperties = true;
      await expect(inspect(await sealRequest(view))).rejects.toThrow();
    },
  );
  it.each(["execution", "account", "budget", "adoption"])(
    "never accepts %s authority on a resealed proposal",
    async (kind) => {
      const view = clone(views[0]) as unknown as Record<string, unknown>;
      if (kind === "execution") view.actualExecutionEnabled = true;
      if (kind === "account") view.accountAccess = "verified";
      if (kind === "budget") view.budget = { capUnits: "15000000" };
      if (kind === "adoption") (view.proposal as Record<string, unknown>).adoption = "adopted";
      await expect(
        inspect(await sealView(view as unknown as ProviderReviewProposalView)),
      ).rejects.toThrow();
    },
  );
});
