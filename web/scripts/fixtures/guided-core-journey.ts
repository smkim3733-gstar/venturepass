// Synthetic, in-memory business responses for one continuous actual-app journey.
// Pure production validators are reused; no StudioStore, service, SDK or database is activated.
import { caseSchema, sectionDefinitions, type StudioCase } from "../../src/lib/studio-schema";
import { answerWorkflowCompany, answerQuestion } from "./guided-answer-workflow";
import {
  preparePlanSupplement,
  type PlanSupplementInput,
} from "../../src/lib/studio-plan-supplement";
import {
  buildPlanSupplementExecutionApproval,
  auditPlanSupplementExecutions,
  supplementDigest,
} from "../../src/lib/studio-plan-supplement-execution-state";
import {
  planSupplementExecutionCommandSchema,
  type PlanSupplementExecutionCommand,
} from "../../src/lib/studio-plan-supplement-execution-types";
import { planSupplementResult } from "../../src/lib/studio-plan-supplement-result";
import {
  preparePlanSupplementAdoption,
  assertPlanSupplementAdoption,
  auditPlanSupplementAdoptions,
  supplementPlanIdentity,
} from "../../src/lib/studio-plan-supplement-adoption";
import type { PlanSupplementAdoptionCommand } from "../../src/lib/studio-plan-supplement-adoption-types";
import {
  buildPlanReviewDecision,
  planReviewInputDigest,
  refreshPlanReviewStaleness,
} from "../../src/lib/studio-plan-review";
import type { PlanReviewDecisionInput } from "../../src/lib/studio-plan-review-types";
import { exportPlanDocx, PLAN_DOCX_MIME } from "../../src/lib/studio-export-docx";
import JSZip from "jszip";
export { answerQuestion, exportPlanDocx, PLAN_DOCX_MIME, preparePlanSupplementAdoption };
export const answer = "외부 시험은 아직 계획 단계입니다.";
export const revisedText =
  "내부 시험을 진행했습니다. 외부 시험은 아직 계획 단계입니다. 시험 결과와 성능은 추가 확인이 필요합니다.";
export function journeyCompany() {
  const company = answerWorkflowCompany();
  const sections = company.plans[0].content.sections;
  company.profile.companyName = "합성 연속 작성 기업";
  company.plans[0].content.sections = sectionDefinitions.map(
    (definition) =>
      sections.find((s) => s.key === definition.key) ?? {
        key: definition.key,
        title: definition.title,
        content: "이 항목의 기존 합성 원문을 보존합니다.",
        evidence: [],
        needsConfirmation: false,
      },
  );
  return caseSchema.parse(company);
}
export function preview(company: StudioCase, input: PlanSupplementInput) {
  return {
    ...preparePlanSupplement(company, input),
    approval: buildPlanSupplementExecutionApproval(company, input, "synthetic-disabled"),
    aiConfigured: true,
  }; // Only a mock UI response; no key lookup or provider exists.
}
export function status(company: StudioCase) {
  auditPlanSupplementExecutions(company);
  return {
    company,
    active: false,
    retainedCapture: false,
    executions: (company.planSupplementExecutions ?? []).map((record) => ({
      record,
      ...planSupplementResult(company, record),
    })),
    transmissionAllowed: false,
  };
}
export function completeProposal(company: StudioCase, raw: PlanSupplementExecutionCommand) {
  const command = planSupplementExecutionCommandSchema.parse(raw);
  if (
    supplementDigest(preview(company, command.input).approval) !==
    supplementDigest(command.approval)
  )
    throw Error("Synthetic approval mismatch");
  const source = company.sources.find((s) => s.id === command.input.sourceSelections[0].sourceId)!;
  const start = source.text.indexOf(answer);
  if (start < 0) throw Error("Synthetic answer not selected");
  const draft = {
    content: revisedText,
    addedEvidence: [{ sourceId: source.id, start, end: start + answer.length, quote: answer }],
  };
  const capture = {
    kind: "response" as const,
    rawJson: JSON.stringify({
      id: "resp_synthetic_journey",
      model: "synthetic-disabled",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(draft) }],
        },
      ],
    }),
  };
  const updated = caseSchema.parse({
    ...company,
    revision: company.revision + 2,
    planSupplementExecutions: [
      ...(company.planSupplementExecutions ?? []),
      {
        id: "d0000000-0000-4000-8000-000000000001",
        command,
        commandSha256: supplementDigest(command),
        reservationRevision: company.revision + 1,
        createdAt: "2026-10-09T02:00:00.000Z",
        capture,
        captureSha256: supplementDigest(capture),
        finishedRevision: company.revision + 2,
        finishedAt: "2026-10-09T02:00:01.000Z",
      },
    ],
  });
  if (status(updated).executions[0].state !== "comparison-ready")
    throw Error("Synthetic proposal must pass existing comparison");
  return updated;
}
export function adopt(company: StudioCase, command: PlanSupplementAdoptionCommand) {
  const proposal = assertPlanSupplementAdoption(company, command);
  const base = company.plans.find((p) => p.id === proposal.basePlanId)!;
  const plan = {
    ...structuredClone(base),
    id: "a0000000-0000-4000-8000-000000000002",
    version: base.version + 1,
    mode: "manual" as const,
    generatedAt: "2026-10-09T02:01:00.000Z",
    content: structuredClone(proposal.content),
    confirmedAt: null,
    // Explicit synthetic finding, not a new invocation of the production review engine.
    review: [
      {
        id: "synthetic-review-0",
        severity: "warning" as const,
        category: "evidence" as const,
        sourceIds: [],
        sectionKey: "development" as const,
        message: "외부 시험 근거 확인 필요",
        action: "시험 근거를 확인하고 담당자 판단을 남기세요.",
      },
    ],
  };
  const updated = caseSchema.parse({
    ...company,
    revision: company.revision + 1,
    plans: [...company.plans, plan],
    planSupplementAdoptions: [
      ...(company.planSupplementAdoptions ?? []),
      {
        id: "e0000000-0000-4000-8000-000000000001",
        command,
        commandSha256: supplementDigest(command),
        savedRevision: company.revision + 1,
        planId: plan.id,
        planVersion: plan.version,
        planIdentitySha256: supplementPlanIdentity(plan),
        basePlanIdentitySha256: supplementPlanIdentity(base),
        recordedAt: plan.generatedAt,
      },
    ],
  });
  auditPlanSupplementAdoptions(updated);
  return updated;
}
export function adoptionAudit(company: StudioCase) {
  auditPlanSupplementAdoptions(company);
  return {
    caseId: company.id,
    revision: company.revision,
    receipts: company.planSupplementAdoptions ?? [],
    databaseChanged: false,
    transmissionAllowed: false,
  };
}
export function decision(
  company: StudioCase,
  command: { clientRequestId: string; decision: PlanReviewDecisionInput },
) {
  const evidenceRevision = 5; // The answer-save step is the last evidence mutation in this scenario.
  const record = buildPlanReviewDecision(company, command.decision, evidenceRevision, {
    id: "f0000000-0000-4000-8000-000000000001",
    clientRequestId: command.clientRequestId,
    inputDigest: planReviewInputDigest(command.decision),
    recordedAt: "2026-10-09T02:02:00.000Z",
  });
  const updated = caseSchema.parse({
    ...company,
    revision: company.revision + 1,
    planReviewDecisions: [...company.planReviewDecisions, record],
  });
  refreshPlanReviewStaleness(updated, evidenceRevision);
  return updated;
}
export async function documentXml(bytes: Uint8Array) {
  return (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
}
