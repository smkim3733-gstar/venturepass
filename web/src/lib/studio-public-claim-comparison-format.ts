import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { executionDigest } from "./studio-engine-request-core";
import { publicClaimComparisonResponseSchema } from "./studio-public-claim-comparison-types";
import { publicClaimComparisonRequestPins } from "./studio-public-claim-comparison-request-types";

// Exact JSON.stringify output of the original locked SDK formatter, including property order.
// This is the one frozen comparison-v1 format, not a general replacement for SDK converters.
const originalWireSha256 = "413b79dd48bd3307647ac973cab4e9640f934bcd033afd944df78a978615b82c";

/** Passive reconstruction for previews and historical reads. A schema or ordering change
 * must be versioned explicitly; never silently rewrite an archived request or its identity.
 */
export function publicClaimComparisonFormat() {
  const format = {
    type: "json_schema" as const,
    name: "public_claim_comparison_v1",
    strict: true as const,
    schema: z.toJSONSchema(publicClaimComparisonResponseSchema, { target: "draft-7" }),
  };
  if (
    executionDigest(format) !== publicClaimComparisonRequestPins.schemaDigest ||
    createHash("sha256").update(JSON.stringify(format)).digest("hex") !== originalWireSha256
  )
    throw new Error("PUBLIC_CLAIM_FROZEN_FORMAT_CHANGED");
  return format;
}
