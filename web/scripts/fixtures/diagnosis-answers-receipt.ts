import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  diagnosisCriteriaVersion,
  emptyDiagnosisAnswers,
} from "../../src/lib/studio-diagnosis-types";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
import type { DiagnosisAnswersCommand } from "../../src/components/studio/diagnosis-answers-response";
export function diagnosisAnswersFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 기본요건 검토 기업";
  const source = {
    id: agencyId(92),
    name: "합성 기본요건 문서",
    kind: "other" as const,
    text: "합성 중소기업 검토 문구\n다른 원문 문구",
    originalName: "synthetic-assessment.pdf",
    mimeType: "application/pdf",
    extraction: "manual" as const,
    warnings: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
  company.sources.push(source);
  company.diagnosisAnswers = emptyDiagnosisAnswers();
  const request: DiagnosisAnswersCommand = {
    action: "diagnosis-answers",
    revision: company.revision,
    answers: {
      entityType: "corporate",
      criteriaVersion: diagnosisCriteriaVersion,
      sme: {
        status: "supported",
        reviewed: true,
        note: "  합성 검토 사유\n둘째 줄  ",
        evidence: [
          {
            sourceId: source.id,
            sourceUpdatedAt: source.updatedAt,
            quote: "합성 중소기업 검토 문구",
            locator: "원본 1페이지",
          },
        ],
      },
      industryEligibility: {
        status: "unknown",
        reviewed: false,
        note: "  제외업종 확인 필요\n미확인 유지  ",
        evidence: [],
      },
    },
  };
  return {
    company: caseSchema.parse(company),
    request,
    source,
    saved: diagnosisAnswersResult(company, request),
  };
}
export function diagnosisAnswersResult(company: StudioCase, command: DiagnosisAnswersCommand) {
  const saved = structuredClone(company);
  saved.diagnosisAnswers = structuredClone(command.answers);
  saved.revision++;
  saved.analysis = null;
  saved.selectedCandidateId = null;
  saved.plans = saved.plans.map((plan) => ({ ...plan, confirmedAt: null }));
  saved.diagnoses = saved.diagnoses.map((diagnosis) => ({ ...diagnosis, stale: true }));
  return caseSchema.parse(saved);
}
