import "server-only";
import type { IsolatedPublicComparisonService } from "./studio-public-claim-comparison-database-v11";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-data-only";
import { privateHeaders } from "./studio-http";
import {
  copyComparisonReviewQuery, comparisonReviewSuccessWire, comparisonReviewErrorWire,
  comparisonReviewErrorStatus, ComparisonReviewReceiveError, type ComparisonReviewErrorCode,
} from "./studio-public-claim-comparison-review-wire";

const blocked = new Set([
  "PUBLIC_COMPARISON_POSTCAPTURE_EXECUTION_PENDING", "PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED",
  "PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED", "PUBLIC_COMPARISON_STORAGE_SESSION_BUSY",
  "PUBLIC_COMPARISON_RECOVERY_REQUIRED", "PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED",
  "PUBLIC_COMPARISON_COMPANY_CLEANUP_REQUIRED", "PUBLIC_COMPARISON_STORAGE_RECOVERY_REQUIRED", "PUBLIC_COMPARISON_COMPANY_TRANSACTION_ACTIVE",
]);
export function comparisonReviewErrorResponse(code: ComparisonReviewErrorCode) {
  return new Response(comparisonReviewErrorWire(code), {
    status: comparisonReviewErrorStatus[code], headers: { ...privateHeaders, "Content-Type": "application/json; charset=utf-8",
      ...(code === "METHOD_NOT_ALLOWED" ? { Allow: "POST" } : {}) },
  });
}
export type ComparisonReviewReadPort = Pick<IsolatedPublicComparisonService, "readStoredReviewByRun">;

/** Inactive internal composition only. Caller retains this authentic service/session.
 * No store getter, installation, recovery, write, server retire or HTTP route here. */
export function encodeStoredComparisonReview(
  service: ComparisonReviewReadPort, rawQuery: unknown,
): Response {
  let query;
  try { query = copyComparisonReviewQuery(rawQuery); }
  catch { return comparisonReviewErrorResponse("INVALID_QUERY"); }
  try {
    const result = service.readStoredReviewByRun(query);
    assertPublicComparisonDataOnly(result, 4 * 1024 * 1024);
    const body = comparisonReviewSuccessWire(query, result);
    return new Response(body, { status: 200, headers: { ...privateHeaders, "Content-Type": "application/json; charset=utf-8" } });
  } catch (e) {
    if (e instanceof ComparisonReviewReceiveError && e.code === "RECEIVE_LIMIT") return comparisonReviewErrorResponse("TOO_LARGE");
    const code = e instanceof Error ? e.message : "";
    if (code === "PUBLIC_COMPARISON_STORED_RESULT_MISSING") return comparisonReviewErrorResponse("RESULT_UNAVAILABLE");
    if (code === "PUBLIC_COMPARISON_ARCHIVE_LIMIT" || code === "PUBLIC_COMPARISON_STORED_READ_LIMIT") return comparisonReviewErrorResponse("TOO_LARGE");
    if (blocked.has(code)) return comparisonReviewErrorResponse("READ_BLOCKED");
    return comparisonReviewErrorResponse("READ_FAILED");
  }
}
