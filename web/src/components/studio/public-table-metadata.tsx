"use client";
import { useEffect, useRef, useState } from "react";
import type {
  PublicResearchCandidate,
  PublicResearchResult,
} from "@/lib/studio-public-research-result";
import {
  readPublicTableMetadataResult,
  type PublicTableMetadataCommand,
  type PublicTableMetadataResult,
} from "@/lib/studio-public-table-metadata";
import { jsonBody, studioFetch } from "./shared";
import styles from "./guided-workspace.module.css";

export function PublicTableMetadata({
  candidate,
  searchResult,
}: {
  candidate: PublicResearchCandidate;
  searchResult: PublicResearchResult;
}) {
  const [kind, setKind] = useState<PublicTableMetadataCommand["kind"] | "">("");
  const [result, setResult] = useState<PublicTableMetadataResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const details = useRef<HTMLDetailsElement | null>(null);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
    };
  }, []);
  function clear() {
    flight.current?.abort();
    flight.current = null;
    setLoading(false);
    setResult(null);
    setError("");
  }
  async function read() {
    if (
      !kind ||
      !candidate.originalUrl ||
      !searchResult.retrievedAt ||
      flight.current ||
      !details.current?.open
    )
      return;
    const command: PublicTableMetadataCommand = {
      action: "read-selected-table-metadata",
      topic: searchResult.topic,
      candidate,
      searchRetrievedAt: searchResult.retrievedAt,
      kind,
      confirmed: true,
    };
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true);
    setResult(null);
    setError("");
    try {
      const raw = await studioFetch<unknown>("/api/studio/public-research/search", {
        method: "POST",
        ...jsonBody(command),
        signal: controller.signal,
      });
      const value = readPublicTableMetadataResult(raw, command);
      if (
        mounted.current &&
        !controller.signal.aborted &&
        flight.current === controller &&
        details.current?.open
      )
        setResult(value);
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        flight.current === controller &&
        details.current?.open
      )
        setError("표 정보가 미확인입니다. 검색 후보를 다시 확인한 뒤 명시적으로 조회해 주세요.");
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }
  const metadata = result?.metadata;
  return (
    <details
      ref={details}
      className={styles.details}
      onToggle={(e) => {
        if (!e.currentTarget.open) clear();
      }}
    >
      <summary>이 표의 기본 정보 확인 (선택)</summary>
      <div className="mt-3 grid min-w-0 gap-3" aria-label="선택 통계표 정보">
        <p className={styles.helper}>
          대상: {candidate.organizationId} / {candidate.tableId}
          <br />
          {candidate.title}
          <br />
          기존 검색 후보를 다시 대조한 후 고른 정보 하나를 읽습니다. 공개 요청은 최대 2회이며 회사
          자료는 보내지 않습니다.
        </p>
        <label className={styles.label}>
          읽을 표 정보
          <select
            aria-label="읽을 표 정보"
            className="mt-1 block w-full min-w-0 rounded border bg-white p-2 text-sm"
            value={kind}
            onChange={(e) => {
              clear();
              setKind(e.target.value as typeof kind);
            }}
          >
            <option value="">정보 선택</option>
            <option value="TBL">표 이름</option>
            <option value="PRD">수록 시점</option>
            <option value="SOURCE">조사·담당 출처</option>
          </select>
        </label>
        <button
          type="button"
          className={styles.link}
          disabled={!kind || loading || !candidate.originalUrl}
          onClick={() => void read()}
        >
          {loading ? "선택 표 정보 조회 중" : "선택 표 정보 한 번 조회"}
        </button>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {result?.status === "not-configured" && (
          <p role="status">앱 안 조회는 KOSIS 연결 설정 후 사용할 수 있습니다.</p>
        )}
        {metadata && (
          <section aria-label="읽은 표 정보" className="grid min-w-0 gap-2 break-words">
            <p className={styles.helper}>
              후보 재대조 시각: {result?.searchCheckedAt}
              <br />표 정보 조회 시각: {result?.retrievedAt}
            </p>
            {result?.status === "empty" && (
              <p role="status">표 정보 행이 없습니다. 해당 통계나 자료가 없다는 판정은 아닙니다.</p>
            )}
            {metadata.kind === "TBL" &&
              metadata.rows.map((r, i) => (
                <p key={i}>
                  표 이름: {r.TBL_NM}
                  <br />
                  영문 표기: {r.TBL_NM_ENG ?? "미확인"}
                </p>
              ))}
            {metadata.kind === "PRD" &&
              metadata.rows.map((r, i) => (
                <p key={i}>
                  주기 원문: {r.PRD_SE} · 시점 원문: {r.PRD_DE}
                </p>
              ))}
            {metadata.kind === "SOURCE" &&
              metadata.rows.map((r, i) => (
                <p key={i}>
                  조사명: {r.JOSA_NM}
                  <br />
                  조사 ID: {r.STAT_ID}
                  <br />
                  담당부서: {r.DEPT_NM ?? "미확인"}
                  <br />
                  담당 연락처 표기: {r.DEPT_PHONE ?? "미확인"}
                </p>
              ))}
          </section>
        )}
        <p className={styles.helper}>
          응답에 기관·표 ID가 없어 요청 대상으로만 연결합니다. 표 이름 일치로 신원을 확정하지
          않습니다. 수록 시점은 전체 목록이나 연속 기간을 뜻하지 않습니다. 수치·항목·분류·주석·표
          갱신일은 아직 읽지 않았습니다.
        </p>
        <p className={styles.helper}>
          조회 시각은 발행일·읽은 날짜가 아닙니다. 자료 저장·사실 확인·AI 전송은 하지 않으며
          닫기·선택 변경·화면 이동 시 결과를 지웁니다.
        </p>
      </div>
    </details>
  );
}
