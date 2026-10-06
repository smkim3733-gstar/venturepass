import { createHash } from "node:crypto";
import { z } from "zod";
import { publicClaimComparisonRequestPins } from "./studio-public-claim-comparison-request-types";

/** Test-only replacement for the one frozen comparison format. This never emulates
 * SDK parsing or execution; refuse any different schema instead of changing request bytes. */
export function pinnedComparisonFormatFixture(schema: z.ZodType, name: string) {
  if (name !== "public_claim_comparison_v1") throw Error("Unsupported synthetic format");
  const format = { type: "json_schema", name, strict: true,
    schema: z.toJSONSchema(schema, { target: "draft-7" }) };
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  if (createHash("sha256").update(JSON.stringify(canonical(format))).digest("hex") !== publicClaimComparisonRequestPins.schemaDigest)
    throw Error("Synthetic format differs from frozen original comparison schema");
  return format;
}
