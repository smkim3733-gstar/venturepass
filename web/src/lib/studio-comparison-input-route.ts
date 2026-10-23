import "server-only";
import { z, ZodError } from "zod";
import { assertLocalRequest, jsonResponse, readBoundedBody, StudioError } from "./studio-http";
import {
  decodeInputDownload,
  inputSelectionSchema,
  type InputDownload,
  type InputSelection,
} from "./studio-comparison-input-wire";
type Owner = { prepare(): void; close(): { closed: boolean }; download(): InputDownload };
type Factory = (selection: InputSelection) => Promise<Owner>;
const error = (code: string, status = 422) => jsonResponse({ code }, status);
/** Original resources survive failed cleanup and configuration withdrawal. No writes or sends. */
export function createInputPreparationHttpServer(open: Factory) {
  const held = new Map<string, { origin: string; pending: boolean; owner?: Owner }>();
  function close(id: string) {
    const item = held.get(id);
    if (!item) return true;
    if (item.pending || (item.owner && !item.owner.close().closed)) return false;
    held.delete(id);
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
          url.pathname !==
            `/api/studio/cases/${companyId}/public-claim-comparison/input-preparation` ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          return error("INVALID_QUERY", 400);
        if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
        if (request.method === "DELETE") {
          await readBoundedBody(request, 0);
          if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
          if (held.get(companyId)?.origin && held.get(companyId)!.origin !== origin)
            return error("CLEANUP_REQUIRED", 409);
          try {
            return close(companyId)
              ? jsonResponse({ closed: true })
              : error("CLEANUP_REQUIRED", 409);
          } catch {
            return error("CLEANUP_REQUIRED", 409);
          }
        }
        if (
          request.method !== "POST" ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
            request.headers.get("content-type") ?? "",
          )
        )
          return error("INVALID_QUERY", 400);
        const selection = inputSelectionSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, 8192)),
          ),
        );
        if (selection.companyId !== companyId) return error("INVALID_QUERY", 400);
        if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
        if (held.has(companyId) || held.size >= 8) return error("CLEANUP_REQUIRED", 409);
        const item: { origin: string; pending: boolean; owner?: Owner } = { origin, pending: true };
        held.set(companyId, item);
        try {
          try {
            item.owner = await open(selection);
          } finally {
            item.pending = false;
          }
          if (request.signal.aborted) throw Error("REQUEST_CANCELLED");
          item.owner.prepare();
          if (!close(companyId)) throw Error("CLEANUP_REQUIRED");
          if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
          const result = decodeInputDownload(item.owner.download(), selection);
          return request.signal.aborted ? error("REQUEST_CANCELLED", 409) : jsonResponse(result);
        } catch (failure) {
          try {
            close(companyId);
          } catch {
            /* Retain the exact original resources. */
          }
          if (held.has(companyId)) return error("CLEANUP_REQUIRED", 409);
          return failure instanceof Error && failure.message === "NOT_CONFIGURED"
            ? error("NOT_CONFIGURED", 503)
            : error("INPUT_UNAVAILABLE");
        }
      } catch (failure) {
        if (failure instanceof StudioError)
          return error(failure.status === 403 ? "LOCAL_ONLY" : "INVALID_QUERY", failure.status);
        if (
          failure instanceof ZodError ||
          failure instanceof SyntaxError ||
          failure instanceof TypeError
        )
          return error("INVALID_QUERY", 400);
        return error("INPUT_UNAVAILABLE");
      }
    },
  });
}
const key = Symbol.for("venturepass.comparison-input-http.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: ReturnType<typeof createInputPreparationHttpServer>;
};
export function inputPreparationRoute(request: Request, companyId: string) {
  const server = (shared[key] ??= createInputPreparationHttpServer(async (selection) => {
    const { openConfiguredInputPreparation } = await import("./studio-comparison-input-open");
    return openConfiguredInputPreparation(selection);
  }));
  return server.handle(request, companyId);
}
