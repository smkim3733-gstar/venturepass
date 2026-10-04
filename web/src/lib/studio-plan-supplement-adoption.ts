// Keyless local adoption identity. No model, SDK, clock or caller-supplied manuscript.
import type { BusinessPlan, StudioCase } from "./studio-schema";
import { StudioError } from "./studio-http";
import {
  auditPlanSupplementExecutions,
  supplementDigest,
} from "./studio-plan-supplement-execution-state";
import { planSupplementResult, readPlanSupplementResponse } from "./studio-plan-supplement-result";
import {
  planSupplementAdoptionCommandSchema,
  planSupplementAdoptionInspectionSchema,
  planSupplementAdoptionReceiptSchema,
  planSupplementAdoptionSelectionSchema,
  type PlanSupplementAdoptionCommand,
} from "./studio-plan-supplement-adoption-types";
export function supplementAdoptionError(code: string): never {
  throw new StudioError(
    "수정안과 원고의 저장 상태를 확인해 주세요. 기존 원고는 변경하지 않았습니다.",
    409,
    code,
  );
}
// Review findings and confirmation may legitimately change later. Manuscript identity may not.
export function supplementPlanIdentity(plan: BusinessPlan) {
  const { review, confirmedAt, ...identity } = plan;
  void review;
  void confirmedAt;
  return supplementDigest(identity);
}
export function auditPlanSupplementAdoptions(company: StudioCase) {
  auditPlanSupplementExecutions(company);
  const ids = new Set<string>(),
    nonces = new Set<string>(),
    executions = new Set<string>(),
    plans = new Set<string>();
  let previousRevision = -1;
  for (const raw of company.planSupplementAdoptions ?? []) {
    const parsed = planSupplementAdoptionReceiptSchema.safeParse(raw);
    if (!parsed.success) supplementAdoptionError("SUPPLEMENT_ADOPTION_HISTORY_INVALID");
    const receipt = parsed.data,
      command = receipt.command;
    const run = company.planSupplementExecutions?.find((item) => item.id === command.executionId);
    const plan = company.plans.find((item) => item.id === receipt.planId);
    const target = run?.command.input.target;
    const base =
      target?.kind === "visit-question"
        ? company.plans.find((item) => item.id === target.planId)
        : undefined;
    if (
      !run ||
      run.capture?.kind !== "response" ||
      !plan ||
      !base ||
      ids.has(receipt.id) ||
      nonces.has(command.clientRequestId) ||
      executions.has(run.id) ||
      plans.has(plan.id) ||
      command.caseId !== company.id ||
      receipt.commandSha256 !== supplementDigest(command) ||
      command.executionCommandSha256 !== run.commandSha256 ||
      command.captureSha256 !== run.captureSha256 ||
      command.revision !== run.finishedRevision ||
      run.finishedRevision !== run.reservationRevision + 1 ||
      previousRevision >= receipt.savedRevision ||
      receipt.savedRevision > company.revision ||
      plan.version !== receipt.planVersion ||
      plan.version !== base.version + 1 ||
      plan.mode !== "manual" ||
      plan.generatedAt !== receipt.recordedAt ||
      plan.candidateId !== base.candidateId ||
      plan.sourceRevision !== base.sourceRevision ||
      supplementPlanIdentity(plan) !== receipt.planIdentitySha256 ||
      supplementPlanIdentity(base) !== receipt.basePlanIdentitySha256 ||
      company.planSupplementExecutions?.some(
        (item) => item.command.clientRequestId === command.clientRequestId,
      )
    )
      supplementAdoptionError("SUPPLEMENT_ADOPTION_HISTORY_INVALID");
    try {
      const { draft } = readPlanSupplementResponse(run.capture.rawJson);
      const target = plan.content.sections.find(
        (item) => item.key === run.command.input.sectionKey,
      )!;
      const originalTarget = base.content.sections.find(
        (item) => item.key === run.command.input.sectionKey,
      )!;
      const outside = structuredClone(plan.content);
      outside.sections[outside.sections.findIndex((item) => item.key === target.key)] =
        structuredClone(originalTarget);
      if (
        !target.needsConfirmation ||
        target.content !== draft.content ||
        supplementDigest(outside) !== supplementDigest(base.content) ||
        supplementDigest(target.evidence.slice(0, originalTarget.evidence.length)) !==
          supplementDigest(originalTarget.evidence) ||
        command.proposalSha256 !==
          supplementDigest({ binding: run.command.approval.binding, draft, content: plan.content })
      )
        throw Error();
    } catch {
      supplementAdoptionError("SUPPLEMENT_ADOPTION_HISTORY_INVALID");
    }
    ids.add(receipt.id);
    nonces.add(command.clientRequestId);
    executions.add(run.id);
    plans.add(plan.id);
    previousRevision = receipt.savedRevision;
  }
}
export function replayPlanSupplementAdoption(
  company: StudioCase,
  raw: PlanSupplementAdoptionCommand,
) {
  const command = planSupplementAdoptionCommandSchema.parse(raw);
  auditPlanSupplementAdoptions(company);
  if (command.caseId !== company.id) supplementAdoptionError("SUPPLEMENT_ADOPTION_COMPANY");
  const receipt = company.planSupplementAdoptions?.find(
    (item) => item.command.clientRequestId === command.clientRequestId,
  );
  if (receipt && receipt.commandSha256 !== supplementDigest(command))
    supplementAdoptionError("SUPPLEMENT_ADOPTION_REQUEST_CONFLICT");
  return receipt ? structuredClone(receipt) : null;
}
export function preparePlanSupplementAdoption(
  company: StudioCase,
  revision: number,
  executionId: string,
) {
  auditPlanSupplementAdoptions(company);
  if (company.revision !== revision) supplementAdoptionError("SUPPLEMENT_ADOPTION_REVISION");
  if (company.planSupplementAdoptions?.some((item) => item.command.executionId === executionId))
    supplementAdoptionError("SUPPLEMENT_ALREADY_ADOPTED");
  if ((company.planSupplementAdoptions?.length ?? 0) >= 30 || company.plans.length >= 100)
    supplementAdoptionError("SUPPLEMENT_ADOPTION_LIMIT");
  const run = company.planSupplementExecutions?.find((item) => item.id === executionId);
  if (!run) supplementAdoptionError("SUPPLEMENT_EXECUTION_NOT_FOUND");
  const result = planSupplementResult(company, run);
  if (!result.proposal) supplementAdoptionError("SUPPLEMENT_COMPARISON_UNAVAILABLE");
  const selection = planSupplementAdoptionSelectionSchema.parse({
    caseId: company.id,
    revision,
    executionId,
    executionCommandSha256: run.commandSha256,
    captureSha256: run.captureSha256,
    proposalSha256: result.proposal.proposalSha256,
    comparisonSha256: supplementDigest(result.proposal),
  });
  return {
    selection,
    proposal: result.proposal,
    databaseChanged: false as const,
    transmissionAllowed: false as const,
  };
}
export function assertPlanSupplementAdoption(
  company: StudioCase,
  raw: PlanSupplementAdoptionCommand,
) {
  const command = planSupplementAdoptionCommandSchema.parse(raw);
  const prepared = preparePlanSupplementAdoption(company, command.revision, command.executionId);
  const { action, clientRequestId, confirmed, ...selection } = command;
  void action;
  void confirmed;
  if (supplementDigest(selection) !== supplementDigest(prepared.selection))
    supplementAdoptionError("SUPPLEMENT_ADOPTION_CHANGED");
  if (
    company.planSupplementExecutions?.some(
      (item) => item.command.clientRequestId === clientRequestId,
    )
  )
    supplementAdoptionError("SUPPLEMENT_ADOPTION_NONCE_USED");
  return prepared.proposal;
}

/** Read one authoritative company row. A missing receipt alone never establishes safe closure. */
export function inspectPlanSupplementAdoption(
  company: StudioCase,
  raw: PlanSupplementAdoptionCommand,
) {
  const command = planSupplementAdoptionCommandSchema.parse(raw);
  // Complete history audit and original nonce lookup precede any current revision inference.
  const receipt = replayPlanSupplementAdoption(company, command);
  const run = company.planSupplementExecutions?.find((item) => item.id === command.executionId);
  const target = run?.command.input.target;
  const base =
    target?.kind === "visit-question"
      ? company.plans.find((item) => item.id === target.planId)
      : undefined;
  const originalContext =
    !!run &&
    run.capture?.kind === "response" &&
    command.executionCommandSha256 === run.commandSha256 &&
    command.captureSha256 === run.captureSha256 &&
    command.revision === run.finishedRevision &&
    run.finishedRevision === run.reservationRevision + 1 &&
    target?.kind === "visit-question" &&
    !!base &&
    base.version === target.planVersion &&
    supplementDigest(base.content) === run.command.input.baseContentSha256 &&
    !company.planSupplementExecutions?.some(
      (item) => item.command.clientRequestId === command.clientRequestId,
    );
  // A matching saved manuscript without its audited receipt may mean the receipt was lost.
  // Keep that case uncertain, including a coincidentally identical manual version.
  let unattributedPlan = false;
  if (!receipt && originalContext && run?.capture?.kind === "response" && base) {
    try {
      const { draft } = readPlanSupplementResponse(run.capture.rawJson);
      unattributedPlan = company.plans.some(
        (plan) =>
          plan.version === base.version + 1 &&
          supplementDigest({
            binding: run.command.approval.binding,
            draft,
            content: plan.content,
          }) === command.proposalSha256 &&
          !company.planSupplementAdoptions?.some((item) => item.planId === plan.id),
      );
    } catch {
      unattributedPlan = true;
    }
  }
  // With the original capture retained and a strictly advanced CAS revision, this exact
  // command cannot create a plan later. An already committed command must have its receipt.
  // This does not prove that another nonce was not adopted, or repair a lost/restored database.
  const state = receipt
    ? "adopted"
    : originalContext && !unattributedPlan && company.revision > command.revision
      ? "not-adopted-stale"
      : "unconfirmed";
  return planSupplementAdoptionInspectionSchema.parse({
    format: "supplement-adoption-inspection-v1",
    caseId: company.id,
    revision: company.revision,
    command,
    commandSha256: supplementDigest(command),
    state,
    receipt,
    canClose: state === "not-adopted-stale",
    databaseChanged: false,
    transmissionAllowed: false,
  });
}
