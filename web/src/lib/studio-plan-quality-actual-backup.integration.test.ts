import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import {
  actualTestNow,
  actualTestPreparation,
  actualTestPlan,
  actualTestModel,
} from "./studio-plan-quality-actual-test-helpers";
import { executionDigest, getPlanExecutionContract } from "./studio-engine-request-preparation";
import type {
  ActualLedgerArtifact,
  ActualLedgerSnapshot,
} from "./studio-plan-quality-actual-ledger-types";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import type { EngineExecutionResponse } from "./studio-engine-execution-types";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  inspectQualityDatabase,
  verifyQualityBackup,
  restoreQualityData,
} from "../../scripts/local-data-quality.mjs";
import {
  qualityWriterTriggerSql,
  qualityV5WriterTriggerSql,
  qualityV6WriterTriggerSql,
  qualityImmutableTriggerSql,
} from "../../scripts/local-data-quality-schema.mjs";

vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("External provider forbidden");
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

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const timeout = process.platform === "win32" ? 150000 : 30000;
const sentinel = "SYNTHETIC_ACTUAL_BACKUP_COMPANY_UNTOUCHED";
let directory: string, emptyBytes: Buffer, allBytes: Buffer;
let snapshots: ActualLedgerSnapshot[], registry: CandidateRegistrySnapshot;
let oldRunId: string,
  mockId: string,
  oldArchive: string,
  mockArchive: string,
  candidateArchive: string;
let actualArchives: string[], prefixArchive: string;

// Pin this suite to the archived v4 layout even after the application writes v5.
// Only this synthetic fixture copy is reconstructed; stored record bytes stay intact.
function legacyActualDatabase(bytes: Buffer) {
  const file = join(directory, `legacy-actual-${randomUUID()}.sqlite`);
  writeFileSync(file, bytes);
  const db = new DatabaseSync(file);
  try {
    const gates = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN ('quality_runs_v5_writer','quality_runs_v6_writer')",
      )
      .get();
    if (gates) {
      const source =
        gates.name === "quality_runs_v6_writer"
          ? qualityV6WriterTriggerSql
          : qualityV5WriterTriggerSql;
      for (const name of Object.keys(source)) db.exec(`DROP TRIGGER ${name}`);
      for (const sql of Object.values(qualityWriterTriggerSql)) db.exec(sql);
    }
  } finally {
    db.close();
  }
  return readFileSync(file);
}

function artifact(
  runId: string,
  key: ActualLedgerArtifact["key"],
  value: unknown,
): ActualLedgerArtifact {
  const body = JSON.stringify(value);
  return { runId, key, body, sha256: hash(body), sizeBytes: Buffer.byteLength(body) };
}
function seedStart(store: PlanQualityStore, index: number) {
  const budget = store.actualBudgetGet();
  const preparation = actualTestPreparation(registry, {
    candidateIndex: index,
    ledgerDigest: budget.headDigest!,
    capUnits: (BigInt(budget.capUnits) - BigInt(budget.recognizedUsageUnits)).toString(),
    heldUnits: budget.heldUnits,
  });
  return store.actualStart({
    clientRequestId: randomUUID(),
    expectedBudgetRevision: budget.revision,
    expectedBudgetDigest: budget.headDigest!,
    expectedActualRunCount: store.actualList().executions.length,
    preparation,
    approval: {
      provenance: "synthetic-test",
      acknowledgedSyntheticOnly: true,
      approvedAt: actualTestNow,
      approvedPreparationDigest: preparation.preparationDigest,
    },
  }).snapshot;
}
function seedDispatch(
  store: PlanQualityStore,
  snapshot: ActualLedgerSnapshot,
  phase: "generation" | "review",
  body: unknown,
  derivedFrom: { generationEventDigest: string; artifactSha256: string } | null = null,
) {
  const preparedArtifact = artifact(snapshot.run.id, `${phase}-request`, body),
    budget = store.actualBudgetGet();
  const requestDigest = executionDigest(body);
  const prepared = store.actualRecordPrepared(snapshot.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    ...(phase === "review" ? { artifact: preparedArtifact } : {}),
    payload: {
      kind: "request-prepared",
      phase,
      requestDigest,
      artifactSha256: preparedArtifact.sha256,
      inputTokenUpperBound: phase === "generation" ? 10 : 20,
      derivedFrom,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
  }).snapshot;
  return store.actualRecordDispatch(snapshot.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: prepared.revision,
    payload: {
      kind: "dispatch-intent",
      phase,
      requestDigest,
      preparedEventDigest: prepared.events.at(-1)!.eventDigest,
      artifactSha256: preparedArtifact.sha256,
      budgetRevision: budget.revision,
      budgetDigest: budget.headDigest!,
    },
  }).snapshot;
}
function seedResponse(
  store: PlanQualityStore,
  snapshot: ActualLedgerSnapshot,
  phase: "generation" | "review",
  body: { input: { content: string }[] },
  output: unknown,
) {
  const response = {
    id: `synthetic-${phase}`,
    _request_id: `synthetic-request-${phase}`,
    model: actualTestModel,
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  };
  const saved = artifact(snapshot.run.id, `${phase}-response`, {
    captureKind: "sdk-response-json",
    response,
  });
  const metadata: EngineExecutionResponse = {
    request: {
      phase,
      sequence: phase === "generation" ? 1 : 2,
      mode: "mock",
      provider: "mock",
      configuredModel: actualTestModel,
      contractDigest: snapshot.run.preparation.engine.contractDigest,
      requestDigest: executionDigest(body),
      inputChars: body.input.reduce((sum, item) => sum + item.content.length, 0),
      maxOutputTokens: 16000,
    },
    responseId: response.id,
    requestId: response._request_id,
    responseModel: response.model,
    status: response.status,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    },
  };
  return store.actualRecordResponse(snapshot.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    artifact: saved,
    payload: {
      kind: "response-received",
      phase,
      requestDigest: metadata.request.requestDigest,
      dispatchEventDigest: snapshot.events.at(-1)!.eventDigest,
      artifactSha256: saved.sha256,
      metadata,
    },
  }).snapshot;
}
function seedValidated(
  store: PlanQualityStore,
  snapshot: ActualLedgerSnapshot,
  phase: "generation" | "review",
  body: unknown,
  output: unknown,
) {
  const saved = artifact(snapshot.run.id, `${phase}-validated`, output);
  return store.actualRecordValidated(snapshot.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: snapshot.revision,
    artifact: saved,
    payload: {
      kind: "domain-validated",
      phase,
      requestDigest: executionDigest(body),
      responseEventDigest: snapshot.events.at(-1)!.eventDigest,
      artifactSha256: saved.sha256,
      outputDigest: executionDigest(output),
    },
  }).snapshot;
}
function seedCompleted(store: PlanQualityStore) {
  let current = seedStart(store, 0);
  const generation = current.run.preparation.requestEvidence!.generation.body,
    plan = actualTestPlan(registry);
  current = seedDispatch(store, current, "generation", generation);
  current = seedResponse(store, current, "generation", generation, plan);
  current = seedValidated(store, current, "generation", generation, {
    kind: "plan",
    content: plan,
  });
  const validated = current.events.at(-1)!;
  const template = current.run.preparation.requestEvidence!.reviewTemplate;
  const review = {
    model: template.model,
    store: template.store,
    max_output_tokens: template.max_output_tokens,
    input: [
      template.systemMessage,
      { role: "user", content: JSON.stringify({ ...template.fixedUserContext, draft: plan }) },
    ],
    text: { format: template.format },
  };
  current = seedDispatch(store, current, "review", review, {
    generationEventDigest: validated.eventDigest,
    artifactSha256: artifact(current.run.id, "generation-validated", {
      kind: "plan",
      content: plan,
    }).sha256,
  });
  current = seedResponse(store, current, "review", review, { findings: [] });
  current = seedValidated(store, current, "review", review, { kind: "review", findings: [] });
  const final = artifact(current.run.id, "final-result", {
    content: plan,
    review: [],
    semanticReview: [],
    contractDigest: current.run.preparation.engine.contractDigest,
  });
  return store.actualStop(current.run.id, {
    clientRequestId: randomUUID(),
    expectedRevision: current.revision,
    artifact: final,
    payload: {
      kind: "execution-stopped",
      outcome: "completed",
      failureCode: null,
      finalArtifactSha256: final.sha256,
    },
  }).snapshot;
}

beforeAll(() => {
  vi.stubGlobal("fetch", forbidden);
  directory = mkdtempSync(join(tmpdir(), "venture-quality-actual-backup-"));
  const root = join(directory, "seed");
  mkdirSync(root);
  writeFileSync(join(root, "studio.sqlite"), sentinel);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(actualTestNow);
  const store = new PlanQualityStore(root, { actualEnvironment: "synthetic-test" });
  try {
    emptyBytes = legacyActualDatabase(
      readFileSync(join(root, "quality-evaluation", "quality.sqlite")),
    );
    registry = store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    }).snapshot;
    candidateArchive = store.candidateRegistryDownload(1).body;
    const old = store.create({
      title: "합성 actual 백업 보존",
      manifestDigest: store.list().manifestDigest,
      clientRequestId: randomUUID(),
    }).run;
    oldRunId = old.id;
    oldArchive = store.download(old.id, 0).body;
    const mock = store.executionStart(
      {
        clientRequestId: randomUUID(),
        acknowledgedMockOnly: true,
        preparation: store.executionPrepare(
          { version: 1, candidateId: registry.entries[0].candidateId },
          getPlanExecutionContract(),
        ),
      },
      getPlanExecutionContract(),
    ).snapshot;
    mockId = mock.run.id;
    mockArchive = store.executionDownload(mockId, 0).body;
    store.actualBudgetConfigure({
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      policy: { provenance: "synthetic-test", currency: "TST", unitScale: 6, capUnits: "1000000" },
    });
    const complete = seedCompleted(store);
    let unknown = seedStart(store, 1);
    unknown = seedDispatch(
      store,
      unknown,
      "generation",
      unknown.run.preparation.requestEvidence!.generation.body,
    );
    unknown = store.actualStop(unknown.run.id, {
      clientRequestId: randomUUID(),
      expectedRevision: unknown.revision,
      payload: {
        kind: "execution-stopped",
        outcome: "result-unobserved",
        failureCode: "INTERRUPTED",
        finalArtifactSha256: null,
      },
    }).snapshot;
    const reserved = seedStart(store, 2);
    snapshots = [complete, unknown, reserved];
    actualArchives = snapshots.map(
      (snapshot) => store.actualDownload(snapshot.run.id, snapshot.revision).body,
    );
    prefixArchive = store.actualDownload(complete.run.id, 4).body;
    allBytes = legacyActualDatabase(
      readFileSync(join(root, "quality-evaluation", "quality.sqlite")),
    );
  } finally {
    store.close();
    vi.useRealTimers();
  }
}, 60000);
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
});
afterAll(() => {
  vi.unstubAllGlobals();
  const target = resolve(directory),
    rel = relative(resolve(tmpdir()), target);
  if (!rel.startsWith("venture-quality-actual-backup-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(target, { recursive: true, force: true });
});
function sourceFor(bytes = allBytes) {
  const root = join(directory, randomUUID());
  mkdirSync(root);
  mkdirSync(join(root, "quality-evaluation"));
  mkdirSync(join(root, "originals"));
  writeFileSync(join(root, "quality-evaluation", "quality.sqlite"), bytes);
  writeFileSync(join(root, "studio.sqlite"), sentinel);
  writeFileSync(join(root, "originals", "keep.bin"), sentinel);
  return root;
}
function edit(root: string, work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(root, "quality-evaluation", "quality.sqlite"));
  try {
    db.function("quality_storage_contract", () => "quality-v4");
    work(db);
  } finally {
    db.close();
  }
}
function inspect(root: string) {
  const db = new DatabaseSync(join(root, "quality-evaluation", "quality.sqlite"), {
    readOnly: true,
  });
  try {
    return inspectQualityDatabase(db);
  } finally {
    db.close();
  }
}
function cli(action: string, source: string, destination?: string, success = true) {
  const result = spawnSync(
    process.execPath,
    [
      resolve("scripts/local-data.mjs"),
      action,
      "--source",
      source,
      ...(destination ? ["--destination", destination] : []),
    ],
    {
      windowsHide: true,
      timeout: 140000,
      maxBuffer: 4096,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        VENTURE_DATA_DIR: join(directory, "forbidden-root"),
        OPENAI_API_KEY: sentinel,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(sentinel);
  expect(result.stdout + result.stderr).not.toContain(directory);
  expect(existsSync(join(directory, "forbidden-root"))).toBe(false);
  expect(result.status, result.stdout + result.stderr).toBe(success ? 0 : 1);
  const resultBody = JSON.parse((success ? result.stdout : result.stderr).trim());
  expect(resultBody).toMatchObject(
    success
      ? { ok: true, companyDataChanged: false, switched: false }
      : { ok: false, completed: false, overwritten: false },
  );
  return resultBody;
}
function resealBackup(root: string, forgeLogicalDigest = false) {
  const file = readFileSync(join(root, "quality.sqlite"));
  const manifest = JSON.parse(readFileSync(join(root, "quality-backup-manifest.json"), "utf8"));
  manifest.file.sha256 = hash(file);
  manifest.file.sizeBytes = file.byteLength;
  if (forgeLogicalDigest) {
    const db = new DatabaseSync(join(root, "quality.sqlite"), { readOnly: true });
    try {
      const logical = createHash("sha256").update(
        digest(
          db
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
            )
            .all(),
        ),
      );
      for (const [name, sql] of [
        ["runs", "SELECT id,body,body_hash FROM quality_runs ORDER BY id"],
        [
          "revisions",
          "SELECT run_id,revision,body,body_hash FROM quality_revisions ORDER BY run_id,revision",
        ],
        ["receipts", "SELECT nonce,body,body_hash FROM quality_requests ORDER BY nonce"],
        [
          "candidateVersions",
          "SELECT set_id,version,body,body_hash FROM quality_candidate_versions ORDER BY set_id,version",
        ],
        [
          "candidateReceipts",
          "SELECT nonce,body,body_hash FROM quality_candidate_requests ORDER BY nonce",
        ],
        ["executionRuns", "SELECT id,body,body_hash FROM quality_execution_runs ORDER BY id"],
        [
          "executionEvents",
          "SELECT run_id,revision,body,body_hash FROM quality_execution_events ORDER BY run_id,revision",
        ],
        [
          "executionReceipts",
          "SELECT nonce,body,body_hash FROM quality_execution_requests ORDER BY nonce",
        ],
        [
          "actualBudgetEvents",
          "SELECT scope_id,revision,body,body_hash FROM quality_actual_budget_events ORDER BY scope_id,revision",
        ],
        ["actualRuns", "SELECT id,body,body_hash FROM quality_actual_runs ORDER BY id"],
        [
          "actualEvents",
          "SELECT run_id,revision,body,body_hash FROM quality_actual_events ORDER BY run_id,revision",
        ],
        [
          "actualArtifacts",
          "SELECT run_id,artifact_key,sha256,size_bytes FROM quality_actual_artifacts ORDER BY run_id,artifact_key",
        ],
        [
          "actualReceipts",
          "SELECT nonce,body,body_hash FROM quality_actual_requests ORDER BY nonce",
        ],
      ]) {
        logical.update(name).update("\0");
        for (const row of db.prepare(sql).all()) logical.update(digest(row));
      }
      manifest.logicalDigest = logical.digest("hex");
    } finally {
      db.close();
    }
  }
  const bytes = JSON.stringify(manifest, null, 2);
  writeFileSync(join(root, "quality-backup-manifest.json"), bytes);
  writeFileSync(
    join(root, "COMPLETE.json"),
    JSON.stringify({ format: "venturepass-quality-backup-complete", manifestSha256: hash(bytes) }),
  );
}
function mutateJson(
  db: DatabaseSync,
  table: string,
  change: (value: Record<string, unknown>) => void,
  reseal = true,
  selection = "ORDER BY rowid LIMIT 1",
) {
  const row = db.prepare(`SELECT rowid,body FROM ${table} ${selection}`).get()!;
  const value = JSON.parse(String(row.body));
  change(value);
  db.exec(`DROP TRIGGER ${table}_no_update`);
  try {
    if (reseal)
      db.prepare(`UPDATE ${table} SET body=?,body_hash=? WHERE rowid=?`).run(
        JSON.stringify(value),
        digest(value),
        row.rowid,
      );
    else
      db.prepare(`UPDATE ${table} SET body=? WHERE rowid=?`).run(JSON.stringify(value), row.rowid);
  } finally {
    db.exec(qualityImmutableTriggerSql[`${table}_no_update`]);
  }
}
function mutateArtifact(db: DatabaseSync, change: (bytes: Buffer) => Buffer, reseal = true) {
  const row = db
    .prepare(
      "SELECT rowid,payload FROM quality_actual_artifacts WHERE artifact_key='generation-request' ORDER BY rowid LIMIT 1",
    )
    .get()!;
  const bytes = change(Buffer.from(row.payload as Uint8Array));
  db.exec("DROP TRIGGER quality_actual_artifacts_no_update");
  try {
    if (reseal)
      db.prepare(
        "UPDATE quality_actual_artifacts SET payload=?,sha256=?,size_bytes=? WHERE rowid=?",
      ).run(bytes, hash(bytes), bytes.byteLength, row.rowid);
    else
      db.prepare("UPDATE quality_actual_artifacts SET payload=? WHERE rowid=?").run(
        bytes,
        row.rowid,
      );
  } finally {
    db.exec(qualityImmutableTriggerSql.quality_actual_artifacts_no_update);
  }
}

describe("actual ledger v4 backup", () => {
  it("inspects an empty v4 database without registering a writer capability", () => {
    expect(inspect(sourceFor(emptyBytes))).toMatchObject({
      runs: 0,
      revisions: 0,
      requests: 0,
      candidateVersions: 0,
      candidateRequests: 0,
      executionRuns: 0,
      executionEvents: 0,
      executionRequests: 0,
      actualBudgetEvents: 0,
      actualRuns: 0,
      actualEvents: 0,
      actualArtifacts: 0,
      actualRequests: 0,
    });
  });
  it.each(["table", "gate", "immutable trigger", "unknown table"])(
    "rejects partial v4 schema: %s",
    (kind) => {
      const root = sourceFor(emptyBytes);
      edit(root, (db) => {
        if (kind === "table") db.exec("DROP TABLE quality_actual_events");
        if (kind === "gate") db.exec("DROP TRIGGER quality_requests_v4_writer");
        if (kind === "immutable trigger")
          db.exec("DROP TRIGGER quality_actual_artifacts_no_update");
        if (kind === "unknown table") db.exec("CREATE TABLE hidden_actual_data (body TEXT)");
      });
      expect(() => inspect(root)).toThrow();
    },
  );
  it("documents complete v4 erasure as indistinguishable legacy reconstruction, not authenticated history", () => {
    const root = sourceFor(emptyBytes);
    edit(root, (db) => {
      for (const name of Object.keys(qualityWriterTriggerSql)) db.exec(`DROP TRIGGER ${name}`);
      for (const name of [
        "quality_actual_events",
        "quality_actual_artifacts",
        "quality_actual_requests",
        "quality_actual_runs",
        "quality_actual_budget_events",
      ])
        db.exec(`DROP TABLE ${name}`);
    });
    const snapshot = inspect(root);
    expect(snapshot).not.toHaveProperty("actualRuns");
    expect(snapshot).toMatchObject({ executionRuns: 0, executionEvents: 0, executionRequests: 0 });
  });
  it.each([
    "body hash",
    "unknown body field",
    "actual AI promotion",
    "run id",
    "reservation bytes",
  ])("rejects altered actual row: %s", (kind) => {
    const root = sourceFor();
    edit(root, (db) =>
      mutateJson(
        db,
        "quality_actual_runs",
        (value) => {
          if (kind === "body hash") value.recordedAt = "2026-09-20T00:00:00.000Z";
          if (kind === "unknown body field") value.unreviewedConsent = true;
          if (kind === "actual AI promotion") value.actualAiCalls = 1;
          if (kind === "run id") value.id = randomUUID();
          if (kind === "reservation bytes") value.storageReservationBytes = 0;
          const { runDigest: ignored, ...payload } = value;
          void ignored;
          value.runDigest = digest(payload);
        },
        kind !== "body hash",
      ),
    );
    expect(() => inspect(root)).toThrow();
  });
  it.each(["raw SHA", "model", "invalid UTF8", "invalid JSON", "truncated body"])(
    "rejects altered artifact: %s",
    (kind) => {
      const root = sourceFor();
      edit(root, (db) =>
        mutateArtifact(
          db,
          (bytes) => {
            if (kind === "invalid UTF8") return Buffer.from([255]);
            if (kind === "invalid JSON") return Buffer.from("{");
            if (kind === "truncated body") return bytes.subarray(0, bytes.length - 4);
            const value = JSON.parse(bytes.toString("utf8"));
            value.model = "unapproved-other-model";
            return Buffer.from(JSON.stringify(value));
          },
          kind !== "raw SHA",
        ),
      );
      expect(() => inspect(root)).toThrow();
    },
  );
  it.each(["size", "SQL type", "receipt", "budget chain"])(
    "rejects orphaned or inconsistent preserved data: %s",
    (kind) => {
      const root = sourceFor();
      edit(root, (db) => {
        if (kind === "size" || kind === "SQL type") {
          db.exec("DROP TRIGGER quality_actual_artifacts_no_update");
          db.exec(
            kind === "size"
              ? "UPDATE quality_actual_artifacts SET size_bytes=size_bytes+1"
              : "UPDATE quality_actual_artifacts SET payload=CAST(payload AS TEXT)",
          );
          db.exec(qualityImmutableTriggerSql.quality_actual_artifacts_no_update);
        } else {
          const table =
            kind === "receipt" ? "quality_actual_requests" : "quality_actual_budget_events";
          db.exec(`DROP TRIGGER ${table}_no_delete`);
          db.exec(`DELETE FROM ${table} WHERE rowid=(SELECT MIN(rowid) FROM ${table})`);
          db.exec(qualityImmutableTriggerSql[`${table}_no_delete`]);
        }
      });
      expect(() => inspect(root)).toThrow();
    },
  );
  it("rejects a pre-load actual row count overflow", () => {
    const root = sourceFor(emptyBytes);
    edit(root, (db) => {
      const insert = db.prepare(
        "INSERT INTO quality_actual_runs (id,body,body_hash) VALUES(?,?,?)",
      );
      for (let index = 0; index < 21; index++) insert.run(randomUUID(), "{}", digest({}));
    });
    expect(() => inspect(root)).toThrow();
  });
  it.each(["policy input digest", "event input digest", "event kind", "event budget head"])(
    "rejects rehashed receipt forgery: %s",
    (kind) => {
      const root = sourceFor();
      edit(root, (db) =>
        mutateJson(
          db,
          "quality_actual_requests",
          (value) => {
            if (kind === "event kind") value.kind = "actual-stop";
            else if (kind === "event budget head")
              value.budgetRevision = Number(value.budgetRevision) + 1;
            else value.inputDigest = "a".repeat(64);
          },
          true,
          kind === "policy input digest"
            ? "WHERE json_extract(body,'$.kind')='actual-budget-configure' LIMIT 1"
            : "WHERE json_extract(body,'$.kind')='actual-prepare' LIMIT 1",
        ),
      );
      expect(() => inspect(root)).toThrow();
    },
  );
  it.each(["empty", "recorded"])(
    "CLI roundtrip preserves %s v4 and historical archives with existing company data untouched",
    (kind) => {
      const source = sourceFor(kind === "empty" ? emptyBytes : allBytes),
        backup = join(directory, randomUUID()),
        target = join(directory, randomUUID());
      const { digest: ignored, storageVersion, ...counts } = inspect(source);
      void ignored;
      expect(storageVersion).toBe(4);
      const before = readFileSync(join(source, "quality-evaluation", "quality.sqlite"));
      mkdirSync(target);
      writeFileSync(join(target, "studio.sqlite"), sentinel);
      mkdirSync(join(target, "originals"));
      writeFileSync(join(target, "originals", "keep.bin"), sentinel);
      expect(cli("quality-backup", source, backup)).toMatchObject(counts);
      expect(cli("quality-verify", backup)).toMatchObject(counts);
      expect(verifyQualityBackup(backup).manifest).toMatchObject({ version: 4, ...counts });
      expect(cli("quality-restore", backup, target)).toMatchObject(counts);
      expect(readFileSync(join(source, "quality-evaluation", "quality.sqlite"))).toEqual(before);
      expect(readFileSync(join(target, "quality-evaluation", "quality.sqlite"))).toEqual(
        readFileSync(join(backup, "quality.sqlite")),
      );
      for (const root of [source, target]) {
        expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(sentinel);
        expect(readFileSync(join(root, "originals", "keep.bin"), "utf8")).toBe(sentinel);
        expect(existsSync(join(root, "quality-evaluation", ".restore-pending"))).toBe(false);
      }
      const restored = new PlanQualityStore(target);
      try {
        if (kind === "recorded") {
          expect(restored.download(oldRunId, 0).body).toBe(oldArchive);
          expect(restored.candidateRegistryDownload(1).body).toBe(candidateArchive);
          expect(restored.executionDownload(mockId, 0).body).toBe(mockArchive);
          snapshots.forEach((snapshot, index) =>
            expect(restored.actualDownload(snapshot.run.id, snapshot.revision).body).toBe(
              actualArchives[index],
            ),
          );
          expect(restored.actualDownload(snapshots[0].run.id, 4).body).toBe(prefixArchive);
          expect(restored.actualGet(snapshots[1].run.id).costState).toBe("held");
          expect(restored.actualGet(snapshots[1].run.id).canResume).toBe(false);
        }
      } finally {
        restored.close();
      }
      const preserved = readFileSync(join(target, "quality-evaluation", "quality.sqlite"));
      expect(() => restoreQualityData(backup, target)).toThrow();
      expect(readFileSync(join(target, "quality-evaluation", "quality.sqlite"))).toEqual(preserved);
      if (kind === "recorded") {
        const db = new DatabaseSync(join(backup, "quality.sqlite"));
        try {
          mutateArtifact(db, (bytes) => {
            const request = JSON.parse(bytes.toString("utf8"));
            request.model = "forged-model";
            return Buffer.from(JSON.stringify(request));
          });
        } finally {
          db.close();
        }
        resealBackup(backup, true);
        expect(() => verifyQualityBackup(backup)).toThrow();
      }
    },
    timeout,
  );
  it("reads historical artifacts after evidence expiration without reinterpreting them as fresh approval", () => {
    const root = sourceFor();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2035-01-01T00:00:00.000Z");
    const store = new PlanQualityStore(root);
    try {
      expect(inspect(root)).toMatchObject({ actualRuns: 3 });
      snapshots.forEach((snapshot, index) =>
        expect(store.actualDownload(snapshot.run.id, snapshot.revision).body).toBe(
          actualArchives[index],
        ),
      );
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });
});
