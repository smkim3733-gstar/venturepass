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
import * as registry from "./studio-plan-quality-candidate-registry";
import {
  candidateRegistryRequestDigestInput,
  candidateRegistrySourceSchema,
  type CandidateRegistrySnapshot,
} from "./studio-plan-quality-candidate-registry-types";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { inspectQualityDatabase, verifyQualityBackup } from "../../scripts/local-data-quality.mjs";

const candidateTables = ["quality_candidate_versions", "quality_candidate_requests"];
// Pin pre-execution schemas rather than following the current store's migrations.
function legacyCandidateDatabase(bytes: Buffer) {
  const file = join(directory, `legacy-candidate-${randomUUID()}.sqlite`);
  writeFileSync(file, bytes);
  const db = new DatabaseSync(file);
  try {
    // Fixture-only legacy reconstruction. This is not detection of erased v4 history.
    for (const row of db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='trigger' AND (name LIKE '%_v4_writer' OR name LIKE '%_v5_writer' OR name LIKE '%_v6_writer')",
      )
      .all())
      db.exec(`DROP TRIGGER ${row.name}`);
    for (const table of [
      "quality_actual_events",
      "quality_actual_artifacts",
      "quality_actual_requests",
      "quality_actual_runs",
      "quality_actual_budget_events",
      "quality_execution_events",
      "quality_execution_requests",
      "quality_execution_runs",
    ])
      db.exec(`DROP TABLE IF EXISTS ${table}`);
  } finally {
    db.close();
  }
  return readFileSync(file);
}
const secret = "SYNTHETIC_CANDIDATE_BACKUP_SENTINEL";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const timeout = process.platform === "win32" ? 150000 : 30000;
let directory: string, emptyBytes: Buffer, candidateBytes: Buffer, combinedBytes: Buffer;
let runId: string, runNonce: string, oldExport: string, candidateExports: string[];
let versions: CandidateRegistrySnapshot[];
const external = vi.fn(() => {
  throw new Error("External calls forbidden in synthetic backup tests");
});

beforeAll(() => {
  vi.stubGlobal("fetch", external);
  directory = mkdtempSync(join(tmpdir(), "venture-quality-candidates-backup-"));
  const root = join(directory, "seed");
  mkdirSync(root);
  writeFileSync(join(root, "studio.sqlite"), secret);
  const store = new PlanQualityStore(root);
  const file = join(root, "quality-evaluation", "quality.sqlite");
  try {
    emptyBytes = legacyCandidateDatabase(readFileSync(file));
    const firstSource = store.candidateRegistryList().source;
    const first = store.candidateRegistryRegister({
      expectedVersion: 0,
      clientRequestId: randomUUID(),
      sourceDigest: firstSource.sourceDigest,
      acknowledgedCandidateStatus: true,
    }).snapshot;
    // Simulate a later bundled synthetic source, never a user-supplied company document.
    const entries = structuredClone(firstSource.entries);
    entries[0].reviewerMetadata.authoringNotes.push("합성 시험 전용 후속 작성 메모");
    const manifest = registry.candidateRegistryManifest(entries);
    const source = candidateRegistrySourceSchema.parse({
      ...firstSource,
      entries,
      manifest,
      sourceDigest: registry.candidateRegistrySourceDigest(entries),
      manifestDigest: digest(manifest),
    });
    const spy = vi.spyOn(registry, "createCandidateRegistrySource").mockReturnValue(source);
    try {
      const second = store.candidateRegistryRegister({
        expectedVersion: 1,
        clientRequestId: randomUUID(),
        sourceDigest: source.sourceDigest,
        acknowledgedCandidateStatus: true,
      }).snapshot;
      versions = [first, second];
      candidateExports = [
        store.candidateRegistryDownload(1).body,
        store.candidateRegistryDownload(2).body,
      ];
      candidateBytes = legacyCandidateDatabase(readFileSync(file));
    } finally {
      spy.mockRestore();
    }
    const run = store.create({
      title: "합성 평가·후보 분리 보존",
      clientRequestId: randomUUID(),
      manifestDigest: store.list().manifestDigest,
    }).run;
    runId = run.id;
    runNonce = run.clientRequestId;
    store.save(run.id, { revision: 0, clientRequestId: randomUUID(), record: run.records[0] });
    oldExport = store.download(run.id, 1).body;
    combinedBytes = legacyCandidateDatabase(readFileSync(file));
    expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(secret);
  } finally {
    store.close();
  }
}, 30000);
afterEach(() => {
  expect(external).not.toHaveBeenCalled();
});
afterAll(() => {
  vi.unstubAllGlobals();
  const rel = relative(resolve(tmpdir()), resolve(directory));
  if (!rel.startsWith("venture-quality-candidates-backup-") || rel.includes(".."))
    throw new Error("Unsafe cleanup");
  rmSync(directory, { recursive: true, force: true });
});

function sourceFor(bytes = combinedBytes) {
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
function replaceVersion(
  db: DatabaseSync,
  version: number,
  mutate: (snapshot: CandidateRegistrySnapshot) => void,
  reseal = false,
) {
  const snapshot = JSON.parse(
    String(
      db.prepare("SELECT body FROM quality_candidate_versions WHERE version=?").get(version)!.body,
    ),
  ) as CandidateRegistrySnapshot;
  const oldNonce = snapshot.clientRequestId;
  mutate(snapshot);
  if (reseal) {
    snapshot.manifest = registry.candidateRegistryManifest(snapshot.entries);
    snapshot.manifestDigest = digest(snapshot.manifest);
    snapshot.sourceDigest = registry.candidateRegistrySourceDigest(snapshot.entries);
    snapshot.versionDigest = registry.candidateRegistryVersionDigest(snapshot);
  }
  db.exec(
    "DROP TRIGGER quality_candidate_versions_no_update; DROP TRIGGER quality_candidate_requests_no_update",
  );
  db.prepare("UPDATE quality_candidate_versions SET body=?,body_hash=? WHERE version=?").run(
    JSON.stringify(snapshot),
    digest(snapshot),
    version,
  );
  if (reseal) {
    const receipt = {
      kind: "register-candidate-set" as const,
      setId: snapshot.setId,
      version: snapshot.version,
      clientRequestId: snapshot.clientRequestId,
      versionDigest: snapshot.versionDigest,
      inputDigest: digest(
        candidateRegistryRequestDigestInput({
          expectedVersion: snapshot.version - 1,
          clientRequestId: snapshot.clientRequestId,
          sourceDigest: snapshot.sourceDigest,
          acknowledgedCandidateStatus: true,
        }),
      ),
    };
    db.prepare(
      "UPDATE quality_candidate_requests SET nonce=?,body=?,body_hash=? WHERE nonce=?",
    ).run(snapshot.clientRequestId, JSON.stringify(receipt), digest(receipt), oldNonce);
  }
  db.exec(trigger(candidateTables[0], "update"));
  db.exec(trigger(candidateTables[1], "update"));
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
function destination() {
  const root = join(directory, randomUUID());
  mkdirSync(root);
  writeFileSync(join(root, "studio.sqlite"), secret);
  return root;
}
function checkCompany(root: string) {
  expect(readFileSync(join(root, "studio.sqlite"), "utf8")).toBe(secret);
  if (existsSync(join(root, "originals")))
    expect(readFileSync(join(root, "originals", "keep.bin"), "utf8")).toBe(secret);
}
function roundTrip(source: string, counts: Record<string, number>, version: 1 | 2) {
  const backup = join(directory, randomUUID()),
    target = destination();
  const before = hash(readFileSync(join(source, "quality-evaluation", "quality.sqlite")));
  expect(cli("quality-backup", source, backup)).toMatchObject(counts);
  expect(hash(readFileSync(join(source, "quality-evaluation", "quality.sqlite")))).toBe(before);
  const manifest = JSON.parse(readFileSync(join(backup, "quality-backup-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ version, ...counts });
  if (version === 1) expect(manifest).not.toHaveProperty("candidateVersions");
  const archived = readdirSync(backup)
    .sort()
    .map((name) => [name, hash(readFileSync(join(backup, name)))]);
  expect(cli("quality-verify", backup)).toMatchObject(counts);
  expect(cli("quality-restore", backup, target)).toMatchObject(counts);
  expect(readFileSync(join(target, "quality-evaluation", "quality.sqlite"))).toEqual(
    readFileSync(join(backup, "quality.sqlite")),
  );
  expect(
    readdirSync(backup)
      .sort()
      .map((name) => [name, hash(readFileSync(join(backup, name)))]),
  ).toEqual(archived);
  checkCompany(source);
  checkCompany(target);
  return { backup, target };
}

describe("candidate registry archival compatibility", () => {
  it(
    "rejects candidate semantic tampering after archive hashes are resealed and leaves restore destination untouched",
    () => {
      const source = sourceFor(candidateBytes),
        backup = join(directory, randomUUID()),
        target = destination();
      cli("quality-backup", source, backup);
      const db = new DatabaseSync(join(backup, "quality.sqlite"));
      try {
        replaceVersion(
          db,
          2,
          (value) => {
            Object.assign(value, { independentHoldoutConfirmed: true });
          },
          true,
        );
      } finally {
        db.close();
      }
      const manifestPath = join(backup, "quality-backup-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const database = readFileSync(join(backup, "quality.sqlite"));
      manifest.file.sha256 = hash(database);
      manifest.file.sizeBytes = database.length;
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
      expect(cli("quality-restore", backup, target, false).code).toBe("QUALITY_DATABASE_INVALID");
      expect(readdirSync(target)).toEqual(["studio.sqlite"]);
      expect(readFileSync(join(source, "quality-evaluation", "quality.sqlite"))).toEqual(
        candidateBytes,
      );
      checkCompany(source);
      checkCompany(target);
    },
    timeout,
  );

  it(
    "preserves legacy three-table v1 backups and archived evaluation bytes",
    () => {
      const source = sourceFor();
      edit(source, (db) => {
        for (const table of candidateTables) db.exec(`DROP TABLE ${table}`);
      });
      expect(inspect(source)).not.toHaveProperty("candidateVersions");
      const { target } = roundTrip(source, { runs: 1, revisions: 1, requests: 2 }, 1);
      const restored = new PlanQualityStore(target);
      try {
        expect(restored.download(runId, 1).body).toBe(oldExport);
      } finally {
        restored.close();
      }
      checkCompany(target);
    },
    timeout,
  );

  it.each(["empty", "candidates-only"] as const)(
    "backs up/restores a new five-table %s store without inventing evaluation runs",
    (kind) => {
      const count = kind === "empty" ? 0 : 2;
      const { target } = roundTrip(
        sourceFor(kind === "empty" ? emptyBytes : candidateBytes),
        { runs: 0, revisions: 0, requests: 0, candidateVersions: count, candidateRequests: count },
        2,
      );
      const restored = new PlanQualityStore(target);
      try {
        expect(restored.list().runs).toHaveLength(0);
        expect(restored.candidateRegistryList().versions).toHaveLength(count);
        if (count)
          for (const version of versions) {
            expect(restored.candidateRegistryGet(version.version)).toEqual(version);
            expect(restored.candidateRegistryDownload(version.version).body).toBe(
              candidateExports[version.version - 1],
            );
            expect(restored.candidateRegistryLookup(version.clientRequestId)).toMatchObject({
              state: "committed",
              receipt: { version: version.version, versionDigest: version.versionDigest },
            });
          }
      } finally {
        restored.close();
      }
    },
    timeout,
  );

  it(
    "preserves both histories and rejects overwrite or a manifest that disguises the schema version",
    () => {
      const { backup, target } = roundTrip(
        sourceFor(),
        { runs: 1, revisions: 1, requests: 2, candidateVersions: 2, candidateRequests: 2 },
        2,
      );
      const restored = new PlanQualityStore(target);
      try {
        expect(restored.download(runId, 1).body).toBe(oldExport);
        expect(restored.candidateRegistryDownload(1).body).toBe(candidateExports[0]);
        expect(restored.candidateRegistryDownload(2).body).toBe(candidateExports[1]);
      } finally {
        restored.close();
      }
      const before = readFileSync(join(target, "quality-evaluation", "quality.sqlite"));
      expect(cli("quality-restore", backup, target, false).code).toBe("QUALITY_DESTINATION_EXISTS");
      expect(readFileSync(join(target, "quality-evaluation", "quality.sqlite"))).toEqual(before);
      const manifestPath = join(backup, "quality-backup-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      delete manifest.candidateVersions;
      delete manifest.candidateRequests;
      manifest.version = 1;
      const bytes = Buffer.from(JSON.stringify(manifest));
      writeFileSync(manifestPath, bytes);
      writeFileSync(
        join(backup, "COMPLETE.json"),
        JSON.stringify({
          format: "venturepass-quality-backup-complete",
          manifestSha256: hash(bytes),
        }),
      );
      expect(() => verifyQualityBackup(backup)).toThrowError(
        expect.objectContaining({ code: "QUALITY_DATABASE_CHANGED" }),
      );
      checkCompany(target);
    },
    timeout,
  );
});

describe("candidate archive structural tampering", () => {
  it.each([
    [
      "synthetic flag",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v, { synthetic: false });
      },
    ],
    [
      "authorship claim",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v, { authoredBy: "human" });
      },
    ],
    [
      "answer key claim",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v, { humanAnswerKey: "approved" });
      },
    ],
    [
      "held-out claim",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v, { independentHoldoutConfirmed: true });
      },
    ],
    [
      "performance claim",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v, { performanceEvaluation: "passed" });
      },
    ],
    [
      "wrong set",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v, { setId: "fixed-50" });
      },
    ],
    [
      "broken predecessor",
      (v: CandidateRegistrySnapshot) => {
        v.previousDigest = "0".repeat(64);
      },
    ],
    [
      "wrong previous version",
      (v: CandidateRegistrySnapshot) => {
        v.previousVersion = 2;
      },
    ],
    [
      "duplicate candidates",
      (v: CandidateRegistrySnapshot) => {
        v.entries[1].candidateId = v.entries[0].candidateId;
      },
    ],
    [
      "duplicate source IDs",
      (v: CandidateRegistrySnapshot) => {
        v.entries[1].input.sources[0].id = v.entries[0].input.sources[0].id;
      },
    ],
    [
      "reviewer hints in model envelope",
      (v: CandidateRegistrySnapshot) => {
        Object.assign(v.entries[0].input, { authoringNotes: ["hint"] });
      },
    ],
    [
      "duplicate source version",
      (v: CandidateRegistrySnapshot) => {
        v.entries = structuredClone(versions[0].entries);
      },
    ],
    [
      "evaluation nonce collision",
      (v: CandidateRegistrySnapshot) => {
        v.clientRequestId = runNonce;
      },
    ],
  ])("rejects resealed %s", (_label, mutate) => {
    const root = sourceFor();
    edit(root, (db) =>
      replaceVersion(db, 2, mutate as (v: CandidateRegistrySnapshot) => void, true),
    );
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });

  it.each([
    [
      "source digest",
      (v: CandidateRegistrySnapshot) => {
        v.sourceDigest = "0".repeat(64);
      },
    ],
    [
      "manifest digest",
      (v: CandidateRegistrySnapshot) => {
        v.manifestDigest = "0".repeat(64);
      },
    ],
    [
      "model input digest",
      (v: CandidateRegistrySnapshot) => {
        v.manifest[0].modelInputDigest = "0".repeat(64);
      },
    ],
    [
      "metadata digest",
      (v: CandidateRegistrySnapshot) => {
        v.manifest[0].reviewerMetadataDigest = "0".repeat(64);
      },
    ],
    [
      "version digest",
      (v: CandidateRegistrySnapshot) => {
        v.versionDigest = "0".repeat(64);
      },
    ],
  ])("rejects mismatched %s despite an updated row hash", (_label, mutate) => {
    const root = sourceFor();
    edit(root, (db) => replaceVersion(db, 2, mutate as (v: CandidateRegistrySnapshot) => void));
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });

  it.each([
    "orphan receipt",
    "missing receipt",
    "wrong receipt input",
    "wrong receipt version",
    "row hash",
    "version gap",
  ])("rejects %s", (kind) => {
    const root = sourceFor();
    edit(root, (db) => {
      if (kind === "orphan receipt")
        db.prepare("INSERT INTO quality_candidate_requests VALUES(?,?,?)").run(
          randomUUID(),
          "{}",
          digest({}),
        );
      if (kind === "missing receipt") {
        db.exec("DROP TRIGGER quality_candidate_requests_no_delete");
        db.prepare("DELETE FROM quality_candidate_requests WHERE nonce=?").run(
          versions[1].clientRequestId,
        );
        db.exec(trigger(candidateTables[1], "delete"));
      }
      if (kind.startsWith("wrong receipt")) {
        const receipt = JSON.parse(
          String(
            db
              .prepare("SELECT body FROM quality_candidate_requests WHERE nonce=?")
              .get(versions[1].clientRequestId)!.body,
          ),
        );
        if (kind === "wrong receipt input") receipt.inputDigest = "0".repeat(64);
        else receipt.version = 1;
        db.exec("DROP TRIGGER quality_candidate_requests_no_update");
        db.prepare("UPDATE quality_candidate_requests SET body=?,body_hash=? WHERE nonce=?").run(
          JSON.stringify(receipt),
          digest(receipt),
          versions[1].clientRequestId,
        );
        db.exec(trigger(candidateTables[1], "update"));
      }
      if (kind === "row hash" || kind === "version gap") {
        db.exec("DROP TRIGGER quality_candidate_versions_no_update");
        db.exec(
          kind === "row hash"
            ? "UPDATE quality_candidate_versions SET body_hash='broken' WHERE version=2"
            : "UPDATE quality_candidate_versions SET version=3 WHERE version=2",
        );
        db.exec(trigger(candidateTables[0], "update"));
      }
    });
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({
        code:
          kind.includes("receipt") && ["orphan receipt", "missing receipt"].includes(kind)
            ? "QUALITY_DATABASE_LIMIT"
            : "QUALITY_DATABASE_INVALID",
      }),
    );
  });

  it.each(["missing trigger", "extra table", "partial upgrade", "removed primary key"])(
    "rejects unsupported schema: %s",
    (kind) => {
      const root = sourceFor();
      edit(root, (db) => {
        if (kind === "missing trigger")
          db.exec("DROP TRIGGER quality_candidate_versions_no_update");
        if (kind === "extra table") db.exec("CREATE TABLE unrelated (id TEXT)");
        if (kind === "partial upgrade") db.exec("DROP TABLE quality_candidate_requests");
        if (kind === "removed primary key") {
          db.exec(
            "DROP TABLE quality_candidate_versions; CREATE TABLE quality_candidate_versions (set_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL)",
          );
          db.exec(trigger(candidateTables[0], "update"));
          db.exec(trigger(candidateTables[0], "delete"));
        }
      });
      expect(() => inspect(root)).toThrowError(
        expect.objectContaining({ code: "QUALITY_SCHEMA_UNSUPPORTED" }),
      );
    },
  );

  it("rejects candidate row/receipt counts before reading invalid bodies", () => {
    const root = sourceFor(emptyBytes);
    edit(root, (db) => {
      for (let version = 1; version <= 21; version++) {
        db.prepare("INSERT INTO quality_candidate_versions VALUES(?,?,?,?)").run(
          "ai-validation-candidates",
          version,
          "invalid",
          "invalid",
        );
        db.prepare("INSERT INTO quality_candidate_requests VALUES(?,?,?)").run(
          randomUUID(),
          "invalid",
          "invalid",
        );
      }
    });
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_LIMIT" }),
    );
  });

  it("keeps chronology based on version links when the local clock goes backwards", () => {
    const root = sourceFor();
    edit(root, (db) =>
      replaceVersion(
        db,
        2,
        (value) => {
          value.registeredAt = "2000-01-01T00:00:00.000Z";
        },
        true,
      ),
    );
    expect(inspect(root)).toMatchObject({ candidateVersions: 2, candidateRequests: 2 });
  });

  it("rejects oversized candidate bodies even when their canonical row hash still matches", () => {
    const root = sourceFor();
    edit(root, (db) => {
      const row = db.prepare("SELECT body FROM quality_candidate_versions WHERE version=2").get()!;
      db.exec("DROP TRIGGER quality_candidate_versions_no_update");
      db.prepare("UPDATE quality_candidate_versions SET body=? WHERE version=2").run(
        String(row.body).padEnd(8 * 1024 * 1024 + 1, " "),
      );
      db.exec(trigger(candidateTables[0], "update"));
    });
    expect(() => inspect(root)).toThrowError(
      expect.objectContaining({ code: "QUALITY_DATABASE_INVALID" }),
    );
  });
});
