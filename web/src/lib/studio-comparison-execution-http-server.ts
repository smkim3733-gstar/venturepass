import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertLocalRequest, jsonResponse } from "./studio-http";
import { createComparisonReviewBodyIO } from "./studio-public-claim-comparison-review-body";
import { ComparisonReviewReceiveError } from "./studio-public-claim-comparison-review-wire";
import {
  comparisonExecutionActionSchema,
  comparisonExecutionSessionHeader,
} from "./studio-comparison-execution-wire";
import type { createComparisonExecutionApproval } from "./studio-comparison-execution-approval";

type Approval = ReturnType<typeof createComparisonExecutionApproval>;
export type ComparisonExecutionOpenFactory = (
  companyId: string,
  companyRevision: number,
) => Promise<{ runId: string; approval: Approval }>;
type IO = ReturnType<typeof createComparisonReviewBodyIO<Response>>;
const bindingSchema = z
  .object({
    companyId: z.string().uuid(),
    companyRevision: z.number().int().nonnegative().safe(),
    runId: z.string().uuid(),
    localOrigin: z.string(),
  })
  .strict();
type Binding = z.infer<typeof bindingSchema>;
type Entry = {
  binding: Binding;
  sessionId: string;
  approval: Approval;
  inputs: Set<IO>;
  consent?: string;
  running?: Promise<unknown>;
  outcome: "pending" | "returned" | "failed" | null;
  closing: boolean;
  closedReceipt?: unknown;
};
const fault = (code: string, status: number) =>
  jsonResponse(
    {
      kind: "comparison-execution-error",
      code,
      runtimeObserved: false,
    },
    status,
  );
const reject = (
  code: "INVALID_QUERY" | "LOCAL_ONLY" | "TOO_LARGE" | "CONTENT_TYPE" | "METHOD_NOT_ALLOWED",
): never => {
  throw new ComparisonReviewReceiveError(code);
};

/** Process-local ownership only. An optional trusted factory opens the server-selected
 * owner; HTTP never supplies policies, reservations, credentials or an owner object.
 * No expiry/eviction of live owners. A process restart fails closed, never resumes a send. */
export function createComparisonExecutionHttpServer() {
  const active = new Map<string, Entry>();
  const closed = new Map<string, { binding: Binding; receipt: unknown }>();
  type OpenResult =
    | { ticket: { sessionId: string; companyId: string; companyRevision: number; runId: string } }
    | { code: string };
  type Opening = {
    companyId: string;
    companyRevision: number;
    origin: string;
    result: Promise<OpenResult>;
    settled: boolean;
    owner?: Approval;
    sessionId?: string;
  };
  const openings = new Map<string, Opening>();
  function view(item: Entry) {
    const state = item.approval.inspect(),
      execution = state.runtime.service?.execution;
    return {
      kind: "comparison-execution-status",
      sessionId: item.sessionId,
      companyId: item.binding.companyId,
      companyRevision: item.binding.companyRevision,
      runId: item.binding.runId,
      status: item.closing ? "draining" : state.status,
      reviewDigest: state.reviewDigest,
      selection: state.selection,
      outcome: item.outcome,
      postcapture: state.postcapture,
      bodyCleanupRequired: [...item.inputs].some((io) => io.inspect().cleanupFailed),
      execution: execution
        ? {
            phase: execution.phase,
            capturePersisted: execution.capturePersisted,
            cleanupRequired: execution.cleanupRequired,
            networkSettled: execution.networkSettled,
            sdkSettled: execution.sdkSettled,
            ioSettled: execution.ioSettled,
          }
        : null,
      runtimeObserved: false,
      dispatchAllowed: false,
    };
  }
  function register(raw: Binding, approval: Approval) {
    const binding = bindingSchema.parse(raw),
      url = new URL(binding.localOrigin);
    if (
      url.origin !== binding.localOrigin ||
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw Error("INVALID_BINDING");
    if (
      active.size >= 8 ||
      [...active.values()].some(
        (item) =>
          item.approval === approval ||
          item.binding.companyId === binding.companyId ||
          item.binding.runId === binding.runId,
      )
    )
      throw Error("ORIGINAL_OWNER_REQUIRED");
    if (approval.inspect().status !== "unused") throw Error("UNUSED_OWNER_REQUIRED");
    const sessionId = randomUUID();
    active.set(sessionId, {
      binding,
      approval,
      sessionId,
      inputs: new Set(),
      outcome: null,
      closing: false,
    });
    return Object.freeze({
      sessionId,
      companyId: binding.companyId,
      companyRevision: binding.companyRevision,
      runId: binding.runId,
    });
  }
  const server = Object.freeze({
    inspect: () => ({
      retained:
        active.size + [...openings.values()].filter((item) => !item.settled || item.owner).length,
      closedReceipts: closed.size,
    }),
    register,
    handle(request: Request, companyId: string, open?: ComparisonExecutionOpenFactory) {
      // The Next adapter transfers the original stream into a native Request (no clone/tee).
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
      let owned: Entry | undefined, closingReceipt: unknown, earlyError: Response | undefined;
      function refuse(code: string, status: number): never {
        earlyError = fault(code, status);
        throw new ComparisonReviewReceiveError("READ_BLOCKED");
      }
      io.start(async () => {
        const url = new URL(request.url),
          headers = request.headers;
        try {
          assertLocalRequest(request);
        } catch {
          reject("LOCAL_ONLY");
        }
        const origin = headers.get("origin");
        if (!origin || !["http:", "https:"].includes(url.protocol)) reject("LOCAL_ONLY");
        if (request.method !== "POST") reject("METHOD_NOT_ALLOWED");
        if (
          !z.string().uuid().safeParse(companyId).success ||
          url.search ||
          url.hash ||
          url.username ||
          url.password ||
          url.pathname !== `/api/studio/cases/${companyId}/public-claim-comparison/execution`
        )
          reject("INVALID_QUERY");
        if (
          !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(
            headers.get("content-type") ?? "",
          ) ||
          ![null, "identity"].includes(headers.get("content-encoding"))
        )
          reject("CONTENT_TYPE");
        const length = headers.get("content-length");
        if (
          length !== null &&
          (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length)))
        )
          reject("INVALID_QUERY");
        if (length !== null && Number(length) > 8192) reject("TOO_LARGE");
        const id = headers.get(comparisonExecutionSessionHeader);
        if (id === null) {
          const bytes = await io.collect(8192);
          let action: z.infer<typeof comparisonExecutionActionSchema>;
          try {
            action = comparisonExecutionActionSchema.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
            );
          } catch {
            return reject("INVALID_QUERY");
          }
          if (action.action !== "open") return reject("INVALID_QUERY");
          // collect has released the full input. Registration can await a module/factory,
          // so keep the abort observer until delivery instead of using the sync boundary.
          io.check();
          const existing = openings.get(action.clientRequestId);
          if (
            existing &&
            (existing.companyId !== companyId ||
              existing.companyRevision !== action.companyRevision ||
              existing.origin !== origin)
          )
            return fault("ORIGINAL_OPEN_REQUEST_REQUIRED", 409);
          let selected = existing;
          if (!selected) {
            if (!open) return fault("NOT_CONFIGURED", 503);
            if (
              [...active.values()].some((item) => item.binding.companyId === companyId) ||
              [...openings.values()].some(
                (item) => item.companyId === companyId && (!item.settled || item.owner),
              )
            )
              return fault("ORIGINAL_OWNER_REQUIRED", 409);
            for (const [key, item] of openings) {
              if (openings.size < 64) break;
              if (item.settled && !item.owner && (!item.sessionId || !active.has(item.sessionId)))
                openings.delete(key);
            }
            if (
              openings.size >= 64 ||
              active.size +
                [...openings.values()].filter((item) => !item.settled || item.owner).length >=
                8
            )
              return fault("REQUEST_BUSY", 409);
            const item: Opening = {
              companyId,
              companyRevision: action.companyRevision,
              origin: origin!,
              result: Promise.resolve({ code: "OPEN_PENDING" }),
              settled: false,
            };
            openings.set(action.clientRequestId, item);
            item.result = Promise.resolve().then(async (): Promise<OpenResult> => {
              try {
                io.check();
                const created = await open(companyId, item.companyRevision);
                item.owner = created.approval;
                const ticket = register(
                  {
                    companyId,
                    companyRevision: item.companyRevision,
                    runId: created.runId,
                    localOrigin: item.origin,
                  },
                  created.approval,
                );
                item.sessionId = ticket.sessionId;
                item.owner = undefined;
                return { ticket };
              } catch {
                // Failed registration retains any returned owner until its explicit retry
                // proves close. No retry creates a replacement factory/runtime.
                if (item.owner) {
                  try {
                    if (item.owner.close().status === "closed") item.owner = undefined;
                  } catch {
                    // Keep the original owner for a later explicit cleanup retry.
                  }
                }
                return { code: "OPEN_UNAVAILABLE" };
              } finally {
                item.settled = true;
              }
            });
            selected = item;
          } else if (selected.settled && selected.owner) {
            try {
              if (selected.owner.close().status === "closed") selected.owner = undefined;
            } catch {
              // A failed cleanup must not discard or replace the retained owner.
            }
          }
          const result = await selected.result;
          if (selected.owner) return fault("CLEANUP_REQUIRED", 409);
          if ("code" in result) return fault(result.code, 503);
          return jsonResponse({
            kind: "comparison-execution-session",
            ...result.ticket,
            closed: !active.has(result.ticket.sessionId),
            runtimeObserved: false,
            dispatchAllowed: false,
          });
        }
        if (!z.string().uuid().safeParse(id).success) reject("INVALID_QUERY");
        const item = active.get(id!),
          prior = closed.get(id!);
        const binding = item?.binding ?? prior?.binding;
        if (!binding || binding.companyId !== companyId || binding.localOrigin !== origin)
          return refuse("SESSION_UNAVAILABLE", 404);
        if (item) {
          if (item.closedReceipt) return refuse("CLEANUP_REQUIRED", 409);
          if (item.inputs.size >= 4) return refuse("REQUEST_BUSY", 409);
          owned = item;
          item.inputs.add(io);
        }
        const bytes = await io.collect(8192);
        let action: z.infer<typeof comparisonExecutionActionSchema>;
        try {
          action = comparisonExecutionActionSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          );
        } catch {
          return reject("INVALID_QUERY");
        }
        io.beforeSync(); // Full body/EOF/release and cancellation check precede every owner call.
        if (action.action === "open") return reject("INVALID_QUERY");
        if (!item)
          return action.action === "close" || action.action === "inspect"
            ? jsonResponse(prior!.receipt)
            : fault("SESSION_CLOSED", 409);
        if (action.action === "inspect") return jsonResponse(view(item));
        if (action.action === "close") {
          if (item.inputs.size !== 1 || item.running) return fault("REQUEST_BUSY", 409);
          item.closing = true;
          const state = item.approval.close();
          if (state.status !== "closed") return fault("CLEANUP_REQUIRED", 409);
          closingReceipt = { ...view(item), status: "closed", closed: true };
          item.closedReceipt = closingReceipt;
          return jsonResponse(closingReceipt);
        }
        if (action.action === "recover") {
          if (item.running) return fault("REQUEST_BUSY", 409);
          item.approval.recover(); // Original command only; never a supplied selection or send.
          return jsonResponse(view(item));
        }
        if (action.action === "recover-postcapture") {
          if (item.running || !item.consent) return fault("REQUEST_BUSY", 409);
          item.approval.recoverPostcapture(action.operation);
          return jsonResponse(view(item));
        }
        if (item.closing) return fault("CLEANUP_REQUIRED", 409);
        if ([...item.inputs].some((input) => input !== io && input.inspect().cleanupFailed))
          return fault("BODY_CLEANUP_REQUIRED", 409);
        if (action.action === "preview") {
          if (item.consent) return fault("ORIGINAL_CONFIRMATION_REQUIRED", 409);
          const prepared = item.approval.preview(),
            selected = prepared.review.request.selection;
          if (
            selected.companyId !== binding.companyId ||
            selected.companyRevision !== binding.companyRevision ||
            prepared.review.runId !== binding.runId
          ) {
            item.closing = true;
            return fault("SELECTION_CHANGED", 409);
          }
          const text = JSON.stringify({ ...view(item), prepared });
          if (new TextEncoder().encode(text).length > 128 * 1024) {
            item.closing = true;
            return fault("REVIEW_TOO_LARGE", 413);
          }
          return jsonResponse(JSON.parse(text));
        }
        if (action.action !== "execute") {
          if (item.running || !item.consent) return fault("REQUEST_BUSY", 409);
          if (action.action === "postcapture-preview") item.approval.previewPostcapture();
          else item.approval.writePostcapture(action.action, action.reviewDigest);
          return jsonResponse(view(item));
        }
        const consent = JSON.stringify(action.consent);
        if (item.consent && item.consent !== consent)
          return fault("ORIGINAL_CONFIRMATION_REQUIRED", 409);
        if (!item.consent) {
          item.consent = consent;
          item.outcome = "pending";
          // This promise outlives HTTP delivery/disconnect. Never pass the request's abort
          // signal to an approved provider call, discard its owner or resend on polling.
          try {
            item.running = item.approval.execute(action.consent);
          } catch {
            item.outcome = "failed";
            return fault("EXECUTION_FAILED", 409);
          }
          const original = item.running;
          void original
            .then(
              () => {
                item.outcome = "returned";
              },
              () => {
                item.outcome = "failed";
              },
            )
            .then(() => {
              if (item.running === original) item.running = undefined;
            });
        }
        return jsonResponse(view(item), item.running ? 202 : 200);
      });
      // Errors can be delivered before a stalled body's cancellation settles. Keep its
      // exact IO owner pinned; close is blocked until every reader is proven released.
      void io.completion.then(() => {
        if (owned && !io.inspect().cleanupFailed) {
          owned.inputs.delete(io);
          if (closingReceipt && owned.inputs.size === 0 && !owned.running) {
            active.delete(owned.sessionId);
            closed.set(owned.sessionId, { binding: owned.binding, receipt: closingReceipt });
            // Only closed receipts are bounded; no live owner is ever silently evicted.
            if (closed.size > 64) closed.delete(closed.keys().next().value!);
          }
        }
      });
      const response = io.delivery.then(
        async (value) => {
          await io.completion;
          return io.inspect().cleanupFailed ? fault("BODY_CLEANUP_REQUIRED", 409) : value;
        },
        (error: unknown) => {
          const code = error instanceof ComparisonReviewReceiveError ? error.code : "READ_FAILED";
          if (code === "READ_BLOCKED" && earlyError) return earlyError;
          const statuses: Record<string, number> = {
            INVALID_QUERY: 400,
            LOCAL_ONLY: 403,
            TOO_LARGE: 413,
            CONTENT_TYPE: 415,
            METHOD_NOT_ALLOWED: 405,
            REQUEST_TIMEOUT: 408,
            REQUEST_CANCELLED: 409,
          };
          return fault(
            code === "READ_FAILED" ? "EXECUTION_UNAVAILABLE" : code,
            statuses[code] ?? 409,
          );
        },
      );
      return Object.freeze({ response, completion: io.completion, inspect: io.inspect });
    },
  });
  return server;
}

const key = Symbol.for("venturepass.comparison-execution-http.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: ReturnType<typeof createComparisonExecutionHttpServer>;
};
export function comparisonExecutionHttpServer() {
  return (shared[key] ??= createComparisonExecutionHttpServer());
}
