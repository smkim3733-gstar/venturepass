import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { finalizationStoreFixture } from "./studio-plan-quality-provider-finalization-store-test-helpers";
import { actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { readPublicComparisonPrefix } from "./studio-public-claim-comparison-prefix-test-helpers";
import { publicComparisonNativeFixture } from "./studio-public-claim-comparison-native-test-helpers";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { inspectQualitySchema } from "../../scripts/local-data-quality-schema.mjs";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";
import {
  createPublicComparisonCoverage,
  type PublicComparisonPrefix,
  type PublicComparisonCoverage,
} from "./studio-public-claim-comparison-budget";
import {
  migratePublicComparisonDatabaseV10,
  inspectPublicComparisonDatabase,
  publicComparisonV10InsertGates,
} from "./studio-public-claim-comparison-database";
import {
  migratePublicComparisonDatabaseV11,
  inspectPublicComparisonDatabaseV11,
  reservePublicComparisonDatabase,
  cancelPublicComparisonDatabase,
} from "./studio-public-claim-comparison-database-v11";
import { publicComparisonV11InsertGates } from "./studio-public-claim-comparison-database-v11-schema";
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
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden, StudioStore: forbidden }));
const selection = {
  databaseInstanceId: "4900300f-313a-4114-bbf5-5b0d33b7c824",
  environment: "production" as const,
  scopeId: "candidate-quality-provider-v2-live" as const,
};
let directory: string, base9: string, base10: string, base11: string;
let prefix: PublicComparisonPrefix, coverage: PublicComparisonCoverage;
let fixture: ReturnType<typeof comparisonReservationTestFixture>;
const opened: DatabaseSync[] = [];
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-comparison-v11-"));
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
  base9 = join(directory, "base", "quality-evaluation", "quality.sqlite");
  base10 = join(directory, "base10.sqlite");
  copyFileSync(base9, base10);
  let db = new DatabaseSync(base10);
  try {
    prefix = readPublicComparisonPrefix(db);
    coverage = createPublicComparisonCoverage(prefix);
    migratePublicComparisonDatabaseV10(db, selection, coverage);
  } finally {
    db.close();
  }
  base11 = join(directory, "base11.sqlite");
  copyFileSync(base10, base11);
  db = new DatabaseSync(base11);
  try {
    const r = migratePublicComparisonDatabaseV11(db, selection, coverage);
    fixture = comparisonReservationTestFixture(r.inspection.inspection.state);
  } finally {
    db.close();
  }
  vi.spyOn(configuration, "getProviderConfigurationProposal").mockImplementation(forbidden);
}, 30000);
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
afterAll(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (directory) {
    const r = relative(resolve(tmpdir()), resolve(directory));
    if (!r.startsWith("venture-comparison-v11-") || r.includes("..")) throw Error("unsafe cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
function database(source = base11) {
  const file = join(directory, randomUUID() + ".sqlite");
  copyFileSync(source, file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30");
  opened.push(db);
  return { db, file };
}
function state(db: DatabaseSync) {
  return inspectPublicComparisonDatabaseV11(db, selection).inspection.state;
}
function current(f = fixture) {
  return {
    company: structuredClone(f.company),
    evidence: structuredClone(f.evidence),
    approvedReview: structuredClone(f.review),
    at: f.at,
    runId: randomUUID(),
    eventId: randomUUID(),
    budgetEventId: randomUUID(),
  };
}
function reserve(db: DatabaseSync) {
  return reservePublicComparisonDatabase(db, selection, fixture.command, current());
}
function cancelCommand(s: ComparisonReservationState) {
  const b = s.bindings.at(-1)!;
  const e = s.archive.records.events.filter((x) => x.runId === b.runId).at(-1)!;
  const budget = s.archive.financial.events.at(-1)!;
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
        db.prepare(`SELECT rowid AS original_order,* FROM ${r.name} ORDER BY rowid`).all(),
      ]),
  );
  return { schema, rows };
}
function legacy(db: DatabaseSync) {
  const s = state(db);
  return s.prefix.rows;
}
function injectInsert(db: DatabaseSync, n: number) {
  const original = db.prepare.bind(db);
  let count = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("INSERT INTO ") && ++count === n) throw Error("injected insert failure");
    return original(sql);
  });
  return spy;
}
function replaceBody(db: DatabaseSync, table: string, where: string, body: string) {
  const name = table + "_no_update";
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec("BEGIN");
  db.exec(`DROP TRIGGER ${name}`);
  db.prepare(`UPDATE ${table} SET body=?,body_hash=? WHERE ${where}`).run(
    body,
    digest(JSON.parse(body)),
  );
  db.exec(sql);
  db.exec("COMMIT");
}
it("explicit empty cutover preserves every original row, coverage bytes and default v9 behavior", () => {
  const { db, file } = database(base10),
    before = snapshot(db);
  const r = migratePublicComparisonDatabaseV11(db, selection, coverage);
  expect(r.status).toBe("migrated-v11");
  expect(r.migrationCommitObserved).toBe(true);
  expect(snapshot(db).rows).toEqual(before.rows);
  expect(migratePublicComparisonDatabaseV11(db, selection, coverage).status).toBe("already-v11");
  const read = new DatabaseSync(file, { readOnly: true });
  try {
    expect(inspectPublicComparisonDatabaseV11(read, selection)).toEqual(r.inspection);
  } finally {
    read.close();
  }
  const old = new DatabaseSync(base9);
  try {
    expect(inspectQualitySchema(old).version).toBe(9);
  } finally {
    old.close();
  }
});
it("rejects v9 direct migration and preserves its original schema", () => {
  const { db } = database(base9),
    before = snapshot(db);
  expect(() => migratePublicComparisonDatabaseV11(db, selection, coverage)).toThrow();
  expect(snapshot(db)).toEqual(before);
});
it.each(["identity", "coverage"] as const)("rejects stale %s before DDL", (kind) => {
  const { db } = database(base10),
    before = snapshot(db);
  expect(() =>
    migratePublicComparisonDatabaseV11(
      db,
      kind === "identity" ? { ...selection, databaseInstanceId: randomUUID() } : selection,
      kind === "coverage" ? { ...coverage, coverageDigest: "f".repeat(64) } : coverage,
    ),
  ).toThrow();
  expect(snapshot(db)).toEqual(before);
});
it("does not promote an existing supplied native v10 suffix", () => {
  const { db } = database(base10),
    f = publicComparisonNativeFixture(prefix, coverage);
  db.exec("BEGIN");
  for (const name of Object.keys(publicComparisonV10InsertGates)) db.exec(`DROP TRIGGER ${name}`);
  // Only fixture seeding bypasses the closed v10 gates; no production importer.
  for (const v of f.a.records.runs)
    db.prepare("INSERT INTO quality_actual_runs(id,body,body_hash) VALUES(?,?,?)").run(
      v.id,
      JSON.stringify(v),
      digest(v),
    );
  for (const sql of Object.values(publicComparisonV10InsertGates)) db.exec(sql);
  db.exec("COMMIT");
  const before = snapshot(db);
  expect(() => migratePublicComparisonDatabaseV11(db, selection, coverage)).toThrow(
    "SUFFIX_NOT_EMPTY",
  );
  expect(snapshot(db)).toEqual(before);
});
it("old v9/v10 readers and constructors reject v11", () => {
  const { db, file } = database();
  expect(() => inspectQualitySchema(db)).toThrow();
  expect(() => inspectQualityDatabase(db)).toThrow();
  expect(() => inspectPublicComparisonDatabase(db, selection)).toThrow();
  expect(() => migratePublicComparisonDatabaseV10(db, selection, coverage)).toThrow();
  const base = join(directory, randomUUID());
  // Constructor test uses a complete fixture layout, not backup/restore.
  const s = new PlanQualityStore(base, { providerEnvironment: "synthetic-test" });
  s.close();
  copyFileSync(file, join(base, "quality-evaluation", "quality.sqlite"));
  expect(() => new PlanQualityStore(base, { providerEnvironment: "synthetic-test" })).toThrow();
});
it("commits seven exact reservation rows and reopens with one nonce owner", () => {
  const { db, file } = database(),
    before = legacy(db);
  const r = reserve(db);
  expect(r.status).toBe("committed");
  expect(r.insertedRows).toBe(7);
  expect(r.commitObserved).toBe(true);
  expect(r.inspection.inspection.view.native.heldUnits).toBe("2");
  expect(r.inspection.inspection.state.prefix.rows).toEqual(before);
  expect(r.inspection.inspection.state.archive.records.receipts).toHaveLength(1);
  expect(r.inspection.inspection.state.bindings).toHaveLength(1);
  expect(Object.values(r.authority).every((v) => v === false)).toBe(true);
  const reopened = new DatabaseSync(file, { readOnly: true });
  try {
    expect(inspectPublicComparisonDatabaseV11(reopened, selection)).toEqual(r.inspection);
  } finally {
    reopened.close();
  }
});
it("cancels in six rows after evidence expiry and releases only unused storage, preserving past cost", () => {
  const { db } = database(),
    r = reserve(db),
    s = r.inspection.inspection.state;
  const c = cancelCommand(s),
    cancelled = cancelPublicComparisonDatabase(db, selection, c, cancelCurrent());
  expect(cancelled.status).toBe("committed");
  expect(cancelled.insertedRows).toBe(6);
  expect(cancelled.inspection.inspection.view.native.heldUnits).toBe("0");
  expect(cancelled.inspection.inspection.view.native.capacity.comparisonHeldBytes).toBe(0);
  expect(cancelled.inspection.inspection.view.native.recognizedUnits).toBe(
    r.inspection.inspection.view.native.recognizedUnits,
  );
  expect(cancelled.inspection.inspection.state.archive.records.receipts).toHaveLength(3);
  expect(cancelled.inspection.inspection.state.archive.financial.receipts).toHaveLength(2);
});
it.each(["reserve", "cancel"] as const)(
  "replays %s before inspecting invalid current inputs and changes no rows",
  (op) => {
    const { db } = database(),
      r = reserve(db);
    const c = cancelCommand(r.inspection.inspection.state);
    if (op === "cancel") cancelPublicComparisonDatabase(db, selection, c, cancelCurrent());
    const before = snapshot(db),
      poisoned = Object.defineProperty({}, "at", {
        get: () => {
          throw Error("must not inspect current");
        },
      });
    const result =
      op === "reserve"
        ? reservePublicComparisonDatabase(db, selection, fixture.command, poisoned)
        : cancelPublicComparisonDatabase(db, selection, c, poisoned);
    expect(result.status).toBe("replay");
    expect(result.insertedRows).toBe(0);
    expect(result.owner).toBeNull();
    expect(snapshot(db)).toEqual(before);
  },
);
it("rejects same reservation nonce with a different full command", () => {
  const { db } = database();
  reserve(db);
  const before = snapshot(db);
  const command = structuredClone(fixture.command);
  command.approval.approvedAt = "2026-10-05T10:00:01.000Z";
  expect(() => reservePublicComparisonDatabase(db, selection, command)).toThrow();
  expect(snapshot(db)).toEqual(before);
});
it.each(["company", "evidence", "head"] as const)("refuses new stale %s without writes", (kind) => {
  const { db } = database(),
    before = snapshot(db),
    cur = current(),
    command = structuredClone(fixture.command);
  if (kind === "company") cur.company.revision++;
  if (kind === "evidence") cur.evidence.context.contextWindowTokens++;
  if (kind === "head") command.expectedBudgetHead.revision++;
  expect(() => reservePublicComparisonDatabase(db, selection, command, cur)).toThrow();
  expect(snapshot(db)).toEqual(before);
});
it.each([1, 2, 3, 4, 5, 6, 7])(
  "rolls back reservation at insert %i and clears the capability",
  (n) => {
    const { db } = database(),
      before = snapshot(db),
      cur = current(),
      spy = injectInsert(db, n);
    try {
      expect(() => reservePublicComparisonDatabase(db, selection, fixture.command, cur)).toThrow(
        "injected",
      );
    } finally {
      spy.mockRestore();
    }
    expect(snapshot(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
    expect(
      db
        .prepare("SELECT comparison_v11_insert_guard('quality_actual_runs','x','{}','x') AS n")
        .get()!.n,
    ).toBe(0);
  },
);
it.each([1, 2, 3, 4, 5, 6])(
  "rolls back cancellation at insert %i, retaining all cost/storage holds",
  (n) => {
    const { db } = database(),
      r = reserve(db),
      c = cancelCommand(r.inspection.inspection.state),
      before = snapshot(db),
      spy = injectInsert(db, n);
    try {
      expect(() => cancelPublicComparisonDatabase(db, selection, c, cancelCurrent())).toThrow(
        "injected",
      );
    } finally {
      spy.mockRestore();
    }
    expect(snapshot(db)).toEqual(before);
    expect(state(db).archive.records.events).toHaveLength(1);
  },
  15000,
);
it.each(["first-ddl", "last-ddl", "before-commit"] as const)(
  "rolls back migration at %s",
  (phase) => {
    const { db } = database(base10),
      before = snapshot(db),
      original = db.exec.bind(db);
    const last = Object.values(publicComparisonV11InsertGates).at(-1)!;
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (
        (phase === "first-ddl" && sql.startsWith("DROP TRIGGER")) ||
        (phase === "before-commit" && sql === "COMMIT")
      )
        throw Error("injected");
      const result = original(sql);
      if (phase === "last-ddl" && sql === last) throw Error("injected");
      return result;
    });
    try {
      expect(() => migratePublicComparisonDatabaseV11(db, selection, coverage)).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(snapshot(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
  },
);
it.each(["reserve", "cancel", "migration"] as const)(
  "recovers %s after COMMIT response loss without inserting again",
  (op) => {
    const { db, file } = database(op === "migration" ? base10 : base11);
    const command =
      op === "cancel" ? cancelCommand(reserve(db).inspection.inspection.state) : fixture.command;
    const cur = op === "cancel" ? cancelCurrent() : current(),
      original = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      const result = original(sql);
      if (sql === "COMMIT") throw Error("lost commit response");
      return result;
    });
    try {
      expect(() =>
        op === "migration"
          ? migratePublicComparisonDatabaseV11(db, selection, coverage)
          : op === "reserve"
            ? reservePublicComparisonDatabase(db, selection, command, cur)
            : cancelPublicComparisonDatabase(db, selection, command, cur),
      ).toThrow("COMMIT_OBSERVATION_UNKNOWN");
    } finally {
      spy.mockRestore();
    }
    expect(db.isTransaction).toBe(false);
    const before = snapshot(db);
    const again = new DatabaseSync(file);
    opened.push(again);
    const result =
      op === "migration"
        ? migratePublicComparisonDatabaseV11(again, selection, coverage)
        : op === "reserve"
          ? reservePublicComparisonDatabase(again, selection, command)
          : cancelPublicComparisonDatabase(again, selection, command);
    expect(result.status).toBe(op === "migration" ? "already-v11" : "replay");
    expect(snapshot(db)).toEqual(before);
  },
  15000,
);
it("rejects caller-owned transactions without rolling them back", () => {
  const { db } = database();
  db.exec("BEGIN IMMEDIATE");
  expect(() => inspectPublicComparisonDatabaseV11(db, selection)).toThrow("TRANSACTION_ACTIVE");
  expect(() => reserve(db)).toThrow("TRANSACTION_ACTIVE");
  expect(() => migratePublicComparisonDatabaseV11(db, selection, coverage)).toThrow(
    "TRANSACTION_ACTIVE",
  );
  expect(db.isTransaction).toBe(true);
  db.exec("ROLLBACK");
});
it("keeps ordinary inserts closed and refuses an arbitrary writer capability string", () => {
  const { db } = database();
  db.function("comparison_v11_insert_guard", { varargs: true }, () => "quality-v11");
  expect(() =>
    db.prepare("INSERT INTO quality_actual_runs(id,body,body_hash) VALUES('fake','{}','x')").run(),
  ).toThrow();
  expect(() =>
    db
      .prepare(
        "INSERT INTO quality_provider_purpose_coverage(id,body,body_hash) VALUES(1,'{}','x')",
      )
      .run(),
  ).toThrow();
  // Re-registering the private guard during the real call repairs only its own connection.
  expect(reserve(db).status).toBe("committed");
  expect(() =>
    db.prepare("INSERT INTO quality_actual_runs(id,body,body_hash) VALUES('fake','{}','x')").run(),
  ).toThrow();
});
it("rejects altered row bytes inside an active capability and prevents reentrant writes", () => {
  const { db } = database(),
    original = db.prepare.bind(db);
  let checked = false;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (!checked && sql.startsWith("INSERT INTO quality_actual_runs")) {
      checked = true;
      expect(() => reserve(db)).toThrow("TRANSACTION_ACTIVE");
      expect(() =>
        original(
          "INSERT INTO quality_actual_runs(id,body,body_hash) VALUES('other','{}','wrong')",
        ).run(),
      ).toThrow();
    }
    return original(sql);
  });
  try {
    expect(reserve(db).status).toBe("committed");
    expect(checked).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it("serializes competing connections and refuses a stale second reservation", () => {
  const { db, file } = database(),
    other = new DatabaseSync(file);
  opened.push(other);
  other.exec("PRAGMA busy_timeout=20");
  db.exec("BEGIN IMMEDIATE");
  expect(() => reserve(other)).toThrow();
  expect(db.isTransaction).toBe(true);
  db.exec("ROLLBACK");
  reserve(db);
  const before = snapshot(db);
  const command = { ...fixture.command, clientRequestId: randomUUID() };
  expect(() => reservePublicComparisonDatabase(other, selection, command, current())).toThrow();
  expect(snapshot(db)).toEqual(before);
}, 15000);
it("honors a separate process writer lock without disturbing its transaction", async () => {
  const { db, file } = database();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.send('locked');process.on('message',()=>{d.exec('COMMIT');d.close();process.disconnect();});`,
      file,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
  );
  try {
    const [message] = await once(child, "message");
    expect(message).toBe("locked");
    expect(() => reserve(db)).toThrow();
  } finally {
    child.send("release");
    await once(child, "exit");
  }
  expect(reserve(db).status).toBe("committed");
}, 15000);
it("counts noncanonical binding bytes without rewriting the stored original", () => {
  const { db } = database(),
    r = reserve(db),
    b = r.inspection.inspection.state.bindings[0];
  const row = db
    .prepare("SELECT body FROM quality_provider_reservation_bindings WHERE run_id=?")
    .get(b.runId)!;
  replaceBody(
    db,
    "quality_provider_reservation_bindings",
    `run_id='${b.runId}'`,
    String(row.body) + " ".repeat(1000),
  );
  const read = inspectPublicComparisonDatabaseV11(db, selection);
  expect(read.bindingRawOverheadBytes).toBe(1000);
  expect(
    read.inspection.view.capacity.totalExposureBytes -
      r.inspection.inspection.view.capacity.totalExposureBytes,
  ).toBe(1000);
  expect(
    db
      .prepare("SELECT body FROM quality_provider_reservation_bindings WHERE run_id=?")
      .get(b.runId)!.body,
  ).toBe(String(row.body) + " ".repeat(1000));
});
it("rejects a self-rehashed binding whose consent no longer matches its original review", () => {
  const { db } = database(),
    r = reserve(db),
    b = structuredClone(r.inspection.inspection.state.bindings[0]);
  b.command.approval.noticeDigest = "a".repeat(64);
  b.commandDigest = digest(b.command);
  const { recordDigest: ignored, ...body } = b;
  void ignored;
  b.recordDigest = digest(body);
  replaceBody(
    db,
    "quality_provider_reservation_bindings",
    `run_id='${b.runId}'`,
    JSON.stringify(b),
  );
  expect(() => inspectPublicComparisonDatabaseV11(db, selection)).toThrow();
});
it("requires the single binding and refuses partial cancellation on reopen", () => {
  const { db } = database(),
    r = reserve(db),
    c = cancelCommand(r.inspection.inspection.state);
  cancelPublicComparisonDatabase(db, selection, c, cancelCurrent());
  const s = state(db),
    end = s.archive.records.events.at(-1)!;
  const name = "quality_actual_events_no_delete",
    sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  db.prepare("DELETE FROM quality_actual_events WHERE run_id=? AND revision=?").run(
    end.runId,
    end.revision,
  );
  db.exec(sql);
  expect(() => inspectPublicComparisonDatabaseV11(db, selection)).toThrow();
}, 15000);

it("keeps the same budget scope and original raw prefix through a second completed cancellation", () => {
  const { db } = database(),
    first = reserve(db),
    original = first.inspection.inspection.state.prefix.rows;
  const c = cancelCommand(first.inspection.inspection.state);
  const ended = cancelPublicComparisonDatabase(db, selection, c, {
    ...cancelCurrent(),
    at: fixture.at,
  });
  const nextFixture = comparisonReservationTestFixture(ended.inspection.inspection.state);
  const second = reservePublicComparisonDatabase(
    db,
    selection,
    nextFixture.command,
    current(nextFixture),
  );
  expect(second.inspection.inspection.state.bindings).toHaveLength(2);
  expect(second.inspection.inspection.state.prefix.rows).toEqual(original);
  expect(second.inspection.inspection.view.native.recognizedUnits).toBe(
    first.inspection.inspection.view.native.recognizedUnits,
  );
  expect(second.inspection.inspection.view.native.heldUnits).toBe("2");
}, 15000);
it("rejects a changed full cancellation command under the original nonce without reading new inputs", () => {
  const { db } = database(),
    r = reserve(db),
    c = cancelCommand(r.inspection.inspection.state);
  cancelPublicComparisonDatabase(db, selection, c, cancelCurrent());
  const before = snapshot(db);
  expect(() =>
    cancelPublicComparisonDatabase(db, selection, { ...c, expectedBindingDigest: "f".repeat(64) }),
  ).toThrow();
  expect(snapshot(db)).toEqual(before);
}, 15000);
it("does not report a no-op COMMIT as persisted", () => {
  const { db } = database(),
    before = snapshot(db),
    original = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql !== "COMMIT") original(sql);
  });
  try {
    expect(() => reserve(db)).toThrow("COMMIT_OBSERVATION_UNKNOWN");
  } finally {
    spy.mockRestore();
  }
  expect(db.isTransaction).toBe(false);
  expect(snapshot(db)).toEqual(before);
});
it("reports rollback uncertainty and closes its insert capability until the caller recovers", () => {
  const { db } = database(),
    before = snapshot(db),
    prepare = injectInsert(db, 2),
    original = db.exec.bind(db);
  const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "ROLLBACK") throw Error("rollback lost");
    original(sql);
  });
  try {
    expect(() => reserve(db)).toThrow("RECOVERY_REQUIRED");
  } finally {
    prepare.mockRestore();
    exec.mockRestore();
  }
  expect(db.isTransaction).toBe(true);
  expect(
    db.prepare("SELECT comparison_v11_insert_guard('quality_actual_runs','x','{}','x') AS n").get()!
      .n,
  ).toBe(0);
  db.exec("ROLLBACK");
  expect(snapshot(db)).toEqual(before);
  expect(reserve(db).status).toBe("committed");
});
it("checks exact body, hash, key and BLOB bytes for the current planned insert", () => {
  const { db } = database(),
    original = db.prepare.bind(db);
  let checkedBody = false,
    checkedBlob = false;
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const stmt = original(sql);
    if (
      sql.startsWith("INSERT INTO quality_actual_runs(") ||
      sql.startsWith("INSERT INTO quality_actual_artifacts(")
    ) {
      const run = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation((...args: Parameters<typeof stmt.run>) => {
        const values = args as import("node:sqlite").SQLInputValue[];
        if (sql.startsWith("INSERT INTO quality_actual_runs(")) {
          const changed = [...values];
          changed[1] = String(changed[1]) + " ";
          expect(() => run(...changed)).toThrow();
          const hash = [...values];
          hash[2] = "f".repeat(64);
          expect(() => run(...hash)).toThrow();
          checkedBody = true;
        } else {
          const changed = [...values];
          changed[2] = Buffer.from("different");
          expect(() => run(...changed)).toThrow();
          checkedBlob = true;
        }
        return run(...values);
      });
    }
    return stmt;
  });
  try {
    expect(reserve(db).status).toBe("committed");
    expect(checkedBody && checkedBlob).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it.each(["runId", "clientRequestId"] as const)(
  "rejects stored binding %s differing from its SQL key",
  (key) => {
    const { db } = database(),
      r = reserve(db),
      b = structuredClone(r.inspection.inspection.state.bindings[0]),
      id = b.runId;
    b[key] = randomUUID();
    const { recordDigest: ignored, ...body } = b;
    void ignored;
    b.recordDigest = digest(body);
    replaceBody(db, "quality_provider_reservation_bindings", `run_id='${id}'`, JSON.stringify(b));
    expect(() => inspectPublicComparisonDatabaseV11(db, selection)).toThrow();
  },
);
it("does not treat a run whose binding is missing as a grandfathered reservation", () => {
  const { db } = database(),
    r = reserve(db),
    id = r.inspection.inspection.state.bindings[0].runId;
  const name = "quality_provider_reservation_bindings_no_delete";
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql as string;
  db.exec(`DROP TRIGGER ${name}`);
  db.prepare("DELETE FROM quality_provider_reservation_bindings WHERE run_id=?").run(id);
  db.exec(sql);
  expect(() => inspectPublicComparisonDatabaseV11(db, selection)).toThrow();
});
