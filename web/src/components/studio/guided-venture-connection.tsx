"use client";
import { useEffect, useRef, useState } from "react";
import {
  readVentureOverview,
  ventureOverviewAction,
  type VentureOverview,
} from "@/lib/venturein-overview-types";
import { studioFetch, formatDate } from "./shared";
import styles from "./guided-workspace.module.css";

type Props = {
  company: { id: string; revision: number };
  disabled: boolean;
  onOpen: (target: VentureOverview) => void;
};
/** Keyed by the parent company's revision. Reading never logs in or inspects a remote page. */
export function GuidedVentureConnection({ company, disabled, onOpen }: Props) {
  const [value, setValue] = useState<VentureOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const request = useRef<{ key: string; promise: Promise<VentureOverview> } | null>(null);
  const reading = useRef(true);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    mounted.current = true;
    const current = ++epoch.current;
    let active = true;
    const key = `${company.id}:${company.revision}`;
    if (request.current?.key !== key)
      request.current = {
        key,
        promise: studioFetch<unknown>(`/api/studio/cases/${company.id}/venturein/overview`).then(
          (raw) => readVentureOverview(raw, { id: company.id, revision: company.revision }),
        ),
      };
    request.current.promise
      .then((next) => {
        if (active && current === epoch.current) {
          setValue(next);
          setError("");
        }
      })
      .catch((caught: unknown) => {
        if (active && current === epoch.current) {
          setValue(null);
          setError(caught instanceof Error ? caught.message : "연결 기록을 확인하지 못했습니다.");
        }
      })
      .finally(() => {
        if (active && current === epoch.current) {
          reading.current = false;
          setLoading(false);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [company.id, company.revision, refresh]);
  function reread() {
    if (disabled || reading.current || !mounted.current) return;
    reading.current = true;
    setLoading(true);
    setValue(null);
    setError("");
    request.current = null;
    setRefresh((n) => n + 1);
  }
  // Even a parent that has not remounted cannot display a previous company's result.
  const current =
    value?.caseId === company.id && value.companyRevision === company.revision ? value : null;
  const action = current ? ventureOverviewAction(current) : null;
  return (
    <section className={styles.sheet} aria-label="벤처인 연결 기록 요약">
      <p className={styles.eyebrow}>지금 할 일</p>
      <h3 className={styles.subheading}>
        {loading
          ? "보관한 연결 기록을 확인하고 있어요"
          : (action?.title ?? "연결 기록 확인이 필요해요")}
      </h3>
      <p className={styles.helper}>
        {action?.description ??
          "이 PC의 연결 기록을 읽습니다. 공식 사이트 조회나 로그인은 실행하지 않습니다."}
      </p>
      {error && (
        <p role="alert" className={styles.notice}>
          {error}
        </p>
      )}
      {current && (
        <p className={styles.helper}>
          연결 기록 조회: {formatDate(current.readAt)} · 공식 접수 상태는 조회하지 않았습니다.
        </p>
      )}
      <div className={styles.actions}>
        {action && (
          <button
            type="button"
            className={styles.primary}
            disabled={disabled || loading}
            onClick={() => {
              if (current) onOpen(readVentureOverview(current, company));
            }}
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          className={styles.link}
          disabled={disabled || loading}
          onClick={reread}
        >
          연결 기록 다시 확인
        </button>
      </div>
      <details className={styles.details}>
        <summary>공식 신청 절차와 확인 범위</summary>
        <p className={styles.helper}>
          신청서 작성·첨부 후 최종 제출, 서류 확인·보완, 수수료 납부 후 접수완료, 평가·심의와 확인서
          발급 순서로 진행합니다.
        </p>
        <p className={styles.helper}>
          로그인에 추가 인증이 필요할 수 있습니다. 로그인만으로 결제·서명·최종 제출을 승인한 것으로
          처리하지 않습니다.
        </p>
        <p className={styles.helper}>
          앱은 선택한 항목의 입력·첨부를 별도 검토 후 실행합니다. 전체 자동 제출·접수 및 심사 결과
          자동 조회는 아직 연결되지 않았습니다.
        </p>
        {current && (
          <p className={styles.helper}>
            마지막 보관 화면 관측:{" "}
            {current.screenObservedAt ? formatDate(current.screenObservedAt) : "기록 없음"} · 현재
            공식 상태를 확인한 시각이 아닙니다.
          </p>
        )}
        {!disabled && (
          <a
            className={styles.link}
            href="https://www.smes.go.kr/venturein/institution/processGuide"
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            벤처인 공식 확인절차 열기
          </a>
        )}
        <p className={styles.helper}>
          공개 안내 확인: 2026-10-05. 현재 계정의 실제 화면·인증·접수 결과는 별도 확인이 필요합니다.
        </p>
      </details>
    </section>
  );
}
