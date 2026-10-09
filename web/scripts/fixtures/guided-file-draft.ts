// Synthetic one-file continuous journey only. Pure contracts validate memory responses;
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
const stamp = (second: number) => `2026-10-09T12:30:${String(second).padStart(2, "0")}.000Z`;
export function fileDraftCompany() {
  return caseSchema.parse({
    id: "c0000000-0000-4000-8000-000000000001",
    profile: { ...emptyProfile(), companyName: "합성 파일 시작 기업" },
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
    id: "b0000000-0000-4000-8000-000000000001", recordedAt: stamp(14),
  });
  return caseSchema.parse({ ...company, revision: company.revision + 1,
    updatedAt: stamp(14), selectedCandidateId: record.candidateId,
    candidateSelections: [...(company.candidateSelections ?? []), record] });
}
export function prepare(company: StudioCase, raw: unknown) {
  const command = guidedPreparationRequestSchema.parse(raw);
  if (command.revision !== company.revision || company.sources.length !== 1 ||
      company.sources[0].text !== adoptedText || company.sources[0].extraction !== "manual" ||
      company.sourceIntakes[0].phase !== "adopted") throw Error("Synthetic input mismatch");
  let next: StudioCase;
  const evidence = [{ sourceId: company.sources[0].id, quote: adoptedText, locator: "합성 파일의 채택한 본문" }];
  if (command.action === "start") {
    const expected = preview(company, { revision: company.revision, sourceIds: [company.sources[0].id] }).approval;
    if (guidedPreparationDigest(command.approval) !== guidedPreparationDigest(expected) ||
        company.plans.length || company.guidedPreparationRuns?.length) throw Error("Synthetic initial command mismatch");
    const analysis = {
      summary: "채택한 파일 본문을 기반으로 한 합성 검토 후보입니다. 실적은 확인되지 않았습니다.",
      facts: [{ id: "reported-description", statement: adoptedText, status: "reported", evidence }],
      candidates: [{
        id: "synthetic-topic", classification: "future-proposal", title: "설비 상태 확인 기술",
        problem: "설비 상태 확인의 어려움", solution: adoptedText,
        targetCustomer: "소규모 제조사", differentiation: "차별성 확인 필요",
        stage: "구상", businessModel: "검토 필요",
        recommendation: "사용자가 설명한 사업과 연결된 후보", evidence,
        gaps: ["계약과 외부 시험 근거 확인 필요"],
      }],
      questions: [{ id: "q1", question: "설비 시험 계획을 알려 주세요.", reason: "근거 보완", priority: "high" }],
      warnings: ["채택한 파일 본문도 사실 확인이 필요합니다."],
      generatedAt: stamp(13), mode: "ai", sourceRevision: company.revision + 1,
    };
    next = caseSchema.parse({ ...company, revision: company.revision + 2, updatedAt: stamp(13),
      analysis, guidedPreparationRuns: [{
        id: "d0000000-0000-4000-8000-000000000001", retryOfId: null,
        mode: "ai", approval: command.approval, approvedAt: stamp(12),
        status: "awaiting_choice", phase: "analysis", analysisDigest: guidedPreparationDigest(analysis),
        candidateId: null, candidateDigest: null, planId: null, code: null,
        requests: [{ clientRequestId: command.clientRequestId, digest: guidedPreparationDigest(command) }],
        createdAt: stamp(12), updatedAt: stamp(13),
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
      sectionKey: "development", sourceIds: [company.sources[0].id],
    }];
    const plan = {
      id: planId, version: 1, mode: "ai", candidateId: selection.candidateId,
      generatedAt: stamp(16), sourceRevision: company.revision + 1, confirmedAt: null,
      content: {
        title: "파일 본문으로 시작한 합성 사업계획서", summary: adoptedText,
        sections: sectionDefinitions.map((section) => ({
          ...section, content: adoptedText + " 이 항목은 추가 확인이 필요합니다.",
          evidence, needsConfirmation: true,
        })),
        actionItems: ["설비 시험 계획과 고객 근거 보완"], interviewQuestions: ["설비 시험 계획을 알려 주세요."],
      }, review,
    };
    next = caseSchema.parse({ ...company, revision: company.revision + 3, updatedAt: stamp(17),
      stage: "drafting", plans: [plan],
      guidedPreparationRuns: [{ ...run, status: "awaiting_review", phase: "plan",
        candidateId: selection.candidateId, candidateDigest: guidedPreparationDigest(selection.candidate),
        planId, updatedAt: stamp(17),
        requests: [...run.requests, { clientRequestId: command.clientRequestId, digest: guidedPreparationDigest(command) }],
        repair: { initialPlanId: planId, finalPlanId: planId, status: "not-needed", attempted: false,
          reason: "추가 근거가 필요한 내용은 미확인으로 남겼습니다.",
          initialReviewCount: 1, finalReviewCount: 1, attemptedAt: null, completedAt: stamp(17) },
      }],
    });
  } else throw Error("Synthetic restart forbidden");
  const run = next.guidedPreparationRuns!.at(-1)!;
  assertGuidedPreparationBinding(next, run);
  const result = { company: next, run };
  if (!guidedPreparationResponse(result, company, command)) throw Error("Synthetic acknowledgment mismatch");
  return result;
}

import { randomUUID } from "node:crypto";
import { localOcrReviewedWarning } from "../../src/lib/studio-ocr-review";
import { newSourceIntakeBatch, pendingIntakeSource, intakeDigest, intakeSha, intakeRequest, intakeResponse } from "../../src/lib/studio-source-intake";
import { sourceIntakeCommandSchema, sourceIntakeOriginalInputSchema } from "../../src/lib/studio-source-intake-types";
import { validateIntakeResponse, intakeCommand } from "../../src/components/studio/source-intakes-ui";

export const fileName = "synthetic-technology.txt";
export const rawText = "합성 설비 센서는 온도 기록을 수집합니다.\n시험 계약은 없고 개발 계획을 세우고 있습니다.\n";
export const adoptedText = "합성 설비 센서는 온도 기록을 수집할 계획입니다.\n시험 계약은 없고 개발 계획을 세우고 있습니다.";
export const originalSha = intakeSha(rawText);
const ensure = (ok: unknown) => { if (!ok) throw Error("Synthetic intake identity mismatch"); };

// In-memory response fixture, not a writer or extractor. Uses the existing pure
// schemas/digests/receipt validator; no file path, store or service is imported.
export function intake(company: StudioCase, raw: unknown) {
  const command = sourceIntakeCommandSchema.parse(raw);
  ensure(command.revision === company.revision);
  const next = structuredClone(company);
  if (command.action === "create") {
    ensure(!next.sourceIntakes.length && !next.sources.length && command.files.length === 1);
    ensure(command.files[0].originalName === fileName && command.files[0].sha256 === originalSha &&
      command.files[0].sizeBytes === Buffer.byteLength(rawText));
    next.sourceIntakes = newSourceIntakeBatch(command).map(item => ({...item, createdAt:stamp(0), updatedAt:stamp(0)}));
    next.revision++;
  } else {
    const item = next.sourceIntakes[0], source = next.sources[0];
    ensure(item && command.itemId === item.id && command.expectedItemVersion === item.version);
    const original = item.original;
    ensure(original && source && source.id === item.sourceId && source.extraction === "pending" && source.text === "");
    if (command.action === "run-next") {
      ensure(command.engine === "local-document" && item.phase === "original_stored" && !item.result);
      const attemptId = randomUUID(), resultId = randomUUID();
      item.attempts.push({id:attemptId,engine:"local-document",startedAt:stamp(4),finishedAt:stamp(5),
        originalSha256:original!.sha256,sourceUpdatedAt:source.updatedAt,externalRequestStarted:false,
        status:"completed",code:null,resultId});
      item.result = {id:resultId,attemptId,engine:"local-document",generatedAt:stamp(5),
        originalSha256:original!.sha256,sourceUpdatedAt:source.updatedAt,textSha256:intakeSha(rawText),
        content:{kind:"plain",text:rawText},warnings:[],reviewStatus:"unreviewed",discardedAt:null};
      item.phase = "awaiting_review"; item.version += 2; next.revision += 2;
    } else if (command.action === "adopt") {
      ensure(item.phase === "awaiting_review" && item.result && !item.adoption);
      ensure(command.resultId === item.result!.id && command.originalSha256 === originalSha &&
        command.sourceUpdatedAt === source.updatedAt && command.text === adoptedText && command.reviewed);
      source.text = command.text; source.extraction = "manual"; source.updatedAt = stamp(6);
      source.warnings = [localOcrReviewedWarning];
      item.adoption = {id:randomUUID(),clientRequestId:command.clientRequestId,inputDigest:intakeDigest(command),
        resultId:item.result!.id,resultTextSha256:item.result!.textSha256,
        adoptedTextSha256:intakeSha(command.text),sourceUpdatedAt:source.updatedAt,adoptedAt:stamp(6)};
      item.phase = "adopted"; item.version++; next.revision++;
      next.analysis = null; next.selectedCandidateId = null;
    } else throw Error("Synthetic intake action forbidden");
    intakeRequest(item, command.action, command.clientRequestId, intakeDigest(command));
    item.updatedAt = stamp(next.revision);
  }
  next.updatedAt = stamp(next.revision);
  const parsed = caseSchema.parse(next), item = parsed.sourceIntakes[0];
  const response = intakeResponse(parsed, command.action === "create" ? null : item.id, item.batchId);
  ensure(validateIntakeResponse(response, company.id, intakeCommand(command)));
  return response;
}
export function original(company: StudioCase, itemId: string, raw: unknown, file: File, bytes: Buffer) {
  const input = sourceIntakeOriginalInputSchema.parse(raw), next = structuredClone(company), item = next.sourceIntakes[0];
  ensure(input.revision === company.revision && item.id === itemId && input.expectedItemVersion === item.version &&
    item.phase === "awaiting_original" && file.name === fileName && file.type === "text/plain" &&
    bytes.toString("utf8") === rawText && intakeSha(bytes) === item.declared.sha256);
  item.original = {originalName:file.name,mimeType:file.type,sizeBytes:bytes.length,sha256:intakeSha(bytes),sourceUpdatedAt:stamp(2)};
  item.phase = "original_stored"; item.version += 2; item.updatedAt = stamp(3);
  intakeRequest(item,"original",input.clientRequestId,intakeDigest({
    action:"original",itemId,...input,name:file.name,mimeType:file.type,sizeBytes:bytes.length,sha256:intakeSha(bytes)
  }));
  next.sources = [pendingIntakeSource(item)]; next.revision += 2; next.updatedAt = stamp(3);
  const parsed = caseSchema.parse(next), response = intakeResponse(parsed,itemId);
  ensure(validateIntakeResponse(response,company.id,{kind:"original",itemId,input,file,sha256:intakeSha(bytes)}));
  return response;
}
