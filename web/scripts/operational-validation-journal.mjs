import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { readSafe, safePath, samePath, sha, within } from "./local-data-files.mjs";
import {
  createAdditionalValidationApproval,
  inspectAdditionalValidationRecords,
  prepareAdditionalValidationRecord,
} from "./operational-validation-additional-records.mjs";

// Local orchestration journal only. It does not grant approval, open SQLite, or send requests.
// The production driver must validate core receipts/ledger heads before acknowledging a step.
const stages = [
  "register",
  "policy",
  "reserve",
  "approve-transmission",
  "execute",
  "continue-review",
];
const maxBytes = 8 * 1024 * 1024;
const failures = new Set([
  "INVALID_PROFILE",
  "BUSY",
  "PARTIAL_STATE",
  "JOURNAL_INVALID",
  "DATABASE_CHANGED",
  "COMMAND_CONFLICT",
  "STAGE_ORDER",
  "CLOSED",
  "SENSITIVE_PAYLOAD",
  "IO_UNCONFIRMED",
]);
export class ValidationJournalError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new ValidationJournalError(code);
};
export function validationJournalErrorCode(error) {
  return error instanceof ValidationJournalError && failures.has(error.code)
    ? error.code
    : "IO_UNCONFIRMED";
}
const json = (value) => JSON.stringify(value);
const hash = (value) => sha(Buffer.from(json(value)));
function exists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function profilePaths(profile) {
  if (
    profile?.approvalId !== "venturepass-operational-validation-20260928" ||
    profile.capUnits !== "15000000" ||
    profile.currency !== "USD" ||
    profile.unitScale !== 6 ||
    typeof profile.directory !== "string" ||
    typeof profile.controlDirectory !== "string" ||
    !path.isAbsolute(profile.directory) ||
    !path.isAbsolute(profile.controlDirectory) ||
    within(profile.directory, profile.controlDirectory) ||
    within(profile.controlDirectory, profile.directory) ||
    !samePath(path.dirname(profile.directory), path.dirname(profile.controlDirectory))
  )
    fail("INVALID_PROFILE");
  const directory = path.resolve(profile.directory),
    control = path.resolve(profile.controlDirectory);
  return {
    directory,
    control,
    journal: path.join(directory, "operational-journal"),
    db: path.join(directory, "quality-evaluation", "quality.sqlite"),
    lock: `${control}.lock`,
    binding: {
      schemaVersion: 1,
      approvalId: profile.approvalId,
      directory,
      controlDirectory: control,
      currency: "USD",
      unitScale: 6,
      capUnits: "15000000",
      generationCalls: 1,
      reviewCalls: 1,
      automaticRetryAllowed: false,
    },
  };
}
function read(file) {
  const bytes = readSafe(file, maxBytes, null, true).bytes;
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("JOURNAL_INVALID");
  }
  // Require our exact encoding: trailing/partial data or silent truncation is not repaired.
  if (!bytes.equals(Buffer.from(json(value) + "\n"))) fail("JOURNAL_INVALID");
  return value;
}
function write(file, value) {
  const bytes = Buffer.from(json(value) + "\n");
  if (bytes.length > maxBytes) fail("JOURNAL_INVALID");
  safePath(path.dirname(file), "directory");
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const sent = writeSync(fd, bytes, offset, bytes.length - offset);
      if (sent <= 0) fail("IO_UNCONFIRMED");
      offset += sent;
    }
    fsyncSync(fd);
    const opened = fstatSync(fd, { bigint: true }),
      current = safePath(file);
    if (
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      current.size !== BigInt(bytes.length)
    )
      fail("IO_UNCONFIRMED");
  } finally {
    closeSync(fd);
  }
}
function pair(paths, name, value) {
  // The independent witness is durable before the database-side copy and any DB mutation.
  write(path.join(paths.control, name), value);
  write(path.join(paths.journal, name), value);
}
function identity(file) {
  const s = safePath(file);
  return { dev: s.dev.toString(), ino: s.ino.toString(), birthtimeNs: s.birthtimeNs.toString() };
}
function fileName(index) {
  return `${String(index).padStart(2, "0")}.json`;
}
function requireOriginalEvidence(current, evidence) {
  const continuation = current.steps[5], execution = current.steps[4];
  const completed = continuation.command === null ? execution : continuation;
  if (!execution.receipt || !completed.receipt ||
      completed.command?.automaticRetryAllowed !== false ||
      json(Object.keys(completed.command)) !== json(["selection", "automaticRetryAllowed"]) ||
      json(evidence.original) !== json(current.originalAnchor) ||
      json(evidence.selection) !== json(completed.command.selection) ||
      json(evidence.checkpoint) !== json(completed.receipt)) fail("JOURNAL_INVALID");
  // Database digest and core completion must be re-audited by the trusted composition.
  createAdditionalValidationApproval(evidence);
}
function readState(paths, allowLock = false, additional = false) {
  if (!allowLock && exists(paths.lock)) fail("BUSY");
  const dataExists = exists(paths.directory),
    controlExists = exists(paths.control);
  if (!dataExists && !controlExists) {
    safePath(path.dirname(paths.directory), "directory");
    return { state: "virgin", entries: [], binding: null };
  }
  if (!dataExists || !controlExists || !exists(paths.journal) || !exists(paths.db))
    fail("PARTIAL_STATE");
  for (const dir of [paths.directory, paths.control, paths.journal]) safePath(dir, "directory");
  const names = readdirSync(paths.control).sort();
  if (
    json(names) !== json(readdirSync(paths.journal).sort()) ||
    names.length < 2 ||
    names.length > (additional ? 27 : 16) ||
    names.some((name, i) => name !== fileName(i))
  )
    fail("PARTIAL_STATE");
  const records = names.map((name) => {
    const outside = read(path.join(paths.control, name));
    if (json(outside) !== json(read(path.join(paths.journal, name)))) fail("JOURNAL_INVALID");
    return outside;
  });
  const binding = records[0];
  if (
    json(binding.profile) !== json(paths.binding) ||
    typeof binding.instanceId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(binding.instanceId) ||
    json(Object.keys(binding)) !== json(["profile", "instanceId"])
  )
    fail("JOURNAL_INVALID");
  if (
    json(records[1]) !==
    json({ bindingDigest: hash(binding), databaseIdentity: identity(paths.db) })
  )
    fail("DATABASE_CHANGED");
  let previous = hash(records[1]);
  const extensionIndex = additional
    ? records.findIndex((record) => record?.stage === "additional-approval") : -1;
  const originalCount = extensionIndex < 0 ? records.length : extensionIndex;
  if (originalCount > 16) fail("JOURNAL_INVALID");
  const entries = records.slice(2, originalCount);
  const steps = stages.map(() => ({ command: null, receipt: null }));
  let nextStage = 0, rejection = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (
      entry.previous !== previous ||
      entry.stage !== stages[nextStage] ||
      !entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload) ||
      json(Object.keys(entry)) !== json(["previous", "stage", "kind", "payload"])
    )
      fail("JOURNAL_INVALID");
    const step = steps[nextStage];
    if (entry.kind === "command" && step.command === null) step.command = entry.payload;
    else if (entry.kind === "receipt" && step.command !== null) {
      step.receipt = entry.payload;
      nextStage++;
    } else if (
      entry.kind === "policy-rejection" && entry.stage === "policy" &&
      step.command !== null && rejection === null &&
      entry.payload?.commandDigest === hash(step.command) &&
      json(Object.keys(entry.payload)) === json(["commandDigest", "evidence"]) &&
      entry.payload.evidence && typeof entry.payload.evidence === "object" &&
      !Array.isArray(entry.payload.evidence)
    ) {
      // The original command stays in the immutable chain. Core, not this file layer,
      // must revalidate the deterministic rejection and the absence of any DB effects.
      rejection = { command: step.command, evidence: entry.payload.evidence };
      step.command = null;
    } else fail("JOURNAL_INVALID");
    previous = hash(entry);
  }
  const current = { state: "initialized", binding, entries, steps, nextStage, rejection, head: previous,
    originalAnchor: { instanceId: binding.instanceId, recordCount: originalCount, headDigest: previous },
    additionalRecords: extensionIndex < 0 ? [] : records.slice(extensionIndex), additionalState: null };
  if (extensionIndex >= 0) {
    const payload = current.additionalRecords[0]?.payload;
    const evidence = payload && {
      original: payload.original, selection: payload.selection, checkpoint: payload.checkpoint,
      databaseDigest: payload.databaseDigest,
    };
    requireOriginalEvidence(current, evidence ?? {});
    current.additionalState = inspectAdditionalValidationRecords(evidence, current.additionalRecords);
  }
  return current;
}
export function inspectValidationJournal(profile) {
  try {
    const state = readState(profilePaths(profile));
    const pending = state.steps?.[state.nextStage];
    return {
      state: state.state,
      completedStages: state.nextStage ?? 0,
      pendingStage: (pending && pending.command !== null) ||
        (state.rejection && state.nextStage === 1) ? stages[state.nextStage] : null,
      ...(state.rejection ? { policyRejectionRecorded: true } : {}),
      // This is file consistency, not a budget balance or confirmation of database receipts.
      ledgerAudited: false,
      transmissionAllowed: false,
    };
  } catch (error) {
    return {
      state: "blocked",
      reason: validationJournalErrorCode(error),
      ledgerAudited: false,
      transmissionAllowed: false,
    };
  }
}
function payloadCopy(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("JOURNAL_INVALID");
  const serialized = json(payload);
  if (!serialized || Buffer.byteLength(serialized) > maxBytes - 1024) fail("JOURNAL_INVALID");
  if (
    /sk-[A-Za-z0-9_-]{16,}|"(?:authorization|api[_-]?key|password|secret|credential)"\s*:/i.test(
      serialized,
    )
  )
    fail("SENSITIVE_PAYLOAD");
  return JSON.parse(serialized);
}
/** Exclusive process lease. A leftover lease is never broken using PID/age heuristics.
 * Callers must retain it until all executions AND unpersisted captures are drained. */
export function acquireValidationJournal(profile) {
  return acquireJournal(profile, false);
}
/** Explicit extension-only file interface. It cannot initialize DB/budget or grant execution.
 * Legacy CLI/session deliberately continue to use acquireValidationJournal. */
export function acquireAdditionalValidationJournal(profile) {
  return acquireJournal(profile, true);
}
function acquireJournal(profile, additional) {
  const paths = profilePaths(profile);
  safePath(path.dirname(paths.control), "directory");
  try {
    mkdirSync(paths.lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") fail("BUSY");
    throw error;
  }
  const lockIdentity = safePath(paths.lock, "directory");
  let closed = false;
  function guard() {
    if (closed) fail("CLOSED");
    const current = safePath(paths.lock, "directory");
    if (
      current.dev !== lockIdentity.dev ||
      current.ino !== lockIdentity.ino ||
      current.birthtimeNs !== lockIdentity.birthtimeNs
    )
      fail("BUSY");
  }
  function state() {
    guard();
    return readState(paths, true, additional);
  }
  function ready() {
    const value = state();
    if (value.state !== "initialized") fail("PARTIAL_STATE");
    return value;
  }
  function append(stage, kind, payload) {
    const current = ready(),
      index = current.entries.length;
    const command = current.steps[current.nextStage]?.command;
    if (
      additional || current.additionalState !== null ||
      stage !== stages[current.nextStage] ||
      (kind === "policy-rejection"
        ? stage !== "policy" || command === null || command === undefined || current.rejection
        : kind !== (command === null ? "command" : "receipt"))
    )
      fail("STAGE_ORDER");
    pair(paths, fileName(index + 2), {
      previous: current.head,
      stage,
      kind,
      payload: payloadCopy(payload),
    });
  }
  function extensionEvidence(current) {
    const p = current.additionalState?.approval;
    if (!p) fail("STAGE_ORDER");
    return { original: p.original, selection: p.selection, checkpoint: p.checkpoint, databaseDigest: p.databaseDigest };
  }
  function appendAdditional(stage, kind, payload) {
    const current = ready(), evidence = extensionEvidence(current);
    const proposal = prepareAdditionalValidationRecord(evidence, current.additionalRecords, stage, kind, payload);
    if (proposal.status === "append-required") {
      pair(paths, fileName(current.originalAnchor.recordCount + current.additionalRecords.length), proposal.record);
    }
    return ready().additionalState.steps[stage][kind];
  }
  return {
    ...(additional ? {
      readOriginalAnchor() { return ready().originalAnchor; },
      readAdditionalState() { return ready().additionalState; },
      appendAdditionalApproval(evidence) {
        const current = ready(), copy = payloadCopy(evidence);
        requireOriginalEvidence(current, copy);
        const record = createAdditionalValidationApproval(copy);
        if (current.additionalState) {
          if (json(record) !== json(current.additionalRecords[0])) fail("COMMAND_CONFLICT");
        } else {
          pair(paths, fileName(current.originalAnchor.recordCount), record);
        }
        return ready().additionalState.approval;
      },
      prepareAdditional(stage, payload) { return appendAdditional(stage, "command", payload); },
      acknowledgeAdditional(stage, payload) { appendAdditional(stage, "receipt", payload); },
    } : {}),
    /** The callback may create only an empty core store. Never adopt a budget or dispatch here.
     * Any interrupted initialization is quarantined, not automatically initialized again. */
    initialize(createEmptyDatabase) {
      if (additional || state().state !== "virgin") fail("PARTIAL_STATE");
      mkdirSync(paths.control, { mode: 0o700 });
      const binding = { profile: paths.binding, instanceId: randomUUID() };
      write(path.join(paths.control, fileName(0)), binding);
      mkdirSync(paths.directory, { mode: 0o700 });
      mkdirSync(paths.journal, { mode: 0o700 });
      write(path.join(paths.journal, fileName(0)), binding);
      const result = createEmptyDatabase(paths.directory);
      if (result?.then) fail("PARTIAL_STATE"); // initialization must be synchronous, no detached work
      guard();
      pair(paths, fileName(1), {
        bindingDigest: hash(binding),
        databaseIdentity: identity(paths.db),
      });
      return ready().binding.instanceId;
    },
    readStep(stage) {
      const current = ready(),
        index = stages.indexOf(stage);
      if (index < 0) fail("STAGE_ORDER");
      return {
        command: current.steps[index].command,
        receipt: current.steps[index].receipt,
      };
    },
    readPolicyRejection() {
      return ready().rejection;
    },
    rejectPendingPolicy(evidence) {
      const current = ready(), copy = payloadCopy(evidence);
      if (current.rejection) {
        if (json(current.rejection.evidence) !== json(copy)) fail("COMMAND_CONFLICT");
        return;
      }
      append("policy", "policy-rejection", {
        commandDigest: hash(current.steps[1].command), evidence: copy,
      });
    },
    prepare(stage, payload) {
      const original = this.readStep(stage).command,
        copy = payloadCopy(payload);
      if (original !== null) {
        if (json(original) !== json(copy)) fail("COMMAND_CONFLICT");
        return original;
      }
      append(stage, "command", copy);
      return this.readStep(stage).command;
    },
    acknowledge(stage, receipt) {
      const original = this.readStep(stage).receipt,
        copy = payloadCopy(receipt);
      if (original !== null) {
        if (json(original) !== json(copy)) fail("COMMAND_CONFLICT");
        return;
      }
      append(stage, "receipt", copy);
    },
    close() {
      if (closed) return;
      guard();
      rmdirSync(paths.lock); // no recursive cleanup; unexpected lease contents stay quarantined
      closed = true;
    },
  };
}
