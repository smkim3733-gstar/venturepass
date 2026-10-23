import "server-only";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readSafe } from "../../scripts/local-data-files.mjs";
import { comparisonExecutionInputSchema } from "./studio-comparison-execution-input-file";
import { createComparisonInputPreparation } from "./studio-comparison-input-preparation";
import {
  decodeInputDownload,
  inputSelectionSchema,
  type InputSelection,
} from "./studio-comparison-input-wire";
function configuration() {
  const data = process.env.VENTURE_DATA_DIR,
    control = process.env.VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR,
    id = process.env.VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID,
    policy = process.env.VENTUREPASS_COMPARISON_INPUT_POLICY_FILE;
  if (!policy) throw Error("NOT_CONFIGURED");
  if (!data || !control || ![data, control, policy].every(isAbsolute))
    throw Error("CONFIGURATION_INVALID");
  return {
    dataRoot: resolve(data),
    controlDirectory: resolve(control),
    databaseInstanceId: z.string().uuid().parse(id),
    policy: resolve(policy),
  };
}
/** Read-only preparation. Never changes an input file, environment, approval or provider runtime. */
export function openConfiguredInputPreparation(raw: InputSelection) {
  const selection = inputSelectionSchema.parse(raw),
    config = configuration(),
    fingerprint = JSON.stringify(config);
  const original = readSafe(config.policy, 128 * 1024, null, true);
  const policy = comparisonExecutionInputSchema.shape.settings
    .pick({ basis: true, usagePolicy: true })
    .strict()
    .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original.bytes)));
  const owner = createComparisonInputPreparation({
    dataRoot: config.dataRoot,
    controlDirectory: config.controlDirectory,
    databaseInstanceId: config.databaseInstanceId,
    settings: { ...selection, ...policy },
  });
  let result: ReturnType<typeof owner.prepare> | undefined;
  return Object.freeze({
    prepare() {
      result = undefined;
      result = owner.prepare();
    },
    close: owner.close,
    download() {
      if (!owner.inspect().closed || !result) throw Error("CLEANUP_REQUIRED");
      if (
        JSON.stringify(configuration()) !== fingerprint ||
        readSafe(config.policy, 128 * 1024).sha256 !== original.sha256
      )
        throw Error("CONFIGURATION_CHANGED");
      const document = comparisonExecutionInputSchema.parse(result.document);
      if (document.databaseInstanceId !== config.databaseInstanceId)
        throw Error("INPUT_UNAVAILABLE");
      const content = JSON.stringify(document, null, 2) + "\n",
        summary = result.summary;
      return decodeInputDownload(
        {
          kind: "comparison-input-download",
          companyId: summary.companyId,
          companyRevision: summary.companyRevision,
          runId: summary.runId,
          inspectedAt: summary.inspectedAt,
          expiresAt: summary.expiresAt,
          reviewDigest: summary.reviewDigest,
          model: summary.model,
          content,
          sha256: createHash("sha256").update(content).digest("hex"),
          transmissionAllowed: false,
          consentRecorded: false,
          runtimeObserved: false,
        },
        selection,
      );
    },
  });
}
