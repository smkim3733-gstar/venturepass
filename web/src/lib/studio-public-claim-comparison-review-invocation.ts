import {
  createComparisonReviewDisplayTicket,
  type ComparisonReviewDisplayFrame,
  type ComparisonReviewDisplaySelection,
} from "./studio-public-claim-comparison-review-display";
import { createComparisonReviewReceiver } from "./studio-public-claim-comparison-review-receive";
import {
  copyComparisonReviewQuery, ComparisonReviewReceiveError, comparisonReviewWireLimits,
  type ComparisonReviewQuery, type ComparisonReviewReceiveCode, type ComparisonReviewWireResult,
} from "./studio-public-claim-comparison-review-wire";
import { publicClaimPreparationSchema } from "./studio-public-claim-comparison-preparation-types";

type IOState = Readonly<{ started: boolean; delivered: boolean; settled: boolean; cleanupFailed: boolean }>;
export type ComparisonReviewRequestOperation = Readonly<{
  response: Promise<Response>;
  completion: Promise<void>;
  inspect(): IOState;
}>;
export type ComparisonReviewRequestStart = (
  query: ComparisonReviewQuery, signal: AbortSignal,
) => ComparisonReviewRequestOperation;
type Outcome = Readonly<{ kind: "result"; result: ComparisonReviewWireResult }> |
  Readonly<{ kind: "error"; code: ComparisonReviewReceiveCode; message: string }>;
type Options = {
  sequence: number;
  snapshot: { id: string; revision: number };
  expected: ComparisonReviewDisplaySelection;
  signal: AbortSignal;
  startRequest: ComparisonReviewRequestStart | null;
};
const fault = (code: ComparisonReviewReceiveCode) => new ComparisonReviewReceiveError(code);
// Only the fixed display selection shape is copied here; nested scalars use the existing schemas.
function dataFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw fault("INVALID_QUERY");
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length > 16 || keys.some((k) => typeof k !== "string" ||
      !("value" in descriptors[k]) || !descriptors[k].enumerable)) throw fault("INVALID_QUERY");
  return Object.fromEntries(keys.map((k) => [k, descriptors[k as string].value]));
}
function sourceIds(value: unknown) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw fault("INVALID_QUERY");
  const d = Object.getOwnPropertyDescriptors(value as object), length = d.length.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 10 ||
      Reflect.ownKeys(value).length !== length + 1) throw fault("INVALID_QUERY");
  return Array.from({ length }, (_, i) => {
    if (!d[i] || !("value" in d[i]) || !d[i].enumerable) throw fault("INVALID_QUERY");
    return d[i].value;
  });
}

/** One inactive explicit call, retained by its caller even after the screen closes.
 * No fetch, service acquisition, registry or server lifecycle capability.
 * A missing/invalid receipt after invoking the trusted port cannot prove Request completion. */
export function createComparisonReviewInvocation(options: Options) {
  let expected: ComparisonReviewDisplaySelection, query: ComparisonReviewQuery;
  let ticket: ReturnType<typeof createComparisonReviewDisplayTicket>;
  const { sequence, snapshot, signal, startRequest } = options;
  try {
    if (!(signal instanceof AbortSignal) || (startRequest !== null && typeof startRequest !== "function"))
      throw fault("INVALID_QUERY");
    const raw = dataFields(options.expected), keys = Object.keys(raw);
    if (keys.length !== 6 || keys.some((k) => !["runId", "dispatchCommandDigest", "mode",
        "selection", "binding", "sectionKey"].includes(k))) throw fault("INVALID_QUERY");
    query = copyComparisonReviewQuery({ runId: raw.runId,
      dispatchCommandDigest: raw.dispatchCommandDigest, mode: raw.mode });
    const shape = publicClaimPreparationSchema.shape, selection = dataFields(raw.selection);
    expected = { ...query,
      selection: shape.selection.parse({ ...selection, sourceIds: sourceIds(selection.sourceIds) }),
      binding: shape.binding.parse(dataFields(raw.binding)),
      sectionKey: shape.input.shape.section.shape.key.parse(raw.sectionKey) };
    if (new TextEncoder().encode(JSON.stringify(expected)).length > comparisonReviewWireLimits.queryBytes)
      throw fault("INVALID_QUERY");
    ticket = createComparisonReviewDisplayTicket(sequence, snapshot, expected);
  } catch { throw fault("INVALID_QUERY"); }

  const receiver = createComparisonReviewReceiver(query, signal);
  let attempted = false, cancelled = false;
  let requestStatus: "not-started" | "pending" | "settled" | "unavailable" = "not-started";
  let operation: unknown; // Retain the original receipt, not only its response.
  let requestInspect: (() => IOState) | undefined;
  let requestCleanupFailed = false, responseEnded = false, settled = false;
  let listening = false, observerCleanupFailed = false;
  let candidate: ComparisonReviewWireResult | undefined, outcome: Outcome | undefined;
  let resolveDelivery!: (value: Outcome) => void, resolveRequest!: () => void, resolveCompletion!: () => void;
  const delivery = new Promise<Outcome>((resolve) => { resolveDelivery = resolve; });
  const requestCompletion = new Promise<void>((resolve) => { resolveRequest = resolve; });
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });

  function unlisten() {
    if (!listening) return;
    listening = false;
    try { signal.removeEventListener("abort", cancel); }
    catch { observerCleanupFailed = true; }
  }
  function fail(code: ComparisonReviewReceiveCode) {
    if (outcome) return;
    unlisten();
    const e = fault(code);
    outcome = Object.freeze({ kind: "error", code: e.code, message: e.message });
    resolveDelivery(outcome);
  }
  function readRequestState(): IOState | null {
    if (!requestInspect) return null;
    try {
      const s = requestInspect();
      if (!s || ["started", "delivered", "settled", "cleanupFailed"].some(
        (key) => typeof s[key as keyof IOState] !== "boolean")) throw fault("RECEIVE_FAILED");
      // Copy once so later caller mutation cannot change the observation.
      return Object.freeze({ started: s.started, delivered: s.delivered,
        settled: s.settled, cleanupFailed: s.cleanupFailed });
    } catch { requestCleanupFailed = true; return null; }
  }
  function finish() {
    if (!responseEnded || !["not-started", "settled"].includes(requestStatus)) return;
    if (!settled) { settled = true; resolveCompletion(); }
    if (outcome) return;
    if (cancelled || signal.aborted) { fail("CANCELLED"); return; }
    unlisten();
    if (requestCleanupFailed || observerCleanupFailed || receiver.inspect().cleanupFailed) { fail("RECEIVE_FAILED"); return; }
    if (candidate) {
      // Delivery and subsequent display copies cannot mutate the private candidate.
      outcome = Object.freeze({ kind: "result", result: structuredClone(candidate) });
      resolveDelivery(outcome);
    }
  }
  function requestUnknown() {
    requestStatus = "unavailable";
    requestCleanupFailed = true;
    fail("RECEIVE_FAILED");
    receiver.cancel();
  }
  function requestEnded(rejected: boolean) {
    const state = readRequestState();
    if (rejected || !state?.settled) { requestUnknown(); return; }
    requestCleanupFailed ||= state.cleanupFailed;
    requestStatus = "settled";
    resolveRequest();
    if (requestCleanupFailed) { fail("RECEIVE_FAILED"); receiver.cancel(); }
    finish();
  }
  void receiver.delivery.then((value) => {
    candidate = value;
    finish();
  }, (e: unknown) => {
    fail(e instanceof ComparisonReviewReceiveError ? e.code : "RECEIVE_FAILED");
  });
  void receiver.completion.then(() => {
    responseEnded = true;
    if (requestStatus === "not-started") resolveRequest();
    finish();
  });
  function cancel() {
    cancelled = true;
    candidate = undefined;
    fail("CANCELLED");
    receiver.cancel();
  }
  try {
    signal.addEventListener("abort", cancel, { once: true }); listening = true;
    if (signal.aborted) cancel();
  } catch { observerCleanupFailed = true; fail("RECEIVE_FAILED"); receiver.cancel(); }
  const responsePromise = (value: Promise<Response>) => new Promise<Response>((resolve, reject) => {
    Promise.prototype.then.call(value, resolve, reject);
  });
  return Object.freeze({
    ticket, supported: startRequest !== null, delivery, requestCompletion,
    responseCompletion: receiver.completion, completion,
    start(frame: ComparisonReviewDisplayFrame) {
      if (attempted) return delivery;
      attempted = true;
      let current = false;
      try { current = ticket.isCurrent(frame); } catch { /* Invalid frame never starts a request. */ }
      if (!current || cancelled || signal.aborted) { cancel(); return delivery; }
      if (!startRequest) { fail("RESULT_UNAVAILABLE"); receiver.cancel(); return delivery; }
      receiver.start((ownedSignal) => {
        requestStatus = "pending";
        let response: unknown, done: unknown;
        try {
          operation = startRequest(structuredClone(query), ownedSignal);
          // A Promise/thenable is not a synchronous receipt. Observe native rejection only.
          if (operation instanceof Promise) {
            void Promise.prototype.then.call(operation, () => undefined, () => undefined);
            throw fault("RECEIVE_FAILED");
          }
          if (!operation || typeof operation !== "object") throw fault("RECEIVE_FAILED");
          const d = Object.getOwnPropertyDescriptors(operation);
          response = d.response?.value; done = d.completion?.value;
          // Observe available originals even when another receipt member is missing.
          if (response instanceof Promise)
            void Promise.prototype.then.call(response, () => undefined, () => undefined);
          if (done instanceof Promise)
            void Promise.prototype.then.call(done, () => undefined, () => undefined);
          if (!(response instanceof Promise) || !(done instanceof Promise) ||
              typeof d.inspect?.value !== "function") throw fault("RECEIVE_FAILED");
          requestInspect = d.inspect.value.bind(operation);
          void Promise.prototype.then.call(done, () => requestEnded(false), () => requestEnded(true));
          return responsePromise(response);
        } catch {
          requestUnknown();
          if (response instanceof Promise) return responsePromise(response);
          throw fault("RECEIVE_FAILED");
        }
      });
      return delivery;
    },
    cancel,
    display(frame: ComparisonReviewDisplayFrame): Outcome | null {
      if (cancelled || signal.aborted) return null;
      try {
        if (!ticket.isCurrent(frame) || !outcome) return null;
        if (outcome.kind === "error") return { ...outcome };
        const request = readRequestState();
        if (!request?.settled) requestCleanupFailed = true;
        if (!settled || requestCleanupFailed || request?.cleanupFailed || observerCleanupFailed ||
            receiver.inspect().cleanupFailed || !candidate) return null;
        const accepted = ticket.accept(candidate, frame);
        // accept only copies this private, wire-validated candidate; it does not alter its literals.
        return accepted ? { kind: "result", result: accepted as ComparisonReviewWireResult } : null;
      } catch { return null; }
    },
    inspect() {
      const request = readRequestState();
      if (request?.cleanupFailed) requestCleanupFailed = true;
      return Object.freeze({ attempted, cancelled: cancelled || signal.aborted,
        settled, requestStatus, requestCleanupFailed, observerCleanupFailed,
        request, response: receiver.inspect(),
        canForget: settled && requestStatus !== "unavailable" && !requestCleanupFailed &&
          !observerCleanupFailed && !receiver.inspect().cleanupFailed,
        // No raw response, service, path, command or server-cleanup claim.
      });
    },
  });
}
