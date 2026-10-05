"use client";
import { useEffect, useRef, useState } from "react";
import type {
  PublicResearchCandidate,
  PublicResearchResult,
} from "@/lib/studio-public-research-result";
import {
  publicSelectedCellCommandSchema,
  readPublicSelectedCellResult,
  type PublicSelectedCellResult,
} from "@/lib/studio-public-selected-cell";
import { jsonBody, studioFetch } from "./shared";
import styles from "./guided-workspace.module.css";

const shown = (value: string | null) =>
  value === null ? "미확인" : value === "" ? "빈 문자" : value;
export function PublicSelectedCellResultView({ result }: { result: PublicSelectedCellResult }) {
  return (
    <section
      aria-label="읽은 통계 수치"
      className="grid min-w-0 grid-cols-1 gap-2 [overflow-wrap:anywhere]"
    >
      {result.status === "not-configured" ? (
        <p role="status">앱 안 조회는 KOSIS 연결 설정 후 사용할 수 있습니다.</p>
      ) : (
        <>
          <p className={styles.helper}>
            후보 재대조 시각: {result.searchCheckedAt}
            <br />
            수치 조회 시각: {result.retrievedAt}
          </p>
          {result.status === "empty" && (
            <p role="status">
              일치하는 수치 행이 없습니다. 자료 부재·코드 무효·수치 0으로 확정하지 않습니다.
            </p>
          )}
          {result.cell && (
            <>
              <p>
                표: {result.cell.tableName}
                <br />
                항목: {result.command.selection.itemId} · {shown(result.cell.itemName)}
              </p>
              {result.cell.classifications.map((c, i) => (
                <p key={i}>
                  분류 {i + 1}: {c.code} · {shown(c.dimensionName)} / {shown(c.valueName)}
                </p>
              ))}
              <p>
                주기·시점: {result.command.selection.period.cycle} /{" "}
                {result.command.selection.period.point}
              </p>
              <p>
                값 원문: <strong className="whitespace-pre-wrap">{shown(result.cell.value)}</strong>
                <br />
                단위: {shown(result.cell.unitName)} (코드 {shown(result.cell.unitId)})
              </p>
              <p>행 수정일 원문: {shown(result.cell.lastChangedText)}</p>
            </>
          )}
        </>
      )}
      <p className={styles.helper}>
        수동으로 지정한 코드와 응답을 대조한 결과입니다. 회사 해당성·사실 확인·단위 해석·통계표 전체
        확인은 완료하지 않았습니다. 조회 시각은 발행일이나 담당자가 읽은 날짜가 아닙니다.
      </p>
    </section>
  );
}

export function PublicSelectedCell({
  candidate,
  searchResult,
}: {
  candidate: PublicResearchCandidate;
  searchResult: PublicResearchResult;
}) {
  const [itemId, setItemId] = useState("");
  const [classifications, setClassifications] = useState([""]);
  const [cycle, setCycle] = useState("");
  const [point, setPoint] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<PublicSelectedCellResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const details = useRef<HTMLDetailsElement | null>(null);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  function clear() {
    flight.current?.abort();
    flight.current = null;
    setLoading(false);
    setResult(null);
    setError("");
    setConfirmed(false);
  }
  function visible() {
    let node: HTMLElement | null = details.current;
    while (node) {
      if (node instanceof HTMLDetailsElement && !node.open) return false;
      node = node.parentElement;
    }
    return !!details.current;
  }
  useEffect(() => {
    mounted.current = true;
    const ancestors: HTMLDetailsElement[] = [];
    let node: HTMLElement | null = details.current;
    while (node) {
      if (node instanceof HTMLDetailsElement) ancestors.push(node);
      node = node.parentElement;
    }
    const onToggle = () => {
      if (ancestors.some((a) => !a.open)) {
        flight.current?.abort();
        flight.current = null;
        setLoading(false);
        setResult(null);
        setError("");
        setConfirmed(false);
      }
    };
    ancestors.forEach((a) => a.addEventListener("toggle", onToggle));
    return () => {
      mounted.current = false;
      flight.current?.abort();
      ancestors.forEach((a) => a.removeEventListener("toggle", onToggle));
    };
  }, []);
  const prepared = publicSelectedCellCommandSchema.safeParse({
    action: "read-selected-statistics-cell",
    topic: searchResult.topic,
    candidate,
    searchRetrievedAt: searchResult.retrievedAt,
    selection: { itemId, classifications, period: { cycle, point } },
    confirmed: true,
  });
  async function read() {
    if (!confirmed || !prepared.success || flight.current || !visible()) return;
    const command = prepared.data;
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true);
    setResult(null);
    setError("");
    setConfirmed(false);
    try {
      const raw = await studioFetch<unknown>("/api/studio/public-research/search", {
        method: "POST",
        ...jsonBody(command),
        signal: controller.signal,
      });
      const value = readPublicSelectedCellResult(raw, command);
      if (
        mounted.current &&
        !controller.signal.aborted &&
        flight.current === controller &&
        visible()
      )
        setResult(value);
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        flight.current === controller &&
        visible()
      )
        setError(
          "수치가 미확인입니다. 다른 공개 조회가 끝났는지, 검색 후보와 코드가 같은지 확인한 뒤 다시 조회해 주세요.",
        );
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }
  const inputClass = "mt-1 block w-full min-w-0 rounded border bg-white p-2 text-sm";
  return (
    <details ref={details} className={styles.details}>
      <summary>코드를 아는 수치 1건 조회 (선택)</summary>
      <div
        aria-label="선택 통계 수치 입력"
        className="mt-3 grid min-w-0 gap-3 [overflow-wrap:anywhere]"
      >
        <p className={styles.helper}>
          대상: {candidate.organizationId} / {candidate.tableId}
          <br />
          {candidate.title}
          <br />
          공식 선택조건에서 직접 확인한 코드와 분류 순서만 입력하세요. 자동 확인된 코드 목록은
          아닙니다. 코드를 모르면 통계표 원문 열기와 수동 출처 보관을 이용하세요. 키가 포함된 URL
          전체는 넣지 마세요.
        </p>
        <label className={styles.label}>
          항목 코드
          <input
            aria-label="항목 코드"
            className={inputClass}
            value={itemId}
            onChange={(e) => {
              clear();
              setItemId(e.target.value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {classifications.map((c, i) => (
          <label key={i} className={styles.label}>
            분류 {i + 1} 코드
            <input
              aria-label={`분류 ${i + 1} 코드`}
              className={inputClass}
              value={c}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                clear();
                setClassifications((values) =>
                  values.map((v, j) => (j === i ? e.target.value : v)),
                );
              }}
            />
          </label>
        ))}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={styles.link}
            disabled={classifications.length === 8}
            onClick={() => {
              clear();
              setClassifications((v) => [...v, ""]);
            }}
          >
            분류 칸 추가
          </button>
          <button
            type="button"
            className={styles.link}
            disabled={classifications.length === 1}
            onClick={() => {
              clear();
              setClassifications((v) => v.slice(0, -1));
            }}
          >
            마지막 분류 칸 제거
          </button>
        </div>
        <p className={styles.helper}>
          분류 1부터 필요한 마지막 분류까지 순서대로 입력하세요. 중간 칸을 비우거나 전체·합계 코드를
          추정하지 않습니다. 각 코드는 영문·숫자·밑줄·하이픈 40자 이내입니다.
        </p>
        <label className={styles.label}>
          수치 주기
          <select
            aria-label="수치 주기"
            className={inputClass}
            value={cycle}
            onChange={(e) => {
              clear();
              setCycle(e.target.value);
              setPoint("");
            }}
          >
            <option value="">주기 선택</option>
            <option value="Y">연</option>
            <option value="M">월</option>
            <option value="Q">분기</option>
          </select>
        </label>
        <label className={styles.label}>
          수치 시점
          <input
            aria-label="수치 시점"
            className={inputClass}
            value={point}
            autoComplete="off"
            inputMode="numeric"
            onChange={(e) => {
              clear();
              setPoint(e.target.value);
            }}
          />
        </label>
        <p className={styles.helper}>
          연: YYYY · 월: YYYYMM · 분기: YYYY01~YYYY04. 시점 1개를 지정하며 최신 시점을 자동 선택하지
          않습니다.
        </p>
        {!prepared.success && (
          <p className={styles.helper}>
            항목·분류 코드와 지원하는 주기·시점을 모두 정확히 입력해 주세요.
          </p>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!prepared.success || loading}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            공식 선택조건에서 코드·분류 순서·시점을 확인했고, 이 조건으로 수치 1건을 조회합니다.
          </span>
        </label>
        <button
          type="button"
          className={styles.link}
          disabled={!prepared.success || !confirmed || loading}
          onClick={() => void read()}
        >
          {loading ? "선택 수치 조회 중" : "선택 수치 한 번 조회"}
        </button>
        <p className={styles.helper}>
          후보 재대조와 수치 조회로 공개 요청 최대 2회가 발생합니다. 회사 자료는 보내지 않습니다.
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {result && <PublicSelectedCellResultView result={result} />}
        <p className={styles.helper}>
          자료 저장·AI 전송·원고 반영은 하지 않습니다. 입력 변경·닫기·화면 이동 시 결과와 조회 확인
          체크를 지웁니다. 입력 내용은 새로고침 뒤 복원하지 않습니다.
        </p>
      </div>
    </details>
  );
}
