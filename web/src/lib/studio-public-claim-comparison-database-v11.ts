import "server-only";
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
import { comparisonPlanAuthority } from "./studio-public-claim-comparison-financial";
import type { PublicComparisonCoverage } from "./studio-public-claim-comparison-budget";

import {
  publicComparisonV12Columns,
  publicComparisonV12InsertGates,
} from "./studio-public-claim-comparison-database-v12-schema";
import {
  inspectComparisonTransmissionState,
  prepareComparisonTransmissionStorageCommand,
  inspectedComparisonTransmissionStorageCommand,
  planPreparedComparisonTransmissionStorageCommand,
  type ComparisonTransmissionOperation,
} from "./studio-public-claim-comparison-transmission";
type Version = 11 | 12;
type Operation = "reserve" | "cancel" | ComparisonTransmissionOperation;
type TransmissionPlan = ReturnType<typeof planPreparedComparisonTransmissionStorageCommand>;
type Table = keyof typeof publicComparisonV12Columns;
type Row = { table: Table; values: SQLInputValue[] };
type Plan =
  | ReturnType<typeof planComparisonReservation>
  | ReturnType<typeof planComparisonCancellation>
  | TransmissionPlan
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
  db.function(
    version === 11 ? "comparison_v11_insert_guard" : "comparison_v12_insert_guard",
    { varargs: true },
    (...args) => {
      const permit = permits.get(db);
      if (
        !busy.has(db) ||
        !db.isTransaction ||
        !permit ||
        permit.version !== version ||
        !(
          version === 11
            ? ["reserve", "cancel"]
            : ["reserve", "cancel", "approve-dispatch", "mark-unknown", "persist-capture"]
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
    },
  );
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
    version === 12
      ? inspectComparisonTransmissionState({
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
  const r = plan.rows;
  return [
    ...(r.artifact ? [artifact(r.artifact)] : []),
    event(r.event),
    receipt(r.receipt),
    ...(r.binding
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
      snapshot.storageVersion === 12
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
      if (transmissionOperation && version !== 12) fail();
      const prepared = transmissionOperation
        ? prepareComparisonTransmissionStorageCommand(
            transmissionState,
            operation as ComparisonTransmissionOperation,
            command,
          )
        : prepareComparisonStorageCommand(before.state, operation as "reserve" | "cancel", command);
      if (prepared.status === "replay") plan = prepared;
      else {
        const transmissionAudit =
          prepared.ticket.kind === "comparison-transmission-ticket"
            ? inspectedComparisonTransmissionStorageCommand(prepared.ticket)
            : null;
        const audited =
          prepared.ticket.kind === "comparison-transmission-ticket"
            ? transmissionAudit!.reservation
            : inspectedComparisonStorageCommand(prepared.ticket);
        // v12 reserve/cancel still audit every existing transmission binding.
        if (version === 12 && !transmissionAudit)
          inspectComparisonTransmissionState(transmissionState);
        const beforeCheckpoint = checkpoint(db, before, audited);
        checkComparisonWitness(session, beforeCheckpoint, version === 12 ? 2 : 1);
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
                    at: z.unknown(),
                    eventId: z.unknown(),
                  })
                  .strict()
          ).parse(current);
          const cap = cur.companyGuard as ComparisonCompanyGuard;
          checkComparisonWitnessCompany(session, cap, version === 12 ? 2 : 1);
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
        plan =
          prepared.ticket.kind === "comparison-transmission-ticket"
            ? planPreparedComparisonTransmissionStorageCommand(prepared.ticket, actualCurrent)
            : planPreparedComparisonStorageCommand(prepared.ticket, actualCurrent);
        const rows = inserts(plan);
        const runId =
          plan.operation === "reserve"
            ? plan.rows.run.id
            : plan.operation === "cancel"
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
        if (version === 12)
          recordComparisonWitnessIntentV2(
            session,
            beforeCheckpoint,
            intent,
            "reservation" in plan.next ? plan.next.reservation : plan.next,
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
            version === 12 ? 2 : 1,
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
    const transmissionCommand =
      plan.operation === "cancel"
        ? undefined
        : inspection.transmission?.commands.find(
            (c) => c.clientRequestId === plan.rows.receipt.clientRequestId,
          );
    let replay;
    if (plan.operation === "reserve") replay = { ...common, binding: binding! };
    else if (plan.operation === "cancel") replay = { ...common, command: cancellation! };
    else {
      if (!transmissionCommand || digest(transmissionCommand) !== digest(command)) fail();
      replay = {
        source: "supplied-transmission-plan" as const,
        status: "replay" as const,
        rows: null,
        owner: null,
        authority: comparisonPlanAuthority,
        command: transmissionCommand,
        receipt: plan.rows.receipt,
      };
    }
    if (companyGuard) checkComparisonCompanyRead(companyGuard, companyId!);
    if (session) {
      const nonce =
        plan.operation === "cancel"
          ? plan.rows.receipts[0].clientRequestId
          : plan.rows.receipt.clientRequestId;
      checkComparisonWitnessPending(session, nonce, digest(command), version === 12 ? 2 : 1);
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
            version === 12
              ? inspectComparisonTransmissionState({
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
          version === 12 ? 2 : 1,
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
export function inspectPublicComparisonDatabaseV12(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
) {
  enter(db);
  try {
    db.exec("BEGIN");
    const result = inspectTransaction(db, selection, 12);
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
export function migrateGuardedPublicComparisonDatabaseV12(session: ComparisonStorageSession) {
  const { db, selection } = beginComparisonStorageSession(session);
  enter(db);
  let attempted = false,
    observed = false;
  try {
    registerGate(db, 12);
    db.exec("BEGIN IMMEDIATE");
    const already = !!db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='quality_actual_runs_v12_writer' AND type='trigger'",
      )
      .get();
    if (already) {
      const snapshot = readStateTransaction(db, selection, 12),
        audit = inspectTransaction(db, selection, 12);
      const cp = checkpoint(db, snapshot, audit.inspection);
      checkComparisonWitness(session, cp, 2);
      db.exec("COMMIT");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
      return {
        status: "already-v12" as const,
        migrationCommitObserved: false,
        dispatchAllowed: false,
        owner: null,
      };
    }
    const before = readStateTransaction(db, selection, 11),
      audit = inspectComparisonReservationState(before.state);
    if (
      audit.state.archive.records.events.some(
        (e) => !["reserved", "cancelled", "finalized"].includes(e.payload.kind),
      )
    )
      fail("PUBLIC_COMPARISON_DISPATCH_ALREADY_PRESENT");
    const beforeCheckpoint = checkpoint(db, before, audit);
    const schema = actualSchema(db);
    const expected = schema.filter(
      (r) => !Object.hasOwn(publicComparisonV11InsertGates, String(r.name)),
    );
    for (const [name, sql] of Object.entries(publicComparisonV12InsertGates))
      expected.push({ type: "trigger", name, tbl_name: name.replace(/_v12_writer$/, ""), sql });
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
          transmissionBindings: [],
        }),
      },
      before.state,
    );
    for (const name of Object.keys(publicComparisonV11InsertGates)) db.exec("DROP TRIGGER " + name);
    for (const sql of Object.values(publicComparisonV12InsertGates)) db.exec(sql);
    const after = inspectTransaction(db, selection, 12);
    if (
      digest(actualSchema(db)) !== digest(expected) ||
      digest(after.inspection.state) !== digest(before.state) ||
      comparisonWitnessInventory(db, [], true) !== originalRowDataDigest
    )
      fail();
    attempted = true;
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    observed = true;
    db.exec("BEGIN IMMEDIATE");
    const durable = readStateTransaction(db, selection, 12),
      verified = inspectTransaction(db, selection, 12);
    acknowledgeComparisonWitnessTransition(
      session,
      checkpoint(db, durable, verified.inspection),
      digest(actualSchema(db)),
    );
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return {
      status: "migrated-v12" as const,
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
export function reconcilePublicComparisonStorageWitnessV2(session: ComparisonStorageSession) {
  const { db, selection } = beginComparisonStorageSession(session);
  enter(db);
  try {
    db.exec("BEGIN IMMEDIATE");
    const snapshot = readStateTransaction(db, selection, 12),
      audit = inspectTransaction(db, selection, 12);
    const cp = checkpoint(db, snapshot, audit.inspection);
    let repairedFilesOnly = false;
    try {
      checkComparisonWitness(session, cp, 2);
    } catch {
      // Both repairs only append an acknowledgement after full DB/schema/original-command audit.
      try {
        acknowledgeComparisonWitnessTransition(session, cp, digest(actualSchema(db)));
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("TRANSITION_RECONCILIATION_REQUIRED"))
          throw e;
        acknowledgeComparisonWitness(
          session,
          cp,
          audit.inspection.state,
          [...audit.inspection.cancellations, ...audit.transmission!.commands],
          2,
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
    endComparisonStorageSession(session);
  }
}
