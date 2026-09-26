// Node-only server helpers. Client code imports the pure types module instead.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import {
  canonicalSelectionValue,
  candidateSelectionLimits,
  candidateSelectionMutationSchema,
  candidateSelectionSchema,
  currentCandidateSelection,
  type CandidateSelection,
  type CandidateSelectionCompany,
  type CandidateSelectionInput,
} from "./studio-candidate-selection-types";

function digest(value: unknown) {
  return createHash("sha256").update(canonicalSelectionValue(value)).digest("hex");
}
export function candidateSelectionInputDigest(input: CandidateSelectionInput) {
  const {
    revision: _revision,
    clientRequestId: _clientRequestId,
    action: _action,
    ...payload
  } = candidateSelectionMutationSchema.parse(input);
  void _revision;
  void _clientRequestId;
  void _action;
  return digest(payload);
}
export function currentVerifiedCandidateSelection(
  company: CandidateSelectionCompany,
): CandidateSelection | null {
  const saved = currentCandidateSelection(company);
  return saved &&
    saved.analysisDigest === digest(company.analysis) &&
    saved.candidateDigest === digest(saved.candidate)
    ? saved
    : null;
}
export function assertCandidateSelectionCapacity(records: CandidateSelection[]) {
  if (
    records.length > candidateSelectionLimits.records ||
    JSON.stringify(records).length > candidateSelectionLimits.characters
  )
    throw new StudioError(
      "아이템 선택 이력 보관 한도를 초과했습니다. 기존 이력은 보존됩니다.",
      409,
      "CANDIDATE_SELECTION_LIMIT",
    );
}
export function isCandidateSelectionReplay(
  company: CandidateSelectionCompany,
  input: CandidateSelectionInput,
): boolean {
  const previous = company.candidateSelections?.find(
    (record) => record.clientRequestId === input.clientRequestId,
  );
  if (!previous) return false;
  if (previous.inputDigest !== candidateSelectionInputDigest(input))
    throw new StudioError(
      "같은 요청으로 다른 선택 이유를 저장할 수 없습니다.",
      409,
      "CANDIDATE_SELECTION_CONFLICT",
    );
  // A historical acknowledgement must not restore an old selection or claim a changed analysis.
  const current = currentVerifiedCandidateSelection(company);
  if (
    !current ||
    company.selectedCandidateId !== previous.candidateId ||
    current.analysisDigest !== previous.analysisDigest
  )
    throw new StudioError(
      "선택 이후 분석 또는 현재 아이템이 변경되었습니다. 최신 상태를 확인해 주세요.",
      409,
      "CANDIDATE_SELECTION_CHANGED",
    );
  return true;
}
export function buildCandidateSelection(
  company: CandidateSelectionCompany,
  raw: CandidateSelectionInput,
  metadata: { id: string; recordedAt: string },
): CandidateSelection {
  const input = candidateSelectionMutationSchema.parse(raw);
  const analysis = company.analysis;
  if (
    !analysis ||
    analysis.generatedAt !== input.analysisGeneratedAt ||
    analysis.sourceRevision !== input.analysisSourceRevision
  )
    throw new StudioError(
      "기업 분석이 변경되었습니다. 현재 분석을 확인해 주세요.",
      409,
      "CANDIDATE_ANALYSIS_CHANGED",
    );
  if (company.selectedCandidateId !== input.expectedSelectedCandidateId)
    throw new StudioError(
      "현재 선택한 아이템이 변경되었습니다. 다시 확인해 주세요.",
      409,
      "CANDIDATE_SELECTION_CHANGED",
    );
  const matches = analysis.candidates.filter((candidate) => candidate.id === input.candidateId);
  if (matches.length !== 1)
    throw new StudioError(
      "현재 기업 분석의 유일한 아이템을 선택해 주세요.",
      400,
      "INVALID_CANDIDATE",
    );
  const candidate = structuredClone(matches[0]);
  const priorMatches =
    company.selectedCandidateId === null
      ? []
      : analysis.candidates.filter((item) => item.id === company.selectedCandidateId);
  const previousCandidate = priorMatches.length === 1 ? structuredClone(priorMatches[0]) : null;
  const record = candidateSelectionSchema.parse({
    ...metadata,
    clientRequestId: input.clientRequestId,
    inputDigest: candidateSelectionInputDigest(input),
    origin: "manual",
    event: company.selectedCandidateId === input.candidateId ? "reason-recorded" : "selection",
    reason: input.reason,
    previousCandidateId: company.selectedCandidateId,
    candidateId: input.candidateId,
    analysisGeneratedAt: analysis.generatedAt,
    analysisSourceRevision: analysis.sourceRevision,
    analysisMode: analysis.mode,
    analysisDigest: digest(analysis),
    candidateDigest: digest(candidate),
    candidate,
    previousCandidate,
    previousContext:
      company.selectedCandidateId === null
        ? "none"
        : previousCandidate
          ? "available"
          : "unavailable",
    previousRecordId: company.candidateSelections?.at(-1)?.id ?? null,
  });
  assertCandidateSelectionCapacity([...(company.candidateSelections ?? []), record]);
  return record;
}
