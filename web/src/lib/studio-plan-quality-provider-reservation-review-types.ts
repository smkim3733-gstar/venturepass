import { z } from "zod";
import { providerPolicyReviewSchema } from "./studio-plan-quality-provider-policy-review-types";
import { providerPolicyAdoptionHeadSchema } from "./studio-plan-quality-provider-policy-adoption-command";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const providerReservationReviewNotice =
  "채택 정책과 현재 누적 예산을 대조한 예약 검토입니다. 별도의 예약 명령과 전송 승인이 필요하며 비용 예약·AI 전송은 실행되지 않습니다.";
const policySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-adopted"), reference: z.null() }).strict(),
  z
    .object({
      state: z.enum(["matched", "changed"]),
      reference: z
        .object({
          revision: z.number().int().min(1).max(100),
          recordDigest: hash,
          clientRequestId: z.string().uuid(),
          recordedAt: z.string().datetime(),
        })
        .strict(),
    })
    .strict(),
]);
const runsSchema = z
  .object({
    globalCount: z.number().int().min(0).max(20),
    productionCount: z.number().int().min(0).max(20),
    unsettledCandidateRunIds: z.array(z.string().uuid()).max(20),
  })
  .strict();
const blockerSchema = z.enum([
  "policy-not-adopted",
  "policy-changed",
  "budget-not-configured",
  "budget-insufficient",
  "budget-incompatible",
  "budget-bound-breached",
  "candidate-unsettled",
  "run-limit",
]);
type Blocker = z.infer<typeof blockerSchema>;
export function assessProviderReservationReview(
  policy: z.infer<typeof policySchema>,
  budgetState: z.infer<typeof providerPolicyReviewSchema>["assessment"]["state"],
  runs: z.infer<typeof runsSchema>,
) {
  const blockers: Blocker[] = [];
  if (policy.state !== "matched")
    blockers.push(policy.state === "not-adopted" ? "policy-not-adopted" : "policy-changed");
  if (budgetState !== "budget-configured") blockers.push(budgetState);
  if (runs.unsettledCandidateRunIds.length) blockers.push("candidate-unsettled");
  if (runs.globalCount >= 20) blockers.push("run-limit");
  return { state: blockers.length ? ("blocked" as const) : ("conditions-met" as const), blockers };
}

/** Browser-safe description only. Neither shape validation nor a digest grants execution rights. */
export const providerReservationReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("provider-reservation-review"),
    policyReview: providerPolicyReviewSchema,
    ledgerDigest: hash,
    policyHead: providerPolicyAdoptionHeadSchema,
    policy: policySchema,
    runs: runsSchema,
    assessment: z
      .object({
        state: z.enum(["conditions-met", "blocked"]),
        blockers: z.array(blockerSchema).max(8),
      })
      .strict(),
    nextStep: z.literal("separate-reservation-command-required"),
    actions: z
      .object({
        reservationAllowed: z.literal(false),
        dispatchAllowed: z.literal(false),
        budgetWriteAllowed: z.literal(false),
      })
      .strict(),
    notice: z.literal(providerReservationReviewNotice),
    reviewDigest: hash,
  })
  .strict()
  .superRefine((value, context) => {
    const fail = () =>
      context.addIssue({ code: "custom", message: "예약 검토 근거가 일치하지 않습니다." });
    const expected = assessProviderReservationReview(
      value.policy,
      value.policyReview.assessment.state,
      value.runs,
    );
    if (JSON.stringify(expected) !== JSON.stringify(value.assessment)) fail();
    if (
      value.runs.productionCount > value.runs.globalCount ||
      value.runs.unsettledCandidateRunIds.length > value.runs.productionCount ||
      new Set(value.runs.unsettledCandidateRunIds).size !==
        value.runs.unsettledCandidateRunIds.length
    )
      fail();
    const reference = value.policy.reference;
    if (
      reference &&
      (reference.revision > value.policyHead.revision ||
        Date.parse(reference.recordedAt) > Date.parse(value.policyReview.inspectedAt) ||
        (reference.revision === value.policyHead.revision &&
          reference.recordDigest !== value.policyHead.headDigest))
    )
      fail();
  });
export type ProviderReservationReview = z.infer<typeof providerReservationReviewSchema>;
export function providerReservationReviewDigestInput(
  value: Omit<ProviderReservationReview, "reviewDigest"> | ProviderReservationReview,
) {
  const { reviewDigest: _ignored, ...body } = value as ProviderReservationReview;
  void _ignored;
  return body;
}
