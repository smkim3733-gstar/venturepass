import "server-only";
import type { StudioStore } from "./studio-storage";
import type { SourceDocument } from "./studio-schema";

export { MAX_VENTURE_ORIGINAL_BYTES } from "./studio-storage";

/** Return bytes only to the server runner; callers must never serialize this result into API/UI data. */
export function readVentureOriginal(
  store: StudioStore,
  caseId: string,
  sourceId: string,
): { source: SourceDocument; buffer: Buffer; sha256: string } {
  return store.originalForVentureInput(caseId, sourceId);
}
