"use client";

import { useId, useState } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import { GuidedPlanEvidence } from "./guided-plan-evidence";
import { formatDate, selectClass } from "./shared";
import styles from "./guided-workspace.module.css";

export function GuidedPlanHistory({
  company,
  blockedReason = "",
}: {
  company: StudioCase;
  blockedReason?: string;
}) {
  return (
    <HistorySelector
      key={`${company.id}:${company.revision}:${!!blockedReason}`}
      company={company}
      blockedReason={blockedReason}
    />
  );
}

function HistorySelector({
  company,
  blockedReason,
}: {
  company: StudioCase;
  blockedReason: string;
}) {
  const id = useId();
  const [planId, setPlanId] = useState("");
  return (
    <section aria-label="저장된 원고 읽기" className="space-y-4">
      <p className={styles.helper}>
        읽을 버전을 직접 선택해 주세요. 현재 수정할 원고와 신청 준비 대상은 바뀌지 않습니다.
      </p>
      <label htmlFor={id} className="block text-sm font-semibold">
        읽을 저장 원고
      </label>
      <select
        id={id}
        className={selectClass}
        value={planId}
        disabled={!!blockedReason}
        onChange={(event) => {
          if (!blockedReason) setPlanId(event.target.value);
        }}
      >
        <option value="">저장 버전 직접 선택</option>
        {[...company.plans]
          .sort((a, b) => b.version - a.version)
          .map((plan, index) => (
            <option key={`${plan.id}:${index}`} value={plan.id}>
              v{plan.version} · {formatDate(plan.generatedAt)} · {plan.content.title}
            </option>
          ))}
      </select>
      <GuidedStoredPlan company={company} planId={planId} blockedReason={blockedReason} />
    </section>
  );
}

/** Read only: resolve a unique stored version on every render, never change the active plan. */
export function GuidedStoredPlan({
  company,
  planId,
  blockedReason = "",
}: {
  company: StudioCase;
  planId: string;
  blockedReason?: string;
}) {
  if (blockedReason) return <p className={styles.notice}>{blockedReason}</p>;
  if (!planId) return <p className={styles.helper}>아직 읽을 원고를 선택하지 않았습니다.</p>;
  const matches = company.plans.filter((plan) => plan.id === planId);
  const plan = matches[0];
  if (
    matches.length !== 1 ||
    company.plans.filter((item) => item.version === plan.version).length !== 1
  )
    return (
      <p className={styles.notice}>
        선택한 원고를 하나로 확인하지 못했습니다. 저장 기록을 확인해 주세요.
      </p>
    );

  return (
    <article
      aria-label={`저장 원고 v${plan.version} 원문`}
      className="space-y-5 min-w-0 [overflow-wrap:anywhere]"
    >
      <header className="space-y-2">
        <h3 className={styles.subheading}>저장 원고 v{plan.version} · 읽기 전용</h3>
        <p className={styles.helper}>작성 시각: {formatDate(plan.generatedAt)}</p>
        <p className={styles.helper}>
          {plan.mode === "ai"
            ? "AI 작성 · 사용자 검토 필요"
            : plan.mode === "assisted"
              ? "자료 기반 정리본 · AI 작성 아님"
              : "수정해 보관한 계획서"}
        </p>
        <p className={styles.helper}>
          {plan.confirmedAt
            ? `저장된 내부 검토 시각: ${formatDate(plan.confirmedAt)}`
            : "전체 검토 미완료"}
          {" · 기관 제출·접수 완료를 뜻하지 않습니다."}
        </p>
        <p className={styles.helper}>
          이 버전의 기록을 표시합니다. 현재 자료와의 연결 및 사실 확인은 별도로 확인해 주세요.
        </p>
      </header>
      <h4 className="whitespace-pre-wrap text-lg font-bold">{plan.content.title}</h4>
      <div>
        <h4 className={styles.subheading}>핵심 요약</h4>
        <p className={styles.body}>{plan.content.summary}</p>
      </div>
      {plan.content.sections.map((section, index) => (
        <section
          key={`${section.key}:${index}`}
          aria-label={`저장 항목 ${index + 1}: ${section.title}`}
        >
          <h4 className={styles.subheading}>{section.title}</h4>
          <p className={styles.helper}>
            {section.needsConfirmation ? "항목 확인 필요" : "저장된 항목 확인 표시 있음"}
          </p>
          <p className={styles.body}>{section.content}</p>
        </section>
      ))}
      {(
        [
          ["남은 확인 사항", plan.content.actionItems],
          ["실사 준비 질문", plan.content.interviewQuestions],
        ] as const
      ).map(([label, items]) => (
        <section key={label}>
          <h4 className={styles.subheading}>{label}</h4>
          {items.length ? (
            <ul className="list-disc space-y-2 pl-5">
              {items.map((item, index) => (
                <li className="whitespace-pre-wrap" key={index}>
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.helper}>저장된 항목 없음</p>
          )}
        </section>
      ))}
      <section>
        <h4 className={styles.subheading}>저장된 검토 의견</h4>
        {plan.review.length ? (
          <ul className="space-y-3">
            {plan.review.map((finding, index) => (
              <li key={index} className="space-y-1 rounded-lg border p-3">
                <p className="text-sm font-semibold">
                  {finding.severity === "error"
                    ? "수정 필요"
                    : finding.severity === "warning"
                      ? "확인 필요"
                      : "참고"}
                </p>
                <p className="whitespace-pre-wrap text-sm">{finding.message}</p>
                <p className="whitespace-pre-wrap text-sm">{finding.action}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.helper}>저장된 의견 없음 · 사실과 증빙은 직접 확인해 주세요.</p>
        )}
      </section>
      <GuidedPlanEvidence company={company} plan={plan} />
    </article>
  );
}
