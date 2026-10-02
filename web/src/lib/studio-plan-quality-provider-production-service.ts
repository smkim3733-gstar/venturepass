import "server-only";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import type { ProviderApprovedRunnerResult } from "./studio-plan-quality-provider-approved-runner";
import {
  providerProductionSelectionSchema,
  type ProviderProductionSelection,
  type ProviderProductionView,
} from "./studio-plan-quality-provider-production-service-types";
import {
  projectVersionedProviderProductionView,
  unavailableProviderProductionView,
} from "./studio-plan-quality-provider-production-view";

type Store = Pick<
  PlanQualityStore,
  | "providerResolveProductionIdentity"
  | "providerRunApprovedProduction"
  | "providerRecoverProductionGenerationCapture"
  | "providerRecoverProductionReviewCapture"
>;
const pending = (result: ProviderApprovedRunnerResult) =>
  !!(result.generation.pendingCapture || result.review?.pendingCapture);
const keyFor = (selection: ProviderProductionSelection) =>
  JSON.stringify([selection.runId, selection.runDigest, selection.approvalBindingDigest]);
export const providerProductionServiceCapacity = 8;

/** Explicit trusted server composition only. This constructor neither installs a runtime nor
 * looks up credentials/default stores. Retain this service instance across HTTP requests.
 * Pending captures stay only in private server memory. Never evict them to admit a new send.
 * Process exit loses that memory: persisted dispatch remains held for manual reconciliation.
 * This local busy guard does not replace the database's cross-process COMMIT ownership. */
export class ProviderProductionExecutionService {
  readonly #store: Store;
  readonly #captures = new Map<string, ProviderApprovedRunnerResult>();
  readonly #active = new Set<string>();
  constructor(store: Store) {
    this.#store = store;
  }
  /** Server lifetime bookkeeping only. No identities, captures or authority are exposed. */
  retention() {
    return Object.freeze({
      activeExecutions: this.#active.size,
      retainedCaptures: this.#captures.size,
    });
  }
  async execute(raw: unknown): Promise<ProviderProductionView> {
    const parsed = providerProductionSelectionSchema.safeParse(raw);
    if (!parsed.success) return unavailableProviderProductionView(null, "invalid-selection");
    const selection = parsed.data,
      key = keyFor(selection);
    if (this.#active.has(key))
      return unavailableProviderProductionView(selection, "execution-in-progress");
    const retained = this.#captures.get(key);
    if (retained) return this.#view(selection, retained);
    if (this.#captures.size + this.#active.size >= providerProductionServiceCapacity)
      return unavailableProviderProductionView(selection, "recovery-capacity-full");
    this.#active.add(key);
    try {
      const identity = this.#store.providerResolveProductionIdentity(selection);
      const result = await this.#store.providerRunApprovedProduction(identity);
      // Retain BEFORE projection/serialization. Even a projection failure cannot discard raw.
      if (pending(result)) this.#captures.set(key, result);
      return this.#view(selection, result);
    } catch {
      // Do not expose error messages, SDK causes, keys, request bodies or unconfirmed outcomes.
      return unavailableProviderProductionView(selection, "execution-unavailable");
    } finally {
      this.#active.delete(key);
    }
  }
  /** Explicit capture-only recovery. No client raw/nonce, SDK call or automatic review start. */
  recover(raw: unknown): ProviderProductionView {
    const parsed = providerProductionSelectionSchema.safeParse(raw);
    if (!parsed.success) return unavailableProviderProductionView(null, "invalid-selection");
    const selection = parsed.data,
      key = keyFor(selection);
    if (this.#active.has(key))
      return unavailableProviderProductionView(selection, "execution-in-progress");
    const retained = this.#captures.get(key);
    if (!retained) return unavailableProviderProductionView(selection, "capture-not-retained");
    this.#active.add(key);
    try {
      const generation = retained.generation.pendingCapture
        ? this.#store.providerRecoverProductionGenerationCapture(retained.generation.pendingCapture)
        : retained.generation;
      const review = retained.review?.pendingCapture
        ? this.#store.providerRecoverProductionReviewCapture(retained.review.pendingCapture)
        : retained.review;
      const result: ProviderApprovedRunnerResult = {
        generation,
        review,
        executionCompleted: review?.executionCompleted === true,
        automaticRetryAllowed: false,
      };
      if (pending(result)) this.#captures.set(key, result);
      else this.#captures.delete(key); // Store has confirmed capture persistence, not merely accepted input.
      return this.#view(selection, result);
    } catch {
      // Keep the identical capture so a failed recovery never becomes a fresh send.
      return this.#view(selection, retained, "capture-recovery-unconfirmed");
    } finally {
      this.#active.delete(key);
    }
  }
  #view(
    selection: ProviderProductionSelection,
    result: ProviderApprovedRunnerResult,
    reason: ProviderProductionView["reason"] = null,
  ) {
    try {
      const view = projectVersionedProviderProductionView(selection, result);
      return reason ? Object.freeze({ ...view, reason }) : view;
    } catch {
      return unavailableProviderProductionView(selection, "execution-unavailable");
    }
  }
}
