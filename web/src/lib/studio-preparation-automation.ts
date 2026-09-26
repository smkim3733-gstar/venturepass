// Node-only state transitions. No timers, database, engine, portal, OCR or external AI calls.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { diagnosisInputFingerprint } from "./studio-diagnosis";
import { currentVerifiedCandidateSelection } from "./studio-candidate-selection";
import { isPreparationStale, preparationDigest } from "./studio-preparation-state";
import { StudioError } from "./studio-http";
import type { StudioCase } from "./studio-schema";
import type { PreparationRun } from "./studio-preparation-types";
import {
  currentPreparationAutomationSetting,
  emptyPreparationAutomation,
  preparationAutomationSchema,
  preparationAutomationLimits,
  preparationAutomationSettingInputSchema,
  preparationAutomationRequestSchema,
  preparationAutomationBatchSchema,
  type PreparationAutomation,
  type PreparationAutomationEvent,
  type PreparationAutomationBatch,
  type PreparationAutomationCommand,
  type PreparationAutomationSettingInput,
  type PreparationAutomationRequest,
} from "./studio-preparation-automation-types";

export type PreparationAutomationCompany = StudioCase & {
  preparationAutomation?: PreparationAutomation;
};
type Meta = { id: string; at: string };
const metadata = z.object({ id: z.string().uuid(), at: z.string().datetime() }).strict();
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function fail(code: string): never {
  throw new StudioError(
    "로컬 준비 연결 상태와 최신 기업 버전을 확인해 주세요. 보관 이력은 유지합니다.",
    409,
    code,
  );
}
const stateOf = (company: PreparationAutomationCompany) => {
  const state = preparationAutomationSchema.parse(
    company.preparationAutomation ?? emptyPreparationAutomation(),
  );
  if (
    (state.caseId !== null && state.caseId !== company.id) ||
    (state.caseId === null &&
      (state.settings.length || state.events.length || state.batches.length || state.overflow))
  )
    fail("AUTOMATION_RECORD_INVALID");
  return state;
};
export function preparationAutomationFingerprint(company: PreparationAutomationCompany) {
  return digest({
    caseId: company.id,
    input: diagnosisInputFingerprint(company),
    agency: company.agencyRecords.filter((record) =>
      ["request", "request-correction", "response"].includes(record.kind),
    ),
  });
}
export function assertPreparationAutomationCapacity(
  state: PreparationAutomation,
  finalDisable = false,
) {
  if (
    !preparationAutomationSchema.safeParse(state).success ||
    JSON.stringify(state).length >
      preparationAutomationLimits.characters - (finalDisable ? 0 : 2000)
  )
    fail("AUTOMATION_LIMIT");
}
export function preparationAutomationRequestDigest(
  raw: PreparationAutomationRequest | PreparationAutomationSettingInput,
) {
  const input =
    raw.action === "set-preparation-automation"
      ? preparationAutomationSettingInputSchema.parse(raw)
      : preparationAutomationRequestSchema.parse(raw);
  const { revision: _revision, clientRequestId: _nonce, ...rest } = input;
  void _revision;
  void _nonce;
  return digest(rest);
}
function seen(state: PreparationAutomation, nonce: string, inputDigest: string) {
  const settings = state.settings.filter((item) => item.clientRequestId === nonce),
    batches = state.batches.filter((item) =>
      item.requests.some((request) => request.clientRequestId === nonce),
    );
  const entries = [
    ...settings.map((item) => item.inputDigest),
    ...batches.flatMap((item) =>
      item.requests
        .filter((request) => request.clientRequestId === nonce)
        .map((request) => request.digest),
    ),
  ];
  if (entries.length > 1 || entries.some((value) => value !== inputDigest))
    fail("AUTOMATION_REQUEST_CONFLICT");
  return { setting: settings[0] ?? null, batch: batches[0] ?? null };
}
function checkRevision(
  company: PreparationAutomationCompany,
  input: { revision: number; expectedSettingVersion: number },
  state: PreparationAutomation,
) {
  if (input.revision !== company.revision) fail("STALE_REVISION");
  if (input.expectedSettingVersion !== (currentPreparationAutomationSetting(state)?.version ?? 0))
    fail("AUTOMATION_PERMISSION_CHANGED");
}
/** Persist returned state in the same company transaction. Enabling captures a baseline, never a retroactive event. */
export function configurePreparationAutomation(
  company: PreparationAutomationCompany,
  raw: PreparationAutomationSettingInput,
  meta: Meta,
) {
  const input = preparationAutomationSettingInputSchema.parse(raw),
    server = metadata.parse(meta),
    state = stateOf(company),
    inputDigest = preparationAutomationRequestDigest(input),
    replay = seen(state, input.clientRequestId, inputDigest);
  if (replay.batch) fail("AUTOMATION_REQUEST_CONFLICT");
  if (replay.setting) return { state, changed: false, replayed: true };
  checkRevision(company, input, state);
  const previous = currentPreparationAutomationSetting(state);
  if ((previous?.enabled ?? false) === input.enabled)
    return { state, changed: false, replayed: false };
  // Reserve one final disable record even when the ordinary settings journal is full.
  if (input.enabled && state.settings.length >= preparationAutomationLimits.settings)
    fail("AUTOMATION_LIMIT");
  if (state.settings.some((item) => item.id === server.id)) fail("AUTOMATION_RECORD_INVALID");
  state.caseId = company.id;
  state.settings.push({
    ...server,
    clientRequestId: input.clientRequestId,
    inputDigest,
    version: (previous?.version ?? 0) + 1,
    enabled: input.enabled,
    baselineFingerprint: preparationAutomationFingerprint(company),
  });
  assertPreparationAutomationCapacity(state, !input.enabled);
  return { state, changed: true, replayed: false };
}
function sourceMeaning(source: StudioCase["sources"][number]) {
  return { name: source.name, kind: source.kind, text: source.text, extraction: source.extraction };
}
/** Hook after successful business mutation, before its commit. Replays/no-ops produce no new events. */
export function collectPreparationAutomationChanges(
  before: PreparationAutomationCompany,
  after: PreparationAutomationCompany,
  at: string,
): PreparationAutomation {
  z.string().datetime().parse(at);
  if (before.id !== after.id || after.revision !== before.revision + 1)
    fail("AUTOMATION_RECORD_INVALID");
  const state = stateOf(after),
    permission = currentPreparationAutomationSetting(state);
  if (!permission?.enabled) return state;
  const candidates: Omit<
    PreparationAutomationEvent,
    "id" | "changeDigest" | "settingVersion" | "companyRevision" | "at"
  >[] = [];
  if (digest(before.profile) !== digest(after.profile))
    candidates.push({
      kind: "profile",
      targetId: after.id,
      targetVersion: String(after.revision),
      change: "updated",
      sourceReadiness: null,
      beforeSha256: digest(before.profile),
      afterSha256: digest(after.profile),
    });
  const sources = new Set([
    ...before.sources.map((source) => source.id),
    ...after.sources.map((source) => source.id),
  ]);
  for (const id of sources) {
    const old = before.sources.find((source) => source.id === id),
      current = after.sources.find((source) => source.id === id),
      left = old ? digest(sourceMeaning(old)) : null,
      right = current ? digest(sourceMeaning(current)) : null;
    if (left === right) continue;
    candidates.push({
      kind: "source",
      targetId: id,
      targetVersion: current?.updatedAt ?? old!.updatedAt,
      change: !current ? "removed" : !old ? "added" : "updated",
      sourceReadiness:
        current?.extraction === "pending" ? "pending" : current?.text.trim() ? "ready" : "empty",
      beforeSha256: left,
      afterSha256: right,
    });
  }
  const relevant = (record: StudioCase["agencyRecords"][number]) =>
    ["request", "request-correction", "response"].includes(record.kind);
  for (const current of after.agencyRecords.filter(relevant)) {
    const old = before.agencyRecords.find((record) => record.id === current.id),
      left = old ? digest(old) : null,
      right = digest(current);
    if (left === right) continue;
    candidates.push({
      kind: current.kind === "response" ? "agency-response" : "agency-request",
      targetId: current.id,
      targetVersion: String(current.version),
      change: old ? "updated" : "added",
      sourceReadiness: null,
      beforeSha256: left,
      afterSha256: right,
    });
  }
  const events = candidates
    .map((item) => ({
      ...item,
      id: randomUUID(),
      changeDigest: digest({ caseId: after.id, from: before.revision, to: after.revision, item }),
      settingVersion: permission.version,
      companyRevision: after.revision,
      at,
    }))
    .filter((item) => !state.events.some((old) => old.changeDigest === item.changeDigest));
  if (!events.length) return state;
  const proposed = { ...state, events: [...state.events, ...events] };
  if (
    state.overflow ||
    !preparationAutomationSchema.safeParse(proposed).success ||
    JSON.stringify(proposed).length > preparationAutomationLimits.characters - 2000
  ) {
    state.overflow = {
      at,
      companyRevision: after.revision,
      changeDigest: digest(events.map((item) => item.changeDigest)),
    };
    return state; // Explicit overflow pauses connection; no history is trimmed, business save remains possible.
  }
  return proposed;
}
export type AutomationTransition = {
  state: PreparationAutomation;
  batch: PreparationAutomationBatch;
  command: PreparationAutomationCommand | null;
  replayed: boolean;
};
function admitted(
  company: PreparationAutomationCompany,
  input: PreparationAutomationRequest,
  state: PreparationAutomation,
) {
  checkRevision(company, input, state);
  if (!currentPreparationAutomationSetting(state)?.enabled) fail("AUTOMATION_DISABLED");
  if (state.overflow) fail("AUTOMATION_LIMIT");
}
function attachedRun(
  company: PreparationAutomationCompany,
  batch: PreparationAutomationBatch,
): PreparationRun | null {
  if (!batch.command) return null;
  const commandIds = new Set(
    batch.requests.map((request) => request.preparationRequestId).filter((id) => id !== null),
  );
  const matches = company.preparationRuns.filter((run) =>
    run.requests.some((request) => commandIds.has(request.clientRequestId)),
  );
  if (matches.length > 1 || (batch.preparationRunId && matches[0]?.id !== batch.preparationRunId))
    fail("AUTOMATION_RECORD_INVALID");
  return matches[0] ?? null;
}
function statusFor(run: PreparationRun): PreparationAutomationBatch["status"] {
  return run.status;
}
function assertChoice(
  company: PreparationAutomationCompany,
  run: PreparationRun,
  candidateId: string,
  candidateDigest: string,
) {
  const selection = currentVerifiedCandidateSelection(company),
    candidate = company.analysis?.candidates.find((item) => item.id === candidateId);
  if (
    run.status !== "awaiting_choice" ||
    !selection ||
    company.selectedCandidateId !== candidateId ||
    !candidate ||
    preparationDigest(candidate) !== candidateDigest ||
    !run.candidates.some((item) => item.id === candidateId && item.digest === candidateDigest)
  )
    fail("AUTOMATION_SELECTION_REQUIRED");
}
/** Persist batch/nonce before calling the returned existing preparation command with the post-commit revision. */
export function beginPreparationAutomation(
  company: PreparationAutomationCompany,
  raw: PreparationAutomationRequest,
  meta: Meta,
): AutomationTransition {
  const input = preparationAutomationRequestSchema.parse(raw),
    server = metadata.parse(meta),
    state = stateOf(company),
    inputDigest = preparationAutomationRequestDigest(input),
    replay = seen(state, input.clientRequestId, inputDigest);
  if (replay.setting) fail("AUTOMATION_REQUEST_CONFLICT");
  if (replay.batch) return { state, batch: replay.batch, command: null, replayed: true };
  admitted(company, input, state);
  const permission = currentPreparationAutomationSetting(state)!,
    fingerprint = preparationAutomationFingerprint(company);
  if (input.action !== "run-pending") {
    const batch = state.batches.find((item) => item.id === input.batchId);
    if (!batch) fail("AUTOMATION_BATCH_NOT_FOUND");
    if (batch.requests.length >= preparationAutomationLimits.requests) fail("AUTOMATION_LIMIT");
    if (batch.settingVersion !== permission.version || batch.inputFingerprint !== fingerprint) {
      batch.status = "superseded";
      batch.code = "AUTOMATION_STALE";
      batch.updatedAt = server.at;
      batch.requests.push({
        clientRequestId: input.clientRequestId,
        digest: inputDigest,
        preparationRequestId: null,
      });
      assertPreparationAutomationCapacity(state);
      return { state, batch, command: null, replayed: false };
    }
    if (!["running", "failed", "awaiting_choice"].includes(batch.status))
      fail("AUTOMATION_CONFIRMATION_REQUIRED");
    const run = attachedRun(company, batch);
    if (run && isPreparationStale(company, run)) fail("AUTOMATION_STALE");
    let command: PreparationAutomationCommand;
    if (input.action === "continue-batch") {
      if (!run) fail("AUTOMATION_SELECTION_REQUIRED");
      assertChoice(company, run, input.candidateId, input.candidateDigest);
      command = {
        action: "continue",
        clientRequestId: randomUUID(),
        runId: run.id,
        candidateId: input.candidateId,
        candidateDigest: input.candidateDigest,
      };
    } else if (run) {
      const unacknowledged =
        batch.command &&
        !run.requests.some((request) => request.clientRequestId === batch.command!.clientRequestId);
      if (unacknowledged) {
        if (batch.command!.action === "continue")
          assertChoice(company, run, batch.command!.candidateId, batch.command!.candidateDigest);
        if (
          batch.command!.action === "start" ||
          (batch.command!.action === "resume" && !["running", "failed"].includes(run.status))
        )
          fail("AUTOMATION_RECORD_INVALID");
        command = batch.command!;
      } else if (!["running", "failed"].includes(run.status)) {
        batch.status = statusFor(run);
        batch.preparationRunId = run.id;
        batch.updatedAt = server.at;
        batch.requests.push({
          clientRequestId: input.clientRequestId,
          digest: inputDigest,
          preparationRequestId: null,
        });
        assertPreparationAutomationCapacity(state);
        return { state, batch, command: null, replayed: false };
      } else command = { action: "resume", clientRequestId: randomUUID(), runId: run.id };
    } else {
      if (batch.command?.action !== "start") fail("AUTOMATION_RECORD_INVALID");
      command = batch.command; // Crash before preparation begin: replay its original nonce, never a new start.
    }
    batch.command = command;
    batch.status = "running";
    batch.code = null;
    batch.updatedAt = server.at;
    batch.requests.push({
      clientRequestId: input.clientRequestId,
      digest: inputDigest,
      preparationRequestId: command.clientRequestId,
    });
    assertPreparationAutomationCapacity(state);
    return { state, batch, command, replayed: false };
  }
  if (state.batches.some((batch) => batch.status === "running")) fail("AUTOMATION_BUSY");
  const assigned = new Set(state.batches.flatMap((batch) => batch.eventIds));
  const events = state.events.filter(
    (event) => event.settingVersion === permission.version && !assigned.has(event.id),
  );
  if (!events.length) fail("AUTOMATION_NO_CHANGES");
  if (state.batches.some((batch) => batch.id === server.id)) fail("AUTOMATION_RECORD_INVALID");
  const sourceIds = new Set(
    events.filter((event) => event.kind === "source").map((event) => event.targetId),
  );
  const pendingSourceIds = company.sources
    .filter((source) => sourceIds.has(source.id) && source.extraction === "pending")
    .map((source) => source.id);
  const agencyRecordIds = events
    .filter((event) => event.kind === "agency-request" || event.kind === "agency-response")
    .map((event) => event.targetId);
  const changesReady = events.some(
    (event) =>
      event.kind === "profile" ||
      (event.kind === "source" && !pendingSourceIds.includes(event.targetId)),
  );
  let status: PreparationAutomationBatch["status"] = "running",
    code: PreparationAutomationBatch["code"] = null;
  if (!changesReady) {
    status = pendingSourceIds.length ? "source-review" : "request-review";
    code = pendingSourceIds.length ? "AUTOMATION_SOURCE_REVIEW" : "AUTOMATION_REQUEST_REVIEW";
  }
  // Material sufficiency remains the existing preparation engine's decision; no new quality score.
  const command: PreparationAutomationCommand | null =
    status === "running" ? { action: "start", clientRequestId: randomUUID() } : null;
  const batch = preparationAutomationBatchSchema.parse({
    id: server.id,
    settingVersion: permission.version,
    inputFingerprint: fingerprint,
    eventIds: events.map((event) => event.id),
    pendingSourceIds: [...new Set(pendingSourceIds)],
    agencyRecordIds: [...new Set(agencyRecordIds)],
    status,
    code,
    command,
    preparationRunId: null,
    requests: [
      {
        clientRequestId: input.clientRequestId,
        digest: inputDigest,
        preparationRequestId: command?.clientRequestId ?? null,
      },
    ],
    createdAt: server.at,
    updatedAt: server.at,
  });
  state.batches.push(batch);
  assertPreparationAutomationCapacity(state);
  return { state, batch, command, replayed: false };
}
/** Commit only exact recorded command results. No artifact changes; concurrent evidence leaves a superseded receipt. */
export function finishPreparationAutomation(
  company: PreparationAutomationCompany,
  batchId: string,
  runId: string,
  at: string,
): AutomationTransition {
  z.string().datetime().parse(at);
  const state = stateOf(company),
    batch = state.batches.find((item) => item.id === batchId);
  if (!batch || batch.status !== "running") fail("AUTOMATION_BATCH_NOT_RUNNING");
  const run = attachedRun(company, batch);
  if (!run || run.id !== runId) fail("AUTOMATION_RECORD_INVALID");
  batch.preparationRunId = runId;
  batch.updatedAt = at;
  if (
    !currentPreparationAutomationSetting(state)?.enabled ||
    currentPreparationAutomationSetting(state)?.version !== batch.settingVersion
  ) {
    batch.status = "blocked";
    batch.code = "AUTOMATION_DISABLED";
  } else if (
    batch.inputFingerprint !== preparationAutomationFingerprint(company) ||
    isPreparationStale(company, run)
  ) {
    batch.status = "superseded";
    batch.code = "AUTOMATION_STALE";
  } else {
    batch.status = statusFor(run);
    batch.code = run.status === "failed" ? "AUTOMATION_PREPARATION_FAILED" : null;
  }
  assertPreparationAutomationCapacity(state);
  return { state, batch, command: null, replayed: false };
}
