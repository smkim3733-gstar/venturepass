"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PreparedPackageRecord,
  PreparedPackageSummary,
} from "@/lib/studio-prepared-package-types";
import { preparedPackageDetails } from "./prepared-package-ui";
import { studioFetch } from "./shared";
import styles from "./guided-workspace.module.css";

const reasonLabels: Record<string, string> = {
  PLAN_NOT_CURRENT: "보관 당시 자료·신청 아이템과 원고의 연결 상태를 다시 확인해야 합니다.",
  OLDER_PLAN_VERSION: "보관 당시 최신 원고가 아닌 이전 버전입니다.",
  NOT_REVIEWED: "내부 검토 완료 표시가 없습니다.",
  UNCONFIRMED_SECTION: "담당자 확인이 필요한 원고 항목이 남아 있습니다.",
  REVIEW_ERROR: "보관 시 규칙 점검에서 오류가 발견됐습니다.",
  REVIEW_CONFIRMATION: "보관 시 규칙 점검에서 확인할 내용이 발견됐습니다.",
  STORED_REVIEW_ERROR: "원고에 저장된 검토 오류가 남아 있습니다.",
  STORED_REVIEW_CONFIRMATION: "원고에 저장된 확인 요청이 남아 있습니다.",
  STORED_SEMANTIC_FINDINGS: "근거·모순·시점·재무·확정 여부에 관한 검토 의견이 남아 있습니다.",
  INVALID_REFERENCE: "원고의 근거 인용을 자료와 다시 대조해야 합니다.",
};

export function PreparedPackageDetails({
  item,
  blocked,
}: {
  item: PreparedPackageSummary;
  blocked: boolean;
}) {
  const [record, setRecord] = useState<PreparedPackageRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const flight = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const close = useCallback(() => {
    const previous = flight.current;
    flight.current = null;
    previous?.abort();
    setLoading(false);
    setRecord(null);
    setError("");
  }, []);
  function visible() {
    for (let node: HTMLElement | null = root.current; node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement && !node.open) return false;
    return !!root.current;
  }
  useEffect(() => {
    mounted.current = true;
    const ancestors: HTMLDetailsElement[] = [];
    for (let node: HTMLElement | null = root.current; node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) ancestors.push(node);
    const toggle = () => {
      if (ancestors.some((node) => !node.open)) close();
    };
    ancestors.forEach((node) => node.addEventListener("toggle", toggle));
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = null;
      ancestors.forEach((node) => node.removeEventListener("toggle", toggle));
    };
  }, [close]);
  useEffect(() => {
    if (blocked) flight.current?.abort();
  }, [blocked]);

  async function read() {
    if (blocked || flight.current || !mounted.current || !visible()) return;
    const controller = new AbortController();
    flight.current = controller;
    setLoading(true);
    setError("");
    setRecord(null);
    try {
      const raw = await studioFetch<unknown>(
        `/api/studio/cases/${item.caseId}/prepared-packages/${item.id}`,
        { signal: controller.signal },
      );
      const value = preparedPackageDetails(raw, item);
      if (
        mounted.current &&
        flight.current === controller &&
        !controller.signal.aborted &&
        visible()
      )
        setRecord(value);
    } catch {
      if (
        mounted.current &&
        flight.current === controller &&
        !controller.signal.aborted &&
        visible()
      )
        setError(
          "선택한 준비본의 보관 내용을 확인하지 못했습니다. 다시 읽기를 눌러 확인해 주세요.",
        );
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }

  return (
    <div
      ref={root}
      className="my-4 min-w-0 space-y-3"
      aria-label={`준비본 ${item.version} 보관 내용`}
    >
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={styles.link}
          disabled={blocked || loading}
          onClick={() => void read()}
        >
          {loading
            ? "보관 내용 읽는 중…"
            : record || error
              ? "보관 내용 다시 읽기"
              : "보관 당시 내용 보기"}
        </button>
        {(loading || record || error) && (
          <button type="button" className={styles.link} onClick={close}>
            {loading ? "읽기 대기 중단" : "보관 내용 닫기"}
          </button>
        )}
      </div>
      {loading && (
        <p role="status" className={styles.helper}>
          보관한 원고·첨부 목록·검토 내용을 읽고 있습니다.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {record && (
        <div className="min-w-0 space-y-4 rounded-xl border p-4">
          <p className={styles.helper}>
            보관 당시 기록입니다. 현재 원고·자료의 변경은 반영하지 않습니다. 확인 후 고칠 내용은
            원고·자료 화면에서 수정하고 새 준비본으로 보관하세요.
          </p>
          <p className="break-words font-semibold">
            {record.company.profile.companyName} · 원고 v{record.plan.version} ·{" "}
            {record.plan.content.title}
          </p>
          <section aria-label="보관 당시 검토 필요 사유">
            <h4 className="font-semibold">보관 당시 검토 필요 사유</h4>
            {record.review.draftReasons.length ? (
              <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-6">
                {record.review.draftReasons.map((reason, index) => (
                  <li key={`${reason}:${index}`} className="break-words">
                    {Object.hasOwn(reasonLabels, reason)
                      ? reasonLabels[reason]
                      : `추가 확인이 필요한 보관 사유: ${reason}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.helper}>
                기록된 사유가 없습니다. 기관 제출 준비나 승인 여부를 확인한 결과는 아닙니다.
              </p>
            )}
          </section>
          <section aria-label="보관 당시 선택 원본">
            <h4 className="font-semibold">포함한 원본 {record.sources.length}개</h4>
            {!record.sources.length && (
              <p className={styles.helper}>
                선택한 원본이 없는 준비본입니다. 원고와 점검 자료는 포함됩니다.
              </p>
            )}
            <ul className="mt-2 space-y-2 text-sm leading-6">
              {record.sources.map(({ source, originalSizeBytes }) => (
                <li key={source.id} className="break-words rounded-lg bg-muted/30 p-3">
                  <strong className="block">{source.name}</strong>
                  <span className="block">
                    {source.originalName || "원본 파일명 기록 없음"} ·{" "}
                    {Math.ceil(originalSizeBytes / 1024).toLocaleString()}KB
                  </span>
                  {source.extraction === "pending" && (
                    <span className="block">보관 당시 본문 확인 전 · 원본 포함</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <details className={styles.details}>
            <summary>보관한 원고 본문 읽기</summary>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">
              {record.plan.content.summary}
            </p>
            {record.plan.content.sections.map((section, index) => (
              <section key={`${section.key}:${index}`} className="my-4 space-y-2">
                <h4 className="break-words font-semibold">
                  {section.title}
                  {section.needsConfirmation ? " · 확인 필요" : ""}
                </h4>
                <p
                  tabIndex={0}
                  className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-base leading-7 focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {section.content}
                </p>
              </section>
            ))}
          </details>
          {(
            [
              ["원고에 저장된 검토 의견", record.review.storedFindings],
              ["보관 시 규칙 점검 의견", record.review.currentRuleFindings],
            ] as const
          ).map(([title, findings]) => (
            <details key={title} className={styles.details}>
              <summary>
                {title} {findings.length}개
              </summary>
              {findings.length ? (
                <ul className="space-y-3 text-sm leading-6">
                  {findings.map((finding, index) => (
                    <li key={index} className="whitespace-pre-wrap break-words">
                      <p>{finding.message}</p>
                      <p className="text-muted-foreground">확인할 일: {finding.action}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.helper}>보관된 의견이 없습니다.</p>
              )}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
