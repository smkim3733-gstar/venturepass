import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { StudioError } from "./studio-http";
import { withVentureInputCompanyLock } from "./venturein-input-lock";
import { compareVentureApplication, fillVentureApplication } from "./venturein-runner";
import { readVentureOriginal } from "./venturein-originals";
import type { StudioStore } from "./studio-storage";
import { preparedPackageSummary } from "./studio-prepared-package-types";
import { compareVenturePreparedBinding } from "./venturein-prepared-binding";
import {
  assertVentureWorkflowVersions,
  getVentureWorkflow,
  readVentureWorkflowStored,
  type VentureWorkflowStatus,
} from "./venturein-workflow";
import {
  ventureExecutionRecordSchema,
  ventureRecoverableCodes,
  ventureInputComparisonFieldSchema,
  venturePreparedComparisonSchema,
  venturePreparedPackageBindingSchema,
  type VentureInputComparison,
  type VentureExecutionRecord,
  type VentureExecutionReview,
  type VentureExecutionAttempt,
  type VentureRecoveryReview,
  type VenturePreparedComparison,
  type VenturePreparedPackageBinding,
} from "./venturein-execution-schema";

type Versions = { revision: number; companyRevision: number; accountRevision: number };
type Ticket = Versions & {
  caseId: string;
  expiresAt: number;
  fingerprint: string;
  preparedPackage?: VenturePreparedPackageBinding;
} & (
    | { kind: "normal" }
    | {
        kind: "recovery";
        priorExecutionId: string;
        priorReceiptFingerprint: string;
        requestedFieldKeys: string[];
        preserveFieldKeys: string[];
      }
  );
type NewTicket = Ticket extends infer T ? (T extends Ticket ? Omit<T, "expiresAt"> : never) : never;
// Restart loses approval tickets. Durable execution receipts still prevent replay of a used screen.
const processState = globalThis as typeof globalThis & {
  __ventureinExecutionTicketsV4?: Map<string, Ticket>;
};
const tickets = (processState.__ventureinExecutionTicketsV4 ??= new Map<string, Ticket>());
const reviewLifetimeMs = 2 * 60 * 1000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const targetsFor = (workflow: VentureWorkflowStatus) => [
  ...workflow.report.textFields.map(({ fieldKey }) => ({ fieldKey, kind: "text" as const })),
  ...[...new Set(workflow.report.attachments.map(({ fieldKey }) => fieldKey))].map((fieldKey) => ({
    fieldKey,
    kind: "file" as const,
  })),
];

function issueTicket(ticket: NewTicket) {
  const now = Date.now();
  for (const [key, current] of tickets)
    if (current.expiresAt <= now || current.caseId === ticket.caseId) tickets.delete(key);
  if (tickets.size >= 100)
    throw new StudioError(
      "검토 요청이 많습니다. 만료 후 다시 준비해 주세요.",
      429,
      "INPUT_REVIEW_LIMIT",
    );
  const token = randomUUID();
  const expiresAt = now + reviewLifetimeMs;
  tickets.set(token, { ...ticket, expiresAt } as Ticket);
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

function fingerprint(
  workflow: VentureWorkflowStatus,
  attachments: VentureExecutionReview["attachments"],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        snapshot: workflow.snapshot,
        draft: workflow.draft,
        fields: workflow.report.textFields,
        attachments: workflow.report.attachments,
        inputReadiness: workflow.report.inputReadiness,
        submissionReady: workflow.report.readyForLocalReview,
        accountRevision: workflow.accountRevision,
        sessionStartedAt: workflow.session.startedAt,
        originalContent: attachments.map(({ fieldKey, sourceId, sha256 }) => ({
          fieldKey,
          sourceId,
          sha256,
        })),
      }),
    )
    .digest("hex");
}

function executionFingerprint(
  workflow: VentureWorkflowStatus,
  attachments: VentureExecutionReview["attachments"],
  preparedPackage?: VenturePreparedPackageBinding,
) {
  const selectedFingerprint = fingerprint(workflow, attachments);
  // The legacy fingerprint is unchanged; no package is inferred for old approvals.
  return preparedPackage
    ? hash({ version: 2, selectedFingerprint, preparedPackage })
    : selectedFingerprint;
}

function readPreparedComparison(
  store: StudioStore,
  caseId: string,
  workflow: VentureWorkflowStatus,
  preparedPackageId: string,
  attachments: VentureExecutionReview["attachments"],
): VenturePreparedComparison {
  // The storage method verifies the immutable row and ZIP bytes. Recompute from the
  // returned bytes as well; never accept a browser-supplied "verified" flag or SHA.
  const { record, buffer } = store.downloadPreparedPackage(caseId, preparedPackageId);
  const company = store.get(caseId);
  const plans = company.plans.filter((plan) => plan.id === workflow.draft?.planId);
  const result = compareVenturePreparedBinding({
    caseId,
    companyRevision: company.revision,
    profile: company.profile,
    plan: plans.length === 1 ? plans[0] : null,
    preparedPackage: record,
    archive: {
      packageId: record.id,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.byteLength,
      verified: true,
    },
    selection: {
      planId: workflow.draft!.planId,
      planVersion: workflow.draft!.planVersion,
      textFields: workflow.report.textFields,
      attachments,
    },
  });
  return venturePreparedComparisonSchema.parse({
    caseId,
    workflowRevision: workflow.revision,
    companyRevision: company.revision,
    accountRevision: workflow.accountRevision,
    snapshotId: workflow.snapshot!.screen.id,
    sessionStartedAt: workflow.snapshot!.sessionStartedAt,
    preparedPackage: preparedPackageSummary(record),
    result,
  });
}
function requirePreparedConnection(
  comparison: VenturePreparedComparison,
): VenturePreparedPackageBinding {
  const result = comparison.result;
  if (
    !result.matched ||
    !result.binding ||
    !result.digest ||
    result.packageDraft === null ||
    result.companyRevisionChanged === null
  )
    throw new StudioError(
      "선택한 준비본과 현재 입력·첨부가 일치하지 않습니다. 준비본 대조 결과를 다시 확인해 주세요.",
      409,
      "PREPARED_PACKAGE_MISMATCH",
    );
  return venturePreparedPackageBindingSchema.parse({
    binding: result.binding,
    digest: result.digest,
    packageDraft: result.packageDraft,
    companyRevisionChanged: result.companyRevisionChanged,
  });
}
function assertPreparedConnection(
  store: StudioStore,
  caseId: string,
  workflow: VentureWorkflowStatus,
  attachments: VentureExecutionReview["attachments"],
  expected: VenturePreparedPackageBinding,
) {
  const observed = requirePreparedConnection(
    readPreparedComparison(store, caseId, workflow, expected.binding.package.id, attachments),
  );
  if (hash(observed) !== hash(expected))
    throw new StudioError(
      "승인에 연결된 준비본 또는 선택 범위가 변경되었습니다. 다시 대조하고 승인해 주세요.",
      409,
      "PREPARED_PACKAGE_CHANGED",
    );
  return observed;
}

/** Local archive/mapping comparison only: no browser inspection, token, or receipt mutation. */
export function compareVenturePreparedPackage(
  caseId: string,
  input: Versions & { preparedPackageId: string },
): VenturePreparedComparison {
  const store = assertVentureWorkflowVersions(caseId, input),
    workflow = getVentureWorkflow(caseId);
  assertEligible(workflow);
  const { attachments } = readReviewedAttachments(store, caseId, workflow);
  const comparison = readPreparedComparison(
    store,
    caseId,
    workflow,
    input.preparedPackageId,
    attachments,
  );
  assertVentureWorkflowVersions(caseId, input);
  return comparison;
}

function assertEligible(workflow: VentureWorkflowStatus) {
  if (workflow.report.inputReadiness?.ready !== true || !workflow.snapshot || !workflow.draft) {
    const limit = workflow.report.inputReadiness?.blockingIssues.find((issue) =>
      ["INPUT_LIMIT", "INPUT_FILE_LIMIT"].includes(issue.code),
    );
    throw new StudioError(
      limit?.message ??
        "선택한 입력·첨부의 보완 항목을 해결하고 현재 기업·화면의 연결안을 확인해 주세요.",
      409,
      limit?.code ?? "INPUT_REVIEW_BLOCKED",
    );
  }
  const fields = workflow.report.textFields;
  const attachments = workflow.report.attachments;
  const targetCount = fields.length + new Set(attachments.map((file) => file.fieldKey)).size;
  if (
    !targetCount ||
    targetCount > 50 ||
    fields.some((field) => !field.confirmed || !field.value || field.value.length > 20_000) ||
    fields.reduce((sum, field) => sum + field.value.length, 0) > 100_000
  )
    throw new StudioError(
      "확인한 입력값이나 첨부가 필요합니다. 한 번에 50개 항목, 텍스트당 20,000자, 전체 텍스트 100,000자까지 지원합니다.",
      409,
      "INPUT_LIMIT",
    );
  if (
    attachments.length > 10 ||
    attachments.some(
      (file) => !file.confirmed || file.sizeBytes <= 0 || file.sizeBytes > 12 * 1024 * 1024,
    ) ||
    attachments.reduce((sum, file) => sum + file.sizeBytes, 0) > 24 * 1024 * 1024
  )
    throw new StudioError(
      "첨부 실행은 한 번에 10개 파일, 파일당 12MB, 합계 24MB까지 지원합니다. 이는 앱의 처리 한도이며 기관의 업로드 허용량은 별도로 확인하세요.",
      409,
      "INPUT_FILE_LIMIT",
    );
}

function readReviewedAttachments(
  store: StudioStore,
  caseId: string,
  workflow: VentureWorkflowStatus,
) {
  const originals = new Map<string, ReturnType<typeof readVentureOriginal>>();
  const attachments = workflow.report.attachments.map((file) => {
    let original = originals.get(file.sourceId);
    if (!original) {
      original = readVentureOriginal(store, caseId, file.sourceId);
      originals.set(file.sourceId, original);
    }
    if (
      original.source.originalName !== file.originalName ||
      original.source.mimeType !== file.mimeType ||
      original.source.updatedAt !== file.sourceUpdatedAt ||
      original.buffer.byteLength !== file.sizeBytes
    )
      throw new StudioError(
        "첨부 원본의 이름·형식·내용이 변경되었습니다. 다시 연결하고 검토해 주세요.",
        409,
        "INPUT_ORIGINAL_CHANGED",
      );
    return { ...file, sha256: original.sha256 };
  });
  return { attachments, originals };
}

/** Compare the current mapping, never restore approval or change an execution receipt. */
export async function compareVentureInput(
  caseId: string,
  input: Versions,
): Promise<VentureInputComparison> {
  return withVentureInputCompanyLock(caseId, () => compareLocked(caseId, input));
}

async function compareLocked(caseId: string, input: Versions): Promise<VentureInputComparison> {
  const store = assertVentureWorkflowVersions(caseId, input);
  const workflow = getVentureWorkflow(caseId);
  assertEligible(workflow);
  const { attachments } = readReviewedAttachments(store, caseId, workflow);
  const before = fingerprint(workflow, attachments);
  const assertCurrent = () => {
    assertVentureWorkflowVersions(caseId, input);
    const current = getVentureWorkflow(caseId);
    assertEligible(current);
    if (fingerprint(current, attachments) !== before)
      throw new StudioError(
        "대조 중 기업·계정·연결안이 바뀌었습니다. 다시 확인해 주세요.",
        409,
        "COMPARE_CHANGED",
      );
  };
  let finalized = false;
  let finalOriginalFailure: StudioError | undefined;
  const finalizeOriginals = () => {
    try {
      assertCurrent();
      const current = getVentureWorkflow(caseId);
      const finalOriginals = readReviewedAttachments(store, caseId, current);
      assertCurrent();
      if (fingerprint(current, finalOriginals.attachments) !== before)
        throw new StudioError(
          "대조 중 첨부 원본이 바뀌었습니다. 다시 연결하고 확인해 주세요.",
          409,
          "COMPARE_ORIGINAL_CHANGED",
        );
      finalized = true;
    } catch (error) {
      if (error instanceof StudioError) finalOriginalFailure = error;
      throw error;
    }
  };
  const result = await compareVentureApplication(
    caseId,
    {
      snapshot: workflow.snapshot!.screen,
      sessionStartedAt: workflow.snapshot!.sessionStartedAt,
      businessNumber: store.get(caseId).profile.businessNumber,
      fields: workflow.report.textFields.map(({ fieldKey, value }) => ({ fieldKey, value })),
      attachments: [...new Set(attachments.map((file) => file.fieldKey))].map((fieldKey) => ({
        fieldKey,
        files: attachments
          .filter((file) => file.fieldKey === fieldKey)
          .map((file) => ({
            name: file.originalName,
            mimeType:
              file.mimeType?.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream",
            size: file.sizeBytes,
            sha256: file.sha256,
          })),
      })),
    },
    assertCurrent,
    finalizeOriginals,
  );
  assertCurrent();
  if (finalOriginalFailure) throw finalOriginalFailure;
  if (
    result.status !== "completed" ||
    !finalized ||
    !result.observedAt ||
    !Number.isFinite(Date.parse(result.observedAt))
  )
    throw new StudioError(
      "현재 화면을 안전하게 대조하지 못했습니다. 현재 연결과 화면을 다시 확인해 주세요.",
      409,
      "COMPARE_UNVERIFIED",
    );
  const fields = result.fields.map((field) => ventureInputComparisonFieldSchema.parse(field));
  const expected = new Map([
    ...workflow.report.textFields.map((field) => [field.fieldKey, "text"] as const),
    ...attachments.map((file) => [file.fieldKey, "file"] as const),
  ]);
  if (
    fields.length !== expected.size ||
    new Set(fields.map((field) => field.fieldKey)).size !== fields.length ||
    fields.some((field) => expected.get(field.fieldKey) !== field.kind)
  )
    throw new StudioError(
      "화면 대조 결과를 확인하지 못했습니다. 다시 확인해 주세요.",
      409,
      "COMPARE_UNVERIFIED",
    );
  return {
    scope: "current-mapping",
    observedAt: result.observedAt,
    workflowRevision: input.revision,
    companyRevision: input.companyRevision,
    accountRevision: input.accountRevision,
    snapshotId: workflow.snapshot!.screen.id,
    sessionStartedAt: workflow.snapshot!.sessionStartedAt,
    fields,
  };
}

/** Local review only. No browser inspection, input or navigation happens during preparation. */
export function prepareVentureExecution(
  caseId: string,
  input: Versions & { preparedPackageId?: string },
): VentureExecutionReview {
  const store = assertVentureWorkflowVersions(caseId, input);
  const workflow = getVentureWorkflow(caseId);
  assertEligible(workflow);
  if (workflow.execution?.snapshotId === workflow.snapshot!.screen.id)
    throw new StudioError(
      "이 화면에서 입력을 이미 시도했습니다. 결과를 직접 확인하고 현재 화면을 다시 읽어 새 연결안을 준비해 주세요.",
      409,
      "INPUT_ALREADY_ATTEMPTED",
    );
  const { attachments } = readReviewedAttachments(store, caseId, workflow);
  const preparedPackage =
    input.preparedPackageId === undefined
      ? undefined
      : requirePreparedConnection(
          readPreparedComparison(store, caseId, workflow, input.preparedPackageId, attachments),
        );
  assertVentureWorkflowVersions(caseId, input);
  const approval = issueTicket({
    ...input,
    caseId,
    kind: "normal",
    fingerprint: executionFingerprint(workflow, attachments, preparedPackage),
    ...(preparedPackage && { preparedPackage }),
  });
  return {
    scope: "selected-fields",
    submissionReady: workflow.report.readyForLocalReview,
    remainingIssues: workflow.report.inputReadiness.deferredIssues,
    ...approval,
    workflowRevision: input.revision,
    companyRevision: input.companyRevision,
    accountRevision: input.accountRevision,
    snapshotId: workflow.snapshot!.screen.id,
    sessionStartedAt: workflow.snapshot!.sessionStartedAt,
    destination: workflow.snapshot!.screen.url,
    companyName: store.get(caseId).profile.companyName,
    fieldCount: workflow.report.textFields.length,
    fields: workflow.report.textFields,
    attachments,
    attachmentCount: attachments.length,
    totalAttachmentBytes: attachments.reduce((sum, file) => sum + file.sizeBytes, 0),
    ...(preparedPackage && { preparedPackage }),
  };
}

const recoverableCodes = new Set<string>(ventureRecoverableCodes);
function recoveryBlocked(code = "RECOVERY_BLOCKED"): never {
  throw new StudioError(
    "이전 시도와 현재 화면을 안전하게 이어갈 수 없습니다. 기록과 현재 화면을 직접 확인해 주세요. 자동 재전송하지 않습니다.",
    409,
    code,
  );
}
const unique = (values: string[]) => new Set(values).size === values.length;
const orderedSubset = (values: string[], whole: string[]) =>
  unique(values) &&
  JSON.stringify(values) === JSON.stringify(whole.filter((key) => values.includes(key)));

/** Missing legacy evidence, uncertain results and any attachment in the original manifest fail closed. */
function recoveryEvidence(
  store: StudioStore,
  caseId: string,
  workflow: VentureWorkflowStatus,
  input: Versions,
) {
  const record = workflow.execution;
  const manifest = record?.manifest;
  const history = record?.previousAttempts;
  if (!record || !manifest || !history || history.length >= 9 || record.status !== "stopped")
    recoveryBlocked();
  const preparedPackage =
    manifest.version === 2
      ? assertPreparedConnection(store, caseId, workflow, [], manifest.preparedPackage)
      : undefined;
  const targets = targetsFor(workflow);
  const keys = targets.map(({ fieldKey }) => fieldKey);
  if (
    !keys.length ||
    !unique(keys) ||
    manifest.targets.some(({ kind }) => kind !== "text") ||
    workflow.report.attachments.length ||
    manifest.caseId !== caseId ||
    manifest.companyRevision !== input.companyRevision ||
    manifest.accountRevision !== input.accountRevision ||
    manifest.snapshotId !== workflow.snapshot!.screen.id ||
    manifest.sessionStartedAt !== workflow.snapshot!.sessionStartedAt ||
    manifest.draftFingerprint !== hash(workflow.draft) ||
    manifest.fingerprint !== executionFingerprint(workflow, [], preparedPackage) ||
    JSON.stringify(manifest.targets) !== JSON.stringify(targets) ||
    input.revision !== manifest.workflowRevision + 2 * (history.length + 1)
  )
    recoveryBlocked("RECOVERY_BINDING_CHANGED");
  const attempts = [...history, record];
  const touched = new Set<string>();
  const ids = new Set<string>();
  for (const [index, attempt] of attempts.entries()) {
    const requested = attempt.requestedFieldKeys;
    const preserved = attempt.preservedFieldKeys;
    const written = attempt.touchedFieldKeys;
    if (
      !requested?.length ||
      !preserved ||
      !written ||
      !unique(written) ||
      ids.has(attempt.id) ||
      attempt.snapshotId !== manifest.snapshotId ||
      attempt.status !== "stopped" ||
      !attempt.finishedAt ||
      !attempt.code ||
      !recoverableCodes.has(attempt.code) ||
      attempt.attachmentFieldKeys.length ||
      attempt.priorExecutionId !== (index === 0 ? null : attempts[index - 1].id) ||
      !orderedSubset(requested, keys) ||
      !orderedSubset(preserved, keys) ||
      requested.some((key) => preserved.includes(key) || touched.has(key)) ||
      keys.some((key) => !requested.includes(key) && !preserved.includes(key)) ||
      (index === 0 && (preserved.length > 0 || requested.length !== keys.length)) ||
      JSON.stringify(written) !== JSON.stringify(requested.slice(0, written.length)) ||
      !orderedSubset(attempt.completedFieldKeys, written) ||
      (attempt.attemptedFieldKey !== null && attempt.attemptedFieldKey !== written.at(-1))
    )
      recoveryBlocked("RECOVERY_HISTORY_UNVERIFIED");
    ids.add(attempt.id);
    written.forEach((key) => touched.add(key));
  }
  return { record, manifest, touched, keys, preparedPackage };
}

function recoveryPartition(
  comparison: VentureInputComparison,
  evidence: ReturnType<typeof recoveryEvidence>,
) {
  if (
    comparison.fields.some(
      (field) =>
        field.kind !== "text" || field.code !== null || !["matched", "empty"].includes(field.state),
    )
  )
    recoveryBlocked("RECOVERY_SCREEN_CONFLICT");
  const states = new Map(comparison.fields.map((field) => [field.fieldKey, field.state]));
  if (evidence.keys.some((key) => !states.has(key)) || states.size !== evidence.keys.length)
    recoveryBlocked("RECOVERY_SCREEN_CONFLICT");
  const requestedFieldKeys = evidence.keys.filter((key) => states.get(key) === "empty");
  const preserveFieldKeys = evidence.keys.filter((key) => states.get(key) === "matched");
  if (requestedFieldKeys.some((key) => evidence.touched.has(key)))
    recoveryBlocked("RECOVERY_PREVIOUS_INPUT_EMPTY");
  if (!requestedFieldKeys.length) recoveryBlocked("RECOVERY_NOTHING_TO_INPUT");
  return { requestedFieldKeys, preserveFieldKeys };
}

export async function prepareVentureRecovery(
  caseId: string,
  input: Versions,
): Promise<VentureRecoveryReview> {
  return withVentureInputCompanyLock(caseId, async () => {
    const store = assertVentureWorkflowVersions(caseId, input);
    const workflow = getVentureWorkflow(caseId);
    assertEligible(workflow);
    const evidence = recoveryEvidence(store, caseId, workflow, input);
    const receiptFingerprint = hash(evidence.record);
    const comparison = await compareLocked(caseId, input);
    assertVentureWorkflowVersions(caseId, input);
    const current = getVentureWorkflow(caseId);
    assertEligible(current);
    const currentEvidence = recoveryEvidence(store, caseId, current, input);
    if (hash(currentEvidence.record) !== receiptFingerprint)
      recoveryBlocked("RECOVERY_BINDING_CHANGED");
    const partition = recoveryPartition(comparison, currentEvidence);
    const approval = issueTicket({
      ...input,
      caseId,
      kind: "recovery",
      fingerprint: evidence.manifest.fingerprint,
      priorExecutionId: evidence.record.id,
      priorReceiptFingerprint: receiptFingerprint,
      ...partition,
      ...(evidence.preparedPackage && { preparedPackage: evidence.preparedPackage }),
    });
    return {
      scope: "text-recovery",
      ...approval,
      submissionReady: current.report.readyForLocalReview,
      remainingIssues: current.report.inputReadiness.deferredIssues,
      workflowRevision: input.revision,
      companyRevision: input.companyRevision,
      accountRevision: input.accountRevision,
      snapshotId: current.snapshot!.screen.id,
      sessionStartedAt: current.snapshot!.sessionStartedAt,
      destination: current.snapshot!.screen.url,
      companyName: store.get(caseId).profile.companyName,
      priorExecutionId: currentEvidence.record.id,
      observedAt: comparison.observedAt,
      fields: current.report.textFields.filter((field) =>
        partition.requestedFieldKeys.includes(field.fieldKey),
      ),
      fieldCount: partition.requestedFieldKeys.length,
      protectedFields: current.report.textFields
        .filter((field) => partition.preserveFieldKeys.includes(field.fieldKey))
        .map(({ fieldKey, label }) => ({ fieldKey, label })),
      ...(evidence.preparedPackage && { preparedPackage: evidence.preparedPackage }),
    };
  });
}

/** Called only under withVentureLock. A persisted running receipt consumes this screen before input. */
export async function executeVentureInput(
  caseId: string,
  input: { token: string; approved: true },
) {
  return withVentureInputCompanyLock(caseId, () => executeLocked(caseId, input, "normal"));
}

export async function executeVentureRecovery(
  caseId: string,
  input: { token: string; approved: true },
) {
  return withVentureInputCompanyLock(caseId, () => executeLocked(caseId, input, "recovery"));
}

async function executeLocked(
  caseId: string,
  input: { token: string; approved: true },
  kind: Ticket["kind"],
) {
  const ticket = tickets.get(input.token);
  if (
    !input.approved ||
    !ticket ||
    ticket.kind !== kind ||
    ticket.caseId !== caseId ||
    ticket.expiresAt <= Date.now()
  ) {
    if (ticket?.caseId === caseId) tickets.delete(input.token);
    throw new StudioError(
      "입력 승인이 없거나 검토안이 만료·사용되었습니다. 현재 상태를 확인하고 다시 준비해 주세요.",
      410,
      "INPUT_REVIEW_EXPIRED",
    );
  }
  // Consume even a stale ticket: approval is never carried to a changed company or browser state.
  tickets.delete(input.token);
  const store = assertVentureWorkflowVersions(caseId, ticket);
  const workflow = getVentureWorkflow(caseId);
  assertEligible(workflow);
  const { attachments, originals } = readReviewedAttachments(store, caseId, workflow);
  if (ticket.preparedPackage)
    assertPreparedConnection(store, caseId, workflow, attachments, ticket.preparedPackage);
  if (executionFingerprint(workflow, attachments, ticket.preparedPackage) !== ticket.fingerprint)
    throw new StudioError(
      "검토 후 계정·화면 또는 입력값이 바뀌었습니다. 다시 검토해 주세요.",
      409,
      "INPUT_REVIEW_CHANGED",
    );
  const { data } = readVentureWorkflowStored(store, caseId);
  let requestedFieldKeys = targetsFor(workflow).map(({ fieldKey }) => fieldKey);
  let preserveFieldKeys: string[] = [];
  let previousAttempts: VentureExecutionAttempt[] = [];
  let manifest: VentureExecutionRecord["manifest"] = {
    ...(ticket.preparedPackage
      ? { version: 2 as const, preparedPackage: ticket.preparedPackage }
      : { version: 1 as const }),
    fingerprint: ticket.fingerprint,
    draftFingerprint: hash(workflow.draft),
    caseId,
    companyRevision: ticket.companyRevision,
    accountRevision: ticket.accountRevision,
    workflowRevision: ticket.revision,
    snapshotId: workflow.snapshot!.screen.id,
    sessionStartedAt: workflow.snapshot!.sessionStartedAt,
    targets: targetsFor(workflow),
  };
  if (ticket.kind === "recovery") {
    const evidence = recoveryEvidence(store, caseId, workflow, ticket);
    if (
      evidence.record.id !== ticket.priorExecutionId ||
      hash(evidence.record) !== ticket.priorReceiptFingerprint
    )
      recoveryBlocked("RECOVERY_BINDING_CHANGED");
    const comparison = await compareLocked(caseId, ticket);
    assertVentureWorkflowVersions(caseId, ticket);
    const current = getVentureWorkflow(caseId);
    assertEligible(current);
    const currentEvidence = recoveryEvidence(store, caseId, current, ticket);
    if (hash(currentEvidence.record) !== ticket.priorReceiptFingerprint)
      recoveryBlocked("RECOVERY_BINDING_CHANGED");
    const partition = recoveryPartition(comparison, currentEvidence);
    if (
      JSON.stringify(partition.requestedFieldKeys) !== JSON.stringify(ticket.requestedFieldKeys) ||
      JSON.stringify(partition.preserveFieldKeys) !== JSON.stringify(ticket.preserveFieldKeys)
    )
      recoveryBlocked("RECOVERY_SCREEN_CHANGED");
    requestedFieldKeys = partition.requestedFieldKeys;
    preserveFieldKeys = partition.preserveFieldKeys;
    manifest = evidence.manifest;
    const { manifest: _manifest, previousAttempts: earlier, ...attempt } = evidence.record;
    void _manifest;
    previousAttempts = [...earlier!, attempt];
  } else if (data.execution?.snapshotId === workflow.snapshot!.screen.id)
    throw new StudioError(
      "같은 화면의 입력 시도는 반복하지 않습니다. 결과 확인 후 화면을 다시 읽어 주세요.",
      409,
      "INPUT_ALREADY_ATTEMPTED",
    );
  const started: VentureExecutionRecord = {
    id: randomUUID(),
    snapshotId: workflow.snapshot!.screen.id,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    completedFieldKeys: [],
    attachmentFieldKeys: [...new Set(attachments.map((file) => file.fieldKey))],
    attemptedFieldKey: null,
    code: null,
    manifest,
    previousAttempts,
    requestedFieldKeys,
    preservedFieldKeys: preserveFieldKeys,
    touchedFieldKeys: [],
    priorExecutionId: ticket.kind === "recovery" ? ticket.priorExecutionId : null,
  };
  store.saveVentureWorkflowEnvelope(
    caseId,
    ticket.revision,
    JSON.stringify({ ...data, execution: started }),
  );
  const runningRevision = ticket.revision + 1;
  const assertCurrent = () => {
    assertVentureWorkflowVersions(caseId, { ...ticket, revision: runningRevision });
    const current = getVentureWorkflow(caseId);
    assertEligible(current);
    if (ticket.preparedPackage)
      assertPreparedConnection(store, caseId, current, attachments, ticket.preparedPackage);
    if (
      executionFingerprint(current, attachments, ticket.preparedPackage) !== ticket.fingerprint ||
      current.execution?.id !== started.id
    )
      throw new StudioError("입력 중 검토 상태가 바뀌었습니다.", 409, "INPUT_REVIEW_CHANGED");
  };
  let execution: VentureExecutionRecord;
  try {
    const result = await fillVentureApplication(
      caseId,
      {
        snapshot: workflow.snapshot!.screen,
        sessionStartedAt: workflow.snapshot!.sessionStartedAt,
        businessNumber: store.get(caseId).profile.businessNumber,
        fields: workflow.report.textFields.map(({ fieldKey, value }) => ({ fieldKey, value })),
        ...(ticket.kind === "recovery" ? { preserveFieldKeys } : {}),
        attachments: started.attachmentFieldKeys.map((fieldKey) => ({
          fieldKey,
          files: attachments
            .filter((file) => file.fieldKey === fieldKey)
            .map((file) => ({
              name: file.originalName,
              mimeType:
                file.mimeType?.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream",
              buffer: originals.get(file.sourceId)!.buffer,
            })),
        })),
      },
      assertCurrent,
    );
    if (ticket.preparedPackage) assertCurrent();
    if (
      !Array.isArray(result.touchedFieldKeys) ||
      !unique(result.touchedFieldKeys) ||
      JSON.stringify(result.touchedFieldKeys) !==
        JSON.stringify(requestedFieldKeys.slice(0, result.touchedFieldKeys.length)) ||
      !orderedSubset(result.completedFieldKeys, result.touchedFieldKeys) ||
      (result.attemptedFieldKey !== null &&
        result.attemptedFieldKey !== result.touchedFieldKeys.at(-1)) ||
      (result.status === "completed" &&
        (result.code !== null ||
          result.attemptedFieldKey !== null ||
          result.completedFieldKeys.length !== requestedFieldKeys.length)) ||
      (result.status === "stopped" && result.code === null)
    )
      throw new Error("Invalid runner outcome");
    execution = ventureExecutionRecordSchema.parse({
      ...started,
      ...result,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    // A process/runner failure cannot prove zero writes; keep an explicit unknown outcome.
    execution = {
      ...started,
      status: "stopped",
      finishedAt: new Date().toISOString(),
      code: "INPUT_RESULT_UNKNOWN",
    };
  }
  // If persistence fails, the running record remains a durable warning, never a success claim.
  store.saveVentureWorkflowEnvelope(
    caseId,
    runningRevision,
    JSON.stringify({ ...data, execution }),
  );
  return { execution, workflow: getVentureWorkflow(caseId) };
}
