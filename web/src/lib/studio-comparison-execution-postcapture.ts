import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  comparisonCloseCommandSchema,
  comparisonResultCommandSchema,
} from "./studio-public-claim-comparison-postcapture";
import {
  comparisonPostcaptureDisplaySchema,
  comparisonPostcaptureOperationSchema,
} from "./studio-comparison-execution-wire";
import type { createComparisonProviderRuntime } from "./studio-comparison-provider-runtime";

type Runtime = Pick<
  ReturnType<typeof createComparisonProviderRuntime>,
  "previewPostcapture" | "writePostcapture" | "recoverPostcapture"
>;
type Operation = z.infer<typeof comparisonPostcaptureOperationSchema>;
type Preview = ReturnType<Runtime["previewPostcapture"]>;
type Display = z.infer<typeof comparisonPostcaptureDisplaySchema>;
type Attempt = {
  reviewDigest: string;
  command:
    z.infer<typeof comparisonResultCommandSchema> | z.infer<typeof comparisonCloseCommandSchema>;
  current: Record<string, string>;
  status: Display["record"];
};

/** Lives with the original dispatch owner. An uncertain write is followed only by
 * read/reconciliation of that exact command; never by another nonce or a new send. */
export function createComparisonExecutionPostcapture(
  runtime: Runtime,
  original: (recovery?: boolean) => { runId: string; dispatchCommandDigest: string },
  costs: () => { currency: string; unitScale: number },
) {
  let preview: { value: Preview; display: NonNullable<Display["review"]> } | undefined;
  const attempts = new Map<Operation, Attempt>();
  const inspect = (): Display =>
    structuredClone({
      record: attempts.get("record-result")?.status ?? "unattempted",
      settlement: attempts.get("settle-finalize")?.status ?? "unattempted",
      review: preview?.display ?? null,
    });
  function receive(operation: Operation, attempt: Attempt, recovery: boolean) {
    preview = undefined; // A write or uncertain recovery invalidates the displayed heads.
    attempt.status = "recovery-required";
    const receipt = recovery
      ? runtime.recoverPostcapture(operation, structuredClone(attempt.command))
      : runtime.writePostcapture(
          operation,
          structuredClone(attempt.command),
          structuredClone(attempt.current),
        );
    if (
      receipt.runId !== attempt.command.runId ||
      receipt.commandDigest !== digest(attempt.command)
    )
      throw Error("COMPARISON_POSTCAPTURE_RECEIPT_MISMATCH");
    if (receipt.status === "blocked") attempt.status = "blocked";
    else if (receipt.witnessMatched && ["committed", "replay"].includes(receipt.status))
      attempt.status = "stored";
    return inspect();
  }
  return Object.freeze({
    inspect,
    preview() {
      const selected = original();
      preview = undefined;
      if ([...attempts.values()].some((a) => a.status === "recovery-required"))
        throw Error("COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED");
      const value = runtime.previewPostcapture(selected);
      if (
        value.runId !== selected.runId ||
        value.dispatchCommandDigest !== selected.dispatchCommandDigest
      )
        throw Error("COMPARISON_POSTCAPTURE_SELECTION_CHANGED");
      const display = comparisonPostcaptureDisplaySchema.shape.review.unwrap().parse({
        reviewDigest: digest(value),
        comparisonState: value.comparisonState,
        comparisonRecorded: value.database.comparisonRecorded,
        costSettled: value.database.costSettled,
        finalized: value.database.finalized,
        usageStatus: value.usage.status,
        units: value.usage.assessment?.units ?? null,
        ...costs(),
        hasPolicyViolations: (value.usage.assessment?.violations.length ?? 0) > 0,
      });
      preview = { value: structuredClone(value), display };
      return inspect();
    },
    write(rawOperation: Operation, rawDigest: string) {
      original();
      const operation = comparisonPostcaptureOperationSchema.parse(rawOperation);
      const reviewDigest = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(rawDigest);
      const prior = attempts.get(operation);
      if (prior) {
        if (prior.reviewDigest !== reviewDigest)
          throw Error("COMPARISON_POSTCAPTURE_ORIGINAL_REVIEW_REQUIRED");
        return receive(operation, prior, true);
      }
      if (!preview || preview.display.reviewDigest !== reviewDigest)
        throw Error("COMPARISON_POSTCAPTURE_REVIEW_REQUIRED");
      const p = preview.value;
      if (
        operation === "record-result"
          ? p.database.comparisonRecorded
          : !p.database.comparisonRecorded ||
            p.database.costSettled ||
            p.database.finalized ||
            p.usage.status !== "known" ||
            !p.usage.assessment ||
            !p.usage.usagePolicyDigest ||
            !p.expectedAssessmentDigest
      )
        throw Error("COMPARISON_POSTCAPTURE_NOT_READY");
      const common = {
        commandVersion: 1,
        purpose: "compare-public-claim",
        clientRequestId: randomUUID(),
        runId: p.runId,
        transmissionBindingDigest: p.transmissionBindingDigest,
        dispatchEventDigest: p.dispatchEventDigest,
        responseArtifactSha256: p.responseArtifactSha256,
        expectedRunHead: p.expectedRunHead,
      };
      const command =
        operation === "record-result"
          ? comparisonResultCommandSchema.parse({
              ...common,
              kind: "record-public-comparison-result",
              responseArtifactByteLength: p.responseArtifactByteLength,
              expectedValidatedArtifactSha256: p.expectedValidatedArtifactSha256,
            })
          : comparisonCloseCommandSchema.parse({
              ...common,
              kind: "settle-finalize-public-comparison",
              comparisonEventDigest: p.comparisonEventDigest,
              usagePolicyDigest: p.usage.usagePolicyDigest,
              expectedAssessmentDigest: p.expectedAssessmentDigest,
              expectedBudgetHead: p.expectedBudgetHead,
            });
      const current: Record<string, string> =
        operation === "record-result"
          ? { at: new Date().toISOString(), eventId: randomUUID() }
          : {
              at: new Date().toISOString(),
              usageEventId: randomUUID(),
              usageNonce: randomUUID(),
              costEventId: randomUUID(),
              budgetEventId: randomUUID(),
              finalEventId: randomUUID(),
              finalizationNonce: randomUUID(),
            };
      const attempt: Attempt = { reviewDigest, command, current, status: "recovery-required" };
      attempts.set(operation, attempt); // Retain BEFORE entering any writer/commit.
      return receive(operation, attempt, false);
    },
    recover(rawOperation: Operation) {
      original(true);
      const operation = comparisonPostcaptureOperationSchema.parse(rawOperation),
        attempt = attempts.get(operation);
      if (!attempt) throw Error("COMPARISON_POSTCAPTURE_ORIGINAL_COMMAND_REQUIRED");
      return receive(operation, attempt, true);
    },
  });
}
