import "server-only";
import type { StudioStore } from "./studio-storage";
import { StudioError } from "./studio-http";

export type AgencyEvidenceStatus = {
  caseRevision: number;
  recordId: string;
  observedAt: string;
  evidence: { sourceId: string; state: "matched" | "changed" | "unavailable" }[];
};

/** Read-only comparison with the locally recorded original, never agency receipt verification. */
export function inspectAgencyEvidence(
  store: StudioStore,
  caseId: string,
  recordId: string,
  expectedRevision: number,
): AgencyEvidenceStatus {
  const company = store.get(caseId);
  const assertRevision = () => {
    if (store.get(caseId).revision !== expectedRevision)
      throw new StudioError(
        "기업자료가 변경되었습니다. 최신 기록을 불러온 뒤 원본을 다시 확인해 주세요.",
        409,
        "STALE_REVISION",
      );
  };
  assertRevision();
  const record = company.agencyRecords.find((entry) => entry.id === recordId);
  if (!record)
    throw new StudioError(
      "해당 기업의 기관 기록을 찾을 수 없습니다.",
      404,
      "AGENCY_RECORD_NOT_FOUND",
    );
  const evidence: AgencyEvidenceStatus["evidence"] = [];
  for (const saved of record.evidence) {
    assertRevision();
    let state: AgencyEvidenceStatus["evidence"][number]["state"] = "unavailable";
    try {
      const current = store.originalForVentureInput(caseId, saved.sourceId);
      state =
        current.source.name === saved.sourceName &&
        current.source.updatedAt === saved.sourceUpdatedAt &&
        current.source.originalName === saved.originalName &&
        current.source.mimeType === saved.mimeType &&
        current.buffer.byteLength === saved.sizeBytes &&
        current.sha256 === saved.sha256
          ? "matched"
          : "changed";
    } catch {
      // Unsafe links, missing files and failed reads reveal neither paths nor raw error details.
      // Recheck the case outside this catch so a concurrent edit never becomes a valid observation.
    }
    assertRevision();
    evidence.push({ sourceId: saved.sourceId, state });
  }
  assertRevision();
  return {
    caseRevision: expectedRevision,
    recordId,
    observedAt: new Date().toISOString(),
    evidence,
  };
}
