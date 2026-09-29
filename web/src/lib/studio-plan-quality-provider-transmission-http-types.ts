import { z } from "zod";
import {
  providerTransmissionReviewInputSchema,
  providerTransmissionReviewSchema,
} from "./studio-plan-quality-provider-transmission-review-types";

export const providerTransmissionHttpLimits = { bodyBytes: 4096 } as const;
/** Read-only browser envelope. Neither a transmission command nor an approval receipt. */
export const providerTransmissionInspectionResponseSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        responseVersion: z.literal(1),
        status: z.literal("review"),
        selection: providerTransmissionReviewInputSchema,
        review: providerTransmissionReviewSchema,
      })
      .strict(),
    z
      .object({
        responseVersion: z.literal(1),
        status: z.literal("unavailable"),
        selection: providerTransmissionReviewInputSchema,
        reason: z.enum([
          "configuration-missing-or-invalid",
          "configuration-expired",
          "configuration-changed",
          "selection-invalid",
          "archive-after-inspection",
          "production-reservation-required",
          "reservation-binding-required",
          "reservation-expired",
          "preparation-changed",
        ]),
        review: z.null(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.status !== "review") return;
    if (
      value.review.run.id !== value.selection.runId ||
      value.review.run.runDigest !== value.selection.runDigest
    )
      context.addIssue({
        code: "custom",
        message: "전송 검토와 선택한 예약 실행이 일치하지 않습니다.",
      });
  });
export type ProviderTransmissionInspectionResponse = z.infer<
  typeof providerTransmissionInspectionResponseSchema
>;

/** Expected state conflicts are different from a completed read with missing/expired settings. */
export function providerTransmissionInspectionStatus(
  value: ProviderTransmissionInspectionResponse,
) {
  if (value.status === "review") return 200;
  switch (value.reason) {
    case "configuration-missing-or-invalid":
    case "configuration-expired":
      return 200;
    default:
      return 409;
  }
}
