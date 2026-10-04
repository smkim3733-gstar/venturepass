import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import type { StudioCase } from "./studio-schema";
import {
  guidedPreparationApprovalSchema,
  type GuidedPreparationRun,
  type GuidedPreparationApproval,
  guidedSourceSelectionPreviewSchema,
} from "./studio-guided-preparation-types";

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
export const guidedPreparationDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function guidedPreparationFingerprint(company: StudioCase) {
  // Match the engine's transmitted evidence scope, excluding the business registration number.
  const { businessNumber: _businessNumber, ...profile } = company.profile;
  void _businessNumber;
  return guidedPreparationDigest({
    profile,
    pendingSourceCount: company.sources.filter((source) => source.extraction === "pending").length,
    sources: company.sources
      .filter((source) => source.extraction !== "pending")
      .map(({ id, name, kind, text, warnings }) => ({ id, name, kind, text, warnings })),
  });
}
export function guidedPreparationApproval(company: StudioCase, model: string) {
  const sources = company.sources.filter((source) => source.extraction !== "pending");
  return guidedPreparationApprovalSchema.parse({
    caseId: company.id,
    revision: company.revision,
    provider: "OpenAI",
    model,
    inputFingerprint: guidedPreparationFingerprint(company),
    sourceIds: sources.map((source) => source.id),
    sourceNames: sources.map((source) => source.name),
    profileIncluded: true,
    businessNumberIncluded: false,
    originalFilesIncluded: false,
    derivedDraftIncluded: true,
    purpose: "analysis-plan-review",
    autoRevisionLimit: 1,
  });
}
/** Server-owned order, exact identities, and only the current usable body scope. */
function selectedSources(company: StudioCase, sourceIds: string[]) {
  guidedSourceSelectionPreviewSchema.parse({ revision: company.revision, sourceIds });
  const ids = new Set(sourceIds);
  const sources = company.sources.filter(
    (source) => source.extraction !== "pending" && ids.has(source.id),
  );
  if (sources.length !== ids.size) guidedPreparationError("GUIDED_SOURCE_SELECTION_INVALID");
  return sources;
}
function selectedFingerprint(company: StudioCase, sourceIds: string[]) {
  return guidedPreparationDigest({
    sourceScope: "selected-sources-v1",
    // Conservative invalidation also catches changes to excluded material; it never expands input.
    companyFingerprint: guidedPreparationFingerprint(company),
    sourceIds,
  });
}
export function guidedSelectedPreparationApproval(
  company: StudioCase,
  model: string,
  sourceIds: string[],
) {
  const sources = selectedSources(company, sourceIds);
  const ids = sources.map((source) => source.id);
  return guidedPreparationApprovalSchema.parse({
    ...guidedPreparationApproval(company, model),
    inputFingerprint: selectedFingerprint(company, ids),
    sourceIds: ids,
    sourceNames: sources.map((source) => source.name),
    sourceScope: "selected-sources-v1",
  });
}
export function guidedExpectedPreparationApproval(
  company: StudioCase,
  model: string,
  approval: GuidedPreparationApproval,
) {
  return approval.sourceScope
    ? guidedSelectedPreparationApproval(company, model, approval.sourceIds)
    : guidedPreparationApproval(company, model);
}
/** Detached execution view. Pending originals contribute only the existing unread count. */
export function guidedPreparationInputCompany(
  company: StudioCase,
  approval: GuidedPreparationApproval,
): StudioCase {
  if (!approval.sourceScope) return company;
  const sources = selectedSources(company, approval.sourceIds);
  const ids = sources.map((source) => source.id);
  if (
    approval.caseId !== company.id ||
    approval.inputFingerprint !== selectedFingerprint(company, ids) ||
    JSON.stringify(ids) !== JSON.stringify(approval.sourceIds) ||
    JSON.stringify(sources.map((source) => source.name)) !== JSON.stringify(approval.sourceNames)
  )
    guidedPreparationError("GUIDED_INPUT_CHANGED");
  const selected = new Set(ids);
  return structuredClone({
    ...company,
    sources: company.sources.filter(
      (source) => source.extraction === "pending" || selected.has(source.id),
    ),
  });
}
/** Additional selected-scope backstop; the engine still owns quote/domain validation. */
export function assertGuidedResultSourceIds(
  approval: GuidedPreparationApproval,
  sourceIds: string[],
) {
  if (
    approval.sourceScope &&
    sourceIds.some((id) => id !== "profile" && !approval.sourceIds.includes(id))
  )
    guidedPreparationError("GUIDED_RESULT_SCOPE_CHANGED");
}

export function guidedPreparationError(code: string, status = 409): never {
  throw new StudioError(
    "AI 준비 상태를 확인해 주세요. 저장한 자료와 결과는 보존하며, 확인되지 않은 요청을 다시 전송하지 않습니다.",
    status,
    code,
  );
}
export function assertGuidedPreparationBinding(company: StudioCase, run: GuidedPreparationRun) {
  if ((company.guidedPreparationRuns ?? []).some((item) => item.retryOfId === run.id))
    guidedPreparationError("GUIDED_SUPERSEDED");
  if (
    run.approval.caseId !== company.id ||
    run.approval.inputFingerprint !==
      (run.approval.sourceScope
        ? selectedFingerprint(company, run.approval.sourceIds)
        : guidedPreparationFingerprint(company))
  )
    guidedPreparationError("GUIDED_INPUT_CHANGED");
  if (run.approval.sourceScope) guidedPreparationInputCompany(company, run.approval);
  if (
    run.analysisDigest !== null &&
    run.analysisDigest !== guidedPreparationDigest(company.analysis)
  )
    guidedPreparationError("GUIDED_ANALYSIS_CHANGED");
}
