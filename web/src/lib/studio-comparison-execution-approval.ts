import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";
import { comparisonTransmissionBasisSchema } from "./studio-public-claim-comparison-transmission-types";
import { comparisonUsagePolicySchema } from "./studio-public-claim-comparison-usage";
import { comparisonDispatchV2CommandSchema } from "./studio-public-claim-comparison-transmission-v4";
import type { createComparisonProviderRuntime } from "./studio-comparison-provider-runtime";
import { comparisonExecutionConsentSchema } from "./studio-comparison-execution-wire";
import { createComparisonExecutionPostcapture } from "./studio-comparison-execution-postcapture";
export { comparisonExecutionConsentSchema } from "./studio-comparison-execution-wire";

type Runtime = Pick<
  ReturnType<typeof createComparisonProviderRuntime>,
  | "prepareTransmission"
  | "execute"
  | "recover"
  | "inspect"
  | "close"
  | "previewPostcapture"
  | "writePostcapture"
  | "recoverPostcapture"
>;
type Review = ReturnType<Runtime["prepareTransmission"]>["review"];
const selectionSchema = z
  .object({
    companyId: z.string().uuid(),
    companyRevision: z.number().int().nonnegative().safe(),
    runId: z.string().uuid(),
  })
  .strict();
export const comparisonExecutionSettingsSchema = selectionSchema
  .extend({
    basis: comparisonTransmissionBasisSchema,
    usagePolicy: comparisonUsagePolicySchema,
  })
  .strict();

/** Server composition for ONE already-reserved run. Policy comes from trusted server
 * configuration, never a request body. No reservation or consent is manufactured here.
 * Keep this owner (and its runtime) through HTTP disconnects, recovery and close retries.
 * HTTP open retains this owner; the constructor does no DB/network work. */
export function createComparisonExecutionApproval(runtime: Runtime, rawSettings: unknown) {
  assertPublicComparisonDataOnly(rawSettings, 128 * 1024);
  const settings = comparisonExecutionSettingsSchema.parse(rawSettings);
  const query = selectionSchema.parse({
    companyId: settings.companyId,
    companyRevision: settings.companyRevision,
    runId: settings.runId,
  });
  let review: Review | undefined;
  let financialCosts: { currency: string; unitScale: number } | undefined;
  let closing = false,
    closed = false;
  let attempt:
    | {
        consentDigest: string;
        command: z.infer<typeof comparisonDispatchV2CommandSchema>;
        context: {
          approvedReview: Review;
          basis: typeof settings.basis;
          usagePolicy: typeof settings.usagePolicy;
          at: string;
          eventId: string;
        };
      }
    | undefined;
  let running: ReturnType<Runtime["execute"]> | undefined;
  const selection = () =>
    attempt
      ? {
          runId: attempt.command.runId,
          dispatchCommandDigest: digest(attempt.command),
        }
      : null;
  const postcapture = createComparisonExecutionPostcapture(
    runtime,
    (recovery = false) => {
      const selected = selection();
      if (!selected || (closing && !recovery) || closed || running)
        throw Error("COMPARISON_APPROVAL_OWNER_REQUIRED");
      return selected;
    },
    () => {
      if (!financialCosts) throw Error("COMPARISON_APPROVAL_COSTS_REQUIRED");
      return financialCosts;
    },
  );
  const inspect = () =>
    Object.freeze({
      source: "comparison-execution-approval" as const,
      status: closed
        ? ("closed" as const)
        : closing
          ? ("draining" as const)
          : running
            ? ("running" as const)
            : attempt
              ? ("attempted" as const)
              : review
                ? ("reviewed" as const)
                : ("unused" as const),
      selection: selection(),
      reviewDigest: review?.reviewDigest ?? null,
      runtime: runtime.inspect(),
      postcapture: postcapture.inspect(),
      dispatchAllowed: false as const,
      runtimeObserved: false as const,
    });
  return Object.freeze({
    inspect,
    previewPostcapture: postcapture.preview,
    writePostcapture: postcapture.write,
    recoverPostcapture: postcapture.recover,
    preview() {
      if (closing || closed || attempt) throw Error("COMPARISON_APPROVAL_PREVIEW_CLOSED");
      // A failed refresh must invalidate the prior visible review as well.
      review = undefined;
      const prepared = runtime.prepareTransmission(
        query,
        settings.basis,
        settings.usagePolicy,
        new Date().toISOString(),
      );
      assertPublicComparisonDataOnly(prepared, 128 * 1024);
      const checked = prepared.review;
      if (
        checked.runId !== query.runId ||
        checked.request.selection.companyId !== query.companyId ||
        checked.request.selection.companyRevision !== query.companyRevision ||
        digest(checked.basis) !== digest(settings.basis) ||
        digest(checked.usagePolicy) !== digest(settings.usagePolicy)
      )
        throw Error("COMPARISON_APPROVAL_REVIEW_MISMATCH");
      review = structuredClone(checked);
      const costs = prepared.reservation.financialBasis?.costs;
      financialCosts = costs ? { currency: costs.currency, unitScale: costs.unitScale } : undefined;
      return structuredClone(prepared); // UI mutation cannot change the retained review.
    },
    execute(rawConsent: unknown) {
      if (closing || closed) throw Error("COMPARISON_APPROVAL_CLOSED");
      assertPublicComparisonDataOnly(rawConsent, 8192);
      const consent = comparisonExecutionConsentSchema.parse(rawConsent);
      const consentDigest = digest(consent);
      if (attempt && attempt.consentDigest !== consentDigest)
        throw Error("COMPARISON_APPROVAL_ORIGINAL_CONFIRMATION_REQUIRED");
      if (!attempt) {
        if (!review || consent.reviewDigest !== review.reviewDigest)
          throw Error("COMPARISON_APPROVAL_REVIEW_REQUIRED");
        const at = new Date().toISOString(),
          now = Date.parse(at);
        if (now < Date.parse(review.inspectedAt) || now >= Date.parse(review.expiresAt))
          throw Error("COMPARISON_APPROVAL_REVIEW_EXPIRED");
        const { clientRequestId, reviewDigest: _digest, ...acknowledgements } = consent;
        void _digest;
        const command = comparisonDispatchV2CommandSchema.parse({
          commandVersion: 2,
          kind: "approve-dispatch-public-claim-comparison",
          purpose: "compare-public-claim",
          clientRequestId,
          runId: review.runId,
          runDigest: review.runDigest,
          expectedReservationBindingDigest: review.reservationBindingDigest,
          approvedReviewDigest: review.reviewDigest,
          expectedTransmissionArchiveDigest: review.transmissionArchiveDigest,
          expectedCoverageDigest: review.coverageDigest,
          expectedRunHead: review.runHead,
          expectedBudgetHead: {
            revision: review.budget.revision,
            headDigest: review.budget.headDigest,
          },
          usagePolicyDigest: review.usagePolicyDigest,
          approval: {
            ...acknowledgements,
            noticeVersion: 1,
            noticeDigest: review.basis.notice.noticeDigest,
            retentionNoticeDigest: review.retentionNoticeDigest,
            exactRequestIdentityDigest: digest(review.identity),
            approvedAt: at,
            expiresAt: review.expiresAt,
          },
        });
        attempt = {
          consentDigest,
          command,
          context: {
            approvedReview: structuredClone(review),
            basis: structuredClone(settings.basis),
            usagePolicy: structuredClone(settings.usagePolicy),
            at,
            eventId: randomUUID(),
          },
        };
      }
      if (running) return running; // Same in-flight operation; never a second execution call.
      try {
        running = runtime.execute(
          structuredClone(attempt.command),
          structuredClone(attempt.context),
        );
      } catch (error) {
        running = Promise.reject(error);
      }
      const original = running;
      // Preserve exact command/time/event/nonce after failure. The SQL owner alone decides replay.
      void original.then(
        () => {
          if (running === original) running = undefined;
        },
        () => {
          if (running === original) running = undefined;
        },
      );
      return original;
    },
    recover() {
      const original = selection();
      if (!original || closed) throw Error("COMPARISON_APPROVAL_OWNER_REQUIRED");
      return runtime.recover(original);
    },
    close() {
      closing = true;
      if (!closed) closed = runtime.close().status === "closed";
      return inspect();
    },
  });
}
