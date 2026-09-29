"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import type { ProviderTransmissionInspectionResponse } from "@/lib/studio-plan-quality-provider-transmission-http-types";
import type { ProviderTransmissionReview } from "@/lib/studio-plan-quality-provider-transmission-review-types";
import { qualityProviderMoney } from "./quality-provider-proposal-details";
import { policyOutboxKey } from "./quality-provider-policy-outbox";
import { reservationOutboxKey } from "./quality-provider-reservation-outbox";
import { transmissionOutboxKey } from "./quality-provider-transmission-outbox";
import {
  fetchProviderTransmissionInspection,
  qualityProviderTransmissionArchive,
} from "./quality-provider-transmission-ui";
const buttonClass = "h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words py-2";
const noop = () => undefined;
const blockers: Record<ProviderTransmissionReview["assessment"]["blockers"][number], string> = {
  "policy-superseded":
    "예약 후 이 후보의 채택 정책이 바뀌었습니다. 원래 예약과 현재 정책을 다시 확인해 주세요.",
  "run-not-reserved":
    "이미 승인·전송·종료 또는 취소 이력이 있어 첫 전송 승인 대상으로 사용할 수 없습니다.",
  "reservation-not-intact":
    "생성·검토 예약이 원래 금액으로 남아 있지 않습니다. 정산 기록을 확인해 주세요.",
  "budget-incompatible": "현재 예산의 통화 또는 금액 단위가 예약 근거와 다릅니다.",
  "budget-bound-breached": "운영 예산 또는 개별 호출의 비용 한도 초과를 먼저 확인해 주세요.",
};
const unavailable: Record<
  Extract<ProviderTransmissionInspectionResponse, { status: "unavailable" }>["reason"],
  string
> = {
  "configuration-missing-or-invalid":
    "공식 운영 설정을 확인하지 못했습니다. 설정을 확인한 뒤 다시 조회해 주세요.",
  "configuration-expired": "공식 운영 근거가 만료됐습니다. 근거를 갱신한 뒤 다시 조회해 주세요.",
  "configuration-changed":
    "예약 후 공식 설정이 바뀌었습니다. 원래 예약에 새 조건을 자동 적용하지 않습니다.",
  "selection-invalid": "선택한 예약 기록이 일치하지 않습니다. 보관 이력을 다시 읽어 주세요.",
  "archive-after-inspection":
    "현재 시각보다 미래의 기록이 있습니다. PC 시각과 기록을 확인해 주세요.",
  "production-reservation-required":
    "운영 예약 기록을 선택해 주세요. 합성 연결시험은 전송 대상이 아닙니다.",
  "reservation-binding-required":
    "이전 예약에 필요한 정책 연결 기록이 없습니다. 기존 기록을 전송 승인으로 사용하지 않습니다.",
  "reservation-expired": "원래 예약의 검토 기한이 지났습니다. 조회로 기한을 연장하지 않습니다.",
  "preparation-changed":
    "예약 당시 요청 조건과 현재 준비 규칙이 다릅니다. 예약 근거를 다시 확인해 주세요.",
};
export function QualityProviderTransmissionDetails({
  value,
  expired,
}: {
  value: ProviderTransmissionInspectionResponse;
  expired: boolean;
}) {
  if (value.status === "unavailable")
    return (
      <p role="status" className="text-sm leading-6">
        {unavailable[value.reason]}
      </p>
    );
  const v = value.review,
    b = v.budget,
    cost = v.financialBasis.costs;
  const money = (units: string) => qualityProviderMoney(units, b.unitScale!, b.currency!);
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p role="status" className="font-semibold">
        {expired
          ? "전송 검토 기한 경과 · 다시 조회 필요"
          : v.assessment.state === "conditions-met"
            ? "조회 당시 전송 검토 조건 충족 · 별도 승인 필요"
            : "전송 검토 보완 필요"}
      </p>
      <p>
        {v.scope.label} · 등록 v{v.scope.version} · 고정 모델 {v.request.model}
      </p>
      <p>
        현재 실행 기록 r{v.run.revision} · 예약 정책 r{v.policy.reservedReference.revision} · 현재
        후보 정책 {v.policy.currentReference ? `r${v.policy.currentReference.revision}` : "없음"}
      </p>
      {!!v.assessment.blockers.length && (
        <ul className="list-disc space-y-1 pl-5">
          {v.assessment.blockers.map((code) => (
            <li key={code}>{blockers[code]}</li>
          ))}
        </ul>
      )}
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        {[
          ["현재 누적 한도", money(b.capUnits)],
          ["확인된 사용 금액", money(b.recognizedUnits)],
          ["전체 미정산 예약", money(b.heldUnits)],
          ["현재 가용액", money(b.availableUnits)],
          [
            "이 실행의 남은 예약",
            qualityProviderMoney(v.reservation.heldUnits, cost.unitScale, cost.currency),
          ],
          [
            "원래 생성 / 검토 예약",
            `${qualityProviderMoney(v.reservation.generationUnits, cost.unitScale, cost.currency)} / ${qualityProviderMoney(v.reservation.reviewUnits, cost.unitScale, cost.currency)}`,
          ],
        ].map(([label, amount]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words font-medium [overflow-wrap:anywhere]">{amount}</dd>
          </div>
        ))}
      </dl>
      <p>
        이미 예약한 금액을 추가 차감하는 조회가 아닙니다. 비용 계산은 실제 토큰 적합성·계정
        접근·결과 품질을 보장하지 않습니다. 사용량이 확인되지 않으면 예약을 유지하며 자동 재시도하지
        않습니다.
      </p>
      <p className="break-words text-xs [overflow-wrap:anywhere]">
        조회 시각: {v.inspectedAt}
        <br />
        재확인 기한: {v.expiresAt}
        <br />
        원래 예약 기한: {v.run.preparationExpiresAt}
      </p>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="cursor-pointer">전송 범위·정확한 요청 내용</summary>
        <p className="my-3">
          목적지: https://api.openai.com/v1/responses
          <br />
          등록 합성 후보 한 건 · 생성 1회 + 검토 1회 · 자동 재시도 없음
        </p>
        <p>
          검토 요청은 같은 실행의 검증된 생성 결과를 받아 고정 문맥에 넣어 만듭니다. 아직 존재하지
          않는 검토 본문을 전송한 기록이 아닙니다.
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer">정확한 생성 요청</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
            {JSON.stringify(v.request.generation.body, null, 2)}
          </pre>
        </details>
        <details className="mt-3">
          <summary className="cursor-pointer">검토 요청의 고정 문맥과 파생 규칙</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
            {JSON.stringify(v.request.reviewTemplate, null, 2)}
          </pre>
        </details>
      </details>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="cursor-pointer">보관 안내·금융 근거·기록 연결</summary>
        <p className="my-3">{v.retention.notice}</p>
        <p>기한은 내부 재확인 기준이며 공급자의 가격 보증일이 아닙니다.</p>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
          {JSON.stringify(
            {
              financialBasis: v.financialBasis,
              retention: v.retention,
              manifest: v.manifest,
              policy: v.policy,
              reservation: v.reservation,
              archiveDigest: v.archiveDigest,
              reviewDigest: v.reviewDigest,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <p className="text-xs text-muted-foreground">
        조회 시점의 검토입니다. 기한이 남아 있어도 정책·예산·실행 기록이 바뀌면 다시 확인해야
        합니다. 조건 충족은 전송 승인이나 실행 완료를 뜻하지 않습니다.
      </p>
    </div>
  );
}

/** Read-only inspection; the independently mounted command panel owns explicit consent/recovery. */
export function QualityProviderTransmissionPanel({
  registry,
  snapshot,
  disabled,
  onBusyChange,
  onReviewChange = noop,
}: {
  registry: CandidateRegistrySnapshot;
  snapshot: ProviderSnapshot;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onReviewChange?: (
    value: ProviderTransmissionInspectionResponse | null,
    snapshotDigest: string,
  ) => void;
}) {
  const [value, setValue] = useState<ProviderTransmissionInspectionResponse | null>(null);
  const [working, setWorking] = useState(false),
    [expired, setExpired] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(false),
    sequence = useRef(0),
    busy = useRef(false),
    controller = useRef<AbortController | null>(null);
  const abandon = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
  }, []);
  const invalidate = useCallback(() => {
    abandon();
    setValue(null);
    onReviewChange(null, snapshot.snapshotDigest);
    setExpired(false);
    setError("");
  }, [abandon, onReviewChange, snapshot.snapshotDigest]);
  useEffect(() => {
    mounted.current = true;
    onReviewChange(null, snapshot.snapshotDigest);
    sequence.current++;
    const storage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === policyOutboxKey ||
        event.key === reservationOutboxKey ||
        event.key === transmissionOutboxKey
      )
        invalidate();
    };
    window.addEventListener("storage", storage);
    window.addEventListener("focus", invalidate);
    window.addEventListener("pageshow", invalidate);
    return () => {
      mounted.current = false;
      abandon();
      onReviewChange(null, snapshot.snapshotDigest);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", invalidate);
      window.removeEventListener("pageshow", invalidate);
    };
  }, [abandon, invalidate, onReviewChange, snapshot.snapshotDigest]);
  useEffect(() => {
    onBusyChange(working);
    return () => onBusyChange(false);
  }, [working, onBusyChange]);
  useEffect(() => {
    if (value?.status !== "review") return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(value.review.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value]);
  async function work(download = false) {
    if (disabled || busy.current || (download && !value)) return;
    busy.current = true;
    setWorking(true);
    setError("");
    const serial = ++sequence.current,
      active = () => mounted.current && serial === sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 30000);
    if (!download) {
      setValue(null);
      onReviewChange(null, snapshot.snapshotDigest);
      setExpired(false);
    }
    try {
      if (download) {
        const archive = await qualityProviderTransmissionArchive(value, registry, snapshot);
        if (!active() || abort.signal.aborted) return;
        const url = URL.createObjectURL(
          new Blob([archive.text], { type: "application/json;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = archive.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const result = await fetchProviderTransmissionInspection(registry, snapshot, abort.signal);
        if (active() && !abort.signal.aborted) {
          setValue(result);
          onReviewChange(result, snapshot.snapshotDigest);
        }
      }
    } catch {
      if (active()) {
        setValue(null);
        onReviewChange(null, snapshot.snapshotDigest);
        setError(
          "전송 검토를 확인하지 못했습니다. 보관 이력을 다시 읽거나 조회를 재시도해 주세요.",
        );
      }
    } finally {
      clearTimeout(timer);
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  return (
    <section
      aria-label="예약 실행 전송 검토"
      className="min-w-0 space-y-3 rounded-xl border bg-background p-4"
    >
      <h4 className="font-semibold">예약 실행 전송 검토</h4>
      <p className="text-sm leading-6 text-muted-foreground">
        위 보관 기록과 연결된 실행의 현재 정책·예산·상태를 새로 확인합니다. 조회와 다운로드로 AI
        전송이나 추가 비용 예약을 실행하지 않습니다.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          className={buttonClass}
          variant="outline"
          disabled={disabled || working}
          onClick={() => void work()}
        >
          {working ? "전송 검토 확인 중…" : value ? "전송 검토 다시 조회" : "전송 검토 조회"}
        </Button>
        {value && (
          <Button
            className={buttonClass}
            variant="outline"
            disabled={disabled || working}
            onClick={() => void work(true)}
          >
            전송 검토 조회본 JSON 내려받기
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {value && <QualityProviderTransmissionDetails value={value} expired={expired} />}
    </section>
  );
}
