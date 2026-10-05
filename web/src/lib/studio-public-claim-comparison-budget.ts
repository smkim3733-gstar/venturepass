import "server-only";
import { inspectPublicComparisonNativeRecords } from "./studio-public-claim-comparison-native";
import { z } from "zod";
import { inspectQualitySuppliedRows } from "../../scripts/local-data-quality.mjs";
import { decodeProviderReservationDatabaseRows } from "../../scripts/local-data-quality-provider-reservation-database.mjs";
import { decodeProviderTransmissionApprovalDatabaseRows } from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import { inspectQualityLedgers } from "../../scripts/local-data-quality-ledgers.mjs";
import { providerDigest as digest, providerBudgetScope } from "../../scripts/local-data-quality-provider.mjs";
import { getProviderExecutionBudgetSnapshot } from "../../scripts/local-data-quality-provider-execution.mjs";

const MiB = 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const integer = z.number().int().nonnegative().safe();
const environment = z.enum(["production", "synthetic-test"]);
const scope = z.enum(["candidate-quality-provider-v2-live", "candidate-quality-provider-v2-synthetic"]);
const body = { body: z.string().max(8 * MiB), body_hash: hash };
const keyed = z.object({ id: uuid, ...body }).strict();
const receiptRow = z.object({ nonce: uuid, ...body }).strict();
const numbered = z.object({ run_id: uuid, revision: integer, ...body }).strict();
const bindingRow = z.object({ storage_order: integer.positive(), run_id: uuid, nonce: uuid, ...body }).strict();
const coverageRow = z.object({ id: z.literal(1), ...body }).strict();
const bindingRows = z.object({
  bindingRows: z.array(bindingRow).max(20),
  coverageRows: z.array(coverageRow).length(1),
}).strict();
export const publicComparisonPrefixRowsSchema = z.object({
  schema: z.array(z.object({ type: z.string().max(20), name: z.string().max(200), tbl_name: z.string().max(200), sql: z.string().max(10000) }).strict()).min(1).max(300),
  runRows: z.array(keyed).max(20),
  revisionRows: z.array(numbered).max(4000),
  receiptRows: z.array(receiptRow).max(4020),
  candidateRows: z.array(z.object({ set_id: z.string().max(120), version: integer, ...body }).strict()).max(20),
  candidateReceipts: z.array(receiptRow).max(20),
  executionRows: z.array(keyed).max(20),
  executionEvents: z.array(numbered).max(140),
  executionReceipts: z.array(receiptRow).max(20),
  policyRows: z.array(z.object({ storage_order: integer.positive(), scope_id: z.string().max(120), revision: integer, nonce: uuid, ...body }).strict()).max(100),
  reservationRows: bindingRows,
  transmissionRows: bindingRows,
  actualRows: z.object({
    budget: z.array(z.object({ scope_id: z.string().max(120), revision: integer, ...body }).strict()).max(1000),
    runs: z.array(keyed).max(20),
    runOrder: z.array(z.object({ storage_order: integer.positive(), id: uuid }).strict()).max(20),
    events: z.array(numbered).max(640),
    artifacts: z.array(z.object({
      run_id: uuid, artifact_key: z.string().max(100),
      payload: z.instanceof(Uint8Array).transform(v => Uint8Array.from(v)),
      sha256: hash, size_bytes: integer.max(8 * MiB),
    }).strict()).max(140),
    receipts: z.array(receiptRow).max(1000),
  }).strict(),
}).strict();
const prefixSchema = z.object({
  storageVersion: z.literal(9), databaseInstanceId: uuid, environment, scopeId: scope,
  rows: publicComparisonPrefixRowsSchema,
  decoded: z.object({
    ledger: z.unknown(), reservationCoverage: z.unknown(), reservationRecords: z.unknown(),
    transmissionCoverage: z.unknown(), transmissionRecords: z.unknown(),
  }).strict(),
}).strict();
export type PublicComparisonPrefix = z.infer<typeof prefixSchema>;
const authority = Object.freeze({
  migrationCommitted: false, fileIdentityVerified: false, sqlSchemaVerified: false,
  executionLifecycleVerified: false, costAssessmentVerified: false,
  approvalGranted: false, dispatchAllowed: false, budgetWriteAllowed: false, databaseWriteAllowed: false,
} as const);
function invalid(code = "PUBLIC_COMPARISON_ARCHIVE_INVALID"): never { throw new Error(code); }
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Reject accessors, hooks, cycles and oversized supplied copies before schema parsing.
 * Repeated references are allowed; they are copied by the schemas, never treated as authority. */
function dataOnly(value: unknown, limit = 600 * MiB) {
  let size = 0, nodes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number) {
    if (++nodes > 1000000 || depth > 100) invalid();
    if (typeof v === "string") size += Buffer.byteLength(v);
    else if (typeof v === "number") { if (!Number.isFinite(v)) invalid(); }
    else if (v === null || typeof v === "boolean") { /* JSON scalar */ }
    else if (typeof v === "object") {
      if (v instanceof Uint8Array) {
        if (![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(v))) invalid();
        for (const key of Reflect.ownKeys(v)) {
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
        }
        size += v.byteLength;
      }
      else {
        if (seen.has(v) || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) invalid();
        seen.add(v);
        for (const key of Reflect.ownKeys(v)) {
          if (typeof key !== "string") invalid();
          const d = Object.getOwnPropertyDescriptor(v, key)!;
          if (!("value" in d) || (!d.enumerable && !(Array.isArray(v) && key === "length"))) invalid();
          if (Array.isArray(v) && key === "length") continue;
          if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
          size += Buffer.byteLength(key);
          visit(d.value, depth + 1);
        }
        seen.delete(v);
      }
    } else invalid();
    if (size > limit) invalid("PUBLIC_COMPARISON_ARCHIVE_LIMIT");
  }
  visit(value, 0);
}
function ordered<T>(rows: T[], keys: (keyof T)[]) {
  for (let i = 1; i < rows.length; i++) {
    let order = 0;
    for (const key of keys) {
      if (rows[i - 1][key] < rows[i][key]) { order = -1; break; }
      if (rows[i - 1][key] > rows[i][key]) { order = 1; break; }
    }
    if (order !== -1) invalid();
  }
}
function inspectPrefix(value: unknown) {
  dataOnly(value);
  const input = prefixSchema.parse(value), r = input.rows;
  if (input.scopeId !== providerBudgetScope(input.environment)) invalid();
  ordered(r.schema, ["type", "name"]);
  for (const rows of [r.runRows, r.executionRows, r.actualRows.runs]) ordered(rows, ["id"]);
  for (const rows of [r.receiptRows, r.candidateReceipts, r.executionReceipts, r.actualRows.receipts]) ordered(rows, ["nonce"]);
  for (const rows of [r.revisionRows, r.executionEvents, r.actualRows.events]) ordered(rows, ["run_id", "revision"]);
  ordered(r.candidateRows, ["set_id", "version"]);
  ordered(r.policyRows, ["storage_order"]);
  ordered(r.actualRows.budget, ["scope_id", "revision"]);
  ordered(r.actualRows.runOrder, ["storage_order"]);
  ordered(r.actualRows.artifacts, ["run_id", "artifact_key"]);
  const reservationRows = decodeProviderReservationDatabaseRows(r.reservationRows.bindingRows, r.reservationRows.coverageRows);
  const transmissionRows = decodeProviderTransmissionApprovalDatabaseRows(r.transmissionRows.bindingRows, r.transmissionRows.coverageRows);
  const audited = inspectQualitySuppliedRows({
    ...r, reservationRows, transmissionRows, storageVersion: 9,
    candidates: true, executions: true, actual: true, policies: true, reservations: true, transmissions: true,
    providerPrefix: null, operational: false,
  });
  const decoded = {
    ledger: audited.ledger,
    reservationCoverage: reservationRows.coverage, reservationRecords: reservationRows.records,
    transmissionCoverage: transmissionRows.coverage, transmissionRecords: transmissionRows.records,
  };
  if (digest(input.decoded) !== digest(decoded)) invalid();
  const ledger = inspectQualityLedgers(audited.ledger);
  if (ledger.reservedBytes !== 0 || ledger.reservedBudgetEventSlots !== 0 || ledger.reservedReceiptSlots !== 0 ||
      ledger.legacy.snapshots.some(v => v.sameCandidateBlocked || v.costState !== "settled") ||
      ledger.provider.snapshots.some(v => v.storage.heldBytes !== 0)) invalid("PUBLIC_COMPARISON_LEGACY_UNSETTLED");
  const budgets = (["production", "synthetic-test"] as const).map(env =>
    getProviderExecutionBudgetSnapshot(ledger.provider.budgetEvents.filter(v => v.environment === env), providerBudgetScope(env)));
  if (budgets.some(v => v.heldUnits !== "0" || v.boundBreached)) invalid("PUBLIC_COMPARISON_LEGACY_UNSETTLED");
  const budget = budgets.find(v => v.scopeId === input.scopeId)!;
  if (!budget.headDigest || !budget.currency || budget.unitScale === null) invalid("PUBLIC_COMPARISON_BUDGET_UNCONFIGURED");
  const nonces = [
    ...r.receiptRows, ...r.candidateReceipts, ...r.executionReceipts, ...r.actualRows.receipts,
  ].map(v => {
    const parsed = JSON.parse(v.body);
    return { nonce: v.nonce, inputDigest: hash.parse(parsed.inputDigest), record: parsed as unknown };
  });
  for (const row of r.policyRows) {
    const parsed = JSON.parse(row.body);
    nonces.push({ nonce: row.nonce, inputDigest: hash.parse(parsed.requestDigest), record: parsed });
  }
  if (new Set(nonces.map(v => v.nonce)).size !== nonces.length) invalid();
  // Frozen database digest includes exact body strings, schema rows, BLOB hashes and insertion order.
  return { input, audited, ledger, budget, budgets, nonces };
}
function coverageFor(p: ReturnType<typeof inspectPrefix>) {
  const value = {
    schemaVersion: 3 as const, coverageVersion: 1 as const, targetStorageVersion: 10 as const,
    purpose: "compare-public-claim" as const, databaseInstanceId: p.input.databaseInstanceId,
    environment: p.input.environment, scopeId: p.input.scopeId,
    prefix: p.audited.snapshot, decodedDigest: digest(p.input.decoded),
    nonceDigest: digest(p.nonces), budgets: p.budgets,
    usedBytes: p.audited.usage.usedBytes, authority,
  };
  return { ...value, coverageDigest: digest(value) };
}
/** Pure cutover proposal: no migration, file check, approval, pricing or dispatch. */
export function createPublicComparisonCoverage(value: unknown) {
  return coverageFor(inspectPrefix(value));
}
export type PublicComparisonCoverage = ReturnType<typeof createPublicComparisonCoverage>;
function inspectCoverage(prefix: unknown, expected: unknown) {
  dataOnly(expected, 2 * MiB);
  const p = inspectPrefix(prefix), coverage = coverageFor(p);
  // Exact JSON object/digest comparison also rejects unknown authority fields.
  if (digest(expected) !== digest(coverage)) invalid("PUBLIC_COMPARISON_COVERAGE_MISMATCH");
  return { ...p, coverage };
}
export function inspectPublicComparisonCoverage(prefix: unknown, expected: unknown) {
  return inspectCoverage(prefix, expected).coverage;
}

const common = {
  runId: uuid, requestDigest: hash, manifestDigest: hash,
};
const reserve = z.object({ kind: z.literal("reserve-comparison"), ...common, reservedUnits: units.refine(v => BigInt(v) > BigInt(0)) }).strict();
const release = z.object({
  kind: z.literal("release-comparison"), runId: uuid, reservationDigest: hash,
  reason: z.literal("not-dispatched"), cancellationEventDigest: hash, releasedUnits: units,
}).strict();
const recognize = z.object({
  kind: z.literal("recognize-comparison-usage"), runId: uuid, reservationDigest: hash,
  dispatchEventDigest: hash, responseArtifactSha256: hash, usageAssessmentDigest: hash,
  recognizedUnits: units, consumedHeldUnits: units, releasedHeldUnits: units, boundExcessUnits: units,
}).strict();
export const publicComparisonBudgetEventSchema = z.object({
  schemaVersion: z.literal(3), purpose: z.literal("compare-public-claim"),
  scopeId: scope, environment, provenance: z.enum(["synthetic-test", "explicit-user"]),
  currency: z.string().min(1).max(10), unitScale: integer.max(12),
  revision: integer.positive(), previousDigest: hash, eventId: uuid,
  recordedAt: z.string().datetime(), payload: z.discriminatedUnion("kind", [reserve, release, recognize]),
  eventDigest: hash,
}).strict();
const receipt = z.object({
  schemaVersion: z.literal(3), purpose: z.literal("compare-public-claim"), scopeId: scope,
  clientRequestId: uuid, runId: uuid, inputDigest: hash, budgetRevision: integer.positive(),
  operationDigest: hash, recordedAt: z.string().datetime(),
}).strict();
/** Supplied financial evidence only. Native execution events/capture and transactional
 * cancellation must be independently audited by the future writer; hashes do not prove them. */
const evidence = z.object({
  runId: uuid, requestDigest: hash, manifestDigest: hash,
  dispatchEventDigest: hash.nullable(), responseArtifactSha256: hash.nullable(),
  cancellationEventDigest: hash.nullable(),
  assessment: z.object({
    status: z.literal("known"), units, requestDigest: hash,
    dispatchEventDigest: hash, responseArtifactSha256: hash,
    requestedTier: z.string().min(1).max(100).nullable(),
    violations: z.array(z.string().min(1).max(200)).max(20),
  }).strict().nullable(),
}).strict();
const suffixSchema = z.object({
  events: z.array(publicComparisonBudgetEventSchema).max(320),
  receipts: z.array(receipt).max(320),
  evidence: z.array(evidence).max(20),
}).strict();
export type PublicComparisonBudgetEvent = z.infer<typeof publicComparisonBudgetEventSchema>;
export type PublicComparisonBudgetSuffix = z.infer<typeof suffixSchema>;
export function publicComparisonBudgetInputDigest(event: PublicComparisonBudgetEvent) {
  dataOnly(event, 32768);
  const e = publicComparisonBudgetEventSchema.parse(event);
  return digest({ schemaVersion: 3, purpose: e.purpose, scopeId: e.scopeId, environment: e.environment,
    currency: e.currency, unitScale: e.unitScale,
    expectedHead: { revision: e.revision - 1, headDigest: e.previousDigest }, payload: e.payload });
}
export function createPublicComparisonBudgetEvent(value: Omit<PublicComparisonBudgetEvent, "eventDigest">) {
  dataOnly(value, 32768);
  return publicComparisonBudgetEventSchema.parse({ ...value, eventDigest: digest(value) });
}
function inspectSuffix(prefix: unknown, expected: unknown, value: unknown, native?: ReturnType<typeof inspectPublicComparisonNativeRecords>) {
  const p = inspectCoverage(prefix, expected);
  dataOnly(value, 32 * MiB);
  const s = suffixSchema.parse(value);
  if (s.events.length !== s.receipts.length) invalid();
  const nonces = new Set(p.nonces.map(v => v.nonce));
  const ids = new Set(p.input.rows.actualRows.budget.map(v => JSON.parse(v.body).eventId as string));
  const oldRuns = new Set(p.ledger.provider.runs.map(v => v.id));
  p.ledger.legacy.runs.forEach(v => oldRuns.add(v.id));
  const receipts = new Map(s.receipts.map(v => [v.operationDigest, v]));
  const proofs = new Map(s.evidence.map(v => [v.runId, v]));
  if (receipts.size !== s.receipts.length || proofs.size !== s.evidence.length) invalid();
  for (const r of s.receipts) {
    if (nonces.has(r.clientRequestId) || bytes(r) > 4096) invalid();
    nonces.add(r.clientRequestId);
  }
  if (native) {
    for (const row of p.input.rows.actualRows.events) ids.add(JSON.parse(row.body).eventId as string);
    for (const row of [...p.input.rows.runRows,...p.input.rows.executionRows]) oldRuns.add(row.id);
    for (const r of native.extraReceipts) {
      if (nonces.has(r.clientRequestId)) invalid();
      nonces.add(r.clientRequestId);
    }
    for (const e of native.records.events) {
      if (ids.has(e.eventId) || s.events.some(v=>v.eventId===e.eventId)) invalid();
      ids.add(e.eventId);
    }
    if (digest(native.records.runs.map(v=>v.id)) !== digest(s.events.filter(v=>v.payload.kind==="reserve-comparison").map(v=>v.payload.runId))) invalid();
  }
  type Reservation = { runId: string; reservationDigest: string; requestDigest: string; manifestDigest: string;
    reservedUnits: string; heldUnits: string; recognizedUnits: string; settled: boolean };
  const reservations = new Map<string, Reservation>();
  let head = p.budget.headDigest, revision = p.budget.revision,
    recognized = BigInt(p.budget.recognizedUnits), bound = p.budget.boundBreached;
  const held = () => [...reservations.values()].reduce((n, v) => n + BigInt(v.heldUnits), BigInt(0));
  for (const e of s.events) {
    const { eventDigest, ...unsigned } = e;
    if (bytes(e) > 32768 || ids.has(e.eventId) || eventDigest !== digest(unsigned) ||
      e.scopeId !== p.input.scopeId || e.environment !== p.input.environment ||
      e.provenance !== (e.environment === "production" ? "explicit-user" : "synthetic-test") ||
      e.currency !== p.budget.currency || e.unitScale !== p.budget.unitScale ||
      e.revision !== revision + 1 || e.previousDigest !== head) invalid();
    ids.add(e.eventId); revision = e.revision; head = eventDigest;
    const r = receipts.get(eventDigest), item = e.payload, proof = proofs.get(item.runId);
    if (!r || r.scopeId !== e.scopeId || r.runId !== item.runId || r.budgetRevision !== e.revision ||
      r.recordedAt !== e.recordedAt || r.inputDigest !== publicComparisonBudgetInputDigest(e) || !proof) invalid();
    if (item.kind === "reserve-comparison") {
      if (bound || held() !== BigInt(0) || reservations.has(item.runId) || oldRuns.has(item.runId) ||
        item.requestDigest !== proof.requestDigest || item.manifestDigest !== proof.manifestDigest ||
        recognized + held() + BigInt(item.reservedUnits) > BigInt(p.budget.capUnits)) invalid();
      reservations.set(item.runId, { runId: item.runId, reservationDigest: eventDigest,
        requestDigest: item.requestDigest, manifestDigest: item.manifestDigest,
        reservedUnits: item.reservedUnits, heldUnits: item.reservedUnits, recognizedUnits: "0", settled: false });
    } else {
      const reservation = reservations.get(item.runId);
      if (!reservation || reservation.settled || reservation.reservationDigest !== item.reservationDigest) invalid();
      if (item.kind === "release-comparison") {
        if (proof.dispatchEventDigest !== null || proof.responseArtifactSha256 !== null ||
          proof.assessment !== null || proof.cancellationEventDigest !== item.cancellationEventDigest ||
          item.releasedUnits !== reservation.heldUnits) invalid();
      } else {
        const a = proof.assessment, cost = BigInt(item.recognizedUnits), hold = BigInt(reservation.heldUnits);
        if (!a || proof.cancellationEventDigest !== null || proof.dispatchEventDigest !== item.dispatchEventDigest ||
          proof.responseArtifactSha256 !== item.responseArtifactSha256 ||
          a.requestDigest !== reservation.requestDigest || a.dispatchEventDigest !== item.dispatchEventDigest ||
          a.responseArtifactSha256 !== item.responseArtifactSha256 || digest(a) !== item.usageAssessmentDigest ||
          a.units !== item.recognizedUnits || item.consumedHeldUnits !== (cost < hold ? cost : hold).toString() ||
          item.releasedHeldUnits !== (cost < hold ? hold - cost : BigInt(0)).toString() ||
          item.boundExcessUnits !== (cost > hold ? cost - hold : BigInt(0)).toString()) invalid();
        recognized += cost;
        bound ||= cost > hold || a.violations.length > 0;
        reservation.recognizedUnits = cost.toString();
      }
      reservation.heldUnits = "0"; reservation.settled = true;
    }
  }
  if (proofs.size !== reservations.size) invalid();
  for (const [id, proof] of proofs) {
    if (!reservations.has(id) || (proof.responseArtifactSha256 !== null && proof.dispatchEventDigest === null) ||
      (proof.assessment !== null && (proof.responseArtifactSha256 === null || proof.dispatchEventDigest === null)) ||
      (proof.cancellationEventDigest !== null && proof.dispatchEventDigest !== null)) invalid();
  }
  // Until full native-v4 run storage is audited, conservatively keep each entire reservation,
  // even for a financially settled proposal. Existing bytes/slots inside it are not counted twice.
  const runCount = reservations.size, prefixRows = p.input.rows.actualRows;
  const suffixBytes = bytes(s), coverageBytes = bytes(p.coverage);
  if (native) {
    if (p.ledger.globalRunCount + runCount > 20 ||
      prefixRows.artifacts.length + native.records.artifacts.length + native.reservedArtifactSlots > 140 ||
      prefixRows.events.length + native.records.events.length + native.reservedEventSlots > 640 ||
      prefixRows.budget.length + s.events.length + native.reservedBudgetSlots > 1000 ||
      prefixRows.receipts.length + native.records.receipts.length + native.reservedReceiptSlots > 1000 ||
      p.audited.usage.usedBytes + coverageBytes + native.totalUsed + native.heldBytes > 256 * MiB)
      invalid("PUBLIC_COMPARISON_ARCHIVE_LIMIT");
  } else {
  if (p.ledger.globalRunCount + runCount > 20 || prefixRows.artifacts.length + runCount * 7 > 140 ||
      prefixRows.events.length + runCount * 32 > 640 ||
      prefixRows.budget.length + runCount * 16 > 1000 ||
      prefixRows.receipts.length + runCount * 64 > 1000 ||
      s.events.length > runCount * 16 || s.receipts.length > runCount * 64 ||
      suffixBytes > runCount * 32 * MiB + 1024 ||
      p.audited.usage.usedBytes + coverageBytes + runCount * 32 * MiB > 256 * MiB) invalid("PUBLIC_COMPARISON_ARCHIVE_LIMIT");
  }
  const exposure = recognized + held(), cap = BigInt(p.budget.capUnits);
  return {
    prefix: p, suffix: s,
    result: {
      source: "supplied-financial-proposal" as const, schemaVersion: 3 as const, purpose: "compare-public-claim" as const,
      coverageDigest: p.coverage.coverageDigest, scopeId: p.input.scopeId, environment: p.input.environment,
      revision, headDigest: head, currency: p.budget.currency, unitScale: p.budget.unitScale, capUnits: p.budget.capUnits,
      recognizedUnits: recognized.toString(), heldUnits: held().toString(),
      availableUnits: (cap > exposure ? cap - exposure : BigInt(0)).toString(),
      deficitUnits: (exposure > cap ? exposure - cap : BigInt(0)).toString(),
      boundBreached: bound || exposure > cap, reservations: [...reservations.values()],
      capacity: { prefixUsedBytes: p.audited.usage.usedBytes, coverageBytes,
        comparisonReservedBytes: runCount * 32 * MiB, suppliedSuffixBytes: suffixBytes,
        reservedBudgetSlots: runCount * 16 - s.events.length, reservedReceiptSlots: runCount * 64 - s.receipts.length },
      authority,
    },
  };
}
/** Audits the unmodified prefix and supplied monetary suffix together; not a full native-v4 run audit. */
export function inspectPublicComparisonBudget(prefix: unknown, coverage: unknown, suffix: unknown) {
  return inspectSuffix(prefix, coverage, suffix).result;
}
/** Lookup is deliberately independent of current company/key/config. It creates no owner or event. */
export function lookupPublicComparisonNonce(prefix: unknown, coverage: unknown, suffix: unknown, value: unknown) {
  dataOnly(value, 1024);
  const command = z.object({ nonce: uuid, inputDigest: hash }).strict().parse(value);
  const { prefix: p, suffix: s } = inspectSuffix(prefix, coverage, suffix);
  const old = p.nonces.find(v => v.nonce === command.nonce);
  const current = s.receipts.find(v => v.clientRequestId === command.nonce);
  const record = old?.record ?? current;
  if (!record) return { status: "not-observed" as const, record: null, authority };
  if ((old?.inputDigest ?? current!.inputDigest) !== command.inputDigest) invalid("PUBLIC_COMPARISON_NONCE_CONFLICT");
  return { status: "replay" as const, record: structuredClone(record), authority };
}

/** Full supplied native-v4 structure plus the unchanged prefix/monetary fold.
 * Financial references come exclusively from audited events/artifacts, never a parallel evidence input.
 * No company, keys, DB, clock or owner is consulted/created. */
export function inspectPublicComparisonNativeArchive(prefix: unknown, coverage: unknown, raw: unknown) {
  dataOnly(raw, 256 * MiB);
  const outer = z.object({records:z.unknown(),financial:suffixSchema.omit({evidence:true})}).strict().parse(raw);
  const auditedCoverage=inspectPublicComparisonCoverage(prefix,coverage);
  const native=inspectPublicComparisonNativeRecords(outer.records,outer.financial,auditedCoverage.coverageDigest);
  const audit=inspectSuffix(prefix,coverage,{...outer.financial,evidence:native.evidence},native);
  return {
    ...audit.result,source:"supplied-native-archive" as const,archiveFormatVersion:4 as const,
    structureConsistent:true as const,sourceKind:"native-state-and-financial-evidence" as const,
    runs:native.summaries,
    capacity:{prefixUsedBytes:audit.result.capacity.prefixUsedBytes,coverageBytes:audit.result.capacity.coverageBytes,
      comparisonUsedBytes:native.totalUsed,comparisonHeldBytes:native.heldBytes,
      reservedEventSlots:native.reservedEventSlots,reservedBudgetSlots:native.reservedBudgetSlots,
      reservedReceiptSlots:native.reservedReceiptSlots,reservedArtifactSlots:native.reservedArtifactSlots},
    nativeReceipts:structuredClone(native.records.receipts),
    authority:{...authority,transactionCommitVerified:false,providerExecutionObserved:false,currentCompanyVerified:false},
  };
}
/** Original receipt only; cold/replay reads never confer dispatch ownership. */
export function lookupPublicComparisonNativeNonce(prefix:unknown,coverage:unknown,raw:unknown,value:unknown) {
  dataOnly(value,1024);
  const command=z.object({nonce:uuid,inputDigest:hash}).strict().parse(value);
  const archive=inspectPublicComparisonNativeArchive(prefix,coverage,raw);
  const current=archive.nativeReceipts.find(v=>v.clientRequestId===command.nonce);
  if(current) {
    if(current.inputDigest!==command.inputDigest) invalid("PUBLIC_COMPARISON_NONCE_CONFLICT");
    return {status:"replay" as const,record:current,owner:null,authority:archive.authority};
  }
  const p=inspectCoverage(prefix,coverage),old=p.nonces.find(v=>v.nonce===command.nonce);
  if(old && old.inputDigest!==command.inputDigest) invalid("PUBLIC_COMPARISON_NONCE_CONFLICT");
  return {status:old?"replay" as const:"not-observed" as const,record:old?structuredClone(old.record):null,owner:null,authority:archive.authority};
}

export { dataOnly as assertPublicComparisonDataOnly };
