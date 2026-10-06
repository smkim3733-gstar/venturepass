import * as transmissionRows from "../../scripts/local-data-quality-provider-transmission-database.mjs";
import {
  comparisonTransmissionBasisSchema,
  comparisonTransmissionNotice,
  comparisonDispatchCommandSchema,
  comparisonUnknownCommandSchema,
  comparisonCaptureCommandSchema,
  createComparisonTransmissionReview,
} from "./studio-public-claim-comparison-transmission";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { captureProviderResponse } from "../../scripts/local-data-quality-provider-usage.mjs";
import { comparisonSha as sha } from "./studio-public-claim-comparison-financial";
import { publicClaimComparisonRequestPins } from "./studio-public-claim-comparison-request-types";
import * as journalIO from "../../scripts/local-journal-io.mjs";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  reserveGuardedPublicComparison,
  initializePublicComparisonStorageWitness,
  inspectPublicComparisonDatabaseV12,
  migrateGuardedPublicComparisonDatabaseV12,
  writeGuardedPublicComparisonV12,
  reconcilePublicComparisonStorageWitnessV2,
} from "./studio-public-claim-comparison-database-v11";
import {
  openComparisonStorageSession,
  closeComparisonStorageSession,
  beginComparisonStorageSession,
  endComparisonStorageSession,
  requireComparisonWitnessCapacity,
} from "./studio-public-comparison-storage-witness";
import {
  comparisonCancelCommandSchema,
  type ComparisonReservationState,
} from "./studio-public-claim-comparison-reservation";
import * as configuration from "./studio-plan-quality-provider-configuration";
import { comparisonReservationTestFixture } from "./studio-public-claim-comparison-reservation-test-helpers";
vi.mock("server-only", () => ({}));
// Keep the real SDK error module out of isolated storage regression imports.
vi.mock("openai/error", () => {
  class APIError extends Error {}
  return {
    APIError,
    APIConnectionError: class extends APIError {},
    APIConnectionTimeoutError: class extends APIError {},
    APIUserAbortError: class extends APIError {},
  };
});
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
  directory = mkdtempSync(join(tmpdir(), "venture-comparison-v12-"));
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
    if (!r.startsWith("venture-comparison-v12-") || r.includes("..")) throw Error("unsafe cleanup");
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

// New multi-transaction SQL + two-copy fsync journeys include several full audits/replays.
// Existing suite timeouts and every production deadline/cap remain unchanged.
const limit = 90000;
const capture = captureProviderResponse({
  id: "synthetic-capture",
  model: "synthetic-model",
  status: "completed",
  output: [],
});
const later = "2026-10-07T10:00:00.000Z";
function state12(g: ReturnType<typeof guarded>) {
  return inspectPublicComparisonDatabaseV12(g.db, selection).transmission!.state;
}
function setup12(reserve = true) {
  const g = guarded();
  if (reserve) reserveGuard(g);
  migrateGuardedPublicComparisonDatabaseV12(g.session);
  return g;
}
function dispatchInput(g: ReturnType<typeof guarded>) {
  const reserved = state12(g),
    at = fixture.at;
  const e = fixture.evidence;
  const basis = comparisonTransmissionBasisSchema.parse({
    kind: "public-comparison-transmission-basis",
    basisVersion: 1,
    purpose: e.purpose,
    provenance: e.provenance,
    model: e.model,
    requestVersion: e.requestVersion,
    contractDigest: e.contractDigest,
    destination: e.destination,
    store: false,
    requestedTier: null,
    maxCalls: 1,
    automaticRetryLimit: 0,
    maxOutputTokens: 16000,
    omissions: e.omissions,
    sources: e.sources,
    method: "POST",
    strict: true,
    schemaDigest: publicClaimComparisonRequestPins.schemaDigest,
    financialBasisDigest: fixture.review.financialBasis.basisDigest,
    retentionNoticeDigest: fixture.review.retentionNoticeDigest,
    notice: { ...comparisonTransmissionNotice, noticeDigest: digest(comparisonTransmissionNotice) },
  });
  const review = createComparisonTransmissionReview(
    reserved,
    fixture.company,
    reserved.reservation.archive.records.runs.at(-1)!.id,
    basis,
    at,
  );
  const command = comparisonDispatchCommandSchema.parse({
    commandVersion: 1,
    kind: "approve-dispatch-public-claim-comparison",
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: review.runId,
    runDigest: review.runDigest,
    expectedReservationBindingDigest: review.reservationBindingDigest,
    approvedReviewDigest: review.reviewDigest,
    expectedTransmissionArchiveDigest: review.transmissionArchiveDigest,
    expectedCoverageDigest: review.coverageDigest,
    expectedRunHead: review.runHead,
    expectedBudgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
    approval: {
      noticeVersion: 1,
      noticeDigest: basis.notice.noticeDigest,
      retentionNoticeDigest: review.retentionNoticeDigest,
      exactRequestIdentityDigest: digest(review.identity),
      approvedAt: at,
      expiresAt: review.expiresAt,
      externalTransmissionAcknowledged: true,
      comparisonPurposeAcknowledged: true,
      singleCallAcknowledged: true,
      noAutomaticRetryAcknowledged: true,
      unknownCostHoldAcknowledged: true,
      noResendAcknowledged: true,
      localRetentionAcknowledged: true,
    },
  });

  return {
    command,
    current: { companyGuard: g.cap, approvedReview: review, basis, at, eventId: randomUUID() },
  };
}
function dispatch(g: ReturnType<typeof guarded>) {
  const input = dispatchInput(g);
  return {
    input,
    result: writeGuardedPublicComparisonV12(
      g.session,
      "approve-dispatch",
      input.command,
      input.current,
    ),
  };
}
function continuation(g: ReturnType<typeof guarded>, kind: "unknown" | "capture") {
  const s = state12(g),
    b = s.transmissionBindings[0],
    e = s.reservation.archive.records.events.at(-1)!;
  const base = {
    commandVersion: 1,
    purpose: "compare-public-claim",
    clientRequestId: randomUUID(),
    runId: b.runId,
    transmissionBindingDigest: b.recordDigest,
    dispatchEventDigest: b.dispatchEventDigest,
    expectedRunHead: { revision: e.revision, headDigest: e.eventDigest },
  };
  return kind === "unknown"
    ? comparisonUnknownCommandSchema.parse({
        ...base,
        kind: "mark-public-comparison-unknown",
        reason: "transport-unknown",
      })
    : comparisonCaptureCommandSchema.parse({
        ...base,
        kind: "persist-public-comparison-capture",
        responseArtifactSha256: sha(JSON.stringify(capture)),
        sizeBytes: Buffer.byteLength(JSON.stringify(capture)),
      });
}
function mark(g: ReturnType<typeof guarded>) {
  const c = continuation(g, "unknown");
  return {
    command: c,
    result: writeGuardedPublicComparisonV12(g.session, "mark-unknown", c, {
      at: later,
      eventId: randomUUID(),
    }),
  };
}
function save(g: ReturnType<typeof guarded>) {
  const c = continuation(g, "capture");
  return {
    command: c,
    result: writeGuardedPublicComparisonV12(g.session, "persist-capture", c, {
      at: later,
      eventId: randomUUID(),
      capture,
    }),
  };
}
function explode() {
  return Object.defineProperty({}, "at", {
    enumerable: true,
    get() {
      throw Error("current read");
    },
  });
}
it(
  "explicit empty transition preserves all rows and witness1 bytes; old APIs reject and no automatic migration",
  () => {
    const g = guarded(),
      before = snapshot(g.db),
      old = witnessFiles(g);
    expect(() => inspectPublicComparisonDatabaseV12(g.db, selection)).toThrow();
    expect(migrateGuardedPublicComparisonDatabaseV12(g.session).status).toBe("migrated-v12");
    expect(snapshot(g.db).rows).toEqual(before.rows);
    expect(witnessFiles(g).map((x) => x.slice(0, 2))).toEqual(old);
    expect(() => inspectPublicComparisonDatabaseV11(g.db, selection)).toThrow();
    expect(() => reserveGuard(g)).toThrow();
    expect(migrateGuardedPublicComparisonDatabaseV12(g.session).status).toBe("already-v12");
    expect(state12(g).transmissionBindings).toEqual([]);
  },
  limit,
);
it(
  "reserved transition followed by dispatch unknown late capture preserves prefix and same scope hold; all false authorities",
  () => {
    const g = guarded();
    reserveGuard(g);
    const before = state(g.db),
      files = witnessFiles(g);
    migrateGuardedPublicComparisonDatabaseV12(g.session);
    const d = dispatch(g);
    expect(d.result.insertedRows).toBe(3);
    expect(d.result.companyLockObserved).toBe(true);
    g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
    const u = mark(g),
      c = save(g);
    expect(u.result.insertedRows).toBe(2);
    expect(c.result.insertedRows).toBe(3);
    const after = state12(g);
    expect(after.reservation.prefix).toEqual(before.prefix);
    expect(after.reservation.coverage).toEqual(before.coverage);
    expect(after.reservation.archive.financial).toEqual(before.archive.financial);
    expect(witnessFiles(g).map((x) => x.slice(0, files[0].length))).toEqual(files);
    for (const r of [d.result, u.result, c.result]) {
      expect(r.owner).toBeNull();
      expect(r.commitObserved).toBe(true);
      expect(r.witnessMatched).toBe(true);
      expect(Object.values(r.authority).every((v) => v === false)).toBe(true);
    }
    for (const [op, command] of [
      ["approve-dispatch", d.input.command],
      ["mark-unknown", u.command],
      ["persist-capture", c.command],
    ] as const) {
      const result = writeGuardedPublicComparisonV12(g.session, op, command, explode());
      expect(result.status).toBe("replay");
      expect(result.insertedRows).toBe(0);
    }
  },
  limit,
);
it(
  "SQL12 can reserve and cancel using existing binding and frozen company rows",
  () => {
    const g = setup12(false),
      before = allCompany(g.companyDb);
    const r = writeGuardedPublicComparisonV12(g.session, "reserve", fixture.command, g.current);
    expect(r.insertedRows).toBe(7);
    const c = cancelCommand(state12(g).reservation);
    expect(
      writeGuardedPublicComparisonV12(g.session, "cancel", c, cancelCurrent()).insertedRows,
    ).toBe(6);
    expect(allCompany(g.companyDb)).toEqual(before);
  },
  limit,
);
it(
  "dispatch lock holds company writer until quality COMMIT; competing quality connections cannot write",
  () => {
    const g = setup12(),
      input = dispatchInput(g),
      exec = g.db.exec.bind(g.db);
    const competitor = new DatabaseSync(g.paths.qualityFile);
    competitor.exec("PRAGMA busy_timeout=10");
    let observed = false;
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && !observed) {
        expect(() => g.companyDb.exec("BEGIN IMMEDIATE")).toThrow();
        expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow();
        observed = true;
      }
      exec(sql);
    });
    try {
      writeGuardedPublicComparisonV12(g.session, "approve-dispatch", input.command, input.current);
      expect(observed).toBe(true);
    } finally {
      spy.mockRestore();
      competitor.close();
    }
  },
  limit,
);
for (const op of ["approve-dispatch", "mark-unknown", "persist-capture"] as const) {
  it(
    op + " exact nonce collision rejects full changed command before current",
    () => {
      const g = setup12();
      const d = dispatch(g);
      const c =
        op === "approve-dispatch"
          ? d.input.command
          : op === "mark-unknown"
            ? mark(g).command
            : save(g).command;
      const changed = { ...c, runId: randomUUID() };
      expect(() => writeGuardedPublicComparisonV12(g.session, op, changed, explode())).toThrow(
        /TRANSMISSION_CHANGED/,
      );
    },
    limit,
  );
  const count = op === "mark-unknown" ? 2 : 3;
  for (let n = 1; n <= count; n++)
    it(
      op + " insert " + n + " failure rolls back all rows and leaves intent blocked",
      () => {
        const g = setup12();
        if (op !== "approve-dispatch") dispatch(g);
        const input =
          op === "approve-dispatch"
            ? dispatchInput(g)
            : {
                command: continuation(g, op === "mark-unknown" ? "unknown" : "capture"),
                current: {
                  at: later,
                  eventId: randomUUID(),
                  ...(op === "persist-capture" ? { capture } : {}),
                },
              };
        const before = snapshot(g.db),
          spy = injectInsert(g.db, n);
        expect(() =>
          writeGuardedPublicComparisonV12(g.session, op, input.command, input.current),
        ).toThrow("injected insert failure");
        spy.mockRestore();
        expect(snapshot(g.db)).toEqual(before);
        expect(() => reconcilePublicComparisonStorageWitnessV2(g.session)).toThrow();
        expect(() =>
          writeGuardedPublicComparisonV12(g.session, op, input.command, input.current),
        ).toThrow();
      },
      limit,
    );
  it(
    op + " COMMIT return loss recovers exact DB command and ack files only with no owner",
    () => {
      const g = setup12();
      if (op !== "approve-dispatch") dispatch(g);
      const input =
        op === "approve-dispatch"
          ? dispatchInput(g)
          : {
              command: continuation(g, op === "mark-unknown" ? "unknown" : "capture"),
              current: {
                at: later,
                eventId: randomUUID(),
                ...(op === "persist-capture" ? { capture } : {}),
              },
            };
      const exec = g.db.exec.bind(g.db);
      let hit = false;
      const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql === "COMMIT" && !hit) {
          hit = true;
          throw Error("lost");
        }
      });
      expect(() =>
        writeGuardedPublicComparisonV12(g.session, op, input.command, input.current),
      ).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
      spy.mockRestore();
      const before = snapshot(g.db);
      expect(
        writeGuardedPublicComparisonV12(g.session, op, input.command, explode()).witnessMatched,
      ).toBe(false);
      expect(reconcilePublicComparisonStorageWitnessV2(g.session).repairedFilesOnly).toBe(true);
      expect(snapshot(g.db)).toEqual(before);
      expect(
        writeGuardedPublicComparisonV12(g.session, op, input.command, explode()).owner,
      ).toBeNull();
    },
    limit,
  );
}
for (const fault of ["ddl-before", "ddl-after", "commit-loss", "ack-loss"] as const)
  it(
    "transition " + fault + " preserves v1 and enforces explicit recovery",
    () => {
      const g = guarded(),
        before = snapshot(g.db),
        files = witnessFiles(g),
        exec = g.db.exec.bind(g.db);
      let hit = false;
      const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
        if (sql.startsWith("DROP TRIGGER") && !hit && fault === "ddl-before") {
          hit = true;
          throw Error("ddl");
        }
        exec(sql);
        if (
          !hit &&
          ((fault === "ddl-after" && sql.startsWith("CREATE TRIGGER")) ||
            (fault === "commit-loss" && sql === "COMMIT"))
        ) {
          hit = true;
          throw Error("injected");
        }
      });
      const io = vi
        .spyOn(journalIO, "writeJournalJson")
        .mockImplementation((file, value, ...args) => {
          if (fault === "ack-loss" && String(file).endsWith("003.json")) throw Error("ack lost");
          return originalWrite(file, value, ...args);
        });
      expect(() => migrateGuardedPublicComparisonDatabaseV12(g.session)).toThrow();
      spy.mockRestore();
      io.mockRestore();
      expect(witnessFiles(g).map((x) => x.slice(0, 2))).toEqual(files);
      if (fault.startsWith("ddl")) {
        expect(snapshot(g.db)).toEqual(before);
        expect(() => migrateGuardedPublicComparisonDatabaseV12(g.session)).toThrow();
        expect(() => reconcilePublicComparisonStorageWitnessV2(g.session)).toThrow();
      } else {
        expect(snapshot(g.db).rows).toEqual(before.rows);
        const stateBefore = snapshot(g.db);
        expect(reconcilePublicComparisonStorageWitnessV2(g.session).repairedFilesOnly).toBe(true);
        expect(snapshot(g.db)).toEqual(stateBefore);
      }
    },
    limit,
  );
const originalWrite = journalIO.writeJournalJson;
for (const field of ["company", "expiry", "review"] as const)
  it(
    "new dispatch rejects stale " + field + " before witness intent",
    () => {
      const g = setup12(),
        i = dispatchInput(g),
        before = snapshot(g.db),
        files = witnessFiles(g);
      if (field === "company")
        g.companyDb.prepare("DELETE FROM studio_cases WHERE id=?").run(fixture.company.id);
      if (field === "expiry") i.current.at = later;
      if (field === "review")
        i.current.approvedReview = { ...i.current.approvedReview, reviewDigest: "f".repeat(64) };
      expect(() =>
        writeGuardedPublicComparisonV12(g.session, "approve-dispatch", i.command, i.current),
      ).toThrow();
      expect(snapshot(g.db)).toEqual(before);
      expect(witnessFiles(g)).toEqual(files);
    },
    limit,
  );
it(
  "bare SQL and arbitrary gate strings stay closed on new and competing connection",
  () => {
    const g = setup12();
    expect(() =>
      g.db
        .prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)")
        .run(randomUUID(), "{}", "x"),
    ).toThrow();
    const other = new DatabaseSync(g.paths.qualityFile);
    try {
      expect(() =>
        other
          .prepare("INSERT INTO quality_actual_requests(nonce,body,body_hash) VALUES(?,?,?)")
          .run(randomUUID(), "{}", "quality-v12"),
      ).toThrow();
    } finally {
      other.close();
    }
    expect(() => writeGuardedPublicComparisonV12(g.session, "settle" as never, {}, {})).toThrow();
  },
  limit,
);
it(
  "no-op COMMIT leaves pending intent and no persisted dispatch",
  () => {
    const g = setup12(),
      i = dispatchInput(g),
      before = snapshot(g.db),
      exec = g.db.exec.bind(g.db);
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql !== "COMMIT") exec(sql);
    });
    expect(() =>
      writeGuardedPublicComparisonV12(g.session, "approve-dispatch", i.command, i.current),
    ).toThrow(/COMMIT_OBSERVATION_UNKNOWN/);
    spy.mockRestore();
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);
it(
  "128 record capacity reserves remaining worst path and never grants future operation permission",
  () => {
    const g = setup12(),
      s = state12(g).reservation;
    expect(() => requireComparisonWitnessCapacity(110, 2, s)).not.toThrow();
    expect(() => requireComparisonWitnessCapacity(114, 2, s)).toThrow(/WITNESS_LIMIT/);
  },
  limit,
);
it(
  "capture bytes mismatch has no rows or witness changes",
  () => {
    const g = setup12();
    dispatch(g);
    const c = continuation(g, "capture"),
      before = snapshot(g.db),
      files = witnessFiles(g);
    expect(() =>
      writeGuardedPublicComparisonV12(g.session, "persist-capture", c, {
        at: later,
        eventId: randomUUID(),
        capture: { ...capture, id: "different" },
      }),
    ).toThrow();
    expect(snapshot(g.db)).toEqual(before);
    expect(witnessFiles(g)).toEqual(files);
  },
  limit,
);
it(
  "dispatch blocks cancellation and second dispatch; capture blocks unknown",
  () => {
    const g = setup12();
    dispatch(g);
    expect(() =>
      writeGuardedPublicComparisonV12(
        g.session,
        "cancel",
        cancelCommand(state12(g).reservation),
        cancelCurrent(),
      ),
    ).toThrow();
    expect(() => dispatch(g)).toThrow();
    save(g);
    expect(() => mark(g)).toThrow();
  },
  limit,
);

it(
  "reopened session reads canonical capture and original command with no new owner",
  () => {
    const g = setup12();
    dispatch(g);
    const c = save(g),
      before = snapshot(g.db);
    const reopened = openComparisonStorageSession(g.paths, selection);
    try {
      const r = writeGuardedPublicComparisonV12(reopened, "persist-capture", c.command, explode());
      expect(r.status).toBe("replay");
      expect(r.witnessMatched).toBe(true);
      expect(r.owner).toBeNull();
      expect(snapshot(g.db)).toEqual(before);
    } finally {
      closeComparisonStorageSession(reopened);
    }
  },
  limit,
);
it(
  "v2 single-copy read failure blocks new work, but original nonce remains structure-only",
  () => {
    const g = setup12(),
      d = dispatch(g),
      originalRead = journalIO.readJournalJson;
    const spy = vi.spyOn(journalIO, "readJournalJson").mockImplementation((file, ...args) => {
      if (String(file).includes("control")) throw Error("partial witness");
      return originalRead(file, ...args);
    });
    expect(
      writeGuardedPublicComparisonV12(g.session, "approve-dispatch", d.input.command, explode())
        .witnessMatched,
    ).toBe(false);
    expect(() => mark(g)).toThrow();
    spy.mockRestore();
  },
  limit,
);
it(
  "capture ack write failure preserves observed COMMIT; reconciliation changes files only",
  () => {
    const g = setup12();
    dispatch(g);
    const c = continuation(g, "capture"),
      count = witnessFiles(g)[0].length;
    const spy = vi
      .spyOn(journalIO, "writeJournalJson")
      .mockImplementation((file, value, ...args) => {
        if (String(file).endsWith(String(count + 1).padStart(3, "0") + ".json")) throw Error("ack");
        return originalWrite(file, value, ...args);
      });
    let error: unknown;
    try {
      writeGuardedPublicComparisonV12(g.session, "persist-capture", c, {
        at: later,
        eventId: randomUUID(),
        capture,
      });
    } catch (e) {
      error = e;
    }
    spy.mockRestore();
    expect(error).toMatchObject({ commitObserved: true, recoveryRequired: true });
    const before = snapshot(g.db);
    expect(reconcilePublicComparisonStorageWitnessV2(g.session).repairedFilesOnly).toBe(true);
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);
it(
  "transition without enrolled matching witness never changes SQL",
  () => {
    const g = guarded(false),
      before = snapshot(g.db);
    expect(() => migrateGuardedPublicComparisonDatabaseV12(g.session)).toThrow();
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);
it(
  "new dispatch rejects same-revision company text drift with no file intent",
  () => {
    const g = setup12(),
      input = dispatchInput(g),
      old = witnessFiles(g);
    const company = structuredClone(fixture.company);
    company.sources[0].text += " changed";
    g.companyDb
      .prepare("UPDATE studio_cases SET body=? WHERE id=?")
      .run(JSON.stringify(company), company.id);
    expect(() =>
      writeGuardedPublicComparisonV12(g.session, "approve-dispatch", input.command, input.current),
    ).toThrow();
    expect(witnessFiles(g)).toEqual(old);
  },
  limit,
);

for (const mutation of ["missing-binding", "sql-identity", "raw-overhead"] as const)
  it(
    "SQL12 raw reader " + mutation + " keeps strict binding and byte boundaries",
    () => {
      const g = setup12();
      dispatch(g);
      const before = state12(g),
        raw = transmissionRows.readProviderTransmissionApprovalRawDatabaseRows;
      const spy = vi
        .spyOn(transmissionRows, "readProviderTransmissionApprovalRawDatabaseRows")
        .mockImplementation((db) => {
          const rows = raw(db),
            result = structuredClone(rows);
          const native = result.bindingRows.find(
            (row: { body: string }) => JSON.parse(row.body).recordVersion === 3,
          )!;
          if (mutation === "missing-binding")
            result.bindingRows = result.bindingRows.filter(
              (row: { body: string }) => JSON.parse(row.body).recordVersion !== 3,
            );
          if (mutation === "sql-identity") native.nonce = randomUUID();
          if (mutation === "raw-overhead") native.body += " ".repeat(200);
          return result;
        });
      if (mutation === "raw-overhead") {
        const after = state12(g);
        expect(after.reservation.additionalUsedBytes).toBe(
          before.reservation.additionalUsedBytes + 200,
        );
        expect(after.transmissionBindings).toEqual(before.transmissionBindings);
      } else expect(() => state12(g)).toThrow();
      spy.mockRestore();
      expect(state12(g)).toEqual(before);
    },
    limit,
  );

it(
  "transition keeps observed DDL commit when acknowledgement rollback also fails",
  () => {
    const g = guarded(),
      exec = g.db.exec.bind(g.db);
    const spy = vi.spyOn(g.db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw Error("rollback lost");
      exec(sql);
    });
    const io = vi
      .spyOn(journalIO, "writeJournalJson")
      .mockImplementation((file, value, ...args) => {
        if (String(file).endsWith("003.json")) throw Error("ack lost");
        return originalWrite(file, value, ...args);
      });
    let caught: unknown;
    try {
      migrateGuardedPublicComparisonDatabaseV12(g.session);
    } catch (error) {
      caught = error;
    }
    try {
      expect(caught).toMatchObject({
        message: "PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED",
        commitObserved: true,
        recoveryRequired: true,
      });
      expect(g.db.isTransaction).toBe(true);
    } finally {
      spy.mockRestore();
      io.mockRestore();
      if (g.db.isTransaction) g.db.exec("ROLLBACK");
      // Same live owner can release its lease only after the SQL transaction ends.
      endComparisonStorageSession(g.session);
    }
    const before = snapshot(g.db);
    expect(reconcilePublicComparisonStorageWitnessV2(g.session).repairedFilesOnly).toBe(true);
    expect(snapshot(g.db)).toEqual(before);
  },
  limit,
);
