import { createHash } from "node:crypto";

// Pure, bounded record protocol for the one additional approval. No files, DB, clock,
// credential, runtime, or transmission authority. The future composition must independently
// audit the original DB and original journal before supplying this evidence.
const stages = ["policy", "reserve", "approve-transmission", "execute", "continue-review"];
const maxBytes = 8 * 1024 * 1024 - 1024;
const json = (v) => JSON.stringify(v);
const hash = (v) => createHash("sha256").update(json(v)).digest("hex");
const fail = () => { throw Error("VALIDATION_ADDITIONAL_RECORD_INVALID"); };
const same = (a, b) => json(a) === json(b);
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v, names) => object(v) && same(Object.keys(v), names);
const sha256 = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const units = (v) => typeof v === "string" && /^(0|[1-9][0-9]{0,14})$/.test(v);
function copy(v) {
  if (!object(v)) fail();
  const encoded = json(v);
  if (!encoded || Buffer.byteLength(encoded) > maxBytes ||
      /sk-[A-Za-z0-9_-]{16,}|"(?:authorization|api[_-]?key|password|secret|credential)"\s*:/i.test(encoded)) fail();
  return JSON.parse(encoded);
}
export function additionalValidationScope() {
  return {
    approvalVersion: 1,
    approvalId: "venturepass-operational-validation-v2-20261002",
    engineVersion: "plan-observation-v2",
    generationCalls: 1,
    reviewCalls: 1,
    totalGenerationCalls: 2,
    totalReviewCalls: 2,
    automaticRetryAllowed: false,
    budgetAction: "keep-existing-budget",
    currency: "USD",
    unitScale: 6,
    capUnits: "15000000",
  };
}
function baseline(value) {
  const v = copy(value);
  if (!keys(v, ["original", "selection", "checkpoint", "databaseDigest"]) ||
      !keys(v.original, ["instanceId", "recordCount", "headDigest"]) ||
      !uuid(v.original.instanceId) ||
      !Number.isSafeInteger(v.original.recordCount) ||
      v.original.recordCount < 12 || v.original.recordCount > 16 ||
      !sha256(v.original.headDigest) ||
      !keys(v.selection, ["runId", "runDigest", "approvalBindingDigest"]) ||
      !uuid(v.selection.runId) || !sha256(v.selection.runDigest) ||
      !sha256(v.selection.approvalBindingDigest) ||
      !keys(v.checkpoint, ["runRevision", "snapshotDigest", "budgetRevision",
        "budgetHeadDigest", "recognizedUnits", "heldUnits"]) ||
      v.checkpoint.runRevision !== 10 || !sha256(v.checkpoint.snapshotDigest) ||
      !Number.isSafeInteger(v.checkpoint.budgetRevision) || v.checkpoint.budgetRevision < 1 ||
      !sha256(v.checkpoint.budgetHeadDigest) || !units(v.checkpoint.recognizedUnits) ||
      v.checkpoint.heldUnits !== "0" ||
      BigInt(v.checkpoint.recognizedUnits) >= 15000000n || !sha256(v.databaseDigest)) fail();
  return v;
}
/** Proposed record only: evidence shape is not a core completion/settlement attestation. */
export function createAdditionalValidationApproval(evidence) {
  const b = baseline(evidence);
  return {
    previous: b.original.headDigest,
    campaign: 2,
    stage: "additional-approval",
    kind: "approval",
    payload: { scope: additionalValidationScope(), ...b },
  };
}
/** All records are from the extension suffix, never a rewritten copy of the original prefix. */
export function inspectAdditionalValidationRecords(evidence, values) {
  const approved = createAdditionalValidationApproval(evidence);
  if (!Array.isArray(values) || values.length > 11) fail();
  const records = values.map(copy);
  const steps = Object.fromEntries(stages.map((stage) => [stage, { command: null, receipt: null }]));
  let headDigest = approved.previous, completedStages = 0;
  for (const [index, record] of records.entries()) {
    if (index === 0) {
      if (!same(record, approved)) fail();
    } else {
      if (!keys(record, ["previous", "campaign", "stage", "kind", "payload"]) ||
          record.previous !== headDigest || record.campaign !== 2 ||
          record.stage !== stages[completedStages] || !object(record.payload)) fail();
      const step = steps[record.stage];
      if (record.kind === "command" && step.command === null) step.command = record.payload;
      else if (record.kind === "receipt" && step.command !== null) {
        step.receipt = record.payload;
        completedStages++;
      } else fail();
    }
    headDigest = hash(record);
  }
  return {
    approval: records.length ? records[0].payload : null,
    completedStages,
    pendingStage: steps[stages[completedStages]]?.command ? stages[completedStages] : null,
    steps,
    headDigest,
    recordCount: records.length,
    ledgerAudited: false,
    transmissionAllowed: false,
  };
}
/** Deterministic append proposal or exact original record. Never replace an uncertain command. */
export function prepareAdditionalValidationRecord(evidence, records, stage, kind, payload) {
  const state = inspectAdditionalValidationRecords(evidence, records), value = copy(payload);
  if (!state.approval || !stages.includes(stage) || !["command", "receipt"].includes(kind)) fail();
  const original = state.steps[stage][kind];
  if (original !== null) {
    if (!same(original, value)) throw Error("VALIDATION_ADDITIONAL_COMMAND_CONFLICT");
    // Preserve the original predecessor and bytes even after later steps have been recorded.
    return { status: "already-recorded", record: copy(records.find(
      (v) => v.stage === stage && v.kind === kind,
    )), ledgerAudited: false, transmissionAllowed: false };
  }
  if (stage !== stages[state.completedStages] ||
      kind !== (state.steps[stage].command === null ? "command" : "receipt")) fail();
  const record = { previous: state.headDigest, campaign: 2, stage, kind, payload: value };
  inspectAdditionalValidationRecords(evidence, [...records, record]);
  return { status: "append-required", record, ledgerAudited: false, transmissionAllowed: false };
}
