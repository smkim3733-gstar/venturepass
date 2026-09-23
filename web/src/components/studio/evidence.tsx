"use client";

import { FileText } from "lucide-react";
import type { Candidate, StudioCase } from "@/lib/studio-schema";

export function EvidenceList({
  evidence,
  company,
}: {
  evidence: Candidate["evidence"];
  company: StudioCase;
}) {
  return (
    <div className="space-y-3">
      {evidence.length === 0 ? (
        <p className="text-xs leading-6 text-muted-foreground">
          연결된 근거가 없습니다. 기업자료에서 확인할 수 있는 내용을 보강해 주세요.
        </p>
      ) : (
        evidence.map((reference, index) => {
          const source = company.sources.find((item) => item.id === reference.sourceId);
          return (
            <details
              key={`${reference.sourceId}-${index}`}
              className="group rounded-xl border bg-white p-3"
            >
              <summary className="cursor-pointer list-none text-xs font-semibold leading-6">
                <span className="flex items-start gap-2">
                  <FileText className="mt-1 size-3.5 shrink-0 text-primary" />
                  <span>
                    {reference.sourceId === "profile"
                      ? "기업정보 · 기업이 제공한 설명"
                      : source?.name || "원본 자료를 다시 확인해 주세요"}
                    <span className="block font-normal text-muted-foreground">
                      {reference.locator || "연결된 인용문"}
                    </span>
                  </span>
                </span>
              </summary>
              <blockquote className="mt-3 whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-3 text-xs leading-6 text-muted-foreground">
                {reference.quote}
              </blockquote>
              {source && (
                <details className="mt-3 border-t pt-3">
                  <summary className="cursor-pointer text-xs text-primary">
                    저장된 원문 보기
                  </summary>
                  <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
                    {source.text}
                  </p>
                </details>
              )}
            </details>
          );
        })
      )}
    </div>
  );
}
