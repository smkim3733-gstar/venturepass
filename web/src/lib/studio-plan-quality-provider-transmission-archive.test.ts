import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { inspectProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  createProviderExecutionBudgetEvent,
  getProviderExecutionBudgetSnapshot,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  createProviderTransmissionApprovalMigrationCoverage as cutover,
  inspectProviderTransmissionApprovalArchive as inspect,
  validateProviderTransmissionApprovalBinding as validate,
  decodeProviderTransmissionApprovalBindingRows as decode,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  providerTransmissionApprovalBindingJsonSchema,
  providerTransmissionApprovalCoverageJsonSchema,
} from "../../scripts/local-data-quality-provider-transmission-binding-schema.mjs";
import {
  providerTransmissionApprovalBindingSchema,
  providerTransmissionApprovalCoverageSchema,
  type ProviderTransmissionApprovalBinding,
} from "./studio-plan-quality-provider-transmission-approval-types";
import { prepareProviderTransmissionApproval } from "./studio-plan-quality-provider-transmission-plan";
import {
  transmissionFixture,
  transmissionCommandFor,
  transmissionReview,
} from "./studio-plan-quality-provider-transmission-test-helpers";
import {
  adopt,
  config,
  refresh,
  prepared,
  withRows,
} from "./studio-plan-quality-provider-reservation-test-helpers";
import { providerConfigurationDigestInput } from "./studio-plan-quality-provider-review-types";
import type {
  ProviderExecutionCommand,
  ProviderExecutionPayload,
  ProviderExecutionEvent,
} from "./studio-plan-quality-provider-execution-types";

vi.mock("./studio-plan-quality-store", () => {
  throw new Error("No database in archive reader");
});
vi.mock("./studio-provider-observation", () => {
  throw new Error("No provider in archive reader");
});
vi.mock("openai", () => {
  throw new Error("No SDK in archive reader");
});
const omit = (v: object, key: string) =>
  Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
const wrong = "a".repeat(64);
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function plan(input: Parameters<typeof prepareProviderTransmissionApproval>[0]) {
  const result = prepareProviderTransmissionApproval(input);
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
function fixture() {
  const f = transmissionFixture();
  const archive = f.input.current.archive,
    coverage = cutover(archive);
  const p = plan(f.input);
  archive.ledger.events.push(p.rows.event);
  archive.ledger.receipts.push(p.rows.receipt);
  return { ...f, archive, coverage, records: [p.rows.binding], plan: p };
}
function reseal(r: ProviderTransmissionApprovalBinding) {
  r.approvedReview.reviewDigest = digest(omit(r.approvedReview, "reviewDigest"));
  r.command.approvedReviewDigest = r.approvedReview.reviewDigest;
  r.commandDigest = digest(r.command);
  r.recordDigest = digest(omit(r, "recordDigest"));
}
const base = fixture();
let f: ReturnType<typeof fixture>;
const fetchSpy = vi.fn(() => {
  throw new Error("No transport");
});
beforeEach(() => {
  f = structuredClone(base);
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("freezes binding and coverage shapes independently of application builders", () => {
  expect(providerTransmissionApprovalBindingJsonSchema).toEqual(
    z.toJSONSchema(providerTransmissionApprovalBindingSchema, { reused: "ref" }),
  );
  expect(providerTransmissionApprovalCoverageJsonSchema).toEqual(
    z.toJSONSchema(providerTransmissionApprovalCoverageSchema, { reused: "ref" }),
  );
});
it("audits immutable native rows, historical r0 and binding without using the clock or mutating input", () => {
  const before = structuredClone(f);
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("No wall clock");
  });
  const result = inspect(f);
  expect(f).toEqual(before);
  expect(result.records).toEqual(f.records);
  expect(result.usedBytes).toBe(size(f.coverage) + size(f.records[0]));
  expect(result.reservationArchive.ledger.provider.snapshots[0]).toMatchObject({
    state: "approved",
    revision: 1,
    dispatchAllowed: false,
    canResume: false,
  });
  expect(validate(f.records[0], f.archive)).toEqual(f.records[0]);
  result.records[0].command.approval.approvedAt = "2099-01-01T00:00:00.000Z";
  expect(f).toEqual(before);
});
it("reads an expired historical approval without a current configuration", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
  expect(inspect({ archive: f.archive, coverage: f.coverage, records: f.records }).records).toEqual(
    f.records,
  );
});
it("can run in native Node without importing TS, application builders or IO adapters", () => {
  const url = pathToFileURL(
    resolve("scripts/local-data-quality-provider-transmission-binding.mjs"),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {readFileSync} from 'node:fs';
    import {inspectProviderTransmissionApprovalArchive as inspect} from ${JSON.stringify(url)};
    globalThis.fetch = () => {throw new Error('no fetch')};
    Date.now = () => {throw new Error('no clock')};
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(inspect(input).records[0].recordDigest);
  `,
    ],
    {
      input: JSON.stringify({ archive: f.archive, coverage: f.coverage, records: f.records }),
      encoding: "utf8",
      timeout: 30000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(f.records[0].recordDigest);
});

const mutations: [string, (r: ProviderTransmissionApprovalBinding) => void][] = [
  [
    "command CAS archive",
    (r) => {
      r.command.expectedArchiveDigest = wrong;
    },
  ],
  [
    "coverage linked hash",
    (r) => {
      r.command.expectedCoverageDigest = r.approvedReview.coverageDigest = wrong;
    },
  ],
  [
    "reservation link",
    (r) => {
      r.command.expectedReservationBindingDigest = r.approvedReview.reservation.bindingDigest =
        wrong;
    },
  ],
  [
    "manifest link",
    (r) => {
      r.command.expectedManifestDigest = wrong;
    },
  ],
  [
    "historical r0 snapshot",
    (r) => {
      r.command.expectedRun.snapshotDigest = r.approvedReview.run.snapshotDigest = wrong;
    },
  ],
  [
    "run metadata",
    (r) => {
      r.approvedReview.run.recordedAt = r.approvedReview.run.preparedAt;
    },
  ],
  [
    "run identity",
    (r) => {
      r.command.runId = randomUUID();
    },
  ],
  [
    "run digest",
    (r) => {
      r.runDigest = wrong;
    },
  ],
  [
    "policy reference",
    (r) => {
      r.command.expectedPolicyReference.recordDigest =
        r.approvedReview.policy.reservedReference.recordDigest = wrong;
    },
  ],
  [
    "policy head",
    (r) => {
      r.command.expectedPolicyHead.headDigest = r.approvedReview.policy.head.headDigest = wrong;
    },
  ],
  [
    "budget head",
    (r) => {
      r.command.expectedBudgetHead.headDigest = r.approvedReview.budget.headDigest = wrong;
    },
  ],
  [
    "budget units",
    (r) => {
      r.approvedReview.budget.availableUnits = "0";
    },
  ],
  [
    "reservation units",
    (r) => {
      r.approvedReview.reservation.heldUnits = "0";
    },
  ],
  [
    "generation settlement",
    (r) => {
      r.approvedReview.reservation.generationSettled = true;
    },
  ],
  [
    "review settlement",
    (r) => {
      r.approvedReview.reservation.reviewSettled = true;
    },
  ],
  [
    "scope label",
    (r) => {
      r.approvedReview.scope.label += " changed";
    },
  ],
  [
    "exact request",
    (r) => {
      r.approvedReview.request.generation.body.model = "changed-model";
    },
  ],
  [
    "financial evidence",
    (r) => {
      r.approvedReview.financialBasis.calculatedAt = r.approvedReview.inspectedAt;
    },
  ],
  [
    "retention evidence",
    (r) => {
      r.approvedReview.retention.validUntil = "2099-01-01T00:00:00.000Z";
    },
  ],
  [
    "usage policy",
    (r) => {
      r.approvedReview.manifest.executionContract.usagePolicy.financialBasisDigest = wrong;
    },
  ],
  [
    "manifest nested hash",
    (r) => {
      r.approvedReview.manifest.executionContract.contractDigest = wrong;
    },
  ],
  [
    "configuration",
    (r) => {
      r.approvedReview.configurationDigest = wrong;
    },
  ],
  [
    "blocked facts",
    (r) => {
      r.approvedReview.facts.policyUnchanged = false;
    },
  ],
  [
    "blocked assessment",
    (r) => {
      r.approvedReview.assessment = { state: "blocked", blockers: ["run-not-reserved"] };
    },
  ],
  [
    "approval event link",
    (r) => {
      r.approvalEventDigest = wrong;
    },
  ],
  [
    "execution input link",
    (r) => {
      r.executionInputDigest = wrong;
    },
  ],
  [
    "nonce identity",
    (r) => {
      r.clientRequestId = r.command.clientRequestId = randomUUID();
    },
  ],
  [
    "retention acknowledgement",
    (r) => {
      r.command.approval.acknowledgedRetentionNoticeDigest = wrong;
    },
  ],
  [
    "native approval time",
    (r) => {
      r.command.approval.approvedAt = "2026-09-27T03:33:31.000Z";
    },
  ],
  [
    "recorded time",
    (r) => {
      r.recordedAt = "2026-09-27T03:34:01.000Z";
    },
  ],
  [
    "inspection after approval",
    (r) => {
      r.approvedReview.inspectedAt = "2026-09-27T03:33:31.000Z";
    },
  ],
  [
    "inspection before reservation",
    (r) => {
      r.approvedReview.inspectedAt = "2026-09-27T03:31:59.000Z";
    },
  ],
  [
    "expiry extended",
    (r) => {
      r.approvedReview.expiresAt = "2026-09-27T03:46:00.000Z";
    },
  ],
];
it.each(mutations)("rejects rehashed %s substitution", (_name, mutate) => {
  mutate(f.records[0]);
  reseal(f.records[0]);
  expect(() => inspect(f)).toThrow("PROVIDER_TRANSMISSION_APPROVAL_ARCHIVE_INVALID");
});
it.each(["recordDigest", "commandDigest"] as const)("rejects %s corruption", (key) => {
  f.records[0][key] = wrong;
  expect(() => inspect(f)).toThrow();
});
it("rejects unknown fields and enabled grants even when rehashed", () => {
  const bad = { ...f.records[0], dispatchAllowed: true, secret: "synthetic-not-a-key" };
  bad.recordDigest = digest(omit(bad, "recordDigest"));
  expect(() => inspect({ ...f, records: [bad] })).toThrow();
});
it.each([
  "acknowledgedExternalTransmission",
  "acknowledgedGenerationAndDerivedReview",
  "acknowledgedFinancialReservationNotTokenFit",
  "acknowledgedUnknownCostHoldAndNoRetry",
  "acknowledgedCurrentPolicyAndBudget",
])("rejects false consent %s despite rehashing", (key) => {
  Object.assign(f.records[0].command.approval, { [key]: false });
  reseal(f.records[0]);
  expect(() => inspect(f)).toThrow();
});
it("accepts a cutover with an unapproved reservation and no approval binding", () => {
  const v = transmissionFixture(),
    archive = v.input.current.archive;
  expect(inspect({ archive, coverage: cutover(archive), records: [] }).records).toEqual([]);
});
it("requires a binding for approval of a run reserved BEFORE migration", () => {
  expect(f.coverage.cutoverProviderEvents[0].eventCount).toBe(0);
  expect(f.coverage.legacyProductionApprovals).toEqual([]);
  expect(() => inspect({ ...f, records: [] })).toThrow();
  // Native receipts alone remain valid, but cannot prove the original review and command.
  expect(() => inspectProviderReservationArchive(f.archive)).not.toThrow();
});
it("preserves exactly the approvals that already existed at migration", () => {
  const coverage = cutover(f.archive);
  expect(coverage.legacyProductionApprovals).toEqual([
    {
      runId: f.records[0].runId,
      approvalEventDigest: f.records[0].approvalEventDigest,
      clientRequestId: f.records[0].clientRequestId,
      executionInputDigest: f.records[0].executionInputDigest,
    },
  ]);
  expect(inspect({ ...f, coverage, records: [] }).records).toEqual([]);
  expect(() => inspect({ ...f, coverage })).toThrow(); // extra binding is ambiguous coverage
});
it.each(["approvalEventDigest", "executionInputDigest", "clientRequestId", "runId"] as const)(
  "rejects a rehashed legacy approval %s mismatch",
  (key) => {
    const coverage = cutover(f.archive);
    coverage.legacyProductionApprovals[0][key] = key.endsWith("Id") ? randomUUID() : wrong;
    coverage.coverageDigest = digest(omit(coverage, "coverageDigest"));
    expect(() => inspect({ ...f, coverage, records: [] })).toThrow();
  },
);
it.each([null, undefined, {}, { ...base.coverage, coverageDigest: wrong }])(
  "does not recreate missing or broken coverage %j",
  (coverage) => {
    expect(() => inspect({ ...f, coverage })).toThrow();
  },
);
it.each([
  (v: typeof base.coverage) => {
    v.cutoverProviderEvents[0].eventCount = 1;
  },
  (v: typeof base.coverage) => {
    v.cutoverProviderEvents[0].eventPrefixDigest = wrong;
  },
  (v: typeof base.coverage) => {
    v.cutoverProviderEvents[0].runDigest = wrong;
  },
  (v: typeof base.coverage) => {
    v.cutoverGlobalRunCount++;
  },
  (v: typeof base.coverage) => {
    v.cutoverRunPrefixDigest = wrong;
  },
  (v: typeof base.coverage) => {
    v.cutoverProviderEvents = [];
  },
  (v: typeof base.coverage) => {
    v.cutoverProviderEvents.push(v.cutoverProviderEvents[0]);
  },
])("rejects rehashed migration boundary mismatch %#", (mutate) => {
  mutate(f.coverage);
  f.coverage.coverageDigest = digest(omit(f.coverage, "coverageDigest"));
  expect(() => inspect(f)).toThrow();
});
it("rejects duplicate, absent and unrelated binding rows", () => {
  expect(() => inspect({ ...f, records: [f.records[0], f.records[0]] })).toThrow();
  f.records[0].runId = randomUUID();
  reseal(f.records[0]);
  expect(() => inspect(f)).toThrow();
});
it("rejects broken v8 coverage, reservation bindings and native receipts", () => {
  for (const field of ["records", "coverage", "receipt"] as const) {
    const v = structuredClone(f);
    if (field === "records") v.archive.records = [];
    if (field === "coverage") v.archive.coverage.coverageDigest = wrong;
    if (field === "receipt") v.archive.ledger.receipts.pop();
    expect(() => inspect(v)).toThrow();
  }
});
it("retains a valid historical binding after another policy is adopted", () => {
  adopt(f.archive.ledger, 1, config(), "2026-09-27T04:00:00.000Z");
  expect(inspect(f).records).toEqual(f.records);
});
it("reads the original policy prefix after the same candidate adopts changed configuration", () => {
  const configuration = config();
  configuration.proposedBudget.capUnits = "30000000";
  configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
  adopt(f.archive.ledger, 0, configuration, "2026-09-27T04:00:00.000Z");
  expect(inspect(f).records).toEqual(f.records);
});
it("rejects a later policy backdated before this approval", () => {
  adopt(f.archive.ledger, 1, config(), "2026-09-27T03:33:00.000Z");
  expect(() => inspect(f)).toThrow();
});
function addEvent(
  payload: ProviderExecutionPayload,
  kind: "provider-prepared" | "provider-dispatch" | "provider-finish",
) {
  const ledger = f.archive.ledger,
    runId = f.records[0].runId;
  const events = ledger.events.filter(
    (e: unknown) => (e as ProviderExecutionEvent).runId === runId,
  ) as ProviderExecutionEvent[];
  const command = {
    clientRequestId: randomUUID(),
    expectedRevision: events.length,
    payload: omit(payload, "releasedBudgetEventDigests"),
  } as ProviderExecutionCommand;
  const budget = getProviderExecutionBudgetSnapshot(
    ledger.budgetEvents as Parameters<typeof getProviderExecutionBudgetSnapshot>[0],
    f.plan.rows.receipt.scopeId,
  );
  const event = createProviderExecutionEvent({
    schemaVersion: 2,
    executionContractVersion: 1,
    runId,
    revision: events.length + 1,
    budgetRevision: budget.revision,
    previousEventDigest: events.at(-1)!.eventDigest,
    recordedAt: "2026-09-27T03:35:00.000Z",
    payload,
  });
  ledger.events.push(event);
  ledger.receipts.push(
    createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: f.plan.rows.receipt.scopeId,
      kind,
      clientRequestId: command.clientRequestId,
      inputDigest: providerExecutionOperationDigest(runId, command),
      runId,
      runRevision: event.revision,
      budgetRevision: event.budgetRevision,
      operationDigest: event.eventDigest,
      recordedAt: event.recordedAt,
    }),
  );
  return event;
}
it("preserves event cutover and bound approval after later prepared/dispatch events", () => {
  const legacyCoverage = cutover(f.archive);
  const prep = f.reservation.rows.run.preparation,
    budget = f.input.review.budget;
  const e = addEvent(
    {
      kind: "request-prepared",
      phase: "generation",
      requestDigest: prep.generation.requestDigest,
      artifactSha256: prep.generation.sha256,
      derivedFrom: null,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
    "provider-prepared",
  );
  addEvent(
    {
      kind: "dispatch-intent",
      phase: "generation",
      requestDigest: prep.generation.requestDigest,
      artifactSha256: prep.generation.sha256,
      preparedEventDigest: e.eventDigest,
      approvalEventDigest: f.plan.rows.event.eventDigest,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
    "provider-dispatch",
  );
  expect(inspect(f).records).toEqual(f.records);
  expect(inspect({ ...f, coverage: legacyCoverage, records: [] }).records).toEqual([]);
  f.archive.ledger.events.reverse();
  expect(() => inspect(f)).toThrow();
});
it("reads the original budget prefix after both phases are released and execution stops", () => {
  const legacyCoverage = cutover(f.archive),
    ledger = f.archive.ledger,
    run = f.reservation.rows.run;
  const released: string[] = [];
  for (const phase of ["generation", "review"] as const) {
    const b = getProviderExecutionBudgetSnapshot(
      ledger.budgetEvents as Parameters<typeof getProviderExecutionBudgetSnapshot>[0],
      run.preparation.budget.scopeId,
    );
    const event = createProviderExecutionBudgetEvent({
      schemaVersion: 2,
      scopeId: b.scopeId,
      environment: "production",
      provenance: "explicit-user",
      revision: b.revision + 1,
      previousDigest: b.headDigest,
      eventId: randomUUID(),
      recordedAt: "2026-09-27T03:35:00.000Z",
      currency: b.currency!,
      unitScale: b.unitScale!,
      payload: {
        kind: "release-phase",
        runId: run.id,
        phase,
        reservationDigest: run.reservationDigest,
        releasedUnits: run.preparation.financialBasis.costs![phase].totalUnits,
        reason: "not-dispatched",
      },
    });
    ledger.budgetEvents.push(event);
    released.push(event.eventDigest);
  }
  addEvent(
    {
      kind: "execution-stopped",
      outcome: "before-dispatch",
      failureCode: "INTERRUPTED",
      finalArtifactSha256: null,
      releasedBudgetEventDigests: released,
    },
    "provider-finish",
  );
  expect(inspect(f).reservationArchive.ledger.provider.snapshots[0].state).toBe("before-dispatch");
  expect(inspect({ ...f, coverage: legacyCoverage, records: [] }).records).toEqual([]);
  expect(inspect(f).records[0].approvedReview.budget.heldUnits).toBe("11220000");
});
it("requires bindings for new runs created after cutover and accepts later budget reservations", () => {
  const configuration = config();
  configuration.proposedBudget.capUnits = "30000000";
  configuration.configurationDigest = digest(providerConfigurationDigestInput(configuration));
  const first = transmissionFixture(configuration),
    archive = first.input.current.archive;
  const coverage = cutover(archive),
    p = plan(first.input);
  archive.ledger.events.push(p.rows.event);
  archive.ledger.receipts.push(p.rows.receipt);
  adopt(archive.ledger, 1, configuration, "2026-09-27T03:35:00.000Z");
  const input = first.reservationInput;
  input.runId = randomUUID();
  const registry = input.current.ledger.registries[0];
  input.current.selection = {
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: registry.entries[1].candidateId,
  };
  input.current.inspectedAt = "2026-09-27T03:38:00.000Z";
  refresh(input);
  const r = prepared(input);
  withRows(input, r);
  archive.records.push(r.rows.binding);
  expect(inspect({ archive, coverage, records: [p.rows.binding] }).records).toHaveLength(1);
  const current = {
    ...first.input.current,
    selection: { runId: r.rows.run.id, runDigest: r.rows.run.runDigest },
    inspectedAt: "2026-09-27T03:39:00.000Z",
  };
  const review = transmissionReview(current),
    command = transmissionCommandFor(review);
  command.approval.approvedAt = current.inspectedAt;
  const second = plan({
    command,
    review,
    current,
    additionalUsedBytes: size(coverage) + size(p.rows.binding),
  });
  archive.ledger.events.push(second.rows.event);
  archive.ledger.receipts.push(second.rows.receipt);
  expect(() => inspect({ archive, coverage, records: [p.rows.binding] })).toThrow();
  expect(
    inspect({ archive, coverage, records: [second.rows.binding, p.rows.binding] }).records,
  ).toHaveLength(2);
  expect(() => inspect({ archive, coverage, records: [p.rows.binding, p.rows.binding] })).toThrow();
  // Receipt order is not a migration boundary; the store reads these by nonce.
  archive.ledger.receipts.reverse();
  expect(
    inspect({ archive, coverage, records: [p.rows.binding, second.rows.binding] }).records,
  ).toHaveLength(2);
  const laterCoverage = cutover(archive);
  laterCoverage.cutoverProviderEvents.reverse();
  laterCoverage.coverageDigest = digest(omit(laterCoverage, "coverageDigest"));
  expect(() => inspect({ archive, coverage: laterCoverage, records: [] })).toThrow();
});
function row(record = f.records[0], storage_order = 1) {
  return {
    run_id: record.runId,
    nonce: record.clientRequestId,
    body: JSON.stringify(record),
    body_hash: digest(record),
    storage_order,
  };
}
it("decodes indexed raw bodies and includes encoding overhead", () => {
  const raw = row();
  raw.body = JSON.stringify(f.records[0], null, 2);
  expect(decode([raw])).toEqual({ records: f.records, usedBytes: Buffer.byteLength(raw.body) });
});
it.each([
  { storage_order: 0 },
  { storage_order: 1.5 },
  { run_id: randomUUID() },
  { nonce: randomUUID() },
  { body_hash: wrong },
  { body: "{" },
  { body: " ".repeat(128 * 1024 + 1) },
])("rejects malformed/index-mismatched raw row %#", (change) => {
  expect(() => decode([{ ...row(), ...change }])).toThrow();
});
it("rejects repeated or reversed raw row insertion order and excess records", () => {
  expect(() => decode([row(), row()])).toThrow();
  expect(() => decode([row(f.records[0], 2), row()])).toThrow();
  expect(() => decode(Array.from({ length: 21 }, (_, i) => row(f.records[0], i + 1)))).toThrow();
});
