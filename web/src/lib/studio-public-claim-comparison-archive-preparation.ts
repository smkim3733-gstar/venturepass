import "server-only";
import { createHash } from "node:crypto";
import { publicEvidenceText } from "./studio-public-evidence";
import { publicClaimPreparationSchema as schema } from "./studio-public-claim-comparison-preparation-types";
import type { PublicClaimComparisonPreparation } from "./studio-public-claim-comparison";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Only stored selection/context consistency. No original company/history/DB authenticity.
 * JSON input keeps accessors/hooks outside this historical read boundary. */
export function inspectArchivedPublicClaimPreparation(
  raw: string,
): PublicClaimComparisonPreparation {
  if (typeof raw !== "string" || raw.length > 242000)
    throw Error("PUBLIC_COMPARISON_CONTEXT_LIMIT");
  const supplied: unknown = JSON.parse(raw);
  const parsed = schema.parse(supplied);
  // Reject trimming, additions, coercion or alternate field order; preserve original v1 bytes.
  if (JSON.stringify(parsed) !== raw) throw Error("PUBLIC_COMPARISON_CONTEXT_FORMAT");
  const { preparationDigest, inputCharacters, ...payload } = parsed;
  const serialized = JSON.stringify(payload);
  const evidence = parsed.input.selectedEvidence;
  if (
    sha(serialized) !== preparationDigest ||
    serialized.length !== inputCharacters ||
    serialized.length > 240000 ||
    !parsed.input.claimQuote.trim() ||
    !parsed.input.section.content.includes(parsed.input.claimQuote) ||
    JSON.stringify(evidence.map((v) => v.sourceId)) !==
      JSON.stringify(parsed.selection.sourceIds) ||
    new Set([...parsed.selection.sourceIds, ...parsed.input.excludedSourceIds]).size !==
      evidence.length + parsed.input.excludedSourceIds.length
  )
    throw Error("PUBLIC_COMPARISON_CONTEXT_MISMATCH");
  for (const v of evidence) {
    if (
      !v.originalReference.quote.trim() ||
      !v.excerpt.includes(v.originalReference.quote) ||
      sha(publicEvidenceText({ ...v.metadata, quote: v.excerpt, ...v.manualNotes })) !==
        v.textSha256
    )
      throw Error("PUBLIC_COMPARISON_CONTEXT_MISMATCH");
  }
  // The dynamic literal shape above was checked against every fixed boundary value.
  return parsed as PublicClaimComparisonPreparation;
}
