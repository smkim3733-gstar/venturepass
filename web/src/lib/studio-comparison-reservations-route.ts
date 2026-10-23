import "server-only";
import { z, ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import { decodeReservationView, type ReservationView } from "./studio-comparison-reservations-wire";
type Owner = { list(): ReservationView; close(): { closed: boolean } };
type Factory = (companyId: string, revision: number) => Promise<Owner>;
const error = (code: string, status = 422) => jsonResponse({ code }, status);
const revision = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .transform(Number)
  .pipe(z.number().safe());

/** Retain failed cleanup by company and original origin even after configuration withdrawal. */
export function createReservationHttpServer(open: Factory) {
  const held = new Map<string, { origin: string; pending: boolean; owner?: Owner }>();
  function close(companyId: string) {
    const item = held.get(companyId);
    if (!item) return true;
    if (item.pending) return false;
    if (item.owner && !item.owner.close().closed) return false;
    held.delete(companyId);
    return true;
  }
  return Object.freeze({
    inspect: () => ({ retained: held.size }),
    async handle(request: Request, companyId: string) {
      try {
        assertLocalRequest(request);
        z.string().uuid().parse(companyId);
        const url = new URL(request.url),
          origin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
        if (
          url.pathname !== `/api/studio/cases/${companyId}/public-claim-comparison/reservations` ||
          url.hash ||
          url.username ||
          url.password
        )
          return error("INVALID_QUERY", 400);
        if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
        if (request.method === "DELETE" && !url.search) {
          await readBoundedBody(request, 0);
          if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
          const item = held.get(companyId);
          if (item && item.origin !== origin) return error("CLEANUP_REQUIRED", 409);
          try {
            return close(companyId)
              ? jsonResponse({ closed: true })
              : error("CLEANUP_REQUIRED", 409);
          } catch {
            return error("CLEANUP_REQUIRED", 409);
          }
        }
        if (
          request.method !== "GET" ||
          request.body ||
          [...url.searchParams.keys()].join() !== "revision"
        )
          return error("INVALID_QUERY", 400);
        const value = revision.parse(url.searchParams.get("revision"));
        if (held.has(companyId) || held.size >= 8) return error("CLEANUP_REQUIRED", 409);
        const item: { origin: string; pending: boolean; owner?: Owner } = { origin, pending: true };
        held.set(companyId, item);
        try {
          try {
            item.owner = await open(companyId, value);
          } finally {
            item.pending = false;
          }
          if (request.signal.aborted) throw Error("REQUEST_CANCELLED");
          const result = decodeReservationView(item.owner.list(), {
            id: companyId,
            revision: value,
          });
          if (!close(companyId)) throw Error("CLEANUP_REQUIRED");
          return request.signal.aborted ? error("REQUEST_CANCELLED", 409) : jsonResponse(result);
        } catch (failure) {
          try {
            close(companyId);
          } catch {
            /* Keep only the original owner. */
          }
          if (held.has(companyId)) return error("CLEANUP_REQUIRED", 409);
          return failure instanceof Error && failure.message === "NOT_CONFIGURED"
            ? error("NOT_CONFIGURED", 503)
            : error("CATALOG_UNAVAILABLE");
        }
      } catch (failure) {
        if (failure instanceof StudioError && failure.status === 403)
          return error("LOCAL_ONLY", 403);
        if (failure instanceof ZodError || failure instanceof StudioError)
          return error("INVALID_QUERY", 400);
        return error("CATALOG_UNAVAILABLE");
      }
    },
  });
}
const key = Symbol.for("venturepass.comparison-reservations-http.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: ReturnType<typeof createReservationHttpServer>;
};
export function reservationRoute(request: Request, companyId: string) {
  const server = (shared[key] ??= createReservationHttpServer(async (id, version) => {
    const { openConfiguredReservations } = await import("./studio-comparison-reservations-open");
    return openConfiguredReservations(id, version);
  }));
  return server.handle(request, companyId);
}
