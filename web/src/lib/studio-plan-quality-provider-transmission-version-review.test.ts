/** In-memory synthetic policies/reservations only. No credentials, DB writes or provider calls. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createServerProviderPolicyContext } from "./studio-plan-quality-provider-policy-server";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { actualTestNow, actualTestRegistry } from "./studio-plan-quality-actual-test-helpers";
import { readFixedProviderConfiguration } from "./studio-plan-quality-provider-configuration-20260927-test-fixture";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { commandFor } from "./studio-plan-quality-provider-reservation-test-helpers";
import { transmissionFixture } from "./studio-plan-quality-provider-transmission-test-helpers";
import {
  createProviderTransmissionReview,
  createVersionedProviderTransmissionReview,
  type ProviderTransmissionReviewInput,
} from "./studio-plan-quality-provider-transmission-review";
import {
  providerTransmissionReviewSchema,
  versionedProviderTransmissionReviewSchema,
  providerTransmissionReviewDigestInput,
} from "./studio-plan-quality-provider-transmission-review-types";
import { createProviderReservationMigrationCoverage } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  createProviderTransmissionManifest,
  createVersionedProviderTransmissionManifest,
  validateProviderExecutionManifest,
  validateVersionedProviderExecutionManifest,
  providerExecutionPayloadSchema,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  providerDigest as digest,
  providerWireDigest,
  providerRawDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import type { ProviderRun } from "./studio-plan-quality-provider-types";

const v1 = "plan-observation-v1",
  v2 = "plan-observation-v2";
const configuration = readFixedProviderConfiguration()!;
const inspectedAt = "2026-09-27T03:33:00.000Z";
type Inspection = Omit<ProviderTransmissionReviewInput, "configuration">;

function fixture(version: PlanPromptVersion = v2) {
  const registry = actualTestRegistry();
  const server = createServerProviderPolicyContext(version, configuration);
  const current = {
    registry,
    candidateId: registry.entries[0].candidateId,
    inspectedAt: actualTestNow,
    budgetEvents: [],
    expectedBudgetHead: { revision: 0, headDigest: null },
  };
  const review = server.review(current);
  if (review.status !== "review") throw Error(review.reason);
  const adoption = server.prepareAdoption({
    current,
    review: review.review,
    usedRequestIds: [],
    currentPolicyHead: { revision: 0, headDigest: null },
    command: providerPolicyAdoptionCommandSchema.parse({
      commandVersion: 1,
      kind: "adopt-provider-policy",
      clientRequestId: randomUUID(),
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: current.candidateId,
      expectedPolicyHead: { revision: 0, headDigest: null },
      approvedReviewDigest: review.review.reviewDigest,
      budgetAction: "initialize-proposed-budget",
      initialBudgetRequestId: randomUUID(),
      approval: {
        noticeVersion: 1,
        acknowledgedPolicy: true,
        acknowledgedBudgetAction: true,
        reservationAndTransmission: "separate-approval-required",
        approvedAt: actualTestNow,
      },
    }),
  });
  if (adoption.status !== "prepared" || !adoption.plan.initialization) throw Error("adoption");
  const ledger: ProviderTransmissionReviewInput["archive"]["ledger"] = {
    runs: [],
    events: [],
    artifacts: [],
    budgetEvents: [adoption.plan.initialization.event],
    receipts: [adoption.plan.initialization.receipt],
    policies: [adoption.plan.record],
    otherNonces: [],
    registries: [registry],
  };
  const coverage = createProviderReservationMigrationCoverage(ledger);
  const reservedCurrent = {
    selection: {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: current.candidateId,
    },
    inspectedAt: "2026-09-27T03:30:00.000Z",
    ledger,
  };
  const reservationReview = server.reservationReview(reservedCurrent);
  if (reservationReview.status !== "review") throw Error(reservationReview.reason);
  const reservation = server.prepareReservation({
    command: commandFor(reservationReview.review),
    review: reservationReview.review,
    current: { ...reservedCurrent, inspectedAt: "2026-09-27T03:32:00.000Z" },
    runId: randomUUID(),
    additionalUsedBytes: 0,
  });
  if (reservation.status !== "prepared") throw Error(reservation.reason);
  const rows = reservation.plan.rows;
  ledger.runs.push(rows.run);
  ledger.artifacts.push(rows.artifact);
  ledger.budgetEvents.push(rows.budgetEvent);
  ledger.receipts.push(rows.receipt);
  return {
    server,
    rows,
    input: {
      selection: { runId: rows.run.id, runDigest: rows.run.runDigest },
      inspectedAt,
      archive: { ledger, coverage, records: [rows.binding] },
    } satisfies Inspection,
  };
}
let baseline: ReturnType<typeof fixture>;
beforeAll(() => {
  baseline = fixture();
}, 15000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const input = () => structuredClone(baseline.input);
function review() {
  const result = baseline.server.transmissionReview(input());
  if (result.status !== "review" || result.review.schemaVersion !== 2) throw Error("v2 review");
  return result.review;
}
const omit = (v: object, k: string) =>
  Object.fromEntries(Object.entries(v).filter(([key]) => key !== k));

it("binds the selected v2 reservation and exact bytes without token or transmission authority", () => {
  const current = input(),
    before = JSON.stringify(current);
  const forbidden = vi.fn(() => {
    throw Error("External access");
  });
  vi.stubGlobal("fetch", forbidden);
  const value = review();
  expect(value.assessment).toEqual({ state: "conditions-met", blockers: [] });
  expect(value.run.archiveFormatVersion).toBe(4);
  expect(value.request.contract.baseContract.engineVersion).toBe(v2);
  expect(value.manifest.executionContract).toMatchObject({
    version: 2,
    engineVersion: v2,
    nativeRunFormat: 3,
    maxCalls: 2,
    maxRetries: 0,
  });
  expect(JSON.stringify(value.request.generation.body)).toBe(
    JSON.stringify(baseline.rows.run.preparation.generation.body),
  );
  expect(value.tokenAssessment).toEqual({
    basis: "financial-reservation-only",
    actualTokenCountMeasured: false,
    contextFitVerified: false,
  });
  expect(Object.values(value.actions)).toEqual([false, false, false]);
  expect(baseline.server.isTransmissionReviewCurrent(value, current)).toBe(true);
  expect(JSON.stringify(current)).toBe(before);
  expect(forbidden).not.toHaveBeenCalled();
});

it("keeps the frozen v1 review/manifest JSON bytes and stored record2/v1 selection", () => {
  const legacy = transmissionFixture(configuration).input.current;
  const { configuration: ignored, ...inspection } = legacy;
  void ignored;
  const selected = createServerProviderPolicyContext(v1, configuration);
  expect(JSON.stringify(selected.transmissionReview(inspection))).toBe(
    JSON.stringify(createProviderTransmissionReview(legacy)),
  );
  const f = fixture(v1);
  const result = f.server.transmissionReview(f.input);
  expect(result.status).toBe("review");
  if (result.status !== "review") return;
  expect(result.review.schemaVersion).toBe(1);
  expect(providerTransmissionReviewSchema.safeParse(result.review).success).toBe(true);
  expect(f.server.isTransmissionReviewCurrent(result.review, f.input)).toBe(true);
}, 15000);

it("leaves the legacy reader and approval event schema unable to authorize v2", () => {
  expect(createProviderTransmissionReview({ ...input(), configuration })).toMatchObject({
    status: "unavailable",
    reason: "preparation-changed",
  });
  const value = review();
  expect(providerTransmissionReviewSchema.safeParse(value).success).toBe(false);
  const old = transmissionFixture(configuration).input;
  const approval = {
    kind: "transmission-approved",
    manifest: value.manifest,
    provenance: "explicit-user",
    approvedAt: old.command.approval.approvedAt,
    expiresAt: old.review.expiresAt,
    acknowledgedExternalTransmission: true,
    acknowledgedGenerationAndDerivedReview: true,
    acknowledgedRetentionNoticeDigest: digest(old.review.retention),
    acknowledgedFinancialReservationNotTokenFit: true,
    acknowledgedUnknownCostHoldAndNoRetry: true,
    budgetRevision: old.review.budget.revision,
    budgetDigest: old.review.budget.headDigest,
  };
  expect(providerExecutionPayloadSchema.safeParse(approval).success).toBe(false);
});

it.each([undefined, null, "plan-observation-v3"])(
  "rejects an unsupported server version %s",
  (version) => {
    expect(() =>
      createServerProviderPolicyContext(version as PlanPromptVersion, configuration),
    ).toThrow();
    expect(() =>
      createVersionedProviderTransmissionReview(version as PlanPromptVersion, {
        ...input(),
        configuration,
      }),
    ).toThrow();
  },
);

it.each([
  "configuration",
  "version",
  "engineVersion",
  "contract",
  "tokenEvidence",
  "tokenAssessment",
])("rejects caller-supplied %s rather than treating it as authority", (key) => {
  expect(() =>
    baseline.server.transmissionReview({ ...input(), [key]: { tokenFitVerified: true } }),
  ).toThrow();
});

it("rejects opposite server versions before a transmission review is issued", () => {
  expect(
    createServerProviderPolicyContext(v1, configuration).transmissionReview(input()),
  ).toMatchObject({ status: "unavailable", reason: "preparation-changed" });
  const legacy = transmissionFixture(configuration).input.current;
  const { configuration: ignored, ...inspection } = legacy;
  void ignored;
  expect(baseline.server.transmissionReview(inspection)).toMatchObject({
    status: "unavailable",
    reason: "preparation-changed",
  });
});

it.each(["store", "instruction", "tools", "review-version"])(
  "rejects a resealed %s request",
  (kind) => {
    const current = input(),
      run = current.archive.ledger.runs[0] as typeof baseline.rows.run;
    if (run.schemaVersion !== 2) throw Error("provider");
    const prep = run.preparation;
    if (kind === "store") Object.assign(prep.generation.body, { store: true });
    if (kind === "instruction") prep.generation.body.input[0].content += "changed";
    if (kind === "tools") Object.assign(prep.generation.body, { tools: [{ type: "web_search" }] });
    if (kind === "review-version")
      prep.reviewTemplate.systemMessage.content =
        transmissionFixture(
          configuration,
        ).reservation.rows.run.preparation.reviewTemplate.systemMessage.content;
    prep.generation.requestDigest = providerWireDigest(prep.generation.body);
    prep.generation.sha256 = providerRawDigest(JSON.stringify(prep.generation.body));
    prep.generation.inputChars = prep.generation.body.input.reduce(
      (n, m) => n + m.content.length,
      0,
    );
    prep.preparationDigest = digest(omit(prep, "preparationDigest"));
    run.runDigest = digest(omit(run, "runDigest"));
    current.selection.runDigest = run.runDigest;
    expect(baseline.server.transmissionReview(current)).toMatchObject({
      status: "unavailable",
      reason: "archive-invalid",
    });
  },
);

it("rejects a manifest for another run or native version even if it is rehashed", () => {
  const value = review(),
    run = baseline.rows.run;
  if (run.archiveFormatVersion !== 3) throw Error("native v2");
  expect(validateVersionedProviderExecutionManifest(run, value.manifest)).toEqual(value.manifest);
  expect(() =>
    createProviderTransmissionManifest(
      run as unknown as ProviderRun,
      value.manifest.executionContract.usagePolicy,
    ),
  ).toThrow();
  expect(() =>
    validateProviderExecutionManifest(run as unknown as ProviderRun, value.manifest as never),
  ).toThrow();
  const changed = structuredClone(value.manifest);
  changed.runDigest = "a".repeat(64);
  changed.manifestDigest = digest(omit(changed, "manifestDigest"));
  expect(() => validateVersionedProviderExecutionManifest(run, changed)).toThrow();
  const legacy = transmissionFixture(configuration).reservation.rows.run;
  expect(() =>
    createVersionedProviderTransmissionManifest(
      legacy as never,
      value.manifest.executionContract.usagePolicy,
    ),
  ).toThrow();
});

it("rebuilds currentness from original audited evidence instead of accepting a new review hash", () => {
  const value = review();
  value.request.generation.body.input[0].content += "changed";
  value.reviewDigest = digest(providerTransmissionReviewDigestInput(value));
  expect(baseline.server.isTransmissionReviewCurrent(value, input())).toBe(false);
});

it("rejects expired, future, wrong-selected and damaged archive evidence", () => {
  const value = review();
  for (const at of [value.expiresAt, "2026-09-27T03:32:59.999Z"])
    expect(
      baseline.server.isTransmissionReviewCurrent(value, { ...input(), inspectedAt: at }),
    ).toBe(false);
  const selected = input();
  selected.selection.runDigest = "a".repeat(64);
  expect(baseline.server.isTransmissionReviewCurrent(value, selected)).toBe(false);
  const damaged = input();
  damaged.archive.ledger.receipts.pop();
  expect(baseline.server.isTransmissionReviewCurrent(value, damaged)).toBe(false);
});

it("does not reuse mutable returned reviews or caller configuration as server selection", () => {
  const config = structuredClone(configuration);
  const server = createServerProviderPolicyContext(v2, config);
  config.model = "changed";
  const first = server.transmissionReview(input());
  expect(first.status).toBe("review");
  if (first.status !== "review") return;
  first.review.request.generation.body.input[0].content = "changed";
  expect(server.transmissionReview(input())).toEqual(baseline.server.transmissionReview(input()));
});

it("rejects token-fit claims, v1 review mixing and native format downgrade", () => {
  const value = review();
  for (const changed of [
    { ...value, tokenAssessment: { ...value.tokenAssessment, contextFitVerified: true } },
    { ...value, request: transmissionFixture(configuration).input.review.request },
    { ...value, manifest: { ...value.manifest, schemaVersion: 1 } },
    { ...value, run: { ...value.run, archiveFormatVersion: 3 } },
  ])
    expect(versionedProviderTransmissionReviewSchema.safeParse(changed).success).toBe(false);
});

it("validates stored v2 manifests without consulting the current clock or credentials", () => {
  const value = review(),
    run = baseline.rows.run;
  if (run.archiveFormatVersion !== 3) throw Error("native v2");
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw Error("Current clock forbidden");
  });
  expect(validateVersionedProviderExecutionManifest(run, value.manifest)).toEqual(value.manifest);
});
