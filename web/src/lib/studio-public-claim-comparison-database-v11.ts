import "server-only";
import { createComparisonBodyBoundary } from "./studio-public-claim-comparison-body";
import { z } from "zod";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import {
  beginComparisonCompanyRead,
  createComparisonCompanyReadScope,
  checkComparisonCompanyRead,
  endComparisonCompanyRead,
  type ComparisonCompanyGuard,
} from "./studio-public-comparison-company-guard";
import {
  beginComparisonStorageSession,
  endComparisonStorageSession,
  openComparisonReadOnlyStorageSession,
  closeComparisonStorageSession,
  initializeComparisonWitness,
  checkComparisonWitness,
  checkComparisonWitnessCompany,
  recordComparisonWitnessIntent,
  acknowledgeComparisonWitness,
  checkComparisonWitnessPending,
  recordComparisonWitnessIntentV2,
  beginComparisonWitnessTransition,
  acknowledgeComparisonWitnessTransition,
  comparisonWitnessInventory,
  comparisonWitnessRow,
  type ComparisonStorageSession,
} from "./studio-public-comparison-storage-witness";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  publicComparisonV10InsertGates,
  readPublicComparisonDatabaseSnapshot,
  type PublicComparisonDatabaseSelection,
} from "./studio-public-claim-comparison-database";
import { publicComparisonV11InsertGates } from "./studio-public-claim-comparison-database-v11-schema";
import {
  inspectComparisonReservationState,
  planComparisonReservation,
  planComparisonCancellation,
  prepareComparisonStorageCommand,
  planPreparedComparisonStorageCommand,
  inspectedComparisonStorageCommand,
  createComparisonReservationReview,
  comparisonReserveCommandSchema,
  comparisonCancelCommandSchema,
} from "./studio-public-claim-comparison-reservation";
import { cancellationSelectionSchema, cancellationNotice } from "./studio-comparison-cancellation-wire";
import { comparisonPlanAuthority, comparisonSha, comparisonHashSchema } from "./studio-public-claim-comparison-financial";
import type { PublicComparisonCoverage } from "./studio-public-claim-comparison-budget";

import {
  publicComparisonV12Columns,
  publicComparisonV12InsertGates,
} from "./studio-public-claim-comparison-database-v12-schema";
import {
  comparisonTransmissionCore,
  comparisonUnknownCommandSchema,
  comparisonCaptureCommandSchema,
  inspectComparisonTransmissionState,
  prepareComparisonTransmissionStorageCommand,
  inspectedComparisonTransmissionStorageCommand,
  planPreparedComparisonTransmissionStorageCommand,
  type ComparisonTransmissionOperation,
} from "./studio-public-claim-comparison-transmission";
import { publicComparisonV13InsertGates } from "./studio-public-claim-comparison-database-v13-schema";
import {
  createComparisonPostcapturePreview,
  createComparisonTransmissionV2Review,
  planComparisonPostcapture,
  comparisonResultCommandSchema,
  comparisonCloseCommandSchema,
  comparisonDispatchV2CommandSchema,
  type ComparisonTransmissionV2Review,
  inspectComparisonTransmissionV4State,
  prepareComparisonV4StorageCommand,
  inspectedComparisonV4StorageCommand,
  planPreparedComparisonV4StorageCommand,
  type ComparisonV4StorageOperation,
} from "./studio-public-claim-comparison-transmission-v4";
import { randomUUID } from "node:crypto";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { inspectArchivedPublicClaimRequest, inspectPublicClaimComparisonRequest, publicClaimComparisonRequestCommandSchema } from "./studio-public-claim-comparison-request";
import { validateComparisonUsagePolicy } from "./studio-public-claim-comparison-usage";
import { snapshotProviderSdkWire } from "./studio-plan-quality-provider-sdk-wire";
import {
  preparePublicComparisonTransportBoundary,
  requireSyntheticComparisonDriver,
  comparisonSyntheticWireKey,
  type SyntheticComparisonDriver,
} from "./studio-public-claim-comparison-transport";
import { derivePublicComparisonCapturedResult, publicComparisonValidatedBody } from "./studio-public-claim-comparison-native";
import { copyComparisonStoredRead } from "./studio-public-claim-comparison-stored-read";
import { requireComparisonProviderDriver, type ComparisonProviderDriver } from "./studio-comparison-provider-driver";
type Version = 11 | 12 | 13;
function witnessVersion(version: Version) {
  return version === 11 ? 1 : version === 12 ? 2 : 3;
}
type V4Plan = Exclude<
  ReturnType<typeof planPreparedComparisonV4StorageCommand>,
  { status: "blocked" }
>;
type Operation =
  "reserve" | "cancel" | ComparisonTransmissionOperation | ComparisonV4StorageOperation;
type TransmissionPlan = ReturnType<typeof planPreparedComparisonTransmissionStorageCommand>;
type Table = keyof typeof publicComparisonV12Columns;
type Row = { table: Table; values: SQLInputValue[] };
type Plan =
  | ReturnType<typeof planComparisonReservation>
  | ReturnType<typeof planComparisonCancellation>
  | TransmissionPlan
  | V4Plan
  | Extract<ReturnType<typeof prepareComparisonV4StorageCommand>, { status: "replay" }>
  | Extract<ReturnType<typeof prepareComparisonTransmissionStorageCommand>, { status: "replay" }>;
type NewPlan = Extract<Plan, { status: "prepared-not-committed" }>;
const busy = new WeakSet<DatabaseSync>();
const permits = new WeakMap<
  DatabaseSync,
  { operation: Operation; version: Version; rows: string[]; index: number }
>();
function fail(code = "PUBLIC_COMPARISON_WRITE_INVALID"): never {
  throw Error(code);
}
function enter(db: DatabaseSync) {
  if (busy.has(db) || db.isTransaction) fail("PUBLIC_COMPARISON_TRANSACTION_ACTIVE");
  busy.add(db);
}
function signature(table: string, values: unknown[]) {
  return JSON.stringify([
    table,
    ...values.map((v) =>
      v instanceof Uint8Array ? { blob: Buffer.from(v).toString("base64") } : v,
    ),
  ]);
}
function registerGate(db: DatabaseSync, version: Version = 11) {
  db.function("comparison_v" + version + "_insert_guard", { varargs: true }, (...args) => {
    const permit = permits.get(db);
    if (
      !busy.has(db) ||
      !db.isTransaction ||
      !permit ||
      permit.version !== version ||
      !(
        version === 11
          ? ["reserve", "cancel"]
          : version === 12
            ? ["reserve", "cancel", "approve-dispatch", "mark-unknown", "persist-capture"]
            : [
                "reserve",
                "cancel",
                "approve-dispatch",
                "mark-unknown",
                "persist-capture",
                "record-result",
                "settle-finalize",
              ]
      ).includes(permit.operation) ||
      typeof args[0] !== "string"
    )
      return 0;
    let actual: string;
    try {
      actual = signature(args[0], args.slice(1));
    } catch {
      return 0;
    }
    if (actual !== permit.rows[permit.index]) return 0;
    permit.index++;
    return 1;
  });
}
function readStateTransaction(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  version: Version = 11,
) {
  const snap = readPublicComparisonDatabaseSnapshot(db, selection, version);
  const additionalUsedBytes =
    Math.max(0, snap.cutoverBytes - Buffer.byteLength(JSON.stringify(snap.coverage))) +
    snap.nativeRawOverheadBytes +
    snap.bindingRawOverheadBytes +
    snap.transmissionRawOverheadBytes;
  const state = {
    prefix: snap.prefix,
    coverage: snap.coverage,
    archive: snap.archive,
    bindings: snap.bindings,
    additionalUsedBytes,
  };
  return {
    source: "local-comparison-reservation-database-read" as const,
    storageVersion: version,
    transmissionBindings: snap.transmissionBindings,
    cutoverDigest: snap.cutover.cutoverDigest,
    rawRowsDigest: snap.rawRowsDigest,
    cutoverBytes: snap.cutoverBytes,
    nativeRawOverheadBytes: snap.nativeRawOverheadBytes,
    bindingRawOverheadBytes: snap.bindingRawOverheadBytes,
    state,
    fileIdentityVerified: false as const,
    currentCompanyVerified: false as const,
    dispatchAllowed: false as const,
  };
}
function inspectTransaction(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  version: Version = 11,
) {
  const { state, ...snapshot } = readStateTransaction(db, selection, version);
  const transmission =
    version >= 12
      ? (version === 13
          ? inspectComparisonTransmissionV4State
          : inspectComparisonTransmissionState)({
          reservation: state,
          transmissionBindings: snapshot.transmissionBindings,
        })
      : null;
  return {
    ...snapshot,
    inspection: transmission?.reservation ?? inspectComparisonReservationState(state),
    transmission,
  };
}
function rollback(db: DatabaseSync, error: unknown, commitAttempted: boolean): never {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    fail("PUBLIC_COMPARISON_RECOVERY_REQUIRED");
  }
  if (commitAttempted) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
  throw error;
}
/** Explicit read; caller supplies the already-open DB. No path, company store, settings or SDK. */
export function inspectPublicComparisonDatabaseV11(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
) {
  enter(db);
  let commitAttempted = false;
  try {
    db.exec("BEGIN");
    const result = inspectTransaction(db, selection);
    commitAttempted = true;
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return result;
  } catch (e) {
    return rollback(db, e, commitAttempted);
  } finally {
    busy.delete(db);
  }
}
/** Only an empty native suffix may opt into v11. Coverage/legacy bytes remain untouched. */
export function migratePublicComparisonDatabaseV11(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  expectedCoverage: PublicComparisonCoverage,
) {
  enter(db);
  let commitAttempted = false;
  try {
    registerGate(db);
    db.exec("BEGIN IMMEDIATE");
    const already = !!db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND name='quality_actual_runs_v11_writer'",
      )
      .get();
    if (already) {
      const inspection = inspectTransaction(db, selection);
      if (digest(inspection.inspection.state.coverage) !== digest(expectedCoverage))
        fail("PUBLIC_COMPARISON_COVERAGE_MISMATCH");
      commitAttempted = true;
      db.exec("COMMIT");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
      return { status: "already-v11" as const, inspection, migrationCommitObserved: false };
    }
    const snap = readPublicComparisonDatabaseSnapshot(db, selection, 10);
    if (digest(snap.coverage) !== digest(expectedCoverage))
      fail("PUBLIC_COMPARISON_COVERAGE_MISMATCH");
    if (
      Object.values(snap.archive.records).some((rows) => rows.length) ||
      snap.archive.financial.events.length ||
      snap.archive.financial.receipts.length ||
      snap.bindings.length
    )
      fail("PUBLIC_COMPARISON_NATIVE_SUFFIX_NOT_EMPTY");
    // Prove the empty state with the same complete native/binding audit used after migration.
    inspectComparisonReservationState({
      prefix: snap.prefix,
      coverage: snap.coverage,
      archive: snap.archive,
      bindings: [],
      additionalUsedBytes: Math.max(
        0,
        snap.cutoverBytes - Buffer.byteLength(JSON.stringify(snap.coverage)),
      ),
    });
    for (const name of Object.keys(publicComparisonV10InsertGates)) db.exec(`DROP TRIGGER ${name}`);
    for (const sql of Object.values(publicComparisonV11InsertGates)) db.exec(sql);
    const inspection = inspectTransaction(db, selection);
    commitAttempted = true;
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return { status: "migrated-v11" as const, inspection, migrationCommitObserved: true };
  } catch (e) {
    return rollback(db, e, commitAttempted);
  } finally {
    permits.delete(db);
    busy.delete(db);
  }
}
function inserts(plan: NewPlan): Row[] {
  const json = (v: unknown) => [JSON.stringify(v), digest(v)];
  const event = (v: { runId: string; revision: number }) => ({
    table: "quality_actual_events" as const,
    values: [v.runId, v.revision, ...json(v)],
  });
  const receipt = (v: { clientRequestId: string }) => ({
    table: "quality_actual_requests" as const,
    values: [v.clientRequestId, ...json(v)],
  });
  const artifact = (v: {
    runId: string;
    key: string;
    body: string;
    sha256: string;
    sizeBytes: number;
  }) => ({
    table: "quality_actual_artifacts" as const,
    values: [v.runId, v.key, Buffer.from(v.body, "utf8"), v.sha256, v.sizeBytes],
  });
  const budget = (b: { scopeId: string; revision: number }): Row => ({
    table: "quality_actual_budget_events",
    values: [b.scopeId, b.revision, ...json(b)],
  });
  if (plan.operation === "reserve") {
    const r = plan.rows;
    return [
      { table: "quality_actual_runs", values: [r.run.id, ...json(r.run)] },
      ...r.artifacts.map(artifact),
      event(r.event),
      budget(r.budgetEvent),
      receipt(r.receipt),
      {
        table: "quality_provider_reservation_bindings",
        values: [r.binding.runId, r.binding.clientRequestId, ...json(r.binding)],
      },
    ];
  }
  if (plan.operation === "cancel") {
    const r = plan.rows;
    return [
      event(r.events[0]),
      budget(r.budgetEvent),
      receipt(r.receipts[0]),
      artifact(r.artifact),
      event(r.events[1]),
      receipt(r.receipts[1]),
    ];
  }
  if (plan.operation === "settle-finalize") {
    const r = plan.rows;
    return [
      event(r.events[0]),
      receipt(r.receipts[0]),
      budget(r.budgetEvent),
      event(r.events[1]),
      receipt(r.receipts[1]),
      artifact(r.artifact),
      event(r.events[2]),
      receipt(r.receipts[2]),
    ];
  }
  const r = plan.rows;
  return [
    ...(r.artifact ? [artifact(r.artifact)] : []),
    event(r.event),
    receipt(r.receipt),
    ...("binding" in r && r.binding
      ? [
          {
            table: "quality_provider_transmission_bindings" as const,
            values: [r.binding.runId, r.binding.clientRequestId, ...json(r.binding)],
          },
        ]
      : []),
  ];
}
function persist(db: DatabaseSync, plan: NewPlan, version: Version = 11) {
  const rows = inserts(plan);
  const permit = {
    operation: plan.operation,
    version,
    rows: rows.map((r) => signature(r.table, r.values)),
    index: 0,
  };
  const before = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  permits.set(db, permit);
  try {
    for (const row of rows) {
      const columns = publicComparisonV12Columns[row.table];
      const result = db
        .prepare(
          `INSERT INTO ${row.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        )
        .run(...row.values);
      if (Number(result.changes) !== 1) fail();
    }
    if (
      permit.index !== rows.length ||
      Number(db.prepare("SELECT total_changes() AS n").get()!.n) - before !== rows.length
    )
      fail();
  } finally {
    permits.delete(db);
  }
  return rows.length;
}
function checkpoint(
  db: DatabaseSync,
  snapshot: ReturnType<typeof readStateTransaction>,
  inspection: ReturnType<typeof inspectComparisonReservationState>,
) {
  return {
    rawRowsDigest: snapshot.rawRowsDigest,
    inventoryDigest: comparisonWitnessInventory(db),
    cutoverDigest: snapshot.cutoverDigest,
    coverageDigest: snapshot.state.coverage.coverageDigest,
    archiveDigest:
      snapshot.storageVersion >= 12
        ? digest({
            reservationArchiveDigest: inspection.view.archiveDigest,
            transmissionBindings: snapshot.transmissionBindings,
          })
        : inspection.view.archiveDigest,
    budgetRevision: inspection.view.native.revision,
    budgetHead: inspection.view.native.headDigest,
  };
}
/** Private-copy backup audit only; does not open paths or acquire an execution capability. */
export function inspectComparisonArchiveCheckpoint(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  version: Version,
) {
  const snapshot = readStateTransaction(db, selection, version);
  const inspected = inspectTransaction(db, selection, version);
  return checkpoint(db, snapshot, inspected.inspection);
}
/** Predict the existing SQL reader's ORDER BY on detached native vectors only.
 * No event filtering, revision/hash rewriting, legacy reordering, or persisted byte changes. */
function expectedSqlArchiveDigest(
  plan: NewPlan,
  version: Version = 11,
  priorBindings: ReturnType<typeof readStateTransaction>["transmissionBindings"] = [],
) {
  const s = "reservation" in plan.next ? plan.next.reservation : plan.next,
    archive = structuredClone(s.archive);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  archive.records.events.sort((a, b) => cmp(a.runId, b.runId) || a.revision - b.revision);
  archive.records.artifacts.sort((a, b) => cmp(a.runId, b.runId) || cmp(a.key, b.key));
  archive.records.receipts.sort((a, b) => cmp(a.clientRequestId, b.clientRequestId));
  archive.financial.events.sort((a, b) => cmp(a.scopeId, b.scopeId) || a.revision - b.revision);
  archive.financial.receipts.sort(
    (a, b) => cmp(a.scopeId, b.scopeId) || a.budgetRevision - b.budgetRevision,
  );
  // runs and bindings retain their original SQL insertion order.
  const reservationArchiveDigest = digest({
    coverageDigest: s.coverage.coverageDigest,
    archive,
    bindings: s.bindings,
  });
  return version === 11
    ? reservationArchiveDigest
    : digest({
        reservationArchiveDigest,
        transmissionBindings:
          "transmissionBindings" in plan.next ? plan.next.transmissionBindings : priorBindings,
      });
}
function observedError(code: string, commitObserved: boolean) {
  return Object.assign(Error(code), { commitObserved, recoveryRequired: true });
}
function write(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  operation: Operation,
  command: unknown,
  current?: unknown,
  session?: ComparisonStorageSession,
  version: Version = 11,
  retainCompanyRead?: (scope: ReturnType<typeof createComparisonCompanyReadScope>) => void,
) {
  enter(db);
  let commitAttempted = false,
    commitObserved = false;
  let companyGuard: ComparisonCompanyGuard | undefined;
  let companyId: string | undefined;
  let scopedCompanyRead: ReturnType<typeof createComparisonCompanyReadScope> | undefined;
  try {
    registerGate(db, version);
    db.exec("BEGIN IMMEDIATE");
    const before = readStateTransaction(db, selection, version);
    let plan: Plan;
    if (session) {
      const transmissionOperation = operation !== "reserve" && operation !== "cancel";
      const transmissionState = {
        reservation: before.state,
        transmissionBindings: before.transmissionBindings,
      };
      if (transmissionOperation && version < 12) fail();
      if (version === 13 && !transmissionOperation)
        inspectComparisonTransmissionV4State(transmissionState);
      const prepared = transmissionOperation
        ? version === 13
          ? prepareComparisonV4StorageCommand(
              transmissionState,
              operation as ComparisonV4StorageOperation,
              command,
            )
          : prepareComparisonTransmissionStorageCommand(
              transmissionState,
              operation as ComparisonTransmissionOperation,
              command,
            )
        : prepareComparisonStorageCommand(before.state, operation as "reserve" | "cancel", command);
      if (prepared.status === "replay") plan = prepared;
      else {
        const transmissionAudit =
          prepared.ticket.kind === "comparison-v4-storage-ticket"
            ? inspectedComparisonV4StorageCommand(prepared.ticket)
            : prepared.ticket.kind === "comparison-transmission-ticket"
              ? inspectedComparisonTransmissionStorageCommand(prepared.ticket)
              : null;
        const audited =
          prepared.ticket.kind === "comparison-prepared-command"
            ? inspectedComparisonStorageCommand(prepared.ticket)
            : transmissionAudit!.reservation;
        // v12 reserve/cancel still audit every existing transmission binding.
        if (version === 12 && !transmissionAudit)
          inspectComparisonTransmissionState(transmissionState);
        const beforeCheckpoint = checkpoint(db, before, audited);
        checkComparisonWitness(session, beforeCheckpoint, witnessVersion(version));
        let actualCurrent = current;
        if (operation === "cancel" && retainCompanyRead) {
          const cur = z.object({ companyGuard: z.unknown(), selection: cancellationSelectionSchema,
            at: z.string().datetime(), eventId: z.string().uuid(), budgetEventId: z.string().uuid(),
            finalEventId: z.string().uuid(), finalizationNonce: z.string().uuid() }).strict().parse(current);
          const c = comparisonCancelCommandSchema.parse(prepared.command);
          const run = before.state.archive.records.runs.find(r => r.id === c.runId);
          if (!run || c.runId !== cur.selection.runId || run.command.selection.companyId !== cur.selection.companyId)
            fail("PUBLIC_COMPARISON_CANCEL_SELECTION_CHANGED");
          const cap = cur.companyGuard as ComparisonCompanyGuard;
          checkComparisonWitnessCompany(session, cap, witnessVersion(version));
          scopedCompanyRead = createComparisonCompanyReadScope(cap);
          retainCompanyRead(scopedCompanyRead);
          companyId = cur.selection.companyId;
          companyGuard = cap;
          const company = scopedCompanyRead.read(companyId);
          if (company.revision !== cur.selection.companyRevision) fail("PUBLIC_COMPARISON_CANCEL_SELECTION_CHANGED");
          const {companyGuard: _cap, selection: _query, ...inputs} = cur;
          void _cap; void _query;
          actualCurrent = inputs;
        }
        if (operation === "reserve" || operation === "approve-dispatch") {
          assertPublicComparisonDataOnly(current, 8 * 1024 * 1024);
          const cur = (
            operation === "reserve"
              ? z
                  .object({
                    companyGuard: z.unknown(),
                    approvedReview: z.unknown(),
                    evidence: z.unknown(),
                    at: z.unknown(),
                    runId: z.unknown(),
                    eventId: z.unknown(),
                    budgetEventId: z.unknown(),
                  })
                  .strict()
              : z
                  .object({
                    companyGuard: z.unknown(),
                    approvedReview: z.unknown(),
                    basis: z.unknown(),
                    ...(version === 13 ? { usagePolicy: z.unknown() } : {}),
                    at: z.unknown(),
                    eventId: z.unknown(),
                  })
                  .strict()
          ).parse(current);
          const cap = cur.companyGuard as ComparisonCompanyGuard;
          checkComparisonWitnessCompany(session, cap, witnessVersion(version));
          companyId =
            "companyId" in prepared.command
              ? prepared.command.companyId
              : before.state.archive.records.runs.find(
                  (r) => r.id === ("runId" in prepared.command ? prepared.command.runId : ""),
                )?.command.selection.companyId;
          if (!companyId) fail();
          // The booking owner retains this exact call scope if rollback fails.
          // Existing callers keep their original guard lifetime.
          if (retainCompanyRead) {
            scopedCompanyRead = createComparisonCompanyReadScope(cap);
            retainCompanyRead(scopedCompanyRead);
          }
          const company = scopedCompanyRead
            ? scopedCompanyRead.read(companyId)
            : beginComparisonCompanyRead(cap, companyId);
          companyGuard = cap;
          const { companyGuard: _cap, ...inputs } = cur;
          void _cap;
          actualCurrent = { ...inputs, company };
        }
        const planned =
          prepared.ticket.kind === "comparison-v4-storage-ticket"
            ? planPreparedComparisonV4StorageCommand(prepared.ticket, actualCurrent)
            : prepared.ticket.kind === "comparison-transmission-ticket"
              ? planPreparedComparisonTransmissionStorageCommand(prepared.ticket, actualCurrent)
              : planPreparedComparisonStorageCommand(prepared.ticket, actualCurrent);
        if (planned.status === "blocked") {
          const inspection = inspectTransaction(db, selection, version);
          commitAttempted = true;
          db.exec("COMMIT");
          if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
          return {
            source: "local-comparison-reservation-database-write" as const,
            storageVersion: version,
            status: "blocked" as const,
            result: planned,
            inspection,
            insertedRows: 0,
            commitObserved: false,
            witnessMatched: true,
            companyLockObserved: false,
            owner: null,
            authority: comparisonPlanAuthority,
          };
        }
        plan = planned;
        const rows = inserts(plan);
        const runId =
          plan.operation === "reserve"
            ? plan.rows.run.id
            : plan.operation === "cancel" || plan.operation === "settle-finalize"
              ? plan.rows.events[0].runId
              : plan.rows.event.runId;
        const intent = {
          operation,
          nonce: prepared.command.clientRequestId,
          commandDigest: digest(prepared.command),
          runId,
          expectedArchiveDigest: expectedSqlArchiveDigest(
            plan,
            version,
            before.transmissionBindings,
          ),
          rows: rows.map((r) => comparisonWitnessRow(r.table, r.values)),
        };
        if (version >= 12)
          recordComparisonWitnessIntentV2(
            session,
            beforeCheckpoint,
            intent,
            "reservation" in plan.next ? plan.next.reservation : plan.next,
            version === 13 ? 3 : 2,
          );
        else {
          if (intent.operation !== "reserve" && intent.operation !== "cancel") fail();
          recordComparisonWitnessIntent(session, beforeCheckpoint, {
            ...intent,
            operation: intent.operation,
          });
        }
      }
    } else {
      if (version !== 11 || (operation !== "reserve" && operation !== "cancel")) fail();
      plan =
        operation === "reserve"
          ? planComparisonReservation(before.state, command, current)
          : planComparisonCancellation(before.state, command, current);
    }
    if (plan.status === "replay") {
      const inspection = inspectTransaction(db, selection, version);
      let witnessMatched = false;
      if (session) {
        try {
          checkComparisonWitness(
            session,
            checkpoint(db, before, inspection.inspection),
            witnessVersion(version),
          );
          witnessMatched = true;
        } catch {
          /* Original DB record remains a structure-only replay; never creates an ack or new rows. */
        }
      }
      commitAttempted = true;
      db.exec("COMMIT");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
      return {
        witnessMatched,
        companyLockObserved: false,
        source: "local-comparison-reservation-database-write" as const,
        storageVersion: version,
        status: "replay" as const,
        result: plan,
        inspection,
        insertedRows: 0,
        commitObserved: false,
        owner: null,
        authority: comparisonPlanAuthority,
      };
    }
    const insertedRows = persist(db, plan, version);
    // Full read of exact schema, frozen bytes, native/budget chain and every binding, in the same transaction.
    const inspection = inspectTransaction(db, selection, version);
    // The post-write inspector already audits all commands. Compare the exact confirmed result,
    // rather than running another complete planner/audit merely to look up the same nonce.
    const common = {
      source: "supplied-reservation-plan" as const,
      status: "replay" as const,
      rows: null,
      owner: null,
      authority: comparisonPlanAuthority,
    };
    const binding =
      plan.operation === "reserve"
        ? inspection.inspection.state.bindings.find(
            (b) => b.clientRequestId === plan.rows.binding.clientRequestId,
          )
        : undefined;
    const cancellation =
      plan.operation === "cancel"
        ? inspection.inspection.cancellations.find(
            (c) => c.clientRequestId === plan.rows.receipts[0].clientRequestId,
          )
        : undefined;
    if (
      plan.operation === "reserve"
        ? !binding || digest(binding) !== digest(plan.rows.binding)
        : plan.operation === "cancel" && (!cancellation || digest(cancellation) !== digest(command))
    )
      fail();
    const receiptForCommand =
      plan.operation === "cancel"
        ? plan.rows.receipts[0]
        : plan.operation === "settle-finalize"
          ? plan.rows.receipts[1]
          : plan.rows.receipt;
    const transmissionCommand = inspection.transmission?.commands.find(
      (c) => c.clientRequestId === receiptForCommand.clientRequestId,
    );
    let replay;
    if (plan.operation === "reserve") replay = { ...common, binding: binding! };
    else if (plan.operation === "cancel") replay = { ...common, command: cancellation! };
    else {
      if (!transmissionCommand || digest(transmissionCommand) !== digest(command)) fail();
      replay = {
        source:
          plan.operation === "record-result" || plan.operation === "settle-finalize"
            ? ("supplied-postcapture-plan" as const)
            : ("supplied-transmission-plan" as const),
        status: "replay" as const,
        rows: null,
        owner: null,
        authority: comparisonPlanAuthority,
        command: transmissionCommand,
        receipt: receiptForCommand,
      };
    }
    if (companyGuard) checkComparisonCompanyRead(companyGuard, companyId!);
    if (session) {
      const nonce = receiptForCommand.clientRequestId;
      checkComparisonWitnessPending(session, nonce, digest(command), witnessVersion(version));
    }
    commitAttempted = true;
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    commitObserved = true;
    if (companyGuard) {
      if (scopedCompanyRead) scopedCompanyRead.finish();
      else endComparisonCompanyRead(companyGuard);
      companyGuard = undefined;
    }
    if (session) {
      // File acknowledgement is separate from the SQL COMMIT. Re-read the durable rows first.
      try {
        db.exec("BEGIN IMMEDIATE");
        const durable = readStateTransaction(db, selection, version),
          transmission =
            version >= 12
              ? (version === 13
                  ? inspectComparisonTransmissionV4State
                  : inspectComparisonTransmissionState)({
                  reservation: durable.state,
                  transmissionBindings: durable.transmissionBindings,
                })
              : null,
          audit = transmission?.reservation ?? inspectComparisonReservationState(durable.state);
        acknowledgeComparisonWitness(
          session,
          checkpoint(db, durable, audit),
          audit.state,
          [...audit.cancellations, ...(transmission?.commands ?? [])],
          witnessVersion(version),
        );
        db.exec("COMMIT");
        if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
      } catch {
        throw observedError("PUBLIC_COMPARISON_WITNESS_ACK_REQUIRED", true);
      }
    }
    return {
      witnessMatched: !!session,
      companyLockObserved:
        !!session && (operation === "reserve" || operation === "approve-dispatch"),
      source: "local-comparison-reservation-database-write" as const,
      storageVersion: version,
      status: "committed" as const,
      result: replay,
      inspection,
      insertedRows,
      commitObserved: true,
      owner: null,
      // Own SQL commit observation conveys no caller authority or provider/human/price authenticity.
      authority: comparisonPlanAuthority,
    };
  } catch (e) {
    if (commitObserved) {
      if (db.isTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          throw observedError("PUBLIC_COMPARISON_RECOVERY_REQUIRED", true);
        }
      }
      throw observedError(
        e instanceof Error && e.message === "PUBLIC_COMPARISON_COMPANY_CLEANUP_REQUIRED"
          ? e.message
          : "PUBLIC_COMPARISON_WITNESS_ACK_REQUIRED",
        true,
      );
    }
    return rollback(db, e, commitAttempted);
  } finally {
    permits.delete(db);
    busy.delete(db);
    if (companyGuard || scopedCompanyRead?.pending()) {
      try {
        if (scopedCompanyRead) scopedCompanyRead.finish();
        else endComparisonCompanyRead(companyGuard!);
      } catch {
        throw observedError("PUBLIC_COMPARISON_COMPANY_CLEANUP_REQUIRED", commitObserved);
      }
    }
  }
}
export function reservePublicComparisonDatabase(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  command: unknown,
  current?: unknown,
) {
  return write(db, selection, "reserve", command, current);
}
export function cancelPublicComparisonDatabase(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  command: unknown,
  current?: unknown,
) {
  return write(db, selection, "cancel", command, current);
}

/** Explicit internal server composition. No route/UI/dispatcher, no actual-price or consent authority. */
type ComparisonStorageCall = {
  session: ComparisonStorageSession;
  connection: ReturnType<typeof beginComparisonStorageSession>;
  commitObserved: boolean;
};
function finishComparisonStorageCall(call: ComparisonStorageCall) {
  try { endComparisonStorageSession(call.session); }
  catch { throw observedError("PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED", call.commitObserved); }
}
function guardedWrite(
  session: ComparisonStorageSession,
  operation: Operation,
  command: unknown,
  current?: unknown,
  version: Version = 11,
) {
  const { db, selection } = beginComparisonStorageSession(session);
  let commitObserved = false;
  try {
    const result = write(db, selection, operation, command, current, session, version);
    commitObserved = result.commitObserved;
    return result;
  } catch (error) {
    commitObserved = !!(
      error &&
      typeof error === "object" &&
      "commitObserved" in error &&
      error.commitObserved === true
    );
    throw error;
  } finally {
    finishComparisonStorageCall({ session, connection: { db, selection }, commitObserved });
  }
}
export function reserveGuardedPublicComparison(
  session: ComparisonStorageSession,
  command: unknown,
  current?: unknown,
) {
  return guardedWrite(session, "reserve", command, current);
}
export function cancelGuardedPublicComparison(
  session: ComparisonStorageSession,
  command: unknown,
  current?: unknown,
) {
  return guardedWrite(session, "cancel", command, current);
}
export function initializePublicComparisonStorageWitness(
  session: ComparisonStorageSession,
  company: ComparisonCompanyGuard,
) {
  const { db, selection } = beginComparisonStorageSession(session);
  enter(db);
  try {
    db.exec("BEGIN IMMEDIATE");
    const snapshot = readStateTransaction(db, selection),
      audit = inspectComparisonReservationState(snapshot.state);
    const result = initializeComparisonWitness(
      session,
      checkpoint(db, snapshot, audit),
      audit.state,
      company,
    );
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return result;
  } catch (e) {
    return rollback(db, e, false);
  } finally {
    busy.delete(db);
    endComparisonStorageSession(session);
  }
}
export function reconcilePublicComparisonStorageWitness(session: ComparisonStorageSession) {
  const { db, selection } = beginComparisonStorageSession(session);
  enter(db);
  try {
    db.exec("BEGIN IMMEDIATE");
    const snapshot = readStateTransaction(db, selection),
      audit = inspectComparisonReservationState(snapshot.state);
    const cp = checkpoint(db, snapshot, audit);
    let repairedFilesOnly = false;
    try {
      checkComparisonWitness(session, cp);
    } catch {
      acknowledgeComparisonWitness(session, cp, audit.state, audit.cancellations);
      repairedFilesOnly = true;
    }
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return {
      source: "local-comparison-witness-reconciliation" as const,
      repairedFilesOnly,
      dispatchAllowed: false,
    };
  } catch (e) {
    return rollback(db, e, false);
  } finally {
    busy.delete(db);
    endComparisonStorageSession(session);
  }
}

/** Explicit SQL12 composition: still no runtime owner, SDK or dispatch permission. */
export function writeGuardedPublicComparisonV12(
  session: ComparisonStorageSession,
  operation: Operation,
  command: unknown,
  current?: unknown,
) {
  if (
    !["reserve", "cancel", "approve-dispatch", "mark-unknown", "persist-capture"].includes(
      operation,
    )
  )
    fail();
  return guardedWrite(session, operation, command, current, 12);
}
function inspectVersionedDatabase(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  version: 12 | 13,
) {
  enter(db);
  try {
    db.exec("BEGIN");
    const result = inspectTransaction(db, selection, version);
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return result;
  } catch (e) {
    return rollback(db, e, false);
  } finally {
    busy.delete(db);
  }
}
function actualSchema(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}
function migrateGuardedDatabase(session: ComparisonStorageSession, version: 12 | 13) {
  const { db, selection } = beginComparisonStorageSession(session);
  enter(db);
  let attempted = false,
    observed = false;
  try {
    registerGate(db, version);
    db.exec("BEGIN IMMEDIATE");
    const already = !!db
      .prepare("SELECT name FROM sqlite_schema WHERE name=? AND type='trigger'")
      .get("quality_actual_runs_v" + version + "_writer");
    if (already) {
      const snapshot = readStateTransaction(db, selection, version),
        audit = inspectTransaction(db, selection, version);
      const cp = checkpoint(db, snapshot, audit.inspection);
      checkComparisonWitness(session, cp, version === 13 ? 3 : 2);
      db.exec("COMMIT");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
      return {
        status: version === 13 ? ("already-v13" as const) : ("already-v12" as const),
        migrationCommitObserved: false,
        dispatchAllowed: false,
        owner: null,
      };
    }
    const before = readStateTransaction(db, selection, version === 13 ? 12 : 11),
      audit =
        version === 13
          ? inspectComparisonTransmissionState({
              reservation: before.state,
              transmissionBindings: before.transmissionBindings,
            }).reservation
          : inspectComparisonReservationState(before.state);
    if (
      version === 12 &&
      audit.state.archive.records.events.some(
        (e) => !["reserved", "cancelled", "finalized"].includes(e.payload.kind),
      )
    )
      fail("PUBLIC_COMPARISON_DISPATCH_ALREADY_PRESENT");
    const beforeCheckpoint = checkpoint(db, before, audit);
    const schema = actualSchema(db);
    const oldGates =
      version === 13 ? publicComparisonV12InsertGates : publicComparisonV11InsertGates;
    const newGates =
      version === 13 ? publicComparisonV13InsertGates : publicComparisonV12InsertGates;
    const expected = schema.filter((r) => !Object.hasOwn(oldGates, String(r.name)));
    for (const [name, sql] of Object.entries(newGates))
      expected.push({
        type: "trigger",
        name,
        tbl_name: name.replace(/_v(12|13)_writer$/, ""),
        sql,
      });
    // Match SQLite BINARY order, independent of host locale.
    expected.sort((a, b) =>
      String(a.type) < String(b.type)
        ? -1
        : String(a.type) > String(b.type)
          ? 1
          : String(a.name) < String(b.name)
            ? -1
            : String(a.name) > String(b.name)
              ? 1
              : 0,
    );
    const originalRowDataDigest = comparisonWitnessInventory(db, [], true);
    beginComparisonWitnessTransition(
      session,
      {
        before: beforeCheckpoint,
        beforeSchemaDigest: digest(schema),
        afterSchemaDigest: digest(expected),
        rowDataDigest: originalRowDataDigest,
        afterArchiveDigest: digest({
          reservationArchiveDigest: audit.view.archiveDigest,
          transmissionBindings: before.transmissionBindings,
        }),
      },
      before.state,
      version === 13 ? 3 : 2,
    );
    for (const name of Object.keys(oldGates)) db.exec("DROP TRIGGER " + name);
    for (const sql of Object.values(newGates)) db.exec(sql);
    const after = inspectTransaction(db, selection, version);
    if (
      digest(actualSchema(db)) !== digest(expected) ||
      digest(after.inspection.state) !== digest(before.state) ||
      digest(after.transmissionBindings) !== digest(before.transmissionBindings) ||
      comparisonWitnessInventory(db, [], true) !== originalRowDataDigest
    )
      fail();
    attempted = true;
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    observed = true;
    db.exec("BEGIN IMMEDIATE");
    const durable = readStateTransaction(db, selection, version),
      verified = inspectTransaction(db, selection, version);
    acknowledgeComparisonWitnessTransition(
      session,
      checkpoint(db, durable, verified.inspection),
      digest(actualSchema(db)),
      version === 13 ? 3 : 2,
    );
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return {
      status: version === 13 ? ("migrated-v13" as const) : ("migrated-v12" as const),
      migrationCommitObserved: true,
      dispatchAllowed: false,
      owner: null,
    };
  } catch (e) {
    if (observed) {
      if (db.isTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          throw observedError("PUBLIC_COMPARISON_RECOVERY_REQUIRED", true);
        }
      }
      throw observedError("PUBLIC_COMPARISON_WITNESS_ACK_REQUIRED", true);
    }
    return rollback(db, e, attempted);
  } finally {
    permits.delete(db);
    busy.delete(db);
    try {
      endComparisonStorageSession(session);
    } catch {
      throw observedError("PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED", observed);
    }
  }
}
function reconcileVersionedWitness(
  session: ComparisonStorageSession,
  version: 12 | 13,
  ownedLease?: OwnedComparisonLease,
  storageCall?: ComparisonStorageCall,
) {
  const active = ownedLease ? ownedComparisonLeases.get(ownedLease) : undefined;
  if (ownedLease && (!active || active.session !== session || version !== 13))
    fail("PUBLIC_COMPARISON_OWNER_REQUIRED");
  if (storageCall && (ownedLease || storageCall.session !== session || version !== 13))
    fail("PUBLIC_COMPARISON_OWNER_REQUIRED");
  const { db, selection } = active ?? storageCall?.connection ?? beginComparisonStorageSession(session);
  enter(db);
  try {
    db.exec("BEGIN IMMEDIATE");
    const snapshot = readStateTransaction(db, selection, version),
      audit = inspectTransaction(db, selection, version);
    const cp = checkpoint(db, snapshot, audit.inspection);
    let repairedFilesOnly = false;
    try {
      checkComparisonWitness(session, cp, version === 13 ? 3 : 2);
    } catch {
      // Both repairs only append an acknowledgement after full DB/schema/original-command audit.
      try {
        acknowledgeComparisonWitnessTransition(
          session,
          cp,
          digest(actualSchema(db)),
          version === 13 ? 3 : 2,
        );
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("TRANSITION_RECONCILIATION_REQUIRED"))
          throw e;
        acknowledgeComparisonWitness(
          session,
          cp,
          audit.inspection.state,
          [...audit.inspection.cancellations, ...audit.transmission!.commands],
          version === 13 ? 3 : 2,
        );
      }
      repairedFilesOnly = true;
    }
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return {
      source: "local-comparison-witness-reconciliation" as const,
      repairedFilesOnly,
      dispatchAllowed: false,
      owner: null,
    };
  } catch (e) {
    return rollback(db, e, false);
  } finally {
    busy.delete(db);
    if (!active && !storageCall) endComparisonStorageSession(session);
  }
}

export function inspectPublicComparisonDatabaseV12(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
) {
  return inspectVersionedDatabase(db, selection, 12);
}
export function inspectPublicComparisonDatabaseV13(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
) {
  return inspectVersionedDatabase(db, selection, 13);
}
export function migrateGuardedPublicComparisonDatabaseV12(session: ComparisonStorageSession) {
  return migrateGuardedDatabase(session, 12);
}
export function migrateGuardedPublicComparisonDatabaseV13(session: ComparisonStorageSession) {
  return migrateGuardedDatabase(session, 13);
}
export function reconcilePublicComparisonStorageWitnessV2(session: ComparisonStorageSession) {
  return reconcileVersionedWitness(session, 12);
}
export function reconcilePublicComparisonStorageWitnessV3(session: ComparisonStorageSession) {
  return reconcileVersionedWitness(session, 13);
}
export function writeGuardedPublicComparisonV13(
  session: ComparisonStorageSession,
  operation: Operation,
  command: unknown,
  current?: unknown,
) {
  if (
    ![
      "reserve",
      "cancel",
      "approve-dispatch",
      "mark-unknown",
      "persist-capture",
      "record-result",
      "settle-finalize",
    ].includes(operation)
  )
    fail();
  return guardedWrite(session, operation, command, current, 13);
}

// This composition is deliberately isolated: no production runtime, credential lookup or SDK.
type OwnedComparisonLease = object;
const ownedComparisonLeases = new WeakMap<
  OwnedComparisonLease,
  {
    session: ComparisonStorageSession;
    db: DatabaseSync;
    selection: PublicComparisonDatabaseSelection;
  }
>();
type ExecutionPhase =
  | "replay"
  | "dispatch-recorded"
  | "start-refused"
  | "in-flight"
  | "unknown"
  | "capture-retained"
  | "capture-persisted"
  | "draining"
  | "recovery-required"
  | "closed";

export function createIsolatedPublicComparisonExecution(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  driver: SyntheticComparisonDriver,
) {
  return createComparisonExecutionLifetime(session, companyGuard, driver).execution;
}

/** Internal provider constructor: the authentic server driver cannot skip the SQL owner.
 * Configuration is checked only for a fresh command and again inside the final read locks.
 * A stored nonce replay neither touches credentials/configuration nor prepares an SDK. */
export function createProviderPublicComparisonExecution(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  driver: ComparisonProviderDriver,
) {
  return createComparisonExecutionLifetime(
    session, companyGuard, undefined, requireComparisonProviderDriver(driver),
  ).execution;
}

function createComparisonExecutionLifetime(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  driver: SyntheticComparisonDriver | undefined,
  provider?: ReturnType<typeof requireComparisonProviderDriver>,
) {
  const lease = Object.freeze({});
  let phase: ExecutionPhase = "closed",
    retired = false,
    executing = false,
    leaseActive = false;
  let dispatchCommitObserved = false,
    witnessMatched = false,
    startAttempted = false;
  let capturePersisted = false,
    promiseSettled = false,
    cleanupRequired = false;
  let driverDone = false,
    networkDone = false,
    hookEntered = false,
    syntheticStartObserved = false;
  let command: z.infer<typeof comparisonDispatchV2CommandSchema> | undefined;
  let replaySelection: { runId: string; dispatchCommandDigest: string } | null = null;
  let postCheckpoint: ReturnType<typeof checkpoint> | undefined;
  let preDispatchCheckpoint: ReturnType<typeof checkpoint> | undefined;
  let boundary: ReturnType<typeof preparePublicComparisonTransportBoundary> | undefined;
  let retained: ReturnType<typeof captureProviderResponse> | undefined;
  let network: Promise<void> | undefined;
  let sdkCompletion: Promise<void> | undefined;
  let bodyBoundary: ReturnType<typeof createComparisonBodyBoundary> | undefined;
  let ioDone = false;
  let sdkEntered = false,
    sdkDone = false,
    decodedDelivered = false,
    networkResponseObserved = false;
  let companyReadOpen = false;
  let pending:
    | { operation: "mark-unknown" | "persist-capture"; command: unknown; current: unknown }
    | undefined;
  let dispatchUncertain = false;
  // Only this private object, created below after fresh write+ack, can enter the start boundary.
  const owners = new WeakMap<
    object,
    { bindingDigest: string; expiresAt: number; issuedAt: number; deadline: number }
  >();
  const owner = Object.freeze({});
  const inspect = () =>
    Object.freeze({
      source: provider ? "provider-comparison-execution" as const : "synthetic-comparison-execution" as const,
      phase,
      owner: null,
      runtimeObserved: false,
      ...(provider ? { providerStartObserved: syntheticStartObserved } : { syntheticStartObserved }),
      dispatchCommitObserved,
      witnessMatched,
      startAttempted,
      capturePersisted,
      promiseSettled,
      networkSettled: networkDone,
      sdkSettled: sdkEntered ? sdkDone : null,
      ioSettled: bodyBoundary ? ioDone : null,
      cleanupRequired,
      retainedCaptureCount: retained ? 1 : 0,
      authority: comparisonPlanAuthority,
    });
  function connection() {
    const active = ownedComparisonLeases.get(lease);
    if (!active || !leaseActive || active.session !== session)
      fail("PUBLIC_COMPARISON_OWNER_REQUIRED");
    return active;
  }
  function readOwned() {
    const { db, selection } = connection();
    enter(db);
    try {
      db.exec("BEGIN IMMEDIATE");
      const audit = inspectTransaction(db, selection, 13);
      const cp = checkpoint(db, { ...audit, state: audit.inspection.state }, audit.inspection);
      db.exec("ROLLBACK");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_RECOVERY_REQUIRED");
      return { audit, cp };
    } catch (error) {
      return rollback(db, error, false);
    } finally {
      busy.delete(db);
    }
  }
  function closeLease() {
    endComparisonStorageSession(session);
    ownedComparisonLeases.delete(lease);
    leaseActive = false;
  }
  function finish() {
    promiseSettled = driverDone && (!network || networkDone) && (!sdkEntered || sdkDone) && (!bodyBoundary || ioDone);
    if (bodyBoundary?.inspect().cleanupFailed) {
      cleanupRequired = true;
      phase = "recovery-required";
      return;
    }
    if (!leaseActive || !capturePersisted || !promiseSettled || pending || dispatchUncertain)
      return;
    try {
      const { db } = connection();
      if (companyReadOpen || db.isTransaction) fail("PUBLIC_COMPARISON_RECOVERY_REQUIRED");
      const { cp } = readOwned();
      checkComparisonWitness(session, cp, 3);
      closeLease();
      owners.delete(owner);
      retained = undefined;
      boundary = undefined;
      postCheckpoint = undefined;
      cleanupRequired = false;
      phase = "closed";
    } catch {
      cleanupRequired = true;
      phase = "recovery-required";
    }
  }
  function cleanOwnedReads() {
    const { db } = connection();
    if (companyReadOpen) {
      endComparisonCompanyRead(companyGuard);
      companyReadOpen = false;
    }
    if (db.isTransaction) {
      db.exec("ROLLBACK");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_RECOVERY_REQUIRED");
    }
    busy.delete(db);
  }
  function persistPending(first: boolean) {
    if (!pending) return;
    const { db, selection } = connection();
    if (!first) {
      // A failed write is never retried. Audit rows and repair only the original acknowledgement.
      reconcileVersionedWitness(session, 13, lease);
      const { audit } = readOwned();
      const replay = prepareComparisonV4StorageCommand(
        audit.transmission!.state,
        pending.operation,
        pending.command,
      );
      if (replay.status !== "replay") fail("PUBLIC_COMPARISON_CAPTURE_RECOVERY_REQUIRED");
    } else {
      const stored = write(
        db,
        selection,
        pending.operation,
        pending.command,
        pending.current,
        session,
        13,
      );
      if (!stored.witnessMatched || stored.status === "blocked")
        fail("PUBLIC_COMPARISON_CAPTURE_RECOVERY_REQUIRED");
    }
    if (pending.operation === "persist-capture") {
      capturePersisted = true;
      phase = "capture-persisted";
    } else phase = "unknown";
    pending = undefined;
    witnessMatched = true;
  }
  function continuation(operation: "mark-unknown" | "persist-capture") {
    if (!command || pending || capturePersisted) return;
    const { audit, cp } = readOwned();
    checkComparisonWitness(session, cp, 3);
    const state = audit.transmission!.state;
    const binding = state.transmissionBindings.find((b) => b.runId === command!.runId);
    if (!binding || !owners.has(owner)) fail("PUBLIC_COMPARISON_OWNER_REQUIRED");
    const events = state.reservation.archive.records.events.filter(
      (e) => e.runId === command!.runId,
    );
    if (
      operation === "mark-unknown" &&
      events.some(
        (e) => e.payload.kind === "dispatch-unknown" || e.payload.kind === "response-captured",
      )
    )
      return;
    const base = {
      commandVersion: 1,
      purpose: "compare-public-claim",
      clientRequestId: randomUUID(),
      runId: command.runId,
      transmissionBindingDigest: binding.recordDigest,
      dispatchEventDigest: binding.dispatchEventDigest,
      expectedRunHead: comparisonTransmissionCore.runHead(state, command.runId),
    };
    const at = new Date().toISOString(),
      eventId = randomUUID();
    if (operation === "persist-capture") {
      if (!retained) fail("PUBLIC_COMPARISON_CAPTURE_REQUIRED");
      pending = {
        operation,
        command: comparisonCaptureCommandSchema.parse({
          ...base,
          kind: "persist-public-comparison-capture",
          responseArtifactSha256: comparisonSha(JSON.stringify(retained)),
          sizeBytes: Buffer.byteLength(JSON.stringify(retained)),
        }),
        current: { at, eventId, capture: retained },
      };
    } else
      pending = {
        operation,
        command: comparisonUnknownCommandSchema.parse({
          ...base,
          kind: "mark-public-comparison-unknown",
          reason: startAttempted ? "transport-unknown" : "not-started-unconfirmed",
        }),
        current: { at, eventId },
      };
    persistPending(true);
  }
  function retainResponse(raw: unknown) {
    if (retained || capturePersisted) fail("PUBLIC_COMPARISON_CAPTURE_ALREADY_RETAINED");
    // First canonical copy precedes any DB access or projection, and is never overwritten.
    retained = captureProviderResponse(raw);
    phase = cleanupRequired || pending ? "recovery-required" : "capture-retained";
    try {
      if (!cleanupRequired && !pending) continuation("persist-capture");
    } catch {
      cleanupRequired = true;
      phase = "recovery-required";
    }
  }
  function unknown() {
    if (capturePersisted || retained || pending || !owners.has(owner)) return;
    hookEntered = true; // An unknown outcome never permits a later first/replacement start.
    try {
      continuation("mark-unknown");
    } catch {
      cleanupRequired = true;
      phase = "recovery-required";
    }
  }
  function startRequest<T>(
    url: unknown,
    input: unknown,
    startFake: (wire: RequestInit) => Promise<T>,
    captureRaw: boolean,
  ): Promise<T> {
    let completion: Promise<T> | undefined;
    if (
      hookEntered ||
      !owners.has(owner) ||
      retired ||
      driverDone ||
      cleanupRequired ||
      (sdkEntered && sdkDone)
    )
      fail("PUBLIC_COMPARISON_START_REFUSED");
    hookEntered = true;
    const activeOwner = owners.get(owner)!;
    const { db, selection } = connection();
    try {
      if (!boundary || !command || !postCheckpoint || typeof startFake !== "function") fail();
      const wire = provider
        ? provider.snapshotWire(boundary.rawBody, url, input)
        : snapshotProviderSdkWire(boundary.rawBody, comparisonSyntheticWireKey, url, input);
      const before = Date.now(),
        monotonic = performance.now();
      if (
        before < activeOwner.issuedAt ||
        before >= activeOwner.expiresAt ||
        monotonic >= activeOwner.deadline ||
        wire.signal?.aborted
      )
        fail("PUBLIC_COMPARISON_START_EXPIRED");
      enter(db);
      db.exec("BEGIN IMMEDIATE");
      const audit = inspectTransaction(db, selection, 13),
        cp = checkpoint(db, { ...audit, state: audit.inspection.state }, audit.inspection);
      checkComparisonWitness(session, cp, 3);
      if (digest(cp) !== digest(postCheckpoint)) fail("PUBLIC_COMPARISON_START_CHANGED");
      const state = audit.transmission!.state;
      const binding = state.transmissionBindings.find((b) => b.runId === command!.runId);
      if (
        !binding ||
        binding.recordVersion !== 4 ||
        binding.recordDigest !== activeOwner.bindingDigest ||
        digest(binding.command) !== digest(command) ||
        comparisonTransmissionCore.runHead(state, command.runId).headDigest !==
          binding.dispatchEventDigest ||
        cp.budgetRevision !== command.expectedBudgetHead.revision ||
        cp.budgetHead !== command.expectedBudgetHead.headDigest
      )
        fail("PUBLIC_COMPARISON_START_CHANGED");
      const original = comparisonTransmissionCore.original(state, command.runId);
      const review = binding.approvedReview as ComparisonTransmissionV2Review; // Fully rebuilt by the inspector above.
      checkComparisonWitnessCompany(session, companyGuard, 3);
      const company = beginComparisonCompanyRead(
        companyGuard,
        original.run.command.selection.companyId,
      );
      companyReadOpen = true;
      inspectPublicClaimComparisonRequest(company, original.run.command, original.run.identity);
      const at = new Date(before).toISOString();
      comparisonTransmissionCore.validateBasis(review.basis, state, command.runId, at);
      validateComparisonUsagePolicy(
        review.usagePolicy,
        original.review.financialBasis,
        original.run.identity,
        review.basis,
        state.reservation.prefix.environment,
        at,
      );
      checkComparisonCompanyRead(companyGuard, company.id);
      checkComparisonWitness(session, cp, 3);
      provider?.assertCurrent(selection);
      const after = Date.now();
      if (
        retired ||
        after < before ||
        after >= activeOwner.expiresAt ||
        performance.now() >= activeOwner.deadline ||
        wire.signal?.aborted
      )
        fail("PUBLIC_COMPARISON_START_EXPIRED");
      startAttempted = true;
      // Synchronous start and rejection handler installation occur inside both SELECT locks.
      // Preserve synchronous throws as an attempted but unobserved request.
      let started: Promise<T>;
      try {
        started = startFake(wire);
        syntheticStartObserved = true;
      } catch (error) {
        started = Promise.reject(error);
      }
      completion = Promise.resolve(started);
      network = completion.then(
        (raw) => {
          networkDone = true;
          if (captureRaw) {
            try {
              retainResponse(raw);
            } catch {
              cleanupRequired = true;
              phase = "recovery-required";
            }
          } else if (raw instanceof Response) {
            networkResponseObserved = raw.ok;
          } else {
            unknown();
            cleanupRequired = true;
            phase = "recovery-required";
          }
          finish();
        },
        () => {
          networkDone = true;
          unknown();
          finish();
        },
      );
      phase = "in-flight";
    } catch {
      phase = startAttempted ? "recovery-required" : "start-refused";
      cleanupRequired = startAttempted;
      // The network promise, if acquired, remains owned even when lock cleanup fails.
    } finally {
      try {
        cleanOwnedReads();
      } catch {
        cleanupRequired = true;
        phase = "recovery-required";
      }
    }
    if (!completion) return Promise.reject(Error("PUBLIC_COMPARISON_START_REFUSED"));
    return completion;
  }
  function sdk(
    invoke: (
      fetch: (url: unknown, input: unknown) => Promise<Response>,
      request: Readonly<{ signal: AbortSignal }>,
    ) => PromiseLike<unknown>,
    startFake: (url: unknown, wire: RequestInit) => Promise<Response>,
  ): Promise<void> {
    if (sdkEntered || hookEntered || !owners.has(owner) || retired || driverDone || cleanupRequired)
      fail("PUBLIC_COMPARISON_SDK_REFUSED");
    if (typeof invoke !== "function" || typeof startFake !== "function")
      fail("PUBLIC_COMPARISON_SDK_REFUSED");
    sdkEntered = true;
    bodyBoundary = createComparisonBodyBoundary();
    void bodyBoundary.completion.then(() => {
      ioDone = true;
      finish();
    });
    const failed = () => {
      unknown();
      if (!retained && !capturePersisted) phase = "recovery-required";
    };
    try {
      const io = bodyBoundary;
      const decoded = invoke(
        (url, input) => startRequest(url, input,
          (wire) => io.start(wire, (exactWire) => startFake(url, exactWire)), false),
        Object.freeze({ signal: io.signal }),
      );
      // Register the FIRST decoded callback directly. No await, projection or DB precedes capture.
      const watched = decoded.then((raw) => {
        // A misbehaving fixture cannot reopen a finished owner with a late callback.
        if (sdkDone || !owners.has(owner)) return;
        if (decodedDelivered || !networkResponseObserved || raw instanceof Response) {
          cleanupRequired = true;
          phase = "recovery-required";
          return;
        }
        decodedDelivered = true;
        try {
          retainResponse(raw);
        } catch {
          cleanupRequired = true;
          phase = "recovery-required";
        }
      }, failed);
      sdkCompletion = Promise.resolve(watched).then(
        () => {
          sdkDone = true;
          bodyBoundary!.seal();
          finish();
        },
        () => {
          failed();
          sdkDone = true;
          bodyBoundary!.seal();
          finish();
        },
      );
    } catch {
      // A factory/create/then throw cannot erase an already-started network promise.
      failed();
      sdkDone = true;
      bodyBoundary.seal();
      sdkCompletion = Promise.resolve();
    }
    return sdkCompletion;
  }
  function start(
    url: unknown,
    input: unknown,
    startFake: (wire: RequestInit) => Promise<unknown>,
  ): Promise<void> {
    if (sdkEntered) fail("PUBLIC_COMPARISON_START_REFUSED");
    const completion = startRequest(url, input, startFake, true);
    // Legacy fixture completion remains a safe observation, not a Response-returning port.
    void completion.catch(() => undefined);
    return network ?? completion.then(() => undefined);
  }
  async function execute(rawCommand: unknown, current: unknown) {
    if (executing || retired) fail("PUBLIC_COMPARISON_EXECUTION_BUSY");
    if (leaseActive) {
      const { audit } = readOwned();
      const replay = prepareComparisonV4StorageCommand(
        audit.transmission!.state,
        "approve-dispatch",
        rawCommand,
      );
      if (replay.status !== "replay" || !command || digest(replay.command) !== digest(command))
        fail("PUBLIC_COMPARISON_EXECUTION_BUSY");
      return inspect(); // An in-progress observation, never a new send capability.
    }
    executing = true;
    try {
      const active = beginComparisonStorageSession(session);
      leaseActive = true;
      ownedComparisonLeases.set(lease, { ...active, session });
      const { audit, cp } = readOwned();
      preDispatchCheckpoint = cp;
      const prepared = prepareComparisonV4StorageCommand(
        audit.transmission!.state,
        "approve-dispatch",
        rawCommand,
      );
      if (prepared.status === "replay") {
        replaySelection ??= { runId: prepared.command.runId, dispatchCommandDigest: digest(prepared.command) };
        const stored = write(
          active.db,
          active.selection,
          "approve-dispatch",
          rawCommand,
          undefined,
          session,
          13,
        );
        witnessMatched = stored.witnessMatched;
        phase = witnessMatched ? "replay" : "recovery-required";
        closeLease();
        return inspect();
      }
      if (command) {
        closeLease();
        fail("PUBLIC_COMPARISON_EXECUTION_RETIRED");
      }
      command = comparisonDispatchV2CommandSchema.parse(rawCommand);
      // Current inputs and the driver are deliberately untouched until the original nonce audit.
      assertPublicComparisonDataOnly(current, 8 * 1024 * 1024);
      const cur = z
        .object({
          approvedReview: z.unknown(),
          basis: z.unknown(),
          usagePolicy: z.unknown(),
          at: z.unknown(),
          eventId: z.unknown(),
        })
        .strict()
        .parse(current);
      const fixture = provider ? undefined : requireSyntheticComparisonDriver(driver!);
      if (provider) {
        if (active.selection.environment !== "production" ||
            active.selection.scopeId !== "candidate-quality-provider-v2-live")
          fail("COMPARISON_PROVIDER_STORAGE_MISMATCH");
        provider.assertCurrent(active.selection);
      }
      const issuedAt = Date.now(),
        startedAt = performance.now();
      dispatchUncertain = true;
      let stored: ReturnType<typeof write>;
      try {
        stored = write(
          active.db,
          active.selection,
          "approve-dispatch",
          command,
          { ...cur, companyGuard },
          session,
          13,
        );
      } catch (error) {
        // Observation only. A failed private call can never mint the send capability.
        dispatchCommitObserved =
          error instanceof Error && "commitObserved" in error && error.commitObserved === true;
        throw error;
      }
      if (stored.status !== "committed" || !stored.commitObserved || !stored.witnessMatched) fail();
      dispatchCommitObserved = true;
      const post = readOwned();
      checkComparisonWitness(session, post.cp, 3);
      const state = post.audit.transmission!.state;
      const binding = state.transmissionBindings.find((b) => b.runId === command!.runId);
      if (
        !binding ||
        binding.recordVersion !== 4 ||
        digest(binding.command) !== digest(command) ||
        comparisonTransmissionCore.runHead(state, command.runId).headDigest !==
          binding.dispatchEventDigest ||
        post.cp.budgetRevision !== command.expectedBudgetHead.revision ||
        post.cp.budgetHead !== command.expectedBudgetHead.headDigest
      )
        fail();
      const run = comparisonTransmissionCore.original(state, command.runId).run;
      const context = state.reservation.archive.records.artifacts.find(
        (a) => a.runId === run.id && a.key === "comparison-context",
      );
      if (!context) fail();
      boundary = preparePublicComparisonTransportBoundary({
        command: run.command,
        identity: run.identity,
        context: context.body,
      });
      const review = binding.approvedReview as ComparisonTransmissionV2Review;
      const expiresAt = Date.parse(review.expiresAt);
      postCheckpoint = post.cp;
      if (retired) fail("PUBLIC_COMPARISON_EXECUTION_RETIRED");
      owners.set(owner, {
        bindingDigest: binding.recordDigest,
        expiresAt,
        issuedAt,
        deadline: startedAt + Math.max(0, expiresAt - issuedAt),
      });
      dispatchUncertain = false;
      witnessMatched = true;
      phase = "dispatch-recorded";
      executing = false;
      try {
        if (provider) await provider.run(boundary, Object.freeze({ sdk }));
        else await fixture!(boundary, Object.freeze({ start, sdk, markUnknown: unknown }));
      } catch {
        unknown();
      } finally {
        driverDone = true;
        if (network) await network;
        if (sdkCompletion) await sdkCompletion;
        if (bodyBoundary) await bodyBoundary.completion;
        promiseSettled = driverDone && (!network || networkDone) && (!sdkEntered || sdkDone) && (!bodyBoundary || ioDone);
        if (!retained && !capturePersisted) {
          unknown();
          phase = "recovery-required";
        }
        finish();
      }
      return inspect();
    } catch {
      let unchangedBeforeDispatch =
        !dispatchUncertain && !dispatchCommitObserved && !owners.has(owner);
      if (
        leaseActive &&
        dispatchUncertain &&
        !dispatchCommitObserved &&
        !owners.has(owner) &&
        preDispatchCheckpoint
      ) {
        try {
          const unchanged = readOwned();
          checkComparisonWitness(session, unchanged.cp, 3);
          unchangedBeforeDispatch = digest(unchanged.cp) === digest(preDispatchCheckpoint);
        } catch {
          /* An intent, changed row or uncertain transaction must retain its lease. */
        }
      }
      if (leaseActive && unchangedBeforeDispatch) {
        try {
          cleanOwnedReads();
          closeLease();
        } catch {
          /* Keep cleanup responsibility. */
        }
      }
      cleanupRequired = leaseActive;
      phase = leaseActive ? "recovery-required" : "start-refused";
      return inspect();
    } finally {
      executing = false;
    }
  }
  function recover(raw: unknown) {
    assertPublicComparisonDataOnly(raw, 1024);
    const selected = z
      .object({
        runId: z.string().uuid(),
        dispatchCommandDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(raw);
    if (
      !command ||
      command.runId !== selected.runId ||
      digest(command) !== selected.dispatchCommandDigest ||
      !leaseActive
    )
      fail("PUBLIC_COMPARISON_OWNER_REQUIRED");
    try {
      cleanOwnedReads();
      if (pending) persistPending(false);
      else reconcileVersionedWitness(session, 13, lease);
      cleanupRequired = false;
      if (retained && !capturePersisted && !pending) continuation("persist-capture");
      if (!retained && !capturePersisted && promiseSettled && owners.has(owner)) {
        unknown();
        phase = "recovery-required";
      }
      finish();
    } catch {
      cleanupRequired = true;
      phase = "recovery-required";
    }
    return inspect();
  }
  const execution = Object.freeze({
    execute,
    recover,
    inspect,
    retire() {
      retired = true;
      if (leaseActive) phase = "draining";
      finish();
      return inspect();
    },
  });
  return {
    execution,
    originalSelection: () => command ? { runId: command.runId, dispatchCommandDigest: digest(command) } : replaySelection,
    // This closure never leaves the module or accepts a public observation as proof.
    // No capture/active/phase count can substitute for the original lease and IO lifetime.
    canRelease: () =>
      !leaseActive && !executing && !companyReadOpen && !pending && !dispatchUncertain &&
      !owners.has(owner) && (!network || networkDone) && (!sdkEntered || sdkDone) &&
      (!bodyBoundary || (ioDone && !bodyBoundary.inspect().cleanupFailed)) &&
      (!command || driverDone || (!dispatchCommitObserved && !startAttempted)),
  };
}

type PostcaptureOperation = "record-result" | "settle-finalize";
const postcaptureSelection = z.object({
  runId: z.string().uuid(),
  dispatchCommandDigest: comparisonHashSchema,
}).strict();
const storedComparisonSelection = postcaptureSelection.extend({
  comparisonEventDigest: comparisonHashSchema,
  responseArtifactSha256: comparisonHashSchema,
  validatedArtifactSha256: comparisonHashSchema,
}).strict();
type StoredComparisonSelection = z.infer<typeof storedComparisonSelection>;
type StoredComparisonRead = {
  source: "synthetic-comparison-stored-review";
  resultIdentity: StoredComparisonSelection & {
    requestIdentity: ReturnType<typeof publicComparisonValidatedBody>["requestIdentity"];
    preparationDigest: string;
    selection: ReturnType<typeof inspectArchivedPublicClaimRequest>["prepared"]["selection"];
    binding: ReturnType<typeof inspectArchivedPublicClaimRequest>["prepared"]["binding"];
  };
  historical: {
    prepared: ReturnType<typeof inspectArchivedPublicClaimRequest>["prepared"];
    result: ReturnType<typeof publicComparisonValidatedBody>;
    currentContextVerified: false;
  };
  database: PostcapturePreview["database"];
  current: { status: "not-checked" | "exact-original-request" | "changed" | "unavailable";
    originalRevision: number; observedRevision: number | null; reason: string | null };
  owner: null;
  runtimeObserved: false;
  authority: typeof comparisonPlanAuthority;
};
export type StoredComparisonCatalog = {
  source: "comparison-stored-catalog";
  companyId: string;
  companyRevision: number;
  reviews: Array<StoredComparisonRead["resultIdentity"] & {
    sectionKey: string;
    sectionTitle: string;
    claimQuote: string;
  }>;
  currentContextVerified: false;
  runtimeObserved: false;
  authority: typeof comparisonPlanAuthority;
};
type PostcaptureSelection = z.infer<typeof postcaptureSelection>;
type PostcapturePreview = Omit<ReturnType<typeof createComparisonPostcapturePreview>, "source"> & {
  source: "synthetic-comparison-postcapture";
  runtimeObserved: false;
  runId: string;
  dispatchCommandDigest: string;
  transmissionBindingDigest: string;
  dispatchEventDigest: string;
  expectedRunHead: { revision: number; headDigest: string };
  expectedBudgetHead: { revision: number; headDigest: string | null };
  comparisonEventDigest: string | null;
  database: { comparisonRecorded: boolean; costSettled: boolean; finalized: boolean;
    currentContextVerified: false; runHeldBytes: number; scopeHeldUnits: string; scopeRecognizedUnits: string };
};
type PostcaptureReceipt = Readonly<{
  source: "synthetic-comparison-postcapture";
  status: "committed" | "replay" | "blocked";
  runId: string;
  commandDigest: string;
  insertedRows: number;
  commitObserved: boolean;
  witnessMatched: boolean;
  owner: null;
  runtimeObserved: false;
  authority: typeof comparisonPlanAuthority;
}>;
type IsolatedComparisonLifetime = ReturnType<typeof createComparisonExecutionLifetime>;
type IsolatedComparisonView = ReturnType<IsolatedComparisonLifetime["execution"]["inspect"]>;
export type IsolatedPublicComparisonService = Readonly<{
  execute(command: unknown, current: unknown): Promise<IsolatedComparisonView>;
  recover(selection: unknown): IsolatedComparisonView;
  previewPostcapture(selection: unknown): PostcapturePreview;
  readStoredReviewByRun(query: unknown): StoredComparisonRead;
  readStoredComparison(selection: unknown): StoredComparisonRead;
  inspectStoredComparisonContext(selection: unknown): StoredComparisonRead;
  writePostcapture(operation: PostcaptureOperation, command: unknown, current?: unknown): PostcaptureReceipt;
  recoverPostcapture(operation: PostcaptureOperation, command: unknown): PostcaptureReceipt;
  inspect(): Readonly<{
    source: "synthetic-comparison-service";
    status: "ready" | "draining" | "closed";
    activeCalls: number;
    execution: IsolatedComparisonView;
    postcapture: Readonly<{
      status: "unused" | "review" | "stored" | "blocked" | "recovery-required";
      runId: string | null;
      commandDigest: string | null;
      cleanupRequired: boolean;
    }>;
    owner: null;
    runtimeObserved: false;
    authority: typeof comparisonPlanAuthority;
  }>;
  retire(): ReturnType<IsolatedPublicComparisonService["inspect"]>;
}>;

export function createIsolatedPublicComparisonService(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  driver: SyntheticComparisonDriver,
): IsolatedPublicComparisonService {
  const lifetime = createComparisonExecutionLifetime(session, companyGuard, driver);
  // This branch always starts with an execution; its last view survives retirement.
  return createComparisonService(session, companyGuard, lifetime).service as IsolatedPublicComparisonService;
}

/** Same audited postcapture owner, with a provider lifetime and explicit provenance.
 * Borrows the session/guard; close confirms handoff before their owner can release them. */
export function createProviderPublicComparisonService(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  driver: ComparisonProviderDriver,
) {
  const lifetime = createComparisonExecutionLifetime(
    session, companyGuard, undefined, requireComparisonProviderDriver(driver),
  );
  const backend = createComparisonService(session, companyGuard, lifetime);
  const service = backend.service;
  const inspect = () => Object.freeze({ ...service.inspect(), source: "provider-comparison-service" as const });
  const postcapture = <T extends PostcapturePreview | PostcaptureReceipt>(value: T):
    Readonly<Omit<T, "source"> & { source: "provider-comparison-postcapture" }> =>
    Object.freeze({ ...value, source: "provider-comparison-postcapture" as const });
  const stored = (value: StoredComparisonRead) =>
    Object.freeze({ ...value, source: "comparison-stored-review" as const });
  return Object.freeze({
    execute: service.execute,
    recover: service.recover,
    prepareTransmission: backend.prepareTransmission,
    previewPostcapture: (selection: unknown) => postcapture(service.previewPostcapture(selection)),
    readStoredReviewByRun: (query: unknown) => stored(service.readStoredReviewByRun(query)),
    readStoredComparison: (selection: unknown) => stored(service.readStoredComparison(selection)),
    inspectStoredComparisonContext: (selection: unknown) => stored(service.inspectStoredComparisonContext(selection)),
    writePostcapture: (operation: PostcaptureOperation, command: unknown, current?: unknown) =>
      postcapture(service.writePostcapture(operation, command, current)),
    recoverPostcapture: (operation: PostcaptureOperation, command: unknown) =>
      postcapture(service.recoverPostcapture(operation, command)),
    inspect,
    close() {
      service.retire();
      backend.finishRead();
      if (service.inspect().status !== "closed") fail("PUBLIC_COMPARISON_SERVICE_CLEANUP_REQUIRED");
      return inspect();
    },
  });
}

function createComparisonService(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  lifetime: IsolatedComparisonLifetime | undefined,
) {
  let last = lifetime?.execution.inspect() ?? null;
  let original: PostcaptureSelection | null = null;
  let selected: PostcaptureSelection | null = null;
  let retired = false, postBusy = false;
  let storage: ComparisonStorageCall | undefined;
  let companyRead: ReturnType<typeof createComparisonCompanyReadScope> | undefined;
  let readStorage: ComparisonStorageCall | undefined;
  let qualityReadOpen = false;
  let postStatus: ReturnType<IsolatedPublicComparisonService["inspect"]>["postcapture"]["status"] = "unused";
  // Kept only for uncertain writes. Recovery never substitutes a fresh command/current/nonce.
  let retained: { operation: PostcaptureOperation; command: unknown; current?: unknown } | undefined;
  const pending = new Set<Promise<IsolatedComparisonView>>();
  function refresh() {
    if (!lifetime) return;
    last = lifetime.execution.inspect();
    original = lifetime.originalSelection() ?? original;
    if (retired && pending.size === 0 && lifetime.canRelease()) lifetime = undefined;
  }
  function requireHandoff() {
    refresh();
    if (postBusy || pending.size || (lifetime && !lifetime.canRelease()))
      fail("PUBLIC_COMPARISON_POSTCAPTURE_EXECUTION_PENDING");
  }
  function cleanStorage() {
    companyRead?.finish();
    companyRead = undefined;
    if (!storage) return;
    // Only this service's successful acquisition can reach this explicit cleanup.
    if (storage.connection.db.isTransaction && (readStorage !== storage || qualityReadOpen))
      storage.connection.db.exec("ROLLBACK");
    finishComparisonStorageCall(storage);
    storage = undefined;
    readStorage = undefined;
    qualityReadOpen = false;
  }
  function withStorage<T>(work: (call: ComparisonStorageCall) => T): T {
    if (storage) fail("PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED");
    storage = { session, connection: beginComparisonStorageSession(session), commitObserved: false };
    const call = storage;
    try {
      return work(call);
    } catch (error) {
      call.commitObserved ||= !!(error && typeof error === "object" && "commitObserved" in error && error.commitObserved === true);
      throw error;
    } finally {
      try {
        if (companyRead?.pending()) fail("PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED");
        finishComparisonStorageCall(call);
        storage = undefined;
        readStorage = undefined;
        qualityReadOpen = false;
      } catch (error) {
        postStatus = "recovery-required";
        throw error;
      }
    }
  }
  function read(call: ComparisonStorageCall) {
    const { db, selection } = call.connection;
    const a = inspectVersionedDatabase(db, selection, 13);
    checkComparisonWitnessCompany(session, companyGuard, 3);
    return {
      a,
      state: a.transmission!.state,
      cp: checkpoint(db, { ...a, state: a.inspection.state }, a.inspection),
    };
  }
  function select(state: ReturnType<typeof read>["state"], raw: unknown) {
    assertPublicComparisonDataOnly(raw);
    const requested = postcaptureSelection.parse(raw);
    if ((original && digest(original) !== digest(requested)) ||
        (selected && digest(selected) !== digest(requested)))
      fail("PUBLIC_COMPARISON_POSTCAPTURE_RUN_CHANGED");
    const binding = state.transmissionBindings.find((b) => b.runId === requested.runId);
    if (!binding || digest(binding.command) !== requested.dispatchCommandDigest)
      fail("PUBLIC_COMPARISON_POSTCAPTURE_RUN_CHANGED");
    return { requested, binding };
  }
  function storedRead(raw: unknown, currentRequested: boolean): StoredComparisonRead {
    requireHandoff();
    if (retained) fail("PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED");
    const requested = storedComparisonSelection.parse(copyComparisonStoredRead(raw, "selection"));
    postBusy = true;
    try {
      cleanStorage();
      return withStorage((call) => {
        readStorage = call;
        const { db, selection } = call.connection;
        enter(db);
        try {
          try { db.exec("BEGIN"); }
          finally { qualityReadOpen = db.isTransaction; }
          if (!qualityReadOpen) fail("PUBLIC_COMPARISON_STORED_READ_LOCK_LOST");
          const a = inspectTransaction(db, selection, 13);
          checkComparisonWitnessCompany(session, companyGuard, 3);
          const cp = checkpoint(db, { ...a, state: a.inspection.state }, a.inspection);
          checkComparisonWitness(session, cp, 3);
          const state = a.transmission!.state;
          const pick = select(state, { runId: requested.runId, dispatchCommandDigest: requested.dispatchCommandDigest });
          const records = state.reservation.archive.records;
          const run = records.runs.find((r) => r.id === requested.runId)!;
          const event = records.events.find((e) => e.runId === run.id && e.payload.kind === "comparison-recorded");
          if (!event) fail("PUBLIC_COMPARISON_STORED_RESULT_MISSING");
          if (event.eventDigest !== requested.comparisonEventDigest ||
              event.payload.kind !== "comparison-recorded" ||
              event.payload.responseArtifactSha256 !== requested.responseArtifactSha256 ||
              event.payload.validatedArtifactSha256 !== requested.validatedArtifactSha256)
            fail("PUBLIC_COMPARISON_STORED_RESULT_CHANGED");
          const context = records.artifacts.find((v) => v.runId === run.id && v.key === "comparison-context")!;
          const response = records.artifacts.find((v) => v.runId === run.id && v.key === "comparison-response")!;
          const validated = records.artifacts.find((v) => v.runId === run.id && v.key === "comparison-validated")!;
          const { prepared } = inspectArchivedPublicClaimRequest(run.command, context.body);
          const result = publicComparisonValidatedBody(run.identity, response.sha256,
            derivePublicComparisonCapturedResult(prepared, captureProviderResponse(JSON.parse(response.body)), run.command.model));
          // The whole SQL13 audit already proves the event, receipt, artifacts and original request.
          // Repeat the narrow projection equality; never trust an isolated validated JSON object.
          if (validated.sha256 !== requested.validatedArtifactSha256 || validated.body !== JSON.stringify(result))
            fail("PUBLIC_COMPARISON_STORED_RESULT_CHANGED");
          selected = pick.requested;
          const current: StoredComparisonRead["current"] = {
            status: "not-checked", originalRevision: run.command.selection.companyRevision,
            observedRevision: null, reason: null,
          };
          if (currentRequested) {
            companyRead = createComparisonCompanyReadScope(companyGuard);
            try {
              const company = companyRead.read(run.command.selection.companyId);
              current.observedRevision = company.revision;
              try {
                inspectPublicClaimComparisonRequest(company, run.command, run.identity);
                current.status = "exact-original-request";
              } catch (error) {
                const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
                if (["PUBLIC_CLAIM_STALE", "PUBLIC_CLAIM_MISSING", "PUBLIC_CLAIM_REQUEST_CHANGED"].includes(code)) {
                  current.status = "changed"; current.reason = code;
                } else {
                  current.status = "unavailable";
                  current.reason = ["PUBLIC_CLAIM_HISTORY", "PUBLIC_CLAIM_FORMAT", "PUBLIC_CLAIM_LIMIT",
                    "PUBLIC_CLAIM_UNSUPPORTED", "PUBLIC_CLAIM_REQUEST_LIMIT"].includes(code) ? code : "CURRENT_AUDIT_UNAVAILABLE";
                }
              }
              companyRead.check(company.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              // File/binding/lock failures cannot be converted to a historical success.
              if (message.startsWith("PUBLIC_COMPARISON_") &&
                  !["PUBLIC_COMPARISON_COMPANY_TRANSACTION_ACTIVE", "PUBLIC_COMPARISON_COMPANY_ROW_INVALID"].includes(message))
                throw error;
              current.status = "unavailable";
              current.reason = message === "PUBLIC_COMPARISON_COMPANY_TRANSACTION_ACTIVE" ? "COMPANY_BUSY" :
                message === "PUBLIC_COMPARISON_COMPANY_ROW_INVALID" ? "COMPANY_ROW_INVALID" : "CURRENT_READ_UNAVAILABLE";
            }
          }
          checkComparisonWitness(session, cp, 3);
          const native = a.inspection.view.native;
          const saved = native.runs.find((r) => r.runId === run.id)!;
          postStatus = "review";
          return copyComparisonStoredRead({
            source: "synthetic-comparison-stored-review" as const,
            resultIdentity: { ...requested, requestIdentity: run.identity,
              preparationDigest: prepared.preparationDigest, selection: prepared.selection, binding: prepared.binding },
            historical: { prepared, result, currentContextVerified: false as const },
            database: { comparisonRecorded: saved.comparisonRecorded, costSettled: saved.costSettled,
              finalized: saved.finalized, currentContextVerified: false as const, runHeldBytes: saved.heldBytes,
              scopeHeldUnits: native.heldUnits, scopeRecognizedUnits: native.recognizedUnits },
            current, owner: null, runtimeObserved: false as const, authority: comparisonPlanAuthority,
          }, "result");
        } finally {
          try {
            companyRead?.finish();
            companyRead = undefined;
            if (qualityReadOpen) {
              db.exec("ROLLBACK");
              if (db.isTransaction) fail("PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED");
              qualityReadOpen = false;
            }
          } finally { busy.delete(db); }
        }
      });
    } finally { postBusy = false; refresh(); }
  }
  function listStoredReviews(raw: unknown): StoredComparisonCatalog {
    requireHandoff();
    if (retained) fail("PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED");
    const query = z.object({ companyId: z.string().uuid(),
      companyRevision: z.number().int().nonnegative().safe() }).strict()
      .parse(copyComparisonStoredRead(raw, "selection"));
    postBusy = true;
    try {
      cleanStorage();
      return withStorage((call) => {
        readStorage = call;
        const { db, selection } = call.connection;
        enter(db);
        try {
          try { db.exec("BEGIN"); }
          finally { qualityReadOpen = db.isTransaction; }
          if (!qualityReadOpen) fail("PUBLIC_COMPARISON_STORED_READ_LOCK_LOST");
          // Audit the complete archive before projecting any company-specific metadata.
          const a = inspectTransaction(db, selection, 13);
          checkComparisonWitnessCompany(session, companyGuard, 3);
          const cp = checkpoint(db, { ...a, state: a.inspection.state }, a.inspection);
          checkComparisonWitness(session, cp, 3);
          companyRead = createComparisonCompanyReadScope(companyGuard);
          const company = companyRead.read(query.companyId);
          if (company.revision !== query.companyRevision)
            fail("PUBLIC_COMPARISON_CATALOG_COMPANY_CHANGED");
          const state = a.transmission!.state, records = state.reservation.archive.records;
          const reviews: StoredComparisonCatalog["reviews"] = [];
          for (const run of records.runs) {
            if (run.command.selection.companyId !== company.id) continue;
            const event = records.events.find((e) => e.runId === run.id && e.payload.kind === "comparison-recorded");
            if (!event || event.payload.kind !== "comparison-recorded") continue;
            const binding = state.transmissionBindings.find((b) => b.runId === run.id);
            const context = records.artifacts.find((v) => v.runId === run.id && v.key === "comparison-context");
            if (!binding || !context) fail("PUBLIC_COMPARISON_STORED_RESULT_MISSING");
            const { prepared } = inspectArchivedPublicClaimRequest(run.command, context.body);
            reviews.push({ runId: run.id, dispatchCommandDigest: digest(binding.command),
              comparisonEventDigest: event.eventDigest,
              responseArtifactSha256: event.payload.responseArtifactSha256,
              validatedArtifactSha256: event.payload.validatedArtifactSha256,
              requestIdentity: run.identity, preparationDigest: prepared.preparationDigest,
              selection: prepared.selection, binding: prepared.binding,
              sectionKey: prepared.input.section.key, sectionTitle: prepared.input.section.title,
              claimQuote: prepared.input.claimQuote });
          }
          companyRead.check(company.id);
          checkComparisonWitness(session, cp, 3);
          // A catalog describes historical records. Company existence/revision alone
          // does not verify today's claim, evidence or original request context.
          return copyComparisonStoredRead({ source: "comparison-stored-catalog" as const,
            ...query, reviews, currentContextVerified: false as const,
            runtimeObserved: false as const, authority: comparisonPlanAuthority }, "result");
        } finally {
          try {
            companyRead?.finish();
            companyRead = undefined;
            if (qualityReadOpen) {
              db.exec("ROLLBACK");
              if (db.isTransaction) fail("PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED");
              qualityReadOpen = false;
            }
          } finally { busy.delete(db); }
        }
      });
    } finally { postBusy = false; refresh(); }
  }
  function parseCommand(operation: PostcaptureOperation, raw: unknown) {
    if (operation !== "record-result" && operation !== "settle-finalize")
      fail("PUBLIC_COMPARISON_POSTCAPTURE_OPERATION");
    assertPublicComparisonDataOnly(raw);
    return (operation === "record-result" ? comparisonResultCommandSchema : comparisonCloseCommandSchema).parse(raw);
  }
  function storageOperation(operation: PostcaptureOperation, raw: unknown, current: unknown, recovery: boolean) {
    requireHandoff();
    const command = parseCommand(operation, raw);
    if (retained && (retained.operation !== operation || digest(retained.command) !== digest(command)))
      fail("PUBLIC_COMPARISON_POSTCAPTURE_ORIGINAL_COMMAND_REQUIRED");
    if (!recovery && (retained || storage || companyRead))
      fail("PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED");
    postBusy = true;
    try {
      if (recovery) {
        retained ??= { operation, command: structuredClone(command) };
        cleanStorage();
      }
      const receipt = withStorage((call) => {
        const { state, cp } = read(call);
        const b = state.transmissionBindings.find((b) => b.runId === command.runId);
        const { requested } = select(state, {
          runId: command.runId, dispatchCommandDigest: b ? digest(b.command) : "",
        });
        // This full original nonce/command audit precedes all inspection of current.
        const prepared = prepareComparisonV4StorageCommand(state, operation, command);
        if (recovery && prepared.status !== "replay") {
          selected = requested;
          retained ??= { operation, command: structuredClone(command) };
          fail("PUBLIC_COMPARISON_POSTCAPTURE_RECORD_NOT_FOUND");
        }
        if (prepared.status !== "replay") {
          checkComparisonWitness(session, cp, 3);
          const plan = planComparisonPostcapture(state, command, current);
          if (plan.status !== "blocked") {
            assertPublicComparisonDataOnly(current);
            retained = { operation, command: structuredClone(command), current: structuredClone(current) };
          }
        } else retained ??= { operation, command: structuredClone(command) };
        selected = requested;
        let result: Pick<ReturnType<typeof write>, "status" | "insertedRows" | "commitObserved" | "witnessMatched">;
        if (recovery) {
          try { checkComparisonWitness(session, cp, 3); }
          catch {
            checkComparisonWitnessPending(session, command.clientRequestId, digest(command), 3);
            reconcileVersionedWitness(session, 13, undefined, call);
          }
          const durable = read(call);
          const recorded = prepareComparisonV4StorageCommand(durable.state, operation, command);
          if (recorded.status !== "replay") fail("PUBLIC_COMPARISON_POSTCAPTURE_RECORD_NOT_FOUND");
          checkComparisonWitness(session, durable.cp, 3);
          // Recovery has no INSERT-capable writer invocation, even after the first audit/ack.
          result = { status: "replay", insertedRows: 0, commitObserved: false, witnessMatched: true };
        } else {
          result = write(call.connection.db, call.connection.selection, operation, command,
            prepared.status === "replay" ? undefined : retained?.current, session, 13);
        }
        call.commitObserved = result.commitObserved;
        postStatus = result.status === "blocked" ? "blocked" : result.witnessMatched ? "stored" : "recovery-required";
        // No archive, canonical bytes, row vectors, paths or capabilities leave this service.
        return Object.freeze({
          source: "synthetic-comparison-postcapture" as const,
          status: result.status,
          runId: command.runId,
          commandDigest: digest(command),
          insertedRows: result.insertedRows,
          commitObserved: result.commitObserved,
          witnessMatched: result.witnessMatched,
          owner: null,
          runtimeObserved: false as const,
          authority: comparisonPlanAuthority,
        });
      });
      if (receipt.witnessMatched) retained = undefined;
      return receipt;
    } catch (error) {
      if (retained || storage) postStatus = "recovery-required";
      throw error;
    } finally {
      postBusy = false;
      refresh();
    }
  }
  function previewPostcapture(raw: unknown): PostcapturePreview {
    requireHandoff();
    if (retained) fail("PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED");
    postBusy = true;
    try {
      cleanStorage(); // An explicit read can finish only its own previously failed read cleanup.
      return withStorage((call) => {
        const { a, state, cp } = read(call);
        const { requested, binding } = select(state, raw);
        checkComparisonWitness(session, cp, 3);
        const preview = createComparisonPostcapturePreview(state, requested.runId);
        const events = state.reservation.archive.records.events.filter((e) => e.runId === requested.runId);
        const head = events.at(-1)!;
        const run = a.inspection.view.native.runs.find((r) => r.runId === requested.runId)!;
        selected = requested;
        postStatus = "review";
        return structuredClone({ ...preview, source: "synthetic-comparison-postcapture" as const,
          runtimeObserved: false as const, ...requested,
          transmissionBindingDigest: binding.recordDigest,
          dispatchEventDigest: binding.dispatchEventDigest,
          expectedRunHead: { revision: head.revision, headDigest: head.eventDigest },
          expectedBudgetHead: { revision: a.inspection.view.native.revision, headDigest: a.inspection.view.native.headDigest },
          comparisonEventDigest: events.find((e) => e.payload.kind === "comparison-recorded")?.eventDigest ?? null,
          database: { comparisonRecorded: run.comparisonRecorded, costSettled: run.costSettled,
            finalized: run.finalized, currentContextVerified: false as const, runHeldBytes: run.heldBytes,
            scopeHeldUnits: a.inspection.view.native.heldUnits, scopeRecognizedUnits: a.inspection.view.native.recognizedUnits },
        });
      });
    } finally { postBusy = false; refresh(); }
  }
  const inspect = (): Omit<ReturnType<IsolatedPublicComparisonService["inspect"]>, "execution"> & {
    execution: IsolatedComparisonView | null;
  } => {
    refresh();
    return Object.freeze({
      source: "synthetic-comparison-service",
      status: retired ? (!lifetime && !postBusy && !retained && !storage && !companyRead ? "closed" : "draining") : "ready",
      activeCalls: pending.size,
      execution: last,
      postcapture: Object.freeze({ status: postStatus, runId: selected?.runId ?? null,
        commandDigest: retained ? digest(retained.command) : null, cleanupRequired: !!storage || !!companyRead }),
      owner: null,
      runtimeObserved: false,
      authority: comparisonPlanAuthority,
    });
  };
  function reservationRead<T>(work: (state: ReturnType<typeof read>["state"], audit: ReturnType<typeof inspectComparisonReservationState>) => T): T {
    requireHandoff();
    if (retired || original || selected || retained) fail("PUBLIC_COMPARISON_PREPARATION_CLOSED");
    postBusy = true;
    try {
      cleanStorage();
      return withStorage((call) => {
        readStorage = call;
        const { db, selection } = call.connection;
        enter(db);
        try {
          try { db.exec("BEGIN IMMEDIATE"); }
          finally { qualityReadOpen = db.isTransaction; }
          if (!qualityReadOpen) fail("PUBLIC_COMPARISON_APPROVAL_LOCK_LOST");
          const a = inspectTransaction(db, selection, 13);
          checkComparisonWitnessCompany(session, companyGuard, 3);
          const cp = checkpoint(db, { ...a, state: a.inspection.state }, a.inspection);
          checkComparisonWitness(session, cp, 3);
          companyRead = createComparisonCompanyReadScope(companyGuard);
          const value = work(a.transmission!.state, a.inspection);
          checkComparisonWitness(session, cp, 3);
          return structuredClone(value);
        } finally {
          try {
            companyRead?.finish();
            companyRead = undefined;
            if (qualityReadOpen) {
              db.exec("ROLLBACK");
              if (db.isTransaction) fail("PUBLIC_COMPARISON_APPROVAL_CLEANUP_REQUIRED");
              qualityReadOpen = false;
            }
          } finally { busy.delete(db); }
        }
      });
    } finally { postBusy = false; }
  }
  const service = Object.freeze({
    async execute(command: unknown, current: unknown) {
      if (retired || !lifetime || selected || postBusy || storage || retained || companyRead)
        fail("PUBLIC_COMPARISON_SERVICE_RETIRED");
      if (original) {
        assertPublicComparisonDataOnly(command);
        if (digest(command) !== original.dispatchCommandDigest) fail("PUBLIC_COMPARISON_POSTCAPTURE_RUN_CHANGED");
      }
      const call = lifetime.execution.execute(command, current);
      pending.add(call);
      try { return await call; }
      finally { pending.delete(call); refresh(); }
    },
    recover(selection: unknown) {
      if (!lifetime) fail("PUBLIC_COMPARISON_SERVICE_CLOSED");
      try { return lifetime.execution.recover(selection); }
      finally { refresh(); }
    },
    previewPostcapture,
    readStoredReviewByRun(raw: unknown) {
      requireHandoff();
      const query = postcaptureSelection.extend({
        mode: z.enum(["historical", "inspect-current"]),
      }).strict().parse(copyComparisonStoredRead(raw, "selection"));
      const preview = previewPostcapture({ runId: query.runId, dispatchCommandDigest: query.dispatchCommandDigest });
      if (!preview.database.comparisonRecorded || !preview.comparisonEventDigest)
        fail("PUBLIC_COMPARISON_STORED_RESULT_MISSING");
      // Separate audited reads, not one snapshot. The second read verifies the actual event/artifacts again.
      return storedRead({
        runId: preview.runId, dispatchCommandDigest: preview.dispatchCommandDigest,
        comparisonEventDigest: preview.comparisonEventDigest,
        responseArtifactSha256: preview.responseArtifactSha256,
        validatedArtifactSha256: preview.expectedValidatedArtifactSha256,
      }, query.mode === "inspect-current");
    },
    readStoredComparison: (raw: unknown) => storedRead(raw, false),
    inspectStoredComparisonContext: (raw: unknown) => storedRead(raw, true),
    writePostcapture: (operation: PostcaptureOperation, command: unknown, current?: unknown) =>
      storageOperation(operation, command, current, false),
    recoverPostcapture: (operation: PostcaptureOperation, command: unknown) =>
      storageOperation(operation, command, undefined, true),
    inspect,
    retire() { retired = true; lifetime?.execution.retire(); return inspect(); },
  });
  return {
    service,
    listStoredReviews,
    prepareCancellation(raw: unknown, atRaw: string) {
      const query = cancellationSelectionSchema.parse(raw), at = z.string().datetime().parse(atRaw);
      return reservationRead((state, audit) => {
        const company = companyRead!.read(query.companyId);
        if (company.revision !== query.companyRevision) fail("PUBLIC_COMPARISON_CANCEL_SELECTION_CHANGED");
        const run = state.reservation.archive.records.runs.find(r => r.id === query.runId);
        const binding = state.reservation.bindings.find(b => b.runId === query.runId);
        const summary = audit.view.native.runs.find(r => r.runId === query.runId);
        if (!run || !binding || !summary || run.command.selection.companyId !== query.companyId ||
            summary.dispatchRecorded || summary.costSettled || summary.finalized || state.transmissionBindings.some(b => b.runId === query.runId))
          fail("PUBLIC_COMPARISON_NOT_CANCELLABLE");
        const context = state.reservation.archive.records.artifacts.find(a => a.runId === query.runId && a.key === "comparison-context");
        if (!context) fail("PUBLIC_COMPARISON_RESERVATION_REQUIRED");
        const {prepared} = inspectArchivedPublicClaimRequest(run.command, context.body);
        const body = {...query, databaseInstanceId: state.reservation.prefix.databaseInstanceId,
          reservationCompanyRevision: run.command.selection.companyRevision, model: run.command.model,
          sectionTitle: prepared.input.section.title, currency: run.manifest.currency, unitScale: run.manifest.unitScale,
          releasedUnits: run.manifest.reservedUnits, inspectedAt: at, expiresAt: new Date(Date.parse(at)+600000).toISOString(),
          expectedBindingDigest: binding.recordDigest, reservationDigest: binding.budgetEventDigest,
          expectedRunHead: {revision:summary.revision,headDigest:summary.headDigest},
          expectedBudgetHead: {revision:audit.view.native.revision,headDigest:audit.view.native.headDigest},notice:cancellationNotice};
        companyRead!.check(company.id);
        return {...body,reviewDigest:digest(body)};
      });
    },
    lookupCancellation(raw: unknown) {
      const command = comparisonCancelCommandSchema.parse(raw);
      return reservationRead((state, audit) => {
        const found = audit.cancellations.find(c => c.clientRequestId === command.clientRequestId);
        if (!found) {
          // Collision with a different operation is an error, not permission to retry.
          prepareComparisonStorageCommand(state.reservation, "cancel", command);
          return {status:"not-observed" as const};
        }
        if (digest(found) !== digest(command)) fail("PUBLIC_COMPARISON_CANCEL_COMMAND_CHANGED");
        const run = state.reservation.archive.records.runs.find(r => r.id === command.runId)!;
        const event = state.reservation.archive.records.events.find(e => e.runId === command.runId && e.payload.kind === "cancelled")!;
        return {status:"recorded" as const,command:found,recordedAt:event.recordedAt,
          currency:run.manifest.currency,unitScale:run.manifest.unitScale,releasedUnits:run.manifest.reservedUnits};
      });
    },
    writeCancellation(command: unknown, current: unknown) {
      requireHandoff();
      if (retired || original || selected || retained) fail("PUBLIC_COMPARISON_PREPARATION_CLOSED");
      assertPublicComparisonDataOnly(current,8192);
      const input = z.object({selection:cancellationSelectionSchema,at:z.string().datetime(),eventId:z.string().uuid(),budgetEventId:z.string().uuid(),finalEventId:z.string().uuid(),finalizationNonce:z.string().uuid()}).strict().parse(current);
      postBusy=true;
      try {cleanStorage();return withStorage(call => {
        const result=write(call.connection.db,call.connection.selection,"cancel",command,{...input,companyGuard},session,13,scope=>{companyRead=scope;});
        call.commitObserved=result.commitObserved;return result;
      });} finally {postBusy=false;}
    },
    prepareReservation(raw: unknown, evidence: unknown, at: string) {
      assertPublicComparisonDataOnly(raw, 8192);
      const request = publicClaimComparisonRequestCommandSchema.parse(raw);
      return reservationRead((state) => {
        const company = companyRead!.read(request.selection.companyId);
        if (company.revision !== request.selection.companyRevision)
          fail("PUBLIC_COMPARISON_APPROVAL_SELECTION_CHANGED");
        const review = createComparisonReservationReview(state.reservation, company, request, evidence, at);
        companyRead!.check(company.id);
        return review;
      });
    },
    lookupReservation(raw: unknown) {
      assertPublicComparisonDataOnly(raw, 128 * 1024);
      const command = comparisonReserveCommandSchema.parse(raw);
      return reservationRead((state) => {
        const prepared = prepareComparisonStorageCommand(state.reservation, "reserve", command);
        if (prepared.status !== "replay") return { status: "not-observed" as const };
        if (!("binding" in prepared) || !prepared.binding) fail("PUBLIC_COMPARISON_RESERVATION_REQUIRED");
        return { status: "recorded" as const, binding: prepared.binding };
      });
    },
    writeReservation(command: unknown, current: unknown) {
      requireHandoff();
      if (retired || original || selected || retained) fail("PUBLIC_COMPARISON_PREPARATION_CLOSED");
      assertPublicComparisonDataOnly(current, 128 * 1024);
      const input = z.object({ approvedReview: z.unknown(), evidence: z.unknown(), at: z.string().datetime(),
        runId: z.string().uuid(), eventId: z.string().uuid(), budgetEventId: z.string().uuid() }).strict().parse(current);
      postBusy = true;
      try {
        cleanStorage();
        return withStorage(call => {
          const result = write(call.connection.db, call.connection.selection, "reserve", command,
            { ...input, companyGuard }, session, 13, scope => { companyRead = scope; });
          call.commitObserved = result.commitObserved;
          return result;
        });
      } finally { postBusy = false; }
    },
    /** Audited historical reservations, not a transmission/consent preview. */
    listReservations(raw: unknown, atRaw: string) {
      requireHandoff();
      if (retired || original || selected || retained) fail("PUBLIC_COMPARISON_APPROVAL_PREPARATION_CLOSED");
      assertPublicComparisonDataOnly(raw, 8192);
      const query = z.object({ companyId: z.string().uuid(),
        companyRevision: z.number().int().nonnegative().safe() }).strict().parse(raw);
      const at = z.string().datetime().parse(atRaw);
      postBusy = true;
      try {
        cleanStorage();
        return withStorage((call) => {
          readStorage = call;
          const { db, selection } = call.connection;
          enter(db);
          try {
            try { db.exec("BEGIN"); }
            finally { qualityReadOpen = db.isTransaction; }
            if (!qualityReadOpen) fail("PUBLIC_COMPARISON_APPROVAL_LOCK_LOST");
            const a = inspectTransaction(db, selection, 13);
            checkComparisonWitnessCompany(session, companyGuard, 3);
            const cp = checkpoint(db, { ...a, state: a.inspection.state }, a.inspection);
            checkComparisonWitness(session, cp, 3);
            companyRead = createComparisonCompanyReadScope(companyGuard);
            const company = companyRead.read(query.companyId);
            if (company.revision !== query.companyRevision) fail("PUBLIC_COMPARISON_CATALOG_COMPANY_CHANGED");
            const state = a.transmission!.state, records = state.reservation.archive.records;
            const reservations = records.runs.filter(run => run.command.selection.companyId === company.id).map(run => {
              const reserved = comparisonTransmissionCore.original(state, run.id).review;
              const event = records.events.filter(e => e.runId === run.id).at(-1);
              const context = records.artifacts.find(v => v.runId === run.id && v.key === "comparison-context");
              const binding = state.reservation.bindings.find(b => b.runId === run.id);
              const cancelled = a.inspection.cancellations.find(c => c.runId === run.id);
              const cancellationEvent = records.events.find(e => e.runId === run.id && e.payload.kind === "cancelled");
              const finalEvent = records.events.find(e => e.runId === run.id && e.payload.kind === "finalized");
              if (!event || !context || !binding || (!!cancelled !== !!cancellationEvent)) fail("PUBLIC_COMPARISON_RESERVATION_REQUIRED");
              const { prepared } = inspectArchivedPublicClaimRequest(run.command, context.body);
              return { runId: run.id, companyRevision: run.command.selection.companyRevision,
                companyRevisionMatches: run.command.selection.companyRevision === query.companyRevision,
                createdAt: run.createdAt, expiresAt: run.manifest.expiresAt,
                reservationExpired: Date.parse(at) >= Date.parse(run.manifest.expiresAt),
                model: run.command.model, sectionKey: prepared.input.section.key,
                sectionTitle: prepared.input.section.title, costs: reserved.financialBasis.costs,
                latestEventKind: event.payload.kind,
                history: {
                  reservation: {clientRequestId:binding.clientRequestId,commandDigest:binding.commandDigest,recordedAt:binding.recordedAt},
                  cancellation: cancelled && cancellationEvent ? {clientRequestId:cancelled.clientRequestId,
                    commandDigest:digest(cancelled),recordedAt:cancellationEvent.recordedAt,releasedUnits:run.manifest.reservedUnits} : null,
                  finalizedAt: finalEvent?.recordedAt ?? null,
                } };
            });
            companyRead.check(company.id);
            checkComparisonWitness(session, cp, 3);
            const result = { kind: "comparison-reservation-catalog" as const,
              databaseInstanceId: selection.databaseInstanceId, ...query, inspectedAt: at, reservations,
              databaseVerified: true as const, currentCompanyVerified: true as const,
              currentContextVerified: false as const, policiesVerified: false as const,
              transmissionAllowed: false as const, consentRecorded: false as const,
              runtimeObserved: false as const };
            assertPublicComparisonDataOnly(result, 256 * 1024);
            return structuredClone(result);
          } finally {
            try {
              companyRead?.finish();
              companyRead = undefined;
              if (qualityReadOpen) {
                db.exec("ROLLBACK");
                if (db.isTransaction) fail("PUBLIC_COMPARISON_APPROVAL_CLEANUP_REQUIRED");
                qualityReadOpen = false;
              }
            } finally { busy.delete(db); }
          }
        });
      } finally { postBusy = false; }
    },
    /** Read-only approval preparation against the same audited database/company snapshot.
     * Trusted server policy/clock inputs, never a supplied company or a dispatch command. */
    prepareTransmission(raw: unknown, basis: unknown, policy: unknown, at: string) {
      requireHandoff();
      if (retired || original || selected || retained) fail("PUBLIC_COMPARISON_APPROVAL_PREPARATION_CLOSED");
      assertPublicComparisonDataOnly(raw, 8192);
      const query = z.object({ runId: z.string().uuid(), companyId: z.string().uuid(),
        companyRevision: z.number().int().nonnegative().safe() }).strict().parse(raw);
      postBusy = true;
      try {
        cleanStorage();
        return withStorage((call) => {
          readStorage = call;
          const { db, selection } = call.connection;
          enter(db);
          try {
            try { db.exec("BEGIN IMMEDIATE"); }
            finally { qualityReadOpen = db.isTransaction; }
            if (!qualityReadOpen) fail("PUBLIC_COMPARISON_APPROVAL_LOCK_LOST");
            const a = inspectTransaction(db, selection, 13);
            checkComparisonWitnessCompany(session, companyGuard, 3);
            const cp = checkpoint(db, { ...a, state: a.inspection.state }, a.inspection);
            checkComparisonWitness(session, cp, 3);
            const state = a.transmission!.state;
            const run = state.reservation.archive.records.runs.find(r => r.id === query.runId);
            if (!run || run.command.selection.companyId !== query.companyId ||
                run.command.selection.companyRevision !== query.companyRevision)
              fail("PUBLIC_COMPARISON_APPROVAL_SELECTION_CHANGED");
            companyRead = createComparisonCompanyReadScope(companyGuard);
            const company = companyRead.read(query.companyId);
            if (company.revision !== query.companyRevision) fail("PUBLIC_COMPARISON_APPROVAL_SELECTION_CHANGED");
            const review = createComparisonTransmissionV2Review(state, company, query.runId, basis, policy, at);
            companyRead.check(company.id);
            checkComparisonWitness(session, cp, 3);
            const reserved = comparisonTransmissionCore.original(state, query.runId).review;
            return structuredClone({ review, reservation: {
              financialBasis: reserved.financialBasis,
              retentionNotice: reserved.retentionNotice,
              retentionNoticeDigest: reserved.retentionNoticeDigest,
            } });
          } finally {
            try {
              companyRead?.finish();
              companyRead = undefined;
              if (qualityReadOpen) {
                db.exec("ROLLBACK");
                if (db.isTransaction) fail("PUBLIC_COMPARISON_APPROVAL_CLEANUP_REQUIRED");
                qualityReadOpen = false;
              }
            } finally { busy.delete(db); }
          }
        });
      } finally { postBusy = false; }
    },
    finishRead() {
      requireHandoff();
      if (retained) fail("PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED");
      cleanStorage();
      refresh();
    },
  };
}

/** Borrowed booking store: audited review/lookup and explicit reservation only.
 * Retains its own failed company/quality read scopes; no dispatcher or migration. */
export function createPublicComparisonReservationStore(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
) {
  const backend = createComparisonService(session, companyGuard, undefined);
  let closing = false, closed = false;
  function available() { if (closing || closed) fail("PUBLIC_COMPARISON_PREPARATION_CLOSED"); }
  return Object.freeze({
    review(...args: Parameters<typeof backend.prepareReservation>) { available(); return backend.prepareReservation(...args); },
    reserve(...args: Parameters<typeof backend.writeReservation>) { available(); return backend.writeReservation(...args); },
    lookup(...args: Parameters<typeof backend.lookupReservation>) { available(); return backend.lookupReservation(...args); },
    close() {
      if (!closed) {
        closing = true;
        backend.service.retire();
        backend.finishRead();
        if (backend.service.inspect().status !== "closed") fail("PUBLIC_COMPARISON_SERVICE_CLEANUP_REQUIRED");
        closed = true;
      }
      return { closed };
    },
  });
}

/** Borrowed cancellation surface; no provider execution or new reservation. */
export function createPublicComparisonCancellationStore(session: ComparisonStorageSession, companyGuard: ComparisonCompanyGuard) {
  const backend=createComparisonService(session,companyGuard,undefined);let closing=false,closed=false;
  function available(){if(closing||closed)fail("PUBLIC_COMPARISON_PREPARATION_CLOSED");}
  return Object.freeze({
    review(...args:Parameters<typeof backend.prepareCancellation>){available();return backend.prepareCancellation(...args);},
    cancel(...args:Parameters<typeof backend.writeCancellation>){available();return backend.writeCancellation(...args);},
    lookup(...args:Parameters<typeof backend.lookupCancellation>){available();return backend.lookupCancellation(...args);},
    close(){if(!closed){closing=true;backend.service.retire();backend.finishRead();if(backend.service.inspect().status!=="closed")fail("PUBLIC_COMPARISON_SERVICE_CLEANUP_REQUIRED");closed=true;}return {closed};},
  });
}

/** Borrowed SELECT-only preparation surface; reservation writes are not exposed. */
export function createPublicComparisonPreparationReader(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
) {
  const backend = createComparisonService(session, companyGuard, undefined);
  let closing = false, closed = false;
  return Object.freeze({
    list(...args: Parameters<typeof backend.listReservations>) {
      if (closing || closed) fail("PUBLIC_COMPARISON_PREPARATION_CLOSED");
      return backend.listReservations(...args);
    },
    prepare(...args: Parameters<typeof backend.prepareTransmission>) {
      if (closing || closed) fail("PUBLIC_COMPARISON_PREPARATION_CLOSED");
      return backend.prepareTransmission(...args);
    },
    close() {
      if (!closed) {
        closing = true;
        backend.service.retire();
        backend.finishRead();
        if (backend.service.inspect().status !== "closed") fail("PUBLIC_COMPARISON_SERVICE_CLEANUP_REQUIRED");
        closed = true;
      }
      return { closed };
    },
  });
}

/** Explicit server-owned reader. Borrows the authenticated company guard, owns only its
 * new read-only quality connection and leases. No dispatcher, schema creation or migration.
 * Keep this object after failure and call close again to finish its own pending cleanup.
 */
export function openPublicComparisonStoredReader(
  paths: unknown,
  selection: PublicComparisonDatabaseSelection,
  companyGuard: ComparisonCompanyGuard,
) {
  const session = openComparisonReadOnlyStorageSession(paths, selection);
  const backend = createComparisonService(session, companyGuard, undefined);
  let closing = false, closed = false;
  const inspect = () => Object.freeze({
    source: "comparison-stored-reader" as const,
    status: closed ? "closed" as const : closing ? "draining" as const : "ready" as const,
    cleanupRequired: backend.service.inspect().postcapture.cleanupRequired,
    runtimeObserved: false as const,
    authority: comparisonPlanAuthority,
  });
  return Object.freeze({
    listStoredReviews(query: unknown) {
      if (closing || closed) fail("PUBLIC_COMPARISON_STORED_READER_CLOSED");
      return backend.listStoredReviews(query);
    },
    readCompanyStoredReview(raw: unknown, company: { companyId: string; companyRevision: number }) {
      if (closing || closed) fail("PUBLIC_COMPARISON_STORED_READER_CLOSED");
      const query = postcaptureSelection.extend({ mode: z.enum(["historical", "inspect-current"]) })
        .strict().parse(copyComparisonStoredRead(raw, "selection"));
      const catalog = backend.listStoredReviews(company);
      const item = catalog.reviews.find((r) => r.runId === query.runId && r.dispatchCommandDigest === query.dispatchCommandDigest);
      if (!item) fail("PUBLIC_COMPARISON_STORED_RESULT_MISSING");
      const selected = { runId: item.runId, dispatchCommandDigest: item.dispatchCommandDigest,
        comparisonEventDigest: item.comparisonEventDigest, responseArtifactSha256: item.responseArtifactSha256,
        validatedArtifactSha256: item.validatedArtifactSha256 };
      // Use the audited catalog identity directly; the second transaction verifies it again.
      const result = query.mode === "historical" ? backend.service.readStoredComparison(selected)
        : backend.service.inspectStoredComparisonContext(selected);
      return { ...result, source: "comparison-stored-review" as const };
    },
    readStoredReviewByRun(query: unknown) {
      if (closing || closed) fail("PUBLIC_COMPARISON_STORED_READER_CLOSED");
      const result = backend.service.readStoredReviewByRun(query);
      // The record's original provenance remains in historical.result; opening a local
      // database never authenticates provider execution or upgrades its authority.
      return { ...result, source: "comparison-stored-review" as const };
    },
    inspect,
    close() {
      if (closed) return inspect();
      closing = true;
      backend.service.retire();
      backend.finishRead();
      closeComparisonStorageSession(session);
      closed = true;
      return inspect();
    },
  });
}
