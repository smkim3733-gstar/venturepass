import "server-only";
import { assertPublicComparisonDataOnly } from "./studio-public-claim-comparison-budget";

/** Size/copy boundary only. This function never authenticates a stored result or grants authority. */
export function copyComparisonStoredRead<T>(value: T, kind: "selection" | "result"): T {
  assertPublicComparisonDataOnly(value);
  const limit = kind === "selection" ? 8 * 1024 : 4 * 1024 * 1024;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limit)
    throw Error("PUBLIC_COMPARISON_STORED_READ_LIMIT");
  return structuredClone(value);
}
