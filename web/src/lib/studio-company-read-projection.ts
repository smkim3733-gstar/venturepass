import { caseSchema } from "./studio-schema";
import { refreshDiagnosisStaleness } from "./studio-diagnosis";
import { refreshPreparationStaleness } from "./studio-preparation-state";
import { refreshPlanReviewStaleness } from "./studio-plan-review";
import { withApplicationCriteriaContexts } from "./studio-criteria-version";

/** Same derived read semantics for StudioStore.get and the locked comparison SELECT. */
export function projectStoredCompany(row: { body: string; evidence_revision: number }) {
  const record = caseSchema.parse(JSON.parse(row.body));
  refreshDiagnosisStaleness(record);
  refreshPreparationStaleness(record);
  refreshPlanReviewStaleness(record, row.evidence_revision);
  return withApplicationCriteriaContexts(record);
}
