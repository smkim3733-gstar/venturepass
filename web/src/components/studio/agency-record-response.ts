import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  agencyAppendMutationSchema,
  buildAgencyRecord,
  type AgencyRecordInput,
} from "@/lib/studio-agency-records";
export type AgencyRecordSaveCommand = {
  action: "append-agency-record";
  revision: number;
  clientRequestId: string;
  record: AgencyRecordInput;
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Read-only command/result comparison. The shared builder is pure; no original or writer is opened. */
export function agencyRecordSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  value: AgencyRecordSaveCommand,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    command = agencyAppendMutationSchema.safeParse(value);
  if (!response.success || !before.success || !command.success) return false;
  const saved = response.data,
    base = before.data,
    input = command.data;
  if (saved.id !== base.id || saved.revision <= base.revision || input.revision !== base.revision)
    return false;
  const originals = base.agencyRecords,
    records = saved.agencyRecords;
  if (
    new Set(originals.map((r) => r.id)).size !== originals.length ||
    new Set(records.map((r) => r.id)).size !== records.length
  )
    return false;
  const matches = records.filter((r) => r.clientRequestId === input.clientRequestId);
  if (matches.length !== 1 || originals.some((r) => r.clientRequestId === input.clientRequestId))
    return false;
  const record = matches[0];
  if (!equal(records, [...originals, record])) return false;
  for (const key of [
    "profile",
    "sources",
    "analysis",
    "selectedCandidateId",
    "plans",
    "tasks",
    "applications",
    "applicationEvents",
    "stage",
  ] as const)
    if (!equal(saved[key], base[key])) return false;
  for (const evidence of record.evidence) {
    const sources = base.sources.filter((s) => s.id === evidence.sourceId);
    if (sources.length !== 1 || !sources[0].originalName) return false;
    const source = sources[0];
    if (
      evidence.sourceName !== source.name ||
      evidence.originalName !== source.originalName ||
      evidence.mimeType !== source.mimeType ||
      evidence.sourceUpdatedAt !== source.updatedAt ||
      evidence.capturedAt !== record.recordedAt
    )
      return false;
  }
  try {
    // Reuse existing canonical text, chain/version, evidence order and capacity rules.
    // Server-generated IDs/digests/file hashes are not authenticated by this comparison.
    const expected = buildAgencyRecord(originals, input.record, {
      id: record.id,
      clientRequestId: input.clientRequestId,
      inputDigest: record.inputDigest,
      recordedAt: record.recordedAt,
      evidence: record.evidence,
    });
    return equal(record, expected);
  } catch {
    return false;
  }
}
