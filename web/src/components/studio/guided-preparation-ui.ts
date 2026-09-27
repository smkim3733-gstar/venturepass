import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  guidedPreparationApprovalSchema,
  guidedPreparationRunSchema,
  type GuidedPreparationRequest,
} from "@/lib/studio-guided-preparation-types";

/** Read responses are bound to the open company and cannot roll its revision back. */
export function guidedPreparationSnapshot(
  value: unknown,
  binding: Pick<StudioCase, "id" | "revision">,
) {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const company = caseSchema.safeParse(raw.company);
  const approval = guidedPreparationApprovalSchema.safeParse(raw.approval);
  if (
    !company.success ||
    company.data.id !== binding.id ||
    company.data.revision < binding.revision ||
    !approval.success ||
    approval.data.caseId !== binding.id ||
    approval.data.revision !== company.data.revision ||
    typeof raw.active !== "boolean" ||
    typeof raw.aiConfigured !== "boolean"
  )
    return null;
  return {
    company: company.data,
    approval: approval.data,
    active: raw.active,
    aiConfigured: raw.aiConfigured,
  };
}

/** A POST acknowledgment must include the exact durable request, never only a success label. */
export function guidedPreparationResponse(
  value: unknown,
  binding: Pick<StudioCase, "id" | "revision">,
  request: GuidedPreparationRequest,
) {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const company = caseSchema.safeParse(raw.company);
  const run = guidedPreparationRunSchema.safeParse(raw.run);
  const expectedApproval =
    request.action !== "continue"
      ? guidedPreparationApprovalSchema.safeParse(request.approval)
      : null;
  if (
    !company.success ||
    company.data.id !== binding.id ||
    company.data.revision < binding.revision ||
    !run.success ||
    run.data.approval.caseId !== binding.id ||
    !run.data.requests.some((item) => item.clientRequestId === request.clientRequestId) ||
    (request.action === "continue" && run.data.id !== request.runId) ||
    (request.action === "restart" && run.data.retryOfId !== request.previousRunId) ||
    (expectedApproval &&
      (!expectedApproval.success ||
        JSON.stringify(run.data.approval) !== JSON.stringify(expectedApproval.data))) ||
    (company.data.guidedPreparationRuns ?? []).filter((saved) => saved.id === run.data.id)
      .length !== 1 ||
    (company.data.guidedPreparationRuns ?? [])
      .flatMap((saved) => saved.requests)
      .filter((saved) => saved.clientRequestId === request.clientRequestId).length !== 1 ||
    !(company.data.guidedPreparationRuns ?? []).some(
      (saved) => saved.id === run.data.id && JSON.stringify(saved) === JSON.stringify(run.data),
    )
  )
    return null;
  return { company: company.data, run: run.data };
}

export function guidedRequestRejected(status: number, value: unknown) {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (raw.accepted === true) return false;
  return raw.accepted === false || [400, 403, 413, 415, 422].includes(status);
}
