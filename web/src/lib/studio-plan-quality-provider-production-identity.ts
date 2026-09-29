import "server-only";
import { createHash } from "node:crypto";
import { providerProductionSelectionSchema } from "./studio-plan-quality-provider-production-service-types";

/** Stable v1 names for an audited, still untouched r1 approval. These are not capabilities.
 * Existing r2/r3 receipts MUST override this derivation, including older arbitrary nonces. */
export function providerInitialProductionIdentity(raw: unknown) {
  const selection = providerProductionSelectionSchema.parse(raw);
  const name = JSON.stringify([
    selection.runId,
    selection.runDigest,
    selection.approvalBindingDigest,
  ]);
  const nonce = (phase: string) => {
    const bytes = createHash("sha1")
      .update(Buffer.from("a43e7eed2f815b4c9de72b03ee247ab2", "hex"))
      .update(`venturepass/production-execution/v1/${phase}/${name}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return Object.freeze({
    ...selection,
    preparedRequestId: nonce("prepared"),
    dispatchRequestId: nonce("dispatch"),
  });
}
