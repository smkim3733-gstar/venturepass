import { caseSchema, type StudioCase, type SourceDocument } from "@/lib/studio-schema";
import { sourceIntakeExternalAttemptSchema } from "@/lib/studio-source-intake-external-types";
import {
  sourceIntakeCommandSchema,
  sourceIntakeItemSchema,
  sourceIntakeLimits,
  sourceIntakeNameSchema,
  type SourceIntakeCommand,
  type SourceIntakeItem,
  type SourceIntakeOriginalInput,
} from "@/lib/studio-source-intake-types";

export type IntakeFile = { clientFileId: string; file: File; kind: SourceDocument["kind"] };
export type IntakePending =
  | { kind: "command"; command: SourceIntakeCommand }
  | { kind: "original"; itemId: string; input: SourceIntakeOriginalInput; file: File };
export const intakeNonce = (request: IntakePending) =>
  request.kind === "command" ? request.command.clientRequestId : request.input.clientRequestId;
export const intakeRevision = (request: IntakePending) =>
  request.kind === "command" ? request.command.revision : request.input.revision;
export function intakeFileError(file: Pick<File, "name" | "size">): string {
  if (!sourceIntakeNameSchema.safeParse(file.name).success)
    return "지원 형식·파일 이름을 확인해 주세요.";
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > sourceIntakeLimits.fileBytes
  )
    return "파일 크기는 1바이트 이상 12MiB 이하여야 합니다.";
  return "";
}
export function intakeBatchError(files: IntakeFile[]): string {
  if (files.length === 0) return "접수할 파일을 선택해 주세요.";
  if (files.length > sourceIntakeLimits.filesPerBatch)
    return "한 번에 최대 10개 파일을 선택해 주세요.";
  if (new Set(files.map((entry) => entry.clientFileId)).size !== files.length)
    return "파일 선택 식별자를 다시 확인해 주세요.";
  if (files.reduce((total, entry) => total + entry.file.size, 0) > sourceIntakeLimits.batchBytes)
    return "한 묶음의 합계는 24MiB 이하여야 합니다.";
  return "";
}
export function intakeRequestAcknowledged(
  company: StudioCase,
  companyId: string,
  request: IntakePending,
): boolean {
  if (company.id !== companyId || company.revision < intakeRevision(request)) return false;
  const action = request.kind === "command" ? request.command.action : "original";
  if (
    company.sourceIntakes
      .flatMap((item) => item.requests)
      .filter((receipt) => receipt.clientRequestId === intakeNonce(request)).length !== 1
  )
    return false;
  const receipts = company.sourceIntakes.filter((item) =>
    item.requests.some(
      (entry) => entry.clientRequestId === intakeNonce(request) && entry.action === action,
    ),
  );
  if (receipts.length !== 1) return false;
  if (request.kind === "command" && request.command.action === "create") {
    const input = request.command;
    const batch = company.sourceIntakes.filter((item) => item.batchId === receipts[0].batchId);
    return (
      batch.length === input.files.length &&
      input.files.every((file) => {
        const matches = batch.filter((item) => item.clientFileId === file.clientFileId);
        return (
          matches.length === 1 &&
          matches[0].declared.originalName === file.originalName &&
          matches[0].declared.sizeBytes === file.sizeBytes &&
          matches[0].declared.kind === file.kind
        );
      })
    );
  }
  const targetId =
    request.kind === "original"
      ? request.itemId
      : request.command.action === "create"
        ? ""
        : request.command.itemId;
  const item = receipts[0];
  if (
    item.id !== targetId ||
    company.sourceIntakes.filter((entry) => entry.id === targetId).length !== 1
  )
    return false;
  const expectedVersion =
    request.kind === "original"
      ? request.input.expectedItemVersion
      : request.command.action === "create"
        ? 0
        : request.command.expectedItemVersion;
  if (item.version < expectedVersion) return false;
  if (request.kind === "original")
    return (
      item.declared.originalName === request.file.name &&
      item.declared.sizeBytes === request.file.size
    );
  if (request.command.action === "adopt") {
    const input = request.command,
      sources = company.sources.filter((source) => source.id === item.sourceId);
    return (
      item.phase === "adopted" &&
      item.adoption?.clientRequestId === input.clientRequestId &&
      item.adoption.resultId === input.resultId &&
      sources.length === 1 &&
      sources[0].extraction === "manual" &&
      sources[0].text === input.text.trim()
    );
  }
  if (request.command.action === "discard-result")
    return (
      item.result?.id === request.command.resultId &&
      item.result.content === null &&
      Boolean(item.result.discardedAt)
    );
  if (request.command.action === "cancel-awaiting-original")
    return (
      item.phase === "cancelled" &&
      item.original === null &&
      item.attempts.length === 0 &&
      item.version > request.command.expectedItemVersion
    );
  if (request.command.action === "run-external") {
    const input = request.command;
    const attempts = item.attempts.filter(
      (attempt) =>
        attempt.externalRequestStarted &&
        "clientRequestId" in attempt &&
        attempt.clientRequestId === input.clientRequestId,
    );
    if (attempts.length !== 1 || item.version <= input.expectedItemVersion) return false;
    const parsed = sourceIntakeExternalAttemptSchema.safeParse(attempts[0]);
    return (
      parsed.success &&
      parsed.data.engine === input.approval.engine &&
      parsed.data.originalSha256 === input.approval.originalSha256 &&
      parsed.data.sourceUpdatedAt === input.approval.sourceUpdatedAt &&
      parsed.data.acknowledgePossibleDuplicate === input.acknowledgePossibleDuplicate &&
      JSON.stringify(parsed.data.externalApproval) === JSON.stringify(input.approval)
    );
  }
  return true;
}
export function validateIntakeStatus(
  raw: unknown,
  companyId: string,
  revision: number,
): { company: StudioCase; activeItemIds: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>,
    parsed = caseSchema.safeParse(value.company);
  if (
    !parsed.success ||
    parsed.data.id !== companyId ||
    parsed.data.revision < revision ||
    !Array.isArray(value.activeItemIds)
  )
    return null;
  const active = value.activeItemIds;
  if (
    active.some(
      (id) =>
        typeof id !== "string" ||
        parsed.data.sourceIntakes.filter((item) => item.id === id).length !== 1,
    ) ||
    new Set(active).size !== active.length
  )
    return null;
  return { company: parsed.data, activeItemIds: active as string[] };
}
export function validateIntakeResponse(
  raw: unknown,
  companyId: string,
  request: IntakePending,
  minimumRevision = intakeRevision(request),
): StudioCase | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>,
    parsed = caseSchema.safeParse(value.company);
  if (
    !parsed.success ||
    parsed.data.revision < minimumRevision ||
    !intakeRequestAcknowledged(parsed.data, companyId, request)
  )
    return null;
  const matching = parsed.data.sourceIntakes.find((item) =>
    item.requests.some((receipt) => receipt.clientRequestId === intakeNonce(request)),
  );
  if (!matching || value.batchId !== matching.batchId) return null;
  if (request.kind === "command" && request.command.action === "create")
    return value.item === null ? parsed.data : null;
  const item = sourceIntakeItemSchema.safeParse(value.item);
  return item.success && JSON.stringify(item.data) === JSON.stringify(matching)
    ? parsed.data
    : null;
}
export function intakeCommand(command: SourceIntakeCommand): IntakePending {
  return { kind: "command", command: sourceIntakeCommandSchema.parse(command) };
}
export function intakeCanRead(item: SourceIntakeItem) {
  return (
    [
      "original_stored",
      "awaiting_method",
      "retryable_failure",
      "awaiting_capacity",
      "result_discarded",
    ].includes(item.phase) &&
    Boolean(item.original) &&
    !item.result?.content &&
    !item.adoption
  );
}
export function intakeCanResume(item: SourceIntakeItem) {
  return ["storing_original", "extracting_local", "requesting_external"].includes(item.phase);
}
/** External uncertainty checks never repeat POST, even with the same client nonce. */
export function intakeReplayIsReadOnly(request: IntakePending) {
  return request.kind === "command" && request.command.action === "run-external";
}
export function intakeCanUpload(item: SourceIntakeItem) {
  return item.phase === "awaiting_original";
}
export function intakeCanCancel(item: SourceIntakeItem) {
  return item.phase === "awaiting_original" && !item.original && item.attempts.length === 0;
}
export function intakePendingState(
  company: StudioCase,
  companyId: string,
  request: IntakePending,
  rejected: boolean,
  activeItemIds: string[],
): "acknowledged" | "rejected" | "unknown" {
  if (intakeRequestAcknowledged(company, companyId, request)) return "acknowledged";
  return company.id === companyId &&
    company.revision >= intakeRevision(request) &&
    rejected &&
    activeItemIds.length === 0
    ? "rejected"
    : "unknown";
}

export class IntakeHttpError extends Error {
  constructor(
    readonly code: string,
    readonly accepted: boolean | null,
  ) {
    super("요청 결과를 확인해 주세요. 저장된 상태를 조회한 뒤 진행할 수 있습니다.");
  }
}
export function intakeErrorMessage(code: string): string {
  if (code === "INTAKE_AI_NOT_CONFIGURED")
    return "외부 판독·전사 설정이 준비되지 않았습니다. 설정을 확인한 뒤 새 전송 검토안을 열어 주세요. 원본은 보관합니다.";
  if (code === "INTAKE_EXTERNAL_RESULT_UNKNOWN")
    return "외부 처리 결과가 미확인입니다. 이미 처리·과금됐을 수 있습니다. 저장 상태 확인과 재개는 다시 전송하지 않으며, 새 전송에는 별도 승인과 중복 비용 확인이 필요합니다.";
  if (code === "INTAKE_EXTERNAL_RECOVERY_REQUIRED")
    return "이전 외부 요청의 저장 상태를 먼저 확인해 주세요. 외부 요청 상태 정리는 미확인 기록만 남기며 파일을 다시 보내지 않습니다.";
  if (code === "INTAKE_EXTERNAL_DUPLICATE_ACK_REQUIRED")
    return "이전 요청의 중복 처리·비용 가능성을 새 전송 검토안에서 확인해 주세요. 기존 승인을 재사용하지 않습니다.";
  if (["INTAKE_EXTERNAL_APPROVAL_STALE", "INTAKE_EXTERNAL_PHASE_INVALID"].includes(code))
    return "원본·자료·모델 설정 또는 처리 단계가 바뀌었습니다. 저장 상태 확인 후 새 전송 검토안을 직접 열어 주세요.";
  if (code === "INTAKE_EXTERNAL_ORIGINAL_CHANGED")
    return "승인할 원본의 해시·형식·수정시각이 접수 정보와 다릅니다. 원본을 보존하고 연결 상태를 먼저 확인해 주세요.";
  if (code === "INTAKE_EXTERNAL_LIMIT")
    return "외부 요청 이력의 보관 한도에 도달했습니다. 기존 원본과 요청 이력을 보존합니다.";
  if (code === "INTAKE_ORIGINAL_FORMAT")
    return "확장자와 실제 파일 형식이 달라 원본을 접수하지 못했습니다. 파일을 확인하거나 미접수 항목을 취소해 주세요.";
  if (["INTAKE_RECOVERY_REQUIRED", "INTAKE_ORIGINAL_CHANGED"].includes(code))
    return "보관 원본 또는 저장 기록이 일치하지 않습니다. 원본을 보존하고 복구 상태를 확인해 주세요. 같은 파일을 반복 접수하지 마세요.";
  if (
    ["INTAKE_ORIGINAL_INVALID", "INTAKE_METHOD_UNSUPPORTED", "OCR_UNSUPPORTED_FORMAT"].includes(
      code,
    )
  )
    return "파일 내용·형식 또는 선택한 판독 방법이 맞지 않습니다. 원본과 지원 형식을 확인해 주세요.";
  if (
    [
      "INTAKE_LIMIT",
      "INTAKE_RESULT_LIMIT",
      "SOURCE_LIMIT",
      "INTAKE_OUTPUT_LIMIT",
      "OCR_OUTPUT_LIMIT",
    ].includes(code)
  )
    return "접수·판독문 보관 한도를 확인해 주세요. 이미 보관한 원본과 결과는 자동 삭제하지 않습니다.";
  if (["INTAKE_BUSY", "OCR_BUSY"].includes(code))
    return "다른 로컬 처리가 진행 중입니다. 완료 여부를 저장 상태에서 확인해 주세요.";
  if (
    [
      "INTAKE_STALE",
      "STALE_REVISION",
      "INTAKE_ATTEMPT_CHANGED",
      "INTAKE_PHASE_INVALID",
      "INTAKE_SOURCE_NOT_PENDING",
    ].includes(code)
  )
    return "기업 자료 또는 작업 단계가 바뀌었습니다. 저장 상태를 확인한 뒤 현재 단계에서 진행해 주세요.";
  if (code === "INTAKE_NO_TEXT")
    return "이 방법으로 읽힌 본문이 없습니다. 원본을 확인하고 지원되는 다른 로컬 판독 방법을 선택해 주세요.";
  if (["OCR_PLATFORM_UNSUPPORTED", "OCR_LANGUAGE_UNAVAILABLE"].includes(code))
    return "이 PC에서 필요한 Windows 한국어 OCR을 사용할 수 없습니다. 원본을 대조해 직접 본문을 입력할 수 있습니다.";
  if (
    ["INTAKE_PAGE_LIMIT", "OCR_PAGE_LIMIT", "INTAKE_FILE_LIMIT", "OCR_IMAGE_LIMIT"].includes(code)
  )
    return "파일 크기·페이지 수 또는 이미지 크기가 로컬 판독 한도를 넘었습니다. 원본을 보존하고 필요한 본문을 직접 확인해 주세요.";
  if (code === "OCR_TIMEOUT")
    return "로컬 판독 제한 시간이 지났습니다. 저장 상태를 확인하기 전에는 같은 단계를 다시 시작하지 않습니다.";
  if (code === "INTAKE_INTERRUPTED")
    return "이전 로컬 처리가 중단되었습니다. 저장된 단계와 원본을 확인한 뒤 명시적으로 재개할 수 있습니다.";
  return "요청 결과를 확인하지 못했습니다. 저장 상태를 먼저 확인해 주세요. 확인 전에는 새 요청을 보내지 않습니다.";
}
export async function sendIntakeRequest(
  endpoint: string,
  request: IntakePending,
): Promise<unknown> {
  let url = endpoint,
    options: RequestInit;
  if (request.kind === "command")
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.command),
      cache: "no-store",
    };
  else {
    url += `/${request.itemId}/original`;
    const body = new FormData();
    body.append("file", request.file);
    body.append("revision", String(request.input.revision));
    body.append("clientRequestId", request.input.clientRequestId);
    body.append("expectedItemVersion", String(request.input.expectedItemVersion));
    options = { method: "PUT", body, cache: "no-store" };
  }
  const response = await fetch(url, options),
    raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const code =
      typeof body.code === "string" && /^[A-Z0-9_]{1,100}$/.test(body.code)
        ? body.code
        : "INTAKE_RESPONSE_FAILED";
    throw new IntakeHttpError(code, typeof body.accepted === "boolean" ? body.accepted : null);
  }
  return raw;
}
