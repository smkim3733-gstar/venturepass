"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { stageLabels, type StageRecord } from "@/lib/studio-schema";

export function StageHistory({ records }: { records: StageRecord[] }) {
  const [visibleCount, setVisibleCount] = useState(20);
  const recent = [...records].reverse().slice(0, visibleCount);
  return (
    <section className="mt-5 rounded-2xl border p-5" aria-label="진행 단계 기록">
      <h3 className="font-bold">
        진행 단계 기록 <span className="text-muted-foreground">{records.length}</span>
      </h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        담당자 기록과 앱의 자동 변경 이력입니다. 기관의 접수·납부·심사 결과를 자동 확인한 기록이
        아닙니다.
      </p>
      {!records.length && (
        <p className="mt-3 text-sm text-muted-foreground">
          아직 변경 이력이 없습니다. 기존 단계의 과거 이력은 추정해서 만들지 않습니다.
        </p>
      )}
      <ol className="mt-4 space-y-4">
        {recent.map((entry) => (
          <li key={entry.id} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {entry.origin === "manual" ? "담당자 기록" : "앱 자동 변경"}
              </Badge>
              <span className="text-sm font-semibold">
                {stageLabels[entry.from]} → {stageLabels[entry.to]}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              기록 시각 {new Date(entry.recordedAt).toLocaleString("ko-KR")}
              {entry.occurredOn
                ? ` · 담당자가 입력한 발생일 ${entry.occurredOn}`
                : " · 발생일 미기재"}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
              {entry.note || "근거 메모 미기재"}
            </p>
          </li>
        ))}
      </ol>
      {records.length > visibleCount && (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={() => setVisibleCount((count) => count + 20)}
        >
          이전 기록 더 보기
        </Button>
      )}
    </section>
  );
}
