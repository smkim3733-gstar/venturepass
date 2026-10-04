"use client";
import type { GuidedWorkflowTarget } from "@/lib/studio-guided-followup";
import type { GuidedAgencyApplicationContext } from "@/lib/studio-guided-agency-context";
import styles from "./guided-workspace.module.css";

export function GuidedFollowupApplication({
  value,
  disabled,
  onNavigate,
}: {
  value: GuidedAgencyApplicationContext | null;
  disabled: boolean;
  onNavigate: (target: GuidedWorkflowTarget) => void;
}) {
  if (!value) return null;
  return (
    <div className="mt-3 min-w-0 break-words" aria-label="기관 기록의 신청 회차 연결">
      <p className={styles.helper}>{value.label} · 담당자 기록</p>
      {value.state === "unknown" && <p className={styles.helper}>{value.detail}</p>}
      <details className={styles.details}>
        <summary>회차 연결·보관 원문 보기</summary>
        <p className={styles.helper}>{value.detail}</p>
        {value.recordedAt && (
          <p className={styles.helper}>
            연결 기록 시각: {value.recordedAt} · 공식 확인 시각이 아닙니다.
          </p>
        )}
        <p className={styles.helper}>
          원문과 회차는 이 PC의 수동 기록입니다. 원문 보기만으로 공식 접수·심사 결과를 확인하지
          않습니다.
        </p>
        <div className="flex flex-wrap gap-3">
          {value.application && (
            <button
              type="button"
              className={styles.link}
              disabled={disabled}
              onClick={() => onNavigate(value.application!.target)}
            >
              연결된 회차 기록 보기
            </button>
          )}
          {value.record && (
            <button
              type="button"
              className={styles.link}
              disabled={disabled}
              onClick={() => onNavigate(value.record!.target)}
            >
              이 안내의 원문 보기 ({value.record.label})
            </button>
          )}
          {value.fixedRecord &&
            value.fixedRecord.target.recordVersionId !== value.record?.target.recordVersionId && (
              <button
                type="button"
                className={styles.link}
                disabled={disabled}
                onClick={() => onNavigate(value.fixedRecord!.target)}
              >
                연결 당시 원문 보기 ({value.fixedRecord.label})
              </button>
            )}
        </div>
      </details>
    </div>
  );
}
