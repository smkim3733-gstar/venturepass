"use client";
import { useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import { createReservationClient } from "@/lib/studio-comparison-reservations-client";
import { executionAmount } from "@/lib/studio-comparison-execution-client";
import { Notice, selectClass } from "./shared";
import { ComparisonCancellation } from "./comparison-cancellation";
import { ComparisonInputPreparation } from "./comparison-input-preparation";
import { useComparisonBooking } from "./comparison-booking-provider";
import { useComparisonCancellation } from "./comparison-cancellation-provider";
import type { ReservationView } from "@/lib/studio-comparison-reservations-wire";

const inputLabels = {
  "not-configured": "실행 입력 파일이 아직 지정되지 않았습니다.",
  unavailable: "실행 입력 파일을 확인하지 못했습니다. 운영 준비 경로에서 파일을 확인해 주세요.",
  "other-company": "서버의 실행 입력은 다른 회사의 예약입니다.",
  "different-revision": "서버의 실행 입력과 현재 회사 버전이 다릅니다.",
  "missing-reservation": "서버의 실행 입력에 지정된 예약을 이 회사 기록에서 찾지 못했습니다.",
  matched: "서버의 실행 입력에 지정된 예약이 현재 회사 버전의 기록과 일치합니다.",
};
const eventLabels = {
  reserved: "예약 기록",
  "dispatch-recorded": "전송 기록",
  "dispatch-unknown": "전송 결과 미확인",
  cancelled: "취소 기록",
  "response-captured": "응답 보관",
  "comparison-recorded": "비교 의견 보관",
  "usage-assessed": "사용량 평가",
  "cost-settled": "비용 정산 기록",
  finalized: "기록 종결",
};
export function ComparisonReservations({
  company,
  blocked,
}: {
  company: StudioCase;
  blocked: boolean;
}) {
  const id = useId();
  const booking = useComparisonBooking(),
    cancellation = useComparisonCancellation();
  const [match, setMatch] = useState<{
    view: ReservationView;
    messages: string[];
    routing: string;
  } | null>(null);
  const [client] = useState(() => createReservationClient((...args) => window.fetch(...args)));
  const [archiveMessage, setArchiveMessage] = useState<{
    company: StudioCase;
    message: string;
  } | null>(null);
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useLayoutEffect(() => {
    client.invalidate();
    return () => {
      client.invalidate();
      booking.client.invalidate();
      cancellation.client.invalidate();
    };
  }, [client, company, blocked, booking.client, cancellation.client]);
  const archiveBusy = state.busy || booking.state.busy || cancellation.state.busy;
  const current = !blocked && state.snapshot === company ? state.view : null;
  const routing = JSON.stringify([booking.state.routing, cancellation.state.routing]);
  const row = current?.reservations.find((r) => r.runId === state.selected);
  return (
    <section
      aria-label="회사별 기존 비교 예약"
      aria-busy={state.busy}
      className="min-w-0 space-y-3 rounded-lg border p-3"
    >
      <h4 className="font-semibold">회사별 기존 예약 확인</h4>
      <p>
        작성 항목과 예약 상태를 확인하세요. 여기서 살펴볼 예약을 선택해도 아래 실행 등록은 서버에
        준비된 예약을 사용합니다.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={blocked || state.busy}
          onClick={() => void client.load(company)}
        >
          기존 예약 목록 불러오기
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={state.busy}
          onClick={() => void client.cleanup(company)}
        >
          예약 조회 연결 정리
        </Button>
      </div>
      <p role="status" aria-live="polite">
        {state.message}
      </p>
      {current && (
        <>
          <Notice>
            {inputLabels[current.input.status]}
            {current.input.runId && <> 예약 번호 {current.input.runId}.</>} 원고·근거·정책 유효성과
            실행 동의는 비용·전송 내용 확인에서 다시 검토합니다.
          </Notice>
          <Button
            type="button"
            variant="outline"
            disabled={state.busy}
            onClick={() => {
              const messages = [
                booking.client.matchHistory(current),
                cancellation.client.matchHistory(current),
              ];
              setMatch({
                view: current,
                messages,
                routing: JSON.stringify([
                  booking.client.getSnapshot().routing,
                  cancellation.client.getSnapshot().routing,
                ]),
              });
            }}
          >
            미확인 요청 기록 대조
          </Button>
          {match?.view === current && match.routing === routing && (
            <div
              role="status"
              aria-label="원래 요청 대조 결과"
              className="space-y-2 [overflow-wrap:anywhere]"
            >
              {match.messages.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
              <p>
                대조 기준: {new Date(current.inspectedAt).toLocaleString("ko-KR")} 조회 목록. 대조
                후에도 원래 연결과 시도 표시는 보존합니다.
              </p>
            </div>
          )}
          <div
            aria-label="확인된 요청 보관"
            className="space-y-2 rounded-md border p-3"
            aria-busy={archiveBusy}
          >
            <p>
              서버 연결이 사라진 요청은 원래 기록을 다시 대조한 뒤 이 탭에 보관할 수 있습니다. 보관
              후 새 작업에는 새 검토와 동의가 필요합니다.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={
                  archiveBusy ||
                  !booking.state.routing?.attempted ||
                  booking.state.routing.selection.companyId !== company.id
                }
                onClick={() =>
                  void booking.client
                    .archiveConfirmed(company)
                    .then(() =>
                      setArchiveMessage({ company, message: booking.client.getSnapshot().message }),
                    )
                }
              >
                확인된 예약 요청 보관
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  archiveBusy ||
                  !cancellation.state.routing?.attempted ||
                  cancellation.state.routing.selection.companyId !== company.id
                }
                onClick={() =>
                  void cancellation.client.archiveConfirmed(company).then(() =>
                    setArchiveMessage({
                      company,
                      message: cancellation.client.getSnapshot().message,
                    }),
                  )
                }
              >
                확인된 취소 요청 보관
              </Button>
            </div>
            <p role="status" aria-label="보관 처리 결과">
              {archiveMessage?.company === company ? archiveMessage.message : ""}
            </p>
          </div>
          {!!current.reservations.length && (
            <>
              <label className="block font-medium" htmlFor={id}>
                살펴볼 기존 예약
              </label>
              <select
                id={id}
                className={selectClass}
                value={state.selected}
                onChange={(e) => client.select(e.target.value)}
              >
                <option value="">예약을 직접 선택하세요</option>
                {current.reservations.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.sectionTitle} · {eventLabels[r.latestEventKind]} · {r.runId}
                  </option>
                ))}
              </select>
            </>
          )}
          {row && (
            <div className="space-y-2" aria-label="선택한 예약 정보">
              <p className="font-medium">
                {row.sectionTitle} · {row.model}
              </p>
              <p>예약 번호 {row.runId}</p>
              <div
                className="space-y-2 rounded-md border p-3 [overflow-wrap:anywhere]"
                role="region"
                aria-label="저장된 예약·취소 기록"
              >
                <h5 className="font-semibold">저장된 예약·취소 기록</h5>
                <p>마지막 원장 조회 {new Date(current.inspectedAt).toLocaleString("ko-KR")}</p>
                <p>
                  예약 기록 시각{" "}
                  {new Date(row.history.reservation.recordedAt).toLocaleString("ko-KR")}
                </p>
                <p className="text-xs">예약 요청 번호 {row.history.reservation.clientRequestId}</p>
                {row.history.cancellation ? (
                  <>
                    <p>
                      취소·종결 기록 시각{" "}
                      {new Date(row.history.cancellation.recordedAt).toLocaleString("ko-KR")}
                    </p>
                    <p>
                      취소로 해제된 예산 보유{" "}
                      {executionAmount(row.history.cancellation.releasedUnits, row.unitScale)}{" "}
                      {row.currency}
                    </p>
                    <p className="text-xs">
                      취소 요청 번호 {row.history.cancellation.clientRequestId}
                    </p>
                  </>
                ) : (
                  <p>
                    이번 원장 조회에서 취소 기록이 없습니다.{" "}
                    {row.history.finalizedAt
                      ? "다른 절차로 종결된 기록이며 취소·환불을 뜻하지 않습니다."
                      : "취소나 예산 해제로 처리하지 않습니다."}
                  </p>
                )}
                <Notice>
                  서버를 다시 시작한 뒤에도 저장된 기록을 조회합니다. 미확인 요청 기록 대조에서 쓰기
                  전에 저장한 서버 요청 번호와 예약 번호를 확인할 수 있습니다. 원래 연결·동의
                  복원이나 실제 청구 환불 확인은 별도입니다.
                </Notice>
              </div>
              <p>
                예약 당시 상한 {executionAmount(row.reservedUnits, row.unitScale)} {row.currency} ·
                실제 청구 대조 전
              </p>
              <p>
                마지막 기록: {eventLabels[row.latestEventKind]} · 회사 버전 {row.companyRevision}
                {row.companyRevisionMatches ? " (현재 버전과 일치)" : " (현재 버전과 다름)"}
              </p>
              <p>
                예약 만료: {new Date(row.expiresAt).toLocaleString("ko-KR")}
                {row.reservationExpired ? " (조회 시점에 만료됨)" : " (조회 시점에 기한 내)"}
              </p>
              <Notice
                tone={
                  current.input.status === "matched" && current.input.runId === row.runId
                    ? "info"
                    : "warning"
                }
              >
                {current.input.status === "matched" && current.input.runId === row.runId
                  ? "선택한 예약은 서버 실행 입력과 일치합니다."
                  : "선택한 예약은 현재 서버 실행 입력과 일치하지 않습니다. 운영 준비 경로에서 정확한 예약 번호와 입력 파일을 확인해 주세요."}{" "}
                목록 확인은 전송 가능성 확인이나 동의가 아닙니다.
              </Notice>
            </div>
          )}
        </>
      )}
      <details className="rounded-md border p-3">
        <summary className="flex min-h-11 cursor-pointer items-center">이 탭에 보관한 요청</summary>
        <p>
          요청 번호와 당시 확인 기록을 보존합니다. 현재 서버 상태나 연결 정리를 뜻하지 않습니다.
          탭을 닫으면 브라우저 보관은 사라질 수 있으며 원장 기록은 유지됩니다.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={archiveBusy}
          onClick={() => {
            void booking.client.showArchives();
            void cancellation.client.showArchives();
          }}
        >
          보관 기록 불러오기
        </Button>
        <ul aria-label="보관한 요청 목록" className="space-y-3 [overflow-wrap:anywhere]">
          {[
            { kind: "예약", entries: booking.state.archives },
            { kind: "취소", entries: cancellation.state.archives },
          ].flatMap(({ kind, entries }) =>
            entries
              .filter((e) => e.original.selection.companyId === company.id)
              .map((e) => (
                <li key={`${kind}:${e.original.registrationId}`}>
                  <p>
                    {kind} 요청 {e.original.requestReference!.clientRequestId}
                  </p>
                  <p>예약 번호 {e.original.requestReference!.runId}</p>
                  <p>
                    대조 시각 {new Date(e.evidence.inspectedAt).toLocaleString("ko-KR")} · 당시 회사
                    버전 {e.evidence.observedCompanyRevision}
                  </p>
                </li>
              )),
          )}
        </ul>
      </details>
      {row && (
        <ComparisonInputPreparation
          key={`input:${company.id}:${company.revision}:${blocked}:${state.selected}`}
          companyId={company.id}
          companyRevision={company.revision}
          runId={row.runId}
          eligible={
            row.companyRevisionMatches &&
            !row.reservationExpired &&
            row.latestEventKind === "reserved"
          }
          blocked={blocked || archiveBusy}
        />
      )}
      <ComparisonCancellation
        key={`${company.id}:${company.revision}:${blocked}:${state.selected}`}
        company={company}
        runId={row?.runId ?? ""}
        blocked={blocked || state.busy}
        onRecorded={() => client.invalidate()}
      />
    </section>
  );
}
