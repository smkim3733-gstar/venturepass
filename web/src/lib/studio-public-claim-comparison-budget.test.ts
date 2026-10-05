import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { inspectQualityDatabase, inspectQualitySuppliedRows } from "../../scripts/local-data-quality.mjs";
import { inspectQualitySchema } from "../../scripts/local-data-quality-schema.mjs";
import { readProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { readProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { getProviderExecutionBudgetSnapshot } from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  createPublicComparisonCoverage, inspectPublicComparisonCoverage, inspectPublicComparisonBudget,
  lookupPublicComparisonNonce, createPublicComparisonBudgetEvent, publicComparisonBudgetInputDigest,
  publicComparisonPrefixRowsSchema,
  type PublicComparisonPrefix, type PublicComparisonCoverage, type PublicComparisonBudgetSuffix,
  type PublicComparisonBudgetEvent,
} from "./studio-public-claim-comparison-budget";

vi.mock("server-only", () => ({}));
// Explicit historical fixture for archived synthetic rows; never refresh current operating evidence.
vi.mock("./studio-plan-quality-provider-configuration-current", () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"));
const guard = vi.hoisted(() => ({ enabled: false }));
const forbidden = vi.hoisted(() => vi.fn(() => { throw Error("IO forbidden"); }));
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      if (guard.enabled) forbidden();
      super(...args);
    }
  } };
});
vi.mock("openai", () => ({ default: class { constructor() { forbidden(); } } }));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
let directory: string, prefix: PublicComparisonPrefix, unsettled: PublicComparisonPrefix, coverage: PublicComparisonCoverage;
let sqlSnapshot: ReturnType<typeof inspectQualityDatabase>;
const h = (s: string) => digest(s);
const empty = (): PublicComparisonBudgetSuffix => ({ events: [], receipts: [], evidence: [] });
function read(db: DatabaseSync): PublicComparisonPrefix {
  const rows = publicComparisonPrefixRowsSchema.parse({
    schema: inspectQualitySchema(db).schema,
    runRows: db.prepare("SELECT id,body,body_hash FROM quality_runs ORDER BY id").all(),
    revisionRows: db.prepare("SELECT run_id,revision,body,body_hash FROM quality_revisions ORDER BY run_id,revision").all(),
    receiptRows: db.prepare("SELECT nonce,body,body_hash FROM quality_requests ORDER BY nonce").all(),
    candidateRows: db.prepare("SELECT set_id,version,body,body_hash FROM quality_candidate_versions ORDER BY set_id,version").all(),
    candidateReceipts: db.prepare("SELECT nonce,body,body_hash FROM quality_candidate_requests ORDER BY nonce").all(),
    executionRows: db.prepare("SELECT id,body,body_hash FROM quality_execution_runs ORDER BY id").all(),
    executionEvents: db.prepare("SELECT run_id,revision,body,body_hash FROM quality_execution_events ORDER BY run_id,revision").all(),
    executionReceipts: db.prepare("SELECT nonce,body,body_hash FROM quality_execution_requests ORDER BY nonce").all(),
    policyRows: db.prepare("SELECT rowid AS storage_order,scope_id,revision,nonce,body,body_hash FROM quality_provider_policies ORDER BY rowid").all(),
    reservationRows: (({ bindingRows, coverageRows }) => ({ bindingRows, coverageRows }))(readProviderReservationDatabaseRows(db)),
    transmissionRows: (({ bindingRows, coverageRows }) => ({ bindingRows, coverageRows }))(readProviderTransmissionApprovalDatabaseRows(db)),
    actualRows: {
      budget: db.prepare("SELECT scope_id,revision,body,body_hash FROM quality_actual_budget_events ORDER BY scope_id,revision").all(),
      runs: db.prepare("SELECT id,body,body_hash FROM quality_actual_runs ORDER BY id").all(),
      runOrder: db.prepare("SELECT rowid AS storage_order,id FROM quality_actual_runs ORDER BY rowid").all(),
      events: db.prepare("SELECT run_id,revision,body,body_hash FROM quality_actual_events ORDER BY run_id,revision").all(),
      artifacts: db.prepare("SELECT run_id,artifact_key,payload,sha256,size_bytes FROM quality_actual_artifacts ORDER BY run_id,artifact_key").all(),
      receipts: db.prepare("SELECT nonce,body,body_hash FROM quality_actual_requests ORDER BY nonce").all(),
    },
  });
  const reservationRows = readProviderReservationDatabaseRows(db);
  const transmissionRows = readProviderTransmissionApprovalDatabaseRows(db);
  const audited = inspectQualitySuppliedRows({
    ...rows, reservationRows, transmissionRows, storageVersion: 9,
    candidates: true, executions: true, actual: true, policies: true, reservations: true, transmissions: true,
    providerPrefix: null, operational: false,
  });
  return {
    storageVersion: 9, databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
    environment: "production", scopeId: "candidate-quality-provider-v2-live", rows,
    decoded: { ledger: audited.ledger, reservationCoverage: reservationRows.coverage, reservationRecords: reservationRows.records,
      transmissionCoverage: transmissionRows.coverage, transmissionRecords: transmissionRows.records },
  };
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(actualTestNow); vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-purpose-contract-"));
  const store = new PlanQualityStore(directory, { providerEnvironment: "synthetic-test" });
  try {
    store.candidateRegistryRegister({ expectedVersion: 0, clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest, acknowledgedCandidateStatus: true });
    const f = await finalizationStoreFixture(store);
    const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    try {
      unsettled = read(db);
      store.providerRecordFinalization(f.identity);
      prefix = read(db);
      sqlSnapshot = inspectQualityDatabase(db);
    } finally { db.close(); }
  } finally { store.close(); }
  // All following contracts run with both DB access methods forbidden, and the fixture closed.
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(forbidden);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(forbidden);
  guard.enabled = true;
  coverage = createPublicComparisonCoverage(prefix);
}, 30000);
beforeEach(() => {
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(forbidden);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(forbidden);
});
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  if (directory) {
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel.startsWith("venture-purpose-contract-") || rel.includes("..")) throw Error("Unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
function append(s: PublicComparisonBudgetSuffix, payload: PublicComparisonBudgetEvent["payload"]) {
  const b = coverage.budgets.find(v => v.scopeId === prefix.scopeId)!;
  const event = createPublicComparisonBudgetEvent({
    schemaVersion: 3, purpose: "compare-public-claim", scopeId: prefix.scopeId, environment: prefix.environment,
    provenance: "explicit-user", currency: b.currency!, unitScale: b.unitScale!,
    revision: (s.events.at(-1)?.revision ?? b.revision) + 1,
    previousDigest: s.events.at(-1)?.eventDigest ?? b.headDigest!,
    eventId: randomUUID(), recordedAt: actualTestNow, payload,
  });
  s.events.push(event);
  s.receipts.push({ schemaVersion: 3, purpose: "compare-public-claim", scopeId: prefix.scopeId,
    clientRequestId: randomUUID(), runId: payload.runId, inputDigest: publicComparisonBudgetInputDigest(event),
    budgetRevision: event.revision, operationDigest: event.eventDigest, recordedAt: event.recordedAt });
  return event;
}
function reserved(units = "1000") {
  const s = empty(), runId = randomUUID(), requestDigest = h("request"), manifestDigest = h("manifest");
  s.evidence.push({ runId, requestDigest, manifestDigest, dispatchEventDigest: null,
    responseArtifactSha256: null, cancellationEventDigest: null, assessment: null });
  append(s, { kind: "reserve-comparison", runId, requestDigest, manifestDigest, reservedUnits: units });
  return s;
}
function release(s: PublicComparisonBudgetSuffix) {
  const proof = s.evidence[0], first = s.events[0];
  if (first.payload.kind !== "reserve-comparison") throw Error("fixture");
  proof.cancellationEventDigest = h("cancel");
  append(s, { kind: "release-comparison", runId: proof.runId, reservationDigest: first.eventDigest,
    reason: "not-dispatched", cancellationEventDigest: proof.cancellationEventDigest, releasedUnits: first.payload.reservedUnits });
}
function recognize(s: PublicComparisonBudgetSuffix, cost = "200") {
  const proof = s.evidence[0], first = s.events[0];
  if (first.payload.kind !== "reserve-comparison") throw Error("fixture");
  proof.dispatchEventDigest = h("dispatch"); proof.responseArtifactSha256 = h("response");
  proof.assessment = { status: "known", units: cost, requestDigest: proof.requestDigest,
    dispatchEventDigest: proof.dispatchEventDigest, responseArtifactSha256: proof.responseArtifactSha256,
    requestedTier: null, violations: [] };
  const hold = BigInt(first.payload.reservedUnits), c = BigInt(cost), consumed = c < hold ? c : hold;
  append(s, { kind: "recognize-comparison-usage", runId: proof.runId, reservationDigest: first.eventDigest,
    dispatchEventDigest: proof.dispatchEventDigest, responseArtifactSha256: proof.responseArtifactSha256,
    usageAssessmentDigest: digest(proof.assessment), recognizedUnits: cost,
    consumedHeldUnits: consumed.toString(), releasedHeldUnits: (hold - consumed).toString(),
    boundExcessUnits: (c > hold ? c - hold : BigInt(0)).toString() });
}
function inspect(s: PublicComparisonBudgetSuffix) { return inspectPublicComparisonBudget(prefix, coverage, s); }
it("shares the full frozen SQL-row audit and preserves nonzero legacy money and all raw rows", () => {
  const before = digest(prefix);
  expect(coverage.prefix).toEqual(sqlSnapshot);
  const old = getProviderExecutionBudgetSnapshot(
    prefix.rows.actualRows.budget.map(v => JSON.parse(v.body)), prefix.scopeId);
  expect(BigInt(old.recognizedUnits)).toBeGreaterThan(BigInt(0));
  expect(inspect(empty())).toMatchObject({ revision: old.revision, headDigest: old.headDigest,
    capUnits: old.capUnits, recognizedUnits: old.recognizedUnits, heldUnits: "0" });
  expect(digest(prefix)).toBe(before);
  expect(Object.values(coverage.authority).every(v => v === false)).toBe(true);
});
it("requires terminal old execution even after its usage has settled", () => {
  expect(() => createPublicComparisonCoverage(unsettled)).toThrow();
});
it.each([
  ["version", (p: PublicComparisonPrefix) => Object.assign(p, { storageVersion: 10 })],
  ["instance", (p: PublicComparisonPrefix) => { p.databaseInstanceId = randomUUID(); }],
  ["scope", (p: PublicComparisonPrefix) => { p.scopeId = "candidate-quality-provider-v2-synthetic"; }],
  ["schema identity", (p: PublicComparisonPrefix) => { p.rows.schema[0].sql += " "; }],
  ["raw byte encoding", (p: PublicComparisonPrefix) => { p.rows.actualRows.runs[0].body += " "; }],
  ["raw hash", (p: PublicComparisonPrefix) => { p.rows.actualRows.runs[0].body_hash = h("changed"); }],
  ["run key", (p: PublicComparisonPrefix) => { p.rows.actualRows.runs[0].id = randomUUID(); }],
  ["order", (p: PublicComparisonPrefix) => { p.rows.actualRows.budget.reverse(); }],
  ["duplicate row", (p: PublicComparisonPrefix) => { p.rows.actualRows.receipts.push(p.rows.actualRows.receipts[0]); }],
  ["dropped receipt", (p: PublicComparisonPrefix) => { p.rows.actualRows.receipts.pop(); }],
  ["insertion order", (p: PublicComparisonPrefix) => { p.rows.actualRows.runOrder[0].storage_order++; }],
  ["missing reservation coverage", (p: PublicComparisonPrefix) => { p.rows.reservationRows.coverageRows.pop(); }],
  ["transmission coverage hash", (p: PublicComparisonPrefix) => { p.rows.transmissionRows.coverageRows[0].body_hash = h("changed"); }],
  ["artifact byte", (p: PublicComparisonPrefix) => { p.rows.actualRows.artifacts[0].payload[0] ^= 1; }],
  ["decoded copy", (p: PublicComparisonPrefix) => { p.decoded.ledger = {}; }],
  ["candidate nonce", (p: PublicComparisonPrefix) => { p.rows.candidateReceipts[0].nonce = randomUUID(); }],
  ["unknown field", (p: PublicComparisonPrefix) => Object.assign(p, { apiKey: "forbidden" })],
])("rejects supplied prefix/coverage drift: %s", (_, mutate) => {
  const p = structuredClone(prefix); mutate(p);
  expect(() => inspectPublicComparisonCoverage(p, coverage)).toThrow();
});
it("returns detached coverage without making supplied schema/instance physical evidence", () => {
  const c = createPublicComparisonCoverage(prefix); c.budgets[0].capUnits = "999";
  expect(createPublicComparisonCoverage(prefix)).toEqual(coverage);
  expect(() => inspectPublicComparisonCoverage(prefix, c)).toThrow();
});
it.each(["getter", "toJSON", "cycle", "undefined"] as const)("rejects inactive object hazards without calling them: %s", kind => {
  const p = structuredClone(prefix);
  if (kind === "getter") Object.defineProperty(p, "rows", { get: forbidden });
  if (kind === "toJSON") Object.assign(p, { toJSON: forbidden });
  if (kind === "cycle") Object.assign(p, { cycle: p });
  if (kind === "undefined") Object.assign(p, { extra: undefined });
  expect(() => createPublicComparisonCoverage(p)).toThrow();
  expect(forbidden).not.toHaveBeenCalled();
});
it("extends the original head, holds unknown costs and reserves remaining slots without double counting", () => {
  const s = reserved(), result = inspect(s);
  expect(result.heldUnits).toBe("1000");
  expect(result.recognizedUnits).toBe(inspect(empty()).recognizedUnits);
  expect(result.capacity).toMatchObject({ comparisonReservedBytes: 32 * 1024 * 1024, reservedBudgetSlots: 15, reservedReceiptSlots: 63 });
  expect(result.revision).toBe(inspect(empty()).revision + 1);
  expect(result.authority.dispatchAllowed).toBe(false);
  s.evidence[0].dispatchEventDigest = h("unknown dispatch");
  expect(inspect(s).heldUnits).toBe("1000");
});
it("releases only the original reservation with supplied cancellation and no dispatch evidence", () => {
  const s = reserved(); release(s);
  expect(inspect(s)).toMatchObject({ heldUnits: "0", recognizedUnits: inspect(empty()).recognizedUnits });
  s.evidence[0].dispatchEventDigest = h("already dispatched");
  expect(() => inspect(s)).toThrow();
});
it("recognizes known supplied amounts once, retaining null requested tier and false assessment authority", () => {
  const s = reserved(); recognize(s);
  expect(inspect(s)).toMatchObject({ heldUnits: "0",
    recognizedUnits: (BigInt(inspect(empty()).recognizedUnits) + BigInt(200)).toString(),
    boundBreached: false, authority: { costAssessmentVerified: false, executionLifecycleVerified: false } });
  expect(s.evidence[0].assessment!.requestedTier).toBeNull();
});
it("keeps missing assessment held and never substitutes usage zero", () => {
  const s = reserved(); s.evidence[0].dispatchEventDigest = h("d"); s.evidence[0].responseArtifactSha256 = h("r");
  expect(inspect(s).heldUnits).toBe("1000");
  recognize(s, "0"); s.evidence[0].assessment = null;
  expect(() => inspect(s)).toThrow();
});
it("reports excess and deficit explicitly, blocking a subsequent reservation", () => {
  const s = reserved(), cap = inspect(empty()).capUnits;
  recognize(s, (BigInt(cap) + BigInt(1)).toString());
  const r = inspect(s);
  expect(r.boundBreached).toBe(true); expect(BigInt(r.deficitUnits)).toBeGreaterThan(BigInt(0));
  expect(r.availableUnits).toBe("0");
  addAnother(s);
  expect(() => inspect(s)).toThrow();
});
function addAnother(s: PublicComparisonBudgetSuffix) {
  const base = reserved();
  s.evidence.push(base.evidence[0]); append(s, base.events[0].payload);
}
it("blocks another run while the first financial reservation is unresolved", () => {
  const s = reserved(); addAnother(s); expect(() => inspect(s)).toThrow();
});
it.each([
  ["wrong scope", (s: PublicComparisonBudgetSuffix) => { s.events[0].scopeId = "candidate-quality-provider-v2-synthetic"; }],
  ["wrong previous head", (s: PublicComparisonBudgetSuffix) => { s.events[0].previousDigest = h("wrong"); }],
  ["wrong revision", (s: PublicComparisonBudgetSuffix) => { s.events[0].revision++; }],
  ["wrong event hash", (s: PublicComparisonBudgetSuffix) => { s.events[0].eventDigest = h("wrong"); }],
  ["old schema", (s: PublicComparisonBudgetSuffix) => Object.assign(s.events[0], { schemaVersion: 2 })],
  ["old phase", (s: PublicComparisonBudgetSuffix) => Object.assign(s.events[0].payload, { phase: "generation" })],
  ["new scope initialization", (s: PublicComparisonBudgetSuffix) => Object.assign(s.events[0].payload, { kind: "configure" })],
  ["duplicate nonce", (s: PublicComparisonBudgetSuffix) => { s.receipts[1].clientRequestId = s.receipts[0].clientRequestId; }],
  ["legacy nonce", (s: PublicComparisonBudgetSuffix) => { s.receipts[0].clientRequestId = prefix.rows.candidateReceipts[0].nonce; }],
  ["receipt digest", (s: PublicComparisonBudgetSuffix) => { s.receipts[0].inputDigest = h("wrong"); }],
  ["extra receipt", (s: PublicComparisonBudgetSuffix) => { s.receipts.push(s.receipts[0]); }],
  ["duplicate proof", (s: PublicComparisonBudgetSuffix) => { s.evidence.push(s.evidence[0]); }],
  ["model price inference", (s: PublicComparisonBudgetSuffix) => Object.assign(s.evidence[0].assessment!, { tokenPrice: 0 })],
  ["usage amount", (s: PublicComparisonBudgetSuffix) => { s.evidence[0].assessment!.units = "0"; }],
  ["request proof", (s: PublicComparisonBudgetSuffix) => { s.evidence[0].requestDigest = h("other"); }],
  ["capture proof", (s: PublicComparisonBudgetSuffix) => { s.evidence[0].responseArtifactSha256 = h("other"); }],
  ["both cancellation and dispatch", (s: PublicComparisonBudgetSuffix) => { s.evidence[0].cancellationEventDigest = h("cancel"); }],
])("rejects suffix identity/evidence defects: %s", (_, mutate) => {
  const s = reserved(); recognize(s); mutate(s);
  expect(() => inspect(s)).toThrow();
});
it("rejects duplicate settlement even with correctly recomputed event and receipt digests", () => {
  const s = reserved(); recognize(s); append(s, s.events[1].payload); expect(() => inspect(s)).toThrow();
});
it("rejects duplicate reserve even after a completed release", () => {
  const s = reserved(); release(s); append(s, s.events[0].payload); expect(() => inspect(s)).toThrow();
});
it("rejects a monetary reservation beyond remaining cap without changing old cap", () => {
  expect(() => inspect(reserved(inspect(empty()).capUnits))).toThrow();
});
it("conservatively keeps full native storage capacity pending future lifecycle audit", () => {
  const s = reserved(); release(s);
  for (let i = 1; i < 8; i++) {
    addAnother(s);
    const proof = s.evidence[i], event = s.events.at(-1)!;
    proof.cancellationEventDigest = h("cancel" + i);
    append(s, { kind: "release-comparison", runId: proof.runId, reservationDigest: event.eventDigest,
      reason: "not-dispatched", cancellationEventDigest: proof.cancellationEventDigest, releasedUnits: "1000" });
    if (i < 7) expect(inspect(s).capacity.comparisonReservedBytes).toBe((i + 1) * 32 * 1024 * 1024);
  }
  expect(() => inspect(s)).toThrow("PUBLIC_COMPARISON_ARCHIVE_LIMIT");
});
it("replays only the same original nonce command, including historical candidate receipts", () => {
  const s = reserved(), r = s.receipts[0], before = digest(s);
  expect(lookupPublicComparisonNonce(prefix, coverage, s, { nonce: r.clientRequestId, inputDigest: r.inputDigest })).toMatchObject({ status: "replay", record: r });
  expect(() => lookupPublicComparisonNonce(prefix, coverage, s, { nonce: r.clientRequestId, inputDigest: h("other") })).toThrow("NONCE_CONFLICT");
  const row = prefix.rows.candidateReceipts[0], old = JSON.parse(row.body);
  expect(lookupPublicComparisonNonce(prefix, coverage, s, { nonce: row.nonce, inputDigest: old.inputDigest })).toMatchObject({ status: "replay", record: old });
  expect(lookupPublicComparisonNonce(prefix, coverage, s, { nonce: randomUUID(), inputDigest: h("new") }).status).toBe("not-observed");
  expect(digest(s)).toBe(before);
});
it("returns detached budget and replay copies, with no new owner or current settings dependency", () => {
  const s = reserved(), r = s.receipts[0], first = inspect(s);
  first.reservations[0].heldUnits = "0";
  expect(inspect(s).heldUnits).toBe("1000");
  const replay = lookupPublicComparisonNonce(prefix, coverage, s, { nonce: r.clientRequestId, inputDigest: r.inputDigest });
  Object.assign(replay.record!, { inputDigest: h("changed") });
  expect(lookupPublicComparisonNonce(prefix, coverage, s, { nonce: r.clientRequestId, inputDigest: r.inputDigest })).toMatchObject({ record: r });
});

function reseal(s: PublicComparisonBudgetSuffix) {
  let head = coverage.budgets.find(v => v.scopeId === prefix.scopeId)!.headDigest!;
  for (let i = 0; i < s.events.length; i++) {
    const { eventDigest: previous, ...raw } = s.events[i];
    const e = createPublicComparisonBudgetEvent({ ...raw, previousDigest: head });
    s.events[i] = e;
    Object.assign(s.receipts[i], { inputDigest: publicComparisonBudgetInputDigest(e), operationDigest: e.eventDigest });
    if (i === 0) for (const later of s.events.slice(1)) {
      if (later.payload.kind !== "reserve-comparison" && later.payload.reservationDigest === previous) later.payload.reservationDigest = e.eventDigest;
    }
    head = e.eventDigest;
  }
}
it.each(["consumedHeldUnits", "releasedHeldUnits", "boundExcessUnits", "recognizedUnits"] as const)(
  "checks BigInt arithmetic after valid hashes: %s", field => {
    const s = reserved(); recognize(s);
    if (s.events[1].payload.kind !== "recognize-comparison-usage") throw Error("fixture");
    s.events[1].payload[field] = "987";
    reseal(s);
    expect(() => inspect(s)).toThrow();
  });
it("keeps explicit zero distinct from missing usage and refuses assessment violations on later reserve", () => {
  const s = reserved(); recognize(s, "0");
  expect(inspect(s).recognizedUnits).toBe(inspect(empty()).recognizedUnits);
  s.evidence[0].assessment!.violations = ["unsupported-report"];
  if (s.events[1].payload.kind !== "recognize-comparison-usage") throw Error("fixture");
  s.events[1].payload.usageAssessmentDigest = digest(s.evidence[0].assessment);
  reseal(s);
  expect(inspect(s).boundBreached).toBe(true);
  addAnother(s); expect(() => inspect(s)).toThrow();
});
it("rejects released amount mismatch after hashes are recomputed", () => {
  const s = reserved(); release(s);
  if (s.events[1].payload.kind !== "release-comparison") throw Error("fixture");
  s.events[1].payload.releasedUnits = "999"; reseal(s);
  expect(() => inspect(s)).toThrow();
});
it("binds historical policy nonce to its original request digest, not its record hash", () => {
  const row = prefix.rows.policyRows[0], record = JSON.parse(row.body);
  expect(lookupPublicComparisonNonce(prefix, coverage, empty(), { nonce: row.nonce, inputDigest: record.requestDigest })).toMatchObject({ status: "replay", record });
  expect(() => lookupPublicComparisonNonce(prefix, coverage, empty(), { nonce: row.nonce, inputDigest: record.recordDigest })).toThrow("NONCE_CONFLICT");
});
it("accepts a supplied schema change only as a different proposal, never as SQL DDL verification", () => {
  const p = structuredClone(prefix); p.rows.schema[0].sql += " ";
  const other = createPublicComparisonCoverage(p);
  expect(other.coverageDigest).not.toBe(coverage.coverageDigest);
  expect(other.authority.sqlSchemaVerified).toBe(false);
});
it("rejects custom array fields and functions without silently dropping them", () => {
  const s = reserved(); Object.assign(s.events, { extra: "hidden" });
  expect(() => inspect(s)).toThrow();
});
it("does not use elapsed time or current server policy to revive a historical permission", () => {
  vi.setSystemTime("2040-01-01T00:00:00.000Z");
  expect(createPublicComparisonCoverage(prefix)).toEqual(coverage);
  expect(inspect(empty()).authority.approvalGranted).toBe(false);
});

it("rejects custom typed-array accessors before reading them", () => {
  const p = structuredClone(prefix);
  Object.defineProperty(p.rows.actualRows.artifacts[0].payload, "byteLength", { get: forbidden });
  expect(() => createPublicComparisonCoverage(p)).toThrow();
  expect(forbidden).not.toHaveBeenCalled();
});
it("rejects reusing an original budget event id even with new valid hashes", () => {
  const s = reserved(); s.events[0].eventId = JSON.parse(prefix.rows.actualRows.budget[0].body).eventId;
  reseal(s); expect(() => inspect(s)).toThrow();
});
