// Memory-only fixture. No writer, SDK, original file or external service.
import { randomUUID } from "node:crypto";
import { caseSchema, emptyProfile } from "../../src/lib/studio-schema";
export function confirmationCompany() {
  const now = "2026-10-10T00:00:00.000Z",
    hash = "a".repeat(64);
  const candidate = {
    id: "synthetic",
    title: "합성 신청 주제",
    problem: "합성 문제",
    solution: "합성 해결",
    targetCustomer: "합성 고객",
    differentiation: "합성 차이",
    stage: "개발 중",
    businessModel: "합성 수익",
    recommendation: "합성 추천",
    evidence: [],
    gaps: [],
  };
  const company = caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 검토 완료 확인 기업" },
    sources: [],
    analysis: {
      summary: "합성 분석",
      facts: [],
      candidates: [candidate],
      questions: [],
      warnings: [],
      generatedAt: now,
      mode: "assisted",
      sourceRevision: 3,
    },
    selectedCandidateId: candidate.id,
    candidateSelections: [
      {
        id: randomUUID(),
        clientRequestId: randomUUID(),
        inputDigest: hash,
        recordedAt: now,
        origin: "manual",
        event: "selection",
        reason: "합성 선택",
        previousCandidateId: null,
        candidateId: candidate.id,
        analysisGeneratedAt: now,
        analysisSourceRevision: 3,
        analysisMode: "assisted",
        analysisDigest: hash,
        candidateDigest: hash,
        candidate,
        previousCandidate: null,
        previousContext: "none",
        previousRecordId: null,
      },
    ],
    plans: [1, 2].map((version) => ({
      id: randomUUID(),
      version,
      generatedAt: now,
      mode: "manual",
      candidateId: candidate.id,
      sourceRevision: 3,
      confirmedAt: null,
      review: [],
      content: {
        title: "검토할 합성 원고 " + version,
        summary: "합성 핵심 요약",
        sections: [
          {
            key: "problem",
            title: "고객의 문제",
            content: "검토한 합성 본문 " + version,
            evidence: [],
            needsConfirmation: false,
          },
        ],
        actionItems: [],
        interviewQuestions: [],
      },
    })),
    tasks: [],
    stage: "preparing",
    revision: 8,
    createdAt: now,
    updatedAt: now,
  });
  return company;
}
export const model = "synthetic-disabled";
