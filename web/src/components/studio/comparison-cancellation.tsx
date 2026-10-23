"use client";
import { useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import { executionAmount } from "@/lib/studio-comparison-execution-client";
import { useComparisonCancellation } from "./comparison-cancellation-provider";
import { Notice } from "./shared";
export function ComparisonCancellation({
  company,
  runId,
  blocked,
  onRecorded,
}: {
  company: StudioCase;
  runId: string;
  blocked: boolean;
  onRecorded: () => void;
}) {
  const { client, state } = useComparisonCancellation();
  const [consent, setConsent] = useState({ digest: "", cancel: false, retain: false });
  useLayoutEffect(() => {
    client.invalidate();
    return () => client.invalidate();
  }, [client, company, runId, blocked]);
  const review = state.status?.review,
    ready =
      !!review &&
      state.snapshot === company &&
      review.runId === runId &&
      !blocked &&
      !state.routing?.attempted;
  const agreed = consent.digest === review?.reviewDigest;
  return (
    <section
      aria-label="미전송 비교 예약 취소"
      aria-busy={state.busy}
      className="min-w-0 space-y-3 rounded-lg border p-3 [overflow-wrap:anywhere]"
    >
      <h4 className="font-semibold">미전송 예약 취소</h4>
      <p className="text-sm">
        위 목록에서 예약 한 건을 직접 선택하세요. 서버가 전송 기록이 없는지 확인한 뒤 취소할 수
        있습니다. 만료되거나 회사 버전이 달라진 예약도 원래 이력을 보존하며 검토합니다.
      </p>
      <Button
        className="min-h-11"
        variant="outline"
        disabled={blocked || state.busy || !runId || !!state.routing?.attempted}
        onClick={() => {
          setConsent({ digest: "", cancel: false, retain: false });
          void client.review(company, {
            companyId: company.id,
            companyRevision: company.revision,
            runId,
          });
        }}
      >
        선택 예약 취소 검토
      </Button>
      {state.message && <p role="status">{state.message}</p>}
      {state.routing && (
        <p className="text-xs">
          원래 회사 {state.routing.selection.companyId} · 원래 예약 {state.routing.selection.runId}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-11"
          variant="outline"
          disabled={state.busy}
          onClick={() => {
            setConsent({ digest: "", cancel: false, retain: false });
            void client.inspect();
          }}
        >
          원래 취소 상태 조회
        </Button>
        <Button
          className="min-h-11"
          variant="outline"
          disabled={state.busy || !state.routing?.attempted}
          onClick={() =>
            void client.recover().then(() => {
              if (client.getSnapshot().status?.receipt) onRecorded();
            })
          }
        >
          원래 취소 기록 확인
        </Button>
        <Button
          className="min-h-11"
          variant="outline"
          disabled={state.busy || !state.routing}
          onClick={() => void client.close()}
        >
          취소 연결 정리
        </Button>
      </div>
      {state.status && (
        <p>
          취소 연결 상태:{" "}
          {
            {
              unused: "검토 전",
              review: "검토됨",
              attempted: "기록 확인 필요",
              recorded: "취소 기록 확인됨",
              "not-observed": "원래 기록 미관측",
              failed: "연결 확인 필요",
              draining: "정리 재시도 필요",
              closed: "정리 완료",
            }[state.status.status]
          }
          {state.status.revoked && " · 설정 변경으로 새 취소 차단"}
        </p>
      )}
      {state.status?.receipt && (
        <Notice>
          예약 {state.status.receipt.runId}의 취소·종결과 예산 보유{" "}
          {executionAmount(state.status.receipt.releasedUnits, state.status.receipt.unitScale)}{" "}
          {state.status.receipt.currency} 해제 기록을 확인했습니다. 원래 기록은 남으며 실제 청구
          환불 확인이 아닙니다. 취소 연결 정리 후 예약 목록을 다시 불러오세요.
        </Notice>
      )}
      {ready && (
        <div className="space-y-3" role="region" aria-label="취소 내용 검토">
          <p className="font-semibold">
            {review.sectionTitle} · {review.model}
          </p>
          <p>취소 대상 예약 {review.runId}</p>
          <p>
            예약 당시 회사 v{review.reservationCompanyRevision} · 현재 v{review.companyRevision}
          </p>
          <p>
            해제할 예산 보유 {executionAmount(review.releasedUnits, review.unitScale)}{" "}
            {review.currency}
          </p>
          <p>검토 만료 {new Date(review.expiresAt).toLocaleString("ko-KR")}</p>
          <Notice>{review.notice}</Notice>
          <fieldset disabled={state.busy} className="space-y-2">
            <legend className="font-semibold">취소 개별 동의</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={agreed && consent.cancel}
                onChange={(e) =>
                  setConsent((v) => ({
                    digest: review.reviewDigest,
                    cancel: e.target.checked,
                    retain: v.digest === review.reviewDigest && v.retain,
                  }))
                }
              />
              표시된 정확한 예약을 취소하고 예산 보유액을 해제합니다.
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={agreed && consent.retain}
                onChange={(e) =>
                  setConsent((v) => ({
                    digest: review.reviewDigest,
                    retain: e.target.checked,
                    cancel: v.digest === review.reviewDigest && v.cancel,
                  }))
                }
              />
              예약·취소 증거는 남으며 삭제나 실제 청구 환불이 아님을 확인했습니다.
            </label>
            <Button
              className="min-h-11"
              disabled={!agreed || !consent.cancel || !consent.retain}
              onClick={() => {
                setConsent({ digest: "", cancel: false, retain: false });
                void client
                  .cancel(company, {
                    reviewDigest: review.reviewDigest,
                    cancelReservationAcknowledged: true,
                    retainedEvidenceAcknowledged: true,
                  })
                  .then(() => {
                    if (client.getSnapshot().status?.receipt) onRecorded();
                  });
              }}
            >
              동의한 예약 취소 기록
            </Button>
          </fieldset>
        </div>
      )}
    </section>
  );
}
