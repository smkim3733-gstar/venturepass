import { z } from "zod";
import type { StudioCase } from "@/lib/studio-schema";
import {
  preparedPackageListSchema,
  preparedPackageRecordSchema,
  preparedPackageRequestSchema,
  type PreparedPackageRequest,
  type PreparedPackageSummary,
} from "@/lib/studio-prepared-package-types";

export function preparedPackageDefiniteRejection(status: number, code?: string) {
  if ([400, 403, 404, 413, 415, 422].includes(status)) return true;
  return (
    status === 409 &&
    !!code &&
    [
      "STALE_REVISION",
      "PREPARED_REQUEST_CONFLICT",
      "PREPARED_SNAPSHOT_CHANGED",
      "PREPARED_SOURCE_CHANGED",
      "PREPARED_ORIGINAL_CHANGED",
      "PACKAGE_ORIGINAL_CHANGED",
      "PACKAGE_ORIGINAL_UNAVAILABLE",
      "PACKAGE_SNAPSHOT_CHANGED",
      "PLAN_NOT_FOUND",
      "SOURCE_NOT_FOUND",
      "ORIGINAL_UNAVAILABLE",
      "ORIGINAL_CHANGED",
      "ORIGINAL_METADATA_CHANGED",
      "UNSAFE_ORIGINAL_PATH",
      "INTAKE_ORIGINAL_CHANGED",
      "SUGGESTION_ORIGINAL_CHANGED",
      "PROCEDURE_ORIGINAL_CHANGED",
    ].includes(code)
  );
}

export function preparedPackageList(value: unknown, company: Pick<StudioCase, "id" | "revision">) {
  const result = preparedPackageListSchema.parse(value);
  if (
    result.caseId !== company.id ||
    result.caseRevision < company.revision ||
    result.packages.some(
      (item) => item.caseId !== company.id || item.caseRevision > result.caseRevision,
    ) ||
    new Set(result.packages.map((item) => item.id)).size !== result.packages.length ||
    new Set(result.packages.map((item) => item.version)).size !== result.packages.length ||
    new Set(result.packages.map((item) => item.clientRequestId)).size !== result.packages.length
  )
    throw new Error("현재 기업의 준비본 목록을 확인하지 못했습니다.");
  return result;
}

export function preparedPackageReceipt(
  value: unknown,
  company: StudioCase,
  request: PreparedPackageRequest,
) {
  const { package: record } = z.object({ package: preparedPackageRecordSchema }).parse(value);
  const plan = company.plans.find((item) => item.id === request.planId);
  if (
    !plan ||
    record.caseId !== company.id ||
    record.caseRevision !== request.revision ||
    record.clientRequestId !== request.clientRequestId ||
    JSON.stringify(record.input) !== JSON.stringify(preparedPackageRequestSchema.parse(request)) ||
    JSON.stringify(record.company.profile) !== JSON.stringify(company.profile) ||
    record.plan.id !== request.planId ||
    record.plan.version !== plan.version ||
    JSON.stringify(record.plan.content) !== JSON.stringify(plan.content) ||
    JSON.stringify(record.plan.review) !== JSON.stringify(plan.review) ||
    record.plan.confirmedAt !== plan.confirmedAt ||
    JSON.stringify(record.review.storedFindings) !== JSON.stringify(plan.review) ||
    record.review.confirmedAt !== plan.confirmedAt ||
    JSON.stringify(record.review.unconfirmedSectionKeys) !==
      JSON.stringify(
        plan.content.sections
          .filter((section) => section.needsConfirmation)
          .map((section) => section.key),
      ) ||
    JSON.stringify(record.sourceIds) !== JSON.stringify(request.sourceIds) ||
    record.sources.length !== request.sourceIds.length ||
    record.sources.some((item, index) => {
      const source = company.sources.find((entry) => entry.id === request.sourceIds[index]);
      return (
        !source ||
        item.source.id !== source.id ||
        item.source.updatedAt !== source.updatedAt ||
        item.source.originalName !== source.originalName
      );
    })
  )
    throw new Error(
      "보관 결과가 선택한 원고·첨부와 일치하지 않습니다. 저장 상태를 다시 확인해 주세요.",
    );
  return record;
}

export function preparedPackageCurrent(item: PreparedPackageSummary, company: StudioCase) {
  return (
    item.caseId === company.id &&
    item.caseRevision === company.revision &&
    company.plans.some((plan) => plan.id === item.planId && plan.version === item.planVersion)
  );
}
