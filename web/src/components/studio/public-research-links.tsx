"use client";
import { useState } from "react";
import { publicResearchTopics, publicStatisticsSearch } from "@/lib/studio-public-research";
import styles from "./guided-workspace.module.css";
export function PublicResearchLinks({ disabled }: { disabled: boolean }) {
  const [topic, setTopic] = useState("");
  const search = topic ? publicStatisticsSearch(topic) : null;
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
            onChange={(e) => setTopic(e.target.value)}
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
        <p className={styles.helper}>
          목록의 일반 주제만 검색어로 보냅니다. 회사명·자료 본문은 넣지 않습니다. 결과의 개별
          통계표에서 대상·단위·기준 기간을 확인한 뒤, 아래에 원문 주소와 발췌를 기록해 주세요.
        </p>
        <p className={styles.helper}>
          새 창의 검색 결과는 앱에 자동 수집되지 않습니다. 찾지 못했거나 시점이 맞지 않으면
          미확인으로 남기고 회사에 필요한 자료를 요청해 주세요.
        </p>
      </div>
    </details>
  );
}
