import "server-only";
import { resolve } from "node:path";
import {
  acquireAdditionalValidationJournal,
  type AdditionalValidationJournal,
  type ValidationProfile,
} from "../../scripts/operational-validation-journal.mjs";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { AdditionalOperationalValidationPreparation } from "./studio-operational-validation-additional-preparation";
import {
  createVersionedProviderProductionRuntime,
  revokeProviderProductionRuntime,
  type ProviderProductionRuntime,
} from "./studio-plan-quality-provider-production-runtime";
import { ProviderProductionExecutionService } from "./studio-plan-quality-provider-production-service";
import { inspectProviderProductionServer } from "./studio-plan-quality-provider-production-server";
import { projectAuditedVersionedProviderProductionStatus } from "./studio-plan-quality-provider-production-status";
import type { ProviderProductionSelection } from "./studio-plan-quality-provider-production-service-types";

const fail = (): never => {
  throw Error("VALIDATION_ADDITIONAL_EXECUTION_UNAVAILABLE");
};
/** Dedicated local owner of the existing journal lease, one fixed v2 runtime and its captures.
 * Construction/reconciliation is keyless; no stored contract or status grants transmission. */
export class AdditionalOperationalValidationSession {
  readonly #journal: AdditionalValidationJournal;
  readonly #store: PlanQualityStore;
  readonly #preparation: AdditionalOperationalValidationPreparation;
  #owner: {
    runtime: ProviderProductionRuntime;
    store: PlanQualityStore;
    service: ProviderProductionExecutionService;
  } | null = null;
  #selection: ProviderProductionSelection | null = null;
  readonly #directory: string;
  #closed = false;
  #active = false;
  constructor(profile: ValidationProfile) {
    if (
      arguments.length !== 1 ||
      !process.env.VENTURE_DATA_DIR ||
      resolve(process.env.VENTURE_DATA_DIR) !== resolve(profile.directory)
    )
      fail();
    this.#directory = resolve(profile.directory);
    this.#journal = acquireAdditionalValidationJournal(profile);
    let opened: PlanQualityStore | null = null;
    try {
      this.#journal.readAuditView(); // Existing DB/file identities BEFORE any store constructor.
      this.#store = opened = new PlanQualityStore(profile.directory);
      this.#preparation = new AdditionalOperationalValidationPreparation(
        this.#store,
        this.#journal,
        () => this.owner().store,
      );
      this.#preparation.audit();
    } catch (error) {
      opened?.close();
      this.#journal.close();
      throw error;
    }
  }
  private owner() {
    if (this.#owner) return this.#owner;
    const other = inspectProviderProductionServer();
    if (other.status !== "not-installed" && other.status !== "closed") return fail();
    if (!process.env.VENTURE_DATA_DIR || resolve(process.env.VENTURE_DATA_DIR) !== this.#directory)
      return fail();
    const runtime = createVersionedProviderProductionRuntime("plan-observation-v2");
    try {
      const store = new PlanQualityStore(this.#directory, { providerProductionRuntime: runtime });
      this.#owner = { runtime, store, service: new ProviderProductionExecutionService(store) };
      return this.#owner;
    } catch (error) {
      revokeProviderProductionRuntime(runtime);
      throw error;
    }
  }
  private open() {
    if (this.#closed) fail();
  }
  private state() {
    const audited = this.#preparation.audit();
    const approval = audited.additionalApproval;
    const selection = approval
      ? {
          runId: approval.runId,
          runDigest: approval.runDigest,
          approvalBindingDigest: approval.recordDigest,
        }
      : null;
    const snapshot = audited.additionalSnapshot;
    const status =
      selection &&
      snapshot &&
      (snapshot.archiveFormatVersion === 3 || snapshot.archiveFormatVersion === 5)
        ? projectAuditedVersionedProviderProductionStatus(selection, snapshot)
        : null;
    const budget = audited.currentBudget;
    const checkpoint =
      status && snapshot
        ? {
            runRevision: snapshot.revision,
            snapshotDigest: snapshot.snapshotDigest,
            budgetRevision: budget.revision,
            budgetHeadDigest: budget.headDigest,
            recognizedUnits: budget.recognizedUnits,
            heldUnits: budget.heldUnits,
          }
        : null;
    return { audited, selection, status, checkpoint };
  }
  /** Recover acknowledgements only from audited durable records. Never recreates a lost DB row,
   * retries an attempted dispatch, loads current configuration or installs an SDK owner. */
  reconcile() {
    this.open();
    if (this.#active) return fail();
    this.#preparation.reconcile();
    const state = this.state(),
      steps = state.audited.journal.additional?.steps;
    const stage = steps?.["continue-review"].command ? "continue-review" : "execute";
    // A live capture must retain its owner/lease. On restart, only durably terminal or fully
    // validated generation evidence may close an unacknowledged attempt.
    if (
      !this.#owner?.service.retention().retainedCaptures &&
      steps?.[stage].command &&
      steps[stage].receipt === null &&
      state.checkpoint &&
      (state.status?.executionCompleted ||
        state.status?.generation?.lastConfirmed === "stopped" ||
        state.status?.review?.lastConfirmed === "stopped" ||
        (state.checkpoint.runRevision === 5 &&
          state.status?.generation?.lastConfirmed === "validated" &&
          state.status.review === null))
    )
      this.#journal.acknowledgeAdditional(stage, state.checkpoint);
    return this.inspect();
  }
  prepare() {
    this.open();
    if (this.#active) return fail();
    this.reconcile();
    this.#selection = Object.freeze(this.#preparation.prepare());
    return { ...this.#selection };
  }
  inspect() {
    this.open();
    const { audited, status } = this.state(),
      steps = audited.journal.additional?.steps;
    return {
      status,
      budget: {
        capUnits: audited.currentBudget.capUnits,
        recognizedUnits: audited.currentBudget.recognizedUnits,
        heldUnits: audited.currentBudget.heldUnits,
        currency: audited.currentBudget.currency,
        unitScale: audited.currentBudget.unitScale,
      },
      attemptRecorded: !!steps?.execute.command,
      continuationRecorded: !!steps?.["continue-review"].command,
      preparationComplete: !!steps?.["approve-transmission"].receipt,
      lifetime: this.#owner?.service.retention() ?? null,
      transmissionAllowed: false as const,
    };
  }
  execute() {
    return this.runOnce("execute");
  }
  continueReview() {
    return this.runOnce("continue-review");
  }
  private async runOnce(stage: "execute" | "continue-review") {
    this.open();
    if (this.#active || !this.#selection) return fail();
    this.reconcile();
    const state = this.state(),
      steps = state.audited.journal.additional?.steps;
    if (!steps || steps[stage].command !== null) return fail();
    if (
      stage === "continue-review" &&
      (!steps.execute.receipt ||
        state.checkpoint?.runRevision !== 5 ||
        state.status?.generation?.lastConfirmed !== "validated" ||
        state.status.review !== null)
    )
      return fail();
    // Persist one-shot intent before runtime installation. A restarted attempt never dispatches.
    this.#journal.prepareAdditional(stage, {
      selection: this.#selection,
      automaticRetryAllowed: false,
    });
    this.#active = true;
    try {
      const owner = this.owner();
      const view = await owner.service.execute(this.#selection);
      if (!owner.service.retention().retainedCaptures) {
        const checkpoint = this.state().checkpoint ?? fail();
        this.#journal.acknowledgeAdditional(stage, checkpoint);
      }
      return view;
    } finally {
      this.#active = false;
    }
  }
  recover() {
    this.open();
    if (this.#active || !this.#owner || !this.#selection) return fail();
    this.state(); // Complete files/DB audit before touching retained capture.
    const view = this.#owner.service.recover(this.#selection);
    this.reconcile();
    return view;
  }
  /** False requires keeping this process alive; no capture/active owner is abandoned. */
  close() {
    if (this.#closed) return true;
    const retained = this.#owner?.service.retention();
    if (this.#active || retained?.activeExecutions || retained?.retainedCaptures) return false;
    if (this.#owner) {
      revokeProviderProductionRuntime(this.#owner.runtime);
      this.#owner.store.close();
    }
    this.#store.close();
    this.#journal.close();
    this.#closed = true;
    return true;
  }
}
