import { z } from "zod";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import {
  providerTransmissionReviewSchema,
  versionedProviderTransmissionReviewSchema,
} from "./studio-plan-quality-provider-transmission-review-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Shape shared with the frozen native reader; alone it proves neither storage nor consent. */
export const providerTransmissionApprovalBindingSchema = z
  .object({
    recordVersion: z.literal(1),
    kind: z.literal("provider-transmission-approval-binding"),
    clientRequestId: z.string().uuid(),
    command: providerTransmissionCommandSchema,
    commandDigest: hash,
    approvedReview: providerTransmissionReviewSchema,
    runId: z.string().uuid(),
    runDigest: hash,
    executionInputDigest: hash,
    approvalEventDigest: hash,
    approvalRevision: z.literal(1),
    recordedAt: z.string().datetime(),
    dispatchAllowed: z.literal(false),
    recordDigest: hash,
  })
  .strict();
export type ProviderTransmissionApprovalBinding = z.infer<
  typeof providerTransmissionApprovalBindingSchema
>;

/** Separate v2 record. The command still binds exact review/request digests, not a client version. */
export const versionedProviderTransmissionApprovalBindingSchema =
  providerTransmissionApprovalBindingSchema.extend({
    recordVersion: z.literal(2),
    approvedReview: versionedProviderTransmissionReviewSchema,
  });
export type VersionedProviderTransmissionApprovalBinding = z.infer<
  typeof versionedProviderTransmissionApprovalBindingSchema
>;
export type StoredProviderTransmissionApprovalBinding =
  ProviderTransmissionApprovalBinding | VersionedProviderTransmissionApprovalBinding;

/** Migration-only event prefixes. An existing reserved run is NOT exempt from later bindings.
 * Receipts are read by nonce, so their array position cannot identify an insertion boundary. */
export const providerTransmissionApprovalCoverageSchema = z
  .object({
    coverageVersion: z.literal(1),
    kind: z.literal("provider-transmission-approval-coverage"),
    cutoverGlobalRunCount: z.number().int().min(0).max(20),
    cutoverRunPrefixDigest: hash,
    cutoverProviderEvents: z
      .array(
        z
          .object({
            runId: z.string().uuid(),
            runDigest: hash,
            eventCount: z.number().int().min(0).max(32),
            eventPrefixDigest: hash,
          })
          .strict(),
      )
      .max(20),
    legacyProductionApprovals: z
      .array(
        z
          .object({
            runId: z.string().uuid(),
            approvalEventDigest: hash,
            clientRequestId: z.string().uuid(),
            executionInputDigest: hash,
          })
          .strict(),
      )
      .max(20),
    coverageDigest: hash,
  })
  .strict();
export type ProviderTransmissionApprovalCoverage = z.infer<
  typeof providerTransmissionApprovalCoverageSchema
>;
