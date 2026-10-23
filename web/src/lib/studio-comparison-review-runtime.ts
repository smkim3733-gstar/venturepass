import "server-only";
import { join, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import {
  recordComparisonCompanyConnection,
  issueComparisonCompanyGuard,
  revokeComparisonCompanyGuards,
} from "./studio-comparison-company-capability";
import { checkComparisonDatabasePath } from "./studio-public-comparison-file-identity";
import { openPublicComparisonStoredReader } from "./studio-public-claim-comparison-database-v11";
import type { PublicComparisonDatabaseSelection } from "./studio-public-claim-comparison-database";
import { createComparisonReviewRequestHandler } from "./studio-public-claim-comparison-review-handler";
import { comparisonReviewErrorResponse } from "./studio-public-claim-comparison-review-server";
import { storedReviewHeaders } from "./studio-comparison-review-catalog";
import { jsonResponse, assertLocalRequest, readBoundedBody, StudioError } from "./studio-http";
import {
  copyComparisonReviewQuery,
  ComparisonReviewReceiveError,
} from "./studio-public-claim-comparison-review-wire";

type Configuration = {
  dataRoot: string;
  controlDirectory: string;
  selection: PublicComparisonDatabaseSelection;
};
type Reader = ReturnType<typeof openPublicComparisonStoredReader>;
type Operation = ReturnType<ReturnType<typeof createComparisonReviewRequestHandler>["handle"]>;
type Held = {
  companyId: string;
  origin: string;
  db?: DatabaseSync;
  reader?: Reader;
  operation?: Operation;
};
const revision = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .transform(Number)
  .pipe(z.number().safe());
const error = (code: string, status: number) => jsonResponse({ code }, status);

/** Existing files only. The server explicitly pins a production database; no env/DB is written. */
function configuration(): Configuration | null {
  const id = process.env.VENTUREPASS_COMPARISON_REVIEW_DATABASE_ID;
  const controlDirectory = process.env.VENTUREPASS_COMPARISON_REVIEW_CONTROL_DIR;
  if (!id && !controlDirectory) return null;
  const dataRoot = process.env.VENTURE_DATA_DIR;
  if (!dataRoot || !controlDirectory || !isAbsolute(dataRoot) || !isAbsolute(controlDirectory))
    throw Error("CONFIGURATION_INVALID");
  return {
    dataRoot: resolve(dataRoot),
    controlDirectory: resolve(controlDirectory),
    selection: {
      databaseInstanceId: z.string().uuid().parse(id),
      environment: "production",
      scopeId: "candidate-quality-provider-v2-live",
    },
  };
}

/** Caller retains this runtime until all requests/cleanup finish. No SQL at construction. */
export function createStoredComparisonRuntime(settings: Configuration | null) {
  const config = settings && structuredClone(settings);
  const held = new Set<Held>();
  function acquire(item: Held) {
    if (!config) throw Error("NOT_CONFIGURED");
    if (item.reader) return item.reader;
    const studioFile = join(config.dataRoot, "studio.sqlite");
    checkComparisonDatabasePath(config.dataRoot, studioFile);
    item.db = new DatabaseSync(studioFile, { readOnly: true });
    recordComparisonCompanyConnection(item.db, config.dataRoot);
    const guard = issueComparisonCompanyGuard(item.db, config.dataRoot);
    item.reader = openPublicComparisonStoredReader(
      {
        dataRoot: config.dataRoot,
        studioFile,
        qualityFile: join(config.dataRoot, "quality.sqlite"),
        controlDirectory: config.controlDirectory,
      },
      config.selection,
      guard,
    );
    return item.reader;
  }
  function close(item: Held) {
    if (
      item.operation &&
      (!item.operation.inspect().settled || item.operation.inspect().cleanupFailed)
    )
      return false;
    item.reader?.close();
    if (item.db) {
      if (item.db.isTransaction) throw Error("COMPANY_CLEANUP_REQUIRED");
      item.db.close();
      revokeComparisonCompanyGuards(item.db);
      item.db = undefined;
    }
    held.delete(item);
    return true;
  }
  function reserve(companyId: string, origin: string) {
    if (held.size >= 8 || [...held].some((h) => h.companyId === companyId))
      throw Error("CLEANUP_REQUIRED");
    const item = { companyId, origin };
    held.add(item);
    return item as Held;
  }
  return Object.freeze({
    inspect: () => ({ retained: held.size }),
    catalog(companyId: string, companyRevision: number, origin: string) {
      if (!config) return error("NOT_CONFIGURED", 503);
      let item: Held | undefined;
      try {
        item = reserve(companyId, origin);
        const catalog = acquire(item).listStoredReviews({ companyId, companyRevision });
        if (!close(item)) return error("CLEANUP_REQUIRED", 409);
        return jsonResponse(catalog);
      } catch {
        if (item) {
          try {
            close(item);
          } catch {
            /* retain this exact owner */
          }
        }
        return error(held.size ? "CLEANUP_REQUIRED" : "CATALOG_UNAVAILABLE", held.size ? 409 : 422);
      }
    },
    cleanup(companyId: string, origin: string) {
      for (const item of held)
        if (item.companyId === companyId && item.origin === origin) {
          try {
            close(item);
          } catch {
            /* explicit retry retains the same object */
          }
        }
      return [...held].some((h) => h.companyId === companyId)
        ? error("CLEANUP_REQUIRED", 409)
        : jsonResponse({ closed: true });
    },
    async review(
      request: Request,
      companyId: string,
      companyRevision: number,
      origin: string,
      runId: string,
      dispatchCommandDigest: string,
    ) {
      let item: Held;
      try {
        item = reserve(companyId, origin);
      } catch {
        return comparisonReviewErrorResponse("READ_BLOCKED");
      }
      const owner = item;
      const handler = createComparisonReviewRequestHandler(
        config && owner
          ? {
              companyId,
              runId,
              dispatchCommandDigest,
              localOrigin: origin,
              service: {
                readStoredReviewByRun(query) {
                  return acquire(owner).readCompanyStoredReview(query, {
                    companyId,
                    companyRevision,
                  });
                },
              },
            }
          : null,
      );
      const operation = handler.handle(request);
      if (owner) owner.operation = operation;
      let response = await operation.response;
      await operation.completion;
      let complete = operation.inspect().settled && !operation.inspect().cleanupFailed;
      if (owner) {
        try {
          complete = close(owner) && complete;
        } catch {
          complete = false;
        }
      }
      if (!complete) response = comparisonReviewErrorResponse("READ_BLOCKED");
      const headers = new Headers(response.headers);
      if (complete) headers.set(storedReviewHeaders.receipt, "complete");
      return new Response(response.body, { status: response.status, headers });
    },
  });
}
const runtimeKey = Symbol.for("venturepass.comparison-read-runtime.v1");
const retainedRuntime = globalThis as typeof globalThis & {
  [runtimeKey]?: {
    runtime: ReturnType<typeof createStoredComparisonRuntime>;
    configurationKey: string;
  };
};
function currentRuntime(cleanupOnly = false) {
  // Share the original owner across Next route bundles and development reloads.
  // Configuration drift blocks new reads, but can never hide its cleanup handle.
  const state = retainedRuntime[runtimeKey];
  if (cleanupOnly) return state?.runtime ?? createStoredComparisonRuntime(null);
  const config = configuration(),
    key = JSON.stringify(config);
  if (state && state.configurationKey !== key) throw Error("CONFIGURATION_CHANGED");
  return (retainedRuntime[runtimeKey] ??= {
    runtime: createStoredComparisonRuntime(config),
    configurationKey: key,
  }).runtime;
}

/** Next's tracked Request is transferred without clone/tee to the native handler. */
export async function storedComparisonRoute(
  request: Request,
  companyId: string,
  kind: "catalog" | "review",
) {
  try {
    assertLocalRequest(request);
    z.string().uuid().parse(companyId);
    const url = new URL(request.url);
    const origin = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
    if (request.signal.aborted) return error("REQUEST_CANCELLED", 409);
    if (kind === "catalog") {
      if (request.method === "DELETE" && !url.search) {
        // Next supplies a stream even for a bodyless DELETE. Require actual EOF
        // before touching the retained owner; any payload still fails closed.
        await readBoundedBody(request, 0);
        return currentRuntime(true).cleanup(companyId, origin);
      }
      if (
        request.method !== "GET" ||
        request.body ||
        [...url.searchParams.keys()].join() !== "revision"
      )
        return error("INVALID_QUERY", 400);
      const value = revision.parse(url.searchParams.get("revision"));
      return currentRuntime().catalog(companyId, value, origin);
    }
    if (request.method !== "POST" || url.search || !request.headers.get("origin"))
      return comparisonReviewErrorResponse("INVALID_QUERY");
    const companyRevision = revision.parse(request.headers.get(storedReviewHeaders.revision));
    const query = copyComparisonReviewQuery({
      runId: request.headers.get(storedReviewHeaders.run),
      dispatchCommandDigest: request.headers.get(storedReviewHeaders.dispatch),
      mode: "historical",
    });
    if (request.bodyUsed) return comparisonReviewErrorResponse("INVALID_QUERY");
    const native = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
      signal: request.signal,
      duplex: "half",
    } as RequestInit);
    return await currentRuntime().review(
      native,
      companyId,
      companyRevision,
      origin,
      query.runId,
      query.dispatchCommandDigest,
    );
  } catch (failure) {
    if (failure instanceof StudioError && failure.status === 403)
      return kind === "review"
        ? comparisonReviewErrorResponse("LOCAL_ONLY")
        : error("LOCAL_ONLY", 403);
    if (
      failure instanceof ZodError ||
      failure instanceof ComparisonReviewReceiveError ||
      (failure instanceof StudioError && failure.code === "TOO_LARGE")
    )
      return kind === "review"
        ? comparisonReviewErrorResponse("INVALID_QUERY")
        : error("INVALID_QUERY", 400);
    return kind === "review"
      ? comparisonReviewErrorResponse("READ_FAILED")
      : error("CATALOG_UNAVAILABLE", 422);
  }
}
