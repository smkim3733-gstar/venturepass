"use client";

import { useEffect, useRef, useState } from "react";
import { ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  VentureInputComparison,
  VentureInputComparisonField,
} from "@/lib/venturein-execution-schema";
import { formatDate, Notice } from "./shared";

type ComparisonBinding = Pick<
  VentureInputComparison,
  "workflowRevision" | "companyRevision" | "accountRevision" | "snapshotId" | "sessionStartedAt"
>;

export function validateVentureInputComparison(
  comparison: VentureInputComparison,
  expected: ComparisonBinding,
  fields: Map<string, VentureInputComparisonField["kind"]>,
) {
  if (
    !comparison ||
    comparison.scope !== "current-mapping" ||
    !Number.isFinite(Date.parse(comparison.observedAt)) ||
    comparison.workflowRevision !== expected.workflowRevision ||
    comparison.companyRevision !== expected.companyRevision ||
    comparison.accountRevision !== expected.accountRevision ||
    comparison.snapshotId !== expected.snapshotId ||
    comparison.sessionStartedAt !== expected.sessionStartedAt ||
    fields.size === 0 ||
    !Array.isArray(comparison.fields) ||
    comparison.fields.length !== fields.size ||
    new Set(comparison.fields.map((field) => field?.fieldKey)).size !== fields.size ||
    comparison.fields.some(
      (field) =>
        !field ||
        fields.get(field.fieldKey) !== field.kind ||
        !["matched", "empty", "conflict", "unknown"].includes(field.state) ||
        (field.code !== null &&
          (typeof field.code !== "string" || !/^[A-Z0-9_]{1,100}$/.test(field.code))),
    )
  )
    throw new Error(
      "대조 결과와 현재 연결이 일치하지 않습니다. 최신 연결 상태를 확인한 뒤 다시 대조해 주세요.",
    );
  return comparison;
}

const stateLabels: Record<VentureInputComparisonField["state"], string> = {
  matched: "일치",
  empty: "빈칸",
  conflict: "상충",
  unknown: "미확인",
};

export function VentureinComparisonResult({
  comparison,
  fieldLabel,
}: {
  comparison: VentureInputComparison;
  fieldLabel: (fieldKey: string) => string;
}) {
  return (
    <div className="space-y-3">
      <p role="status" className="text-xs leading-6 text-muted-foreground">
        관측 시각: {formatDate(comparison.observedAt)} · 현재 연결안의 선택 항목{" "}
        {comparison.fields.length}개. 이 시각 이후의 화면 변경은 반영하지 않습니다.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-xs leading-6">
          <caption className="sr-only">현재 연결안과 공식 화면의 읽기 전용 대조 결과</caption>
          <thead className="bg-muted/40">
            <tr>
              <th scope="col" className="p-3">
                선택 항목
              </th>
              <th scope="col" className="p-3">
                종류
              </th>
              <th scope="col" className="p-3">
                관측 상태
              </th>
              <th scope="col" className="p-3">
                의미
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison.fields.map((field) => (
              <tr key={field.fieldKey} className="border-t align-top">
                <th scope="row" className="break-words p-3 font-medium">
                  {fieldLabel(field.fieldKey)}
                </th>
                <td className="whitespace-nowrap p-3">
                  {field.kind === "file" ? "첨부" : "텍스트"}
                </td>
                <td className="whitespace-nowrap p-3">
                  <Badge variant="outline">{stateLabels[field.state]}</Badge>
                </td>
                <td className="min-w-52 space-y-1 break-words p-3 text-muted-foreground">
                  <p>
                    {field.state === "matched"
                      ? field.kind === "file"
                        ? "현재 선택 파일의 개수·순서와 이름·크기·형식·SHA256이 연결 원본과 일치합니다. 기관의 수신·서버 저장을 증명하지 않습니다."
                        : "현재 입력값이 연결안과 같습니다."
                      : field.state === "empty"
                        ? field.kind === "file"
                          ? "현재 선택된 파일이 없습니다. 이전에 파일이 전송되지 않았다는 뜻은 아닙니다."
                          : "현재 입력란이 비어 있습니다."
                        : field.state === "conflict"
                          ? "현재 값 또는 파일 선택 정보가 연결안과 다릅니다. 공식 화면을 직접 확인하세요."
                          : "현재 상태를 확인하지 못했습니다. 일치하거나 비어 있다고 판단하지 않습니다."}
                  </p>
                  {field.code && <p className="text-[11px]">대조 코드: {field.code}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function VentureinComparisonPanel({
  compare,
  blockedReason,
  busy,
  fieldLabel,
}: {
  compare: () => Promise<VentureInputComparison | null>;
  blockedReason: string;
  busy: boolean;
  fieldLabel: (fieldKey: string) => string;
}) {
  const [comparison, setComparison] = useState<VentureInputComparison | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function readCurrent() {
    if (busy || blockedReason || inFlight.current) return;
    inFlight.current = true;
    setComparison(null);
    try {
      const value = await compare();
      if (mounted.current) setComparison(value);
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section aria-label="현재 연결안과 공식 화면 대조" className="space-y-3 rounded-xl border p-4">
      <h5 className="text-sm font-semibold">읽기 전용 현재 상태 대조</h5>
      <Notice>
        현재 저장된 연결안과 지금 열린 공식 화면을 비교합니다. 과거 승인 내용을 복원하거나 새 실행을
        허가하지 않습니다. 입력·첨부·저장·동의·제출을 실행하지 않으며, 기관의 저장·접수 상태도
        확인하지 않습니다. 모두 일치해도 기존 실행 결과의 미확인 상태나 재실행 제한은 해제되지
        않습니다.
      </Notice>
      <Button
        type="button"
        variant="outline"
        disabled={busy || !!blockedReason}
        onClick={readCurrent}
      >
        <ScanSearch />
        현재 화면과 연결안 대조
      </Button>
      {blockedReason && <p className="text-xs leading-6 text-muted-foreground">{blockedReason}</p>}
      {comparison && !blockedReason && (
        <VentureinComparisonResult comparison={comparison} fieldLabel={fieldLabel} />
      )}
    </section>
  );
}
