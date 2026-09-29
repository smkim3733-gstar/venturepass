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
