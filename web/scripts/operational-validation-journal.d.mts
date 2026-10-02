export type ValidationStage =
  "register" | "policy" | "reserve" | "approve-transmission" | "execute" | "continue-review";
export type ValidationProfile = {
  approvalId: string;
  directory: string;
  controlDirectory: string;
  currency: string;
  unitScale: number;
  capUnits: string;
};
export type ValidationJournal = {
  initialize(createEmptyDatabase: (directory: string) => void): string;
  readStep(stage: ValidationStage): { command: unknown | null; receipt: unknown | null };
  readPolicyRejection(): { command: unknown; evidence: unknown } | null;
  rejectPendingPolicy(evidence: object): void;
  prepare(stage: ValidationStage, payload: object): unknown;
  acknowledge(stage: ValidationStage, receipt: object): void;
  close(): void;
};
export class ValidationJournalError extends Error {
  code: string;
  constructor(code: string);
}
export function validationJournalErrorCode(error: unknown): string;
export function acquireValidationJournal(profile: ValidationProfile): ValidationJournal;
export function inspectValidationJournal(profile: ValidationProfile): {
  state: "virgin" | "initialized" | "blocked";
  reason?: string;
  completedStages?: number;
  pendingStage?: ValidationStage | null;
  policyRejectionRecorded?: true;
  ledgerAudited: false;
  transmissionAllowed: false;
};

export type ValidationJournalAuditView = {
  original: { instanceId: string; recordCount: number; headDigest: string };
  steps: Record<ValidationStage, { command: unknown | null; receipt: unknown | null }>;
  rejection: { command: unknown; evidence: unknown } | null;
  additional: ReturnType<
    typeof import("./operational-validation-additional-records.mjs").inspectAdditionalValidationRecords
  > | null;
};
export type AdditionalValidationJournal = ValidationJournal & {
  /** Both file copies, immutable identities and the held lease are checked in one read. */
  readAuditView(): ValidationJournalAuditView;
  readOriginalAnchor(): { instanceId: string; recordCount: number; headDigest: string };
  readAdditionalState(): ReturnType<
    typeof import("./operational-validation-additional-records.mjs").inspectAdditionalValidationRecords
  > | null;
  appendAdditionalApproval(
    evidence: import("./operational-validation-additional-records.mjs").AdditionalValidationEvidence,
  ): import("./operational-validation-additional-records.mjs").AdditionalValidationApproval;
  prepareAdditional(
    stage: import("./operational-validation-additional-records.mjs").AdditionalValidationStage,
    payload: object,
  ): unknown;
  acknowledgeAdditional(
    stage: import("./operational-validation-additional-records.mjs").AdditionalValidationStage,
    receipt: object,
  ): void;
};
/** File consistency only. Existing initialized original journal is required. */
export function acquireAdditionalValidationJournal(
  profile: ValidationProfile,
): AdditionalValidationJournal;
