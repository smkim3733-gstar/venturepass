import { z } from "zod";
import { canonicalSelectionValue as canonical } from "./studio-candidate-selection-types";
import { comparisonRequestReferenceSchema } from "./studio-comparison-history-match";
import {
  decodeReservationView,
  reservationHistorySchema,
  type ReservationView,
} from "./studio-comparison-reservations-wire";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Routing = {
  version: 1;
  registrationId: string;
  selection: { companyId: string; companyRevision: number; runId?: string };
  attempted: boolean;
  requestReference?: z.infer<typeof comparisonRequestReferenceSchema>;
};
const evidenceSchema = z
  .object({
    companyId: z.string().uuid(),
    runId: z.string().uuid(),
    inspectedAt: z.string().datetime(),
    observedCompanyRevision: z.number().int().nonnegative().safe(),
    reservationCompanyRevision: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    reservedUnits: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
    history: reservationHistorySchema,
  })
  .strict();
export type RequestArchive<T extends Routing> = {
  original: T;
  evidence: z.infer<typeof evidenceSchema>;
};

/** One atomic browser value holds active routing and preserved evidence. No ledger mutation. */
export function createRequestArchive<T extends Routing>(
  storage: Storage,
  key: string,
  schema: z.ZodType<T>,
  kind: "reservation" | "cancellation",
) {
  const entrySchema = z.object({ original: schema, evidence: evidenceSchema }).strict();
  const envelopeSchema = z
    .object({
      version: z.literal(2),
      active: schema.nullable(),
      archives: z.array(entrySchema).max(20),
    })
    .strict();
  function matching(original: T, evidence: z.infer<typeof evidenceSchema>) {
    const ref = original.requestReference,
      record = evidence.history[kind];
    return !!(
      original.attempted &&
      ref &&
      evidence.companyId === original.selection.companyId &&
      evidence.runId === ref.runId &&
      (kind !== "cancellation" || original.selection.runId === ref.runId) &&
      record?.clientRequestId === ref.clientRequestId &&
      Date.parse(record.recordedAt) <= Date.parse(evidence.inspectedAt) &&
      (!evidence.history.cancellation ||
        (evidence.history.cancellation.releasedUnits === evidence.reservedUnits &&
          evidence.history.cancellation.recordedAt === evidence.history.finalizedAt &&
          evidence.history.cancellation.clientRequestId !==
            evidence.history.reservation.clientRequestId)) &&
      (kind !== "reservation" ||
        original.selection.companyRevision === evidence.reservationCompanyRevision)
    );
  }
  function load(): { active: T | null; archives: RequestArchive<T>[] } {
    const raw = storage.getItem(key);
    if (!raw) return { active: null, archives: [] };
    if (new TextEncoder().encode(raw).byteLength > 256 * 1024) throw Error("HISTORY_STORAGE");
    const value = JSON.parse(raw);
    if (value.version === 1) return { active: schema.parse(value), archives: [] };
    const envelope = envelopeSchema.parse(value);
    const ids = new Set<string>();
    for (const entry of envelope.archives) {
      if (!matching(entry.original, entry.evidence) || ids.has(entry.original.registrationId))
        throw Error("HISTORY_STORAGE");
      ids.add(entry.original.registrationId);
    }
    if (envelope.active && ids.has(envelope.active.registrationId)) throw Error("HISTORY_STORAGE");
    return envelope;
  }
  function persist(active: T | null, archives: RequestArchive<T>[]) {
    const value = archives.length ? envelopeSchema.parse({ version: 2, active, archives }) : active;
    if (value === null) {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw Error("HISTORY_STORAGE");
      return;
    }
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).byteLength > 256 * 1024) throw Error("HISTORY_STORAGE");
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw Error("HISTORY_STORAGE");
  }
  return Object.freeze({
    load,
    save(active: T) {
      const current = load();
      if (
        current.archives.some((e) => e.original.registrationId === active.registrationId) ||
        (current.active &&
          (current.active.registrationId !== active.registrationId ||
            canonical(current.active.selection) !== canonical(active.selection) ||
            (current.active.attempted && !active.attempted)))
      )
        throw Error("HISTORY_CHANGED");
      persist(schema.parse(active), current.archives);
    },
    clear(original: T) {
      const current = load();
      if (canonical(current.active) !== canonical(original)) throw Error("HISTORY_CHANGED");
      persist(null, current.archives);
    },
    archive(original: T, raw: ReservationView) {
      const current = load();
      if (canonical(current.active) !== canonical(original)) throw Error("HISTORY_CHANGED");
      if (current.archives.length >= 20) throw Error("HISTORY_FULL");
      const view = decodeReservationView(raw, {
        id: original.selection.companyId,
        revision: raw.companyRevision,
      });
      const ref = original.requestReference,
        row = view.reservations.find((r) => r.runId === ref?.runId);
      if (!row) throw Error("HISTORY_UNCONFIRMED");
      const evidence = evidenceSchema.parse({
        companyId: view.companyId,
        runId: row.runId,
        inspectedAt: view.inspectedAt,
        observedCompanyRevision: view.companyRevision,
        reservationCompanyRevision: row.companyRevision,
        currency: row.currency,
        unitScale: row.unitScale,
        reservedUnits: row.reservedUnits,
        history: row.history,
      });
      if (!matching(original, evidence)) throw Error("HISTORY_UNCONFIRMED");
      const archives = [...current.archives, { original: structuredClone(original), evidence }];
      persist(null, archives);
      return archives;
    },
  });
}

/** Exact owner absence is required on both sides of the fresh audited read. */
export async function requireMissingComparisonOwner(inspect: () => Promise<unknown>) {
  try {
    await inspect();
  } catch (error) {
    if (error instanceof Error && error.message === "OWNER_UNAVAILABLE") return;
    throw error;
  }
  throw Error("HISTORY_OWNER_PRESENT");
}
export function archiveFailure(error: unknown) {
  if (error instanceof Error && error.message === "HISTORY_OWNER_PRESENT")
    return "원래 서버 연결이 남아 있습니다. 원래 기록 확인과 연결 정리를 먼저 사용하세요.";
  if (error instanceof Error && error.message === "HISTORY_FULL")
    return "이 탭의 보관 한도 20건에 도달했습니다. 기존 기록과 활성 요청을 보존합니다.";
  return "요청을 보관하지 못했습니다. 원래 연결·기록·브라우저 저장 상태를 확인하세요. 미확인 요청으로 새 작업을 시작하지 않습니다.";
}
