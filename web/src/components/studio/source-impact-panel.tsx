"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  buildSourceImpact,
  sourceImpactKindLabels,
  sourceImpactLimit,
  sourceImpactReasonLabels,
  sourceImpactStateLabels,
  type SourceImpactDestination,
  type SourceImpactState,
} from "@/lib/studio-source-impact";
import type { StudioCase } from "@/lib/studio-schema";
import { Notice, selectClass } from "./shared";

export type SourceImpactNavigation = {
  caseId: string;
  revision: number;
  destination: SourceImpactDestination;
};
export function SourceImpactPanel({
  company,
  onNavigate,
  blockedReason = "",
}: {
  company: StudioCase;
  onNavigate: (input: SourceImpactNavigation) => void;
  blockedReason?: string;
}) {
  const result = useMemo(() => buildSourceImpact(company), [company]);
  const [sourceId, setSourceId] = useState("all");
  const [state, setState] = useState<SourceImpactState | "attention" | "all">("attention");
  const [shown, setShown] = useState(30);
  const unresolved =
    sourceId === "all" && (state === "attention" || state === "unknown" || state === "all")
      ? result.unresolved
      : [];
  const rows = result.groups
    .filter((group) => sourceId === "all" || group.sourceId === sourceId)
    .flatMap((group) => group.rows.map((row) => ({ group, row })))
    .filter(
      ({ row }) =>
        state === "all" || (state === "attention" ? row.state !== "current" : row.state === state),
    );
  const linked = result.counts.changed + result.counts.unknown + result.counts.current;
  return (
    <section
      className="mt-8 space-y-4 rounded-2xl border bg-white/60 p-4 sm:p-6"
      aria-labelledby="source-impact-title"
    >
      <div>
        <h2 id="source-impact-title" className="font-bold">
          자료 변경 영향 · 연결 대상 재확인
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          저장된 자료 ID·수정 시각·인용을 대조합니다. 관련 후보·원고 항목·주장·답변의 연결 목록이며,
          의미상 영향이나 사실의 진위를 자동 판정하지 않습니다.
        </p>
      </div>
      <Notice tone="info">
        ‘등록 버전·인용 일치’는 원본 파일·본문 전체·검토 완료를 보장하지 않습니다. 원본 바이트와
        SHA는 여기서 재검사하지 않습니다. 자료 버전이 없는 구형 인용은 문구가 같아도 정보
        부족입니다. 과거 기록과 제출 당시 기록은 그대로 보존되며, 새 버전 작성이나 재확인은 사용자가
        해당 화면에서 진행합니다.
      </Notice>
      <p className="text-sm">
        변경 확인 {result.counts.changed}개 · 정보 부족 {result.counts.unknown}개 · 등록 연결 일치{" "}
        {result.counts.current}개
      </p>
      {result.truncated && (
        <Notice tone="warning">
          연결 {sourceImpactLimit}개 표시 한도에 도달했습니다. 표시되지 않은 연결이 있으며 이 목록을
          전체 영향 없음의 근거로 사용할 수 없습니다.
        </Notice>
      )}
      {!linked && (
        <Notice tone="info">
          명시적으로 저장된 자료 연결을 찾지 못했습니다. 연결 없음은 영향 없음이나 검토 완료를
          뜻하지 않습니다.
        </Notice>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="source-impact-source">대조할 자료</Label>
          <select
            id="source-impact-source"
            className={selectClass}
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setShown(30);
            }}
          >
            <option value="all">모든 자료</option>
            {result.groups.map((group) => (
              <option key={group.sourceId} value={group.sourceId}>
                {group.sourceName} · 연결 {group.rows.length}개
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="source-impact-state">표시 상태</Label>
          <select
            id="source-impact-state"
            className={selectClass}
            value={state}
            onChange={(event) => {
              setState(event.target.value as typeof state);
              setShown(30);
            }}
          >
            <option value="attention">변경 확인·정보 부족</option>
            <option value="all">모든 상태</option>
            {Object.entries(sourceImpactStateLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {linked > 0 && rows.length === 0 && unresolved.length === 0 && (
        <p className="text-sm text-muted-foreground">
          선택한 필터에 해당하는 연결이 없습니다. 다른 상태·자료도 확인해 주세요.
        </p>
      )}
      <div className="space-y-3">
        {rows.slice(0, shown).map(({ group, row }) => (
          <article key={row.key} className="space-y-3 rounded-xl border bg-white p-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{sourceImpactStateLabels[row.state]}</Badge>
              <Badge variant="secondary">{sourceImpactKindLabels[row.target.kind]}</Badge>
              {row.historical && <Badge variant="outline">보존된 과거 기록</Badge>}
            </div>
            <h3 className="text-sm font-semibold">
              {group.sourceName} → {row.title}
            </h3>
            <p className="break-all text-xs text-muted-foreground">
              자료 ID {row.sourceId}
              <br />
              대상 ID {row.target.id}
              {row.target.version !== null ? ` · v${row.target.version}` : ""}
              {row.target.partId ? ` · 항목 ${row.target.partId}` : ""}
              {row.target.sectionKey ? ` · 원고 항목 ${row.target.sectionKey}` : ""}
            </p>
            <p className="text-xs">
              연결 시각 {row.recordedUpdatedAt || "미보관"} → 현재 자료 수정 시각{" "}
              {row.currentUpdatedAt || "확인 불가"}
            </p>
            {!!row.reasons.length && (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {row.reasons.map((reason) => (
                  <li key={reason}>{sourceImpactReasonLabels[reason]}</li>
                ))}
              </ul>
            )}
            {row.via && (
              <p className="break-all text-xs text-muted-foreground">
                명시한 보조 기록 경유: {sourceImpactKindLabels[row.via.kind]} · ID {row.via.id} · v
                {row.via.version}
                {row.via.partId ? ` · 항목 ${row.via.partId}` : ""}. 보조 기록 연결이며 주장 내용의
                진위 판정이 아닙니다.
              </p>
            )}
            {row.binding === "versioned-reference" && !row.quote && (
              <p className="text-xs text-muted-foreground">
                본문 인용 없이 등록된 자료 버전만 연결되어 있습니다. 원본 내용·주장 관계는 직접
                확인해야 합니다.
              </p>
            )}
            {(row.context === "stale" || row.context === "missing") && (
              <p className="text-xs text-amber-800">
                이 기록 전체의 다른 연결도 재확인이 필요합니다. 현재 자료 하나가 그 원인이라고
                단정하지 않습니다.
              </p>
            )}
            {row.excerpt && (
              <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap">
                대상 기재 일부: {row.excerpt}
              </blockquote>
            )}
            {row.quote && (
              <details>
                <summary className="cursor-pointer text-xs underline">
                  저장 인용 일부·위치 보기
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-sm">{row.quote}</p>
                <p className="mt-1 text-xs">{row.locator || "위치 미기재"}</p>
              </details>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(blockedReason)}
              onClick={() =>
                onNavigate({
                  caseId: result.caseId,
                  revision: result.revision,
                  destination: row.destination,
                })
              }
            >
              연결 대상 화면에서 재확인
            </Button>
          </article>
        ))}
      </div>
      {unresolved.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            자료를 특정할 수 없는 보조 기록 연결 {unresolved.length}개
          </h3>
          {unresolved.slice(0, shown).map((row) => (
            <article key={row.key} className="space-y-2 rounded-xl border bg-white p-4">
              <Badge variant="outline">{sourceImpactStateLabels.unknown}</Badge>
              <p className="text-sm">{sourceImpactReasonLabels[row.reason]}</p>
              <p className="break-all text-xs">
                주장 ID {row.target.id} · v{row.target.version} · 보조 기록 ID {row.via.id} · v
                {row.via.version}
              </p>
              <p className="text-xs text-muted-foreground">
                자료 ID나 영향 관계를 임의로 복원하지 않았습니다.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(blockedReason)}
                onClick={() =>
                  onNavigate({
                    caseId: result.caseId,
                    revision: result.revision,
                    destination: row.destination,
                  })
                }
              >
                연결 대상 화면에서 재확인
              </Button>
            </article>
          ))}
        </div>
      )}
      {rows.length > shown && (
        <Button type="button" variant="outline" onClick={() => setShown((value) => value + 30)}>
          연결 30개 더 보기 ({shown}/{rows.length})
        </Button>
      )}
      {unresolved.length > shown && (
        <Button type="button" variant="outline" onClick={() => setShown((value) => value + 30)}>
          자료 미확인 연결 더 보기 ({shown}/{unresolved.length})
        </Button>
      )}
      {blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
      <p className="text-xs text-muted-foreground">
        원고 항목의 인용만 있는 경우 특정 문장·표까지 추정하지 않습니다. 정확한 ID·버전으로 명시한
        수치·검토 기록 경유만 별도로 표시합니다. 인용이 없는 내용, 자료끼리의 의미 관계, 다른 원고를
        통한 간접 연결은 이 목록에서 자동 추론하지 않습니다.
      </p>
    </section>
  );
}
