"use client";
import type { StudioCase } from "@/lib/studio-schema";
import {
  guidedApplicationHistory,
  type GuidedApplicationTarget,
} from "@/lib/studio-guided-applications";
import { Button } from "@/components/ui/button";

export function GuidedApplicationHistory({
  company,
  disabled,
  onNavigate,
}: {
  company: StudioCase;
  disabled: boolean;
  onNavigate: (target: GuidedApplicationTarget) => void;
}) {
  const history = guidedApplicationHistory(company);
  if (!company.applications.length && !company.applicationEvents.length) return null;
  return (
    <details
      key={`${company.id}:${company.revision}`}
      className="rounded-xl border p-4"
      aria-label="신청 회차·제출 기록 요약"
    >
      <summary className="cursor-pointer font-semibold">신청 회차·제출 기록 보기</summary>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        담당자가 남긴 수동 기록입니다. 제출했다고 기록한 날짜와 앱에 기록한 시각을 구분합니다.
        벤처인 입력 결과·접수 기록 연결은 공식 접수나 심사 결과 확인이 아닙니다.
      </p>
      <p className="text-xs leading-6">공식 확인 시각 없음 · 자동 조회 미연결</p>
      {history.needsInspection && (
        <p role="status" className="mt-3 text-sm">
          신청 이력의 연결을 확인해야 합니다. 기관 안내와 진행 기록 화면에서 원래 이력을 확인해
          주세요.
        </p>
      )}
      {history.cycles.map((cycle) => (
        <section key={cycle.id} className="mt-4 space-y-3 rounded-lg border p-3 break-words">
          <h4 className="font-semibold">{cycle.title}</h4>
          <p className="text-xs">
            {cycle.kind === "new" ? "신규" : "재확인"} · 예정일 {cycle.plannedOn || "미기재"} ·
            담당자 기록
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || history.needsInspection}
            onClick={() => onNavigate(cycle.target)}
          >
            이 회차 기록 보기
          </Button>
          {!cycle.submissions.length && (
            <p className="text-sm">
              제출했다고 보관한 기록 없음 · 실제 미제출을 증명하지 않습니다.
            </p>
          )}
          {cycle.submissions.map((item) => (
            <div key={item.id} className="space-y-2 border-t pt-3 text-sm">
              <p>
                제출했다고 기록한 날짜: {item.occurredOn} · 기록 v{item.version}
              </p>
              <p className="text-xs">앱 기록 시각: {item.recordedAt}</p>
              <p>
                당시 원고 v{item.planVersion} · {item.receipt}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || history.needsInspection}
                onClick={() => onNavigate(item.target)}
              >
                이 제출 기록의 원고·접수 근거 보기
              </Button>
            </div>
          ))}
        </section>
      ))}
    </details>
  );
}
