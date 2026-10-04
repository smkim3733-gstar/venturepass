"use client";
import { useEffect, useRef, useState } from "react";
import { publicResearchTopics, publicStatisticsSearch } from "@/lib/studio-public-research";
import {
  publicResearchCandidateFields,
  readPublicResearchResult,
  type PublicResearchCandidate,
  type PublicResearchResult,
} from "@/lib/studio-public-research-result";
import { jsonBody, studioFetch } from "./shared";
import styles from "./guided-workspace.module.css";
export function PublicResearchLinks({
  disabled,
  canFill = false,
  onCandidate,
}: {
  disabled: boolean;
  canFill?: boolean;
  onCandidate?: (candidate: PublicResearchCandidate) => void;
}) {
  const [topic, setTopic] = useState("");
  const [result, setResult] = useState<PublicResearchResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (disabled) flight.current?.abort();
  }, [disabled]);
  const search = topic ? publicStatisticsSearch(topic) : null;
  function select(value: string) {
    flight.current?.abort();
    flight.current = null;
    setLoading(false);
    setTopic(value);
    setResult(null);
    setError("");
  }
  async function lookup() {
    if (!search || disabled || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const raw = await studioFetch<unknown>("/api/studio/public-research/search", {
        method: "POST",
        ...jsonBody({ topic: search.topic }),
        signal: controller.signal,
      });
      const value = readPublicResearchResult(raw, search.topic);
      if (mounted.current && !controller.signal.aborted && flight.current === controller)
        setResult(value);
    } catch {
      if (mounted.current && !controller.signal.aborted && flight.current === controller)
        setError("검색 결과가 미확인입니다. 아래 새 창 검색을 이용하거나 다시 조회해 주세요.");
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }
  return (
    <details className={styles.details}>
      <summary>공개 통계 찾기 (선택)</summary>
      <div className="mt-3 grid min-w-0 gap-3" aria-label="공개 통계 검색 준비">
        <label className={styles.label}>
          찾을 공개 주제
          <select
            aria-label="찾을 공개 주제"
            className="mt-1 block w-full min-w-0 rounded border bg-white p-2 text-sm"
            value={topic}
            disabled={disabled}
            onChange={(e) => select(e.target.value)}
          >
            <option value="">주제 선택</option>
            {publicResearchTopics().map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {search && (
          <>
            <p className={styles.helper}>
              검색할 곳: {search.provider}
              <br />
              보낼 검색어: <strong>{search.query}</strong>
            </p>
            <button
              type="button"
              className={styles.link}
              disabled={disabled || loading}
              onClick={() => void lookup()}
            >
              {loading ? "공개 검색 후보 조회 중" : "공개 검색 후보 10개 조회"}
            </button>
            {!disabled ? (
              <a
                className={styles.link}
                href={search.href}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                KOSIS에서 검색 열기 (새 창)
              </a>
            ) : (
              <span className={styles.helper}>자료 처리 중에는 검색을 열 수 없습니다.</span>
            )}
          </>
        )}
        {!disabled && error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {!disabled && result?.topic === topic && result.status === "not-configured" && (
          <p role="status">
            앱 안 조회는 KOSIS 연결 설정 후 사용할 수 있습니다. 현재는 새 창 검색에서 원문을 확인해
            주세요.
          </p>
        )}
        {!disabled && result?.topic === topic && result.status === "results" && (
          <section aria-label="KOSIS 검색 후보" className="grid min-w-0 gap-3">
            <p className={styles.helper}>
              출처: KOSIS 통합검색 · 검색순 첫 10개 이내
              <br />
              조회 시각: {result.retrievedAt}
              <br />
              조회 시각은 발행일·담당자가 원문을 읽은 날짜가 아닙니다. 통계 수치와 원문은 아직 읽지
              않았습니다.
            </p>
            {!result.candidates.length && (
              <p role="status">검색 후보가 없습니다. 해당 사실이나 자료가 없다는 뜻은 아닙니다.</p>
            )}
            {result.candidates.map((c) => {
              let fillable = false;
              try {
                publicResearchCandidateFields(c);
                fillable = true;
              } catch {
                /* Keep long titles and unavailable links visible. */
              }
              return (
                <article
                  key={JSON.stringify([c.organizationId, c.tableId])}
                  className="min-w-0 space-y-2 rounded border p-3 text-sm break-words"
                >
                  <strong>{c.title}</strong>
                  <p>제공기관 표기: {c.organization || "미확인"}</p>
                  <p>
                    수록기간 원문 표기: {c.periodStart || "미확인"} ~ {c.periodEnd || "미확인"}
                  </p>
                  {c.originalUrl ? (
                    <a
                      className={styles.link}
                      href={c.originalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      통계표 원문 열기 (새 창)
                    </a>
                  ) : (
                    <p>통계표 주소를 확인하지 못했습니다. KOSIS에서 직접 찾아 주세요.</p>
                  )}
                  {onCandidate && (
                    <button
                      type="button"
                      className={styles.link}
                      disabled={!canFill || !fillable}
                      onClick={() => onCandidate(c)}
                    >
                      제목·주소를 아래 빈 입력칸에 넣기
                    </button>
                  )}
                </article>
              );
            })}
            <p className={styles.helper}>
              제목·주소만 옮기며 기존 입력을 덮어쓰지 않습니다. 발췌·읽은 날짜는 원문을 확인한 뒤
              직접 기록해 주세요.
            </p>
          </section>
        )}
        <p className={styles.helper}>
          목록의 일반 주제만 검색어로 보냅니다. 회사명·자료 본문은 넣지 않습니다. 결과의 개별
          통계표에서 대상·단위·기준 기간을 확인한 뒤, 아래에 원문 주소와 발췌를 기록해 주세요.
        </p>
        <p className={styles.helper}>
          앱 안 조회는 검색 후보만 가져옵니다. 자료 보관·사실 확인·AI 전송은 하지 않습니다. 찾지
          못했거나 시점이 맞지 않으면 미확인으로 남기고 회사에 필요한 자료를 요청해 주세요.
        </p>
      </div>
    </details>
  );
}
