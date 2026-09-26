import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { prepareColdSource } from "./local-data-cold.mjs";
import { backupLocalData } from "./local-data.mjs";
import { inspectDatabase } from "./local-data-store.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "venture-cold-unit-"));
  const source = path.join(root, "source");
  const file = path.join(source, "studio.sqlite");
  fs.mkdirSync(source);
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE studio_cases(id TEXT PRIMARY KEY,revision INTEGER,evidence_revision INTEGER,body TEXT); CREATE TABLE venture_accounts(case_id TEXT PRIMARY KEY,encrypted_payload BLOB,masked_login_id TEXT,revision INTEGER,updated_at TEXT); CREATE TABLE venture_workflows(case_id TEXT PRIMARY KEY,revision INTEGER,body TEXT,updated_at TEXT);",
  );
  const record = { id: randomUUID(), revision: 0, sources: [], plans: [], tasks: [] };
  db.prepare("INSERT INTO studio_cases VALUES(?,?,?,?)").run(
    record.id,
    0,
    0,
    JSON.stringify(record),
  );
  const snapshot = inspectDatabase(db);
  db.close();
  const bytes = fs.readFileSync(file);
  assert.equal(bytes[18], 2);
  assert.deepEqual(fs.readdirSync(source), ["studio.sqlite"]);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(!path.isAbsolute(relative) && /^venture-cold-unit-[^\\/]+$/.test(relative));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, file, snapshot, bytes };
}
function captureScratch(t, action = () => {}) {
  const paths = [];
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (file, ...args) => {
    const result = mkdir(file, ...args);
    if (path.basename(String(file)).startsWith("venture-cold-backup-")) {
      paths.push(String(file));
      action(String(file));
    }
    return result;
  });
  syncBuiltinESMExports();
  return paths;
}
function withCold(t, run) {
  const data = fixture(t);
  const scratch = captureScratch(t);
  const cold = prepareColdSource(data.source);
  assert.ok(cold);
  try {
    run(data, cold, scratch);
  } finally {
    cold.close();
  }
  assert.equal(scratch.length, 1);
  assert.equal(fs.existsSync(scratch[0]), false);
}

test("cold WAL is inspected only through a private DELETE copy; source bytes and entries stay unchanged", (t) => {
  withCold(t, (data, cold, scratch) => {
    assert.deepEqual(inspectDatabase(cold.database), data.snapshot);
    assert.equal(cold.database.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    assert.equal(fs.readFileSync(path.join(scratch[0], "studio.sqlite"))[18], 1);
    cold.assertCurrent();
    assert.deepEqual(fs.readFileSync(data.file), data.bytes);
    assert.deepEqual(fs.readdirSync(data.source), ["studio.sqlite"]);
  });
});
for (const suffix of ["-wal", "-shm", "-journal"])
  test(`incomplete source ${suffix} refuses cold copy and leaves it untouched`, (t) => {
    const data = fixture(t);
    const scratch = captureScratch(t);
    fs.writeFileSync(data.file + suffix, "synthetic");
    assert.throws(() => prepareColdSource(data.source), { code: "SOURCE_WAL_NOT_READY" });
    assert.equal(scratch.length, 0);
    assert.equal(fs.readFileSync(data.file + suffix, "utf8"), "synthetic");
    assert.deepEqual(fs.readFileSync(data.file), data.bytes);
  });
test("a restarted app's new sidecars invalidate a prepared cold source", (t) => {
  withCold(t, (data, cold) => {
    const reopened = new DatabaseSync(data.file);
    try {
      reopened.prepare("SELECT count(*) FROM studio_cases").get();
      assert.throws(() => cold.assertCurrent(), { code: "SOURCE_WAL_CHANGED" });
    } finally {
      reopened.close();
    }
  });
});
test("a source sidecar created and removed between checks invalidates root metadata", (t) => {
  withCold(t, (data, cold) => {
    fs.writeFileSync(data.file + "-wal", "transient");
    fs.unlinkSync(data.file + "-wal");
    assert.throws(() => cold.assertCurrent(), { code: "SOURCE_WAL_CHANGED" });
  });
});
test("same database bytes with changed metadata cannot be accepted as a stable source", (t) => {
  withCold(t, (data, cold) => {
    const stat = fs.statSync(data.file);
    fs.utimesSync(data.file, stat.atime, new Date(stat.mtimeMs + 2000));
    assert.deepEqual(fs.readFileSync(data.file), data.bytes);
    assert.throws(() => cold.assertCurrent(), { code: "SOURCE_WAL_CHANGED" });
  });
});
test("an identical replacement database at the same pathname is rejected", (t) => {
  withCold(t, (data, cold) => {
    fs.renameSync(data.file, path.join(data.root, "previous.sqlite"));
    fs.writeFileSync(data.file, data.bytes);
    assert.throws(() => cold.assertCurrent(), { code: "SOURCE_WAL_CHANGED" });
  });
});
test("same-size source changes during the byte copy fail and clean only owned scratch", (t) => {
  const data = fixture(t);
  const scratch = captureScratch(t);
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    const count = read(...args);
    if (scratch.length && !changed && count > 100) {
      changed = true;
      const bytes = Buffer.from(data.bytes);
      bytes[bytes.length - 1] ^= 1;
      fs.writeFileSync(data.file, bytes);
    }
    return count;
  });
  syncBuiltinESMExports();
  assert.throws(() => prepareColdSource(data.source), { code: "FILE_CHANGED" });
  assert.equal(changed, true);
  assert.equal(scratch.length, 1);
  assert.equal(fs.existsSync(scratch[0]), false);
  assert.deepEqual(fs.readdirSync(data.source), ["studio.sqlite"]);
});
test("an incomplete main database cannot pass the scratch integrity and logical checks", (t) => {
  const data = fixture(t);
  const scratch = captureScratch(t);
  fs.truncateSync(data.file, data.bytes.length - 512);
  let cold;
  try {
    assert.throws(
      () => {
        cold = prepareColdSource(data.source);
      },
      { code: "DATABASE_INVALID" },
    );
  } finally {
    cold?.close();
  }
  assert.equal(scratch.length, 0);
  assert.deepEqual(fs.readdirSync(data.source), ["studio.sqlite"]);
});
test("scratch cleanup preserves unknown entries instead of recursively deleting them", (t) => {
  const data = fixture(t);
  const scratch = captureScratch(t, (directory) => {
    fs.writeFileSync(path.join(directory, "unowned-file"), "KEEP");
  });
  try {
    assert.throws(() => prepareColdSource(data.source), { code: "SCRATCH_CHANGED" });
    assert.equal(fs.readFileSync(path.join(scratch[0], "unowned-file"), "utf8"), "KEEP");
    assert.deepEqual(fs.readFileSync(data.file), data.bytes);
  } finally {
    // Only these exact synthetic files, inside the captured direct temp child, are ours.
    const directory = scratch[0];
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    for (const name of ["studio.sqlite", "unowned-file"])
      if (fs.existsSync(path.join(directory, name))) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});
test(
  "post-COMPLETE source changes remove our completion marker and preserve original bytes",
  { timeout: 60000 },
  async (t) => {
    const data = fixture(t);
    const target = path.join(data.root, "backup");
    const scratch = captureScratch(t);
    const open = fs.openSync;
    const write = fs.writeSync;
    let markerDescriptor;
    let changed = false;
    t.mock.method(fs, "openSync", (file, ...args) => {
      const result = open(file, ...args);
      if (file === path.join(target, "COMPLETE.json")) markerDescriptor = result;
      return result;
    });
    t.mock.method(fs, "writeSync", (fd, ...args) => {
      const result = write(fd, ...args);
      if (fd === markerDescriptor && !changed) {
        changed = true;
        const stat = fs.statSync(data.file);
        fs.utimesSync(data.file, stat.atime, new Date(stat.mtimeMs + 2000));
      }
      return result;
    });
    syncBuiltinESMExports();
    await assert.rejects(backupLocalData(data.source, target), { code: "SOURCE_WAL_CHANGED" });
    assert.equal(changed, true);
    assert.equal(fs.existsSync(path.join(target, "COMPLETE.json")), false);
    assert.deepEqual(fs.readFileSync(data.file), data.bytes);
    assert.deepEqual(fs.readdirSync(data.source), ["studio.sqlite"]);
    assert.equal(scratch.length, 1);
    assert.equal(fs.existsSync(scratch[0]), false);
  },
);

test(
  "app restart during scratch cleanup is caught after cleanup and removes COMPLETE",
  { timeout: 60000 },
  async (t) => {
    const data = fixture(t);
    const target = path.join(data.root, "backup");
    const scratch = captureScratch(t);
    const remove = fs.rmdirSync;
    let changed = false;
    t.mock.method(fs, "rmdirSync", (directory, ...args) => {
      const result = remove(directory, ...args);
      if (scratch.includes(String(directory))) {
        changed = true;
        fs.writeFileSync(data.file + "-wal", "synthetic app restart");
      }
      return result;
    });
    syncBuiltinESMExports();
    await assert.rejects(backupLocalData(data.source, target), { code: "SOURCE_WAL_CHANGED" });
    assert.equal(changed, true);
    assert.equal(fs.existsSync(path.join(target, "COMPLETE.json")), false);
    assert.deepEqual(fs.readFileSync(data.file), data.bytes);
    assert.equal(fs.existsSync(scratch[0]), false);
  },
);
