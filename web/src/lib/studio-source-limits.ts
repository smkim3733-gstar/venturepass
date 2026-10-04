/** Attachments are optional. Count is separate from file-size and text limits. */
export const MAX_COMPANY_SOURCES = 100;

/** Count saved sources and unfinished intake reservations once per source ID. */
export function occupiedSourceSlots(record: {
  sources: readonly { id: string }[];
  sourceIntakes: readonly { sourceId: string; phase: string }[];
}): number {
  const ids = new Set(record.sources.map((source) => source.id));
  for (const item of record.sourceIntakes) {
    if (item.phase !== "cancelled") ids.add(item.sourceId);
  }
  return ids.size;
}
