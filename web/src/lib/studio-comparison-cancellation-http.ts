import "server-only";
import { z } from "zod";
import { assertLocalRequest, jsonResponse } from "./studio-http";
import {
  cancellationActionSchema,
  cancellationReviewSchema,
  cancellationStateSchema,
  type CancellationSelection,
} from "./studio-comparison-cancellation-wire";
import { canonicalSelectionValue as canonical } from "./studio-candidate-selection-types";
import { createComparisonReviewBodyIO } from "./studio-public-claim-comparison-review-body";
import { ComparisonReviewReceiveError } from "./studio-public-claim-comparison-review-wire";
import type { createComparisonCancellation } from "./studio-comparison-cancellation";
type Owner = ReturnType<typeof createComparisonCancellation>;
type IO = ReturnType<typeof createComparisonReviewBodyIO<Response>>;
const fault = (code: string, status = 409) =>
  jsonResponse({ kind: "comparison-cancellation-error", code, runtimeObserved: false }, status);
export function createCancellationHttpServer() {
  const entries = new Map<
      string,
      { origin: string; selection: CancellationSelection; owner: Owner }
    >(),
    closed = new Map<string, { origin: string; state: z.infer<typeof cancellationStateSchema> }>(),
    inputs = new Set<IO>();
  return Object.freeze({
    handle(request: Request, companyId: string, open: (selection: CancellationSelection) => Owner) {
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
      inputs.add(io);
      let explicit: Response | undefined;
      const reject = (code: string, status: number): never => {
        explicit = fault(code, status);
        throw new ComparisonReviewReceiveError("READ_BLOCKED");
      };
      io.start(async () => {
        const origin = request.headers.get("origin"),
          id = request.headers.get("x-venturepass-comparison-cancellation");
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
          url.pathname !== `/api/studio/cases/${companyId}/public-claim-comparison/cancellation` ||
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
        const bytes = await io.collect(8192),
          parsed = cancellationActionSchema.safeParse(
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
          if (
            action.selection.companyId !== companyId ||
            (entry && canonical(entry.selection) !== canonical(action.selection))
          )
            return fault("SELECTION_CHANGED");
          if (!entry) {
            if (
              entries.size >= 8 ||
              [...entries.values()].some((v) => v.selection.companyId === companyId)
            )
              return fault("OWNER_BUSY");
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
        let review: z.infer<typeof cancellationReviewSchema> | null = null;
        try {
          if (action.action === "review") {
            const raw = entry.owner.review();
            if (
              raw.companyId !== entry.selection.companyId ||
              raw.companyRevision !== entry.selection.companyRevision ||
              raw.runId !== entry.selection.runId
            ) {
              entry.owner.revoke();
              return fault("SELECTION_CHANGED");
            }
            review = cancellationReviewSchema.parse(
              Object.fromEntries(
                Object.keys(cancellationReviewSchema.shape).map((key) => [
                  key,
                  raw[key as keyof typeof raw],
                ]),
              ),
            );
          } else if (action.action === "cancel") entry.owner.cancel(action.consent);
          else if (action.action === "recover") entry.owner.recover();
          else if (action.action === "close") entry.owner.close();
          const state = cancellationStateSchema.parse({
            kind: "comparison-cancellation-state",
            registrationId: id,
            selection: entry.selection,
            ...entry.owner.inspect(),
            review,
          });
          if (
            state.receipt &&
            (state.receipt.companyId !== companyId ||
              state.receipt.companyRevision !== entry.selection.companyRevision ||
              state.receipt.runId !== entry.selection.runId ||
              state.receipt.clientRequestId !== state.clientRequestId)
          )
            throw Error("RECEIPT_MISMATCH");
          if (state.status === "closed") {
            entries.delete(id!);
            closed.set(id!, { origin, state });
            if (closed.size > 64) closed.delete(closed.keys().next().value!);
          }
          return jsonResponse(state);
        } catch {
          return fault("CANCELLATION_UNAVAILABLE");
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
const key = Symbol.for("venturepass.comparison-cancellation-http.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: ReturnType<typeof createCancellationHttpServer>;
};
export const cancellationHttpServer = () => (shared[key] ??= createCancellationHttpServer());
