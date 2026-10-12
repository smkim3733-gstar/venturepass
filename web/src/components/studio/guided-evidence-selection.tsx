"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sourceKindLabels, type StudioCase } from "@/lib/studio-schema";
import {
  selectedEvidenceInput,
  selectedEvidenceSnapshot,
  type SelectedEvidenceSnapshot,
} from "./guided-evidence-selection-state";
import { jsonBody, studioFetch } from "./shared";
import styles from "./guided-workspace.module.css";

export function GuidedEvidenceSelection({
  company,
  sourceIds,
  currentRevision,
  locked,
  onClose,
  onConfirm,
}: {
  company: StudioCase;
  sourceIds: string[];
  currentRevision: number;
  locked: boolean;
  onClose: () => void;
  onConfirm: (value: SelectedEvidenceSnapshot) => void;
}) {
  const [ids, setIds] = useState(sourceIds);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false),
    active = useRef(true),
    epoch = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      epoch.current += 1;
    };
  }, [currentRevision]);
  const input = selectedEvidenceInput(company, ids);
  const stale = currentRevision !== company.revision;
  const disabled = locked || checking || stale;
  async function confirm() {
    if (disabled || inFlight.current || !input || input.overInputLimit) return;
    inFlight.current = true;
    const requestEpoch = epoch.current;
    setChecking(true);
    setError("");
    try {
      const raw = await studioFetch<unknown>(
        `/api/studio/cases/${company.id}/guided-preparation/preview`,
        {
          method: "POST",
          ...jsonBody({ revision: company.revision, sourceIds: ids }),
        },
      );
      const snapshot = selectedEvidenceSnapshot(raw, company, ids);
      if (!snapshot) throw Error("선택 범위 불일치");
      if (active.current && epoch.current === requestEpoch) onConfirm(snapshot);
    } catch {
      if (active.current && epoch.current === requestEpoch)
        setError(
          "선택한 자료의 최신 상태를 확인하지 못했습니다. 전송하지 않았으며, 선택을 유지합니다. 다시 확인해 주세요.",
        );
    } finally {
      inFlight.current = false;
      if (active.current && epoch.current === requestEpoch) setChecking(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>AI에 사용할 자료 선택</DialogTitle>
          <DialogDescription>
            필요한 자료만 고르세요. 회사 설명·기업정보는 함께 사용하며, 다음 단계에서 전송에
            동의합니다.
          </DialogDescription>
        </DialogHeader>
        <p className={styles.helper}>
          선택 {ids.length}개 · 미선택{" "}
          {company.sources.filter((s) => s.extraction !== "pending" && !ids.includes(s.id)).length}
          개 · 판독 대기 {company.sources.filter((s) => s.extraction === "pending").length}개
        </p>
        <div className={styles.support}>
          <button
            type="button"
            className={styles.link}
            disabled={disabled}
            onClick={() => {
              setIds(company.sources.filter((s) => s.extraction !== "pending").map((s) => s.id));
              setError("");
            }}
          >
            사용 가능한 자료 모두 선택
          </button>
          <button
            type="button"
            className={styles.link}
            disabled={disabled}
            onClick={() => {
              setIds([]);
              setError("");
            }}
          >
            회사 설명만 사용
          </button>
        </div>
        <ul className="max-h-64 overflow-y-auto space-y-2" aria-label="AI 근거 선택 목록">
          {company.sources.map((source, index) => (
            <li key={source.id} className={styles.file}>
              <label className="flex items-start gap-3 w-full min-w-0">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  disabled={disabled || source.extraction === "pending"}
                  checked={ids.includes(source.id)}
                  onChange={(event) => {
                    setIds(
                      event.target.checked
                        ? [...ids, source.id]
                        : ids.filter((id) => id !== source.id),
                    );
                    setError("");
                  }}
                />
                <span className="min-w-0 break-all">
                  {source.name}
                  <small className="block text-xs text-slate-600">
                    <span>{sourceKindLabels[source.kind]}</span>
                    {source.originalName && <span className="block">{source.originalName}</span>}
                  </small>
                  <small className="block text-xs text-slate-600">
                    {source.extraction === "pending"
                      ? "판독·본문 채택 전 · 내용 제외"
                      : source.text.trim()
                        ? "저장된 본문 사용 · 사실 확인은 별도"
                        : "빈 본문 · 기본 정보만 사용"}
                  </small>
                  {source.extraction !== "pending" && (
                    <small className="block text-xs text-slate-600">
                      저장 본문 {source.text.length.toLocaleString("ko-KR")}자
                    </small>
                  )}
                </span>
              </label>
              {source.extraction !== "pending" && source.text.trim() && (
                <details className="w-full min-w-0 text-sm">
                  <summary className="cursor-pointer text-slate-700">
                    선택 전 저장 본문 확인
                  </summary>
                  <p className="mt-2 text-xs text-slate-600">
                    펼쳐 읽어도 선택은 바뀌지 않습니다. 현재 저장된 본문이며, 원본 파일이나 사실
                    여부는 별도로 확인해 주세요.
                  </p>
                  <p
                    role="region"
                    aria-label={`자료 ${index + 1} 선택 전 저장 본문`}
                    tabIndex={0}
                    className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border p-3 text-slate-700"
                  >
                    {source.text}
                  </p>
                </details>
              )}
            </li>
          ))}
        </ul>
        <p
          role={input?.overInputLimit ? "alert" : undefined}
          className={input?.overInputLimit ? styles.error : styles.helper}
        >
          첫 분석 입력 {input?.inputCharacters.toLocaleString("ko-KR")} / 240,000자
          {input?.overInputLimit &&
            ` · 한도 초과 ${(input.inputCharacters - input.inputCharacterLimit).toLocaleString("ko-KR")}자: 선택 자료를 줄이거나 본문을 정리해 주세요. 자동으로 자르지 않습니다.`}
        </p>
        <p className={styles.helper}>
          전체 입력에는 기업정보·자료 이름 등도 포함되므로 본문 글자 수의 합계와 다를 수 있습니다.
        </p>
        <p className={styles.helper}>
          0개를 선택하면 회사 설명만 사용합니다. 근거가 부족한 사실은 확인이 필요합니다. 원본
          파일·사업자등록번호 입력칸은 보내지 않지만 본문 속 개인정보는 확인해 주세요. 후속
          초안·검토의 추가 입력과 AI 토큰 한도는 별도입니다.
        </p>
        <p className={styles.helper}>
          아직 승인하지 않은 선택은 창을 닫거나 새로고침하면 초기화됩니다. 이미 실행한 작업의 자료
          범위는 그대로 보존합니다.
        </p>
        {stale && (
          <p role="alert" className={styles.error}>
            자료가 바뀌었습니다. 창을 닫고 최신 자료로 다시 선택해 주세요.
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.link} onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={disabled || !input || input.overInputLimit}
            onClick={() => void confirm()}
          >
            {checking ? "선택 범위 확인 중…" : "선택 범위 확인"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
