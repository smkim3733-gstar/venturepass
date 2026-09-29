import { z } from "zod";
import { providerReservationCommandSchema } from "./studio-plan-quality-provider-reservation-command";
import { providerReservationReviewSchema } from "./studio-plan-quality-provider-reservation-review-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();

/** Shape shared with a frozen native reader. A valid shape/hash is not a committed approval. */
export const providerReservationBindingSchema = z
  .object({
    recordVersion: z.literal(1),
    kind: z.literal("provider-reservation-policy-binding"),
    clientRequestId: uuid,
    command: providerReservationCommandSchema,
    commandDigest: hash,
    approvedReview: providerReservationReviewSchema,
    runId: uuid,
    runDigest: hash,
    startInputDigest: hash,
    recordedAt: z.string().datetime(),
    dispatchAllowed: z.literal(false),
    recordDigest: hash,
  })
  .strict();
export type ProviderReservationBinding = z.infer<typeof providerReservationBindingSchema>;

/** Immutable migration boundary, not an allowlist that grows with new production reservations. */
export const providerReservationCoverageSchema = z
  .object({
    coverageVersion: z.literal(1),
    kind: z.literal("provider-reservation-binding-coverage"),
    cutoverGlobalRunCount: z.number().int().min(0).max(20),
    cutoverRunPrefixDigest: hash,
    legacyProductionRuns: z.array(z.object({ runId: uuid, runDigest: hash }).strict()).max(20),
    coverageDigest: hash,
  })
  .strict();
export type ProviderReservationCoverage = z.infer<typeof providerReservationCoverageSchema>;
