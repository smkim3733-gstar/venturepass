import { caseSchema, originalOnlyWarnings, type StudioCase } from "@/lib/studio-schema";
import {
  localOcrReviewedWarning,
  MAX_OCR_REVIEWS,
  reviewLocalOcrMutationSchema,
} from "@/lib/studio-ocr-review";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const unique = (values: string[]) => new Set(values).size === values.length;
async function sha256(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Match the original correction before publishing a new company revision. */
export async function localOcrSaveAcknowledged(
  value: unknown,
  original: StudioCase,
  mutation: unknown,
): Promise<boolean> {
  try {
    const before = caseSchema.safeParse(original);
    const after = caseSchema.safeParse(value);
    const request = reviewLocalOcrMutationSchema.safeParse(mutation);
    if (!before.success || !after.success || !request.success) return false;
    const prior = before.data,
      next = after.data,
      command = request.data;
    if (
      next.id !== prior.id ||
      !Number.isSafeInteger(prior.revision) ||
      prior.revision < 0 ||
      !Number.isSafeInteger(next.revision) ||
      next.revision <= prior.revision ||
      command.revision !== prior.revision
    )
      return false;
    if (
      !unique(prior.sources.map((source) => source.id)) ||
      !unique(next.sources.map((source) => source.id))
    )
      return false;
    const index = prior.sources.findIndex((source) => source.id === command.sourceId);
    const source = prior.sources[index],
      saved = next.sources[index];
    if (
      !source ||
      !saved ||
      prior.sources.length !== next.sources.length ||
      !source.originalName ||
      source.extraction !== "pending" ||
      source.text !== "" ||
      source.updatedAt !== command.sourceUpdatedAt
    )
      return false;
    const savedAt = Date.parse(saved.updatedAt),
      priorAt = Date.parse(source.updatedAt);
    if (
      !Number.isFinite(savedAt) ||
      saved.updatedAt === source.updatedAt ||
      (Number.isFinite(priorAt) && savedAt <= priorAt)
    )
      return false;
    const warnings = [
      ...new Set([
        ...source.warnings.filter(
          (warning) => !(originalOnlyWarnings as readonly string[]).includes(warning),
        ),
        localOcrReviewedWarning,
      ]),
    ];
    if (
      !same(saved, {
        ...source,
        text: command.text,
        extraction: "manual",
        warnings,
        updatedAt: saved.updatedAt,
      })
    )
      return false;
    if (prior.sources.some((item, i) => i !== index && !same(item, next.sources[i]))) return false;
    if (
      next.sourceOcrReviews.length !== prior.sourceOcrReviews.length + 1 ||
      next.sourceOcrReviews.length > MAX_OCR_REVIEWS ||
      !same(prior.sourceOcrReviews, next.sourceOcrReviews.slice(0, -1))
    )
      return false;
    if (
      !unique(next.sourceOcrReviews.map((review) => review.id)) ||
      !unique(next.sourceOcrReviews.map((review) => review.clientRequestId))
    )
      return false;
    const receipt = next.sourceOcrReviews.at(-1)!;
    if (prior.sourceOcrReviews.some((review) => review.clientRequestId === command.clientRequestId))
      return false;
    const input = {
      action: command.action,
      sourceId: command.sourceId,
      sourceUpdatedAt: command.sourceUpdatedAt,
      originalSha256: command.originalSha256,
      text: command.text,
      reviewed: command.reviewed,
    };
    return (
      receipt.clientRequestId === command.clientRequestId &&
      receipt.sourceId === command.sourceId &&
      receipt.originalSha256 === command.originalSha256 &&
      receipt.sourceUpdatedAt === saved.updatedAt &&
      receipt.textSha256 === (await sha256(command.text)) &&
      receipt.inputDigest === (await sha256(JSON.stringify(input)))
    );
  } catch {
    return false;
  }
}
