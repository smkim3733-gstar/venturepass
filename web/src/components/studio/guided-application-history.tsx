"use client";
import type { StudioCase } from "@/lib/studio-schema";
import {
  guidedApplicationHistory,
  validGuidedApplicationTarget,
  type GuidedApplicationTarget,
} from "@/lib/studio-guided-applications";
import { isApplicationSubmission } from "@/lib/studio-application-types";
import { ApplicationSubmissionView } from "./application-history";
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
      key={`${company.id}:${company.revision}:${disabled}`}
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
              <GuidedSubmissionRead company={company} target={item.target} disabled={disabled} />
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

/** Resolve the original local address on each render; reading never selects an active plan. */
export function GuidedSubmissionRead({
  company,
  target,
  disabled,
}: {
  company: StudioCase;
  target: GuidedApplicationTarget;
  disabled: boolean;
}) {
  if (disabled) return <p className="text-sm">진행 중인 작업을 마친 뒤 보관 내용을 읽어 주세요.</p>;
  if (!target.submissionVersionId || !validGuidedApplicationTarget(company, target))
    return (
      <p className="text-sm">제출 기록의 연결을 확인하지 못했습니다. 원래 이력을 확인해 주세요.</p>
    );
  const matches = company.applicationEvents.filter(
    (record) => record.id === target.submissionVersionId && isApplicationSubmission(record),
  );
  const submission = matches[0];
  if (matches.length !== 1 || !isApplicationSubmission(submission)) return null;
  const receipts = company.agencyRecords.filter(
    (record) => record.id === submission.receiptRecordId,
  );
  // The shared view resolves a fixed ID. Never let it pick an ambiguous or unrelated record.
  if (
    receipts.length > 1 ||
    receipts.some(
      (record) =>
        (record.kind !== "notice" && record.kind !== "notice-correction") ||
        record.details.category !== "receipt",
    )
  )
    return <p className="text-sm">연결한 접수 기록 확인 필요 · 원래 이력을 확인해 주세요.</p>;
  return (
    <details
      key={`${company.id}:${company.revision}:${target.submissionVersionId}`}
      className="min-w-0 rounded-lg border p-3 [overflow-wrap:anywhere]"
      aria-label="제출 당시 보관 내용"
    >
      <summary className="cursor-pointer font-semibold">제출 당시 보관 내용 읽기</summary>
      <p className="my-3 text-sm leading-6 text-muted-foreground">
        당시 원고의 검토 상태·인용·원본 정보·담당자를 읽습니다. 원고 본문 전체나 기관 수신 증명은
        아니며, 현재 원고와 신청 준비 대상은 바뀌지 않습니다.
      </p>
      <ApplicationSubmissionView company={company} submission={submission} />
    </details>
  );
}
