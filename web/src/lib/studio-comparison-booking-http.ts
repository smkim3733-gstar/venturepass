import "server-only";
import { z } from "zod";
import { assertLocalRequest, jsonResponse } from "./studio-http";
import {
  bookingActionSchema,
  bookingReviewSchema,
  bookingStateSchema,
  type BookingSelection,
} from "./studio-comparison-booking-wire";
import { canonicalSelectionValue as canonical } from "./studio-candidate-selection-types";
import { createComparisonReviewBodyIO } from "./studio-public-claim-comparison-review-body";
import { ComparisonReviewReceiveError } from "./studio-public-claim-comparison-review-wire";
import type { createComparisonReservationBooking } from "./studio-comparison-reservation-booking";
type Owner = ReturnType<typeof createComparisonReservationBooking>;
type IO = ReturnType<typeof createComparisonReviewBodyIO<Response>>;
const fault = (code: string, status = 409) =>
  jsonResponse({ kind: "comparison-booking-error", code, runtimeObserved: false }, status);
export function createBookingHttpServer() {
  const entries = new Map<string, { origin: string; selection: BookingSelection; owner: Owner }>();
  const closed = new Map<string, { origin: string; state: z.infer<typeof bookingStateSchema> }>();
  const inputs = new Set<IO>();
  return Object.freeze({
    handle(request: Request, companyId: string, open: (selection: BookingSelection) => Owner) {
      const io = createComparisonReviewBodyIO<Response>(
        request.signal,
        {
          cancelled: "REQUEST_CANCELLED",
          timeout: "REQUEST_TIMEOUT",
          invalid: "INVALID_QUERY",
          limit: "TOO_LARGE",
          failed: "READ_FAILED",
        },
        { body: request.body, used: request.bodyUsed },
      );
      // Retain every reader, including invalid/unregistered requests, until release is proven.
      inputs.add(io);
      let explicit: Response | undefined;
      const reject = (code: string, status: number): never => {
        explicit = fault(code, status);
        throw new ComparisonReviewReceiveError("READ_BLOCKED");
      };
      io.start(async () => {
        const origin = request.headers.get("origin"),
          id = request.headers.get("x-venturepass-comparison-booking");
        try {
          assertLocalRequest(request);
        } catch {
          return reject("LOCAL_ONLY", 403);
        }
        const url = new URL(request.url);
        if (
          !origin ||
          !z.string().uuid().safeParse(companyId).success ||
          !z.string().uuid().safeParse(id).success ||
          url.pathname !== `/api/studio/cases/${companyId}/public-claim-comparison/booking` ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          return reject("INVALID_QUERY", 400);
        if (request.method !== "POST") return reject("METHOD_NOT_ALLOWED", 405);
        if (
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
            request.headers.get("content-type") ?? "",
          ) ||
          request.headers.has("content-encoding")
        )
          return reject("CONTENT_TYPE", 415);
        const length = request.headers.get("content-length");
        if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 8192))
          return reject("TOO_LARGE", 413);
        if (
          inputs.size > 8 ||
          [...inputs].some((other) => other !== io && other.inspect().cleanupFailed)
        )
          return reject("BODY_CLEANUP_REQUIRED", 409);
        const bytes = await io.collect(8192);
        const parsed = bookingActionSchema.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        if (!parsed.success) return reject("INVALID_QUERY", 400);
        io.beforeSync();
        const action = parsed.data;
        let entry = entries.get(id!);
        const prior = closed.get(id!);
        if (
          (entry && (entry.origin !== origin || entry.selection.companyId !== companyId)) ||
          (prior && (prior.origin !== origin || prior.state.selection.companyId !== companyId))
        )
          return fault("OWNER_UNAVAILABLE", 404);
        if (prior)
          return action.action === "inspect" || action.action === "close"
            ? jsonResponse(prior.state)
            : fault("OWNER_CLOSED");
        if (action.action === "open") {
          if (action.selection.companyId !== companyId) return fault("SELECTION_CHANGED");
          if (entry && canonical(entry.selection) !== canonical(action.selection))
            return fault("SELECTION_CHANGED");
          if (!entry) {
            if (
              entries.size >= 8 ||
              [...entries.values()].some((v) => v.selection.companyId === companyId)
            )
              return fault("OWNER_BUSY");
            // Factory is synchronous and passive. No resources are acquired before this
            // exact owner is registered; failed review/close retains it for original recovery.
            try {
              entry = { origin, selection: action.selection, owner: open(action.selection) };
            } catch (e) {
              return fault(
                e instanceof Error && e.message === "NOT_CONFIGURED"
                  ? "NOT_CONFIGURED"
                  : "OPEN_UNAVAILABLE",
                503,
              );
            }
            entries.set(id!, entry);
          }
        }
        if (!entry) return fault("OWNER_UNAVAILABLE", 404);
        let review: null | z.infer<typeof bookingReviewSchema> = null;
        try {
          if (action.action === "review") {
            const r = entry.owner.review();
            if (canonical(r.request.selection) !== canonical(entry.selection)) {
              entry.owner.revoke();
              return fault("SELECTION_CHANGED");
            }
            review = bookingReviewSchema.parse({
              reviewDigest: r.reviewDigest,
              inspectedAt: r.inspectedAt,
              expiresAt: r.expiresAt,
              companyId: r.companyId,
              companyRevision: r.companyRevision,
              request: r.request,
              identity: r.identity,
              budget: {
                currency: r.budget.currency,
                unitScale: r.budget.unitScale,
                availableUnits: r.budget.availableUnits,
                heldUnits: r.budget.heldUnits,
              },
              costs: {
                currency: r.financialBasis.costs.currency,
                unitScale: r.financialBasis.costs.unitScale,
                reservedUnits: r.financialBasis.costs.reservedUnits,
                inputUnits: r.financialBasis.costs.inputUnits,
                outputUnits: r.financialBasis.costs.outputUnits,
              },
              notice: r.notice.text,
              retention: {
                localNotice: r.retentionNotice.localNotice,
                providerNotice: r.retentionNotice.providerNotice,
              },
              sources: r.financialBasis.evidence.sources.map((s) => ({
                title: s.title,
                url: s.url,
                excerpt: s.excerpt,
                reviewedAt: s.reviewedAt,
                validUntil: s.validUntil,
              })),
            });
          } else if (action.action === "reserve") entry.owner.reserve(action.consent);
          else if (action.action === "recover") entry.owner.recover();
          else if (action.action === "close") entry.owner.close();
          const state = bookingStateSchema.parse({
            kind: "comparison-booking-state",
            registrationId: id,
            selection: entry.selection,
            ...entry.owner.inspect(),
            review,
          });
          if (
            state.receipt &&
            (state.receipt.companyId !== companyId ||
              state.receipt.companyRevision !== entry.selection.companyRevision ||
              state.receipt.runId !== state.runId ||
              state.receipt.clientRequestId !== state.clientRequestId)
          )
            throw Error("RECEIPT_MISMATCH");
          if (new TextEncoder().encode(JSON.stringify(state)).length > 128 * 1024)
            return fault("REVIEW_TOO_LARGE", 413);
          if (state.status === "closed") {
            entries.delete(id!);
            closed.set(id!, { origin, state });
            if (closed.size > 64) closed.delete(closed.keys().next().value!);
          }
          return jsonResponse(state);
        } catch {
          return fault("BOOKING_UNAVAILABLE");
        }
      });
      void io.completion.then(() => {
        if (!io.inspect().cleanupFailed) inputs.delete(io);
      });
      const response = io.delivery.then(
        async (value) => {
          await io.completion;
          return io.inspect().cleanupFailed ? fault("BODY_CLEANUP_REQUIRED") : value;
        },
        (e: unknown) =>
          explicit ??
          fault(e instanceof ComparisonReviewReceiveError ? e.code : "INVALID_QUERY", 400),
      );
      return { response, completion: io.completion };
    },
  });
}
const key = Symbol.for("venturepass.comparison-booking-http.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: ReturnType<typeof createBookingHttpServer>;
};
export const bookingHttpServer = () => (shared[key] ??= createBookingHttpServer());
