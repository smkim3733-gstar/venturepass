import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External IO forbidden");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      forbidden();
    }
  },
}));
vi.mock("./studio-storage", () => ({ getStudioStore: forbidden }));
import { PlanQualityStore } from "./studio-plan-quality-store";
import { createActualArtifact } from "./studio-plan-quality-actual-ledger";
import {
  actualTestNow,
  actualTestPlan,
  actualTestPreparation,
  actualTestResponse,
} from "./studio-plan-quality-actual-test-helpers";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { getPlanExecutionContract } from "./studio-engine-request-preparation";
import {
  inspectQualitySchema,
  migrateQualitySchemaV4,
  qualityLegacyTableSql,
  qualityImmutableTriggerSql,
  qualityWriterTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";
import type {
  ActualLedgerSnapshot,
  ActualLedgerStart,
} from "./studio-plan-quality-actual-ledger-types";
import type { EngineExecutionResponse } from "./studio-engine-execution-types";

let directory: string, store: PlanQualityStore;
beforeEach(() => {
  forbidden.mockClear();
  vi.stubGlobal("fetch", forbidden);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(actualTestNow));
  directory = mkdtempSync(join(tmpdir(), "venturepass-actual-store-"));
  writeFileSync(join(directory, "studio.sqlite"), "DO NOT OPEN COMPANY DATA");
  store = new PlanQualityStore(directory, { actualEnvironment: "synthetic-test" });
  store.candidateRegistryRegister({
    clientRequestId: randomUUID(),
    expectedVersion: 0,
    sourceDigest: store.candidateRegistryList().source.sourceDigest,
    acknowledgedCandidateStatus: true,
  });
}, 15000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, "studio.sqlite"), "utf8")).toBe("DO NOT OPEN COMPANY DATA");
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const path = resolve(directory),
    rel = relative(resolve(tmpdir()), path);
  if (!rel.startsWith("venturepass-actual-store-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(path, { recursive: true, force: true });
}, 15000);
function configure(capUnits = "100") {
  return store.actualBudgetConfigure({
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits },
  });
}
function input(index = 0): ActualLedgerStart {
  const budget = store.actualBudgetGet();
  const preparation = actualTestPreparation(store.candidateRegistryGet(1), {
    candidateIndex: index,
    capUnits: (BigInt(budget.capUnits) - BigInt(budget.recognizedUsageUnits)).toString(),
    heldUnits: budget.heldUnits,
    ledgerDigest: budget.headDigest!,
  });
  return {
    clientRequestId: randomUUID(),
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    expectedActualRunCount: store.actualList().executions.length,
    preparation,
    approval: {
      provenance: "synthetic-test",
      approvedPreparationDigest: preparation.preparationDigest,
      acknowledgedSyntheticOnly: true,
      approvedAt: actualTestNow,
    },
  };
}
function prepare(snapshot: ActualLedgerSnapshot) {
  const budget = store.actualBudgetGet(),
    preparation = snapshot.run.preparation;
  return store.actualRecordPrepared(snapshot.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    payload: {
      kind: "request-prepared",
      phase: "generation",
      requestDigest: preparation.requestEvidence!.generation.requestDigest,
      artifactSha256: store.actualArtifact(snapshot.run.id, "generation-request").sha256,
      inputTokenUpperBound: preparation.evidence.tokens!.generation.inputUpperBound,
      derivedFrom: null,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
  });
}
function dispatch(snapshot: ActualLedgerSnapshot) {
  const event = snapshot.events.at(-1)!;
  if (event.payload.kind !== "request-prepared") throw new Error("Missing prepared");
  const budget = store.actualBudgetGet();
  const request = {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    payload: {
      kind: "dispatch-intent" as const,
      phase: event.payload.phase,
      requestDigest: event.payload.requestDigest,
      preparedEventDigest: event.eventDigest,
      artifactSha256: event.payload.artifactSha256,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
  };
  return { request, ...store.actualRecordDispatch(snapshot.run.id, request) };
}
function respond(snapshot: ActualLedgerSnapshot, missingUsage = false, inputTokens = 1) {
  const last = snapshot.events.at(-1)!;
  if (last.payload.kind !== "dispatch-intent") throw new Error("Missing dispatch");
  const phase = last.payload.phase,
    prep = snapshot.run.preparation;
  const plan = actualTestPlan(store.candidateRegistryGet(1));
  const raw = actualTestResponse(plan, { missingUsage, inputTokens });
  const artifact = createActualArtifact({
    runId: snapshot.run.id,
    key: `${phase}-response`,
    body: JSON.stringify({ captureKind: "sdk-response-json", response: raw }),
  });
  const metadata: EngineExecutionResponse = {
    request: {
      phase,
      sequence: phase === "generation" ? 1 : 2,
      mode: "mock",
      provider: "mock",
      configuredModel: prep.model!,
      contractDigest: prep.engine.contractDigest,
      requestDigest: last.payload.requestDigest,
      inputChars: prep.requestEvidence!.generation.inputChars,
      maxOutputTokens: 16000,
    },
    responseId: raw.id,
    requestId: raw._request_id,
    responseModel: raw.model,
    status: raw.status,
    usage: missingUsage
      ? null
      : {
          inputTokens,
          outputTokens: 1,
          totalTokens: inputTokens + 1,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
        },
  };
  return store.actualRecordResponse(snapshot.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    artifact,
    payload: {
      kind: "response-received",
      phase,
      requestDigest: last.payload.requestDigest,
      dispatchEventDigest: last.eventDigest,
      artifactSha256: artifact.sha256,
      metadata,
    },
  });
}
function sql(work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
  try {
    work(db);
  } finally {
    db.close();
  }
}

describe("synthetic actual ledger storage", () => {
  it("installs exact v6 schema and blocks legacy writers without changing prior bytes", () => {
    const before = store.candidateRegistryDownload(1).body;
    sql((db) => {
      const schema = inspectQualitySchema(db);
      expect(schema.version).toBe(6);
      expect(schema.schema).toHaveLength(52);
      expect(() =>
        db
          .prepare("INSERT INTO quality_requests VALUES(?,?,?)")
          .run(randomUUID(), "{}", digest({})),
      ).toThrow(/quality_storage_contract/);
    });
    store.close();
    store = new PlanQualityStore(directory);
    expect(store.candidateRegistryDownload(1).body).toBe(before);
    expect(() => configure()).toThrowError(
      expect.objectContaining({ code: "ACTUAL_EXECUTION_DISABLED" }),
    );
  });
  it("atomically reserves cost, exact generation bytes, slots and a replayable nonce", () => {
    configure();
    const request = input(),
      started = store.actualStart(request),
      id = started.snapshot.run.id;
    expect(started).toMatchObject({
      newlyCommitted: true,
      replayed: false,
      snapshot: { state: "reserved", actualAiCalls: 0, storage: { remainingEventSlots: 32 } },
    });
    expect(store.actualBudgetGet()).toMatchObject({
      heldUnits: "4",
      recognizedUsageUnits: "0",
      availableUnits: "96",
    });
    expect(store.actualArtifact(id, "generation-request").body.toString("utf8")).toBe(
      JSON.stringify(request.preparation.requestEvidence!.generation.body),
    );
    const archive = store.actualDownload(id, 0).body;
    store.close();
    store = new PlanQualityStore(directory, { actualEnvironment: "synthetic-test" });
    expect(store.actualStart(request)).toMatchObject({
      newlyCommitted: false,
      replayed: true,
      receipt: started.receipt,
    });
    expect(store.actualLookup(request.clientRequestId)).toEqual({
      state: "committed",
      receipt: started.receipt,
    });
    expect(store.actualDownload(id, 0).body).toBe(archive);
    expect(store.actualBudgetGet().heldUnits).toBe("4");
  });
  it("rolls back every start row if receipt insertion fails", () => {
    configure();
    const request = input(),
      before = store.actualBudgetGet();
    sql((db) =>
      db.exec(
        "CREATE TRIGGER fail_actual_receipt BEFORE INSERT ON quality_actual_requests BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
      ),
    );
    expect(() => store.actualStart(request)).toThrow();
    expect(store.actualList().executions).toHaveLength(0);
    expect(store.actualBudgetGet()).toEqual(before);
    expect(store.actualLookup(request.clientRequestId)).toEqual({ state: "not-observed" });
    sql((db) => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_artifacts").get()!.n).toBe(0);
      db.exec("DROP TRIGGER fail_actual_receipt");
    });
  });
  it("rolls back received bytes and recognized usage when its durable receipt fails", () => {
    configure();
    const sent = dispatch(prepare(store.actualStart(input()).snapshot).snapshot);
    const before = store.actualBudgetGet();
    sql((db) =>
      db.exec(
        "CREATE TRIGGER fail_actual_receipt BEFORE INSERT ON quality_actual_requests BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
      ),
    );
    expect(() => respond(sent.snapshot)).toThrow();
    expect(store.actualBudgetGet()).toEqual(before);
    expect(store.actualGet(sent.snapshot.run.id).revision).toBe(sent.snapshot.revision);
    expect(() => store.actualArtifact(sent.snapshot.run.id, "generation-response")).toThrowError(
      expect.objectContaining({ code: "QUALITY_ACTUAL_ARTIFACT_NOT_FOUND" }),
    );
    sql((db) => db.exec("DROP TRIGGER fail_actual_receipt"));
  });
  it("holds space for future bytes and atomically refuses an eighth active reservation", () => {
    configure();
    for (let index = 0; index < 7; index++) store.actualStart(input(index));
    const before = store.actualBudgetGet(),
      request = input(7);
    expect(() => store.actualStart(request)).toThrowError(
      expect.objectContaining({ code: "QUALITY_STORAGE_LIMIT" }),
    );
    expect(store.actualList().executions).toHaveLength(7);
    expect(store.actualBudgetGet()).toEqual(before);
    expect(store.actualLookup(request.clientRequestId)).toEqual({ state: "not-observed" });
    sql((db) =>
      expect(db.prepare("SELECT COUNT(*) AS n FROM quality_actual_artifacts").get()!.n).toBe(7),
    );
  }, 30000);
  it("rejects stale budget CAS, overspending, duplicate bodies and all legacy nonce directions", () => {
    const configured = configure("7"),
      first = input(),
      stale = input(1);
    store.actualStart(first);
    expect(() => store.actualStart(stale)).toThrowError(
      expect.objectContaining({ code: "QUALITY_ACTUAL_VERSION_CONFLICT" }),
    );
    expect(() => store.actualStart(input(1))).toThrow();
    expect(() =>
      store.actualStart({
        ...first,
        approval: { ...first.approval, approvedAt: "2026-09-27T03:01:00.000Z" },
      }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_ACTUAL_NONCE_CONFLICT" }));
    const candidateNonce = store.candidateRegistryGet(1).clientRequestId;
    expect(() =>
      store.actualBudgetConfigure({
        clientRequestId: candidateNonce,
        expectedRevision: 2,
        policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "7" },
      }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_ACTUAL_NONCE_CONFLICT" }));
    expect(() =>
      store.create({
        clientRequestId: configured.receipt.clientRequestId,
        title: "합성 nonce 충돌",
        manifestDigest: store.list().manifestDigest,
      }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_NONCE_CONFLICT" }));
    expect(() =>
      store.candidateRegistryRegister({
        clientRequestId: first.clientRequestId,
        expectedVersion: 1,
        sourceDigest: store.candidateRegistryList().source.sourceDigest,
        acknowledgedCandidateStatus: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_CANDIDATE_NONCE_CONFLICT" }));
    const mock = store.executionPrepare(
      { version: 1, candidateId: store.candidateRegistryGet(1).entries[1].candidateId },
      getPlanExecutionContract(),
    );
    expect(() =>
      store.executionStart(
        { clientRequestId: first.clientRequestId, preparation: mock, acknowledgedMockOnly: true },
        getPlanExecutionContract(),
      ),
    ).toThrowError(expect.objectContaining({ code: "QUALITY_EXECUTION_NONCE_CONFLICT" }));
  });
  it("keeps dispatch replay and GET receipts without new transmission authority", () => {
    configure();
    const started = store.actualStart(input()),
      prepared = prepare(started.snapshot),
      sent = dispatch(prepared.snapshot);
    expect(sent.newlyCommitted).toBe(true);
    expect(store.actualRecordDispatch(sent.snapshot.run.id, sent.request)).toMatchObject({
      newlyCommitted: false,
      replayed: true,
      receipt: sent.receipt,
    });
    const looked = store.actualLookup(sent.request.clientRequestId);
    expect(looked).not.toHaveProperty("newlyCommitted");
    const current = store.actualRecordFinish(sent.snapshot.run.id, {
      clientRequestId: randomUUID(),
      expectedRevision: sent.snapshot.revision,
      payload: {
        kind: "execution-stopped",
        outcome: "result-unobserved",
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
      },
    });
    expect(current.snapshot).toMatchObject({
      state: "result-unobserved",
      costState: "held",
      sameCandidateBlocked: true,
    });
    expect(store.actualBudgetGet().heldUnits).toBe("2");
    expect(() => store.actualStart(input())).toThrowError(
      expect.objectContaining({ code: "QUALITY_ACTUAL_UNSETTLED" }),
    );
  });
  it("preserves past revision bytes after later request and other candidate reservations", () => {
    configure();
    const started = store.actualStart(input()),
      id = started.snapshot.run.id;
    const initial = store.actualDownload(id, 0).body;
    prepare(started.snapshot);
    store.actualStart(input(1));
    expect(store.actualDownload(id, 0).body).toBe(initial);
    expect(store.actualGet(id, 0).artifacts.map((v) => v.key)).toEqual(["generation-request"]);
  });
  it("records received usage before output validation and retains uncertain usage", () => {
    configure();
    const first = store.actualStart(input()),
      sent = dispatch(prepare(first.snapshot).snapshot),
      received = respond(sent.snapshot);
    expect(received.snapshot).toMatchObject({ state: "response-received", actualAiCalls: 0 });
    expect(store.actualBudgetGet()).toMatchObject({ recognizedUsageUnits: "2", heldUnits: "2" });
    const next = store.actualStart(input(1)),
      unknown = respond(dispatch(prepare(next.snapshot).snapshot).snapshot, true);
    expect(unknown.snapshot.costState).toBe("held");
    expect(store.actualBudgetGet()).toMatchObject({ recognizedUsageUnits: "2", heldUnits: "6" });
  });
  it("retains full over-budget usage and blocks every new candidate start", () => {
    configure("4");
    const started = store.actualStart(input()),
      received = respond(dispatch(prepare(started.snapshot).snapshot).snapshot, false, 12000000);
    expect(received.snapshot.costState).toBe("bound-breached");
    expect(store.actualBudgetGet()).toMatchObject({
      recognizedUsageUnits: "13",
      heldUnits: "2",
      deficitUnits: "11",
      boundBreached: true,
    });
    expect(() => store.actualStart(input(1))).toThrow();
  });
  it("rejects expired new starts and dispatches while preserving already stored replays", () => {
    configure();
    const request = input(),
      started = store.actualStart(request),
      prepared = prepare(started.snapshot);
    vi.setSystemTime(new Date("2026-09-29T00:00:00.000Z"));
    expect(store.actualStart(request).replayed).toBe(true);
    expect(() => dispatch(prepared.snapshot)).toThrowError(
      expect.objectContaining({ code: "QUALITY_ACTUAL_EVIDENCE_EXPIRED" }),
    );
    expect(() => store.actualStart(input(1))).toThrowError(
      expect.objectContaining({ code: "QUALITY_ACTUAL_EVIDENCE_EXPIRED" }),
    );
  });
  it("blocks a changed or missing pinned original instead of recording a new stage", () => {
    configure();
    const started = store.actualStart(input());
    sql((db) => {
      db.exec("DROP TRIGGER quality_actual_artifacts_no_update");
      db.prepare("UPDATE quality_actual_artifacts SET payload=? WHERE run_id=?").run(
        Buffer.from("{}"),
        started.snapshot.run.id,
      );
    });
    expect(() => store.actualGet(started.snapshot.run.id)).toThrowError(
      expect.objectContaining({ code: "QUALITY_ACTUAL_STORAGE_CORRUPT" }),
    );
  });
  it("refuses incomplete migration without repairing its missing immutable trigger", () => {
    store.close();
    const db = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    db.exec("DROP TRIGGER quality_actual_events_no_delete");
    db.close();
    expect(() => new PlanQualityStore(directory)).toThrow();
    // Restore only the synthetic test's exact missing trigger so cleanup can use a valid store.
    const repair = new DatabaseSync(join(directory, "quality-evaluation", "quality.sqlite"));
    repair.exec(qualityImmutableTriggerSql.quality_actual_events_no_delete);
    repair.close();
    store = new PlanQualityStore(directory, { actualEnvironment: "synthetic-test" });
    const isolated = new DatabaseSync(":memory:");
    try {
      for (const [name, ddl] of Object.entries(qualityLegacyTableSql).slice(0, 3)) {
        isolated.exec(ddl);
        isolated.exec(qualityImmutableTriggerSql[`${name}_no_update`]);
        isolated.exec(qualityImmutableTriggerSql[`${name}_no_delete`]);
      }
      expect(inspectQualitySchema(isolated).version).toBe(1);
      const before = isolated
        .prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
      isolated.exec("BEGIN IMMEDIATE");
      migrateQualitySchemaV4(isolated);
      expect(inspectQualitySchema(isolated).version).toBe(4);
      isolated.exec("ROLLBACK");
      expect(inspectQualitySchema(isolated).version).toBe(1);
      expect(
        isolated
          .prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
          .all(),
      ).toEqual(before);
    } finally {
      isolated.close();
    }
  });
  it.each(["QUALITY-V4", "quality- v4"])(
    "rejects a changed writer-gate string literal: %s",
    (literal) => {
      const isolated = new DatabaseSync(":memory:");
      try {
        migrateQualitySchemaV4(isolated);
        isolated.exec("DROP TRIGGER quality_runs_v4_writer");
        isolated.exec(
          qualityWriterTriggerSql.quality_runs_v4_writer.replace("'quality-v4'", `'${literal}'`),
        );
        expect(() => inspectQualitySchema(isolated)).toThrowError(
          expect.objectContaining({ code: "QUALITY_SCHEMA_UNSUPPORTED" }),
        );
      } finally {
        isolated.close();
      }
    },
  );
});
