import { z } from "zod";
import {
  providerProposedBudgetSchema,
  providerReviewScopeSchema,
} from "./studio-plan-quality-provider-review-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/);
const date = z.string().datetime();
export const providerPolicyReviewLifetimeMs = 15 * 60 * 1000;
export const providerPolicyReviewNotice =
  "운영 정책과 누적 예산의 검토 자료입니다. 정책 채택·예산 설정·비용 예약·AI 전송은 실행되지 않습니다.";

export const providerPolicyBudgetHeadSchema = z
  .object({ revision: z.number().int().min(0).max(1000), headDigest: hash.nullable() })
  .strict()
  .refine((value) => (value.revision === 0) === (value.headDigest === null));

const budgetSchema = z
  .object({
    scopeId: z.literal("candidate-quality-provider-v2-live"),
    revision: z.number().int().min(0).max(1000),
    headDigest: hash.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    unitScale: z.number().int().min(0).max(12).nullable(),
    capUnits: units,
    heldUnits: units,
    recognizedUnits: units,
    availableUnits: units,
    deficitUnits: units,
    boundBreached: z.boolean(),
  })
  .strict();
type PolicyBudget = z.infer<typeof budgetSchema>;
type ProposedBudget = z.infer<typeof providerProposedBudgetSchema>;

export function assessProviderPolicyBudget(
  budget: PolicyBudget,
  proposedBudget: ProposedBudget,
  reservationUnits: string,
) {
  const configured = budget.revision > 0;
  if (
    configured &&
    (budget.currency !== proposedBudget.currency || budget.unitScale !== proposedBudget.unitScale)
  )
    return {
      state: "budget-incompatible" as const,
      basis: "incompatible" as const,
      availableBeforeReservationUnits: null,
      availableAfterReservationUnits: null,
      shortfallUnits: null,
    };
  const available = BigInt(configured ? budget.availableUnits : proposedBudget.capUnits);
  const requested = BigInt(reservationUnits);
  return {
    state: !configured
      ? ("budget-not-configured" as const)
      : budget.boundBreached
        ? ("budget-bound-breached" as const)
        : available < requested
          ? ("budget-insufficient" as const)
          : ("budget-configured" as const),
    basis: configured ? ("existing-budget" as const) : ("unapproved-proposal" as const),
    availableBeforeReservationUnits: available.toString(),
    availableAfterReservationUnits: (available > requested
      ? available - requested
      : BigInt(0)
    ).toString(),
    shortfallUnits: (requested > available ? requested - available : BigInt(0)).toString(),
  };
}

export const providerPolicyReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("provider-policy-review"),
    environment: z.literal("production"),
    inputProvenance: z.literal("registered-synthetic-candidate"),
    scope: providerReviewScopeSchema,
    inspectedAt: date,
    expiresAt: date,
    bindings: z
      .object({
        configurationDigest: hash,
        requestReviewDigest: hash,
        financialBasisDigest: hash,
        retentionDigest: hash,
        usagePolicyDigest: hash,
        model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
      })
      .strict(),
    budget: budgetSchema,
    proposedBudget: providerProposedBudgetSchema,
    reservation: z
      .object({ generationUnits: units, reviewUnits: units, totalUnits: units })
      .strict(),
    assessment: z
      .object({
        state: z.enum([
          "budget-not-configured",
          "budget-configured",
          "budget-insufficient",
          "budget-incompatible",
          "budget-bound-breached",
        ]),
        basis: z.enum(["existing-budget", "unapproved-proposal", "incompatible"]),
        availableBeforeReservationUnits: units.nullable(),
        availableAfterReservationUnits: units.nullable(),
        shortfallUnits: units.nullable(),
      })
      .strict(),
    accountAccess: z.literal("not-checked"),
    actions: z
      .object({
        policyAdoptionAllowed: z.literal(false),
        budgetWriteAllowed: z.literal(false),
        reservationAllowed: z.literal(false),
        dispatchAllowed: z.literal(false),
      })
      .strict(),
    notice: z.literal(providerPolicyReviewNotice),
    reviewDigest: hash,
  })
  .strict()
  .superRefine((value, context) => {
    const fail = () =>
      context.addIssue({ code: "custom", message: "운영 정책 검토 값이 일치하지 않습니다." });
    const duration = Date.parse(value.expiresAt) - Date.parse(value.inspectedAt);
    if (duration <= 0 || duration > providerPolicyReviewLifetimeMs) fail();
    const b = value.budget;
    // String-format issues need not abort Zod refinements; never pass malformed units to BigInt.
    if (
      [
        b.capUnits,
        b.heldUnits,
        b.recognizedUnits,
        b.availableUnits,
        b.deficitUnits,
        value.proposedBudget.capUnits,
        ...Object.values(value.reservation),
      ].some((value) => !units.safeParse(value).success)
    )
      return;
    const exposure = BigInt(b.heldUnits) + BigInt(b.recognizedUnits);
    const cap = BigInt(b.capUnits);
    if (
      !providerPolicyBudgetHeadSchema.safeParse({ revision: b.revision, headDigest: b.headDigest })
        .success ||
      BigInt(b.availableUnits) !== (cap > exposure ? cap - exposure : BigInt(0)) ||
      BigInt(b.deficitUnits) !== (exposure > cap ? exposure - cap : BigInt(0)) ||
      (exposure > cap && !b.boundBreached)
    )
      fail();
    if (b.revision === 0) {
      if (
        b.currency !== null ||
        b.unitScale !== null ||
        cap !== BigInt(0) ||
        exposure !== BigInt(0) ||
        b.boundBreached
      )
        fail();
    } else if (b.currency === null || b.unitScale === null) fail();
    if (
      BigInt(value.reservation.totalUnits) !==
        BigInt(value.reservation.generationUnits) + BigInt(value.reservation.reviewUnits) ||
      BigInt(value.reservation.totalUnits) > BigInt(value.proposedBudget.capUnits)
    )
      fail();
    const expected = assessProviderPolicyBudget(
      b,
      value.proposedBudget,
      value.reservation.totalUnits,
    );
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      if (value.assessment[key] !== expected[key]) fail();
    }
  });

export type ProviderPolicyReview = z.infer<typeof providerPolicyReviewSchema>;
export function providerPolicyReviewDigestInput(
  value: Omit<ProviderPolicyReview, "reviewDigest"> | ProviderPolicyReview,
) {
  const { reviewDigest: _ignored, ...body } = value as ProviderPolicyReview;
  void _ignored;
  return body;
}
