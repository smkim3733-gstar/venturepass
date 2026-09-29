/** Synthetic protocol fixtures only; no real adoption, customer data or provider calls. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { prepareProviderPolicyAdoption } from "./studio-plan-quality-provider-policy-adoption";
import {
  providerPolicyAdoptionRecordSchema,
  type ProviderPolicyAdoptionRecord,
} from "./studio-plan-quality-provider-policy-adoption-types";
import { assessProviderPolicyBudget } from "./studio-plan-quality-provider-policy-review-types";
import { providerProposalConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { providerPolicyArchiveJsonSchema } from "../../scripts/local-data-quality-provider-policy-schema.mjs";
import {
  inspectProviderPolicyLedger,
  validateProviderPolicyAdoptionRecord,
} from "../../scripts/local-data-quality-provider-policy.mjs";
import type { ProviderBudgetEvent } from "./studio-plan-quality-provider-types";

const registry = actualTestRegistry();
const omit = <T extends object>(value: T, key: keyof T) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function prepare(
  events: ProviderBudgetEvent[] = [],
  head: { revision: number; headDigest: string | null } = { revision: 0, headDigest: null },
  at = "2026-09-27T03:01:00.000Z",
) {
  const current = {
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: at,
    configuration: getProviderConfigurationProposal(),
    budgetEvents: events,
    expectedBudgetHead: { revision: events.length, headDigest: events.at(-1)?.eventDigest ?? null },
  };
  const review = createProviderPolicyReview(current);
  if (review.status !== "review") throw new Error("Synthetic review failed");
  const result = prepareProviderPolicyAdoption({
    current,
    review: review.review,
    currentPolicyHead: head,
    usedRequestIds: events.map((e) => e.eventId),
    command: {
      commandVersion: 1,
      kind: "adopt-provider-policy",
      clientRequestId: randomUUID(),
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: current.candidateId,
      expectedPolicyHead: head,
      approvedReviewDigest: review.review.reviewDigest,
      budgetAction: events.length ? "keep-existing-budget" : "initialize-proposed-budget",
      initialBudgetRequestId: events.length ? null : randomUUID(),
      approval: {
        noticeVersion: 1,
        acknowledgedPolicy: true,
        acknowledgedBudgetAction: true,
        reservationAndTransmission: "separate-approval-required",
        approvedAt: at,
      },
    },
  });
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function fixture() {
  const plan = prepare();
  if (!plan.initialization) throw new Error("Missing fixture initializer");
  return {
    records: [plan.record],
    registries: [registry],
    otherNonces: [registry.clientRequestId],
    provider: {
      runs: [],
      events: [],
      artifacts: [],
      budgetEvents: [plan.initialization.event],
      receipts: [plan.initialization.receipt],
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function reseal(record: ProviderPolicyAdoptionRecord) {
  const view = record.reviewedProposal,
    review = record.approvedReview,
    proposal = view.proposal;
  proposal.usagePolicy.financialBasisDigest = digest(view.financialBasis);
  proposal.configurationDigest = digest(providerProposalConfigurationDigestInput(view));
  view.viewDigest = digest(omit(view, "viewDigest"));
  review.bindings = {
    configurationDigest: proposal.configurationDigest,
    requestReviewDigest: digest(proposal.requestReview),
    financialBasisDigest: digest(view.financialBasis),
    retentionDigest: digest(view.retention),
    usagePolicyDigest: digest(proposal.usagePolicy),
    model: view.model,
  };
  review.reservation = {
    generationUnits: view.financialBasis.costs.generation.totalUnits,
    reviewUnits: view.financialBasis.costs.review.totalUnits,
    totalUnits: view.financialBasis.costs.totalUnits,
  };
  review.assessment = assessProviderPolicyBudget(
    review.budget,
    review.proposedBudget,
    review.reservation.totalUnits,
  );
  review.reviewDigest = digest(omit(review, "reviewDigest"));
  record.command.approvedReviewDigest = review.reviewDigest;
  record.requestDigest = digest(record.command);
  record.recordDigest = digest(omit(record, "recordDigest"));
}
afterEach(() => vi.unstubAllGlobals());

it("freezes the exact v1 shape for native archive readers; semantic refinements are checked separately", () => {
  expect(providerPolicyArchiveJsonSchema).toEqual(
    z.toJSONSchema(providerPolicyAdoptionRecordSchema, { reused: "ref" }),
  );
});
it("validates a complete two-adoption chain without modifying the existing budget or minting permissions", () => {
  const f = fixture(),
    first = f.records[0];
  const next = prepare(
    f.provider.budgetEvents,
    { revision: 1, headDigest: first.recordDigest },
    "2026-09-27T03:02:00.000Z",
  );
  expect(next.initialization).toBeNull();
  f.records.push(next.record);
  const before = JSON.stringify(f),
    result = inspectProviderPolicyLedger(f);
  expect(JSON.stringify(f)).toBe(before);
  expect(result).toMatchObject({ revision: 2, headDigest: next.record.recordDigest });
  expect(result.nonces).toEqual(f.records.map((r) => r.clientRequestId));
  expect(result.usedBytes).toBe(
    f.records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0),
  );
  expect(
    result.records.every(
      (r: ProviderPolicyAdoptionRecord) => !r.reservationAllowed && !r.dispatchAllowed,
    ),
  ).toBe(true);
  expect(
    result.provider.budgets.find(
      (b: { scopeId: string }) => b.scopeId === "candidate-quality-provider-v2-live",
    ),
  ).toMatchObject({ revision: 1, capUnits: "15000000", recognizedUnits: "0", heldUnits: "0" });
});
it("reads expired history without fetching prices, reading credentials, or rebuilding today's request", () => {
  const f = fixture();
  vi.stubGlobal("fetch", () => {
    throw new Error("No network");
  });
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("No current clock");
  });
  try {
    expect(inspectProviderPolicyLedger(f).revision).toBe(1);
  } finally {
    vi.restoreAllMocks();
  }
});
it("accepts an empty policy chain without interpreting an existing budget receipt as adoption", () => {
  const f = fixture();
  f.records = [];
  expect(inspectProviderPolicyLedger(f)).toMatchObject({
    revision: 0,
    headDigest: null,
    usedBytes: 0,
  });
});

it.each<[string, (r: ProviderPolicyAdoptionRecord) => void]>([
  [
    "recomputed financial totals",
    (r) => {
      r.reviewedProposal.financialBasis.costs.generation.inputUnits = "1";
    },
  ],
  [
    "stale maximum rate",
    (r) => {
      r.reviewedProposal.financialBasis.costs.maximumInputRate.rate.units = "1";
    },
  ],
  [
    "source excerpt",
    (r) => {
      r.reviewedProposal.proposal.sources[0].excerpt += " altered";
    },
  ],
  [
    "source date",
    (r) => {
      r.reviewedProposal.proposal.sources[0].reviewedAt = "2027-01-01T00:00:00.000Z";
    },
  ],
  [
    "duplicate sources",
    (r) => {
      r.reviewedProposal.proposal.sources.push(
        structuredClone(r.reviewedProposal.proposal.sources[0]),
      );
    },
  ],
  [
    "non-official source",
    (r) => {
      r.reviewedProposal.proposal.sources[0].url = "https://example.invalid/evidence";
    },
  ],
  [
    "retention authority",
    (r) => {
      r.reviewedProposal.retention.documentDigest = "a".repeat(64);
    },
  ],
  [
    "usage authority",
    (r) => {
      r.reviewedProposal.proposal.usagePolicy.authority.documentDigest = "a".repeat(64);
    },
  ],
  [
    "usage cache partition",
    (r) => {
      r.reviewedProposal.proposal.usagePolicy.inputPartition = {
        kind: "equal-rates",
        basis: "tampered",
      };
    },
  ],
  [
    "wrong request model",
    (r) => {
      r.reviewedProposal.proposal.requestReview.model = "different-model";
    },
  ],
  [
    "request body changed and rehashed",
    (r) => {
      const g = r.reviewedProposal.proposal.requestReview.generation;
      g.body.input[1].content = g.body.input[1].content.replace('"profile":', '"changedProfile":');
      g.requestDigest = providerWireDigest(g.body);
      g.sha256 = providerRawDigest(JSON.stringify(g.body));
      g.inputChars = g.body.input.reduce((n, item) => n + item.content.length, 0);
    },
  ],
  [
    "review template changed and rehashed",
    (r) => {
      const t = r.reviewedProposal.proposal.requestReview.reviewTemplate;
      t.fixedUserContext.preparationContext = "changed";
      t.templateDigest = providerWireDigest(omit(t, "templateDigest"));
    },
  ],
  [
    "registry label",
    (r) => {
      r.reviewedProposal.scope.label = "another";
      r.approvedReview.scope.label = "another";
    },
  ],
  [
    "registry source digest",
    (r) => {
      r.reviewedProposal.scope.registrySourceDigest = "a".repeat(64);
      r.approvedReview.scope.registrySourceDigest = "a".repeat(64);
    },
  ],
  [
    "budget amount",
    (r) => {
      r.approvedReview.budget.capUnits = "1";
    },
  ],
  [
    "budget held amount",
    (r) => {
      r.approvedReview.budget.heldUnits = "1";
    },
  ],
  [
    "budget breach",
    (r) => {
      r.approvedReview.budget.boundBreached = true;
    },
  ],
  [
    "initial budget nonce",
    (r) => {
      r.command.initialBudgetRequestId = randomUUID();
      r.budgetTransition.initializationRequestId = r.command.initialBudgetRequestId;
    },
  ],
  [
    "approval before inspection",
    (r) => {
      r.command.approval.approvedAt = "2026-09-27T02:59:00.000Z";
    },
  ],
  [
    "incorrect deadline",
    (r) => {
      r.approvedReview.expiresAt = "2026-09-27T03:14:59.000Z";
    },
  ],
  [
    "changed blocker notice",
    (r) => {
      r.reviewedProposal.blockers[0].message = "Approved";
    },
  ],
])("rejects %s even after envelope digests are recalculated", (_name, mutate) => {
  const f = fixture();
  mutate(f.records[0]);
  reseal(f.records[0]);
  expect(() => inspectProviderPolicyLedger(f)).toThrow("PROVIDER_POLICY_ARCHIVE_INVALID");
});

it.each<[string, (f: Fixture) => void]>([
  [
    "missing registry",
    (f) => {
      f.registries = [];
    },
  ],
  [
    "duplicated registry version",
    (f) => {
      f.registries.push(f.registries[0]);
    },
  ],
  [
    "registry entry changed",
    (f) => {
      f.registries = structuredClone(f.registries);
      f.registries[0].entries[0].input.profile.companyName = "changed";
    },
  ],
  [
    "registration after approval",
    (f) => {
      f.registries = structuredClone(f.registries);
      f.registries[0].registeredAt = "2027-01-01T00:00:00.000Z";
    },
  ],
  [
    "missing initializer",
    (f) => {
      f.provider.budgetEvents = [];
    },
  ],
  [
    "missing receipt",
    (f) => {
      f.provider.receipts = [];
    },
  ],
  [
    "wrong initializer receipt",
    (f) => {
      f.provider.receipts[0].inputDigest = "a".repeat(64);
    },
  ],
  [
    "duplicate policy row",
    (f) => {
      f.records.push(f.records[0]);
    },
  ],
  [
    "collision with another ledger",
    (f) => {
      f.otherNonces.push(f.records[0].clientRequestId);
    },
  ],
  [
    "initializer nonce reused elsewhere",
    (f) => {
      f.otherNonces.push(f.provider.receipts[0].clientRequestId);
    },
  ],
  [
    "duplicated other nonce",
    (f) => {
      f.otherNonces.push(f.otherNonces[0]);
    },
  ],
  [
    "policy limit",
    (f) => {
      f.records = Array.from({ length: 101 }, () => f.records[0]);
    },
  ],
])("rejects %s in complete chain inspection", (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => inspectProviderPolicyLedger(f)).toThrow("PROVIDER_POLICY_ARCHIVE_INVALID");
});
it("rejects a missing predecessor and reordered policy rows", () => {
  const f = fixture(),
    next = prepare(
      f.provider.budgetEvents,
      { revision: 1, headDigest: f.records[0].recordDigest },
      "2026-09-27T03:02:00.000Z",
    );
  expect(() => inspectProviderPolicyLedger({ ...f, records: [next.record] })).toThrow();
  expect(() =>
    inspectProviderPolicyLedger({ ...f, records: [next.record, f.records[0]] }),
  ).toThrow();
});
it("rejects extra permissions, malformed integer text and oversized rows before trusting hashes", () => {
  const f = fixture();
  for (const record of [
    { ...f.records[0], dispatchAllowed: true },
    { ...f.records[0], extraAuthority: true },
    { ...f.records[0], injected: "x".repeat(2 * 1024 * 1024) },
    {
      ...f.records[0],
      approvedReview: {
        ...f.records[0].approvedReview,
        budget: { ...f.records[0].approvedReview.budget, capUnits: "1.5" },
      },
    },
  ])
    expect(() =>
      validateProviderPolicyAdoptionRecord(record, registry, f.provider.budgetEvents),
    ).toThrow("PROVIDER_POLICY_ARCHIVE_INVALID");
});
it("runs in a fresh native Node process with no TS loader, network or credential access", () => {
  const moduleUrl = pathToFileURL(resolve("scripts/local-data-quality-provider-policy.mjs")).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from 'node:fs';
    globalThis.fetch = () => {throw new Error('No network');};
    process.env = new Proxy(process.env, {get(target, key, receiver) {
      if (/^(OPENAI|VENTURE_DATA_DIR)/.test(String(key))) throw new Error('No credentials');
      return Reflect.get(target, key, receiver);
    }});
    const { inspectProviderPolicyLedger } = await import(${JSON.stringify(moduleUrl)});
    const result = inspectProviderPolicyLedger(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(JSON.stringify({revision: result.revision, headDigest: result.headDigest}));
  `,
    ],
    { input: JSON.stringify(fixture()), encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    revision: 1,
    headDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
