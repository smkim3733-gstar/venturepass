import { z } from "zod";
export const inputSelectionSchema = z
  .object({
    companyId: z.string().uuid(),
    companyRevision: z.number().int().nonnegative().safe(),
    runId: z.string().uuid(),
  })
  .strict();
export type InputSelection = z.infer<typeof inputSelectionSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const inputDownloadSchema = inputSelectionSchema
  .extend({
    kind: z.literal("comparison-input-download"),
    inspectedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    reviewDigest: hash,
    model: z.string().min(1).max(200),
    content: z
      .string()
      .min(1)
      .max(128 * 1024),
    sha256: hash,
    transmissionAllowed: z.literal(false),
    consentRecorded: z.literal(false),
    runtimeObserved: z.literal(false),
  })
  .strict();
export type InputDownload = z.infer<typeof inputDownloadSchema>;
/** Validate the bounded transport and selected IDs. Full policy validation remains server-owned. */
export function decodeInputDownload(raw: unknown, selection: InputSelection, now = Date.now()) {
  const value = inputDownloadSchema.parse(raw);
  const document = z
    .object({
      inputVersion: z.literal(1),
      databaseInstanceId: z.string().uuid(),
      settings: inputSelectionSchema
        .extend({
          basis: z.object({ provenance: z.literal("official-reviewed") }).passthrough(),
          usagePolicy: z.object({ provenance: z.literal("official-reviewed") }).passthrough(),
        })
        .strict(),
    })
    .strict()
    .parse(JSON.parse(value.content));
  if (
    new TextEncoder().encode(value.content).length > 128 * 1024 ||
    Date.parse(value.expiresAt) <= now ||
    Date.parse(value.inspectedAt) > now ||
    Date.parse(value.expiresAt) <= Date.parse(value.inspectedAt) ||
    (["companyId", "companyRevision", "runId"] as const).some(
      (key) => value[key] !== selection[key] || document.settings[key] !== selection[key],
    )
  )
    throw Error("INPUT_UNAVAILABLE");
  return value;
}
export const inputFileName = (value: InputSelection) => `comparison-input-${value.runId}.json`;
