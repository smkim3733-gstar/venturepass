import "server-only";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { readSafe, samePath } from "../../scripts/local-data-files.mjs";
import { comparisonFinancialEvidenceSchema } from "./studio-public-claim-comparison-financial";
import { publicClaimComparisonSelectionSchema } from "./studio-public-claim-comparison-types";
import { createComparisonReservationBooking } from "./studio-comparison-reservation-booking";
const schema = z
  .object({
    policyVersion: z.literal(1),
    databaseInstanceId: z.string().uuid(),
    evidence: comparisonFinancialEvidenceSchema,
  })
  .strict();
function configuration() {
  const dataRoot = process.env.VENTURE_DATA_DIR,
    controlDirectory = process.env.VENTUREPASS_COMPARISON_EXECUTION_CONTROL_DIR,
    databaseInstanceId = process.env.VENTUREPASS_COMPARISON_EXECUTION_DATABASE_ID,
    file = process.env.VENTUREPASS_COMPARISON_RESERVATION_POLICY_FILE;
  if (!dataRoot || !controlDirectory || !databaseInstanceId || !file) throw Error("NOT_CONFIGURED");
  if (
    ![dataRoot, controlDirectory, file].every(isAbsolute) ||
    !samePath(dirname(resolve(file)), dirname(resolve(controlDirectory)))
  )
    throw Error("POLICY_INVALID");
  const read = readSafe(file, 128 * 1024, null, true);
  const policy = schema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)),
  );
  if (
    policy.databaseInstanceId !== databaseInstanceId ||
    policy.evidence.provenance !== "official-reviewed"
  )
    throw Error("POLICY_INVALID");
  return { dataRoot, controlDirectory, databaseInstanceId, file, sha256: read.sha256, policy };
}
/** Trusted file only; HTTP supplies selection IDs, never prices, policy, model or commands. */
export function openConfiguredBooking(raw: unknown) {
  const selection = publicClaimComparisonSelectionSchema.parse(raw),
    original = configuration();
  const owner = createComparisonReservationBooking({
    dataRoot: original.dataRoot,
    controlDirectory: original.controlDirectory,
    databaseInstanceId: original.databaseInstanceId,
    request: {
      requestVersion: original.policy.evidence.requestVersion,
      model: original.policy.evidence.model,
      selection,
    },
    evidence: original.policy.evidence,
  });
  function current() {
    try {
      if (JSON.stringify(configuration()) !== JSON.stringify(original)) throw Error("CHANGED");
    } catch {
      owner.revoke();
      throw Error("POLICY_CHANGED");
    }
  }
  return Object.freeze({
    ...owner,
    review() {
      current();
      return owner.review();
    },
    reserve(consent: unknown) {
      current();
      return owner.reserve(consent);
    },
  });
}
