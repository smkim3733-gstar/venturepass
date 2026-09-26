import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCandidateSelection,
  currentVerifiedCandidateSelection,
} from "./studio-candidate-selection";
import {
  currentCandidateSelection,
  candidateSelectionMutationSchema,
  type CandidateSelectionCompany,
  type CandidateSelectionInput,
} from "./studio-candidate-selection-types";

function fixture(): CandidateSelectionCompany {
  return {
    selectedCandidateId: null,
    candidateSelections: [],
    analysis: {
      generatedAt: "2026-09-25T00:00:00.000Z",
      sourceRevision: 3,
      mode: "assisted",
      summary: "분석",
      facts: [],
      questions: [],
      warnings: [],
      candidates: [
        {
          id: "candidate",
          title: "기존 기술",
          problem: "문제",
          solution: "해결",
          targetCustomer: "고객",
          differentiation: "확인 필요",
          stage: "개발 중",
          businessModel: "미확인",
          recommendation: "자동 추천 설명",
          evidence: [],
          gaps: [],
        },
      ],
    },
  };
}
function input(company = fixture()): CandidateSelectionInput {
  return {
    action: "select-candidate",
    revision: 4,
    clientRequestId: randomUUID(),
    candidateId: "candidate",
    analysisGeneratedAt: company.analysis!.generatedAt,
    analysisSourceRevision: company.analysis!.sourceRevision,
    expectedSelectedCandidateId: company.selectedCandidateId,
    reason: "고객 범위를 검토하고 선택했습니다.",
  };
}
function selected() {
  const company = fixture();
  const saved = buildCandidateSelection(company, input(company), {
    id: randomUUID(),
    recordedAt: new Date().toISOString(),
  });
  company.candidateSelections!.push(saved);
  company.selectedCandidateId = saved.candidateId;
  return company;
}
describe("candidate selection contract", () => {
  it("does not invent a reason for legacy selections", () => {
    const company = fixture();
    company.selectedCandidateId = "candidate";
    expect(currentCandidateSelection(company)).toBeNull();
    expect(currentVerifiedCandidateSelection(company)).toBeNull();
  });
  it("copies only current and preceding candidate snapshots without aliasing", () => {
    const company = selected();
    const saved = company.candidateSelections![0];
    expect(saved.event).toBe("selection");
    expect(saved.previousContext).toBe("none");
    expect(saved).not.toHaveProperty("analysis");
    company.analysis!.candidates[0].title = "변경";
    expect(saved.candidate.title).toBe("기존 기술");
    expect(currentCandidateSelection(company)).toBeNull();
  });
  it.each(["generatedAt", "sourceRevision", "mode"] as const)("rejects old analysis %s", (key) => {
    const company = selected();
    if (key === "sourceRevision") company.analysis!.sourceRevision++;
    else if (key === "mode") company.analysis!.mode = "ai";
    else company.analysis!.generatedAt = "2026-09-26T00:00:00.000Z";
    expect(currentCandidateSelection(company)).toBeNull();
  });
  it("server rejects otherwise identical metadata with changed analysis context", () => {
    const company = selected();
    company.analysis!.summary = "다른 분석 내용";
    expect(currentCandidateSelection(company)).not.toBeNull();
    expect(currentVerifiedCandidateSelection(company)).toBeNull();
  });
  it("requires last history record rather than resurrecting an earlier choice", () => {
    const company = selected();
    company.candidateSelections!.push({
      ...company.candidateSelections![0],
      id: randomUUID(),
      candidateId: "other",
    });
    expect(currentCandidateSelection(company)).toBeNull();
  });
  it("preserves an unavailable previous ID without guessing a snapshot", () => {
    const company = fixture();
    company.selectedCandidateId = "legacy";
    const saved = buildCandidateSelection(company, input(company), {
      id: randomUUID(),
      recordedAt: new Date().toISOString(),
    });
    expect(saved.previousCandidateId).toBe("legacy");
    expect(saved.previousCandidate).toBeNull();
    expect(saved.previousContext).toBe("unavailable");
  });
  it.each(["", "   ", "x".repeat(2001)])("rejects blank/oversized reasons", (reason) => {
    expect(candidateSelectionMutationSchema.safeParse({ ...input(), reason }).success).toBe(false);
  });
  it("strictly rejects server metadata and reasonless legacy writes", () => {
    expect(
      candidateSelectionMutationSchema.safeParse({ ...input(), recordedAt: "forged" }).success,
    ).toBe(false);
    expect(
      candidateSelectionMutationSchema.safeParse({
        action: "select-candidate",
        revision: 0,
        candidateId: "candidate",
      }).success,
    ).toBe(false);
  });
});
