import "server-only";
import { createAdditionalValidationApproval } from "../../scripts/operational-validation-additional-records.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import type {
  AdditionalValidationEvidence,
  AdditionalValidationApproval,
} from "../../scripts/operational-validation-additional-records.mjs";
import type { PlanQualityStore } from "./studio-plan-quality-store";

/** Independent DB half of the journal/DB comparison. The journal must still prove its
 * original file identity and command/receipt chain; this read is never execution authority.
 * No current configuration, clock, key, prompt builder or second DB transaction is used.
 */
export function auditAdditionalValidationDatabase(
  store: PlanQualityStore,
  input: AdditionalValidationEvidence,
) {
  const evidence = createAdditionalValidationApproval(input)
    .payload as AdditionalValidationApproval; // Validated copy.
  const proof = store.inspectCompletedProviderHistory({
    runId: evidence.selection.runId,
    budgetRevision: evidence.checkpoint.budgetRevision,
  });
  if (
    !proof ||
    proof.databaseDigest !== evidence.databaseDigest ||
    digest(proof.selection) !== digest(evidence.selection) ||
    digest(proof.checkpoint) !== digest(evidence.checkpoint)
  )
    throw Error("VALIDATION_HISTORY_MISMATCH");
  const { current, currentBudget: budget } = proof;
  if (
    current.storageVersion !== 9 ||
    current.candidateVersions !== 1 ||
    current.candidateRequests !== 1 ||
    current.runs !== 0 ||
    current.revisions !== 0 ||
    current.requests !== 0 ||
    current.executionRuns !== 0 ||
    current.executionEvents !== 0 ||
    current.executionRequests !== 0 ||
    current.actualRuns < 1 ||
    current.actualRuns > 2 ||
    current.providerPolicies < 1 ||
    current.providerPolicies > 2 ||
    !budget ||
    budget.currency !== "USD" ||
    budget.unitScale !== 6 ||
    budget.capUnits !== "15000000" ||
    BigInt(budget.recognizedUnits) + BigInt(budget.heldUnits) > BigInt("15000000")
  )
    throw Error("VALIDATION_HISTORY_MISMATCH");
  return { ...proof, fileIdentityAudited: false as const, transmissionAllowed: false as const };
}
