import { createHash, randomUUID } from "node:crypto";
import { StudioError } from "./studio-http";
import {
  sourceLocationLimits,
  sourceLocationMetadataSchema,
  type SourceLocationMetadata,
} from "./studio-source-location-types";
import { validateSourceLocationMetadata } from "./studio-source-location";
import { originalOnlyWarnings, type StudioCase, type SourceDocument } from "./studio-schema";
import {
  sourceIntakeLimits,
  sourceIntakeResultText,
  type CreateSourceIntakeCommand,
  type SourceIntakeItem,
  type SourceIntakeResponse,
} from "./studio-source-intake-types";

export function intakeError(code: string, status = 409): never {
  const messages: Record<string, string> = {
    INTAKE_NOT_FOUND: "접수 항목을 찾을 수 없습니다.",
    INTAKE_STALE: "접수 항목 또는 기업 자료가 변경되었습니다. 저장 상태를 다시 확인해 주세요.",
    INTAKE_NONCE_CONFLICT: "같은 요청 식별자에 다른 입력이 사용되었습니다.",
    INTAKE_PHASE_INVALID: "현재 접수 단계에서는 요청한 작업을 할 수 없습니다.",
    INTAKE_LIMIT: "접수 이력의 보관 한도에 도달했습니다. 기존 기록은 보존됩니다.",
    INTAKE_RESULT_LIMIT: "미검토 판독문 보관 한도에 도달했습니다. 원본은 보존됩니다.",
    INTAKE_ORIGINAL_CHANGED: "접수 당시 원본과 현재 원본이 다릅니다. 결과를 저장하지 않았습니다.",
    INTAKE_ORIGINAL_INVALID: "원본 파일의 이름, 형식 또는 크기가 접수 정보와 다릅니다.",
    INTAKE_SOURCE_NOT_PENDING: "이미 본문이 저장된 자료입니다. 기존 본문을 덮어쓰지 않습니다.",
    INTAKE_RESULT_INVALID: "판독 결과 형식이나 본문을 확인할 수 없습니다.",
    INTAKE_RECOVERY_REQUIRED: "원본 저장 확인이 끝나지 않았습니다. 접수 복구를 먼저 실행해 주세요.",
  };
  throw new StudioError(
    messages[code] ?? "접수 상태를 확인한 뒤 다시 시도해 주세요.",
    status,
    code,
  );
}
export function intakeSha(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function intakeDigest(input: object) {
  const value = { ...input } as Record<string, unknown>;
  delete value.revision;
  return intakeSha(JSON.stringify(value));
}
export function intakeItem(record: StudioCase, itemId: string) {
  const found = record.sourceIntakes.filter((item) => item.id === itemId);
  if (found.length !== 1) intakeError("INTAKE_NOT_FOUND", 404);
  return found[0];
}
export function intakeReplay(
  record: StudioCase,
  clientRequestId: string,
  digest: string,
): SourceIntakeItem | null {
  const found = record.sourceIntakes.flatMap((item) =>
    item.requests
      .filter((request) => request.clientRequestId === clientRequestId)
      .map((request) => ({ item, request })),
  );
  if (found.length > 1 || (found.length === 1 && found[0].request.inputDigest !== digest))
    intakeError("INTAKE_NONCE_CONFLICT");
  return found[0]?.item ?? null;
}
export function intakeRequest(
  item: SourceIntakeItem,
  action: SourceIntakeItem["requests"][number]["action"],
  clientRequestId: string,
  inputDigest: string,
) {
  if (item.requests.length >= sourceIntakeLimits.requests) intakeError("INTAKE_LIMIT", 413);
  item.requests.push({ action, clientRequestId, inputDigest });
}
export function intakeTouch(item: SourceIntakeItem, expected?: number) {
  if (expected !== undefined && item.version !== expected) intakeError("INTAKE_STALE");
  item.version += 1;
  item.updatedAt = new Date().toISOString();
}
export function intakeResponse(
  company: StudioCase,
  itemId: string | null,
  batchId?: string,
): SourceIntakeResponse {
  const item = itemId ? intakeItem(company, itemId) : null;
  return { company, batchId: item?.batchId ?? batchId!, item };
}
export function intakeRetainedCharacters(items: SourceIntakeItem[]) {
  return items.reduce(
    (sum, item) =>
      sum +
      [...item.previousResults, ...(item.result ? [item.result] : [])].reduce(
        (total, result) =>
          total + (result.content ? sourceIntakeResultText(result.content).length : 0),
        0,
      ),
    0,
  );
}
export function assertIntakeCapacity(record: StudioCase) {
  if (intakeLocationBytes(record.sourceIntakes) > sourceLocationLimits.retainedBytes)
    intakeError("INTAKE_RESULT_LIMIT", 413);
  if (record.sourceIntakes.length > sourceIntakeLimits.items) intakeError("INTAKE_LIMIT", 413);
  if (intakeRetainedCharacters(record.sourceIntakes) > sourceIntakeLimits.retainedText)
    intakeError("INTAKE_RESULT_LIMIT", 413);
  const sourceIds = new Set(record.sources.map((source) => source.id));
  for (const item of record.sourceIntakes)
    if (item.phase !== "cancelled") sourceIds.add(item.sourceId);
  if (sourceIds.size > 40)
    throw new StudioError(
      "등록 자료와 원본 접수 대기는 기업별 합계 40개까지 가능합니다.",
      413,
      "SOURCE_LIMIT",
    );
}
export function intakeLocationBytes(items: SourceIntakeItem[]) {
  return items.reduce(
    (sum, item) =>
      sum +
      [...item.previousResults, ...(item.result ? [item.result] : [])].reduce(
        (total, result) =>
          total + (result.locations ? Buffer.byteLength(JSON.stringify(result.locations)) : 0),
        0,
      ),
    0,
  );
}
/** Only optional coordinates are reduced at their separate capacity; text is never truncated. */
export function retainIntakeLocations(
  items: SourceIntakeItem[],
  text: string,
  value: SourceLocationMetadata | undefined,
): { locations?: SourceLocationMetadata; limited: boolean } {
  if (value === undefined) return { limited: false };
  if (!validateSourceLocationMetadata(text, value)) intakeError("INTAKE_RESULT_INVALID", 422);
  const parsed = sourceLocationMetadataSchema.parse(value),
    remaining = sourceLocationLimits.retainedBytes - intakeLocationBytes(items);
  if (Buffer.byteLength(JSON.stringify(parsed)) <= remaining)
    return { locations: parsed, limited: false };
  const partial: SourceLocationMetadata = { ...parsed, coverage: "partial", segments: [] };
  let size = Buffer.byteLength(JSON.stringify(partial));
  if (size > remaining) return { limited: true };
  for (const segment of parsed.segments) {
    const added = Buffer.byteLength(JSON.stringify(segment)) + (partial.segments.length ? 1 : 0);
    if (size + added > remaining) break;
    partial.segments.push(segment);
    size += added;
  }
  return { locations: partial, limited: true };
}
export function newSourceIntakeBatch(input: CreateSourceIntakeCommand): SourceIntakeItem[] {
  const batchId = randomUUID(),
    now = new Date().toISOString();
  return input.files.map((file, index) => ({
    id: randomUUID(),
    batchId,
    clientFileId: file.clientFileId,
    sourceId: randomUUID(),
    version: 1,
    declared: { originalName: file.originalName, sizeBytes: file.sizeBytes, kind: file.kind },
    original: null,
    phase: "awaiting_original",
    attempts: [],
    result: null,
    previousResults: [],
    adoption: null,
    requests:
      index === 0
        ? [
            {
              clientRequestId: input.clientRequestId,
              inputDigest: intakeDigest(input),
              action: "create",
            },
          ]
        : [],
    createdAt: now,
    updatedAt: now,
    code: null,
  }));
}
export function pendingIntakeSource(item: SourceIntakeItem): SourceDocument {
  if (!item.original) intakeError("INTAKE_ORIGINAL_INVALID");
  return {
    id: item.sourceId,
    name: item.original.originalName,
    kind: item.declared.kind,
    text: "",
    originalName: item.original.originalName,
    mimeType: item.original.mimeType,
    extraction: "pending",
    warnings: [...originalOnlyWarnings],
    createdAt: item.original.sourceUpdatedAt,
    updatedAt: item.original.sourceUpdatedAt,
  };
}
export function assertIntakeOriginal(
  item: SourceIntakeItem,
  original: { source: SourceDocument; buffer: Buffer; sha256: string },
  pending = true,
) {
  if (
    !item.original ||
    original.source.id !== item.sourceId ||
    original.sha256 !== item.original.sha256 ||
    original.buffer.length !== item.original.sizeBytes ||
    original.source.originalName !== item.original.originalName ||
    original.source.mimeType !== item.original.mimeType ||
    original.source.updatedAt !== item.original.sourceUpdatedAt
  )
    intakeError("INTAKE_ORIGINAL_CHANGED");
  if (pending && (original.source.extraction !== "pending" || original.source.text !== ""))
    intakeError("INTAKE_SOURCE_NOT_PENDING");
}
