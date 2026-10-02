export type AdditionalValidationStage =
  "policy" | "reserve" | "approve-transmission" | "execute" | "continue-review";
export type AdditionalValidationEvidence = {
  original: { instanceId: string; recordCount: number; headDigest: string };
  selection: { runId: string; runDigest: string; approvalBindingDigest: string };
  checkpoint: {
    runRevision: 10;
    snapshotDigest: string;
    budgetRevision: number;
    budgetHeadDigest: string;
    recognizedUnits: string;
    heldUnits: "0";
  };
  databaseDigest: string;
};
export function additionalValidationScope(): {
  approvalVersion: 1;
  approvalId: "venturepass-operational-validation-v2-20261002";
  engineVersion: "plan-observation-v2";
  generationCalls: 1; reviewCalls: 1; totalGenerationCalls: 2; totalReviewCalls: 2;
  automaticRetryAllowed: false; budgetAction: "keep-existing-budget";
  currency: "USD"; unitScale: 6; capUnits: "15000000";
};
export type AdditionalValidationApproval = AdditionalValidationEvidence & {
  scope: ReturnType<typeof additionalValidationScope>;
};
export type AdditionalValidationRecord = {
  previous: string; campaign: 2; stage: AdditionalValidationStage | "additional-approval";
  kind: "command" | "receipt" | "approval"; payload: object;
};
export function createAdditionalValidationApproval(evidence: unknown): AdditionalValidationRecord;
export function inspectAdditionalValidationRecords(evidence: unknown, records: unknown): {
  approval: AdditionalValidationApproval | null;
  completedStages: number;
  pendingStage: AdditionalValidationStage | null;
  steps: Record<AdditionalValidationStage, { command: object | null; receipt: object | null }>;
  headDigest: string; recordCount: number; ledgerAudited: false; transmissionAllowed: false;
};
export function prepareAdditionalValidationRecord(
  evidence: unknown, records: AdditionalValidationRecord[],
  stage: AdditionalValidationStage, kind: "command" | "receipt", payload: object,
): {
  status: "already-recorded" | "append-required"; record: AdditionalValidationRecord;
  ledgerAudited: false; transmissionAllowed: false;
};
