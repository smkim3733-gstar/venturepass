import "server-only";
import { createComparisonBodyBoundary } from "./studio-public-claim-comparison-body";
import { z } from "zod";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import {
  beginComparisonCompanyRead,
  checkComparisonCompanyRead,
  endComparisonCompanyRead,
  type ComparisonCompanyGuard,
} from "./studio-public-comparison-company-guard";
import {
  beginComparisonStorageSession,
  endComparisonStorageSession,
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
} from "./studio-public-claim-comparison-reservation";
import { comparisonPlanAuthority, comparisonSha } from "./studio-public-claim-comparison-financial";
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
import { inspectPublicClaimComparisonRequest } from "./studio-public-claim-comparison-request";
import { validateComparisonUsagePolicy } from "./studio-public-claim-comparison-usage";
import { snapshotProviderSdkWire } from "./studio-plan-quality-provider-sdk-wire";
import {
  preparePublicComparisonTransportBoundary,
  requireSyntheticComparisonDriver,
  comparisonSyntheticWireKey,
  type SyntheticComparisonDriver,
} from "./studio-public-claim-comparison-transport";
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
) {
  enter(db);
  let commitAttempted = false,
    commitObserved = false;
  let companyGuard: ComparisonCompanyGuard | undefined;
  let companyId: string | undefined;
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
          const company = beginComparisonCompanyRead(cap, companyId);
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
      endComparisonCompanyRead(companyGuard);
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
    if (companyGuard) {
      try {
        endComparisonCompanyRead(companyGuard);
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
    try {
      endComparisonStorageSession(session);
    } catch {
      throw observedError("PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED", commitObserved);
    }
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
) {
  const active = ownedLease ? ownedComparisonLeases.get(ownedLease) : undefined;
  if (ownedLease && (!active || active.session !== session || version !== 13))
    fail("PUBLIC_COMPARISON_OWNER_REQUIRED");
  const { db, selection } = active ?? beginComparisonStorageSession(session);
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
    if (!active) endComparisonStorageSession(session);
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

function createComparisonExecutionLifetime(
  session: ComparisonStorageSession,
  companyGuard: ComparisonCompanyGuard,
  driver: SyntheticComparisonDriver,
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
      source: "synthetic-comparison-execution" as const,
      phase,
      owner: null,
      runtimeObserved: false,
      syntheticStartObserved,
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
      const wire = snapshotProviderSdkWire(
        boundary.rawBody,
        comparisonSyntheticWireKey,
        url,
        input,
      );
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
      const fixture = requireSyntheticComparisonDriver(driver);
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
        await fixture(boundary, Object.freeze({ start, sdk, markUnknown: unknown }));
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
    // This closure never leaves the module or accepts a public observation as proof.
    // No capture/active/phase count can substitute for the original lease and IO lifetime.
    canRelease: () =>
      !leaseActive && !executing && !companyReadOpen && !pending && !dispatchUncertain &&
      !owners.has(owner) && (!network || networkDone) && (!sdkEntered || sdkDone) &&
      (!bodyBoundary || (ioDone && !bodyBoundary.inspect().cleanupFailed)) &&
      (!command || driverDone || (!dispatchCommitObserved && !startAttempted)),
  };
}

type IsolatedComparisonLifetime = ReturnType<typeof createComparisonExecutionLifetime>;
type IsolatedComparisonView = ReturnType<IsolatedComparisonLifetime["execution"]["inspect"]>;
export type IsolatedPublicComparisonService = Readonly<{
  execute(command: unknown, current: unknown): Promise<IsolatedComparisonView>;
  recover(selection: unknown): IsolatedComparisonView;
  inspect(): Readonly<{
    source: "synthetic-comparison-service";
    status: "ready" | "draining" | "closed";
    activeCalls: number;
    execution: IsolatedComparisonView;
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
  // Does not inspect current configuration, command, driver authenticity or credentials.
  // The engine owns original-nonce-first validation when execute is explicitly called.
  let lifetime: IsolatedComparisonLifetime | undefined =
    createComparisonExecutionLifetime(session, companyGuard, driver);
  let last = lifetime.execution.inspect();
  let retired = false;
  const pending = new Set<Promise<IsolatedComparisonView>>();
  function refresh() {
    if (!lifetime) return;
    last = lifetime.execution.inspect();
    if (retired && pending.size === 0 && lifetime.canRelease()) {
      lifetime = undefined;
    }
  }
  const inspect: IsolatedPublicComparisonService["inspect"] = () => {
    refresh();
    return Object.freeze({
      source: "synthetic-comparison-service",
      status: !lifetime ? "closed" : retired ? "draining" : "ready",
      activeCalls: pending.size,
      execution: last,
      owner: null,
      runtimeObserved: false,
      authority: comparisonPlanAuthority,
    });
  };
  const service: IsolatedPublicComparisonService = Object.freeze({
    async execute(command: unknown, current: unknown) {
      if (retired || !lifetime) fail("PUBLIC_COMPARISON_SERVICE_RETIRED");
      const call = lifetime.execution.execute(command, current);
      pending.add(call); // A replay observation must not replace the original pending promise.
      try {
        return await call;
      } finally {
        pending.delete(call);
        refresh();
      }
    },
    recover(selection: unknown) {
      if (!lifetime) fail("PUBLIC_COMPARISON_SERVICE_CLOSED");
      try {
        return lifetime.execution.recover(selection);
      } finally {
        refresh();
      }
    },
    inspect,
    retire() {
      retired = true;
      lifetime?.execution.retire();
      return inspect();
    },
  });
  return service;
}
