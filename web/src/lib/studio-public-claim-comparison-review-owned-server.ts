import "server-only";
import {
  openPublicComparisonStoredReader,
  type StoredComparisonCatalog,
} from "./studio-public-claim-comparison-database-v11";
import { z } from "zod";
import type { PublicComparisonDatabaseSelection } from "./studio-public-claim-comparison-database";
import type { ComparisonCompanyGuard } from "./studio-comparison-company-capability";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-data-only";
import { createComparisonReviewRequestHandler } from "./studio-public-claim-comparison-review-handler";
import { comparisonReviewErrorResponse } from "./studio-public-claim-comparison-review-server";

type Operation = ReturnType<ReturnType<typeof createComparisonReviewRequestHandler>["handle"]>;
type Binding = {
  paths: unknown;
  selection: PublicComparisonDatabaseSelection;
  companyGuard: ComparisonCompanyGuard;
  companyId: string;
  runId: string;
  dispatchCommandDigest: string;
  localOrigin: string;
};
type CompanyBinding = Omit<Binding, "runId" | "dispatchCommandDigest"> & {
  companyRevision: number;
};

/** Trusted server composition only. Import/creation does not open a store or install a route.
 * The caller retains this owner until close reports closed, including after a failure.
 * Paths, guard and fixed selection come from the server, never from the HTTP request.
 */
export function createOwnedComparisonReviewServer(binding: Binding) {
  return createReviewOwner(binding).server;
}

/** One company snapshot, one explicitly chosen stored run. Trusted server calls only.
 * No request-supplied paths, catalog installation, default store or automatic polling. */
export function createCompanyComparisonReviewServer(binding: CompanyBinding) {
  const owner = createReviewOwner(binding);
  return Object.freeze({ ...owner.server, list: owner.list, select: owner.select });
}

function createReviewOwner(input: Binding | CompanyBinding) {
  // Scalars and data settings are captured; only the authentic company capability is borrowed.
  const binding = { ...input };
  z.string().uuid().parse(binding.companyId);
  if ("companyRevision" in binding)
    z.number().int().nonnegative().safe().parse(binding.companyRevision);
  const origin = new URL(binding.localOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== binding.localOrigin ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw Error("INVALID_QUERY");
  const settings = { paths: binding.paths, selection: binding.selection };
  assertPublicComparisonDataOnly(settings, 16384);
  const fixed = structuredClone(settings),
    companyGuard = binding.companyGuard;
  let reader: ReturnType<typeof openPublicComparisonStoredReader> | undefined;
  let closing = false,
    closed = false;
  const operations = new Set<Operation>();
  let catalog: StoredComparisonCatalog | undefined;
  function getReader() {
    if (closing || closed) throw Error("PUBLIC_COMPARISON_STORED_READER_CLOSED");
    if (reader?.inspect().cleanupRequired)
      throw Error("PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED");
    return (reader ??= openPublicComparisonStoredReader(
      fixed.paths,
      fixed.selection,
      companyGuard,
    ));
  }
  const makeHandler = (selected: Pick<Binding, "runId" | "dispatchCommandDigest">) =>
    createComparisonReviewRequestHandler({
      companyId: binding.companyId,
      ...selected,
      localOrigin: binding.localOrigin,
      service: {
        readStoredReviewByRun(query) {
          // The existing handler has already checked origin, scope, canonical body and cancellation.
          return getReader().readStoredReviewByRun(query);
        },
      },
    });
  let handler =
    "runId" in binding
      ? makeHandler({ runId: binding.runId, dispatchCommandDigest: binding.dispatchCommandDigest })
      : null;
  const inspect = () =>
    Object.freeze({
      status: closed ? ("closed" as const) : closing ? ("draining" as const) : ("ready" as const),
      pendingRequests: [...operations].filter((operation) => !operation.inspect().settled).length,
      bodyCleanupRequired: [...operations].some((operation) => operation.inspect().cleanupFailed),
      readerAcquired: !!reader,
      storageCleanupRequired: reader?.inspect().cleanupRequired ?? false,
    });
  const server = Object.freeze({
    handle(request: Request): Operation {
      if (closing || closed || operations.size || !handler)
        return Object.freeze({
          response: Promise.resolve(
            comparisonReviewErrorResponse(handler ? "READ_BLOCKED" : "RESULT_UNAVAILABLE"),
          ),
          completion: Promise.resolve(),
          inspect: () =>
            Object.freeze({ started: false, delivered: true, settled: true, cleanupFailed: false }),
        });
      const operation = handler.handle(request);
      operations.add(operation);
      const completion = operation.completion.then(() => {
        // Delivery alone cannot release ownership. Failed body cleanup retains the original handle.
        if (!operation.inspect().cleanupFailed) operations.delete(operation);
      });
      return Object.freeze({ ...operation, completion });
    },
    inspect,
    close() {
      if (closed) return inspect();
      closing = true;
      if (operations.size) return inspect();
      reader?.close(); // Failure leaves the same reader here for the next explicit close.
      closed = true;
      return inspect();
    },
  });
  function requireSelectionPhase() {
    if (closing || closed || operations.size || handler || !("companyRevision" in binding))
      throw Error("PUBLIC_COMPARISON_CATALOG_SELECTION_BLOCKED");
  }
  return {
    server,
    list() {
      requireSelectionPhase();
      catalog = undefined; // A failed refresh cannot leave a stale selectable catalog.
      if (!("companyRevision" in binding))
        throw Error("PUBLIC_COMPARISON_CATALOG_SELECTION_BLOCKED");
      const result = getReader().listStoredReviews({
        companyId: binding.companyId,
        companyRevision: binding.companyRevision,
      });
      catalog = structuredClone(result);
      return structuredClone(result);
    },
    select(runId: string, dispatchCommandDigest: string) {
      requireSelectionPhase();
      if (reader?.inspect().cleanupRequired)
        throw Error("PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED");
      const item = catalog?.reviews.find(
        (review) =>
          review.runId === runId &&
          review.dispatchCommandDigest === dispatchCommandDigest &&
          review.selection.companyId === binding.companyId,
      );
      if (!item) throw Error("PUBLIC_COMPARISON_CATALOG_SELECTION_MISSING");
      handler = makeHandler({
        runId: item.runId,
        dispatchCommandDigest: item.dispatchCommandDigest,
      });
      catalog = undefined;
      return structuredClone(item);
    },
  };
}
