"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createInputPreparationClient } from "@/lib/studio-comparison-input-client";
import { inputFileName } from "@/lib/studio-comparison-input-wire";
import { Button } from "@/components/ui/button";
import { Notice } from "./shared";
export function ComparisonInputPreparation({
  companyId,
  companyRevision,
  runId,
  eligible,
  blocked,
}: {
  companyId: string;
  companyRevision: number;
  runId: string;
  eligible: boolean;
  blocked: boolean;
}) {
  const [client] = useState(() => createInputPreparationClient((...args) => fetch(...args)));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [expired, setExpired] = useState(false);
  useEffect(
    () => () => client.invalidate(),
    [client, companyId, companyRevision, runId, eligible, blocked],
  );
  useEffect(() => {
    const result = state.result;
    if (!result) return;
    const remaining = Date.parse(result.expiresAt) - Date.now();
    const timer = setTimeout(
      () => {
        setExpired(true);
        client.invalidate();
      },
      Math.min(Math.max(remaining, 0), 2147483647),
    );
    return () => clearTimeout(timer);
  }, [client, state.result]);
  const selection = { companyId, companyRevision, runId };
  const valid = state.result && !expired && !blocked && eligible;
  return (
    <section
      className="space-y-3 rounded-md border p-3 [overflow-wrap:anywhere]"
      aria-label="실행 입력 파일 준비"
      aria-busy={state.busy}
    >
      <h5 className="font-semibold">실행 입력 파일 준비</h5>
      <Notice>
        선택한 예약과 검토된 정책으로 입력 JSON을 준비합니다. 원고·발췌 본문은 파일에 넣지 않습니다.
        파일 준비 후 운영 담당자의 검토·활성화와 새로운 전송 동의가 필요합니다.
      </Notice>
      {!eligible && <p>현재 회사 버전의 기한 내 미실행 예약을 선택해야 준비할 수 있습니다.</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={blocked || state.busy || !eligible}
          onClick={() => {
            setExpired(false);
            void client.prepare(selection);
          }}
        >
          선택한 예약의 입력 파일 준비
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={blocked || state.busy}
          onClick={() => {
            setExpired(false);
            void client.cleanup(selection);
          }}
        >
          준비 연결 정리
        </Button>
      </div>
      <p role="status">
        {state.message ||
          (expired ? "준비 검토 기한이 지났습니다. 예약을 다시 확인하고 준비하세요." : "")}
      </p>
      {valid && (
        <div className="space-y-2">
          <p>
            예약 번호 {state.result!.runId} · 모델 {state.result!.model}
          </p>
          <p>
            검토 시각 {new Date(state.result!.inspectedAt).toLocaleString("ko-KR")} · 검토 기한{" "}
            {new Date(state.result!.expiresAt).toLocaleString("ko-KR")}
          </p>
          <p className="text-xs">파일 SHA-256 {state.result!.sha256}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const result = state.result!;
              if (Date.now() >= Date.parse(result.expiresAt)) {
                setExpired(true);
                client.invalidate();
                return;
              }
              const href = URL.createObjectURL(
                new Blob([result.content], { type: "application/json;charset=utf-8" }),
              );
              const link = document.createElement("a");
              link.href = href;
              link.download = inputFileName(result);
              document.body.appendChild(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(href), 1000);
            }}
          >
            입력 JSON 내려받기
          </Button>
          <p>
            다운로드는 활성화 완료가 아닙니다. 운영 담당자가 파일을 검토해 지정 위치에 별도
            배치·설정한 뒤 예약 목록을 다시 조회하고 실행 입력 일치를 확인하세요.
          </p>
        </div>
      )}
    </section>
  );
}
