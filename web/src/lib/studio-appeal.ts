// Server-only operations. Browser components use studio-appeal-types instead.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import { isAgencyNoticeRecord, type AgencyEvidenceSnapshot } from "./studio-agency-records";
import { originalConflicts, planConflicts } from "./studio-evidence-history";
import type { SourceDocument, StudioCase } from "./studio-schema";
import {
  appealPreparationSchema,
  MAX_APPEAL_ORIGINAL_BYTES,
  MAX_APPEAL_SOURCES,
  MAX_APPEAL_TEXT,
  MAX_APPEAL_VERSIONS,
  type AppealPreparation,
  type AppealPreparationInput,
} from "./studio-appeal-types";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const appealInputDigest = (input: AppealPreparationInput) => digest(JSON.stringify(input));
function fail(message: string, code: string, status = 409): never {
  throw new StudioError(message, status, code);
}
export function assertAppealCapacity(records: AppealPreparation[]) {
  const countStrings = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce((total, item) => total + countStrings(item), 0);
    if (value && typeof value === "object")
      return Object.values(value).reduce<number>((total, item) => total + countStrings(item), 0);
    return 0;
  };
  if (records.length > MAX_APPEAL_VERSIONS || countStrings(records) > MAX_APPEAL_TEXT)
    fail(
      "소명 준비 이력의 보관 한도에 도달했습니다. 기존 이력을 보존하며 새 버전은 저장하지 않았습니다.",
      "APPEAL_LIMIT",
    );
}
export function isAppealReplay(
  records: AppealPreparation[],
  clientRequestId: string,
  inputDigest: string,
) {
  const matches = records.filter((record) => record.clientRequestId === clientRequestId);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== inputDigest)
    fail(
      "같은 저장 요청에 다른 소명 내용이 포함되어 있습니다. 최신 내용을 확인하고 새 요청으로 준비해 주세요.",
      "APPEAL_REQUEST_CONFLICT",
    );
  return true;
}
type OriginalReader = (sourceId: string) => {
  source: SourceDocument;
  buffer: Buffer;
  sha256: string;
};
type Generated = Pick<AppealPreparation, "id" | "clientRequestId" | "inputDigest" | "recordedAt">;

/** Create one immutable, local manual preparation. No AI, official actions, or stage changes. */
export function buildAppealPreparation(
  company: StudioCase,
  input: AppealPreparationInput,
  generated: Generated,
  readOriginal: OriginalReader,
): AppealPreparation {
  if (company.appealPreparations.length >= MAX_APPEAL_VERSIONS)
    fail("소명 준비 이력의 보관 한도에 도달했습니다.", "APPEAL_LIMIT");
  const notices = company.agencyRecords.filter(isAgencyNoticeRecord);
  const noticeRoot = notices.find(
    (notice) => notice.id === input.noticeRecordId && notice.kind === "notice",
  );
  if (!noticeRoot) fail("이 기업의 결과 통보를 찾을 수 없습니다.", "APPEAL_NOTICE_NOT_FOUND", 404);
  const notice = notices.filter((entry) => entry.noticeRecordId === noticeRoot.id).at(-1)!;
  if (notice.id !== input.noticeVersionId || notice.details.category !== "decision")
    fail("최신 결과 통보를 확인하고 소명 준비를 다시 열어 주세요.", "APPEAL_NOTICE_STALE");
  let previous: AppealPreparation | undefined;
  if (input.preparationId) {
    const first = company.appealPreparations.find(
      (record) => record.id === input.preparationId && record.previousVersionId === null,
    );
    if (!first) fail("이 기업의 소명 준비 건을 찾을 수 없습니다.", "APPEAL_NOT_FOUND", 404);
    if (first.noticeRecordId !== input.noticeRecordId)
      fail("다른 결과 통보로 소명 준비 건을 옮길 수 없습니다.", "APPEAL_ROOT_MISMATCH");
    previous = company.appealPreparations
      .filter((record) => record.preparationId === first.id)
      .at(-1)!;
    if (previous.id !== input.previousVersionId)
      fail("소명 준비의 최신 버전이 변경되었습니다. 다시 불러와 주세요.", "APPEAL_VERSION_STALE");
  } else if (
    company.appealPreparations.some((record) => record.noticeRecordId === input.noticeRecordId)
  ) {
    fail(
      "이 통보에 연결한 소명 준비 건이 있습니다. 최신 버전에서 이어서 작성해 주세요.",
      "APPEAL_ALREADY_EXISTS",
    );
  }
  const references = input.reasons.flatMap((reason) => [
    ...reason.evidence,
    ...reason.additionalEvidence,
  ]);
  const sourceIds = [...new Set(references.map((reference) => reference.sourceId))];
  if (sourceIds.length > MAX_APPEAL_SOURCES)
    fail(
      "한 소명 준비 버전에는 서로 다른 자료 10개까지 연결할 수 있습니다.",
      "APPEAL_SOURCE_LIMIT",
      413,
    );
  // Validate membership and every text quote before opening even one original file.
  for (const reference of references) {
    const matches = company.sources.filter((source) => source.id === reference.sourceId);
    if (matches.length !== 1)
      fail("이 기업의 자료를 선택해 주세요.", "APPEAL_SOURCE_NOT_FOUND", 404);
    const source = matches[0];
    if (
      source.updatedAt !== reference.sourceUpdatedAt ||
      (reference.quote === ""
        ? !source.originalName
        : !reference.quote.trim() ||
          source.extraction === "pending" ||
          !source.text.includes(reference.quote))
    )
      fail(
        "자료의 현재 본문과 인용을 확인해 주세요. 미추출 원본은 인용 없이 연결할 수 있습니다.",
        "APPEAL_SOURCE_STALE",
      );
  }
  const planSnapshots: AppealPreparation["planSnapshots"] = [];
  for (const reason of input.reasons) {
    const noticeText = reason.noticeField === "body" ? notice.body : notice.details.reasons;
    if (!noticeText.includes(reason.noticeQuote))
      fail(
        "사유는 연결한 결과 통보의 원문에서 정확히 인용해 주세요.",
        "APPEAL_REASON_INVALID",
        422,
      );
    if (!reason.planClaim) continue;
    const claim = reason.planClaim;
    const matches = company.plans.filter((plan) => plan.id === claim.planId);
    if (matches.length !== 1)
      fail("이 기업의 기존 계획서 버전을 선택해 주세요.", "APPEAL_PLAN_NOT_FOUND", 404);
    const plan = matches[0];
    const sections = plan.content.sections.filter((section) => section.key === claim.sectionKey);
    if (sections.length !== 1 || !sections[0].content.includes(claim.quote))
      fail(
        "기존 주장은 선택한 계획서 항목의 원문에서 정확히 인용해 주세요.",
        "APPEAL_CLAIM_INVALID",
        422,
      );
    if (!planSnapshots.some((snapshot) => snapshot.planId === plan.id)) {
      const snapshot = {
        planId: plan.id,
        version: plan.version,
        contentSha256: digest(JSON.stringify(plan.content)),
      };
      if (planConflicts(company, snapshot))
        fail(
          "이미 연결한 계획서 버전이 변경되었습니다. 기존 이력을 보존하고 별도 새 계획서 버전을 사용해 주세요.",
          "APPEAL_PLAN_CHANGED",
        );
      planSnapshots.push(snapshot);
    }
  }
  const sourceSnapshots: AppealPreparation["sourceSnapshots"] = [];
  let totalBytes = 0;
  for (const sourceId of sourceIds) {
    const source = company.sources.find((entry) => entry.id === sourceId)!;
    let original: AgencyEvidenceSnapshot | null = null;
    if (source.originalName) {
      const current = readOriginal(sourceId);
      if (JSON.stringify(current.source) !== JSON.stringify(source))
        fail("자료가 변경되었습니다. 다시 불러와 주세요.", "APPEAL_SOURCE_STALE");
      totalBytes += current.buffer.length;
      if (current.buffer.length > 12 * 1024 * 1024 || totalBytes > MAX_APPEAL_ORIGINAL_BYTES)
        fail("원본은 파일별 12MiB, 합계 24MiB 이내로 연결해 주세요.", "APPEAL_ORIGINAL_LIMIT", 413);
      original = {
        sourceId,
        sourceName: source.name,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: current.buffer.length,
        sha256: current.sha256,
        capturedAt: generated.recordedAt,
        sourceUpdatedAt: source.updatedAt,
      };
      if (originalConflicts(company, original))
        fail(
          "이미 연결한 원본이 변경되었습니다. 기존 이력을 보존하고 새 원본을 별도 등록해 주세요.",
          "APPEAL_ORIGINAL_CHANGED",
        );
    }
    sourceSnapshots.push({
      sourceId,
      sourceName: source.name,
      sourceUpdatedAt: source.updatedAt,
      extraction: source.extraction,
      textSha256: digest(source.text),
      original,
    });
  }
  const record = appealPreparationSchema.parse({
    ...generated,
    ...input,
    preparationId: input.preparationId ?? generated.id,
    previousVersionId: previous?.id ?? null,
    version: (previous?.version ?? 0) + 1,
    origin: "manual",
    review: {
      reviewedAt: input.review.reviewed ? generated.recordedAt : null,
      reviewer: input.review.reviewer,
      note: input.review.note,
    },
    sourceSnapshots,
    planSnapshots,
  });
  assertAppealCapacity([...company.appealPreparations, record]);
  // Re-read all originals at the final synchronous save boundary, preserving their full hash.
  for (const snapshot of sourceSnapshots) {
    if (!snapshot.original) continue;
    const current = readOriginal(snapshot.sourceId);
    const source = company.sources.find((entry) => entry.id === snapshot.sourceId)!;
    if (
      JSON.stringify(current.source) !== JSON.stringify(source) ||
      current.sha256 !== snapshot.original.sha256 ||
      current.buffer.length !== snapshot.original.sizeBytes
    )
      fail(
        "저장 중 원본이 변경되었습니다. 이 버전은 저장하지 않았습니다.",
        "APPEAL_ORIGINAL_CHANGED",
      );
  }
  return record;
}
