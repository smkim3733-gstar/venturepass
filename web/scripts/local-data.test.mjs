import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  linkSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readSafe, safePath, sha } from "./local-data-files.mjs";
import { inspectDatabase, openReadOnly } from "./local-data-store.mjs";
import { verifyLocalData } from "./local-data.mjs";

function fixture(t, beforeCleanup = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "venture-data-unit-"));
  t.after(() => {
    beforeCleanup();
    const target = resolve(root);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + "\\venture-data-unit-") ||
        target.startsWith(resolve(tmpdir()) + "/venture-data-unit-"),
    );
    rmSync(target, { recursive: true, force: true });
  });
  return root;
}
function database(t) {
  let db;
  const root = fixture(t, () => db.close());
  db = new DatabaseSync(join(root, "test.sqlite"));
  db.exec(
    "CREATE TABLE studio_cases(id TEXT PRIMARY KEY,revision INTEGER,evidence_revision INTEGER,body TEXT); CREATE TABLE venture_accounts(case_id TEXT PRIMARY KEY,encrypted_payload BLOB,masked_login_id TEXT,revision INTEGER,updated_at TEXT); CREATE TABLE venture_workflows(case_id TEXT PRIMARY KEY,revision INTEGER,body TEXT,updated_at TEXT);",
  );
  return db;
}
function addCase(db, changes = {}) {
  const record = { id: randomUUID(), revision: 0, sources: [], plans: [], tasks: [], ...changes };
  db.prepare("INSERT INTO studio_cases VALUES(?,?,?,?)").run(
    record.id,
    record.revision,
    0,
    JSON.stringify(record),
  );
  return record;
}
test("bounded safe copy preserves exact bytes and uses exclusive output creation", (t) => {
  const root = fixture(t);
  const source = join(root, "source");
  const target = join(root, "target");
  writeFileSync(source, "synthetic payload");
  const result = readSafe(source, 1024, target);
  assert.equal(result.sha256, sha(Buffer.from("synthetic payload")));
  assert.equal(result.sizeBytes, 17);
  assert.equal(readFileSync(target, "utf8"), "synthetic payload");
  assert.throws(() => readSafe(source, 1024, target), { code: "EEXIST" });
  assert.throws(() => readSafe(source, 2), { code: "FILE_LIMIT" });
});
test("hardlinked source and directory junctions are rejected before reading", (t) => {
  const root = fixture(t);
  const source = join(root, "source");
  const other = join(root, "other");
  writeFileSync(source, "payload");
  linkSync(source, other);
  assert.throws(() => readSafe(other, 1024), { code: "UNSAFE_PATH" });
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  mkdirSync(actual);
  writeFileSync(join(actual, "data"), "payload");
  symlinkSync(actual, alias, "junction");
  assert.throws(() => safePath(join(alias, "data")), { code: "UNSAFE_PATH" });
});
test("same-sized writes during a read invalidate the observation", (t) => {
  const root = fixture(t);
  const source = join(root, "source");
  writeFileSync(source, "aaaa");
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    const count = original(...args);
    if (!changed) {
      changed = true;
      writeFileSync(source, "bbbb");
      // Windows can report both writes in the same timestamp tick. Make this
      // mutation deterministic instead of relying on filesystem clock granularity.
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(source, future, future);
    }
    return count;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(() => readSafe(source, 1024), { code: "FILE_CHANGED" });
});
test("full SQL snapshot changes when content changes without a revision increment", (t) => {
  const db = database(t);
  const record = addCase(db);
  const before = inspectDatabase(db);
  record.extra = "synthetic changed value";
  db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  const after = inspectDatabase(db);
  assert.notEqual(before.digest, after.digest);
  assert.equal(after.companies, 1);
});
test("full SQL snapshot includes encrypted account and workflow rows without logging them", (t) => {
  const db = database(t);
  const record = addCase(db);
  const before = inspectDatabase(db);
  db.prepare("INSERT INTO venture_accounts VALUES(?,?,?,?,?)").run(
    record.id,
    Buffer.from("fixture ciphertext"),
    "f***",
    1,
    "time",
  );
  db.prepare("INSERT INTO venture_workflows VALUES(?,?,?,?)").run(record.id, 1, "{}", "time");
  const after = inspectDatabase(db);
  assert.equal(after.accounts, 1);
  assert.equal(after.workflows, 1);
  assert.notEqual(before.digest, after.digest);
  assert.equal(JSON.stringify(after).includes("fixture"), false);
});
test("case/source ownership and logical revisions fail closed", (t) => {
  const db = database(t);
  const record = addCase(db);
  const mutate = (body) =>
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(body), record.id);
  mutate({ ...record, id: randomUUID() });
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  mutate({ ...record, revision: 10 });
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  const source = { id: randomUUID(), originalName: "fixture.pdf" };
  mutate({ ...record, sources: [source, source] });
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  mutate({ ...record, sources: [{ ...source, id: "../../private" }] });
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  mutate(record);
  db.prepare("INSERT INTO venture_workflows VALUES(?,?,?,?)").run(randomUUID(), 1, "{}", "time");
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
});
test("unknown schema, views and triggers are not silently included as restorable data", (t) => {
  const db = database(t);
  addCase(db);
  db.exec("CREATE TABLE extra(secret TEXT)");
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_SCHEMA_UNSUPPORTED" });
  db.exec("DROP TABLE extra; CREATE VIEW hidden AS SELECT body FROM studio_cases");
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_SCHEMA_UNSUPPORTED" });
  db.exec(
    "DROP VIEW hidden; CREATE TRIGGER hidden AFTER DELETE ON studio_cases BEGIN DELETE FROM venture_accounts; END",
  );
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_SCHEMA_UNSUPPORTED" });
});
test("snapshot records originals by case/source UUID only", (t) => {
  const db = database(t);
  const id = randomUUID();
  const record = addCase(db, {
    sources: [
      { id, originalName: "PRIVATE_SOURCE_NAME.pdf" },
      { id: randomUUID(), originalName: null },
    ],
  });
  const snapshot = inspectDatabase(db);
  assert.deepEqual(snapshot.originals, [`originals/${record.id}/${id}.bin`]);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_SOURCE_NAME"), false);
});
test("unfinished original checkpoint requires app recovery before a complete backup", (t) => {
  const db = database(t);
  const intake = { id: randomUUID(), sourceId: randomUUID(), phase: "storing_original" };
  const record = addCase(db, { sourceIntakes: [intake] });
  assert.throws(() => inspectDatabase(db), { code: "SOURCE_INTAKE_RECOVERY_REQUIRED" });
  // The same checkpoint must fail even if a source row is already present.
  record.sources = [{ id: intake.sourceId, originalName: "SYNTHETIC_PRIVATE.pdf" }];
  db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  assert.throws(() => inspectDatabase(db), { code: "SOURCE_INTAKE_RECOVERY_REQUIRED" });
  record.sourceIntakes[0].phase = "awaiting_review";
  db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  const resumed = inspectDatabase(db);
  assert.deepEqual(resumed.originals, [`originals/${record.id}/${intake.sourceId}.bin`]);
  assert.equal(JSON.stringify(resumed).includes("SYNTHETIC_PRIVATE"), false);
});
test("unuploaded reservations and unreviewed extraction changes remain in the snapshot digest", (t) => {
  const db = database(t);
  const record = addCase(db, {
    sourceIntakes: [{ id: randomUUID(), phase: "awaiting_original", result: null }],
  });
  const initial = inspectDatabase(db);
  assert.deepEqual(initial.originals, []);
  record.sourceIntakes[0].result = { text: "SYNTHETIC_UNREVIEWED_PRIVATE_TEXT" };
  db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  const changed = inspectDatabase(db);
  assert.notEqual(changed.digest, initial.digest);
  assert.equal(JSON.stringify(changed).includes("SYNTHETIC_UNREVIEWED_PRIVATE_TEXT"), false);
});
test("malformed intake collections fail before original inventory is accepted", (t) => {
  const db = database(t);
  const record = addCase(db);
  for (const sourceIntakes of [
    null,
    {},
    [null],
    [{}],
    Array(101).fill({ phase: "awaiting_original" }),
  ]) {
    db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
      JSON.stringify({ ...record, sourceIntakes }),
      record.id,
    );
    assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  }
});
test("closed WAL source without sidecars is rejected without initializing them", (t) => {
  const root = fixture(t);
  const db = new DatabaseSync(join(root, "studio.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT)");
  db.close();
  const before = readdirSync(root);
  assert.throws(() => openReadOnly(root), { code: "SOURCE_WAL_NOT_READY" });
  assert.deepEqual(readdirSync(root), before);
});
test("verify rejects WAL-header backup before SQLite can create sidecars", (t) => {
  const root = fixture(t);
  const file = join(root, "studio.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE fixture(value TEXT)");
  db.close();
  const bytes = readFileSync(file);
  bytes[18] = 2;
  bytes[19] = 2;
  writeFileSync(file, bytes);
  const manifest = Buffer.from(
    JSON.stringify({
      format: "venturepass-local-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      logicalDigest: "0".repeat(64),
      companies: 0,
      accounts: 0,
      workflows: 0,
      files: [{ path: "studio.sqlite", sizeBytes: bytes.length, sha256: sha(bytes) }],
    }),
  );
  writeFileSync(join(root, "backup-manifest.json"), manifest);
  writeFileSync(
    join(root, "COMPLETE.json"),
    JSON.stringify({ format: "venturepass-local-backup-complete", manifestSha256: sha(manifest) }),
  );
  const before = readdirSync(root);
  assert.throws(() => verifyLocalData(root), { code: "BACKUP_JOURNAL_UNSUPPORTED" });
  assert.deepEqual(readdirSync(root), before);
  assert.deepEqual(readFileSync(file), bytes);
});

const preparedSql =
  "CREATE TABLE studio_prepared_packages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES studio_cases(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0), client_request_id TEXT NOT NULL, request_digest TEXT NOT NULL, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, archive BLOB NOT NULL, UNIQUE(case_id, version), UNIQUE(case_id, client_request_id))";
const syntheticArchive = Buffer.from("PK\x03\x04 SYNTHETIC ARCHIVE BYTES ONLY");
function preparedRecord(company, version = 1) {
  const content = {
    title: "Synthetic retained plan",
    summary: "Local synthetic test",
    sections: [],
    actionItems: [],
    interviewQuestions: [],
  };
  const input = {
    revision: company.revision,
    planId: randomUUID(),
    sourceIds: [],
    clientRequestId: randomUUID(),
  };
  return {
    id: randomUUID(),
    version,
    caseId: company.id,
    caseRevision: company.revision,
    clientRequestId: input.clientRequestId,
    requestDigest: sha(JSON.stringify(input)),
    input,
    createdAt: "2026-09-27T00:00:00.000Z",
    scope: "local-preparation-only",
    company: {
      profile: { companyName: "Synthetic local fixture" },
      snapshotSha256: sha(JSON.stringify(company)),
    },
    plan: {
      id: input.planId,
      version: 1,
      generatedAt: "2026-09-27T00:00:00.000Z",
      mode: "manual",
      candidateId: randomUUID(),
      sourceRevision: 0,
      content,
      review: [],
      confirmedAt: null,
      contentSha256: sha(JSON.stringify(content)),
    },
    sourceIds: [],
    sources: [],
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
      sha256: sha(syntheticArchive),
      sizeBytes: syntheticArchive.length,
    },
  };
}
function addPrepared(db, record, changes = {}) {
  const body = JSON.stringify(record);
  const row = {
    id: record.id,
    case_id: record.caseId,
    version: record.version,
    client_request_id: record.clientRequestId,
    request_digest: record.requestDigest,
    body,
    body_sha256: sha(body),
    archive: syntheticArchive,
    ...changes,
  };
  db.prepare("INSERT INTO studio_prepared_packages VALUES(?,?,?,?,?,?,?,?)").run(
    ...Object.values(row),
  );
}

test("exact current empty prepared table is accepted without changing the legacy snapshot format", (t) => {
  const db = database(t);
  addCase(db);
  const legacy = inspectDatabase(db);
  db.exec(preparedSql);
  const current = inspectDatabase(db);
  assert.deepEqual(Object.keys(current), Object.keys(legacy));
  assert.notEqual(current.digest, legacy.digest);
  assert.equal(current.companies, 1);
});

for (const [label, altered] of [
  [
    "missing foreign key",
    preparedSql.replace(" REFERENCES studio_cases(id) ON DELETE CASCADE", ""),
  ],
  ["different cascade", preparedSql.replace("ON DELETE CASCADE", "ON DELETE RESTRICT")],
  ["missing version check", preparedSql.replace(" CHECK(version > 0)", "")],
  ["missing version uniqueness", preparedSql.replace(", UNIQUE(case_id, version)", "")],
  ["missing nonce uniqueness", preparedSql.replace(", UNIQUE(case_id, client_request_id)", "")],
  ["missing not null", preparedSql.replace("archive BLOB NOT NULL", "archive BLOB")],
  [
    "extra column",
    preparedSql.replace("archive BLOB NOT NULL", "archive BLOB NOT NULL, extra TEXT"),
  ],
])
  test(`prepared schema refuses ${label}`, (t) => {
    const db = database(t);
    addCase(db);
    db.exec(altered);
    assert.throws(() => inspectDatabase(db), { code: "DATABASE_SCHEMA_UNSUPPORTED" });
  });

test("prepared rows are part of logical digest and never repopulate the live original inventory", (t) => {
  const db = database(t);
  const company = addCase(db, { revision: 7 });
  db.exec(preparedSql);
  const first = inspectDatabase(db);
  const record = preparedRecord(company);
  const sourceId = randomUUID();
  record.input.sourceIds = [sourceId];
  record.sourceIds = [sourceId];
  record.requestDigest = sha(JSON.stringify(record.input));
  record.sources = [
    {
      source: { id: sourceId, originalName: "SYNTHETIC_DELETED.pdf" },
      sourceSha256: "1".repeat(64),
      textSha256: "2".repeat(64),
      originalSha256: "3".repeat(64),
      originalSizeBytes: 10,
    },
  ];
  addPrepared(db, record);
  const second = inspectDatabase(db);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(second.originals, []);
  // Current source and plan collections deliberately have no historical IDs.
  const changed = { ...company, revision: 8, plans: [], sources: [] };
  db.prepare("UPDATE studio_cases SET revision=?,body=? WHERE id=?").run(
    8,
    JSON.stringify(changed),
    company.id,
  );
  assert.doesNotThrow(() => inspectDatabase(db));
  const row = db.prepare("SELECT * FROM studio_prepared_packages").get();
  const otherArchive = Buffer.from(syntheticArchive);
  otherArchive[otherArchive.length - 1] ^= 1;
  record.zip.sha256 = sha(otherArchive);
  const body = JSON.stringify(record);
  db.prepare("UPDATE studio_prepared_packages SET body=?,body_sha256=?,archive=? WHERE id=?").run(
    body,
    sha(body),
    otherArchive,
    row.id,
  );
  assert.notEqual(inspectDatabase(db).digest, second.digest);
});

for (const [label, modify, rowChanges] of [
  ["body hash corruption", () => {}, { body_sha256: "0".repeat(64) }],
  ["archive byte corruption", () => {}, { archive: Buffer.alloc(syntheticArchive.length, 65) }],
  ["archive wrong storage type", () => {}, { archive: "not a BLOB" }],
  [
    "metadata ID mismatch",
    (r) => {
      r.id = randomUUID();
    },
    { id: randomUUID() },
  ],
  [
    "company metadata mismatch",
    (r) => {
      r.caseId = randomUUID();
    },
  ],
  [
    "future company revision",
    (r) => {
      r.caseRevision = 99;
    },
  ],
  [
    "revision binding mismatch",
    (r) => {
      r.input.revision++;
    },
  ],
  [
    "nonce binding mismatch",
    (r) => {
      r.input.clientRequestId = randomUUID();
    },
  ],
  [
    "request digest mismatch",
    (r) => {
      r.requestDigest = "0".repeat(64);
    },
  ],
  [
    "plan binding mismatch",
    (r) => {
      r.input.planId = randomUUID();
      r.requestDigest = sha(JSON.stringify(r.input));
    },
  ],
  [
    "plan content changed",
    (r) => {
      r.plan.content.summary += "changed";
    },
  ],
  [
    "stored review mismatch",
    (r) => {
      r.review.storedFindings = [{ message: "changed" }];
    },
  ],
  [
    "confirmation mismatch",
    (r) => {
      r.review.confirmedAt = "2026-09-27T00:00:00.000Z";
    },
  ],
  [
    "ZIP size mismatch",
    (r) => {
      r.zip.sizeBytes++;
    },
  ],
  [
    "ZIP digest mismatch",
    (r) => {
      r.zip.sha256 = "0".repeat(64);
    },
  ],
  [
    "unknown envelope field",
    (r) => {
      r.unrecognized = true;
    },
  ],
  [
    "duplicate selected source",
    (r) => {
      const id = randomUUID();
      r.sourceIds = [id, id];
    },
  ],
  [
    "missing pinned source",
    (r) => {
      r.sourceIds = [randomUUID()];
    },
  ],
  [
    "bad archive filename",
    (r) => {
      r.zip.fileName = "../../escape.zip";
    },
  ],
  [
    "unsupported scope",
    (r) => {
      r.scope = "official-submitted";
    },
  ],
  [
    "metadata limit",
    (r) => {
      r.company.profile.extra = "x".repeat(2 * 1024 * 1024);
    },
  ],
])
  test(`prepared snapshot refuses ${label}`, (t) => {
    const db = database(t);
    const company = addCase(db, { revision: 7 });
    db.exec(preparedSql);
    const record = preparedRecord(company);
    modify(record);
    addPrepared(db, record, { case_id: company.id, ...rowChanges });
    assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  });

test("prepared history rejects gaps, duplicate UUID casing, company orphans and over-limit rows", (t) => {
  const db = database(t);
  const company = addCase(db, { revision: 7 });
  db.exec(preparedSql);
  addPrepared(db, preparedRecord(company, 2));
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  db.exec("DELETE FROM studio_prepared_packages");
  const one = preparedRecord(company),
    two = preparedRecord(company, 2);
  one.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  one.clientRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  one.input.clientRequestId = one.clientRequestId;
  one.requestDigest = sha(JSON.stringify(one.input));
  two.id = one.id.toUpperCase();
  addPrepared(db, one);
  addPrepared(db, two);
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  db.exec("DELETE FROM studio_prepared_packages");
  two.id = randomUUID();
  two.clientRequestId = one.clientRequestId.toUpperCase();
  two.input.clientRequestId = two.clientRequestId;
  two.requestDigest = sha(JSON.stringify(two.input));
  addPrepared(db, one);
  addPrepared(db, two);
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  db.exec("DELETE FROM studio_prepared_packages");
  db.exec("PRAGMA foreign_keys=OFF");
  addPrepared(db, one, { case_id: randomUUID() });
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  db.exec("DELETE FROM studio_prepared_packages");
  db.exec("PRAGMA foreign_keys=ON");
  for (let version = 1; version <= 20; version++) addPrepared(db, preparedRecord(company, version));
  assert.doesNotThrow(() => inspectDatabase(db));
  addPrepared(db, preparedRecord(company, 21));
  assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
});

test("prepared nonce is company scoped and request digest does not depend on stored object key order", (t) => {
  const db = database(t);
  const firstCompany = addCase(db, { revision: 7 }),
    secondCompany = addCase(db, { revision: 8 });
  db.exec(preparedSql);
  const first = preparedRecord(firstCompany),
    second = preparedRecord(secondCompany);
  second.clientRequestId = first.clientRequestId;
  second.input.clientRequestId = first.clientRequestId;
  second.requestDigest = sha(JSON.stringify(second.input));
  second.input = Object.fromEntries(Object.entries(second.input).reverse());
  addPrepared(db, first);
  addPrepared(db, second);
  assert.equal(inspectDatabase(db).companies, 2);
});

for (const [label, modify] of [
  [
    "source ID mismatch",
    (r) => {
      r.sources[0].source.id = randomUUID();
    },
  ],
  [
    "invalid original SHA",
    (r) => {
      r.sources[0].originalSha256 = "invalid";
    },
  ],
  [
    "invalid source SHA",
    (r) => {
      r.sources[0].sourceSha256 = "invalid";
    },
  ],
  [
    "raw source body in metadata",
    (r) => {
      r.sources[0].source.text = "not stored in this envelope";
    },
  ],
])
  test(`prepared snapshot refuses ${label}`, (t) => {
    const db = database(t);
    const company = addCase(db, { revision: 7 });
    db.exec(preparedSql);
    const record = preparedRecord(company),
      sourceId = randomUUID();
    record.input.sourceIds = [sourceId];
    record.sourceIds = [sourceId];
    record.requestDigest = sha(JSON.stringify(record.input));
    record.sources = [
      {
        source: { id: sourceId, originalName: "SYNTHETIC.pdf" },
        sourceSha256: "1".repeat(64),
        textSha256: "2".repeat(64),
        originalSha256: "3".repeat(64),
        originalSizeBytes: 10,
      },
    ];
    modify(record);
    addPrepared(db, record);
    assert.throws(() => inspectDatabase(db), { code: "DATABASE_INVALID" });
  });
