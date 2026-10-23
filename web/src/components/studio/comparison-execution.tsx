"use client";
import { useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import {
  executionAcknowledgements,
  executionAmount,
  type ExecutionAcknowledgement,
} from "@/lib/studio-comparison-execution-client";
import { useComparisonExecution } from "./comparison-execution-provider";
import { PublicClaimPreviewResult } from "./public-claim-preview";
import { Notice } from "./shared";
import { ComparisonReservations } from "./comparison-reservations";

export function ComparisonExecution({
  company,
  blocked,
}: {
  company: StudioCase;
  blocked: boolean;
}) {
  const { client, state } = useComparisonExecution();
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    client.invalidateReview();
    return () => client.invalidateReview();
  }, [client, company, blocked, open]);
  const owner = state.owner,
    same = owner?.companyId === company.id && owner.companyRevision === company.revision;
  const visible = open && !blocked && same && state.snapshot === company;
  return (
    <details
      className="min-w-0 rounded-xl border p-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="min-h-11 cursor-pointer py-3 font-semibold"
        onClick={(event) => {
          // Native toggle events can coalesce on a rapid close/reopen. Commit each
          // explicit toggle so child metadata and review consent are invalidated.
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        예약한 공개 근거 비교 실행 (선택)
      </summary>
      {open && (
        <section
          aria-label="예약 비교 실행"
          aria-busy={state.busy}
          className="min-w-0 space-y-4 pt-4 text-sm [overflow-wrap:anywhere] [&_button]:min-h-11"
        >
          <p>
            서버에 준비된 기존 예약을 확인하고 직접 동의한 경우에만 외부 AI에 한 번 전송합니다. 이
            화면을 여는 것만으로 전송하지 않습니다.
          </p>
          {blocked && (
            <Notice>
              원고·주장 편집 또는 저장을 마친 뒤 검토해 주세요. 원래 실행의 상태 확인과 종료는
              가능합니다.
            </Notice>
          )}
          {owner && !same && (
            <Notice tone="warning">
              다른 회사 또는 이전 버전의 실행을 보관 중입니다. 회사 {owner.companyId} · 버전{" "}
              {owner.companyRevision}. 원래 상태를 확인하고 종료해 주세요.
            </Notice>
          )}
          <ComparisonReservations company={company} blocked={blocked || state.busy} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={state.busy || blocked || !!owner?.sessionId}
              onClick={() => void client.open(company)}
            >
              실행 등록·기존 연결 확인
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                state.busy ||
                blocked ||
                !same ||
                !owner?.sessionId ||
                owner.attempted ||
                state.closed
              }
              onClick={() => void client.preview(company)}
            >
              비용·전송 내용 확인
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy || !owner?.sessionId || state.closed}
              onClick={() => void client.command("inspect")}
            >
              실행 상태 확인
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy || !owner?.attempted || state.closed}
              onClick={() => void client.command("recover")}
            >
              원래 실행 복구 확인
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state.busy || !owner?.sessionId || state.closed}
              onClick={() => void client.command("close")}
            >
              실행 연결 종료
            </Button>
            {(state.closed || state.registrationFailed) && (
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={() => client.release()}
              >
                확인된 연결 기록 비우기
              </Button>
            )}
          </div>
          <p role="status" aria-live="polite">
            {state.message}
          </p>
          {state.status && (
            <Notice>
              {state.status.outcome === "returned"
                ? "실행 요청의 처리가 반환되었습니다. 사실 확인이나 비용 정산 완료를 의미하지 않습니다."
                : state.status.outcome === "failed"
                  ? "실행 처리를 확인하지 못했습니다. 재전송하지 말고 원래 복구 상태를 확인해 주세요."
                  : state.status.outcome === "pending"
                    ? "실행이 진행 중입니다. 잠시 뒤 상태 확인을 눌러 주세요."
                    : "아직 실행 결과가 없습니다."}
              {state.status.execution?.capturePersisted &&
                " 응답 캡처는 보관되었습니다. 아래에서 의견 보관과 비용 상태를 따로 확인하세요."}
              {(state.status.bodyCleanupRequired ||
                state.status.execution?.cleanupRequired ||
                state.status.status === "draining") &&
                " 원래 연결 정리가 필요합니다."}
            </Notice>
          )}
          {visible && state.prepared && state.input && (
            <ExecutionConsent key={state.prepared.review.reviewDigest} company={company} />
          )}
          {owner?.attempted && <Postcapture />}
          <p className="text-muted-foreground">
            새로고침 후에는 등록·기존 연결 확인을 눌러 원래 상태를 조회하세요. 이 탭에는 연결 번호만
            남고 검토 원문과 동의는 저장하지 않습니다.
          </p>
        </section>
      )}
    </details>
  );
}
function Postcapture() {
  const { client, state } = useComparisonExecution(),
    p = state.status?.postcapture,
    r = p?.review;
  const disabled =
    state.busy ||
    state.closed ||
    state.status?.status === "draining" ||
    state.status?.outcome === "pending";
  return (
    <section aria-label="응답 의견 보관과 비용 정산" className="space-y-3 rounded-lg border p-3">
      <h4 className="font-semibold">원래 응답의 의견 보관·비용 정산</h4>
      <p>
        회사·원고가 바뀌어도 원래 실행 {state.owner?.runId}의 기록을 처리합니다. AI 재호출 없이 로컬
        기록을 보관합니다.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={
          disabled || p?.record === "recovery-required" || p?.settlement === "recovery-required"
        }
        onClick={() => void client.command("postcapture-preview")}
      >
        최신 비용·보관 확인
      </Button>
      {r && (
        <>
          <p>
            의견 {r.comparisonRecorded ? "보관 확인" : "미보관"} · 비용{" "}
            {r.costSettled ? "정산 확인" : "미정산"} · 기록 {r.finalized ? "종결 확인" : "미종결"}
          </p>
          <p>
            {r.usageStatus === "known" && r.units !== null
              ? `관측 사용량 기준 ${executionAmount(r.units, r.unitScale)} ${r.currency}`
              : "사용량 미확인 — 비용 예약을 유지하며 정산할 수 없습니다."}
          </p>
          {r.hasPolicyViolations && (
            <Notice tone="warning">
              관측 사용량에 정책 위반 항목이 있습니다. 초과 비용도 원래 금액대로 기록합니다.
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={disabled || p?.record !== "unattempted" || r.comparisonRecorded}
              onClick={() => void client.postcapture("record-result")}
            >
              비교 의견 보관
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                disabled ||
                p?.settlement !== "unattempted" ||
                !r.comparisonRecorded ||
                r.costSettled ||
                r.finalized ||
                r.usageStatus !== "known" ||
                r.units === null
              }
              onClick={() => void client.postcapture("settle-finalize")}
            >
              표시된 비용 정산·기록 종결
            </Button>
          </div>
        </>
      )}
      {p &&
        (["record-result", "settle-finalize"] as const).map((operation) => {
          const status = operation === "record-result" ? p.record : p.settlement;
          const label = operation === "record-result" ? "의견 보관" : "비용 정산";
          return (
            status !== "unattempted" && (
              <div key={operation} className="space-y-2">
                <p>
                  {label}:{" "}
                  {status === "stored"
                    ? "원래 기록 확인"
                    : status === "blocked"
                      ? "처리 차단 — 기록 확인 필요"
                      : "결과 미확인 — 원래 기록 복구 필요"}
                </p>
                {status !== "stored" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={state.busy || state.closed || state.status?.outcome === "pending"}
                    onClick={() => void client.postcapture(operation, true)}
                  >
                    {label} 원래 기록 확인
                  </Button>
                )}
              </div>
            )
          );
        })}
      <p>
        정산은 로컬 비용 기록이며 실제 청구 대조·사실 확인·사람 검토 완료와 별개입니다. 보관된
        의견은 아래 ‘보관된 공개 근거 비교 결과’에서 조회하세요.
      </p>
    </section>
  );
}
function ExecutionConsent({ company }: { company: StudioCase }) {
  const { client, state } = useComparisonExecution(),
    p = state.prepared!;
  const [checks, setChecks] = useState<Partial<Record<ExecutionAcknowledgement, boolean>>>({});
  const costs = p.reservation.financialBasis.costs,
    done = Object.keys(executionAcknowledgements).every(
      (k) => checks[k as ExecutionAcknowledgement] === true,
    );
  const amount = (units: string) => `${executionAmount(units, costs.unitScale)} ${costs.currency}`;
  return (
    <div className="min-w-0 space-y-4">
      <h4 className="font-semibold">전송 전 비용·보관 안내</h4>
      <p className="text-base font-semibold">기존 예약 상한 {amount(costs.reservedUnits)}</p>
      <p>
        입력 {amount(costs.inputUnits)} + 출력 {amount(costs.outputUnits)} · 실제 청구액 확정 전이며
        비용 불명 시 예약을 유지합니다.
      </p>
      <p>
        모델 {p.review.basis.model} · 전송 대상 {p.review.basis.destination} · 1회 호출 · 검토 만료{" "}
        {p.review.expiresAt}
      </p>
      <p className="whitespace-pre-wrap">{p.review.basis.notice.text}</p>
      <p className="whitespace-pre-wrap">로컬 보관: {p.reservation.retentionNotice.localNotice}</p>
      <p className="whitespace-pre-wrap">
        공급자 보관: {p.reservation.retentionNotice.providerNotice}
      </p>
      <p>store:false는 공급자의 무보관을 보장하지 않습니다.</p>
      <details className="rounded-lg border p-3">
        <summary className="min-h-11 cursor-pointer py-3">요금·전송 정책의 검토 근거</summary>
        {[...p.reservation.financialBasis.evidence.sources, ...p.review.basis.sources].map(
          (source, i) => (
            <article key={i} className="space-y-2 border-t py-3">
              <p className="font-medium">{source.title}</p>
              <p>{source.url}</p>
              <p>
                검토일 {source.reviewedAt} · 유효기한 {source.validUntil}
              </p>
              <p className="whitespace-pre-wrap">{source.excerpt}</p>
            </article>
          ),
        )}
      </details>
      <PublicClaimPreviewResult view={state.input!} reserved />
      <fieldset disabled={state.busy || state.owner?.attempted} className="space-y-2">
        <legend className="mb-2 font-semibold">전송 동의 — 모두 직접 확인</legend>
        {(Object.entries(executionAcknowledgements) as [ExecutionAcknowledgement, string][]).map(
          ([key, label]) => (
            <label
              key={key}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0"
                checked={checks[key] === true}
                onChange={(event) => setChecks({ ...checks, [key]: event.target.checked })}
              />
              <span>{label}</span>
            </label>
          ),
        )}
        <Button type="button" disabled={!done} onClick={() => void client.execute(company, checks)}>
          동의한 내용으로 1회 실행
        </Button>
      </fieldset>
    </div>
  );
}
