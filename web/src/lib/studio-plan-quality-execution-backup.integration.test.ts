import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { freezePolicyFreeSchema } from "./studio-plan-quality-policy-storage-test-helpers";
import { getPlanExecutionContract } from "./studio-engine";
import { runQualityMockExecution } from "./studio-plan-quality-execution-runner";
import { createQualityExecutionPreparation } from "./studio-plan-quality-execution";
import {
  qualityExecutionEventDigestInput,
  qualityExecutionPreparationDigestInput,
  qualityExecutionRequestDigestInput,
  qualityExecutionRunDigestInput,
  type QualityExecutionEvent,
  type QualityExecutionRun,
  type QualityExecutionSnapshot,
} from "./studio-plan-quality-execution-types";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { inspectQualityDatabase } from "../../scripts/local-data-quality.mjs";

vi.mock("server-only", () => ({}));

const tables = ["quality_execution_runs", "quality_execution_events", "quality_execution_requests"];
const timeout = process.platform === "win32" ? 150000 : 30000;
const secret = "SYNTHETIC_EXECUTION_BACKUP_SENTINEL";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const external = vi.fn(() => {
  throw new Error("External calls forbidden");
});
let directory: string, emptyBytes: Buffer, allBytes: Buffer, candidate: CandidateRegistrySnapshot;
let oldRunId: string, oldRunNonce: string, oldArchive: string, candidateArchive: string;
let snapshots: QualityExecutionSnapshot[], executionArchives: string[], prefixArchive: string;

// Fixture-only v3 reconstruction, not proof that completely erased v4 history is detectable.
function legacyExecutionDatabase(bytes: Buffer) {
  const file = join(directory, `legacy-execution-${randomUUID()}.sqlite`);
  writeFileSync(file, bytes);
  const db = new DatabaseSync(file);
  try {
    freezePolicyFreeSchema(db, 3);
  } finally {
    db.close();
  }
  return readFileSync(file);
}

beforeAll(async () => {
  vi.stubGlobal("fetch", external);
  directory = mkdtempSync(join(tmpdir(), "venture-quality-execution-backup-"));
  const root = join(directory, "seed");
  mkdirSync(root);
  writeFileSync(join(root, "studio.sqlite"), secret);
  const store = new PlanQualityStore(root),
    file = join(root, "quality-evaluation", "quality.sqlite");
  try {
    emptyBytes = legacyExecutionDatabase(readFileSync(file));
    candidate = store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: store.candidateRegistryList().source.sourceDigest,
      acknowledgedCandidateStatus: true,
    }).snapshot;
    candidateArchive = store.candidateRegistryDownload(1).body;
    const oldRun = store.create({
      title: "합성 평가 및 실행 백업",
      clientRequestId: randomUUID(),
      manifestDigest: store.list().manifestDigest,
    }).run;
    oldRunId = oldRun.id;
    oldRunNonce = oldRun.clientRequestId;
    store.save(oldRun.id, {
      revision: 0,
      clientRequestId: randomUUID(),
      record: oldRun.records[0],
    });
    oldArchive = store.download(oldRun.id, 1).body;
    const start = (index: number) => {
      const contract = getPlanExecutionContract();
      return store.executionStart(
        {
          clientRequestId: randomUUID(),
          acknowledgedMockOnly: true,
          preparation: store.executionPrepare(
            { version: 1, candidateId: candidate.entries[index].candidateId },
            contract,
          ),
        },
        contract,
      ).snapshot;
    };
    const completed = await runQualityMockExecution(store, start(0));
    expect(completed.state).toBe("completed");
    let failed = start(1);
    failed = store.executionAppend(failed.run.id, 0, {
      kind: "finished",
      outcome: "failed",
      failureCode: "ENGINE_FAILED",
      result: null,
    });
    let unknown = start(2);
    const dispatch = completed.events[0].payload;
    expect(dispatch.kind).toBe("dispatch");
    unknown = store.executionAppend(unknown.run.id, 0, dispatch);
    unknown = store.executionAppend(unknown.run.id, 1, {
      kind: "finished",
      outcome: "unknown",
      failureCode: "INTERRUPTED",
      result: null,
    });
    let interrupted = start(3);
    interrupted = store.executionAppend(interrupted.run.id, 0, dispatch);
    const authorized = start(4);
    snapshots = [completed, failed, unknown, interrupted, authorized];
    executionArchives = snapshots.map(
      (snapshot) => store.executionDownload(snapshot.run.id, snapshot.revision).body,
    );
    prefixArchive = store.executionDownload(completed.run.id, 3).body;
    allBytes = legacyExecutionDatabase(readFileSync(file));
    expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(secret);
  } finally {
    store.close();
  }
}, 60000);
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
});
afterAll(() => {
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-quality-execution-backup-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});
function sourceFor(bytes = allBytes) {
  const root = join(directory, randomUUID());
  mkdirSync(root);
  mkdirSync(join(root, "quality-evaluation"));
  writeFileSync(join(root, "quality-evaluation", "quality.sqlite"), bytes);
  writeFileSync(join(root, "studio.sqlite"), secret);
  mkdirSync(join(root, "originals"));
  writeFileSync(join(root, "originals", "keep.bin"), secret);
  return root;
}
function edit(root: string, work: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(root, "quality-evaluation", "quality.sqlite"));
  try {
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
function trigger(table: string, action: "update" | "delete") {
  return `CREATE TRIGGER ${table}_no_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable'); END`;
}
function replaceRun(db: DatabaseSync, id: string, mutate: (value: QualityExecutionRun) => void) {
  const run = JSON.parse(
    String(db.prepare("SELECT body FROM quality_execution_runs WHERE id=?").get(id)!.body),
  ) as QualityExecutionRun;
  const oldNonce = run.clientRequestId;
  mutate(run);
  run.preparation.planDigest = digest(qualityExecutionPreparationDigestInput(run.preparation));
  run.inputDigest = digest(
    qualityExecutionRequestDigestInput({
      clientRequestId: run.clientRequestId,
      preparation: run.preparation,
      acknowledgedMockOnly: true,
    }),
  );
  run.runDigest = digest(qualityExecutionRunDigestInput(run));
  const receipt = {
    kind: "start-candidate-execution",
    executionId: run.id,
    clientRequestId: run.clientRequestId,
    inputDigest: run.inputDigest,
    runDigest: run.runDigest,
    planDigest: run.preparation.planDigest,
  };
  db.exec(
    "DROP TRIGGER quality_execution_runs_no_update; DROP TRIGGER quality_execution_requests_no_update",
  );
  db.prepare("UPDATE quality_execution_runs SET body=?,body_hash=? WHERE id=?").run(
    JSON.stringify(run),
    digest(run),
    id,
  );
  db.prepare("UPDATE quality_execution_requests SET nonce=?,body=?,body_hash=? WHERE nonce=?").run(
    run.clientRequestId,
    JSON.stringify(receipt),
    digest(receipt),
    oldNonce,
  );
  db.exec(trigger(tables[0], "update"));
  db.exec(trigger(tables[2], "update"));
}
function replaceEvents(
  db: DatabaseSync,
  id: string,
  mutate: (events: QualityExecutionEvent[]) => void,
) {
  const events = db
    .prepare("SELECT body FROM quality_execution_events WHERE run_id=? ORDER BY revision")
    .all(id)
    .map((row) => JSON.parse(String(row.body)) as QualityExecutionEvent);
  mutate(events);
  db.exec("DROP TRIGGER quality_execution_events_no_update");
  for (const [index, event] of events.entries()) {
    event.previousEventDigest = events[index - 1]?.eventDigest ?? null;
    event.eventDigest = digest(qualityExecutionEventDigestInput(event));
    db.prepare(
      "UPDATE quality_execution_events SET body=?,body_hash=? WHERE run_id=? AND revision=?",
    ).run(JSON.stringify(event), digest(event), id, index + 1);
  }
  db.exec(trigger(tables[1], "update"));
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
      timeout: 110000,
      maxBuffer: 4096,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        OPENAI_API_KEY: secret,
        VENTURE_DATA_DIR: join(directory, "must-not-read"),
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(directory);
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(existsSync(join(directory, "must-not-read"))).toBe(false);
  expect(result.status, result.stdout + result.stderr).toBe(success ? 0 : 1);
  const value = JSON.parse((success ? result.stdout : result.stderr).trim());
  expect(value).toMatchObject(
    success
      ? {
          ok: true,
          companyDataChanged: false,
          switched: false,
          scope: "quality-records-structure-and-bytes-only",
        }
      : { ok: false, completed: false, overwritten: false },
  );
  return value;
}
function target() {
  const root = join(directory, randomUUID());
  mkdirSync(root);
  writeFileSync(join(root, "studio.sqlite"), secret);
  return root;
}
function assertCompany(root: string) {
  expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(secret);
  if (existsSync(join(root, "originals")))
    expect(readFileSync(join(root, "originals", "keep.bin"), "utf8")).toBe(secret);
}

describe("execution archive v3", () => {
  it.each(["empty", "recorded"] as const)(
    "round trips %s eight-table records preserving interrupted states and all historical bytes",
    (kind) => {
      const source = sourceFor(kind === "empty" ? emptyBytes : allBytes),
        backup = join(directory, randomUUID()),
        destination = target();
      const count = kind === "empty" ? 0 : 5;
      const counts = {
        executionRuns: count,
        executionEvents: kind === "empty" ? 0 : 11,
        executionRequests: count,
      };
      const before = readFileSync(join(source, "quality-evaluation", "quality.sqlite"));
      expect(cli("quality-backup", source, backup)).toMatchObject(counts);
      const manifest = JSON.parse(
        readFileSync(join(backup, "quality-backup-manifest.json"), "utf8"),
      );
      expect(manifest).toMatchObject({ version: 3, ...counts });
      expect(cli("quality-verify", backup)).toMatchObject(counts);
      expect(cli("quality-restore", backup, destination)).toMatchObject(counts);
      expect(readFileSync(join(source, "quality-evaluation", "quality.sqlite"))).toEqual(before);
      expect(readFileSync(join(destination, "quality-evaluation", "quality.sqlite"))).toEqual(
        readFileSync(join(backup, "quality.sqlite")),
      );
      const restored = new PlanQualityStore(destination);
      try {
        expect(restored.executionList().executions).toHaveLength(count);
        if (count) {
          expect(restored.download(oldRunId, 1).body).toBe(oldArchive);
          expect(restored.candidateRegistryDownload(1).body).toBe(candidateArchive);
          for (const [index, snapshot] of snapshots.entries()) {
            expect(restored.executionGet(snapshot.run.id)).toEqual(snapshot);
            expect(restored.executionDownload(snapshot.run.id, snapshot.revision).body).toBe(
              executionArchives[index],
            );
            expect(restored.executionLookup(snapshot.run.clientRequestId)).toMatchObject({
              state: "committed",
              receipt: { executionId: snapshot.run.id },
            });
            expect(snapshot).toMatchObject({
              actualAiCalls: 0,
              canResume: false,
              cost: { actualCharge: 0, actualAiAllowed: false },
            });
          }
          expect(restored.executionDownload(snapshots[0].run.id, 3).body).toBe(prefixArchive);
        }
      } finally {
        restored.close();
      }
      assertCompany(source);
      assertCompany(destination);
    },
    timeout,
  );

  it(
    "rejects resealed actual-AI claims before restore and never replaces a company database",
    () => {
      const source = sourceFor(),
        backup = join(directory, randomUUID()),
        destination = target();
      cli("quality-backup", source, backup);
      const db = new DatabaseSync(join(backup, "quality.sqlite"));
      try {
        replaceRun(db, snapshots[0].run.id, (run) => {
          Object.assign(run.preparation, { mode: "actual-ai", provider: "OpenAI" });
        });
      } finally {
        db.close();
      }
      const file = readFileSync(join(backup, "quality.sqlite"));
      const manifestPath = join(backup, "quality-backup-manifest.json"),
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.file.sha256 = hash(file);
      manifest.file.sizeBytes = file.length;
      const bytes = Buffer.from(JSON.stringify(manifest));
      writeFileSync(manifestPath, bytes);
      writeFileSync(
        join(backup, "COMPLETE.json"),
        JSON.stringify({
          format: "venturepass-quality-backup-complete",
          manifestSha256: hash(bytes),
        }),
      );
      expect(cli("quality-verify", backup, undefined, false).code).toBe("QUALITY_DATABASE_INVALID");
      expect(cli("quality-restore", backup, destination, false).code).toBe(
        "QUALITY_DATABASE_INVALID",
      );
      expect(readdirSync(destination)).toEqual(["studio.sqlite"]);
      assertCompany(source);
      assertCompany(destination);
    },
    timeout,
  );
});

describe("execution archive integrity", () => {
  it.each([
    [
      "actual promotion",
      (run: QualityExecutionRun) => {
        Object.assign(run.preparation, { mode: "actual-ai", provider: "OpenAI" });
      },
    ],
    [
      "real charge",
      (run: QualityExecutionRun) => {
        Object.assign(run.preparation.cost, { actualCharge: 1 });
      },
    ],
    [
      "actual approval",
      (run: QualityExecutionRun) => {
        Object.assign(run.preparation.cost, { actualAiAllowed: true });
      },
    ],
    [
      "quality claim",
      (run: QualityExecutionRun) => {
        Object.assign(run.preparation, { performanceEvaluation: "passed" });
      },
    ],
    [
      "foreign version",
      (run: QualityExecutionRun) => {
        run.preparation.versionDigest = "0".repeat(64);
      },
    ],
    [
      "different source",
      (run: QualityExecutionRun) => {
        run.preparation.modelInputDigest = "0".repeat(64);
      },
    ],
    [
      "model scope",
      (run: QualityExecutionRun) => {
        Object.assign(run.preparation, { model: "another-model" });
      },
    ],
    [
      "old evaluation nonce",
      (run: QualityExecutionRun) => {
        run.clientRequestId = oldRunNonce;
      },
    ],
    [
      "candidate nonce",
      (run: QualityExecutionRun) => {
        run.clientRequestId = candidate.clientRequestId;
      },
    ],
    [
      "duplicate CAS index",
      (run: QualityExecutionRun) => {
        run.preparation.expectedRunCount = 0;
      },
    ],
  ])("rejects resealed run: %s", (_label, mutate) => {
    const root = sourceFor();
    edit(root, (db) =>
      replaceRun(db, snapshots[4].run.id, mutate as (run: QualityExecutionRun) => void),
    );
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });

  it.each([
    "incomplete response",
    "foreign response",
    "changed output",
    "out of order",
    "wrong execution",
    "false completion",
    "final content rewrite",
    "actual dispatch",
  ])("rejects resealed events: %s", (kind) => {
    const root = sourceFor();
    edit(root, (db) =>
      replaceEvents(db, snapshots[0].run.id, (events) => {
        if (kind === "incomplete response" && events[1].payload.kind === "response")
          events[1].payload.response.status = "incomplete";
        if (kind === "foreign response" && events[1].payload.kind === "response")
          events[1].payload.response.request.requestDigest = "0".repeat(64);
        if (
          kind === "changed output" &&
          events[2].payload.kind === "validated" &&
          events[2].payload.validated.output.kind === "plan"
        )
          events[2].payload.validated.output.content.title = "바뀐 합성 출력";
        if (kind === "out of order" && events[0].payload.kind === "dispatch") {
          events[0].payload.request.sequence = 2;
          events[0].payload.request.phase = "review";
        }
        if (kind === "actual dispatch" && events[0].payload.kind === "dispatch")
          Object.assign(events[0].payload.request, { mode: "actual-ai", provider: "OpenAI" });
        if (kind === "wrong execution") events[1].executionId = snapshots[1].run.id;
        if (kind === "false completion")
          events[0].payload = {
            kind: "finished",
            outcome: "completed",
            failureCode: null,
            result: null,
          };
        if (
          kind === "final content rewrite" &&
          events[6].payload.kind === "finished" &&
          events[6].payload.result
        )
          events[6].payload.result.content.sections[0].content = "합성 원고 바꿔치기";
      }),
    );
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });

  it("rejects starting the same candidate while its prior result remains unknown, but permits different candidates", () => {
    const root = sourceFor();
    expect(inspect(root)).toMatchObject({ executionRuns: 5 });
    edit(root, (db) =>
      replaceRun(db, snapshots[4].run.id, (run) => {
        run.preparation = createQualityExecutionPreparation(
          candidate,
          snapshots[3].run.preparation.candidateId,
          run.preparation.engine,
          4,
        );
      }),
    );
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });

  it.each([
    "missing receipt",
    "orphan receipt",
    "broken row hash",
    "missing trigger",
    "partial schema",
    "event cap",
    "run cap",
  ])("rejects %s", (kind) => {
    const root = sourceFor();
    edit(root, (db) => {
      if (kind === "missing receipt") {
        db.exec("DROP TRIGGER quality_execution_requests_no_delete");
        db.prepare("DELETE FROM quality_execution_requests WHERE nonce=?").run(
          snapshots[4].run.clientRequestId,
        );
        db.exec(trigger(tables[2], "delete"));
      }
      if (kind === "orphan receipt")
        db.prepare("INSERT INTO quality_execution_requests VALUES(?,?,?)").run(
          randomUUID(),
          "{}",
          digest({}),
        );
      if (kind === "broken row hash") {
        db.exec("DROP TRIGGER quality_execution_runs_no_update");
        db.prepare("UPDATE quality_execution_runs SET body_hash='bad' WHERE id=?").run(
          snapshots[4].run.id,
        );
        db.exec(trigger(tables[0], "update"));
      }
      if (kind === "missing trigger") db.exec("DROP TRIGGER quality_execution_events_no_update");
      if (kind === "partial schema") db.exec("DROP TABLE quality_execution_events");
      if (kind === "event cap")
        for (let revision = 8; revision <= 148; revision++)
          db.prepare("INSERT INTO quality_execution_events VALUES(?,?,?,?)").run(
            snapshots[0].run.id,
            revision,
            "{}",
            digest({}),
          );
      if (kind === "run cap")
        for (let index = 0; index < 16; index++) {
          db.prepare("INSERT INTO quality_execution_runs VALUES(?,?,?)").run(
            randomUUID(),
            "{}",
            digest({}),
          );
          db.prepare("INSERT INTO quality_execution_requests VALUES(?,?,?)").run(
            randomUUID(),
            "{}",
            digest({}),
          );
        }
    });
    expect(() => inspect(root)).toThrow();
  });

  it("preserves observed model differences and unknown usage rather than inventing billing or ordering by wall clock", () => {
    const root = sourceFor();
    edit(root, (db) =>
      replaceEvents(db, snapshots[0].run.id, (events) => {
        for (const event of events) {
          event.recordedAt = "2000-01-01T00:00:00.000Z";
          if (event.payload.kind === "response") {
            event.payload.response.responseModel = "synthetic-provider-reported-model";
            event.payload.response.usage = null;
          }
        }
      }),
    );
    expect(inspect(root)).toMatchObject({
      executionRuns: 5,
      executionEvents: 11,
      executionRequests: 5,
    });
  });

  it.each([
    ["quality_execution_runs", 32 * 1024],
    ["quality_execution_events", 1024 * 1024],
    ["quality_execution_requests", 4096],
  ] as const)("rejects oversized %s bodies with otherwise unchanged JSON hashes", (table, cap) => {
    const root = sourceFor();
    edit(root, (db) => {
      const row = db.prepare(`SELECT rowid,body FROM ${table} LIMIT 1`).get()!;
      db.exec(`DROP TRIGGER ${table}_no_update`);
      db.prepare(`UPDATE ${table} SET body=? WHERE rowid=?`).run(
        String(row.body).padEnd(cap + 1, " "),
        row.rowid,
      );
      db.exec(trigger(table, "update"));
    });
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });
});
