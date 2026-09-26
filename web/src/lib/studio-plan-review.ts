// Node-only review history. No original file, AI, or official portal access.
import { createHash } from "node:crypto";
import type { StudioCase } from "./studio-schema";
import { StudioError } from "./studio-http";
import { diagnosisInputFingerprint } from "./studio-diagnosis";
import { planConflicts } from "./studio-evidence-history";
import {
  planReviewDecisionInputSchema,
  planReviewDecisionSchema,
  planReviewFindingSchema,
  planReviewLimits,
  type PlanReviewDecision,
  type PlanReviewDecisionInput,
  type PlanReviewStaleReason,
} from "./studio-plan-review-types";

type Company = StudioCase;
type Generated = Pick<PlanReviewDecision, "id" | "clientRequestId" | "inputDigest" | "recordedAt">;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string, status = 409): never {
  throw new StudioError(
    "원고·검토 의견과 최신 처리 이력을 확인해 주세요. 기존 판단 기록은 보존했습니다.",
    status,
    code,
  );
}
export function planReviewInputDigest(input: PlanReviewDecisionInput) {
  return hash(planReviewDecisionInputSchema.parse(input));
}
export function isPlanReviewReplay(records: PlanReviewDecision[], nonce: string, digest: string) {
  const matches = records.filter((entry) => entry.clientRequestId === nonce);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== digest)
    fail("PLAN_REVIEW_REQUEST_CONFLICT");
  return true;
}
export function assertPlanReviewCapacity(records: PlanReviewDecision[]) {
  if (
    records.length > planReviewLimits.records ||
    JSON.stringify(records).length > planReviewLimits.characters
  )
    fail("PLAN_REVIEW_LIMIT", 413);
}
export function refreshPlanReviewStaleness(company: Company, evidenceRevision: number) {
  if (!company.planReviewDecisions.length) return;
  const fingerprint = diagnosisInputFingerprint(company);
  for (const record of company.planReviewDecisions) {
    const reasons: PlanReviewStaleReason[] = [];
    const plans = company.plans.filter((plan) => plan.id === record.planId);
    const plan = plans[0];
    if (plans.length !== 1) reasons.push("plan-missing");
    else {
      if (plan.version !== record.planVersion || hash(plan.content) !== record.planContentSha256)
        reasons.push("plan-changed");
      const finding = planReviewFindingSchema.safeParse(plan.review[record.findingIndex]);
      if (!finding.success || hash(finding.data) !== record.findingSha256)
        reasons.push("finding-changed");
      if (
        plan.sourceRevision !== record.planSourceRevision ||
        plan.sourceRevision < evidenceRevision
      )
        reasons.push("plan-evidence-outdated");
    }
    if (record.evidenceRevision !== evidenceRevision || record.evidenceFingerprint !== fingerprint)
      reasons.push("evidence-changed");
    record.stale = reasons.length > 0;
    record.staleReasons = reasons;
  }
}
export function buildPlanReviewDecision(
  company: Company,
  raw: PlanReviewDecisionInput,
  evidenceRevision: number,
  generated: Generated,
): PlanReviewDecision {
  const input = planReviewDecisionInputSchema.parse(raw);
  if (company.planReviewDecisions.length >= planReviewLimits.records)
    fail("PLAN_REVIEW_LIMIT", 413);
  const plans = company.plans.filter((plan) => plan.id === input.planId);
  if (plans.length !== 1) fail("PLAN_REVIEW_PLAN_NOT_FOUND", 404);
  const plan = plans[0];
  if (plan.version !== input.planVersion) fail("PLAN_REVIEW_PLAN_CHANGED");
  const finding = planReviewFindingSchema.safeParse(plan.review[input.findingIndex]);
  if (!finding.success || JSON.stringify(finding.data) !== JSON.stringify(input.finding))
    fail("PLAN_REVIEW_FINDING_CHANGED");
  const planContentSha256 = hash(plan.content);
  if (
    planConflicts(company, {
      planId: plan.id,
      version: plan.version,
      contentSha256: planContentSha256,
    }) ||
    company.planReviewDecisions.some(
      (entry) =>
        entry.planId === plan.id &&
        (entry.planVersion !== plan.version || entry.planContentSha256 !== planContentSha256),
    )
  )
    fail("PLAN_REVIEW_PLAN_CHANGED");
  const findingSha256 = hash(finding.data);
  const reviewKey = hash([plan.id, planContentSha256, input.findingIndex, findingSha256]);
  const previous = company.planReviewDecisions
    .filter((entry) => entry.reviewKey === reviewKey)
    .at(-1);
  if ((previous?.id ?? null) !== input.previousRecordId) fail("PLAN_REVIEW_VERSION_STALE");
  const record = planReviewDecisionSchema.parse({
    ...input,
    ...generated,
    origin: "manual",
    rootId: previous?.rootId ?? generated.id,
    version: (previous?.version ?? 0) + 1,
    reviewKey,
    planContentSha256,
    findingSha256,
    planSourceRevision: plan.sourceRevision,
    evidenceRevision,
    evidenceFingerprint: diagnosisInputFingerprint(company),
    stale: false,
    staleReasons: [],
  });
  assertPlanReviewCapacity([...company.planReviewDecisions, record]);
  return record;
}
