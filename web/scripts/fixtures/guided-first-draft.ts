// Synthetic front-half journey only. Pure contracts validate memory responses;
// no store, service, engine, SDK, key or database is activated.
import {
  caseSchema, emptyProfile, sectionDefinitions, type StudioCase,
} from "../../src/lib/studio-schema";
import {
  guidedPreparationApproval, guidedSelectedPreparationApproval,
  guidedPreparationDigest, guidedPreparationInputCompany,
  assertGuidedPreparationBinding, assertGuidedResultSourceIds,
} from "../../src/lib/studio-guided-preparation-state";
import {
  guidedPreparationRequestSchema, guidedSourceSelectionPreviewSchema,
} from "../../src/lib/studio-guided-preparation-types";
import { buildCandidateSelection, currentVerifiedCandidateSelection } from "../../src/lib/studio-candidate-selection";
import type { CandidateSelectionInput } from "../../src/lib/studio-candidate-selection-types";
import { serializeStudioAiInput, STUDIO_AI_INPUT_CHARACTER_LIMIT } from "../../src/lib/studio-ai-input";
import { selectedEvidenceSnapshot } from "../../src/components/studio/guided-evidence-selection-state";
import { guidedPreparationResponse } from "../../src/components/studio/guided-preparation-ui";

export const description = "소규모 제조사의 설비 상태를 센서로 확인하는 기술을 구상하고 있습니다. 고객 계약과 외부 시험은 아직 없습니다.";
export const model = "synthetic-no-provider";
const stamp = (second: number) => `2026-10-09T11:30:${String(second).padStart(2, "0")}.000Z`;
export function firstDraftCompany() {
  return caseSchema.parse({
    id: "c0000000-0000-4000-8000-000000000001",
    profile: { ...emptyProfile(), companyName: "합성 설명 시작 기업" },
    sources: [], analysis: null, selectedCandidateId: null, plans: [], tasks: [],
    stage: "preparing", revision: 0, createdAt: stamp(0), updatedAt: stamp(0),
  });
}
export function status(company: StudioCase) {
  return { company, active: false, aiConfigured: true,
    approval: guidedPreparationApproval(company, model) };
}
export function preview(company: StudioCase, raw: unknown) {
  const input = guidedSourceSelectionPreviewSchema.parse(raw);
  if (input.revision !== company.revision) throw Error("Synthetic stale preview");
  const approval = guidedSelectedPreparationApproval(company, model, input.sourceIds);
  const characters = serializeStudioAiInput(guidedPreparationInputCompany(company, approval)).length;
  const result = {
    ...status(company), approval, inputCharacters: characters,
    inputCharacterLimit: STUDIO_AI_INPUT_CHARACTER_LIMIT,
    overInputLimit: characters > STUDIO_AI_INPUT_CHARACTER_LIMIT, transmissionAllowed: false,
  };
  if (!selectedEvidenceSnapshot(result, company, input.sourceIds)) throw Error("Synthetic scope mismatch");
  return result;
}
export function select(company: StudioCase, input: CandidateSelectionInput) {
  if (input.revision !== company.revision) throw Error("Synthetic stale selection");
  const record = buildCandidateSelection(company, input, {
    id: "b0000000-0000-4000-8000-000000000001", recordedAt: stamp(4),
  });
  return caseSchema.parse({ ...company, revision: company.revision + 1,
    updatedAt: stamp(4), selectedCandidateId: record.candidateId,
    candidateSelections: [...(company.candidateSelections ?? []), record] });
}
export function prepare(company: StudioCase, raw: unknown) {
  const command = guidedPreparationRequestSchema.parse(raw);
  if (command.revision !== company.revision || company.sources.length ||
      company.profile.technologySummary !== description) throw Error("Synthetic input mismatch");
  let next: StudioCase;
  const evidence = [{ sourceId: "profile", quote: description, locator: "technologySummary" }];
  if (command.action === "start") {
    const expected = preview(company, { revision: company.revision, sourceIds: [] }).approval;
    if (guidedPreparationDigest(command.approval) !== guidedPreparationDigest(expected) ||
        company.plans.length || company.guidedPreparationRuns?.length) throw Error("Synthetic initial command mismatch");
    const analysis = {
      summary: "회사 설명을 기반으로 한 합성 검토 후보입니다. 실적은 확인되지 않았습니다.",
      facts: [{ id: "reported-description", statement: description, status: "reported", evidence }],
      candidates: [{
        id: "synthetic-topic", classification: "future-proposal", title: "설비 상태 확인 기술",
        problem: "설비 상태 확인의 어려움", solution: description,
        targetCustomer: "소규모 제조사", differentiation: "차별성 확인 필요",
        stage: "구상", businessModel: "검토 필요",
        recommendation: "사용자가 설명한 사업과 연결된 후보", evidence,
        gaps: ["계약과 외부 시험 근거 확인 필요"],
      }],
      questions: [{ id: "q1", question: "설비 시험 계획을 알려 주세요.", reason: "근거 보완", priority: "high" }],
      warnings: ["회사 설명은 사용자 진술이며 증빙 확인이 필요합니다."],
      generatedAt: stamp(3), mode: "ai", sourceRevision: company.revision + 1,
    };
    next = caseSchema.parse({ ...company, revision: company.revision + 2, updatedAt: stamp(3),
      analysis, guidedPreparationRuns: [{
        id: "d0000000-0000-4000-8000-000000000001", retryOfId: null,
        mode: "ai", approval: command.approval, approvedAt: stamp(2),
        status: "awaiting_choice", phase: "analysis", analysisDigest: guidedPreparationDigest(analysis),
        candidateId: null, candidateDigest: null, planId: null, code: null,
        requests: [{ clientRequestId: command.clientRequestId, digest: guidedPreparationDigest(command) }],
        createdAt: stamp(2), updatedAt: stamp(3),
      }],
    });
  } else if (command.action === "continue") {
    const run = company.guidedPreparationRuns?.at(-1);
    const selection = currentVerifiedCandidateSelection(company);
    if (!run || run.id !== command.runId || run.status !== "awaiting_choice" || !selection ||
        company.plans.length) throw Error("Synthetic continuation mismatch");
    assertGuidedPreparationBinding(company, run);
    assertGuidedResultSourceIds(run.approval, evidence.map((e) => e.sourceId));
    const planId = "a0000000-0000-4000-8000-000000000001";
    const review = [{
      id: "synthetic-confirmation", severity: "warning", category: "confirmation",
      message: "계약과 외부 시험 근거 확인 필요", action: "자료가 생기면 보완해 주세요.",
      sectionKey: "development", sourceIds: ["profile"],
    }];
    const plan = {
      id: planId, version: 1, mode: "ai", candidateId: selection.candidateId,
      generatedAt: stamp(6), sourceRevision: company.revision + 1, confirmedAt: null,
      content: {
        title: "설명으로 시작한 합성 사업계획서", summary: description,
        sections: sectionDefinitions.map((section) => ({
          ...section, content: description + " 이 항목은 추가 확인이 필요합니다.",
          evidence, needsConfirmation: true,
        })),
        actionItems: ["설비 시험 계획과 고객 근거 보완"], interviewQuestions: ["설비 시험 계획을 알려 주세요."],
      }, review,
    };
    next = caseSchema.parse({ ...company, revision: company.revision + 3, updatedAt: stamp(7),
      stage: "drafting", plans: [plan],
      guidedPreparationRuns: [{ ...run, status: "awaiting_review", phase: "plan",
        candidateId: selection.candidateId, candidateDigest: guidedPreparationDigest(selection.candidate),
        planId, updatedAt: stamp(7),
        requests: [...run.requests, { clientRequestId: command.clientRequestId, digest: guidedPreparationDigest(command) }],
        repair: { initialPlanId: planId, finalPlanId: planId, status: "not-needed", attempted: false,
          reason: "추가 근거가 필요한 내용은 미확인으로 남겼습니다.",
          initialReviewCount: 1, finalReviewCount: 1, attemptedAt: null, completedAt: stamp(7) },
      }],
    });
  } else throw Error("Synthetic restart forbidden");
  const run = next.guidedPreparationRuns!.at(-1)!;
  assertGuidedPreparationBinding(next, run);
  const result = { company: next, run };
  if (!guidedPreparationResponse(result, company, command)) throw Error("Synthetic acknowledgment mismatch");
  return result;
}
