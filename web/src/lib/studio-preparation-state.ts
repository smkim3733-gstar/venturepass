// Node-only hashes for local preparation. Client code imports only preparation-types.
import { createHash } from "node:crypto";
import { diagnosisInputFingerprint } from "./studio-diagnosis";
import { diagnosisCriteriaVersion } from "./studio-diagnosis-types";
import { currentVerifiedCandidateSelection } from "./studio-candidate-selection";
import type { PreparationRun } from "./studio-preparation-types";
import type { StudioCase } from "./studio-schema";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function preparationDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function isPreparationStale(record: StudioCase, run: PreparationRun): boolean {
  if (
    run.inputFingerprint !== diagnosisInputFingerprint(record) ||
    run.criteriaVersion !== diagnosisCriteriaVersion
  )
    return true;
  if (run.analysisDigest !== (record.analysis ? preparationDigest(record.analysis) : null))
    return true;
  if (
    run.selectedCandidateId !== null &&
    (!currentVerifiedCandidateSelection(record) ||
      record.selectedCandidateId !== run.selectedCandidateId ||
      run.selectedCandidateDigest !==
        preparationDigest(
          record.analysis?.candidates.find((item) => item.id === run.selectedCandidateId) ?? null,
        ))
  )
    return true;
  if (
    run.diagnosisId &&
    !record.diagnoses.some((item) => item.id === run.diagnosisId && !item.stale)
  )
    return true;
  if (
    run.planId &&
    run.planDigest !==
      preparationDigest(record.plans.find((item) => item.id === run.planId) ?? null)
  )
    return true;
  return false;
}
export function refreshPreparationStaleness(record: StudioCase): void {
  for (const run of record.preparationRuns) run.stale = isPreparationStale(record, run);
}
