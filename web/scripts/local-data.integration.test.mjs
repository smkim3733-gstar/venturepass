import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const script = fileURLToPath(new URL("./local-data.mjs", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const secret = "SYNTHETIC_SECRET_NEVER_PRINT_THIS";

function fixture(root) {
  mkdirSync(root);
  const database = new DatabaseSync(path.join(root, "studio.sqlite"));
  database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON; CREATE TABLE studio_cases (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, evidence_revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE venture_accounts (case_id TEXT PRIMARY KEY REFERENCES studio_cases(id) ON DELETE CASCADE, encrypted_payload BLOB, masked_login_id TEXT, revision INTEGER NOT NULL CHECK (revision > 0), updated_at TEXT NOT NULL, CHECK ((encrypted_payload IS NULL AND masked_login_id IS NULL) OR (encrypted_payload IS NOT NULL AND masked_login_id IS NOT NULL))); CREATE TABLE venture_workflows (case_id TEXT PRIMARY KEY REFERENCES studio_cases(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK (revision > 0), body TEXT NOT NULL, updated_at TEXT NOT NULL);",
  );
  const now = "2026-09-25T00:00:00.000Z";
  const id = randomUUID();
  const sourceId = randomUUID();
  const original = Buffer.from(`%PDF-1.7\n${secret}\nSYNTHETIC ORIGINAL`);
  const attemptId = randomUUID();
  const resultId = randomUUID();
  const unreviewedText = `UNREVIEWED ${secret}`;
  const record = {
    id,
    profile: {
      companyName: "SYNTHETIC_COMPANY_NEVER_PRINT",
      businessNumber: "",
      industry: "",
      foundedOn: "",
      paidInCapital: "",
      closingMonth: "",
      applicationDate: "",
      applicationKind: "new",
      technologySummary: "",
      customers: "",
      team: "",
      financials: "",
      developmentPlan: "",
      patents: "",
    },
    sources: [
      {
        id: sourceId,
        name: "SYNTHETIC_SOURCE_NEVER_PRINT",
        kind: "technology",
        text: "",
        originalName: "synthetic-private.pdf",
        mimeType: "application/pdf",
        extraction: "pending",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    stageHistory: [],
    agencyRecords: [],
    sourceOcrReviews: [],
    sourceIntakes: [
      {
        id: randomUUID(),
        batchId: randomUUID(),
        clientFileId: randomUUID(),
        sourceId,
        version: 4,
        declared: {
          originalName: "synthetic-private.pdf",
          kind: "technology",
          sizeBytes: original.length,
        },
        original: {
          originalName: "synthetic-private.pdf",
          mimeType: "application/pdf",
          sizeBytes: original.length,
          sha256: sha(original),
          sourceUpdatedAt: now,
        },
        phase: "awaiting_review",
        attempts: [
          {
            id: attemptId,
            engine: "local-document",
            startedAt: now,
            finishedAt: now,
            originalSha256: sha(original),
            sourceUpdatedAt: now,
            externalRequestStarted: false,
            status: "completed",
            code: null,
            resultId,
          },
        ],
        result: {
          id: resultId,
          attemptId,
          engine: "local-document",
          generatedAt: now,
          originalSha256: sha(original),
          sourceUpdatedAt: now,
          textSha256: sha(unreviewedText),
          content: { kind: "plain", text: unreviewedText },
          warnings: [],
          reviewStatus: "unreviewed",
          discardedAt: null,
        },
        previousResults: [],
        adoption: null,
        requests: [],
        createdAt: now,
        updatedAt: now,
        code: null,
      },
    ],
    diagnoses: [],
    preparationRuns: [],
    revision: 7,
    createdAt: now,
    updatedAt: now,
  };
  database
    .prepare("INSERT INTO studio_cases (id, revision, evidence_revision, body) VALUES (?, ?, ?, ?)")
    .run(id, 7, 4, JSON.stringify(record));
  database
    .prepare(
      "INSERT INTO venture_accounts (case_id, encrypted_payload, masked_login_id, revision, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, Buffer.from(secret), "SYNTHETIC_MASK_NEVER_PRINT", 1, now);
  database
    .prepare(
      "INSERT INTO venture_workflows (case_id, revision, body, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, 1, JSON.stringify({ synthetic: secret }), now);
  const relative = path.join("originals", id, `${sourceId}.bin`);
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), original);
  return { database, record, relative, original };
}

function snapshot(database) {
  const tables = ["studio_cases", "venture_accounts", "venture_workflows"];
  if (
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='studio_prepared_packages'",
      )
      .get()
  )
    tables.push("studio_prepared_packages");
  return tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

function cli(args, temporaryRoot, forbidden, ok = true, originals = 1) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: path.dirname(script),
    windowsHide: true,
    timeout: 150_000,
    maxBuffer: 8192,
    encoding: "utf8",
    env: {
      ...process.env,
      VENTURE_DATA_DIR: path.join(temporaryRoot, "must-not-be-accessed"),
      OPENAI_API_KEY: secret,
      NODE_NO_WARNINGS: "1",
    },
  });
  assert.equal(result.error, undefined, "CLI must finish within its bounded timeout");
  assert.equal(result.status, ok ? 0 : 1);
  const output = result.stdout + result.stderr;
  for (const value of forbidden)
    assert.equal(
      output.includes(value),
      false,
      "CLI output must contain only fixed status codes and counts",
    );
  assert.equal(existsSync(path.join(temporaryRoot, "must-not-be-accessed")), false);
  const payload = JSON.parse((ok ? result.stdout : result.stderr).trim());
  if (ok) {
    assert.equal(result.stderr, "");
    assert.deepEqual(payload, {
      ok: true,
      action: args[0],
      companies: 1,
      originals,
      accounts: 1,
      scope: "structure-and-bytes-only",
      credentials: "same-windows-user-may-be-required",
      switched: false,
    });
  } else {
    assert.equal(result.stdout, "");
    assert.equal(payload.ok, false);
    assert.equal(payload.completed, false);
    assert.equal(payload.overwritten, false);
  }
  return payload;
}

test(
  "synthetic child CLI: Unicode paths, live WAL snapshot, readonly verification, new-directory restore, and refusal boundaries",
  { timeout: 300_000 },
  async (t) => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "venture-local-data-audit-"));
    const source = path.join(temporaryRoot, "자료 원본");
    const backup = path.join(temporaryRoot, "백업 보관");
    const restored = path.join(temporaryRoot, "복원 후보");
    const data = fixture(source);
    const forbidden = [
      temporaryRoot,
      source,
      backup,
      restored,
      secret,
      data.record.id,
      data.record.profile.companyName,
      data.record.sources[0].id,
      data.record.sources[0].name,
      data.record.sources[0].originalName,
      "SYNTHETIC_MASK_NEVER_PRINT",
    ];
    const before = snapshot(data.database);
    try {
      await t.test(
        "backup includes committed live WAL data without changing source DB or originals",
        () => {
          assert.ok(existsSync(path.join(source, "studio.sqlite-wal")));
          cli(["backup", "--source", source, "--destination", backup], temporaryRoot, forbidden);
          assert.deepEqual(snapshot(data.database), before);
          assert.deepEqual(readFileSync(path.join(source, data.relative)), data.original);
          assert.deepEqual(
            readdirSync(backup).sort(),
            ["COMPLETE.json", "backup-manifest.json", "originals", "studio.sqlite"].sort(),
          );
          assert.equal(existsSync(path.join(backup, "studio.sqlite-wal")), false);
          const db = new DatabaseSync(path.join(backup, "studio.sqlite"), { readOnly: true });
          try {
            assert.deepEqual(snapshot(db), before);
          } finally {
            db.close();
          }
        },
      );
      await t.test("verify preserves every backup byte and manifest hash", () => {
        const files = ["studio.sqlite", "backup-manifest.json", "COMPLETE.json", data.relative];
        const initial = files.map((file) => sha(readFileSync(path.join(backup, file))));
        cli(["verify", "--source", backup], temporaryRoot, forbidden);
        assert.deepEqual(
          files.map((file) => sha(readFileSync(path.join(backup, file)))),
          initial,
        );
      });
      await t.test(
        "restore creates only a new destination and retains all three tables plus exact original",
        () => {
          cli(["restore", "--source", backup, "--destination", restored], temporaryRoot, forbidden);
          const db = new DatabaseSync(path.join(restored, "studio.sqlite"), { readOnly: true });
          try {
            assert.deepEqual(snapshot(db), before);
          } finally {
            db.close();
          }
          assert.deepEqual(readFileSync(path.join(restored, data.relative)), data.original);
          cli(["verify", "--source", restored], temporaryRoot, forbidden);
          assert.deepEqual(snapshot(data.database), before);
        },
      );
      await t.test("existing restore directory is never overwritten", () => {
        const initial = sha(readFileSync(path.join(restored, "studio.sqlite")));
        const result = cli(
          ["restore", "--source", backup, "--destination", restored],
          temporaryRoot,
          forbidden,
          false,
        );
        assert.equal(result.code, "DESTINATION_EXISTS");
        assert.equal(sha(readFileSync(path.join(restored, "studio.sqlite"))), initial);
      });
      await t.test(
        "incomplete intake checkpoint blocks backup without changing source or reporting completion",
        () => {
          const blocked = path.join(temporaryRoot, "intake-must-not-backup");
          const unfinished = structuredClone(data.record);
          unfinished.sourceIntakes[0].phase = "storing_original";
          data.database
            .prepare("UPDATE studio_cases SET body=? WHERE id=?")
            .run(JSON.stringify(unfinished), unfinished.id);
          const checkpoint = snapshot(data.database);
          try {
            const result = cli(
              ["backup", "--source", source, "--destination", blocked],
              temporaryRoot,
              forbidden,
              false,
            );
            assert.equal(result.code, "SOURCE_INTAKE_RECOVERY_REQUIRED");
            assert.equal(existsSync(path.join(blocked, "COMPLETE.json")), false);
            assert.deepEqual(snapshot(data.database), checkpoint);
            assert.deepEqual(readFileSync(path.join(source, data.relative)), data.original);
          } finally {
            data.database
              .prepare("UPDATE studio_cases SET body=? WHERE id=?")
              .run(JSON.stringify(data.record), data.record.id);
          }
          assert.deepEqual(snapshot(data.database), before);
        },
      );
      await t.test(
        "same-size original tampering invalidates verify and prevents creating a restore directory",
        () => {
          writeFileSync(path.join(backup, data.relative), Buffer.alloc(data.original.length, 0x41));
          assert.equal(
            cli(["verify", "--source", backup], temporaryRoot, forbidden, false).code,
            "FILE_CHANGED",
          );
          const blocked = path.join(temporaryRoot, "must-not-restore");
          assert.equal(
            cli(
              ["restore", "--source", backup, "--destination", blocked],
              temporaryRoot,
              forbidden,
              false,
            ).code,
            "FILE_CHANGED",
          );
          assert.equal(existsSync(blocked), false);
          assert.deepEqual(snapshot(data.database), before);
          assert.deepEqual(readFileSync(path.join(source, data.relative)), data.original);
        },
      );
    } finally {
      data.database.close();
      const resolved = path.resolve(temporaryRoot);
      const boundary = path.relative(path.resolve(tmpdir()), resolved);
      if (
        path.isAbsolute(boundary) ||
        boundary.startsWith("..") ||
        !path.basename(resolved).startsWith("venture-local-data-audit-")
      )
        throw new Error("Unsafe synthetic cleanup target");
      rmSync(resolved, { recursive: true, force: true });
    }
  },
);

const preparedSql =
  "CREATE TABLE studio_prepared_packages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES studio_cases(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0), client_request_id TEXT NOT NULL, request_digest TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, archive BLOB NOT NULL, UNIQUE(case_id, version), UNIQUE(case_id, client_request_id))";
async function addSyntheticPrepared(data) {
  const source = data.record.sources[0];
  const content = {
    title: "SYNTHETIC RETAINED PLAN",
    summary: secret,
    sections: [],
    actionItems: [],
    interviewQuestions: [],
  };
  const plan = {
    id: randomUUID(),
    version: 1,
    generatedAt: "2026-09-27T00:00:00.000Z",
    mode: "manual",
    candidateId: randomUUID(),
    sourceRevision: 4,
    content,
    review: [],
    confirmedAt: null,
  };
  data.record.plans = [plan];
  data.database
    .prepare("UPDATE studio_cases SET body=? WHERE id=?")
    .run(JSON.stringify(data.record), data.record.id);
  const zip = new JSZip();
  zip.file(`originals/${source.id}.bin`, data.original);
  zip.file("plan.json", JSON.stringify(plan));
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  const input = {
    revision: data.record.revision,
    planId: plan.id,
    sourceIds: [source.id],
    clientRequestId: randomUUID(),
  };
  const metadata = { ...source };
  delete metadata.text;
  const record = {
    id: randomUUID(),
    version: 1,
    caseId: data.record.id,
    caseRevision: input.revision,
    clientRequestId: input.clientRequestId,
    requestDigest: sha(JSON.stringify(input)),
    input,
    createdAt: "2026-09-27T00:00:00.000Z",
    scope: "local-preparation-only",
    company: { profile: data.record.profile, snapshotSha256: sha(JSON.stringify(data.record)) },
    plan: { ...plan, contentSha256: sha(JSON.stringify(content)) },
    sourceIds: [source.id],
    sources: [
      {
        source: metadata,
        sourceSha256: sha(JSON.stringify(source)),
        textSha256: sha(source.text),
        originalSha256: sha(data.original),
        originalSizeBytes: data.original.length,
      },
    ],
    review: {
      storedFindings: [],
      currentRuleFindings: [],
      confirmedAt: null,
      unconfirmedSectionKeys: [],
      currentEvidence: true,
      latestPlanVersion: true,
      draft: true,
      draftReasons: ["Synthetic unconfirmed plan"],
    },
    zip: {
      fileName: "venturepass-preparation-package.zip",
      sha256: sha(archive),
      sizeBytes: archive.length,
    },
  };
  const body = JSON.stringify(record);
  data.database
    .prepare("INSERT INTO studio_prepared_packages VALUES(?,?,?,?,?,?,?,?)")
    .run(
      record.id,
      record.caseId,
      record.version,
      record.clientRequestId,
      record.requestDigest,
      body,
      sha(body),
      archive,
    );
  return { record, archive };
}
function syntheticCleanup(root) {
  const target = path.resolve(root);
  const relative = path.relative(path.resolve(tmpdir()), target);
  assert.ok(
    !path.isAbsolute(relative) &&
      !relative.startsWith("..") &&
      path.basename(target).startsWith("venture-local-data-audit-"),
  );
  rmSync(target, { recursive: true, force: true });
}
function assertRestoredRows(root, rows) {
  const database = new DatabaseSync(path.join(root, "studio.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(snapshot(database), rows);
  } finally {
    database.close();
  }
}

test(
  "synthetic child CLI: current four-table database with no packages backs up and restores",
  { timeout: 180_000 },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "venture-local-data-audit-"));
    const source = path.join(root, "source"),
      backup = path.join(root, "backup"),
      restored = path.join(root, "restored");
    const data = fixture(source);
    try {
      data.database.exec(preparedSql);
      const before = snapshot(data.database);
      const forbidden = [root, secret, data.record.id];
      cli(["backup", "--source", source, "--destination", backup], root, forbidden);
      cli(["verify", "--source", backup], root, forbidden);
      cli(["restore", "--source", backup, "--destination", restored], root, forbidden);
      assertRestoredRows(restored, before);
      assert.deepEqual(snapshot(data.database), before);
      assert.deepEqual(readFileSync(path.join(restored, data.relative)), data.original);
    } finally {
      data.database.close();
      syntheticCleanup(root);
    }
  },
);

test(
  "synthetic child CLI: immutable prepared ZIP survives original and plan deletion; resealed corrupt backup is refused",
  { timeout: 360_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "venture-local-data-audit-"));
    const source = path.join(root, "source"),
      backup = path.join(root, "backup"),
      restored = path.join(root, "restored");
    const data = fixture(source);
    let closed = false;
    try {
      data.database.exec(preparedSql);
      const prepared = await addSyntheticPrepared(data);
      const before = snapshot(data.database);
      const forbidden = [
        root,
        secret,
        data.record.id,
        prepared.record.id,
        prepared.record.clientRequestId,
      ];
      cli(["backup", "--source", source, "--destination", backup], root, forbidden);
      cli(["verify", "--source", backup], root, forbidden);
      cli(["restore", "--source", backup, "--destination", restored], root, forbidden);
      assertRestoredRows(restored, before);
      assert.deepEqual(readFileSync(path.join(restored, data.relative)), data.original);
      assert.deepEqual(snapshot(data.database), before);

      // Alter only archived bytes, then reseal the outer file manifest. The inner
      // prepared SHA must still reject it before a restoration directory exists.
      const badDb = new DatabaseSync(path.join(backup, "studio.sqlite"));
      const badArchive = Buffer.from(prepared.archive);
      badArchive[badArchive.length - 1] ^= 1;
      badDb.prepare("UPDATE studio_prepared_packages SET archive=?").run(badArchive);
      badDb.close();
      const manifestPath = path.join(backup, "backup-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const databaseBytes = readFileSync(path.join(backup, "studio.sqlite"));
      Object.assign(
        manifest.files.find((item) => item.path === "studio.sqlite"),
        { sizeBytes: databaseBytes.length, sha256: sha(databaseBytes) },
      );
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      writeFileSync(manifestPath, manifestBytes);
      writeFileSync(
        path.join(backup, "COMPLETE.json"),
        JSON.stringify({
          format: "venturepass-local-backup-complete",
          manifestSha256: sha(manifestBytes),
        }),
      );
      assert.equal(
        cli(["verify", "--source", backup], root, forbidden, false).code,
        "DATABASE_INVALID",
      );
      const blocked = path.join(root, "blocked");
      assert.equal(
        cli(["restore", "--source", backup, "--destination", blocked], root, forbidden, false).code,
        "DATABASE_INVALID",
      );
      assert.equal(existsSync(blocked), false);

      // Historical source IDs remain solely inside the preserved package. Cold
      // backup must not require/recreate a removed live source or its plan.
      data.record.sources = [];
      data.record.plans = [];
      data.record.sourceIntakes = [];
      data.record.revision++;
      data.database
        .prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?")
        .run(data.record.revision, JSON.stringify(data.record), data.record.id);
      unlinkSync(path.join(source, data.relative));
      const historicalRows = snapshot(data.database);
      data.database.close();
      closed = true;
      const beforeBytes = readFileSync(path.join(source, "studio.sqlite"));
      const beforeFiles = readdirSync(source, { recursive: true }).sort();
      const historyBackup = path.join(root, "history-backup"),
        historyRestored = path.join(root, "history-restored");
      cli(["backup", "--source", source, "--destination", historyBackup], root, forbidden, true, 0);
      cli(["verify", "--source", historyBackup], root, forbidden, true, 0);
      cli(
        ["restore", "--source", historyBackup, "--destination", historyRestored],
        root,
        forbidden,
        true,
        0,
      );
      assertRestoredRows(historyRestored, historicalRows);
      assert.equal(existsSync(path.join(historyRestored, data.relative)), false);
      const restoredDb = new DatabaseSync(path.join(historyRestored, "studio.sqlite"), {
        readOnly: true,
      });
      let restoredZip;
      try {
        restoredZip = Buffer.from(
          restoredDb.prepare("SELECT archive FROM studio_prepared_packages").get().archive,
        );
      } finally {
        restoredDb.close();
      }
      assert.deepEqual(restoredZip, prepared.archive);
      const opened = await JSZip.loadAsync(restoredZip);
      assert.deepEqual(
        await opened.file(`originals/${prepared.record.sourceIds[0]}.bin`).async("nodebuffer"),
        data.original,
      );
      assert.deepEqual(readFileSync(path.join(source, "studio.sqlite")), beforeBytes);
      assert.deepEqual(readdirSync(source, { recursive: true }).sort(), beforeFiles);
    } finally {
      if (!closed) data.database.close();
      syntheticCleanup(root);
    }
  },
);

test(
  "synthetic child CLI: cleanly closed WAL backs up through scratch and restores without changing source directory or bytes",
  { timeout: 180_000 },
  () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "venture-local-data-audit-"));
    const source = path.join(temporaryRoot, "종료한 자료");
    const backup = path.join(temporaryRoot, "종료한 백업");
    const restored = path.join(temporaryRoot, "종료한 복원");
    const data = fixture(source);
    const expectedRows = snapshot(data.database);
    data.database.close();
    const originalDatabase = readFileSync(path.join(source, "studio.sqlite"));
    const originalNames = readdirSync(source, { recursive: true }).sort();
    const forbidden = [
      temporaryRoot,
      source,
      backup,
      restored,
      secret,
      data.record.id,
      data.record.profile.companyName,
      data.record.sources[0].id,
      data.record.sources[0].name,
      data.record.sources[0].originalName,
      "SYNTHETIC_MASK_NEVER_PRINT",
    ];
    try {
      assert.equal(originalDatabase[18], 2);
      assert.equal(originalDatabase[19], 2);
      for (const suffix of ["-wal", "-shm", "-journal"])
        assert.equal(existsSync(path.join(source, `studio.sqlite${suffix}`)), false);

      cli(["backup", "--source", source, "--destination", backup], temporaryRoot, forbidden);
      cli(["verify", "--source", backup], temporaryRoot, forbidden);
      cli(["restore", "--source", backup, "--destination", restored], temporaryRoot, forbidden);
      cli(["verify", "--source", restored], temporaryRoot, forbidden);

      const restoredDatabase = new DatabaseSync(path.join(restored, "studio.sqlite"), {
        readOnly: true,
      });
      try {
        assert.deepEqual(snapshot(restoredDatabase), expectedRows);
      } finally {
        restoredDatabase.close();
      }
      assert.deepEqual(readFileSync(path.join(restored, data.relative)), data.original);
      assert.deepEqual(readdirSync(source, { recursive: true }).sort(), originalNames);
      assert.deepEqual(readFileSync(path.join(source, "studio.sqlite")), originalDatabase);
      assert.deepEqual(readFileSync(path.join(source, data.relative)), data.original);
      for (const suffix of ["-wal", "-shm", "-journal"])
        assert.equal(existsSync(path.join(source, `studio.sqlite${suffix}`)), false);
    } finally {
      const resolved = path.resolve(temporaryRoot);
      const boundary = path.relative(path.resolve(tmpdir()), resolved);
      if (
        path.isAbsolute(boundary) ||
        boundary.startsWith("..") ||
        !path.basename(resolved).startsWith("venture-local-data-audit-")
      )
        throw new Error("Unsafe synthetic cleanup target");
      rmSync(resolved, { recursive: true, force: true });
    }
  },
);
