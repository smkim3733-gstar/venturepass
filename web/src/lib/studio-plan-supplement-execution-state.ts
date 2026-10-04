import { StudioError } from "./studio-http";
import type { StudioCase } from "./studio-schema";
import { answerSuggestionSha } from "./studio-answer-suggestion";
import { preparePlanSupplement } from "./studio-plan-supplement";
import {
  planSupplementExecutionApprovalSchema,
  planSupplementExecutionRecordSchema,
  type PlanSupplementExecutionCommand,
  type PlanSupplementExecutionRecord,
} from "./studio-plan-supplement-execution-types";
import type { PlanSupplementInput } from "./studio-plan-supplement-types";

export const supplementDigest = (value: unknown) => answerSuggestionSha(JSON.stringify(value));
export function supplementExecutionError(code: string): never {
  throw new StudioError(
    "수정안 요청의 저장 상태와 기준 원고를 확인해 주세요. 새 요청으로 다시 전송하지 않습니다.",
    409,
    code,
  );
}
/** Server-selected model and exact current input; this read does not grant execution ownership. */
export function buildPlanSupplementExecutionApproval(
  company: StudioCase,
  input: PlanSupplementInput,
  model: string,
) {
  const prepared = preparePlanSupplement(company, input);
  return planSupplementExecutionApprovalSchema.parse({
    purpose: "propose-one-section-supplement",
    requestVersion: "one-section-supplement-v1",
    provider: "openai",
    destination: "https://api.openai.com/v1/responses",
    model,
    binding: prepared.binding,
    payloadSha256: prepared.binding.payloadSha256,
    targetBodyIncluded: true,
    originalFilesIncluded: false,
    otherSectionsIncluded: false,
    callLimit: 1,
    automaticRetryLimit: 0,
  });
}
/** Audit all retained requests before looking up an original nonce. No current clock/key/model required. */
export function auditPlanSupplementExecutions(company: StudioCase) {
  const ids = new Set<string>(),
    nonces = new Set<string>();
  let previous: PlanSupplementExecutionRecord | null = null;
  for (const raw of company.planSupplementExecutions ?? []) {
    const parsed = planSupplementExecutionRecordSchema.safeParse(raw);
    if (!parsed.success) supplementExecutionError("SUPPLEMENT_HISTORY_INVALID");
    const record = parsed.data;
    if (
      (previous !== null &&
        (previous.capture === null ||
          previous.capture.kind === "unobserved" ||
          previous.finishedRevision === null ||
          previous.finishedRevision >= record.reservationRevision)) ||
      ids.has(record.id) ||
      nonces.has(record.command.clientRequestId) ||
      record.commandSha256 !== supplementDigest(record.command) ||
      record.command.approval.binding.answer.caseId !== company.id ||
      record.command.approval.binding.answer.companyRevision !== record.command.input.revision ||
      record.command.approval.payloadSha256 !== record.command.approval.binding.payloadSha256 ||
      supplementDigest(record.command.input.target) !==
        supplementDigest(record.command.approval.binding.answer.target) ||
      record.command.input.sectionKey !== record.command.approval.binding.sectionKey ||
      supplementDigest(record.command.input.sourceSelections) !==
        supplementDigest(
          record.command.approval.binding.answer.sources.map(
            ({ sourceId, sourceUpdatedAt, textSha256 }) => ({
              sourceId,
              sourceUpdatedAt,
              textSha256,
            }),
          ),
        ) ||
      (record.capture !== null && record.captureSha256 !== supplementDigest(record.capture)) ||
      record.reservationRevision > company.revision ||
      (record.finishedRevision !== null && record.finishedRevision > company.revision)
    )
      supplementExecutionError("SUPPLEMENT_HISTORY_INVALID");
    previous = record;
    ids.add(record.id);
    nonces.add(record.command.clientRequestId);
  }
}
export function replayPlanSupplementExecution(
  company: StudioCase,
  command: PlanSupplementExecutionCommand,
) {
  auditPlanSupplementExecutions(company);
  const record = company.planSupplementExecutions?.find(
    (item) => item.command.clientRequestId === command.clientRequestId,
  );
  if (record && record.commandSha256 !== supplementDigest(command))
    supplementExecutionError("SUPPLEMENT_REQUEST_CONFLICT");
  return record ? structuredClone(record) : null;
}
/** Only the reservation's own revision increment is normalized; any unrelated write blocks dispatch. */
export function currentPlanSupplementPayload(
  company: StudioCase,
  record: PlanSupplementExecutionRecord,
  model: string,
) {
  auditPlanSupplementExecutions(company);
  if (company.revision !== record.reservationRevision || record.capture !== null)
    supplementExecutionError("SUPPLEMENT_CURRENT_CHANGED");
  const original = { ...company, revision: record.command.input.revision };
  const approval = buildPlanSupplementExecutionApproval(original, record.command.input, model);
  if (supplementDigest(approval) !== supplementDigest(record.command.approval))
    supplementExecutionError("SUPPLEMENT_APPROVAL_CHANGED");
  return preparePlanSupplement(original, record.command.input).payload;
}
