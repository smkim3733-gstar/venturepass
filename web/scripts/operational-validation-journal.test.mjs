import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import {
  acquireValidationJournal,
  inspectValidationJournal,
  validationJournalErrorCode,
} from "./operational-validation-journal.mjs";
import { operationalValidationProfile } from "./operational-validation.mjs";

const moduleUrl = new URL("./operational-validation-journal.mjs", import.meta.url).href;
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "venture-journal-test-"));
  const profile = {
    ...operationalValidationProfile(),
    directory: path.join(root, "data"),
    controlDirectory: path.join(root, "control"),
  };
  const cleanup = [];
  t.after(() => {
    for (const callback of cleanup) callback();
    const target = path.resolve(root),
      relative = path.relative(path.resolve(tmpdir()), target);
    assert.ok(
      !relative.startsWith("..") &&
        !path.isAbsolute(relative) &&
        relative.startsWith("venture-journal-test-"),
    );
    rmSync(target, { recursive: true, force: true });
  });
  return {
    root,
    profile,
    cleanup,
    db: path.join(profile.directory, "quality-evaluation", "quality.sqlite"),
    inner: path.join(profile.directory, "operational-journal"),
    lock: `${profile.controlDirectory}.lock`,
  };
}
// File identity fixture only; no API key, approval ledger or production runtime is installed.
function createEmptyDatabase(directory) {
  mkdirSync(path.join(directory, "quality-evaluation"));
  writeFileSync(path.join(directory, "quality-evaluation", "quality.sqlite"), "fixture-empty-db");
}
function initialized(t) {
  const f = fixture(t),
    journal = acquireValidationJournal(f.profile);
  journal.initialize(createEmptyDatabase);
  f.cleanup.push(() => journal.close());
  return { ...f, journal };
}
function child(profile, code) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { acquireValidationJournal } from ${JSON.stringify(moduleUrl)};
    const profile = ${JSON.stringify(profile)};
    ${code}
  `,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
}

test("one policy rejection preserves all original bytes and resumes a distinct command in the same chain", (t) => {
  const f = initialized(t), j = f.journal;
  j.prepare("register", { nonce: "registration" });
  j.acknowledge("register", { digest: "registered" });
  const original = { command: { clientRequestId: "original" } };
  j.prepare("policy", original);
  const originals = readdirSync(f.inner).map((name) => [name, readFileSync(path.join(f.inner, name))]);
  const evidence = { coreProof: "file-layer-fixture-only" };
  j.rejectPendingPolicy(evidence);
  j.rejectPendingPolicy(evidence);
  assert.deepEqual(j.readPolicyRejection(), { command: original, evidence });
  assert.deepEqual(j.readStep("policy"), { command: null, receipt: null });
  assert.throws(() => j.prepare("reserve", { tooEarly: true }), { code: "STAGE_ORDER" });
  j.close();
  assert.equal(inspectValidationJournal(f.profile).pendingStage, "policy");
  const resumed = acquireValidationJournal(f.profile);
  try {
    resumed.prepare("policy", { command: { clientRequestId: "replacement" } });
    assert.throws(() => resumed.rejectPendingPolicy({ different: true }), { code: "COMMAND_CONFLICT" });
    resumed.acknowledge("policy", { digest: "adopted" });
    for (const stage of ["reserve", "approve-transmission", "execute", "continue-review"]) {
      resumed.prepare(stage, { stage });
      resumed.acknowledge(stage, { confirmed: true });
    }
    for (const [name, bytes] of originals) {
      assert.deepEqual(readFileSync(path.join(f.inner, name)), bytes);
      assert.deepEqual(readFileSync(path.join(f.profile.controlDirectory, name)), bytes);
    }
    assert.equal(readdirSync(f.inner).length, 16);
  } finally { resumed.close(); }
  assert.equal(inspectValidationJournal(f.profile).completedStages, 6);
});

test("rejection cannot precede registration or replace an acknowledged policy", (t) => {
  const { journal: j } = initialized(t);
  assert.throws(() => j.rejectPendingPolicy({ proof: true }), { code: "STAGE_ORDER" });
  j.prepare("register", { register: true });
  j.acknowledge("register", { confirmed: true });
  assert.throws(() => j.rejectPendingPolicy({ proof: true }), { code: "STAGE_ORDER" });
  j.prepare("policy", { policy: true });
  j.acknowledge("policy", { confirmed: true });
  assert.throws(() => j.rejectPendingPolicy({ proof: true }), { code: "STAGE_ORDER" });
});

test("a missing rejection copy is quarantined instead of replaying a fresh command", (t) => {
  const f = initialized(t), j = f.journal;
  j.prepare("register", { register: true });
  j.acknowledge("register", { confirmed: true });
  j.prepare("policy", { policy: true });
  const original = readFileSync(path.join(f.inner, "04.json"));
  j.rejectPendingPolicy({ proof: "file-fixture" });
  rmSync(path.join(f.inner, "05.json"));
  assert.throws(() => j.prepare("policy", { replacement: true }), { code: "PARTIAL_STATE" });
  assert.deepEqual(readFileSync(path.join(f.inner, "04.json")), original);
  j.close();
  assert.equal(inspectValidationJournal(f.profile).reason, "PARTIAL_STATE");
});
test("status is read-only, never claims a budget audit, and accepts no alternate path/execute flags", (t) => {
  const f = fixture(t);
  assert.deepEqual(inspectValidationJournal(f.profile), {
    state: "virgin",
    completedStages: 0,
    pendingStage: null,
    ledgerAudited: false,
    transmissionAllowed: false,
  });
  assert.deepEqual(readdirSync(f.root), []);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./operational-validation.mjs", import.meta.url)),
      "execute",
      "--directory=elsewhere",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).reason, "UNSUPPORTED_COMMAND");
});
test("first initialization binds the same database and can reopen without another budget initialization", (t) => {
  const { profile, journal } = initialized(t);
  journal.close();
  assert.equal(inspectValidationJournal(profile).state, "initialized");
  const resumed = acquireValidationJournal(profile);
  let calls = 0;
  try {
    assert.throws(() => resumed.initialize(() => calls++), { code: "PARTIAL_STATE" });
  } finally {
    resumed.close();
  }
  assert.equal(calls, 0);
});
test("another process cannot initialize or prepare while an owner holds the lease", (t) => {
  const f = initialized(t);
  const result = child(
    f.profile,
    `
    try { acquireValidationJournal(profile); process.exitCode = 9; }
    catch (e) { process.stdout.write(e.code); }
  `,
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "BUSY");
  assert.equal(inspectValidationJournal(f.profile).reason, "BUSY");
});
test("original command survives exit after the database committed but before its receipt was journaled", (t) => {
  const f = initialized(t),
    nonce = randomUUID();
  const command = { clientRequestId: nonce, expectedVersion: 0, sourceDigest: "a".repeat(64) };
  f.journal.prepare("register", command);
  // Simulates a durable DB receipt written after prepare, with its response lost to this process.
  const receipt = { clientRequestId: nonce, version: 1 };
  writeFileSync(path.join(f.root, "committed-receipt.json"), JSON.stringify(receipt));
  f.journal.close();
  assert.equal(inspectValidationJournal(f.profile).pendingStage, "register");
  const result = child(
    f.profile,
    `
    import { readFileSync } from "node:fs";
    const j = acquireValidationJournal(profile);
    const original = j.readStep("register");
    const saved = JSON.parse(readFileSync(${JSON.stringify(path.join(f.root, "committed-receipt.json"))}, "utf8"));
    if (original.command.clientRequestId !== saved.clientRequestId || original.receipt !== null) process.exitCode = 9;
    j.acknowledge("register", saved);
    j.close();
  `,
  );
  assert.equal(result.status, 0, result.stderr);
  const resumed = acquireValidationJournal(f.profile);
  try {
    assert.deepEqual(resumed.readStep("register"), { command, receipt });
    assert.deepEqual(resumed.prepare("register", command), command);
    assert.throws(
      () => resumed.prepare("register", { ...command, clientRequestId: randomUUID() }),
      { code: "COMMAND_CONFLICT" },
    );
    assert.throws(() => resumed.acknowledge("register", { ...receipt, version: 2 }), {
      code: "COMMAND_CONFLICT",
    });
  } finally {
    resumed.close();
  }
});
test("stage ordering and immutable replay retain exactly one command per phase", (t) => {
  const f = initialized(t);
  assert.throws(() => f.journal.prepare("policy", {}), { code: "STAGE_ORDER" });
  for (const stage of ["register", "policy", "reserve", "approve-transmission"]) {
    const command = { clientRequestId: randomUUID(), kind: stage };
    f.journal.prepare(stage, command);
    assert.deepEqual(f.journal.prepare(stage, command), command);
    f.journal.acknowledge(stage, { committed: command.clientRequestId });
  }
  assert.equal(readdirSync(f.profile.controlDirectory).length, 10);
  f.journal.close();
  assert.equal(inspectValidationJournal(f.profile).completedStages, 4);
  assert.equal(inspectValidationJournal(f.profile).transmissionAllowed, false);
});
for (const lost of ["db", "directory", "control", "inner"]) {
  test(`loss of ${lost} after initialization cannot create a fresh budget`, (t) => {
    const f = initialized(t);
    f.journal.close();
    const target = {
      db: f.db,
      directory: f.profile.directory,
      control: f.profile.controlDirectory,
      inner: f.inner,
    }[lost];
    assert.ok(path.relative(f.root, target) && !path.relative(f.root, target).startsWith(".."));
    rmSync(target, { recursive: true });
    assert.equal(inspectValidationJournal(f.profile).reason, "PARTIAL_STATE");
    const j = acquireValidationJournal(f.profile);
    try {
      assert.throws(() => j.initialize(() => assert.fail("must not create DB")), {
        code: "PARTIAL_STATE",
      });
    } finally {
      j.close();
    }
  });
}
test("replaced database with identical bytes is blocked by persisted file identity", (t) => {
  const f = initialized(t);
  f.journal.close();
  const bytes = readFileSync(f.db);
  renameSync(f.db, `${f.db}.original`);
  writeFileSync(f.db, bytes);
  assert.equal(inspectValidationJournal(f.profile).reason, "DATABASE_CHANGED");
});
test("changed cap or directory cannot reuse an existing approval journal", (t) => {
  const f = initialized(t);
  f.journal.close();
  assert.equal(
    inspectValidationJournal({ ...f.profile, capUnits: "30000000" }).reason,
    "INVALID_PROFILE",
  );
  assert.equal(
    inspectValidationJournal({ ...f.profile, directory: path.join(f.root, "other") }).reason,
    "PARTIAL_STATE",
  );
});
test("interruption in empty DB initialization leaves a quarantined history, never a virgin budget", (t) => {
  const f = fixture(t),
    j = acquireValidationJournal(f.profile);
  try {
    assert.throws(() =>
      j.initialize((directory) => {
        createEmptyDatabase(directory);
        throw new Error("interrupted");
      }),
    );
  } finally {
    j.close();
  }
  assert.equal(inspectValidationJournal(f.profile).reason, "PARTIAL_STATE");
});
test("abrupt owner exit leaves an exclusive lease requiring reconciliation, never an automatic takeover", (t) => {
  const f = fixture(t);
  const result = child(f.profile, `acquireValidationJournal(profile); process.exit(7);`);
  assert.equal(result.status, 7);
  assert.equal(inspectValidationJournal(f.profile).reason, "BUSY");
  assert.throws(() => acquireValidationJournal(f.profile), { code: "BUSY" });
});
test("fsync failure between witness and database-side copy blocks the callback boundary", (t) => {
  const f = initialized(t);
  const realSync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", () => {
    throw new Error("simulated disk failure");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => f.journal.prepare("register", { clientRequestId: randomUUID() }));
  } finally {
    fs.fsyncSync = realSync;
    syncBuiltinESMExports();
  }
  f.journal.close();
  assert.equal(inspectValidationJournal(f.profile).reason, "PARTIAL_STATE");
  assert.equal(readdirSync(f.profile.controlDirectory).length, 3);
  assert.equal(readdirSync(f.inner).length, 2);
});
test("truncated, edited or unpaired records never become an empty/ready journal", (t) => {
  const f = initialized(t);
  f.journal.prepare("register", { clientRequestId: randomUUID() });
  f.journal.close();
  const witness = path.join(f.profile.controlDirectory, "02.json");
  writeFileSync(witness, readFileSync(witness).subarray(0, 20));
  assert.equal(inspectValidationJournal(f.profile).reason, "JOURNAL_INVALID");
});
test("invalid predecessor is rejected even if both copies match", (t) => {
  const f = initialized(t);
  f.journal.prepare("register", { clientRequestId: randomUUID() });
  f.journal.close();
  const value = JSON.parse(readFileSync(path.join(f.inner, "02.json"), "utf8"));
  value.previous = "0".repeat(64);
  for (const dir of [f.inner, f.profile.controlDirectory])
    writeFileSync(path.join(dir, "02.json"), JSON.stringify(value) + "\n");
  assert.equal(inspectValidationJournal(f.profile).reason, "JOURNAL_INVALID");
});
test("hardlinked journal and directory aliases cannot redirect reads or writes", (t) => {
  const f = initialized(t);
  f.journal.close();
  linkSync(path.join(f.inner, "00.json"), path.join(f.root, "alias.json"));
  assert.equal(inspectValidationJournal(f.profile).state, "blocked");
  const aliased = path.join(f.root, "control-alias");
  symlinkSync(f.profile.controlDirectory, aliased, "junction");
  assert.equal(
    inspectValidationJournal({ ...f.profile, controlDirectory: aliased }).state,
    "blocked",
  );
});
test("sensitive payloads and arbitrary errors never enter records or safe output", (t) => {
  const f = initialized(t);
  for (const payload of [
    { apiKey: "private" },
    { nested: { Authorization: "private" } },
    { message: "sk-syntheticSecretNotAnActualKey12345" },
  ])
    assert.throws(() => f.journal.prepare("register", payload), { code: "SENSITIVE_PAYLOAD" });
  assert.equal(readdirSync(f.inner).length, 2);
  assert.equal(
    validationJournalErrorCode(new Error("raw provider error containing a credential")),
    "IO_UNCONFIRMED",
  );
  f.journal.close();
  assert.throws(() => f.journal.readStep("register"), { code: "CLOSED" });
});
