import { createVersionedProviderConfigurationProposalView } from "./studio-plan-quality-provider-configuration";
import {
  createVersionedProviderPolicyReview,
  isVersionedProviderPolicyReviewCurrent,
} from "./studio-plan-quality-provider-policy-review";
import { prepareVersionedProviderPolicyAdoption } from "./studio-plan-quality-provider-policy-adoption";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { prepareProviderPolicyAdoption } from "./studio-plan-quality-provider-policy-adoption";
import {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionRecordSchema,
  versionedProviderPolicyAdoptionRecordSchema,
} from "./studio-plan-quality-provider-policy-adoption-types";
import type { VersionedProviderPolicyAdoptionRecord } from "./studio-plan-quality-provider-policy-adoption-types";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  decodeProviderPolicyRows,
  decodeVersionedProviderPolicyRows,
  inspectVersionedProviderPolicyLedger,
  validateVersionedProviderPolicyAdoptionRecord,
  validateProviderPolicyAdoptionRecord,
} from "../../scripts/local-data-quality-provider-policy.mjs";
import type { ProviderBudgetEvent } from "./studio-plan-quality-provider-types";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";

const registry = actualTestRegistry();
const configuration = readFixedProviderConfiguration()!;
const initialHead = { revision: 0, headDigest: null };
function current(events: ProviderBudgetEvent[] = []) {
  return {
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: actualTestNow,
    budgetEvents: events,
    expectedBudgetHead: { revision: events.length, headDigest: events.at(-1)?.eventDigest ?? null },
  };
}
function fixture(
  version: PlanPromptVersion = "plan-observation-v2",
  events: ProviderBudgetEvent[] = [],
  head: { revision: number; headDigest: string | null } = initialHead,
) {
  const server = createServerProviderPolicyContext(version, configuration),
    ctx = current(events),
    result = server.review(ctx);
  if (result.status !== "review") throw Error(result.reason);
  const command = providerPolicyAdoptionCommandSchema.parse({
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: ctx.candidateId,
    expectedPolicyHead: head,
    approvedReviewDigest: result.review.reviewDigest,
    budgetAction: events.length ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: events.length ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: actualTestNow,
    },
  });
  return {
    server,
    input: {
      command,
      review: result.review,
      current: ctx,
      currentPolicyHead: head,
      usedRequestIds: [] as string[],
    },
  };
}
function plan(f = fixture()) {
  const result = f.server.prepareAdoption(f.input);
  if (result.status !== "prepared") throw Error(result.reason);
  return result.plan;
}
const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function reseal(record: VersionedProviderPolicyAdoptionRecord) {
  const view = record.reviewedProposal,
    request = view.proposal.requestReview;
  request.contract.baseContract.contractDigest = providerWireDigest(
    omit(request.contract.baseContract, "contractDigest"),
  );
  request.contract.contractDigest = providerWireDigest(omit(request.contract, "contractDigest"));
  request.generation.requestDigest = providerWireDigest(request.generation.body);
  request.generation.sha256 = providerRawDigest(JSON.stringify(request.generation.body));
  request.generation.inputChars = request.generation.body.input.reduce(
    (n, m) => n + m.content.length,
    0,
  );
  request.reviewTemplate.contractDigest = request.contract.contractDigest;
  request.reviewTemplate.templateDigest = providerWireDigest(
    omit(request.reviewTemplate, "templateDigest"),
  );
  view.viewDigest = digest(omit(view, "viewDigest"));
  record.approvedReview.bindings.requestReviewDigest = digest(request);
  record.approvedReview.reviewDigest = digest(omit(record.approvedReview, "reviewDigest"));
  record.command.approvedReviewDigest = record.approvedReview.reviewDigest;
  record.requestDigest = digest(record.command);
  record.recordDigest = digest(omit(record, "recordDigest"));
  return record;
}
const forbidden = vi.fn(() => {
  throw Error("No network");
});
beforeEach(() => vi.stubGlobal("fetch", forbidden));
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("server-selected policy planning and distinct archives (no real consent or writes)", () => {
  it("binds v2 requests while keeping v1 review bytes and the same financial/budget evidence", () => {
    const legacy = createProviderPolicyReview({ ...current(), configuration });
    const one = fixture("plan-observation-v1"),
      two = fixture();
    expect(one.input.review).toEqual(legacy.status === "review" ? legacy.review : null);
    expect(two.input.review.bindings.requestReviewDigest).not.toBe(
      one.input.review.bindings.requestReviewDigest,
    );
    expect(two.input.review.bindings.financialBasisDigest).toBe(
      one.input.review.bindings.financialBasisDigest,
    );
    expect(two.input.review.budget).toEqual(one.input.review.budget);
    expect(two.input.review.proposedBudget).toEqual(one.input.review.proposedBudget);
    const p = plan(two);
    expect(p.record.recordVersion).toBe(2);
    expect(p.record.reviewedProposal.viewVersion).toBe(4);
    expect(
      p.record.reviewedProposal.proposal.requestReview.contract.baseContract.engineVersion,
    ).toBe("plan-observation-v2");
    expect(p.record.dispatchAllowed).toBe(false);
    expect(p.record.reservationAllowed).toBe(false);
    expect(p.status).toBe("prepared-not-committed");
  });
  it("rejects old v1 approval at the v2 server and v2 approval at the legacy server", () => {
    const one = fixture("plan-observation-v1"),
      two = fixture();
    expect(two.server.prepareAdoption(one.input)).toMatchObject({
      status: "refused",
      reason: "review-not-current",
    });
    expect(one.server.prepareAdoption(two.input)).toMatchObject({
      status: "refused",
      reason: "review-not-current",
    });
    expect(
      prepareProviderPolicyAdoption({
        ...two.input,
        current: { ...two.input.current, configuration },
      }),
    ).toMatchObject({ status: "refused", reason: "review-not-current" });
    expect(two.server.isReviewCurrent(one.input.review, current())).toBe(false);
  });
  it.each(["configuration", "version", "engineVersion", "contract"])(
    "rejects caller-supplied %s selection",
    (field) => {
      const f = fixture();
      expect(() => f.server.review({ ...current(), [field]: "untrusted" })).toThrow(
        "cannot be supplied",
      );
      expect(() =>
        f.server.prepareAdoption({
          ...f.input,
          current: { ...f.input.current, [field]: "untrusted" },
        }),
      ).toThrow("cannot be supplied");
    },
  );
  it("freezes the server configuration snapshot and isolates returned evidence", () => {
    const config = structuredClone(configuration),
      s = createServerProviderPolicyContext("plan-observation-v2", config);
    const before = s.review(current());
    config.model = "changed-model";
    expect(s.review(current())).toEqual(before);
    const f = fixture(),
      p = plan(f);
    p.record.reviewedProposal.proposal.requestReview.generation.body.input[0].content = "tampered";
    expect(
      plan(f).record.reviewedProposal.proposal.requestReview.generation.body.input[0].content,
    ).not.toBe("tampered");
  });
  it.each(["unknown", undefined, null])("refuses unsupported server version %s", (version) => {
    expect(() =>
      createServerProviderPolicyContext(version as PlanPromptVersion, configuration),
    ).toThrow();
  });
  it("preserves the v1 chain and existing budget on a version change; round-trips stored rows", () => {
    const first = fixture("plan-observation-v1");
    const legacy = prepareProviderPolicyAdoption({
      ...first.input,
      current: { ...first.input.current, configuration },
    });
    if (legacy.status !== "prepared" || !legacy.plan.initialization)
      throw Error("Legacy fixture failed");
    const before = JSON.stringify(legacy.plan);
    const events = [legacy.plan.initialization.event],
      head = { revision: 1, headDigest: legacy.plan.record.recordDigest };
    const f = fixture("plan-observation-v2", events, head);
    f.input.usedRequestIds = [
      legacy.plan.record.clientRequestId,
      legacy.plan.initialization.event.eventId,
    ];
    const next = plan(f);
    expect(next.initialization).toBeNull();
    expect(next.record.budgetTransition.before).toEqual(next.record.budgetTransition.after);
    expect(next.record.budgetTransition.before).toEqual({
      revision: 1,
      headDigest: events[0].eventDigest,
    });
    const records = [legacy.plan.record, next.record];
    const rows = records.map((r, i) => ({
      storage_order: i + 1,
      body: JSON.stringify(r),
      body_hash: digest(r),
      scope_id: r.scopeId,
      revision: r.revision,
      nonce: r.clientRequestId,
    }));
    for (const [i, r] of decodeVersionedProviderPolicyRows(rows).records.entries())
      expect(providerRawDigest(JSON.stringify(r)), orderDifference(records[i], r)).toBe(
        providerRawDigest(rows[i].body),
      );
    expect(() => decodeProviderPolicyRows(rows)).toThrow();
    const inspect = () =>
      inspectVersionedProviderPolicyLedger({
        records,
        registries: [registry],
        provider: {
          runs: [],
          events: [],
          artifacts: [],
          budgetEvents: events,
          receipts: [legacy.plan.initialization!.receipt],
        },
      });
    expect(inspect()).toMatchObject({ revision: 2, headDigest: next.record.recordDigest });
    expect(JSON.stringify(legacy.plan)).toBe(before);
    next.record.previousDigest = "f".repeat(64);
    reseal(next.record);
    expect(inspect).toThrow();
  });
  it("uses the passive archive from a plain Node process after the review expired", () => {
    const p = plan(),
      budget = [p.initialization!.event],
      bytes = JSON.stringify(p.record);
    const moduleUrl = pathToFileURL(resolve("scripts/local-data-quality-provider-policy.mjs")).href;
    const script =
      "const m=await import(" +
      JSON.stringify(moduleUrl) +
      ");const chunks=[];for await(const c of process.stdin)chunks.push(c);const p=JSON.parse(Buffer.concat(chunks));const r=m.validateVersionedProviderPolicyAdoptionRecord(p.record,p.registry,p.budget);process.stdout.write(JSON.stringify(r));";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify({ record: p.record, registry, budget }),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(
      providerRawDigest(child.stdout),
      orderDifference(p.record, JSON.parse(child.stdout)),
    ).toBe(providerRawDigest(bytes));
    const f = fixture();
    expect(
      f.server.isReviewCurrent(f.input.review, {
        ...current(),
        inspectedAt: f.input.review.expiresAt,
      }),
    ).toBe(false);
  });
  it("keeps original policy record readers/schema v1 only", () => {
    const p = plan(),
      events = [p.initialization!.event];
    expect(() => validateProviderPolicyAdoptionRecord(p.record, registry, events)).toThrow();
    expect(providerPolicyAdoptionRecordSchema.safeParse(p.record).success).toBe(false);
    expect(versionedProviderPolicyAdoptionRecordSchema.safeParse(p.record).success).toBe(true);
    const parsed = validateVersionedProviderPolicyAdoptionRecord(p.record, registry, events);
    expect(providerRawDigest(JSON.stringify(parsed)), orderDifference(p.record, parsed)).toBe(
      providerRawDigest(JSON.stringify(p.record)),
    );
  });
  const mutations: [string, (r: VersionedProviderPolicyAdoptionRecord) => void][] = [
    [
      "v1 review graft",
      (r) => {
        r.reviewedProposal.proposal.requestReview.reviewTemplate = plan(
          fixture("plan-observation-v1"),
        ).record.reviewedProposal.proposal.requestReview.reviewTemplate;
      },
    ],
    [
      "generation instruction",
      (r) => {
        r.reviewedProposal.proposal.requestReview.generation.body.input[0].content += " changed";
      },
    ],
    [
      "extra tools",
      (r) => {
        Object.assign(r.reviewedProposal.proposal.requestReview.generation.body, { tools: [] });
      },
    ],
    [
      "relabelled version",
      (r) => {
        r.reviewedProposal.proposal.requestReview.contract.baseContract.engineVersion =
          "plan-observation-v1";
      },
    ],
    [
      "unsupported version",
      (r) => {
        Object.assign(r.reviewedProposal.proposal.requestReview.contract.baseContract, {
          engineVersion: "plan-observation-v3",
        });
      },
    ],
  ];
  it.each(mutations)("rejects fully rehashed archive %s", (_, mutate) => {
    const p = plan();
    mutate(p.record);
    reseal(p.record);
    expect(() =>
      validateVersionedProviderPolicyAdoptionRecord(p.record, registry, [p.initialization!.event]),
    ).toThrow();
  });
  it.each(["approval-time", "nonce", "policy-head", "budget-head", "evidence-expiry"])(
    "retains the existing %s guard",
    (guard) => {
      const f = fixture();
      if (guard === "approval-time")
        f.input.command.approval.approvedAt = "2026-09-27T02:59:59.999Z";
      if (guard === "nonce") f.input.usedRequestIds = [f.input.command.clientRequestId];
      if (guard === "policy-head")
        f.input.currentPolicyHead = { revision: 1, headDigest: "f".repeat(64) };
      if (guard === "budget-head")
        f.input.current.expectedBudgetHead = { revision: 1, headDigest: "f".repeat(64) };
      if (guard === "evidence-expiry") f.input.current.inspectedAt = "2026-09-28T00:00:00.000Z";
      expect(f.server.prepareAdoption(f.input).status).toBe("refused");
    },
  );
});

function orderDifference(a: unknown, b: unknown, path = "root"): string {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return "";
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (JSON.stringify(ka) !== JSON.stringify(kb))
    return path + ":" + ka.join(",") + " != " + kb.join(",");
  for (const k of ka) {
    const d = orderDifference(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
      path + "." + k,
    );
    if (d) return d;
  }
  return "";
}

it.each(["unknown", undefined, null])(
  "rejects unsupported version at pure policy boundaries: %s",
  (version) => {
    const f = fixture(),
      currentInput = { ...f.input.current, configuration };
    expect(() =>
      createVersionedProviderConfigurationProposalView(version as PlanPromptVersion, currentInput),
    ).toThrow();
    expect(() =>
      createVersionedProviderPolicyReview(version as PlanPromptVersion, currentInput),
    ).toThrow();
    expect(() =>
      isVersionedProviderPolicyReviewCurrent(
        version as PlanPromptVersion,
        f.input.review,
        currentInput,
      ),
    ).toThrow();
    expect(() =>
      prepareVersionedProviderPolicyAdoption(version as PlanPromptVersion, {
        ...f.input,
        current: currentInput,
      }),
    ).toThrow();
  },
);
