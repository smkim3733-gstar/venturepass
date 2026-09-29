import "server-only";
import { resolve } from "node:path";
import { z } from "zod";
import {
  acquireValidationJournal,
  inspectValidationJournal,
  type ValidationJournal,
  type ValidationProfile,
} from "../../scripts/operational-validation-journal.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { PlanQualityStore } from "./studio-plan-quality-store";
import { OperationalValidationPreparation } from "./studio-operational-validation-preparation";
import {
  installProviderProductionServer,
  inspectProviderProductionServer,
  retireProviderProductionServer,
  executeProviderProductionSelection,
  recoverProviderProductionSelection,
} from "./studio-plan-quality-provider-production-server";
import {
  providerProductionSelectionSchema,
  type ProviderProductionSelection,
} from "./studio-plan-quality-provider-production-service-types";

const attemptSchema = z
  .object({ selection: providerProductionSelectionSchema, automaticRetryAllowed: z.literal(false) })
  .strict();
const fail = (): never => {
  throw Error("VALIDATION_EXECUTION_UNAVAILABLE");
};
/** Dedicated local process only; caller sets the fixed directory and loads its key explicitly.
 * This owner/lease must remain alive until both active work and retained captures are drained. */
export class OperationalValidationSession {
  readonly #journal: ValidationJournal;
  readonly #store: PlanQualityStore;
  readonly #preparation: OperationalValidationPreparation;
  #selection: ProviderProductionSelection | null = null;
  #ownsServer = false;
  #active = false;
  #closed = false;
  constructor(profile: ValidationProfile) {
    if (
      !process.env.VENTURE_DATA_DIR ||
      resolve(process.env.VENTURE_DATA_DIR) !== resolve(profile.directory)
    )
      fail();
    const before = inspectValidationJournal(profile);
    if (before.state === "blocked") fail();
    this.#journal = acquireValidationJournal(profile);
    try {
      if (before.state === "virgin")
        this.#journal.initialize((directory) => new PlanQualityStore(directory).close());
      // File identity is checked before the constructor can create/migrate anything.
      this.#journal.readStep("register");
      this.#store = new PlanQualityStore(profile.directory);
      this.#preparation = new OperationalValidationPreparation(this.#store, this.#journal);
    } catch (error) {
      this.#journal.close();
      throw error;
    }
  }
  prepare() {
    if (this.#closed || this.#active) return fail();
    this.#selection = this.#preparation.prepare();
    if (this.#journal.readStep("execute").command !== null) this.inspect();
    return this.#selection;
  }
  recoverPolicy() {
    if (this.#closed || this.#active || this.#ownsServer || this.#selection) return fail();
    return this.#preparation.recoverPolicy();
  }
  private checkpoint(state = this.#preparation.audit()) {
    const { budget, run } = state;
    if (!run) return fail();
    return {
      runRevision: run.revision,
      snapshotDigest: run.snapshotDigest,
      budgetRevision: budget.revision,
      budgetHeadDigest: budget.headDigest,
      recognizedUnits: budget.recognizedUnits,
      heldUnits: budget.heldUnits,
    };
  }
  inspect() {
    if (this.#closed) return fail();
    const state = this.#preparation.audit();
    const continuation = this.#journal.readStep("continue-review");
    const attempt =
      continuation.command !== null ? continuation : this.#journal.readStep("execute");
    if (attempt.command !== null) {
      const saved = attemptSchema.parse(attempt.command);
      if (
        !state.approval ||
        digest(saved.selection) !==
          digest({
            runId: state.approval.runId,
            runDigest: state.approval.runDigest,
            approvalBindingDigest: state.approval.recordDigest,
          })
      )
        return fail();
      if (attempt.receipt !== null && digest(attempt.receipt) !== digest(this.checkpoint(state)))
        return fail();
    }
    return {
      status: state.approval
        ? this.#store.providerProductionStatus({
            runId: state.approval.runId,
            runDigest: state.approval.runDigest,
          })
        : null,
      budget: {
        capUnits: state.budget.capUnits,
        recognizedUnits: state.budget.recognizedUnits,
        heldUnits: state.budget.heldUnits,
        currency: state.budget.currency,
        unitScale: state.budget.unitScale,
      },
      attemptRecorded: attempt.command !== null,
      lifetime: this.#ownsServer ? inspectProviderProductionServer() : null,
    };
  }
  async execute() {
    return this.runOnce("execute");
  }
  async continueReview() {
    return this.runOnce("continue-review");
  }
  private async runOnce(stage: "execute" | "continue-review") {
    if (this.#closed || this.#active || !this.#selection) return fail();
    const inspected = this.inspect();
    // Persist a one-shot attempt BEFORE runtime installation/dispatch. A restarted process,
    // even with a rolled-back approved DB, may inspect/reconcile but never sends it again.
    if (this.#journal.readStep(stage).command !== null) return fail();
    if (
      stage === "continue-review" &&
      (this.#journal.readStep("execute").receipt === null ||
        inspected.status?.lastAuditedRevision !== 5 ||
        inspected.status.generation?.lastConfirmed !== "validated" ||
        inspected.status.review !== null)
    )
      return fail();
    const prior = inspectProviderProductionServer();
    if (!this.#ownsServer && prior.status !== "not-installed" && prior.status !== "closed")
      return fail();
    this.#journal.prepare(stage, { selection: this.#selection, automaticRetryAllowed: false });
    this.#active = true;
    try {
      if (!this.#ownsServer) {
        installProviderProductionServer();
        this.#ownsServer = true;
      }
      const view = await executeProviderProductionSelection(this.#selection);
      if (inspectProviderProductionServer().retainedCaptures === 0)
        this.#journal.acknowledge(stage, this.checkpoint());
      return view;
    } finally {
      this.#active = false;
    }
  }
  recover() {
    if (this.#closed || this.#active || !this.#ownsServer || !this.#selection) return fail();
    this.inspect();
    const view = recoverProviderProductionSelection(this.#selection);
    const stage =
      this.#journal.readStep("continue-review").command !== null ? "continue-review" : "execute";
    if (
      inspectProviderProductionServer().retainedCaptures === 0 &&
      this.#journal.readStep(stage).receipt === null
    )
      this.#journal.acknowledge(stage, this.checkpoint());
    return view;
  }
  /** False means the caller MUST keep the process/event loop alive. No capture is abandoned. */
  close() {
    if (this.#closed) return true;
    if (this.#active) return false;
    if (this.#ownsServer) {
      const state = inspectProviderProductionServer();
      if (state.activeExecutions || state.retainedCaptures) return false;
      if (retireProviderProductionServer().status !== "closed") return false;
    }
    this.#store.close();
    this.#journal.close();
    this.#closed = true;
    return true;
  }
}
