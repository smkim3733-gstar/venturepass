import { z } from "zod";
import {
  providerProposalFinancialBasisSchema,
  providerProposalRetentionSchema,
  providerProposalUsagePolicySchema,
  providerRequestReviewSchema,
  versionedPolicyRequestSchema,
  providerReviewScopeSchema,
} from "./studio-plan-quality-provider-review-types";
import { providerPolicyReviewSchema } from "./studio-plan-quality-provider-policy-review-types";
import { providerPolicyAdoptionHeadSchema } from "./studio-plan-quality-provider-policy-adoption-command";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime();
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/);
export const providerTransmissionReviewLifetimeMs = 15 * 60 * 1000;
export const providerTransmissionReviewNotice =
  "이미 예약된 후보 한 건의 전송 범위를 검토합니다. 생성과 생성 결과로 구성할 검토 요청에는 별도 명시적 승인이 필요하며 이 조회로 승인·전송·비용 쓰기를 실행하지 않습니다.";
export const providerTransmissionReviewInputSchema = z
  .object({ runId: z.string().uuid(), runDigest: hash })
  .strict();
const reference = z
  .object({
    revision: z.number().int().min(1).max(100),
    recordDigest: hash,
    clientRequestId: z.string().uuid(),
    recordedAt: date,
  })
  .strict();

/** Browser-safe shape for the existing native v1 manifest; the server also validates it natively. */
export const providerTransmissionReviewManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runDigest: hash,
    preparationDigest: hash,
    executionContract: z
      .object({
        version: z.literal(1),
        mode: z.literal("provider"),
        requestContractDigest: hash,
        usagePolicy: providerProposalUsagePolicySchema,
        usagePolicyDigest: hash,
        responseSchemaVersion: z.literal(1),
        domainValidationVersion: z.literal(1),
        limits: z
          .object({
            requestBytes: z.literal(2097152),
            responseBytes: z.literal(4194304),
            validatedBytes: z.literal(2097152),
            finalBytes: z.literal(4194304),
            totalArtifactBytes: z.literal(20971520),
          })
          .strict(),
        maxCalls: z.literal(2),
        maxRetries: z.literal(0),
        contractDigest: hash,
      })
      .strict(),
    manifestDigest: hash,
  })
  .strict();
export const versionedProviderTransmissionReviewManifestSchema =
  providerTransmissionReviewManifestSchema.extend({
    schemaVersion: z.literal(2),
    executionContract: providerTransmissionReviewManifestSchema.shape.executionContract.extend({
      version: z.literal(2),
      engineVersion: z.literal("plan-observation-v2"),
      nativeRunFormat: z.literal(3),
    }),
  });
const blocker = z.enum([
  "policy-superseded",
  "run-not-reserved",
  "reservation-not-intact",
  "budget-incompatible",
  "budget-bound-breached",
]);
const factsSchema = z
  .object({
    policyUnchanged: z.boolean(),
    runUntouched: z.boolean(),
    reservationIntact: z.boolean(),
    budgetCompatible: z.boolean(),
    budgetWithinBound: z.boolean(),
  })
  .strict();
export function assessProviderTransmissionReview(facts: z.infer<typeof factsSchema>) {
  const blockers: z.infer<typeof blocker>[] = [];
  if (!facts.policyUnchanged) blockers.push("policy-superseded");
  if (!facts.runUntouched) blockers.push("run-not-reserved");
  if (!facts.reservationIntact) blockers.push("reservation-not-intact");
  if (!facts.budgetCompatible) blockers.push("budget-incompatible");
  if (!facts.budgetWithinBound) blockers.push("budget-bound-breached");
  return { state: blockers.length ? ("blocked" as const) : ("conditions-met" as const), blockers };
}
const transmissionReviewShape = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("provider-transmission-review"),
    environment: z.literal("production"),
    inputProvenance: z.literal("registered-synthetic-candidate"),
    scope: providerReviewScopeSchema,
    inspectedAt: date,
    expiresAt: date,
    archiveDigest: hash,
    coverageDigest: hash,
    configurationDigest: hash,
    run: z
      .object({
        id: z.string().uuid(),
        runDigest: hash,
        preparationDigest: hash,
        recordedAt: date,
        preparedAt: date,
        preparationExpiresAt: date,
        revision: z.number().int().min(0).max(1000),
        archiveFormatVersion: z.union([z.literal(2), z.literal(3)]),
        state: z.enum([
          "reserved",
          "cancelled-before-dispatch",
          "approved",
          "prepared",
          "dispatching",
          "response-recorded",
          "validated",
          "completed",
          "before-dispatch",
          "result-unobserved",
          "needs-cost-review",
          "output-invalid",
          "bound-breached",
        ]),
        snapshotDigest: hash,
      })
      .strict(),
    reservation: z
      .object({
        bindingDigest: hash,
        clientRequestId: z.string().uuid(),
        approvedReviewDigest: hash,
        reservationDigest: hash,
        generationUnits: units,
        reviewUnits: units,
        totalUnits: units,
        heldUnits: units,
        generationHeldUnits: units,
        reviewHeldUnits: units,
        generationSettled: z.boolean(),
        reviewSettled: z.boolean(),
      })
      .strict(),
    policy: z
      .object({
        head: providerPolicyAdoptionHeadSchema,
        reservedReference: reference,
        currentReference: reference.nullable(),
      })
      .strict(),
    budget: providerPolicyReviewSchema.shape.budget,
    request: providerRequestReviewSchema,
    financialBasis: providerProposalFinancialBasisSchema,
    retention: providerProposalRetentionSchema,
    manifest: providerTransmissionReviewManifestSchema,
    facts: factsSchema,
    assessment: z
      .object({ state: z.enum(["conditions-met", "blocked"]), blockers: z.array(blocker).max(5) })
      .strict(),
    accountAccess: z.literal("not-checked"),
    actions: z
      .object({
        approvalWriteAllowed: z.literal(false),
        dispatchAllowed: z.literal(false),
        budgetWriteAllowed: z.literal(false),
      })
      .strict(),
    nextStep: z.literal("separate-transmission-approval-required"),
    notice: z.literal(providerTransmissionReviewNotice),
    reviewDigest: hash,
  })
  .strict();
const versionedTransmissionReviewShape = transmissionReviewShape.extend({
  schemaVersion: z.literal(2),
  run: transmissionReviewShape.shape.run.extend({ archiveFormatVersion: z.literal(4) }),
  request: versionedPolicyRequestSchema.extend({
    contract: versionedPolicyRequestSchema.shape.contract.extend({
      baseContract: versionedPolicyRequestSchema.shape.contract.shape.baseContract.extend({
        engineVersion: z.literal("plan-observation-v2"),
      }),
    }),
  }),
  manifest: versionedProviderTransmissionReviewManifestSchema,
  tokenAssessment: z
    .object({
      basis: z.literal("financial-reservation-only"),
      actualTokenCountMeasured: z.literal(false),
      contextFitVerified: z.literal(false),
    })
    .strict(),
});
function validateTransmissionReview(
  v: z.infer<typeof transmissionReviewShape> | z.infer<typeof versionedTransmissionReviewShape>,
  context: z.RefinementCtx,
  versioned: boolean,
) {
  const fail = () =>
    context.addIssue({ code: "custom", message: "전송 검토 근거가 일치하지 않습니다." });
  const now = Date.parse(v.inspectedAt),
    end = Date.parse(v.expiresAt),
    p = v.policy;
  if (
    end <= now ||
    end - now > providerTransmissionReviewLifetimeMs ||
    Date.parse(v.run.preparedAt) > Date.parse(v.run.recordedAt) ||
    Date.parse(v.run.recordedAt) > now ||
    end > Date.parse(v.run.preparationExpiresAt) ||
    end > Date.parse(v.retention.validUntil) ||
    end > Date.parse(v.manifest.executionContract.usagePolicy.authority.validUntil)
  )
    fail();
  for (const r of [p.reservedReference, p.currentReference]) {
    if (
      r &&
      (r.revision > p.head.revision ||
        Date.parse(r.recordedAt) > now ||
        (r.revision === p.head.revision && r.recordDigest !== p.head.headDigest))
    )
      fail();
  }
  const expectedPolicy =
    p.currentReference !== null &&
    p.currentReference.revision === p.reservedReference.revision &&
    p.currentReference.recordDigest === p.reservedReference.recordDigest;
  const expectedRun =
    v.run.archiveFormatVersion === (versioned ? 4 : 2) &&
    v.run.revision === 0 &&
    v.run.state === "reserved";
  if (v.facts.policyUnchanged !== expectedPolicy || v.facts.runUntouched !== expectedRun) fail();
  if (JSON.stringify(v.assessment) !== JSON.stringify(assessProviderTransmissionReview(v.facts)))
    fail();
  const request = v.request,
    c = v.manifest.executionContract,
    b = v.budget,
    r = v.reservation;
  if (
    request.scope.version !== v.scope.version ||
    request.scope.versionDigest !== v.scope.versionDigest ||
    request.scope.candidateId !== v.scope.candidateId ||
    request.scope.sourceDigest !== v.scope.sourceDigest ||
    request.scope.candidateDigest !== v.scope.candidateDigest ||
    request.scope.modelInputDigest !== v.scope.modelInputDigest ||
    v.manifest.runDigest !== v.run.runDigest ||
    v.manifest.preparationDigest !== v.run.preparationDigest ||
    c.requestContractDigest !== request.contract.contractDigest ||
    c.usagePolicy.configuredModel !== request.model ||
    v.financialBasis.model !== request.model ||
    v.financialBasis.calculatedAt !== v.run.preparedAt
  )
    fail();
  const money = [
    b.capUnits,
    b.heldUnits,
    b.recognizedUnits,
    b.availableUnits,
    b.deficitUnits,
    ...Object.entries(r)
      .filter(([k]) => k.endsWith("Units"))
      .map(([, amount]) => amount),
  ];
  if (money.some((amount) => !units.safeParse(amount).success)) return;
  const exposure = BigInt(b.heldUnits) + BigInt(b.recognizedUnits),
    cap = BigInt(b.capUnits);
  const costs = v.financialBasis.costs;
  if (
    b.revision < 1 ||
    !b.headDigest ||
    !b.currency ||
    b.unitScale === null ||
    BigInt(b.availableUnits) !== (cap > exposure ? cap - exposure : BigInt(0)) ||
    BigInt(b.deficitUnits) !== (exposure > cap ? exposure - cap : BigInt(0)) ||
    BigInt(r.totalUnits) !== BigInt(r.generationUnits) + BigInt(r.reviewUnits) ||
    BigInt(r.heldUnits) !== BigInt(r.generationHeldUnits) + BigInt(r.reviewHeldUnits) ||
    BigInt(r.heldUnits) > BigInt(b.heldUnits) ||
    r.generationUnits !== costs.generation.totalUnits ||
    r.reviewUnits !== costs.review.totalUnits ||
    r.totalUnits !== costs.totalUnits ||
    v.facts.reservationIntact !==
      (!r.generationSettled &&
        !r.reviewSettled &&
        r.generationHeldUnits === r.generationUnits &&
        r.reviewHeldUnits === r.reviewUnits) ||
    v.facts.budgetCompatible !==
      (b.currency === costs.currency && b.unitScale === costs.unitScale) ||
    v.facts.budgetWithinBound !== (!b.boundBreached && b.deficitUnits === "0")
  )
    fail();
}
export const providerTransmissionReviewSchema = transmissionReviewShape.superRefine((v, context) =>
  validateTransmissionReview(v, context, false),
);
export const versionedProviderTransmissionReviewSchema =
  versionedTransmissionReviewShape.superRefine((v, context) =>
    validateTransmissionReview(v, context, true),
  );
export type VersionedProviderTransmissionReview = z.infer<
  typeof versionedProviderTransmissionReviewSchema
>;
export type StoredProviderTransmissionReview =
  ProviderTransmissionReview | VersionedProviderTransmissionReview;
export type ProviderTransmissionReview = z.infer<typeof providerTransmissionReviewSchema>;
export function providerTransmissionReviewDigestInput(
  value: Omit<StoredProviderTransmissionReview, "reviewDigest"> | StoredProviderTransmissionReview,
) {
  const { reviewDigest: ignored, ...body } = value as StoredProviderTransmissionReview;
  void ignored;
  return body;
}
