import type { StudioCase } from "@/lib/studio-schema";
import type { SourceIntakeItem } from "@/lib/studio-source-intake-types";
import {
  sourceIntakeExternalApprovalPreviewSchema,
  sourceIntakeExternalSupports,
  runExternalSourceIntakeSchema,
  type SourceIntakeExternalApprovalPreview,
  type SourceIntakeExternalEngine,
} from "@/lib/studio-source-intake-external-types";

export type IntakeExternalReview = {
  preview: SourceIntakeExternalApprovalPreview;
  clientRequestId: string;
  approved: boolean;
  acknowledgePossibleDuplicate: boolean;
};
export function intakeCanPrepareExternal(item: SourceIntakeItem) {
  return (
    [
      "original_stored",
      "awaiting_method",
      "awaiting_capacity",
      "retryable_failure",
      "result_discarded",
      "external_result_unknown",
    ].includes(item.phase) &&
    !!item.original &&
    !item.adoption &&
    !item.result?.content
  );
}
export function intakeExternalPreviewProblem(
  company: StudioCase,
  preview: SourceIntakeExternalApprovalPreview,
) {
  const { approval } = preview;
  if (company.id !== approval.caseId || company.revision !== preview.companyRevision)
    return "기업 버전이 바뀌었습니다. 새 전송 검토안을 열어 주세요.";
  const items = company.sourceIntakes.filter((item) => item.id === approval.itemId),
    item = items.length === 1 ? items[0] : null;
  const sources = company.sources.filter((source) => source.id === approval.sourceId),
    source = sources.length === 1 ? sources[0] : null;
  if (
    !item ||
    !intakeCanPrepareExternal(item) ||
    item.version !== approval.itemVersion ||
    item.sourceId !== approval.sourceId ||
    !item.original ||
    item.original.sha256 !== approval.originalSha256 ||
    item.original.originalName !== approval.originalName ||
    item.original.mimeType !== approval.mimeType ||
    item.original.sizeBytes !== approval.sizeBytes ||
    item.original.sourceUpdatedAt !== approval.sourceUpdatedAt ||
    item.declared.originalName !== approval.originalName ||
    item.declared.sizeBytes !== approval.sizeBytes ||
    !source ||
    source.updatedAt !== approval.sourceUpdatedAt ||
    source.extraction !== "pending" ||
    source.text !== "" ||
    source.originalName !== approval.originalName ||
    source.mimeType !== approval.mimeType ||
    !sourceIntakeExternalSupports(approval.originalName, approval.engine)
  )
    return "선택한 원본·자료·판독 단계가 바뀌었습니다. 저장 상태를 확인한 뒤 새 전송 검토안을 열어 주세요.";
  const requiresDuplicate = item.attempts.some(
    (attempt) => attempt.externalRequestStarted && attempt.status !== "completed",
  );
  if (requiresDuplicate !== preview.requiresDuplicateAcknowledgement)
    return "이전 외부 요청 상태가 바뀌었습니다. 중복 처리 가능성을 새 검토안에서 확인해 주세요.";
  return "";
}
export function validateIntakeExternalPreview(
  raw: unknown,
  company: StudioCase,
  item: SourceIntakeItem,
  engine: SourceIntakeExternalEngine,
) {
  const parsed = sourceIntakeExternalApprovalPreviewSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.approval.itemId !== item.id ||
    parsed.data.approval.itemVersion !== item.version ||
    parsed.data.approval.engine !== engine ||
    intakeExternalPreviewProblem(company, parsed.data)
  )
    return null;
  return parsed.data;
}
export function intakeExternalCommand(company: StudioCase, review: IntakeExternalReview) {
  if (
    !review.approved ||
    (review.preview.requiresDuplicateAcknowledgement && !review.acknowledgePossibleDuplicate) ||
    intakeExternalPreviewProblem(company, review.preview)
  )
    return null;
  const parsed = runExternalSourceIntakeSchema.safeParse({
    action: "run-external",
    revision: review.preview.companyRevision,
    clientRequestId: review.clientRequestId,
    itemId: review.preview.approval.itemId,
    expectedItemVersion: review.preview.approval.itemVersion,
    approval: review.preview.approval,
    approved: true,
    acknowledgePossibleDuplicate: review.acknowledgePossibleDuplicate,
  });
  return parsed.success ? parsed.data : null;
}
