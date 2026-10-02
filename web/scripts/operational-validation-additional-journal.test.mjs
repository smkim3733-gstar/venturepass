import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  acquireValidationJournal, acquireAdditionalValidationJournal, inspectValidationJournal,
} from "./operational-validation-journal.mjs";
import { operationalValidationProfile } from "./operational-validation.mjs";

const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const copy = (v) => JSON.parse(JSON.stringify(v));
function fixture(t, { continuation = false, complete = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "venture-additional-journal-")), journals = [];
  const profile = { ...operationalValidationProfile(), directory: path.join(root, "data"), controlDirectory: path.join(root, "control") };
  const inner = path.join(profile.directory, "operational-journal");
  t.after(() => {
    for (const j of journals) j.close();
    const rel = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(rel.startsWith("venture-additional-journal-") && !rel.includes("..") && !path.isAbsolute(rel));
    rmSync(root, { recursive: true, force: true });
  });
  const old = acquireValidationJournal(profile); journals.push(old);
  old.initialize((directory) => {
    mkdirSync(path.join(directory, "quality-evaluation"));
    // File-layer identity fixture only; never an actual core ledger or approval.
    writeFileSync(path.join(directory, "quality-evaluation", "quality.sqlite"), "file-identity-fixture");
  });
  for (const stage of ["register", "policy", "reserve", "approve-transmission"]) {
    if (stage === "policy") {
      old.prepare(stage, { command: { clientRequestId: "original-rejected-policy" } });
      old.rejectPendingPolicy({ explanation: "fixture-only" });
    }
    old.prepare(stage, { command: { clientRequestId: "old-" + stage } });
    old.acknowledge(stage, { recordDigest: hash(stage) });
  }
  const selection = { runId: "22222222-2222-4222-8222-222222222222", runDigest: "b".repeat(64), approvalBindingDigest: "c".repeat(64) };
  const checkpoint = { runRevision: 10, snapshotDigest: "d".repeat(64), budgetRevision: 5, budgetHeadDigest: "e".repeat(64), recognizedUnits: "227485", heldUnits: "0" };
  old.prepare("execute", { selection, automaticRetryAllowed: false });
  if (complete) old.acknowledge("execute", continuation ? { ...checkpoint, runRevision: 5 } : checkpoint);
  if (continuation) {
    old.prepare("continue-review", { selection, automaticRetryAllowed: false });
    old.acknowledge("continue-review", checkpoint);
  }
  old.close();
  const original = Object.fromEntries(readdirSync(inner).map((name) => [name, readFileSync(path.join(inner, name))]));
  const open = () => { const j = acquireAdditionalValidationJournal(profile); journals.push(j); return j; };
  const j = open();
  const evidence = { original: j.readOriginalAnchor(), selection, checkpoint, databaseDigest: "f".repeat(64) };
  return { root, profile, inner, j, open, evidence, original };
}
function originalUnchanged(f) {
  for (const [name, bytes] of Object.entries(f.original)) for (const dir of [f.inner, f.profile.controlDirectory])
    assert.deepEqual(readFileSync(path.join(dir, name)), bytes);
}
function child(profile, code) {
  const moduleUrl = new URL("./operational-validation-journal.mjs", import.meta.url).href;
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    'import { acquireAdditionalValidationJournal } from ' + JSON.stringify(moduleUrl) + ';\n' +
    'const profile=' + JSON.stringify(profile) + ';\n' + code,
  ], { encoding: "utf8", timeout: 10000, windowsHide: true });
}

for (const continuation of [false, true]) test("appends exactly one suffix after original completion, continuation=" + continuation, (t) => {
  const f = fixture(t, { continuation }), e = copy(f.evidence), originalCount = Object.keys(f.original).length;
  const approval = f.j.appendAdditionalApproval(e);
  assert.equal(approval.scope.capUnits, "15000000");
  assert.deepEqual(f.j.appendAdditionalApproval(e), approval);
  assert.deepEqual(f.j.readOriginalAnchor(), e.original);
  const replay = { selection: e.selection, automaticRetryAllowed: false };
  if (continuation) {
    assert.deepEqual(f.j.prepare("continue-review", replay), replay);
    assert.throws(() => f.j.prepare("continue-review", {
      ...replay, selection: { ...e.selection, runDigest: "0".repeat(64) },
    }), /COMMAND_CONFLICT/);
  } else assert.throws(() => f.j.prepare("continue-review", replay), /STAGE_ORDER/);
  for (const stage of ["policy", "reserve", "approve-transmission", "execute", "continue-review"]) {
    const command = { command: { clientRequestId: "new-" + stage } };
    f.j.prepareAdditional(stage, command);
    f.j.acknowledgeAdditional(stage, { recordDigest: hash(command) });
  }
  assert.equal(f.j.readAdditionalState().completedStages, 5);
  assert.equal(f.j.readAdditionalState().ledgerAudited, false);
  assert.equal(f.j.readAdditionalState().transmissionAllowed, false);
  assert.equal(readdirSync(f.inner).length, originalCount + 11);
  originalUnchanged(f);
  f.j.close();
  // Original CLI/session cannot interpret the extension as another original run.
  assert.equal(inspectValidationJournal(f.profile).state, "blocked");
  const reopened = f.open();
  assert.equal(reopened.readAdditionalState().completedStages, 5);
  assert.deepEqual(reopened.readOriginalAnchor(), e.original);
  assert.deepEqual(reopened.readStep("execute").command.selection, e.selection);
  assert.throws(() => reopened.appendAdditionalApproval({ ...e, databaseDigest: "0".repeat(64) }), /COMMAND_CONFLICT/);
  originalUnchanged(f);
});

test("pending original execute cannot serve as completed baseline", (t) => {
  const f = fixture(t, { complete: false });
  assert.throws(() => f.j.appendAdditionalApproval(f.evidence), /JOURNAL_INVALID/);
  assert.equal(readdirSync(f.inner).length, Object.keys(f.original).length);
});
for (const field of ["original", "selection", "checkpoint"]) test("foreign original " + field + " is rejected before append", (t) => {
  const f = fixture(t), e = copy(f.evidence);
  if (field === "original") e.original.headDigest = "0".repeat(64);
  if (field === "selection") e.selection.runDigest = "0".repeat(64);
  if (field === "checkpoint") e.checkpoint.recognizedUnits = "0";
  assert.throws(() => f.j.appendAdditionalApproval(e), /JOURNAL_INVALID/);
  assert.equal(readdirSync(f.inner).length, Object.keys(f.original).length);
  originalUnchanged(f);
});
test("extended interface cannot initialize or reset even an absent campaign", (t) => {
  const f = fixture(t);
  assert.throws(() => f.j.initialize(() => assert.fail("no DB callback")), /PARTIAL_STATE/);
  f.j.close();
  const newProfile = { ...f.profile, directory: path.join(f.root, "absent"), controlDirectory: path.join(f.root, "absent-control") };
  const j = acquireAdditionalValidationJournal(newProfile);
  try { assert.throws(() => j.initialize(() => assert.fail("no DB callback")), /PARTIAL_STATE/); }
  finally { j.close(); }
});
test("same lease excludes a second process without age/PID takeover", (t) => {
  const f = fixture(t);
  f.j.appendAdditionalApproval(f.evidence);
  const result = child(f.profile, "acquireAdditionalValidationJournal(profile);");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BUSY/);
  originalUnchanged(f);
});
test("original pending command/receipt resumes across processes; changed nonce never replaces it", (t) => {
  const f = fixture(t), command = { command: { clientRequestId: "new-policy-nonce" } };
  f.j.appendAdditionalApproval(f.evidence);
  f.j.prepareAdditional("policy", command);
  const before = readFileSync(path.join(f.inner, "15.json"));
  f.j.close();
  const result = child(f.profile, 'const j=acquireAdditionalValidationJournal(profile);' +
    'const c=j.readAdditionalState().steps.policy.command;' +
    'if(c.command.clientRequestId!=="new-policy-nonce")throw Error("changed");' +
    'j.acknowledgeAdditional("policy",{recordDigest:"' + "7".repeat(64) + '"});j.close();');
  assert.equal(result.status, 0, result.stderr);
  const j = f.open();
  assert.deepEqual(j.prepareAdditional("policy", command), command);
  assert.throws(() => j.prepareAdditional("policy", { command: { clientRequestId: "replacement" } }), /COMMAND_CONFLICT/);
  assert.deepEqual(readFileSync(path.join(f.inner, "15.json")), before);
  assert.equal(j.readAdditionalState().completedStages, 1);
  originalUnchanged(f);
});
for (const operation of ["approval", "command", "receipt"]) test("unpaired " + operation + " after fsync failure stays quarantined with original bytes", (t) => {
  const f = fixture(t);
  if (operation !== "approval") f.j.appendAdditionalApproval(f.evidence);
  if (operation === "receipt") f.j.prepareAdditional("policy", { id: "original" });
  const realSync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", () => { throw Error("disk interruption"); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => operation === "approval" ? f.j.appendAdditionalApproval(f.evidence) :
      operation === "command" ? f.j.prepareAdditional("policy", { id: "original" }) :
        f.j.acknowledgeAdditional("policy", { committed: true }));
  } finally { fs.fsyncSync = realSync; syncBuiltinESMExports(); }
  assert.throws(() => f.j.readAdditionalState(), /PARTIAL_STATE/);
  assert.throws(() => f.j.appendAdditionalApproval(f.evidence), /PARTIAL_STATE/);
  assert.equal(readdirSync(f.profile.controlDirectory).length, readdirSync(f.inner).length + 1);
  originalUnchanged(f);
});
test("durable pair followed by lost caller response recovers exact record, not another append", (t) => {
  const f = fixture(t);
  f.j.appendAdditionalApproval(f.evidence);
  f.j.prepareAdditional("policy", { id: "same-command" });
  const before = readdirSync(f.inner).map((name) => readFileSync(path.join(f.inner, name)));
  f.j.close();
  const j = f.open();
  j.appendAdditionalApproval(f.evidence);
  j.prepareAdditional("policy", { id: "same-command" });
  assert.deepEqual(readdirSync(f.inner).map((name) => readFileSync(path.join(f.inner, name))), before);
});
for (const corruption of ["scope", "original-cost", "campaign", "predecessor"]) test("matching two-sided copies still reject " + corruption + " corruption", (t) => {
  const f = fixture(t);
  f.j.appendAdditionalApproval(f.evidence);
  f.j.prepareAdditional("policy", { id: "same" });
  const index = corruption === "scope" || corruption === "original-cost" ? 14 : 15;
  const name = index + ".json";
  const record = JSON.parse(readFileSync(path.join(f.inner, name), "utf8"));
  if (corruption === "scope") record.payload.scope.capUnits = "30000000";
  if (corruption === "original-cost") record.payload.checkpoint.recognizedUnits = "0";
  if (corruption === "campaign") record.campaign = 3;
  if (corruption === "predecessor") record.previous = "0".repeat(64);
  for (const dir of [f.inner, f.profile.controlDirectory]) {
    writeFileSync(path.join(dir, name), JSON.stringify(record) + "\n");
    if (index === 14) {
      const next = JSON.parse(readFileSync(path.join(dir, "15.json"), "utf8"));
      next.previous = hash(record);
      writeFileSync(path.join(dir, "15.json"), JSON.stringify(next) + "\n");
    }
  }
  assert.throws(() => f.j.readAdditionalState());
  originalUnchanged(f);
});

test("extension interface is read-only for the original campaign before any additional approval", (t) => {
  const f = fixture(t);
  const original = f.j.readStep("execute").command;
  assert.deepEqual(f.j.prepare("execute", original), original);
  assert.throws(() => f.j.prepare("continue-review", original), /STAGE_ORDER/);
  assert.equal(f.j.readAdditionalState(), null);
  assert.equal(readdirSync(f.inner).length, Object.keys(f.original).length);
  originalUnchanged(f);
});
