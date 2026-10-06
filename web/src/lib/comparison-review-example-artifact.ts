import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { copyComparisonReviewQuery, decodeComparisonReviewWire } from "./studio-public-claim-comparison-review-wire";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z.object({
  kind: z.literal("synthetic-sql13-export"), version: z.literal(1),
  sqlVersion: z.literal(13), witnessVersion: z.literal(3),
  runId: z.string().uuid(), dispatchCommandDigest: hash, comparisonEventDigest: hash,
  responseArtifactSha256: hash, validatedArtifactSha256: hash, wireSha256: hash,
}).strict();
export type ComparisonExampleProvenance = z.infer<typeof provenanceSchema>;
export const exampleWireSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Integrity of a committed synthetic snapshot, not live SQL or an authority proof. */
export function validateComparisonExampleArtifact(raw: unknown, provenance: unknown) {
  const manifest = provenanceSchema.parse(provenance);
  const text = JSON.stringify(raw);
  if (typeof text !== "string" || exampleWireSha256(text) !== manifest.wireSha256)
    throw Error("EXAMPLE_WIRE_HASH");
  const query = copyComparisonReviewQuery((raw as { query?: unknown }).query);
  if (query.mode !== "historical") throw Error("EXAMPLE_HISTORICAL_ONLY");
  const result = decodeComparisonReviewWire(text, 200, query);
  for (const key of ["runId", "dispatchCommandDigest", "comparisonEventDigest",
    "responseArtifactSha256", "validatedArtifactSha256"] as const) {
    if (manifest[key] !== result.resultIdentity[key]) throw Error("EXAMPLE_ORIGINAL_IDENTITY");
  }
  return { query, result, provenance: manifest };
}
