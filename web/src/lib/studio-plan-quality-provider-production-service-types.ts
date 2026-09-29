import { z } from "zod";

/** Public selection only. No transport configuration, credential, capture or phase nonce. */
export const providerProductionSelectionSchema = z
  .object({
    runId: z.string().uuid(),
    runDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvalBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProviderProductionSelection = z.infer<typeof providerProductionSelectionSchema>;
/** Read-only lookup can select an execution without supplying its approval binding. The server
 * resolves that binding from its audited archive; this input is never an execution command. */
export const providerProductionInspectionInputSchema = providerProductionSelectionSchema.pick({
  runId: true,
  runDigest: true,
});
export type ProviderProductionInspectionInput = z.infer<
  typeof providerProductionInspectionInputSchema
>;
const phaseSchema = z
  .object({
    lastConfirmed: z.enum([
      "none",
      "approved",
      "prepared",
      "dispatch-recorded",
      "response-recorded",
      "validated",
      "stopped",
      "completed",
    ]),
    response: z.enum(["not-observed", "unobserved", "captured-not-confirmed", "recorded"]),
    failureStage: z
      .enum(["dispatch", "response", "validation", "finalization", "stop", "history"])
      .nullable(),
    stopOutcome: z
      .enum([
        "before-dispatch",
        "result-unobserved",
        "needs-cost-review",
        "bound-breached",
        "output-invalid",
      ])
      .nullable(),
  })
  .strict();
/** Whitelist shared by the future HTTP/UI boundary; never serialize an internal runner result. */
export const providerProductionViewSchema = z
  .object({
    viewVersion: z.literal(1),
    selection: providerProductionSelectionSchema.nullable(),
    status: z.enum([
      "completed",
      "stopped",
      "capture-recovery-required",
      "last-confirmed",
      "unavailable",
    ]),
    reason: z
      .enum([
        "invalid-selection",
        "execution-unavailable",
        "execution-in-progress",
        "recovery-capacity-full",
        "capture-not-retained",
        "capture-recovery-unconfirmed",
      ])
      .nullable(),
    generation: phaseSchema.nullable(),
    review: phaseSchema.nullable(),
    lastAuditedRevision: z.number().int().min(1).max(10).nullable(),
    lastAuditedBudget: z.enum(["unsettled", "settled", "unconfirmed"]),
    recovery: z.enum(["server-capture", "reconcile-before-continuing", "none"]),
    executionCompleted: z.boolean(),
    automaticRetryAllowed: z.literal(false),
  })
  .strict()
  .superRefine((view, context) => {
    if (
      view.executionCompleted !== (view.status === "completed") ||
      (view.status !== "unavailable" && (!view.selection || !view.generation)) ||
      (view.status === "unavailable" &&
        (view.generation !== null || view.review !== null || !view.reason)) ||
      (view.executionCompleted &&
        (view.generation?.lastConfirmed !== "validated" ||
          view.generation.response !== "recorded" ||
          view.review?.lastConfirmed !== "completed" ||
          view.review.response !== "recorded" ||
          view.recovery !== "none")) ||
      (view.status === "capture-recovery-required") !== (view.recovery === "server-capture") ||
      (view.status === "capture-recovery-required" &&
        ![view.generation?.response, view.review?.response].includes("captured-not-confirmed"))
    )
      context.addIssue({ code: "custom", message: "실행 상태의 확인 근거가 일치하지 않습니다." });
  });
export type ProviderProductionView = z.infer<typeof providerProductionViewSchema>;
