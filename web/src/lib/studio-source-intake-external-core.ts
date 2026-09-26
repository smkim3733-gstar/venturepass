import { createHash } from "node:crypto";
import { z } from "zod";
import { StudioError } from "./studio-http";
import type { SourceDocument } from "./studio-schema";
import type { SourceIntakeItem } from "./studio-source-intake-types";
import { sourceIntakeLimits } from "./studio-source-intake-types";
import { validateSourceIntakeOriginal } from "./studio-source-intake-original";
import { validateSourceIntakeAudio } from "./studio-source-intake-audio";
import {
  runExternalSourceIntakeSchema,
  sourceIntakeExternalApprovalSchema,
  sourceIntakeExternalAttemptSchema,
  sourceIntakeExternalConfigurationSchema,
  sourceIntakeExternalSupports,
  type RunExternalSourceIntakeCommand,
  type SourceIntakeExternalApproval,
  type SourceIntakeExternalAttempt,
  type SourceIntakeExternalConfiguration,
} from "./studio-source-intake-external-types";

type ExternalAttemptState = {
  id: string;
  engine: string;
  status: string;
  externalRequestStarted: boolean;
  externalApproval?: SourceIntakeExternalApproval;
  approvalSha256?: string;
  clientRequestId?: string;
};
// Structural view allows new isolated helpers to be tested before the legacy intake schema expands.
export type ExternalIntakeItemState = Pick<
  SourceIntakeItem,
  "id" | "sourceId" | "version" | "original" | "adoption" | "requests"
> & {
  phase: string;
  attempts: ExternalAttemptState[];
  result: { content: unknown | null } | null;
};
export type ExternalIntakeCompanyState = {
  id: string;
  revision: number;
  sources: SourceDocument[];
};
export type ExternalIntakeOriginal = { source: SourceDocument; buffer: Buffer; sha256: string };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function externalIntakeError(code: string, status = 409): never {
  const messages: Record<string, string> = {
    INTAKE_EXTERNAL_APPROVAL_STALE:
      "승인한 원본·접수 버전·모델 또는 전송 대상이 바뀌었습니다. 정확한 요청을 다시 확인해 주세요.",
    INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED:
      "이전 외부 처리 결과가 미확인입니다. 중복 처리와 비용 가능성을 확인한 새 요청만 보낼 수 있습니다.",
    INTAKE_EXTERNAL_RECOVERY_REQUIRED:
      "이전 외부 요청의 저장 상태를 먼저 확인해 주세요. 재개는 외부 파일을 다시 보내지 않습니다.",
    INTAKE_EXTERNAL_RESULT_UNKNOWN:
      "외부 처리 결과를 확인하지 못했습니다. 자동 재전송하지 않으며 보관한 원본과 요청 이력은 유지합니다.",
    INTAKE_EXTERNAL_PHASE_INVALID:
      "현재 접수 단계에서는 새 외부 요청을 보낼 수 없습니다. 보관된 판독문을 먼저 확인해 주세요.",
    INTAKE_EXTERNAL_ORIGINAL_CHANGED:
      "승인할 원본의 본문·해시·형식 또는 수정시각이 접수 정보와 다릅니다.",
    INTAKE_EXTERNAL_LIMIT: "외부 요청 이력의 보관 한도에 도달했습니다. 기존 기록은 유지합니다.",
  };
  throw new StudioError(messages[code] ?? "외부 요청의 저장 상태를 확인해 주세요.", status, code);
}
export const externalIntakeApprovalSha = (approval: SourceIntakeExternalApproval) =>
  hash(JSON.stringify(sourceIntakeExternalApprovalSchema.parse(approval)));
export function externalIntakeRequestDigest(raw: RunExternalSourceIntakeCommand) {
  const { revision: _revision, ...input } = runExternalSourceIntakeSchema.parse(raw);
  void _revision;
  return hash(JSON.stringify(input));
}
export function externalIntakeNeedsDuplicateAcknowledgement(item: ExternalIntakeItemState) {
  return item.attempts.some(
    (attempt) => attempt.externalRequestStarted && attempt.status !== "completed",
  );
}
function assertReady(item: ExternalIntakeItemState) {
  if (item.phase === "requesting_external")
    externalIntakeError("INTAKE_EXTERNAL_RECOVERY_REQUIRED");
  if (
    item.adoption ||
    item.result?.content != null ||
    !item.original ||
    ![
      "original_stored",
      "awaiting_method",
      "awaiting_capacity",
      "retryable_failure",
      "result_discarded",
      "external_result_unknown",
    ].includes(item.phase)
  )
    externalIntakeError("INTAKE_EXTERNAL_PHASE_INVALID");
  if (
    item.attempts.length >= sourceIntakeLimits.attempts ||
    // Reserve one durable request receipt for an interrupted external attempt's explicit recovery.
    item.requests.length >= sourceIntakeLimits.requests - 1
  )
    externalIntakeError("INTAKE_EXTERNAL_LIMIT", 413);
}
/** Builds the exact approval displayed to the user. Reads only supplied server-owned state/bytes. */
export function buildExternalIntakeApproval(
  company: ExternalIntakeCompanyState,
  item: ExternalIntakeItemState,
  rawConfiguration: SourceIntakeExternalConfiguration,
  original: ExternalIntakeOriginal,
): SourceIntakeExternalApproval {
  assertReady(item);
  const configuration = sourceIntakeExternalConfigurationSchema.parse(rawConfiguration),
    stored = item.original!,
    matches = company.sources.filter((source) => source.id === item.sourceId);
  if (
    matches.length !== 1 ||
    JSON.stringify(matches[0]) !== JSON.stringify(original.source) ||
    original.source.extraction !== "pending" ||
    original.source.text !== "" ||
    original.source.id !== item.sourceId ||
    original.source.updatedAt !== stored.sourceUpdatedAt ||
    original.source.originalName !== stored.originalName ||
    original.source.mimeType !== stored.mimeType ||
    original.sha256 !== stored.sha256 ||
    hash(original.buffer) !== stored.sha256 ||
    original.buffer.length !== stored.sizeBytes ||
    !sourceIntakeExternalSupports(stored.originalName, configuration.engine)
  )
    externalIntakeError("INTAKE_EXTERNAL_ORIGINAL_CHANGED");
  const file = { name: stored.originalName, mimeType: stored.mimeType, buffer: original.buffer };
  if (configuration.engine === "ai-transcription") validateSourceIntakeAudio(file);
  else validateSourceIntakeOriginal(file);
  return sourceIntakeExternalApprovalSchema.parse({
    version: 1,
    caseId: company.id,
    itemId: item.id,
    itemVersion: item.version,
    sourceId: item.sourceId,
    sourceUpdatedAt: stored.sourceUpdatedAt,
    originalSha256: stored.sha256,
    originalName: stored.originalName,
    mimeType: stored.mimeType,
    sizeBytes: stored.sizeBytes,
    ...configuration,
  });
}
/** Call inside the durable store transaction invoked by the provider's beforeRequest callback. */
export function buildExternalIntakeAttempt(
  company: ExternalIntakeCompanyState,
  item: ExternalIntakeItemState,
  raw: RunExternalSourceIntakeCommand,
  configuration: SourceIntakeExternalConfiguration,
  original: ExternalIntakeOriginal,
  generated: { id: string; startedAt: string },
): SourceIntakeExternalAttempt {
  const input = runExternalSourceIntakeSchema.parse(raw);
  if (
    company.revision !== input.revision ||
    item.id !== input.itemId ||
    item.version !== input.expectedItemVersion ||
    company.id !== input.approval.caseId
  )
    externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
  if (
    item.attempts.some(
      (attempt) => attempt.id === generated.id || attempt.clientRequestId === input.clientRequestId,
    )
  )
    externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
  const approval = buildExternalIntakeApproval(company, item, configuration, original);
  if (JSON.stringify(approval) !== JSON.stringify(input.approval))
    externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
  if (externalIntakeNeedsDuplicateAcknowledgement(item) && !input.acknowledgePossibleDuplicate)
    externalIntakeError("INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED");
  return sourceIntakeExternalAttemptSchema.parse({
    ...generated,
    engine: approval.engine,
    finishedAt: null,
    originalSha256: approval.originalSha256,
    sourceUpdatedAt: approval.sourceUpdatedAt,
    externalRequestStarted: true,
    externalApproval: approval,
    approvalSha256: externalIntakeApprovalSha(approval),
    clientRequestId: input.clientRequestId,
    acknowledgePossibleDuplicate: input.acknowledgePossibleDuplicate,
    status: "running",
    code: null,
    resultId: null,
  });
}
export function currentExternalIntakeAttempt(
  item: ExternalIntakeItemState,
): SourceIntakeExternalAttempt {
  const parsed = sourceIntakeExternalAttemptSchema.safeParse(item.attempts.at(-1));
  if (
    !parsed.success ||
    item.phase !== "requesting_external" ||
    parsed.data.status !== "running" ||
    parsed.data.resultId !== null ||
    parsed.data.finishedAt !== null ||
    parsed.data.approvalSha256 !== externalIntakeApprovalSha(parsed.data.externalApproval) ||
    parsed.data.engine !== parsed.data.externalApproval.engine ||
    parsed.data.externalApproval.itemId !== item.id ||
    parsed.data.externalApproval.sourceId !== item.sourceId ||
    parsed.data.externalApproval.itemVersion + 1 !== item.version ||
    parsed.data.originalSha256 !== parsed.data.externalApproval.originalSha256 ||
    parsed.data.sourceUpdatedAt !== parsed.data.externalApproval.sourceUpdatedAt
  )
    return externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
  const attempt = parsed.data,
    receipts = item.requests.filter(
      (request) => request.clientRequestId === attempt.clientRequestId,
    );
  if (
    receipts.length !== 1 ||
    receipts[0].action !== "run-external" ||
    receipts[0].inputDigest !==
      externalIntakeRequestDigest({
        action: "run-external",
        revision: 0,
        clientRequestId: attempt.clientRequestId,
        itemId: item.id,
        expectedItemVersion: attempt.externalApproval.itemVersion,
        approval: attempt.externalApproval,
        approved: true,
        acknowledgePossibleDuplicate: attempt.acknowledgePossibleDuplicate,
      })
  )
    externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
  return parsed.data;
}
/** A restart/timeout is not evidence of non-delivery. It never creates a new attempt. */
export function unknownExternalIntakeAttempt(
  item: ExternalIntakeItemState,
  finishedAt: string,
): SourceIntakeExternalAttempt {
  const attempt = currentExternalIntakeAttempt(item);
  z.string().datetime().parse(finishedAt);
  return { ...attempt, status: "unknown", finishedAt, code: "INTAKE_EXTERNAL_RESULT_UNKNOWN" };
}
/** Final commit precondition; source mutations and stale/late provider responses fail closed. */
export function assertExternalIntakeResultBinding(
  company: ExternalIntakeCompanyState,
  item: ExternalIntakeItemState,
  binding: { revision: number; itemId: string; itemVersion: number; attemptId: string },
  original: ExternalIntakeOriginal,
) {
  const attempt = currentExternalIntakeAttempt(item),
    approval = attempt.externalApproval;
  if (
    company.revision !== binding.revision ||
    company.id !== approval.caseId ||
    item.id !== binding.itemId ||
    item.version !== binding.itemVersion ||
    attempt.id !== binding.attemptId ||
    !item.original ||
    item.original.sha256 !== approval.originalSha256 ||
    item.original.sourceUpdatedAt !== approval.sourceUpdatedAt ||
    item.original.originalName !== approval.originalName ||
    item.original.mimeType !== approval.mimeType ||
    item.original.sizeBytes !== approval.sizeBytes
  )
    externalIntakeError("INTAKE_EXTERNAL_APPROVAL_STALE");
  const sources = company.sources.filter((source) => source.id === item.sourceId);
  if (
    sources.length !== 1 ||
    JSON.stringify(sources[0]) !== JSON.stringify(original.source) ||
    original.source.id !== approval.sourceId ||
    original.source.updatedAt !== approval.sourceUpdatedAt ||
    original.source.originalName !== approval.originalName ||
    original.source.mimeType !== approval.mimeType ||
    original.source.extraction !== "pending" ||
    original.source.text !== "" ||
    original.sha256 !== approval.originalSha256 ||
    hash(original.buffer) !== approval.originalSha256 ||
    original.buffer.length !== approval.sizeBytes
  )
    externalIntakeError("INTAKE_EXTERNAL_ORIGINAL_CHANGED");
  return attempt;
}
