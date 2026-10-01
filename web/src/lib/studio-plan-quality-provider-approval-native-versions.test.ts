/** Native synthetic in-memory approval records. No durable approval or supplier request. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { beforeAll, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { versionedTransmissionFixture } from "./studio-plan-quality-provider-transmission-version-test-helpers";
import * as core from "../../scripts/local-data-quality-provider.mjs";
import * as frozen from "../../scripts/local-data-quality-provider-reservation-ledger.mjs";
import {
  createProviderTransmissionApprovalMigrationCoverage,
  inspectProviderTransmissionApprovalArchive,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { inspectVersionedProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import { inspectQualityLedgers } from "../../scripts/local-data-quality-ledgers.mjs";
import type {
  VersionedProviderRun,
  StoredProviderRunEvent,
  ProviderArtifact,
  ProviderBudgetEvent,
  ProviderReceipt,
} from "./studio-plan-quality-provider-types";

let baseline: ReturnType<typeof versionedTransmissionFixture>;
beforeAll(() => {
  baseline = versionedTransmissionFixture();
}, 15000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
function fixture() {
  const input = structuredClone(baseline.input);
  const result = baseline.server.transmissionReview(input);
  if (
    result.status !== "review" ||
    result.review.schemaVersion !== 2 ||
    !result.review.budget.headDigest
  )
    throw Error("Expected v2");
  const review = result.review;
  const run = input.archive.ledger.runs[0] as VersionedProviderRun;
  const command = core.versionedProviderApprovalCommandSchema.parse({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    payload: {
      kind: "transmission-approved",
      manifest: review.manifest,
      provenance: "explicit-user",
      approvedAt: "2026-09-27T03:33:30.000Z",
      expiresAt: review.expiresAt,
      acknowledgedExternalTransmission: true,
      acknowledgedGenerationAndDerivedReview: true,
      acknowledgedRetentionNoticeDigest: run.preparation.retentionDigest,
      acknowledgedFinancialReservationNotTokenFit: true,
      acknowledgedUnknownCostHoldAndNoRetry: true,
      budgetRevision: review.budget.revision,
      budgetDigest: review.budget.headDigest,
    },
  });
  const event = core.createVersionedProviderApprovalEvent({
    schemaVersion: 2,
    executionContractVersion: 2,
    runId: run.id,
    revision: 1,
    budgetRevision: review.budget.revision,
    previousEventDigest: null,
    recordedAt: "2026-09-27T03:34:00.000Z",
    payload: command.payload,
  });
  const receipt = core.createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: run.preparation.budget.scopeId,
    kind: "provider-approve",
    clientRequestId: command.clientRequestId,
    inputDigest: core.versionedProviderApprovalOperationDigest(run.id, command),
    runId: run.id,
    runRevision: 1,
    budgetRevision: event.budgetRevision,
    operationDigest: event.eventDigest,
    recordedAt: event.recordedAt,
  });
  input.archive.ledger.events.push(event);
  input.archive.ledger.receipts.push(receipt);
  return { input, run, command, event, receipt };
}
type Fixture = ReturnType<typeof fixture>;
function native(f: Fixture) {
  const ledger = f.input.archive.ledger;
  return {
    runs: ledger.runs as VersionedProviderRun[],
    events: ledger.events as StoredProviderRunEvent[],
    artifacts: ledger.artifacts as ProviderArtifact[],
    budgetEvents: ledger.budgetEvents as ProviderBudgetEvent[],
    receipts: ledger.receipts as ProviderReceipt[],
    registries: ledger.registries,
    otherNonces: ledger.policies!.map((p) => (p as { clientRequestId: string }).clientRequestId),
  };
}
function read(f: Fixture) {
  return core.inspectVersionedProviderLedger(native(f));
}
function relink(f: Fixture) {
  f.event.eventDigest = core.providerDigest(without(f.event, "eventDigest"));
  f.receipt.operationDigest = f.event.eventDigest;
  f.receipt.recordedAt = f.event.recordedAt;
  f.receipt.budgetRevision = f.event.budgetRevision;
  f.receipt.inputDigest = core.versionedProviderApprovalOperationDigest(f.run.id, {
    ...f.command,
    payload: f.event.payload,
  });
}

it("reads explicit v2 native approval as snapshot5 without changing money, request bytes or authority", () => {
  const f = fixture(),
    before = JSON.stringify(f.input.archive.ledger.budgetEvents);
  const result = read(f);
  expect(result.snapshots[0]).toMatchObject({
    archiveFormatVersion: 5,
    state: "approved",
    revision: 1,
    dispatchAllowed: false,
    canResume: false,
    terminal: false,
    unsettled: true,
    dispatchIntentCount: 0,
    responseCount: 0,
    unobservedDispatchCount: 0,
    eligibleForNewCandidateRun: false,
  });
  expect(result.snapshots[0].run.archiveFormatVersion).toBe(3);
  expect(result.budgets.find((b) => b.environment === "production")).toMatchObject({
    recognizedUnits: "0",
    heldUnits: f.run.preparation.financialBasis.costs!.totalUnits,
  });
  expect(JSON.stringify(f.input.archive.ledger.budgetEvents)).toBe(before);
  expect(native(f).artifacts[0].body).toBe(JSON.stringify(f.run.preparation.generation.body));
  expect(inspectQualityLedgers(f.input.archive.ledger).provider.snapshots[0]).toEqual(
    result.snapshots[0],
  );
  expect(
    inspectVersionedProviderReservationArchive(f.input.archive).ledger.provider.snapshots[0],
  ).toEqual(result.snapshots[0]);
});

it("counts v2 production approval as requiring an upper binding and refuses missing or legacy coverage", () => {
  const f = fixture();
  const prefix = structuredClone(f.input.archive);
  prefix.ledger.runs = [];
  prefix.ledger.events = [];
  prefix.ledger.artifacts = [];
  prefix.ledger.budgetEvents = prefix.ledger.budgetEvents.slice(0, 1);
  prefix.ledger.receipts = prefix.ledger.receipts.slice(0, 1);
  prefix.records = [];
  const coverage = createProviderTransmissionApprovalMigrationCoverage(prefix);
  expect(() =>
    inspectProviderTransmissionApprovalArchive({ archive: f.input.archive, coverage, records: [] }),
  ).toThrow("PROVIDER_TRANSMISSION_APPROVAL_ARCHIVE_INVALID");
  expect(() => createProviderTransmissionApprovalMigrationCoverage(f.input.archive)).toThrow();
});

it("leaves the old native event, command and reservation reader closed to v2", () => {
  const f = fixture();
  expect(core.providerExecutionEventSchema.safeParse(f.event).success).toBe(false);
  expect(core.providerExecutionCommandSchema.safeParse(f.command).success).toBe(false);
  expect(() => core.inspectProviderLedger(native(f) as never)).toThrow();
  expect(() => frozen.inspectProviderLedger(native(f) as never)).toThrow();
  expect(() => core.providerExecutionOperationDigest(f.run.id, f.command as never)).toThrow();
});

it("binds the explicit execution version into the original nonce input digest", () => {
  const f = fixture();
  const oldDigest = core.providerDigest({
    kind: "provider-execution-operation",
    runId: f.run.id,
    clientRequestId: f.command.clientRequestId,
    expectedRevision: 0,
    payload: f.command.payload,
    artifact: null,
  });
  expect(f.receipt.inputDigest).not.toBe(oldDigest);
  f.receipt.inputDigest = oldDigest;
  expect(() => read(f)).toThrow();
});

it.each(["missing", "duplicate", "nonce", "operation", "revision", "scope"])(
  "rejects %s receipt evidence",
  (change) => {
    const f = fixture();
    if (change === "missing") f.input.archive.ledger.receipts.pop();
    if (change === "duplicate") f.input.archive.ledger.receipts.push(structuredClone(f.receipt));
    if (change === "nonce") f.receipt.clientRequestId = f.run.clientRequestId;
    if (change === "operation") f.receipt.operationDigest = "a".repeat(64);
    if (change === "revision") f.receipt.runRevision = 2;
    if (change === "scope") f.receipt.scopeId = "candidate-quality-provider-v2-synthetic";
    expect(() => read(f)).toThrow();
  },
);

it.each(["previous", "revision", "version", "run", "digest", "second"])(
  "rejects %s event identity or chain",
  (change) => {
    const f = fixture();
    if (change === "previous") Object.assign(f.event, { previousEventDigest: "a".repeat(64) });
    if (change === "revision") Object.assign(f.event, { revision: 2 });
    if (change === "version") Object.assign(f.event, { executionContractVersion: 1 });
    if (change === "run") f.event.runId = randomUUID();
    if (change === "digest") f.event.eventDigest = "b".repeat(64);
    if (change === "second") f.input.archive.ledger.events.push(structuredClone(f.event));
    expect(() => read(f)).toThrow();
  },
);

it.each([
  "before-reservation",
  "recorded-before-approval",
  "expired",
  "past-preparation",
  "budget",
  "retention",
  "provenance",
])("rejects resealed %s approval", (change) => {
  const f = fixture();
  if (change === "before-reservation") f.event.payload.approvedAt = "2026-09-27T03:31:59.999Z";
  if (change === "recorded-before-approval") f.event.recordedAt = "2026-09-27T03:33:29.999Z";
  if (change === "expired") f.event.recordedAt = f.event.payload.expiresAt;
  if (change === "past-preparation") f.event.payload.expiresAt = "2026-09-30T00:00:00.000Z";
  if (change === "budget") f.event.payload.budgetDigest = "a".repeat(64);
  if (change === "retention") f.event.payload.acknowledgedRetentionNoticeDigest = "a".repeat(64);
  if (change === "provenance") f.event.payload.provenance = "synthetic-test";
  relink(f);
  expect(() => read(f)).toThrow();
});

it.each([
  "acknowledgedExternalTransmission",
  "acknowledgedGenerationAndDerivedReview",
  "acknowledgedFinancialReservationNotTokenFit",
  "acknowledgedUnknownCostHoldAndNoRetry",
])("requires %s", (key) => {
  const f = fixture();
  Object.assign(f.event.payload, { [key]: false });
  expect(() => read(f)).toThrow();
});

it.each([
  "request-prepared",
  "dispatch-intent",
  "response-received",
  "domain-validated",
  "execution-stopped",
])("does not accept unsupported v2 %s events", (kind) => {
  const f = fixture();
  Object.assign(f.event.payload, { kind });
  expect(() => read(f)).toThrow();
});

it("rejects extra response artifacts and a native run format downgrade", () => {
  const f = fixture();
  f.input.archive.ledger.artifacts.push(
    core.createProviderExecutionArtifact({
      runId: f.run.id,
      key: "generation-response",
      body: "{}",
    }),
  );
  expect(() => read(f)).toThrow();
  f.input.archive.ledger.artifacts.pop();
  Object.assign(f.run, { archiveFormatVersion: 2 });
  expect(() => read(f)).toThrow();
});

it("checks exact original generation bytes despite a rehashed artifact", () => {
  const f = fixture(),
    artifact = native(f).artifacts[0];
  artifact.body += " ";
  artifact.sha256 = core.providerRawDigest(artifact.body);
  artifact.sizeBytes = Buffer.byteLength(artifact.body);
  expect(() => read(f)).toThrow();
});

it("reads the stored v2 approval in a cold Node process without current prompt, clock or SDK", () => {
  const f = fixture();
  const url = pathToFileURL(resolve("scripts/local-data-quality-provider.mjs")).href;
  const script =
    'import fs from "node:fs"; import {inspectVersionedProviderLedger} from ' +
    JSON.stringify(url) +
    '; Date.now=()=>{throw Error("Clock forbidden")};globalThis.fetch=()=>{throw Error("IO forbidden")};const value=inspectVersionedProviderLedger(JSON.parse(fs.readFileSync(0,"utf8")));process.stdout.write(JSON.stringify(value));';
  const cold = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify(native(f)),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  expect(cold).toEqual(read(f));
});

it("reports an already approved v2 run as blocked for a new first approval", () => {
  const f = fixture();
  const result = baseline.server.transmissionReview({
    ...f.input,
    inspectedAt: f.event.recordedAt,
  });
  expect(result.status).toBe("review");
  if (result.status !== "review") return;
  expect(result.review.run).toMatchObject({
    archiveFormatVersion: 5,
    revision: 1,
    state: "approved",
  });
  expect(result.review.assessment).toEqual({ state: "blocked", blockers: ["run-not-reserved"] });
  expect(Object.values(result.review.actions)).toEqual([false, false, false]);
});
