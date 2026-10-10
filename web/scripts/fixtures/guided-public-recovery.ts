// Memory-only responses for the public evidence recovery UI. No writer or provider is activated.
import { answerWorkflowCompany } from "./guided-answer-workflow";
import {
  caseSchema,
  sourceSchema,
  type StudioCase,
  type SourceDocument,
} from "../../src/lib/studio-schema";
import { guidedPreparationApproval } from "../../src/lib/studio-guided-preparation-state";
import { publicEvidenceSaved } from "../../src/lib/studio-public-evidence";
export const model = "synthetic-disabled";
export function recoveryCompany() {
  const company = answerWorkflowCompany();
  company.profile.companyName = "합성 공개 근거 복구 기업";
  return company;
}
export function status(company: StudioCase) {
  return {
    company,
    active: false,
    aiConfigured: true,
    approval: guidedPreparationApproval(company, model),
  };
}
export function save(
  company: StudioCase,
  command: { action: string; revision: number; source: SourceDocument },
) {
  if (
    command.action !== "source" ||
    command.revision !== company.revision ||
    company.sources.some((source) => source.id === command.source.id)
  )
    throw Error("Synthetic command mismatch");
  const source = sourceSchema.parse(command.source);
  const next = caseSchema.parse({
    ...company,
    revision: company.revision + 1,
    updatedAt: source.updatedAt,
    analysis: null,
    selectedCandidateId: null,
    sources: [...company.sources, source],
    plans: company.plans.map((plan) => ({ ...plan, confirmedAt: null })),
  });
  if (
    !publicEvidenceSaved(
      next,
      {
        caseId: company.id,
        command: { action: "source", revision: company.revision, source },
        sectionKey: "market",
      },
      company,
    )
  )
    throw Error("Synthetic saved-source mismatch");
  return next;
}
