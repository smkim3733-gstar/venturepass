"use client";
import { useId, useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import { readManualPublicEvidence } from "@/lib/studio-public-evidence-export";
import { bookingConsents } from "@/lib/studio-comparison-booking-wire";
import { executionAmount } from "@/lib/studio-comparison-execution-client";
import { useComparisonBooking } from "./comparison-booking-provider";
import { PublicClaimPreviewResult } from "./public-claim-preview";
import { Notice, selectClass } from "./shared";
export function ComparisonBooking({ company, blocked }: { company: StudioCase; blocked: boolean }) {
  const { client, state } = useComparisonBooking(),
    id = useId();
  const [open, setOpen] = useState(false),
    [recordId, setRecordId] = useState(""),
    [sources, setSources] = useState<string[]>([]),
    [consents, setConsents] = useState<string[]>([]);
  useLayoutEffect(() => {
    client.invalidate();
    return () => client.invalidate();
  }, [client, company, blocked]);
  const record = company.claimReviews?.find((r) => r.id === recordId),
    review = state.status?.review;
  const ready =
    !!review &&
    state.snapshot === company &&
    !!state.input &&
    !blocked &&
    !state.routing?.attempted;
  function clear() {
    client.invalidate();
    setConsents([]);
  }
  return (
    <details open={open} className="min-w-0 rounded-xl border p-4">
      <summary
        className="flex min-h-11 cursor-pointer items-center font-semibold"
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
          clear();
        }}
      >
        공개 근거 비교 새 예약 (선택)
      </summary>
      {open && (
        <div className="mt-4 min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-busy={state.busy}>
          <Notice>
            저장된 주장과 공개 발췌를 선택해 비용 상한·보관 조건을 검토합니다. 예약을 확정하면 선택
            내용과 요청이 로컬 원장에 보관되고 예산이 확보됩니다. 외부 전송은 별도 승인이
            필요합니다.
          </Notice>
          <fieldset
            disabled={blocked || state.busy || !!state.routing?.attempted}
            className="min-w-0 space-y-3"
          >
            <div className="space-y-1">
              <label htmlFor={id + "-claim"}>새 예약의 저장 주장 버전</label>
              <select
                id={id + "-claim"}
                className={selectClass + " min-h-11"}
                value={recordId}
                onChange={(e) => {
                  clear();
                  setRecordId(e.target.value);
                  setSources([]);
                }}
              >
                <option value="">직접 선택하세요</option>
                {[...(company.claimReviews ?? [])].reverse().map((r) => (
                  <option key={r.id} value={r.id}>
                    v{r.version} · {r.claimQuote}
                  </option>
                ))}
              </select>
            </div>
            {record && (
              <fieldset className="space-y-2">
                <legend className="text-sm">새 예약에 포함할 공개 근거 (1~10개)</legend>
                {record.references.map((ref) => {
                  const source = company.sources.find((s) => s.id === ref.sourceId);
                  const supported =
                    !!source &&
                    source.originalName === null &&
                    source.mimeType === null &&
                    !!readManualPublicEvidence(source);
                  return (
                    <label className="flex min-h-11 items-center gap-2 text-sm" key={ref.sourceId}>
                      <input
                        type="checkbox"
                        checked={sources.includes(ref.sourceId)}
                        disabled={
                          !supported || (!sources.includes(ref.sourceId) && sources.length >= 10)
                        }
                        onChange={(e) => {
                          clear();
                          setSources(
                            e.target.checked
                              ? [...sources, ref.sourceId]
                              : sources.filter((s) => s !== ref.sourceId),
                          );
                        }}
                      />
                      <span>
                        {source?.name ?? ref.sourceId}
                        {!supported && " · 수동 공개 발췌 형식 미지원"}
                      </span>
                    </label>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  선택 {sources.length}개 · 제외 {record.references.length - sources.length}개.
                  제외한 자료는 ID만 포함합니다.
                </p>
              </fieldset>
            )}
            <Button
              className="min-h-11"
              disabled={!record || !sources.length}
              onClick={() => {
                setConsents([]);
                if (record)
                  void client.prepare(company, {
                    companyId: company.id,
                    companyRevision: company.revision,
                    claimRecordId: record.id,
                    claimVersion: record.version,
                    claimInputDigest: record.inputDigest,
                    sourceIds: sources,
                  });
              }}
            >
              예약 내용·비용 검토
            </Button>
          </fieldset>
          {blocked && <Notice>원고·주장 편집 또는 저장을 마친 뒤 새 예약을 검토해 주세요.</Notice>}
          {state.message && (
            <p role="status" className="text-sm">
              {state.message}
            </p>
          )}
          {state.routing && (
            <p className="text-xs text-muted-foreground">
              원래 회사 {state.routing.selection.companyId} · v
              {state.routing.selection.companyRevision}
              {state.routing.selection.companyId !== company.id &&
                " · 현재 화면과 다른 회사의 연결입니다."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={state.busy}
              onClick={() => {
                setConsents([]);
                void client.inspect();
              }}
            >
              원래 예약 상태 조회
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={state.busy || !state.routing?.attempted}
              onClick={() => {
                setConsents([]);
                void client.recover();
              }}
            >
              원래 예약 기록 확인
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={state.busy || !state.routing}
              onClick={() => {
                setConsents([]);
                void client.close();
              }}
            >
              예약 연결 정리
            </Button>
          </div>
          {state.status && (
            <p className="text-sm">
              예약 연결 상태:{" "}
              {
                {
                  unused: "검토 전",
                  review: "검토됨",
                  attempted: "기록 확인 필요",
                  recorded: "예약 기록 확인됨",
                  "not-observed": "원래 기록 미관측",
                  blocked: "기록 차단",
                  failed: "연결 확인 필요",
                  closed: "정리 완료",
                  draining: "정리 재시도 필요",
                }[state.status.status]
              }
              {state.status.revoked && " · 설정 변경으로 새 예약 차단"}
            </p>
          )}
          {state.status?.receipt && (
            <Notice>
              <strong>예약 기록 확인</strong>
              <p>예약 번호 {state.status.receipt.runId}</p>
              <p>
                먼저 예약 연결 정리를 완료하세요. 서버 입력 준비 절차에서 이 번호를 지정한 뒤, 아래
                실행 화면에서 비용·전송 내용을 다시 확인하세요. 현재 화면의 선택으로 서버 실행
                입력이 바뀌지 않습니다.
              </p>
            </Notice>
          )}
          {ready && (
            <section
              aria-label="새 예약 검토"
              className="min-w-0 space-y-3 rounded-lg bg-muted/40 p-3"
            >
              <p>
                서버 지정 모델 {review.request.model} · 검토 만료{" "}
                {new Date(review.expiresAt).toLocaleString("ko-KR")}
              </p>
              <p className="font-semibold">
                새 예약 상한 {executionAmount(review.costs.reservedUnits, review.costs.unitScale)}{" "}
                {review.costs.currency}
              </p>
              <p className="text-sm">
                사용 가능 예산{" "}
                {executionAmount(review.budget.availableUnits, review.budget.unitScale)}{" "}
                {review.budget.currency} · 현재 보유{" "}
                {executionAmount(review.budget.heldUnits, review.budget.unitScale)}{" "}
                {review.budget.currency}
              </p>
              <Notice>{review.notice}</Notice>
              <p className="whitespace-pre-wrap text-sm">
                로컬 보관: {review.retention.localNotice}
              </p>
              <p className="whitespace-pre-wrap text-sm">
                공급자 보관: {review.retention.providerNotice}
              </p>
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center">
                  서버 정책 검토 근거
                </summary>
                {review.sources.map((s, i) => (
                  <div key={i} className="my-3 space-y-1 text-sm">
                    <p>{s.title}</p>
                    <p>{s.url}</p>
                    <p className="whitespace-pre-wrap">{s.excerpt}</p>
                    <p>
                      검토 {s.reviewedAt} · 유효기한 {s.validUntil}
                    </p>
                  </div>
                ))}
              </details>
              <PublicClaimPreviewResult view={state.input!} reserved />
              <fieldset disabled={state.busy} className="space-y-2">
                <legend className="font-semibold">새 예약 개별 동의</legend>
                {bookingConsents.map(([key, label]) => (
                  <label key={key} className="flex min-h-11 items-start gap-2 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={consents.includes(key)}
                      onChange={(e) =>
                        setConsents(
                          e.target.checked ? [...consents, key] : consents.filter((c) => c !== key),
                        )
                      }
                    />
                    <span>{label}</span>
                  </label>
                ))}
                <Button
                  className="min-h-11"
                  disabled={consents.length !== bookingConsents.length}
                  onClick={() => {
                    const consent = {
                      reviewDigest: review.reviewDigest,
                      ...Object.fromEntries(consents.map((c) => [c, true])),
                    };
                    setConsents([]);
                    void client.reserve(company, consent);
                  }}
                >
                  동의한 내용으로 예약 기록
                </Button>
              </fieldset>
            </section>
          )}
        </div>
      )}
    </details>
  );
}
