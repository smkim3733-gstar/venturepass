import "server-only";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  publicComparisonV10InsertGates,
  readPublicComparisonDatabaseSnapshot,
  type PublicComparisonDatabaseSelection,
} from "./studio-public-claim-comparison-database";
import {
  publicComparisonV11Columns,
  publicComparisonV11InsertGates,
} from "./studio-public-claim-comparison-database-v11-schema";
import {
  inspectComparisonReservationState,
  planComparisonReservation,
  planComparisonCancellation,
} from "./studio-public-claim-comparison-reservation";
import { comparisonPlanAuthority } from "./studio-public-claim-comparison-financial";
import type { PublicComparisonCoverage } from "./studio-public-claim-comparison-budget";

type Table = keyof typeof publicComparisonV11Columns;
type Row = { table: Table; values: SQLInputValue[] };
type Plan =
  ReturnType<typeof planComparisonReservation> | ReturnType<typeof planComparisonCancellation>;
type NewPlan = Extract<Plan, { status: "prepared-not-committed" }>;
const busy = new WeakSet<DatabaseSync>();
const permits = new WeakMap<
  DatabaseSync,
  { operation: "reserve" | "cancel"; rows: string[]; index: number }
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
function registerGate(db: DatabaseSync) {
  db.function("comparison_v11_insert_guard", { varargs: true }, (...args) => {
    const permit = permits.get(db);
    if (
      !busy.has(db) ||
      !db.isTransaction ||
      !permit ||
      (permit.operation !== "reserve" && permit.operation !== "cancel") ||
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
function readStateTransaction(db: DatabaseSync, selection: PublicComparisonDatabaseSelection) {
  const snap = readPublicComparisonDatabaseSnapshot(db, selection, 11);
  const additionalUsedBytes =
    Math.max(0, snap.cutoverBytes - Buffer.byteLength(JSON.stringify(snap.coverage))) +
    snap.nativeRawOverheadBytes +
    snap.bindingRawOverheadBytes;
  const state = {
    prefix: snap.prefix,
    coverage: snap.coverage,
    archive: snap.archive,
    bindings: snap.bindings,
    additionalUsedBytes,
  };
  return {
    source: "local-comparison-reservation-database-read" as const,
    storageVersion: 11 as const,
    cutoverDigest: snap.cutover.cutoverDigest,
    cutoverBytes: snap.cutoverBytes,
    nativeRawOverheadBytes: snap.nativeRawOverheadBytes,
    bindingRawOverheadBytes: snap.bindingRawOverheadBytes,
    state,
    fileIdentityVerified: false as const,
    currentCompanyVerified: false as const,
    dispatchAllowed: false as const,
  };
}
function inspectTransaction(db: DatabaseSync, selection: PublicComparisonDatabaseSelection) {
  const { state, ...snapshot } = readStateTransaction(db, selection);
  return { ...snapshot, inspection: inspectComparisonReservationState(state) };
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
  const b = plan.rows.budgetEvent;
  const budget: Row = {
    table: "quality_actual_budget_events",
    values: [b.scopeId, b.revision, ...json(b)],
  };
  if (plan.operation === "reserve") {
    const r = plan.rows;
    return [
      { table: "quality_actual_runs", values: [r.run.id, ...json(r.run)] },
      ...r.artifacts.map(artifact),
      event(r.event),
      budget,
      receipt(r.receipt),
      {
        table: "quality_provider_reservation_bindings",
        values: [r.binding.runId, r.binding.clientRequestId, ...json(r.binding)],
      },
    ];
  }
  const r = plan.rows;
  return [
    event(r.events[0]),
    budget,
    receipt(r.receipts[0]),
    artifact(r.artifact),
    event(r.events[1]),
    receipt(r.receipts[1]),
  ];
}
function persist(db: DatabaseSync, plan: NewPlan) {
  const rows = inserts(plan);
  const permit = {
    operation: plan.operation,
    rows: rows.map((r) => signature(r.table, r.values)),
    index: 0,
  };
  const before = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  permits.set(db, permit);
  try {
    for (const row of rows) {
      const columns = publicComparisonV11Columns[row.table];
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
function write(
  db: DatabaseSync,
  selection: PublicComparisonDatabaseSelection,
  operation: "reserve" | "cancel",
  command: unknown,
  current?: unknown,
) {
  enter(db);
  let commitAttempted = false;
  try {
    registerGate(db);
    db.exec("BEGIN IMMEDIATE");
    const before = readStateTransaction(db, selection);
    // The planner resolves exact original nonces before touching supplied current/company inputs.
    const plan =
      operation === "reserve"
        ? planComparisonReservation(before.state, command, current)
        : planComparisonCancellation(before.state, command, current);
    if (plan.status === "replay") {
      const inspection = inspectTransaction(db, selection);
      commitAttempted = true;
      db.exec("COMMIT");
      if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
      return {
        source: "local-comparison-reservation-database-write" as const,
        status: "replay" as const,
        result: plan,
        inspection,
        insertedRows: 0,
        commitObserved: false,
        owner: null,
        authority: comparisonPlanAuthority,
      };
    }
    const insertedRows = persist(db, plan);
    // Full read of exact schema, frozen bytes, native/budget chain and every binding, in the same transaction.
    const inspection = inspectTransaction(db, selection);
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
        : !cancellation || digest(cancellation) !== digest(command)
    )
      fail();
    const replay =
      plan.operation === "reserve"
        ? { ...common, binding: binding! }
        : { ...common, command: cancellation! };
    commitAttempted = true;
    db.exec("COMMIT");
    if (db.isTransaction) fail("PUBLIC_COMPARISON_COMMIT_OBSERVATION_UNKNOWN");
    return {
      source: "local-comparison-reservation-database-write" as const,
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
    return rollback(db, e, commitAttempted);
  } finally {
    permits.delete(db);
    busy.delete(db);
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
