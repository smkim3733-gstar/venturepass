import { z } from "zod";
const uuid = z.string().uuid(),
  integer = z.number().int().nonnegative().safe();
const units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const recordReference = z
  .object({
    clientRequestId: uuid,
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.string().datetime(),
  })
  .strict();
export const reservationHistorySchema = z
  .object({
    reservation: recordReference,
    cancellation: recordReference.extend({ releasedUnits: units }).nullable(),
    finalizedAt: z.string().datetime().nullable(),
  })
  .strict();
export const reservationViewSchema = z
  .object({
    kind: z.literal("comparison-reservation-view"),
    companyId: uuid,
    companyRevision: integer,
    inspectedAt: z.string().datetime(),
    input: z
      .object({
        status: z.enum([
          "not-configured",
          "unavailable",
          "other-company",
          "different-revision",
          "missing-reservation",
          "matched",
        ]),
        runId: uuid.nullable(),
      })
      .strict(),
    reservations: z
      .array(
        z
          .object({
            runId: uuid,
            companyRevision: integer,
            companyRevisionMatches: z.boolean(),
            createdAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
            reservationExpired: z.boolean(),
            model: z.string().min(1).max(200),
            sectionKey: z.string().min(1).max(200),
            sectionTitle: z.string().min(1).max(2000),
            currency: z.string().regex(/^[A-Z]{3}$/),
            unitScale: z.number().int().min(0).max(12),
            reservedUnits: units,
            latestEventKind: z.enum([
              "reserved",
              "dispatch-recorded",
              "dispatch-unknown",
              "cancelled",
              "response-captured",
              "comparison-recorded",
              "usage-assessed",
              "cost-settled",
              "finalized",
            ]),
            history: reservationHistorySchema,
          })
          .strict(),
      )
      .max(20),
    currentContextVerified: z.literal(false),
    policiesVerified: z.literal(false),
    transmissionAllowed: z.literal(false),
    consentRecorded: z.literal(false),
    runtimeObserved: z.literal(false),
  })
  .strict();
export type ReservationView = z.infer<typeof reservationViewSchema>;
export function decodeReservationView(value: unknown, company: { id: string; revision: number }) {
  const result = reservationViewSchema.parse(value),
    ids = new Set(result.reservations.map((r) => r.runId));
  const selected = result.reservations.find((r) => r.runId === result.input.runId);
  if (
    result.companyId !== company.id ||
    result.companyRevision !== company.revision ||
    ids.size !== result.reservations.length ||
    result.reservations.some(
      (r) =>
        r.companyRevisionMatches !== (r.companyRevision === company.revision) ||
        r.reservationExpired !== Date.parse(result.inspectedAt) >= Date.parse(r.expiresAt),
    ) ||
    result.reservations.some((r) => {
      const h = r.history,
        cancelled = h.cancellation;
      return (
        h.reservation.recordedAt !== r.createdAt ||
        Date.parse(r.createdAt) > Date.parse(result.inspectedAt) ||
        (r.latestEventKind === "finalized") !== (h.finalizedAt !== null) ||
        (h.finalizedAt !== null &&
          (Date.parse(h.finalizedAt) < Date.parse(r.createdAt) ||
            Date.parse(h.finalizedAt) > Date.parse(result.inspectedAt))) ||
        r.latestEventKind === "cancelled" ||
        !!(
          cancelled &&
          (cancelled.releasedUnits !== r.reservedUnits ||
            cancelled.recordedAt !== h.finalizedAt ||
            cancelled.clientRequestId === h.reservation.clientRequestId)
        )
      );
    }) ||
    (result.input.status === "matched" && (!selected || !selected.companyRevisionMatches)) ||
    (result.input.status === "missing-reservation" && (!result.input.runId || selected)) ||
    (!["matched", "missing-reservation"].includes(result.input.status) &&
      result.input.runId !== null)
  )
    throw Error("RESERVATION_VIEW_MISMATCH");
  return result;
}
