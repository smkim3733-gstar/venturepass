import { caseSchema, companyProfileSchema, type CompanyProfile, type StudioCase } from "@/lib/studio-schema";
import { emptyDiagnosisAnswers } from "@/lib/studio-diagnosis-types";
import { emptyPreparationAutomation } from "@/lib/studio-preparation-automation-types";

/** Check the requested profile and empty initial state before opening a new company. */
export function createdCompanyResponse(
  value: unknown,
  profile: CompanyProfile,
  existingIds: readonly string[],
): StudioCase | null {
  const parsed = caseSchema.safeParse(value);
  const request = companyProfileSchema.safeParse(profile);
  if (!parsed.success || !request.success) return null;
  const next = parsed.data;
  if (
    existingIds.includes(next.id) ||
    next.revision !== 0 ||
    next.stage !== "preparing" ||
    !Number.isFinite(Date.parse(next.createdAt)) ||
    next.createdAt !== next.updatedAt ||
    JSON.stringify(next.profile) !== JSON.stringify(request.data) ||
    next.applicationNumberBindings !== undefined ||
    next.analysis !== null ||
    next.selectedCandidateId !== null ||
    Object.values(next).some((value) => Array.isArray(value) && value.length !== 0) ||
    JSON.stringify(next.diagnosisAnswers) !== JSON.stringify(emptyDiagnosisAnswers()) ||
    JSON.stringify(next.preparationAutomation) !== JSON.stringify(emptyPreparationAutomation())
  ) return null;
  return next;
}
