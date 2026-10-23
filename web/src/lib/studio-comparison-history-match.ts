import { z } from "zod";
import type { ReservationView } from "./studio-comparison-reservations-wire";

export const comparisonRequestReferenceSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    runId: z.string().uuid(),
  })
  .strict();

/** Display-only attribution of an attempted request. Never a receipt, retry, or owner recovery. */
export function matchComparisonHistory(
  kind: "reservation" | "cancellation",
  routing: {
    selection: { companyId: string; companyRevision: number };
    attempted: boolean;
    requestReference?: z.infer<typeof comparisonRequestReferenceSchema>;
  } | null,
  view: ReservationView,
) {
  const label = kind === "reservation" ? "예약" : "취소";
  if (!routing || routing.selection.companyId !== view.companyId)
    return `이 회사의 미확인 ${label} 요청이 브라우저에 없습니다.`;
  if (!routing.attempted)
    return `${label} 쓰기를 시도한 기록이 없습니다. 검토만으로 완료 처리하지 않습니다.`;
  const ref = routing.requestReference;
  if (!ref)
    return `${label} 요청에 사전 저장된 서버 요청 번호가 없습니다. 과거 기록을 이번 요청의 결과로 대조할 수 없습니다.`;
  const row = view.reservations.find((r) => r.runId === ref.runId);
  const record = row?.history[kind];
  if (
    !row ||
    !record ||
    record.clientRequestId !== ref.clientRequestId ||
    (kind === "reservation" && row.companyRevision !== routing.selection.companyRevision)
  )
    return `이번 목록에서 원래 ${label} 요청과 일치하는 기록을 찾지 못했습니다. 실패나 미실행을 뜻하지 않으며 다시 보내지 않습니다.`;
  return `원래 ${label} 요청과 저장된 기록이 일치합니다. 예약 번호 ${ref.runId} · 요청 번호 ${ref.clientRequestId} · 기록 시각 ${new Date(record.recordedAt).toLocaleString("ko-KR")}. 연결이나 실행 동의를 복원하지 않습니다.`;
}
