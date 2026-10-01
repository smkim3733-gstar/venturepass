/** Synthetic planning/archive verification only. No DB write, provider or approval authority. */
import { expect, it, vi, beforeAll, afterEach } from "vitest";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
vi.mock("server-only", () => ({}));
import { versionedTransmissionFixture } from "./studio-plan-quality-provider-transmission-version-test-helpers";
import {
  transmissionCommandFor,
  transmissionFixture,
} from "./studio-plan-quality-provider-transmission-test-helpers";
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  inspectVersionedProviderTransmissionApprovalArchive as inspect,
  validateVersionedProviderTransmissionApprovalBinding as validate,
  decodeVersionedProviderTransmissionApprovalBindingRows as decode,
  inspectProviderTransmissionApprovalArchive as legacyInspect,
  createProviderTransmissionApprovalMigrationCoverage as cutover,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { versionedProviderTransmissionApprovalBindingJsonSchema } from "../../scripts/local-data-quality-provider-transmission-versioned-schema.mjs";
import {
  providerTransmissionApprovalBindingSchema,
  versionedProviderTransmissionApprovalBindingSchema,
} from "./studio-plan-quality-provider-transmission-approval-types";
import {
  prepareProviderTransmissionApproval as legacyPlan,
  prepareVersionedProviderTransmissionApproval,
} from "./studio-plan-quality-provider-transmission-plan";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
const version = "plan-observation-v2";
const wrong = "a".repeat(64);
let base: ReturnType<typeof versionedTransmissionFixture>;
beforeAll(() => {
  base = versionedTransmissionFixture();
}, 15000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function pending() {
  const current = structuredClone(base.input);
  const result = base.server.transmissionReview(current);
  if (result.status !== "review" || result.review.schemaVersion !== 2) throw Error("v2 review");
  return {
    command: transmissionCommandFor(result.review),
    review: result.review,
    current: { ...current, inspectedAt: "2026-09-27T03:34:00.000Z" },
    additionalUsedBytes: 0,
  };
}
function fixture() {
  const input = pending();
  // Empty cutover explicitly excludes all later native v2 runs.
  const coverage = {
    coverageVersion: 1 as const,
    kind: "provider-transmission-approval-coverage" as const,
    cutoverGlobalRunCount: 0,
    cutoverRunPrefixDigest: digest([]),
    cutoverProviderEvents: [],
    legacyProductionApprovals: [],
  };
  const result = base.server.prepareTransmissionApproval(input);
  if (result.status !== "prepared" || result.plan.planVersion !== 2)
    throw Error(JSON.stringify(result));
  const plan = result.plan,
    archive = structuredClone(input.current.archive);
  archive.ledger.events.push(plan.rows.event);
  archive.ledger.receipts.push(plan.rows.receipt);
  return {
    input,
    plan,
    archive,
    coverage: { ...coverage, coverageDigest: digest(coverage) },
    records: [plan.rows.binding],
  };
}
type F = ReturnType<typeof fixture>;
function reseal(f: F) {
  const r = f.records[0];
  r.approvedReview.reviewDigest = digest(omit(r.approvedReview, "reviewDigest"));
  r.command.approvedReviewDigest = r.approvedReview.reviewDigest;
  r.commandDigest = digest(r.command);
  r.recordDigest = digest(omit(r, "recordDigest"));
}
it("plans v2 event2/binding2 and audits full upper coverage with unchanged budget and no authority", () => {
  const f = fixture(),
    before = JSON.stringify(f);
  expect(f.plan).toMatchObject({
    planVersion: 2,
    dispatchAllowed: false,
    budgetWriteAllowed: false,
    execution: { expectedRevision: 0 },
    rows: { event: { executionContractVersion: 2 }, binding: { recordVersion: 2 } },
  });
  const result = inspect(f);
  expect(result.records).toEqual(f.records);
  expect(validate(f.records[0], f.archive)).toEqual(f.records[0]);
  expect(result.reservationArchive.ledger.provider.snapshots[0]).toMatchObject({
    archiveFormatVersion: 5,
    state: "approved",
    dispatchAllowed: false,
    canResume: false,
  });
  expect(f.archive.ledger.budgetEvents).toEqual(f.input.current.archive.ledger.budgetEvents);
  expect(JSON.stringify(f)).toBe(before);
  expect(() => legacyInspect(f)).toThrow();
  expect(providerTransmissionApprovalBindingSchema.safeParse(f.records[0]).success).toBe(false);
  const row = {
    storage_order: 1,
    run_id: f.records[0].runId,
    nonce: f.records[0].clientRequestId,
    body: JSON.stringify(f.records[0]),
    body_hash: digest(f.records[0]),
  };
  expect(decode([row]).records).toEqual(f.records);
  expect(() => decode([{ ...row, nonce: "wrong" }])).toThrow();
});
it("keeps default and explicit v1 plan JSON and archived bytes identical", () => {
  const f = transmissionFixture(readFixedProviderConfiguration()!);
  const old = legacyPlan(f.input),
    selected = prepareVersionedProviderTransmissionApproval("plan-observation-v1", f.input);
  expect(JSON.stringify(selected)).toBe(JSON.stringify(old));
  if (old.status !== "prepared") throw Error("v1");
  expect(Object.keys(old.plan)).toEqual([
    "planVersion",
    "status",
    "transaction",
    "persistence",
    "execution",
    "rows",
    "capacity",
    "dispatchAllowed",
    "budgetWriteAllowed",
  ]);
  const coverage = cutover(f.input.current.archive);
  f.input.current.archive.ledger.events.push(old.plan.rows.event);
  f.input.current.archive.ledger.receipts.push(old.plan.rows.receipt);
  const state = { archive: f.input.current.archive, coverage, records: [old.plan.rows.binding] };
  expect(JSON.stringify(inspect(state))).toBe(JSON.stringify(legacyInspect(state)));
});
it("freezes a separate native JSON shape with application parser parity", () => {
  const f = fixture(),
    shape = z.fromJSONSchema(versionedProviderTransmissionApprovalBindingJsonSchema);
  expect(shape.parse(f.records[0])).toEqual(
    versionedProviderTransmissionApprovalBindingSchema.parse(f.records[0]),
  );
  for (const value of [
    { ...f.records[0], recordVersion: 1 },
    { ...f.records[0], recordVersion: 3 },
    {
      ...f.records[0],
      approvedReview: {
        ...f.records[0].approvedReview,
        tokenAssessment: {
          basis: "measured",
          actualTokenCountMeasured: true,
          contextFitVerified: true,
        },
      },
    },
    { ...f.records[0], unexpected: true },
  ]) {
    expect(shape.safeParse(value).success).toBe(false);
    expect(versionedProviderTransmissionApprovalBindingSchema.safeParse(value).success).toBe(false);
  }
});
it.each([undefined, null, "unsupported"])("rejects unsupported explicit version %s", (value) => {
  expect(() =>
    prepareVersionedProviderTransmissionApproval(value as PlanPromptVersion, {
      ...pending(),
      current: { ...pending().current, configuration: readFixedProviderConfiguration() },
    }),
  ).toThrow();
});
it("rejects opposite selected versions and legacy preparation entry", () => {
  const p = pending();
  expect(
    legacyPlan({ ...p, current: { ...p.current, configuration: readFixedProviderConfiguration() } })
      .status,
  ).toBe("refused");
  const server = createServerProviderPolicyContext(
    "plan-observation-v1",
    readFixedProviderConfiguration(),
  );
  expect(server.prepareTransmissionApproval(p).status).toBe("refused");
  const old = transmissionFixture(readFixedProviderConfiguration()!);
  expect(prepareVersionedProviderTransmissionApproval(version, old.input).status).toBe("refused");
});
it.each(["configuration", "version", "engineVersion", "contract", "tokenEvidence"])(
  "rejects injected %s before planning",
  (key) => {
    const p = pending();
    expect(() =>
      base.server.prepareTransmissionApproval({
        ...p,
        current: { ...p.current, [key]: "injected" },
      }),
    ).toThrow();
    expect(() => base.server.prepareTransmissionApproval({ ...p, [key]: "injected" })).toThrow();
  },
);
it("snapshots fixed configuration and does not let returned plans alter a later plan", () => {
  const config = readFixedProviderConfiguration()!;
  const server = createServerProviderPolicyContext(version, config);
  const p = pending(),
    original = server.prepareTransmissionApproval(p);
  config.configurationDigest = wrong;
  expect(server.prepareTransmissionApproval(p)).toEqual(original);
  if (original.status !== "prepared") throw Error("plan");
  original.plan.rows.binding.command.approval.approvedAt = "2099-01-01T00:00:00.000Z";
  expect(server.prepareTransmissionApproval(p)).not.toEqual(original);
});
it.each([
  [
    "wrong manifest",
    (p: ReturnType<typeof pending>) => {
      p.command.expectedManifestDigest = wrong;
    },
  ],
  [
    "wrong policy",
    (p: ReturnType<typeof pending>) => {
      p.command.expectedPolicyReference.recordDigest = wrong;
      p.command.expectedPolicyHead.headDigest = wrong;
    },
  ],
  [
    "wrong budget",
    (p: ReturnType<typeof pending>) => {
      p.command.expectedBudgetHead.headDigest = wrong;
    },
  ],
  [
    "early consent",
    (p: ReturnType<typeof pending>) => {
      p.command.approval.approvedAt = "2026-09-27T03:32:59.000Z";
    },
  ],
  [
    "future consent",
    (p: ReturnType<typeof pending>) => {
      p.command.approval.approvedAt = "2026-09-27T03:35:00.000Z";
    },
  ],
  [
    "expired review",
    (p: ReturnType<typeof pending>) => {
      p.current.inspectedAt = p.review.expiresAt;
    },
  ],
  [
    "capacity",
    (p: ReturnType<typeof pending>) => {
      p.additionalUsedBytes = 256 * 1024 * 1024;
    },
  ],
  [
    "occupied nonce",
    (p: ReturnType<typeof pending>) => {
      p.current.archive.ledger.otherNonces!.push(p.command.clientRequestId);
    },
  ],
  [
    "rehashed review",
    (p: ReturnType<typeof pending>) => {
      p.review.configurationDigest = wrong;
      p.review.reviewDigest = digest(omit(p.review, "reviewDigest"));
      p.command.approvedReviewDigest = p.review.reviewDigest;
    },
  ],
])("refuses %s before persistence", (_name, mutate) => {
  const p = pending();
  mutate(p);
  expect(base.server.prepareTransmissionApproval(p).status).toBe("refused");
});
it.each([
  [
    "record format",
    (f: F) => {
      Object.assign(f.records[0], { recordVersion: 1 });
    },
  ],
  [
    "run snapshot format",
    (f: F) => {
      Object.assign(f.records[0].approvedReview.run, { archiveFormatVersion: 2 });
    },
  ],
  [
    "request bytes",
    (f: F) => {
      f.records[0].approvedReview.request.generation.body.input[0].content += " changed";
    },
  ],
  [
    "policy reference",
    (f: F) => {
      f.records[0].command.expectedPolicyReference.recordDigest = wrong;
      f.records[0].command.expectedPolicyHead.headDigest = wrong;
    },
  ],
  [
    "budget head",
    (f: F) => {
      f.records[0].command.expectedBudgetHead.headDigest = wrong;
    },
  ],
  [
    "reservation",
    (f: F) => {
      f.records[0].command.expectedReservationBindingDigest = wrong;
    },
  ],
  [
    "early approval",
    (f: F) => {
      f.records[0].command.approval.approvedAt = "2026-09-27T03:32:59.000Z";
    },
  ],
  [
    "late inspection",
    (f: F) => {
      f.records[0].approvedReview.inspectedAt = "2026-09-27T03:35:00.000Z";
    },
  ],
  [
    "event link",
    (f: F) => {
      f.records[0].approvalEventDigest = wrong;
    },
  ],
  [
    "nonce",
    (f: F) => {
      f.records[0].clientRequestId = "00000000-0000-4000-8000-000000000001";
    },
  ],
])("rejects resealed binding %s", (_name, mutate) => {
  const f = fixture();
  mutate(f);
  reseal(f);
  expect(() => inspect(f)).toThrow();
});
it("refuses missing/duplicate/orphan bindings and forged migration coverage", () => {
  const f = fixture();
  expect(() => inspect({ ...f, records: [] })).toThrow();
  expect(() => inspect({ ...f, records: [...f.records, ...f.records] })).toThrow();
  expect(() => inspect({ ...f, archive: f.input.current.archive })).toThrow();
  expect(() => cutover(f.archive)).toThrow();
  const coverage = {
    ...f.coverage,
    cutoverGlobalRunCount: 1,
    cutoverRunPrefixDigest: digest(
      f.archive.ledger.runs.map((v) => {
        const r = v as { id: string; schemaVersion: number; runDigest: string };
        return { id: r.id, schemaVersion: r.schemaVersion, runDigest: r.runDigest };
      }),
    ),
  };
  coverage.coverageDigest = digest(omit(coverage, "coverageDigest"));
  expect(() => inspect({ ...f, records: [], coverage })).toThrow();
});
it("reads the stored approval cold without current prompt, clock or fetch", () => {
  const f = fixture(),
    before = JSON.stringify(f);
  const url = pathToFileURL(
    resolve("scripts/local-data-quality-provider-transmission-binding.mjs"),
  ).href;
  const source = `import fs from "node:fs";import {inspectVersionedProviderTransmissionApprovalArchive as inspect} from ${JSON.stringify(url)};Date.now=()=>{throw Error("clock");};globalThis.fetch=()=>{throw Error("fetch");};const v=JSON.parse(fs.readFileSync(0,"utf8"));const r=inspect(v);process.stdout.write(JSON.stringify(r.records));`;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    input: JSON.stringify({ archive: f.archive, records: f.records, coverage: f.coverage }),
    encoding: "utf8",
  });
  expect(JSON.parse(result)).toEqual(f.records);
  expect(JSON.stringify(f)).toBe(before);
});
