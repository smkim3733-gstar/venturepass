import "server-only";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { readSafe, samePath } from "../../scripts/local-data-files.mjs";
import { comparisonExecutionSettingsSchema } from "./studio-comparison-execution-approval";

export const comparisonExecutionInputSchema = z
  .object({
    inputVersion: z.literal(1),
    databaseInstanceId: z.string().uuid(),
    settings: comparisonExecutionSettingsSchema,
  })
  .strict();

/** Explicit server-owned input; not consent or a reservation. Never creates a file.
 * Sibling of the configured control directory, bounded and stable regular file.
 * readSafe refuses links/hardlinks, unsafe ancestors and replacement during reading. */
export function readComparisonExecutionInputFile(
  controlDirectory: string,
  databaseInstanceId: string,
) {
  const configured = process.env.VENTUREPASS_COMPARISON_EXECUTION_INPUT_FILE;
  if (!configured) return null;
  if (
    !isAbsolute(configured) ||
    !samePath(dirname(resolve(configured)), dirname(resolve(controlDirectory)))
  )
    throw Error("COMPARISON_INPUT_UNAVAILABLE");
  const file = resolve(configured),
    read = readSafe(file, 128 * 1024, null, true);
  const parsed = comparisonExecutionInputSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)),
  );
  if (
    parsed.databaseInstanceId !== databaseInstanceId ||
    parsed.settings.basis.provenance !== "official-reviewed" ||
    parsed.settings.usagePolicy.provenance !== "official-reviewed"
  )
    throw Error("COMPARISON_INPUT_UNAVAILABLE");
  return { file, sha256: read.sha256, settings: parsed.settings };
}
