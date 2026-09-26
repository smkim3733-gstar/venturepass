import { z } from "zod";
import {
  ventureExecutionRecordSchema,
  type VentureExecutionRecord,
} from "./venturein-execution-schema";
import { sanitizeVentureInspectionUrl } from "./venturein-inspection";
import type {
  VentureBoundSnapshot,
  VenturePreflightReport,
  VentureSubmissionDraft,
} from "./venturein-preflight";
import type { VentureSessionStatus } from "./venturein-schema";

export const ventureJourneyEntrySchema = z
  .object({
    id: z.string().min(1).max(200),
    snapshotId: z.string().min(1).max(200),
    url: z
      .string()
      .max(2000)
      .refine((url) => sanitizeVentureInspectionUrl(url) === url),
    title: z.string().max(200),
    observedAt: z.string().datetime(),
    fieldCount: z.number().int().min(0).max(150),
    attachmentCount: z.number().int().min(0).max(150),
    execution: ventureExecutionRecordSchema.nullable(),
  })
  .strict()
  .refine((entry) => !entry.execution || entry.execution.snapshotId === entry.snapshotId, {
    message: "다른 화면의 실행 기록입니다.",
  });
export const ventureJourneyHistorySchema = z.array(ventureJourneyEntrySchema).max(12);
export type VentureJourneyEntry = z.infer<typeof ventureJourneyEntrySchema>;
export type VentureJourney = {
  entries: VentureJourneyEntry[];
  phase: "connect" | "inspect" | "map" | "review" | "execute" | "verify" | "handoff";
  message: string;
};

/** A short local observation history, not evidence of agency receipt or submission. */
export function appendVentureJourney(
  history: VentureJourneyEntry[],
  snapshot: VentureBoundSnapshot | null,
  execution: VentureExecutionRecord | null,
): VentureJourneyEntry[] {
  if (!snapshot) return history;
  const screen = snapshot.screen;
  const entry = ventureJourneyEntrySchema.parse({
    id: screen.id,
    snapshotId: screen.id,
    url: screen.url,
    title: screen.title,
    observedAt: screen.observedAt,
    fieldCount: screen.fields.filter((field) => field.kind !== "file").length,
    attachmentCount: screen.fields.filter((field) => field.kind === "file").length,
    execution: execution?.snapshotId === screen.id ? execution : null,
  });
  const existing = history.findIndex((item) => item.snapshotId === screen.id);
  const next = [...history];
  if (existing >= 0) next[existing] = entry;
  else next.push(entry);
  return next.slice(-12);
}

export function buildVentureJourney(input: {
  history: VentureJourneyEntry[];
  snapshot: VentureBoundSnapshot | null;
  draft: VentureSubmissionDraft | null;
  execution: VentureExecutionRecord | null;
  session: VentureSessionStatus;
  report: VenturePreflightReport;
  companyRevision: number;
  accountRevision: number;
}): VentureJourney {
  const entries = appendVentureJourney(input.history, input.snapshot, input.execution);
  const result = (phase: VentureJourney["phase"], message: string) => ({ entries, phase, message });
  if (input.session.state !== "connected_unmapped" || !input.session.startedAt)
    return result(
      "connect",
      "벤처인 로그인 연결을 완료하세요. 이전 화면의 기록은 보관되지만 새 연결의 입력 승인으로 재사용하지 않습니다.",
    );
  if (
    !input.snapshot ||
    input.snapshot.sessionStartedAt !== input.session.startedAt ||
    input.snapshot.accountRevision !== input.accountRevision
  )
    return result("inspect", "현재 공식 화면을 읽어 신청기업과 항목을 확인하세요.");
  const execution =
    input.execution?.snapshotId === input.snapshot.screen.id ? input.execution : null;
  if (execution) {
    if (execution.status !== "completed" || execution.code === "INPUT_RESULT_UNKNOWN")
      return result(
        "verify",
        "마지막 입력·첨부 결과를 공식 화면에서 확인하세요. 같은 화면 기록으로 재실행하지 않습니다. 확인 후 현재 화면을 다시 연결하세요.",
      );
    return result(
      "handoff",
      "화면의 입력·첨부 값 확인을 마쳤습니다. 공식 사이트에서 다음 동작을 확인해 이동한 뒤 ‘다음 화면 연결’을 누르세요. 저장·동의·제출·접수 완료를 뜻하지 않습니다.",
    );
  }
  if (
    !input.draft ||
    input.draft.companyRevision !== input.companyRevision ||
    input.draft.snapshotId !== input.snapshot.screen.id ||
    input.draft.accountRevision !== input.accountRevision ||
    input.draft.sessionStartedAt !== input.session.startedAt
  )
    return result(
      "map",
      "현재 화면의 항목에 기업자료·원고·첨부 원본을 연결하고 의미와 용도를 확인하세요. 이전 화면의 확인은 새 화면에 적용하지 않습니다.",
    );
  if (input.report.inputReadiness?.ready !== true)
    return result(
      "review",
      "선택한 입력·첨부의 보완사항을 해결하세요. 기업 일치·자료·연결 확인을 유지하며 동의나 전체 제출 완료를 추정하지 않습니다.",
    );
  return result(
    "execute",
    "검토안을 준비해 전송할 값·파일·공식 주소를 확인한 뒤 선택한 항목의 실행을 승인할 수 있습니다. 남은 필수 항목·동의와 전체 제출 준비는 별도로 확인하세요.",
  );
}
