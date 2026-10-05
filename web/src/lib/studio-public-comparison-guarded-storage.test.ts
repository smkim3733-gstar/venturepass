import { samePath } from "../../scripts/local-data-files.mjs";
import * as journalIO from "../../scripts/local-journal-io.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  linkSync,
  rmdirSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { StudioStore } from "./studio-storage";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { createPublicComparisonCoverage } from "./studio-public-claim-comparison-budget";
import { migratePublicComparisonDatabaseV10 } from "./studio-public-claim-comparison-database";
import {
  migratePublicComparisonDatabaseV11,
  inspectPublicComparisonDatabaseV11,
  reservePublicComparisonDatabase,
  reserveGuardedPublicComparison,
  cancelGuardedPublicComparison,
  initializePublicComparisonStorageWitness,
  reconcilePublicComparisonStorageWitness,
} from "./studio-public-claim-comparison-database-v11";
import {
  beginComparisonCompanyRead,
  endComparisonCompanyRead,
} from "./studio-public-comparison-company-guard";
import {
  openComparisonStorageSession,
  closeComparisonStorageSession,
  beginComparisonStorageSession,
  endComparisonStorageSession,
} from "./studio-public-comparison-storage-witness";
import {
  comparisonCancelCommandSchema,
  type ComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { comparisonReservationTestFixture } from "./studio-public-claim-comparison-reservation-test-helpers";
vi.mock("server-only", () => ({}));
vi.mock(
  "./studio-plan-quality-provider-configuration-current",
  () => import("./studio-plan-quality-provider-configuration-20260927-test-fixture"),
);
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("external/customer I/O forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
const selection = {
  databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
  environment: "production" as const,
  scopeId: "candidate-quality-provider-v2-live" as const,
};
let directory: string, base11: string;
let fixture: ReturnType<typeof comparisonReservationTestFixture>;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-comparison-guard-"));
  const store = new PlanQualityStore(join(directory, "base"), {
    providerEnvironment: "synthetic-test",
  });
  try {
    store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    });
    const f = await finalizationStoreFixture(store);
    store.providerRecordFinalization(f.identity);
  } finally {
    store.close();
  }
  base11 = join(directory, "base11.sqlite");
  copyFileSync(join(directory, "base", "quality-evaluation", "quality.sqlite"), base11);
  const db = new DatabaseSync(base11);
  try {
    const prefix = readPublicComparisonPrefix(db),
      coverage = createPublicComparisonCoverage(prefix);
    migratePublicComparisonDatabaseV10(db, selection, coverage);
    const migrated = migratePublicComparisonDatabaseV11(db, selection, coverage);
    fixture = comparisonReservationTestFixture(migrated.inspection.inspection.state);
  } finally {
    db.close();
  }
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
}, 30000);
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (directory) {
    const r = relative(resolve(tmpdir()), resolve(directory));
    if (!r.startsWith("venture-comparison-guard-") || r.includes(".."))
      throw Error("unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
function state(db: DatabaseSync) {
  return inspectPublicComparisonDatabaseV11(db, selection).inspection.state;
}
function current() {
  return {
    company: structuredClone(fixture.company),
    evidence: structuredClone(fixture.evidence),
    approvedReview: structuredClone(fixture.review),
    at: fixture.at,
    runId: randomUUID(),
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
  };
}
function cancelCommand(s: ComparisonReservationState) {
  const b = s.bindings.at(-1)!,
    e = s.archive.records.events.filter((x) => x.runId === b.runId).at(-1)!,
    budget = s.archive.financial.events.at(-1)!;
  return comparisonCancelCommandSchema.parse({
    commandVersion: 1,
    kind: "cancel-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    expectedBindingDigest: b.recordDigest,
    reservationDigest: b.budgetEventDigest,
    expectedRunHead: { revision: e.revision, headDigest: e.eventDigest },
    expectedBudgetHead: { revision: budget.revision, headDigest: budget.eventDigest },
  });
}
function cancelCurrent() {
  return {
    at: "2026-10-05T13:00:00.000Z",
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
    finalEventId: randomUUID(),
    finalizationNonce: randomUUID(),
  };
}
function snapshot(db: DatabaseSync) {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
  const rows = Object.fromEntries(
    schema
      .filter((r) => r.type === "table")
      .map((r) => [
        String(r.name),
        db.prepare("SELECT rowid AS original_order,* FROM " + r.name + " ORDER BY rowid").all(),
      ]),
  );
  return { schema, rows };
}
function injectInsert(db: DatabaseSync, n: number) {
  const original = db.prepare.bind(db);
  let count = 0;
  return vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("INSERT INTO ") && ++count === n) throw Error("injected insert failure");
    return original(sql);
  });
}

function guarded(enroll = true) {
  const root = join(directory, randomUUID()),
    data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const qualityFile = join(data, "quality.sqlite");
  copyFileSync(base11, qualityFile);
  const studio = new StudioStore(data);
  const companyDb = new DatabaseSync(join(data, "studio.sqlite"));
  companyDb
    .prepare("INSERT INTO studio_cases(id,revision,evidence_revision,body) VALUES(?,?,?,?)")
    .run(fixture.company.id, fixture.company.revision, 0, JSON.stringify(fixture.company));
  companyDb.exec("PRAGMA busy_timeout=30");
  const cap = studio.comparisonCompanyGuard();
  const paths = {
    dataRoot: data,
    qualityFile,
    studioFile: join(data, "studio.sqlite"),
    controlDirectory: join(root, "control"),
  };
  const session = openComparisonStorageSession(paths, selection);
  const internal = beginComparisonStorageSession(session);
  const db = internal.db;
  endComparisonStorageSession(session);
  const cleanup = () => {
    closeComparisonStorageSession(session);
    companyDb.close();
    studio.close();
  };
  cleanups.push(cleanup);
  if (enroll) initializePublicComparisonStorageWitness(session, cap);
  const supplied = current();
  const { company: _company, ...input } = supplied;
  void _company;
  return { session, cap, paths, studio, companyDb, db, current: { ...input, companyGuard: cap } };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function reserveGuard(g: ReturnType<typeof guarded>) {
  return reserveGuardedPublicComparison(g.session, fixture.command, g.current);
}
function witnessFiles(g: ReturnType<typeof guarded>) {
  const dirs = [g.paths.controlDirectory, join(g.paths.dataRoot, "comparison-storage-witness")];
  return dirs.map((dir) =>
    readdirSync(dir)
      .sort()
      .map((n) => readFileSync(join(dir, n), "utf8")),
  );
}
function allCompany(db: DatabaseSync) {
  return ["studio_cases", "venture_accounts", "venture_workflows", "studio_prepared_packages"].map(
    (t) => db.prepare("SELECT * FROM " + t).all(),
  );
}
const limit = 30000;
it(
  "enrolls empty v11, holds company lock through quality COMMIT, preserves all company tables and false authorities",
  () => {
    const g = guarded(),
      original = allCompany(g.companyDb),
      get = g.studio.get(fixture.company.id);
    const exec = g.db.exec.bind(g.db);
    let checked = false;
    vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && !checked) {
        expect(() => g.companyDb.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
        checked = true;
      }
      return exec(sql);
    });
    const r = reserveGuard(g);
    expect(checked).toBe(true);
    expect(r).toMatchObject({
      status: "committed",
      insertedRows: 7,
      commitObserved: true,
      companyLockObserved: true,
      witnessMatched: true,
      owner: null,
    });
    expect(Object.values(r.authority).every((v) => v === false)).toBe(true);
    expect(g.studio.get(fixture.company.id)).toEqual(get);
    expect(allCompany(g.companyDb)).toEqual(original);
    expect(witnessFiles(g)[0]).toEqual(witnessFiles(g)[1]);
    expect(witnessFiles(g)[0]).toHaveLength(4);
    expect(g.companyDb.isTransaction).toBe(false);
  },
  limit,
);
it(
  "replays original command before poisoned company/current getters and after company deletion",
  () => {
    const g = guarded();
    reserveGuard(g);
    g.companyDb.prepare("DELETE FROM studio_cases").run();
    const poisoned = Object.defineProperty({}, "companyGuard", { get: forbidden });
    expect(reserveGuardedPublicComparison(g.session, fixture.command, poisoned)).toMatchObject({
      status: "replay",
      insertedRows: 0,
      companyLockObserved: false,
    });
    expect(witnessFiles(g)[0]).toHaveLength(4);
  },
  limit,
);
it(
  "cancel is company and price independent and stores all six rows",
  () => {
    const g = guarded();
    reserveGuard(g);
    const command = cancelCommand(state(g.db));
    g.companyDb.prepare("DELETE FROM studio_cases").run();
    g.studio.close(); // revokes capability; cancellation does not consult it
    cleanups.pop();
    cleanups.push(() => {
      closeComparisonStorageSession(g.session);
      g.companyDb.close();
    });
    const r = cancelGuardedPublicComparison(g.session, command, cancelCurrent());
    expect(r).toMatchObject({
      status: "committed",
      insertedRows: 6,
      companyLockObserved: false,
      witnessMatched: true,
    });
    expect(
      cancelGuardedPublicComparison(
        g.session,
        command,
        Object.defineProperty({}, "at", { get: forbidden }),
      ),
    ).toMatchObject({ status: "replay", insertedRows: 0 });
    expect(witnessFiles(g)[0]).toHaveLength(6);
  },
  limit,
);
it(
  "same nonce different command refuses before current and writes no witness",
  () => {
    const g = guarded();
    reserveGuard(g);
    const cmd = { ...fixture.command, companyRevision: fixture.command.companyRevision + 1 };
    expect(() =>
      reserveGuardedPublicComparison(
        g.session,
        cmd,
        Object.defineProperty({}, "at", { get: forbidden }),
      ),
    ).toThrow();
    expect(witnessFiles(g)[0]).toHaveLength(4);
  },
  limit,
);
it.each(["id", "revision", "evidence_revision", "body"] as const)(
  "rejects SQL/company mismatch %s before intent",
  (field) => {
    const g = guarded();
    if (field === "id") g.companyDb.prepare("UPDATE studio_cases SET id=?").run(randomUUID());
    if (field === "revision") g.companyDb.exec("UPDATE studio_cases SET revision=revision+1");
    if (field === "evidence_revision")
      g.companyDb.exec("UPDATE studio_cases SET evidence_revision=revision+1");
    if (field === "body")
      g.companyDb
        .prepare("UPDATE studio_cases SET body=?")
        .run(JSON.stringify({ ...fixture.company, revision: fixture.company.revision + 1 }));
    expect(() => reserveGuard(g)).toThrow(/COMPANY_ROW_INVALID/);
    expect(witnessFiles(g)[0]).toHaveLength(2);
  },
  limit,
);
it(
  "rejects company body beyond 32MiB before JSON parsing",
  () => {
    const g = guarded();
    g.companyDb.prepare("UPDATE studio_cases SET body=?").run(" ".repeat(32 * 1024 * 1024 + 1));
    expect(() => reserveGuard(g)).toThrow(/COMPANY_ROW_INVALID/);
  },
  limit,
);
it(
  "rejects fake company capability, getter, and supplied company field",
  () => {
    const g = guarded();
    for (const cur of [
      { ...g.current, companyGuard: { kind: "comparison-company-guard" } },
      { ...g.current, company: fixture.company },
      Object.defineProperty({ ...g.current }, "at", { get: forbidden }),
    ])
      expect(() => reserveGuardedPublicComparison(g.session, fixture.command, cur)).toThrow();
    expect(witnessFiles(g)[0]).toHaveLength(2);
  },
  limit,
);
it(
  "rejects company capability from another root and active company transaction",
  () => {
    const a = guarded(),
      b = guarded();
    expect(() =>
      reserveGuardedPublicComparison(a.session, fixture.command, {
        ...a.current,
        companyGuard: b.cap,
      }),
    ).toThrow();
    // Owned store transaction, not the competing reader connection.
    const locked = beginComparisonCompanyRead(a.cap, fixture.company.id);
    expect(locked.id).toBe(fixture.company.id);
    expect(() => reserveGuard(a)).toThrow(/COMPANY_TRANSACTION_ACTIVE/);
    endComparisonCompanyRead(a.cap);
  },
  limit,
);
it(
  "quality writer lock is acquired before attempting a competing studio writer",
  () => {
    const g = guarded();
    g.companyDb.exec("BEGIN IMMEDIATE");
    expect(() => reserveGuard(g)).toThrow(/locked/);
    g.companyDb.exec("ROLLBACK");
    expect(witnessFiles(g)[0]).toHaveLength(2);
    expect(g.db.isTransaction).toBe(false);
  },
  limit,
);
it(
  "existing active quality transaction is rejected without touching its transaction",
  () => {
    const g = guarded();
    g.db.exec("BEGIN");
    expect(() => reserveGuard(g)).toThrow(/STORAGE_SESSION_BUSY/);
    expect(g.db.isTransaction).toBe(true);
    g.db.exec("ROLLBACK");
  },
  limit,
);
it(
  "normal SQLite size/mtime and WAL lifecycle are allowed",
  () => {
    const g = guarded();
    g.companyDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    reserveGuard(g);
    const command = cancelCommand(state(g.db));
    expect(cancelGuardedPublicComparison(g.session, command, cancelCurrent()).status).toBe(
      "committed",
    );
  },
  limit,
);
it(
  "restore pending blocks writes and preserves markers",
  () => {
    const g = guarded();
    writeFileSync(join(g.paths.dataRoot, ".restore-pending"), "pending");
    expect(() => reserveGuard(g)).toThrow(/RESTORE_PENDING/);
    expect(readFileSync(join(g.paths.dataRoot, ".restore-pending"), "utf8")).toBe("pending");
  },
  limit,
);
it(
  "unsafe hard-linked SQLite sidecar refuses without deleting it",
  () => {
    const g = guarded(),
      target = join(directory, randomUUID() + ".txt");
    writeFileSync(target, "x");
    linkSync(target, g.paths.qualityFile + "-journal");
    expect(() => reserveGuard(g)).toThrow();
    unlinkSync(g.paths.qualityFile + "-journal");
  },
  limit,
);
it(
  "leftover lease is not removed by age/PID and refuses new operations",
  () => {
    const g = guarded(),
      lock = g.paths.controlDirectory + ".lock";
    mkdirSync(lock);
    expect(() => reserveGuard(g)).toThrow(/BUSY/);
    expect(existsSync(lock)).toBe(true);
    rmdirSync(lock);
  },
  limit,
);
it(
  "partial witness pair stays blocked and is never filled automatically",
  () => {
    const g = guarded();
    unlinkSync(join(g.paths.controlDirectory, "001.json"));
    expect(() => reserveGuard(g)).toThrow();
    expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow();
    expect(existsSync(join(g.paths.controlDirectory, "001.json"))).toBe(false);
  },
  limit,
);
it.each([1, 2, 3, 4, 5, 6, 7])(
  "injected reserve INSERT %i rolls back DB; durable intent prevents silent retry",
  (n) => {
    const g = guarded(),
      before = snapshot(g.db);
    const spy = injectInsert(g.db, n);
    expect(() => reserveGuard(g)).toThrow(/injected/);
    spy.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
    expect(witnessFiles(g)[0]).toHaveLength(3);
    expect(() => reserveGuard(g)).toThrow(/WITNESS_RECONCILIATION_REQUIRED/);
    expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow(
      /WITNESS_RECONCILIATION_REQUIRED/,
    );
  },
  limit,
);
it.each([1, 2, 3, 4, 5, 6])(
  "injected cancel INSERT %i leaves whole reservation and blocks further writes",
  (n) => {
    const g = guarded();
    reserveGuard(g);
    const cmd = cancelCommand(state(g.db)),
      before = snapshot(g.db);
    const spy = injectInsert(g.db, n);
    expect(() => cancelGuardedPublicComparison(g.session, cmd, cancelCurrent())).toThrow(
      /injected/,
    );
    spy.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
    expect(witnessFiles(g)[0]).toHaveLength(5);
    expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow();
  },
  limit,
);
it(
  "COMMIT return loss leaves durable DB rows; explicit reconciliation writes only ack",
  () => {
    const g = guarded(),
      exec = g.db.exec.bind(g.db);
    let once = true;
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      const r = exec(sql);
      if (sql === "COMMIT" && once) {
        once = false;
        throw Error("lost");
      }
      return r;
    });
    expect(() => reserveGuard(g)).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
    spy.mockRestore();
    const before = snapshot(g.db);
    expect(witnessFiles(g)[0]).toHaveLength(3);
    expect(reserveGuardedPublicComparison(g.session, fixture.command)).toMatchObject({
      status: "replay",
      witnessMatched: false,
    });
    expect(reconcilePublicComparisonStorageWitness(g.session)).toMatchObject({
      repairedFilesOnly: true,
    });
    expect(snapshot(g.db)).toEqual(before);
    expect(reconcilePublicComparisonStorageWitness(g.session)).toMatchObject({
      repairedFilesOnly: false,
    });
  },
  limit,
);
it(
  "no-op COMMIT cannot report reservation success or erase intent",
  () => {
    const g = guarded(),
      exec = g.db.exec.bind(g.db);
    const spy = vi
      .spyOn(g.db, "exec")
      .mockImplementation((sql) => (sql === "COMMIT" ? undefined : exec(sql)));
    expect(() => reserveGuard(g)).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
    spy.mockRestore();
    expect(state(g.db).bindings).toHaveLength(0);
    expect(witnessFiles(g)[0]).toHaveLength(3);
  },
  limit,
);
it(
  "ack without DB rows detects restored old database",
  () => {
    const g = guarded();
    reserveGuard(g);
    // Logical restored snapshot, with exact old schema/bytes, same open handle. No product recovery bypass.
    const s = state(g.db),
      rows = s.archive.records;
    const tables = [
      "quality_actual_runs",
      "quality_actual_events",
      "quality_actual_artifacts",
      "quality_actual_requests",
      "quality_actual_budget_events",
      "quality_provider_reservation_bindings",
    ];
    const triggers = g.db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_no_delete'",
      )
      .all();
    g.db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    for (const t of triggers) g.db.exec("DROP TRIGGER " + t.name);
    for (const t of tables) {
      if (t === "quality_actual_requests")
        for (const r of rows.receipts)
          g.db.prepare("DELETE FROM " + t + " WHERE nonce=?").run(r.clientRequestId);
      else if (t === "quality_actual_budget_events")
        for (const r of s.archive.financial.events)
          g.db
            .prepare("DELETE FROM " + t + " WHERE scope_id=? AND revision=?")
            .run(r.scopeId, r.revision);
      else
        for (const r of rows.runs)
          g.db
            .prepare(
              "DELETE FROM " +
                t +
                " WHERE " +
                (t === "quality_actual_runs" ? "id" : "run_id") +
                "=?",
            )
            .run(r.id);
    }
    for (const t of triggers) g.db.exec(String(t.sql));
    g.db.exec("COMMIT; PRAGMA foreign_keys=ON");
    expect(() => reserveGuard(g)).toThrow(/WITNESS_DATABASE_CHANGED/);
    expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow();
  },
  limit,
);
it(
  "existing native suffix cannot enroll a new witness",
  () => {
    const g = guarded(false);
    reservePublicComparisonDatabase(g.db, selection, fixture.command, current());
    expect(() => initializePublicComparisonStorageWitness(g.session, g.cap)).toThrow(
      /WITNESS_NONEMPTY/,
    );
    expect(existsSync(g.paths.controlDirectory)).toBe(false);
  },
  limit,
);
it(
  "unwitnessed supplied writer rows block fresh writes and reconciliation",
  () => {
    const g = guarded();
    reservePublicComparisonDatabase(g.db, selection, fixture.command, current());
    expect(reserveGuardedPublicComparison(g.session, fixture.command)).toMatchObject({
      status: "replay",
      witnessMatched: false,
    });
    expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow();
  },
  limit,
);
it(
  "metadata witness excludes company text, prices, consent and key material",
  () => {
    const g = guarded();
    reserveGuard(g);
    const all = witnessFiles(g)[0].join("");
    for (const key of [
      '"reservedUnits"',
      '"capUnits"',
      '"approvedReview"',
      '"request"',
      '"company"',
      '"rawBody"',
      '"evidence"',
    ])
      expect(all).not.toContain(key);
    for (const content of witnessFiles(g)[0])
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(32768);
  },
  limit,
);

it.each([1, 2])(
  "failure at intent copy %i inserts no SQL rows and preserves any partial witness",
  (copy) => {
    const g = guarded(),
      before = snapshot(g.db),
      original = journalIO.writeJournalJson;
    let count = 0;
    const spy = vi
      .spyOn(journalIO, "writeJournalJson")
      .mockImplementation((file, value, max, fail) => {
        if (value.payload.type === "intent" && ++count === copy) throw Error("intent file failure");
        return original(file, value, max, fail);
      });
    expect(() => reserveGuard(g)).toThrow(/intent file failure/);
    spy.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
    if (copy === 2) expect(() => reserveGuard(g)).toThrow(/WITNESS_PARTIAL/);
  },
  limit,
);
it.each([1, 2])(
  "failure at ack copy %i reports known COMMIT; partial pairs never repaired automatically",
  (copy) => {
    const g = guarded(),
      original = journalIO.writeJournalJson;
    let count = 0;
    const spy = vi
      .spyOn(journalIO, "writeJournalJson")
      .mockImplementation((file, value, max, fail) => {
        if (value.payload.type === "ack" && ++count === copy) throw Error("ack file failure");
        return original(file, value, max, fail);
      });
    let caught: unknown;
    try {
      reserveGuard(g);
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect(caught).toMatchObject({
      message: "PUBLIC_COMPARISON_WITNESS_ACK_REQUIRED",
      commitObserved: true,
    });
    expect(state(g.db).bindings).toHaveLength(1);
    if (copy === 1)
      expect(reconcilePublicComparisonStorageWitness(g.session).repairedFilesOnly).toBe(true);
    else
      expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow(/WITNESS_PARTIAL/);
  },
  limit,
);
it(
  "studio release failure preserves known quality COMMIT and original nonce",
  () => {
    const g = guarded(),
      original = DatabaseSync.prototype.exec;
    let once = true;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const file = this.prepare("PRAGMA database_list")
        .all()
        .find((r) => r.name === "main")?.file;
      if (
        sql === "ROLLBACK" &&
        typeof file === "string" &&
        samePath(file, g.paths.studioFile) &&
        once
      ) {
        once = false;
        throw Error("studio cleanup lost");
      }
      return original.call(this, sql);
    });
    let caught: unknown;
    try {
      reserveGuard(g);
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect(caught).toMatchObject({
      message: "PUBLIC_COMPARISON_COMPANY_CLEANUP_REQUIRED",
      commitObserved: true,
    });
    expect(reserveGuardedPublicComparison(g.session, fixture.command)).toMatchObject({
      status: "replay",
      insertedRows: 0,
      witnessMatched: false,
    });
    expect(reconcilePublicComparisonStorageWitness(g.session).repairedFilesOnly).toBe(true);
  },
  limit,
);
it(
  "reopens session after COMMIT loss and acknowledges exact durable rows only",
  () => {
    const g = guarded(),
      original = g.db.exec.bind(g.db);
    let once = true;
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      const r = original(sql);
      if (sql === "COMMIT" && once) {
        once = false;
        throw Error("lost");
      }
      return r;
    });
    expect(() => reserveGuard(g)).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
    spy.mockRestore();
    closeComparisonStorageSession(g.session);
    cleanups.pop();
    const reopened = openComparisonStorageSession(g.paths, selection);
    cleanups.push(() => {
      closeComparisonStorageSession(reopened);
      g.companyDb.close();
      g.studio.close();
    });
    expect(reconcilePublicComparisonStorageWitness(reopened).repairedFilesOnly).toBe(true);
    expect(reserveGuardedPublicComparison(reopened, fixture.command)).toMatchObject({
      status: "replay",
      witnessMatched: true,
      insertedRows: 0,
    });
  },
  limit,
);
it(
  "an independent process studio writer blocks reservation without an intent",
  async () => {
    const g = guarded();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.send('locked');process.on('message',()=>{d.exec('ROLLBACK');d.close();process.disconnect();});",
        g.paths.studioFile,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    try {
      expect((await once(child, "message"))[0]).toBe("locked");
      expect(() => reserveGuard(g)).toThrow(/locked/);
      expect(witnessFiles(g)[0]).toHaveLength(2);
    } finally {
      child.send("release");
      await once(child, "exit");
    }
  },
  limit,
);
it(
  "reentrant reservation cannot acquire same session or change the original command",
  () => {
    const g = guarded(),
      original = g.db.prepare.bind(g.db);
    let checked = false;
    const spy = vi.spyOn(g.db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO ") && !checked) {
        checked = true;
        expect(() => reserveGuard(g)).toThrow(/STORAGE_SESSION_BUSY/);
      }
      return original(sql);
    });
    expect(reserveGuard(g).status).toBe("committed");
    spy.mockRestore();
    expect(checked).toBe(true);
  },
  limit,
);
it(
  "unrelated ATTACH database and unsafe control paths are refused",
  () => {
    const g = guarded();
    g.db.exec("ATTACH DATABASE ':memory:' AS other");
    expect(() => reserveGuard(g)).toThrow(/DATABASE_HANDLE_MISMATCH/);
    g.db.exec("DETACH DATABASE other");
    expect(() =>
      openComparisonStorageSession(
        { ...g.paths, controlDirectory: join(g.paths.dataRoot, "control") },
        selection,
      ),
    ).toThrow(/STORAGE_PATH_INVALID/);
  },
  limit,
);
it(
  "copied witness directories fail identity even with unchanged bytes",
  () => {
    const g = guarded(),
      old = g.paths.controlDirectory + "-old";
    renameSync(g.paths.controlDirectory, old);
    mkdirSync(g.paths.controlDirectory);
    for (const n of readdirSync(old)) copyFileSync(join(old, n), join(g.paths.controlDirectory, n));
    expect(() => reserveGuard(g)).toThrow(/WITNESS_BINDING_CHANGED/);
  },
  limit,
);

it("session paths reject accessors before evaluating them", () => {
  expect(() =>
    openComparisonStorageSession(
      Object.defineProperty({}, "dataRoot", { get: forbidden }),
      selection,
    ),
  ).toThrow();
});
it(
  "pending ack refuses semantically equal but byte-changed inserted rows",
  () => {
    const g = guarded(),
      exec = g.db.exec.bind(g.db);
    let once = true;
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      const r = exec(sql);
      if (sql === "COMMIT" && once) {
        once = false;
        throw Error("lost");
      }
      return r;
    });
    expect(() => reserveGuard(g)).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
    spy.mockRestore();
    const run = state(g.db).archive.records.runs[0];
    const trigger = g.db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='quality_actual_runs_no_update'")
      .get()!;
    g.db.exec("DROP TRIGGER quality_actual_runs_no_update");
    g.db.prepare("UPDATE quality_actual_runs SET body=' '||body WHERE id=?").run(run.id);
    g.db.exec(String(trigger.sql));
    expect(() => reconcilePublicComparisonStorageWitness(g.session)).toThrow(
      /WITNESS_ROWS_CHANGED/,
    );
    expect(witnessFiles(g)[0]).toHaveLength(3);
  },
  limit,
);

it(
  "lease release failure retains known COMMIT without reporting an unexecuted reservation",
  () => {
    const g = guarded(),
      original = journalIO.acquireJournalLease;
    let once = true;
    const spy = vi.spyOn(journalIO, "acquireJournalLease").mockImplementation((lock, fail) => {
      const lease = original(lock, fail);
      return {
        guard: lease.guard,
        close() {
          if (once) {
            once = false;
            throw Error("lease cleanup");
          }
          lease.close();
        },
      };
    });
    let caught: unknown;
    try {
      reserveGuard(g);
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect(caught).toMatchObject({
      message: "PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED",
      commitObserved: true,
    });
    expect(existsSync(g.paths.controlDirectory + ".lock")).toBe(true);
    endComparisonStorageSession(g.session); // same live owner explicitly finishes cleanup
    expect(reserveGuardedPublicComparison(g.session, fixture.command)).toMatchObject({
      status: "replay",
      insertedRows: 0,
      witnessMatched: true,
    });
  },
  limit,
);
