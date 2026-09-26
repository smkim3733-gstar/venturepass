"use client";

import { ArrowRight, History, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { VentureExecutionRecord } from "@/lib/venturein-execution-schema";
import type { VentureWorkflowStatus } from "@/lib/venturein-workflow";
import { formatDate, Notice } from "./shared";

const steps = [
  { phase: "connect", label: "로그인 연결" },
  { phase: "inspect", label: "화면 읽기" },
  { phase: "map", label: "항목 연결" },
  { phase: "review", label: "선택 입력 점검" },
  { phase: "execute", label: "검토·승인·실행" },
  { phase: "verify", label: "결과 확인" },
  { phase: "handoff", label: "공식 화면 확인" },
] as const;

function executionLabel(execution: VentureExecutionRecord | null) {
  if (!execution) return "실행 기록 없음";
  if (execution.code === "INPUT_RESULT_UNKNOWN") return "실행 결과 미확인";
  if (execution.status === "running") return "실행 결과 확인 필요";
  return execution.status === "completed" ? "선택 항목 화면 값·첨부 상태 확인" : "실행 중단";
}

export function VentureinJourneyPanel({
  journey,
  currentSnapshotId,
  canReadNext,
  readNextBlockedReason,
  onReadCurrent,
}: {
  journey?: VentureWorkflowStatus["journey"] | null;
  currentSnapshotId: string | null;
  canReadNext: boolean;
  readNextBlockedReason: string;
  onReadCurrent: () => void;
}) {
  if (!journey) {
    return (
      <section aria-label="신청 화면별 진행 상태">
        <Notice>
          진행 이력을 아직 불러오지 못했습니다. ‘점검 결과 새로고침’을 눌러 최신 상태를 확인해
          주세요.
        </Notice>
      </section>
    );
  }
  const entries = [...journey.entries]
    .sort((one, two) => Date.parse(two.observedAt) - Date.parse(one.observedAt))
    .slice(0, 12);

  return (
    <section aria-label="신청 화면별 진행 상태" className="space-y-4 rounded-2xl border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <ArrowRight className="size-4 text-primary" />
        <h3 className="font-bold">신청 화면별 진행 상태</h3>
      </div>
      <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
        {steps.map((step, index) => (
          <li
            key={step.phase}
            aria-current={journey.phase === step.phase ? "step" : undefined}
            className={`rounded-lg border p-3 leading-5 ${journey.phase === step.phase ? "border-primary/30 bg-primary/5 font-semibold text-primary" : "text-muted-foreground"}`}
          >
            <span className="mr-1">{index + 1}.</span>
            {step.label}
            {journey.phase === step.phase && <span className="mt-1 block">현재 단계</span>}
          </li>
        ))}
      </ol>
      <p role="status" className="text-sm leading-6">
        {journey.message}
      </p>
      <Notice>
        이번 선택 항목의 입력·첨부 결과를 공식 Edge 창에서 확인하세요. 다음 단계가 필요하면 공식
        사이트에서 직접 이동한 뒤 ‘다음 화면 연결’을 누르세요. 이 버튼은 현재 열린 화면을 읽으며,
        다음·저장·동의·제출 버튼을 누르지 않습니다.
      </Notice>
      <div className="space-y-2">
        <Button type="button" variant="outline" disabled={!canReadNext} onClick={onReadCurrent}>
          <RefreshCw />
          다음 화면 연결
        </Button>
        {!canReadNext && (
          <p className="text-xs leading-6 text-muted-foreground">{readNextBlockedReason}</p>
        )}
      </div>
      <details className="rounded-xl border p-4" open={entries.length > 0}>
        <summary className="cursor-pointer text-sm font-semibold">
          <History className="mr-2 inline size-4" />
          최근 읽은 화면 이력 · {entries.length}개
        </summary>
        {entries.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            공식 화면을 읽으면 이곳에 기록됩니다.
          </p>
        ) : (
          <ol className="mt-4 space-y-3">
            {entries.map((entry) => {
              const execution = entry.execution;
              const fileKeys = new Set(execution?.attachmentFieldKeys ?? []);
              const completedFiles =
                execution?.completedFieldKeys.filter((key) => fileKeys.has(key)).length ?? 0;
              const completedText = (execution?.completedFieldKeys.length ?? 0) - completedFiles;
              return (
                <li
                  key={entry.id}
                  className="space-y-2 rounded-lg bg-muted/30 p-3 text-xs leading-6"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="break-words font-semibold">{entry.title || "공식 벤처인 화면"}</p>
                    <div className="flex flex-wrap gap-2">
                      {entry.snapshotId === currentSnapshotId && (
                        <Badge variant="outline">현재 연결</Badge>
                      )}
                      <Badge variant="outline">{executionLabel(execution)}</Badge>
                    </div>
                  </div>
                  <p>
                    {formatDate(entry.observedAt)} · 일반 항목 {entry.fieldCount}개 · 첨부 입력란{" "}
                    {entry.attachmentCount}개
                  </p>
                  <p className="break-all text-muted-foreground">{entry.url}</p>
                  {execution && (
                    <p>
                      확인된 항목: 텍스트 {completedText}개 · 첨부 {completedFiles}개
                      {execution.finishedAt ? ` · ${formatDate(execution.finishedAt)}` : ""}
                    </p>
                  )}
                  {execution?.code === "INPUT_RESULT_UNKNOWN" && (
                    <p className="font-medium text-amber-900">
                      일부 또는 모든 값·파일이 이미 전송됐을 수 있습니다. 확인 0개가 미전송을 뜻하지
                      않으므로 공식 화면을 직접 확인하세요.
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </details>
      <p className="text-xs leading-6 text-muted-foreground">
        선택 항목의 화면 확인 이력입니다. 전체 필수 항목이나 약관·동의가 완료됐다는 뜻이 아닙니다.
        기관의 저장·접수·심사 완료를 증명하지 않습니다.
      </p>
    </section>
  );
}
