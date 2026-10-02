import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  additionalValidationScope, createAdditionalValidationApproval,
  inspectAdditionalValidationRecords as inspect, prepareAdditionalValidationRecord as prepare,
} from "./operational-validation-additional-records.mjs";

const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clone = (v) => JSON.parse(JSON.stringify(v));
function evidence() {
  // File protocol fixture; these values are NOT a core DB completion attestation.
  return {
    original: { instanceId: "11111111-1111-4111-8111-111111111111", recordCount: 14, headDigest: "a".repeat(64) },
    selection: { runId: "22222222-2222-4222-8222-222222222222", runDigest: "b".repeat(64), approvalBindingDigest: "c".repeat(64) },
    checkpoint: { runRevision: 10, snapshotDigest: "d".repeat(64), budgetRevision: 5,
      budgetHeadDigest: "e".repeat(64), recognizedUnits: "227485", heldUnits: "0" },
    databaseDigest: "f".repeat(64),
  };
}
function history() {
  const e = evidence(), records = [createAdditionalValidationApproval(e)];
  for (const stage of ["policy", "reserve", "approve-transmission", "execute", "continue-review"]) {
    for (const kind of ["command", "receipt"]) records.push(prepare(e, records, stage, kind, {
      fixture: stage, kind, identity: stage + "-" + kind,
    }).record);
  }
  return { e, records };
}
test("fixed additional scope preserves cumulative USD15 and exactly one further pair without IO or permission", () => {
  const e = evidence(), approval = createAdditionalValidationApproval(e);
  assert.deepEqual(approval.payload.scope, {
    approvalVersion: 1, approvalId: "venturepass-operational-validation-v2-20261002",
    engineVersion: "plan-observation-v2", generationCalls: 1, reviewCalls: 1,
    totalGenerationCalls: 2, totalReviewCalls: 2, automaticRetryAllowed: false,
    budgetAction: "keep-existing-budget", currency: "USD", unitScale: 6, capUnits: "15000000",
  });
  assert.deepEqual(approval.payload.checkpoint, e.checkpoint);
  assert.equal(approval.previous, e.original.headDigest);
  assert.deepEqual(inspect(e, []), {
    approval: null, completedStages: 0, pendingStage: null,
    steps: Object.fromEntries(["policy", "reserve", "approve-transmission", "execute", "continue-review"]
      .map((s) => [s, { command: null, receipt: null }])),
    headDigest: e.original.headDigest, recordCount: 0, ledgerAudited: false, transmissionAllowed: false,
  });
  assert.equal(inspect(e, [approval]).ledgerAudited, false);
});
test("all suffix prefixes are readable and preserve predecessor/order without any original registration or budget reset", () => {
  const { e, records } = history();
  for (let n = 1; n <= records.length; n++) {
    const s = inspect(e, records.slice(0, n));
    assert.equal(s.recordCount, n);
    assert.equal(s.headDigest, hash(records[n - 1]));
    assert.equal(s.completedStages, Math.floor((n - 1) / 2));
    assert.equal(s.transmissionAllowed, false);
  }
  assert.equal(records.length, 11);
  assert.equal(inspect(e, records).completedStages, 5);
  assert.equal(inspect(e, records).pendingStage, null);
});
test("exact original command/receipt recovery precedes later suffix progress and never creates another record", () => {
  const { e, records } = history(), originalBytes = JSON.stringify(records);
  for (const record of records.slice(1)) {
    const result = prepare(e, records, record.stage, record.kind, record.payload);
    assert.equal(result.status, "already-recorded");
    assert.equal(JSON.stringify(result.record), JSON.stringify(record));
    assert.equal(result.transmissionAllowed, false);
    assert.throws(() => prepare(e, records, record.stage, record.kind, { ...record.payload, identity: "new" }),
      /VALIDATION_ADDITIONAL_COMMAND_CONFLICT/);
  }
  assert.equal(JSON.stringify(records), originalBytes);
});
test("input, scope, parsed payload and proposals have independent references", () => {
  const e = evidence(), approval = createAdditionalValidationApproval(e), original = clone(approval);
  e.checkpoint.recognizedUnits = "0";
  additionalValidationScope().capUnits = "1";
  assert.deepEqual(approval, original);
  const parsed = inspect(evidence(), [approval]);
  parsed.approval.checkpoint.recognizedUnits = "1";
  assert.deepEqual(approval, original);
  const payload = { nested: { id: "same" } };
  const command = prepare(evidence(), [approval], "policy", "command", payload);
  payload.nested.id = "changed";
  assert.equal(command.record.payload.nested.id, "same");
});

const badEvidence = [
  ["missing original", (e) => { delete e.original; }],
  ["unknown property", (e) => { e.dispatchAllowed = true; }],
  ["different evidence encoding", (e) => { const v = e.selection; delete e.selection; e.selection = v; }],
  ["missing selection version identity", (e) => { delete e.selection.approvalBindingDigest; }],
  ["invalid original UUID", (e) => { e.original.instanceId = "-".repeat(36); }],
  ["original count too low", (e) => { e.original.recordCount = 11; }],
  ["original count too high", (e) => { e.original.recordCount = 17; }],
  ["incomplete original run", (e) => { e.checkpoint.runRevision = 9; }],
  ["unsettled original hold", (e) => { e.checkpoint.heldUnits = "1"; }],
  ["consumed cumulative budget", (e) => { e.checkpoint.recognizedUnits = "15000000"; }],
  ["over cumulative budget", (e) => { e.checkpoint.recognizedUnits = "15000001"; }],
  ["negative recognized cost", (e) => { e.checkpoint.recognizedUnits = "-1"; }],
  ["noncanonical units", (e) => { e.checkpoint.recognizedUnits = "0227485"; }],
  ["fresh budget", (e) => { e.checkpoint.budgetRevision = 0; }],
  ["fractional budget revision", (e) => { e.checkpoint.budgetRevision = 1.1; }],
  ["unhashed core snapshot", (e) => { e.databaseDigest = ""; }],
  ["secret payload", (e) => { e.secret = "private"; }],
];
for (const [name, change] of badEvidence) test("rejects baseline " + name, () => {
  const e = evidence(); change(e);
  assert.throws(() => createAdditionalValidationApproval(e), /VALIDATION_ADDITIONAL_RECORD_INVALID/);
});
const badRecord = [
  ["reinitialized budget", (r) => { r[0].payload.scope.budgetAction = "initialize-proposed-budget"; }],
  ["changed cap", (r) => { r[0].payload.scope.capUnits = "30000000"; }],
  ["changed engine", (r) => { r[0].payload.scope.engineVersion = "plan-observation-v1"; }],
  ["third approval", (r) => { r[0].payload.scope.approvalId += "-again"; }],
  ["extra generation", (r) => { r[0].payload.scope.generationCalls = 2; }],
  ["automatic retries", (r) => { r[0].payload.scope.automaticRetryAllowed = true; }],
  ["foreign original run", (r) => { r[0].payload.selection.runDigest = "0".repeat(64); }],
  ["foreign original checkpoint", (r) => { r[0].payload.checkpoint.recognizedUnits = "0"; }],
  ["foreign DB digest", (r) => { r[0].payload.databaseDigest = "0".repeat(64); }],
  ["reordered stages", (r) => { r[1].stage = "reserve"; }],
  ["old campaign", (r) => { r[1].campaign = 1; }],
  ["new registration", (r) => { r[1].stage = "register"; }],
  ["duplicate approval", (r) => { r[1] = clone(r[0]); }],
  ["receipt without command", (r) => { r[1].kind = "receipt"; }],
  ["replacement pending command", (r) => { r[2].kind = "command"; }],
  ["trailing run", (r) => { r.push(clone(r[1])); }],
  ["extra field", (r) => { r[1].allowed = true; }],
  ["array payload", (r) => { r[1].payload = []; }],
  ["secret in historical payload", (r) => { r[1].payload = { api_key: "private" }; }],
];
for (const [name, change] of badRecord) test("rejects rehashed suffix " + name, () => {
  const { e, records } = history(); change(records);
  // Rehash every descendant; local valid hashes cannot substitute for exact scope/origin/order.
  for (let i = 1; i < records.length; i++) records[i].previous = hash(records[i - 1]);
  assert.throws(() => inspect(e, records), /VALIDATION_ADDITIONAL_RECORD_INVALID/);
});
test("requires approval and exact command-before-receipt ordering, disallows arbitrary/restarted stages", () => {
  const e = evidence(), r = [createAdditionalValidationApproval(e)];
  for (const [records, stage, kind] of [
    [[], "policy", "command"], [r, "policy", "receipt"], [r, "reserve", "command"],
    [r, "register", "command"], [r, "policy", "policy-rejection"],
  ]) assert.throws(() => prepare(e, records, stage, kind, {}), /VALIDATION_ADDITIONAL_RECORD_INVALID/);
  assert.throws(() => prepare(e, r, "policy", "command", { text: "sk-notARealKeyButForbiddenPattern1234" }));
});
test("invalid predecessor and missing/partial suffix cannot silently become a new campaign", () => {
  const { e, records } = history();
  records[2].previous = "0".repeat(64);
  assert.throws(() => inspect(e, records));
  assert.throws(() => inspect(e, records.slice(1)));
  assert.throws(() => inspect(e, null));
  assert.throws(() => inspect(e, [null]));
});
test("overlarge payload is rejected before a record proposal is made", () => {
  const e = evidence(), r = [createAdditionalValidationApproval(e)];
  assert.throws(() => prepare(e, r, "policy", "command", { text: "x".repeat(8 * 1024 * 1024) }));
});
