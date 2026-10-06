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
function errorResponse(code: ComparisonReviewErrorCode) {
  return new Response(comparisonReviewErrorWire(code), {
    status: comparisonReviewErrorStatus[code], headers: { ...privateHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
/** Inactive internal composition only. Caller retains this authentic service/session.
 * No store getter, installation, recovery, write, server retire or HTTP route here. */
export function encodeStoredComparisonReview(
  service: IsolatedPublicComparisonService, rawQuery: unknown,
): Response {
  let query;
  try { query = copyComparisonReviewQuery(rawQuery); }
  catch { return errorResponse("INVALID_QUERY"); }
  try {
    const result = service.readStoredReviewByRun(query);
    assertPublicComparisonDataOnly(result, 4 * 1024 * 1024);
    const body = comparisonReviewSuccessWire(query, result);
    return new Response(body, { status: 200, headers: { ...privateHeaders, "Content-Type": "application/json; charset=utf-8" } });
  } catch (e) {
    if (e instanceof ComparisonReviewReceiveError && e.code === "RECEIVE_LIMIT") return errorResponse("TOO_LARGE");
    const code = e instanceof Error ? e.message : "";
    if (code === "PUBLIC_COMPARISON_STORED_RESULT_MISSING") return errorResponse("RESULT_UNAVAILABLE");
    if (code === "PUBLIC_COMPARISON_ARCHIVE_LIMIT" || code === "PUBLIC_COMPARISON_STORED_READ_LIMIT") return errorResponse("TOO_LARGE");
    if (blocked.has(code)) return errorResponse("READ_BLOCKED");
    return errorResponse("READ_FAILED");
  }
}
