import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import type { StudioCase } from "./studio-schema";
import {
  guidedPreparationApprovalSchema,
  type GuidedPreparationRun,
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
    run.approval.inputFingerprint !== guidedPreparationFingerprint(company)
  )
    guidedPreparationError("GUIDED_INPUT_CHANGED");
  if (
    run.analysisDigest !== null &&
    run.analysisDigest !== guidedPreparationDigest(company.analysis)
  )
    guidedPreparationError("GUIDED_ANALYSIS_CHANGED");
}
