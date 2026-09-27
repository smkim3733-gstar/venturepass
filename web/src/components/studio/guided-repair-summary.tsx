import type { StudioCase } from "@/lib/studio-schema";
import type { GuidedPreparationRun } from "@/lib/studio-guided-preparation-types";
import styles from "./guided-workspace.module.css";

const labels = {
  pending: "작성한 초안을 보관했어요",
  "not-needed": "작성·검토 결과를 보관했어요",
  applied: "계획서를 수정하고 다시 점검했어요",
  unresolved: "수정본을 보관했어요. 확인할 내용이 남아 있어요",
  rejected: "이전 원고를 보관했어요. 수정안은 적용하지 않았어요",
  failed: "원고는 보관했어요. 자동 수정을 마치지 못했어요",
} as const;

export function GuidedRepairSummary({
  company,
  run,
}: {
  company: StudioCase;
  run?: GuidedPreparationRun;
}) {
  const repair = run?.repair;
  if (!repair || run.approval.caseId !== company.id) return null;
  const initial = company.plans.find((plan) => plan.id === repair.initialPlanId);
  const final = company.plans.find((plan) => plan.id === repair.finalPlanId);
  if (
    !initial ||
    initial.candidateId !== run.candidateId ||
    (repair.finalPlanId !== null && !final) ||
    (final && final.candidateId !== initial.candidateId) ||
    run.planId !== (final?.id ?? initial.id) ||
    (["applied", "unresolved", "not-needed", "rejected"].includes(repair.status) && !final) ||
    (["not-needed", "failed", "rejected"].includes(repair.status) &&
      final &&
      final.id !== initial.id) ||
    (repair.status === "pending" && final)
  )
    return null;
  const changes =
    final?.content.sections.filter((section) => {
      const before = initial.content.sections.find((item) => item.key === section.key);
      return (
        before &&
        (before.content !== section.content ||
          JSON.stringify(before.evidence) !== JSON.stringify(section.evidence))
      );
    }) ?? [];
  return (
    <div className={styles.notice}>
      <strong>{labels[repair.status]}</strong>
      <p>{repair.reason} 사실·수치의 확인과 제출 전 검토는 별도로 진행해 주세요.</p>
      <details className={styles.details}>
        <summary>AI 검토·수정 이력</summary>
        <p>
          자동 수정 {repair.attempted ? "1회 시도" : "시도 없음"} · 최초 원고 v{initial.version}
          {final && final.id !== initial.id ? ` → 수정 원고 v${final.version}` : " 유지"}
        </p>
        <p>
          확인 의견 {repair.initialReviewCount}개
          {repair.finalReviewCount !== null
            ? ` → ${repair.finalReviewCount}개`
            : " · 다음 검토 미완료"}
          . 의견 수는 승인 가능성이나 심사 점수가 아닙니다.
        </p>
        {changes.map((section) => (
          <details className={styles.details} key={section.key}>
            <summary>{section.title} 수정 전·후</summary>
            <p className={styles.eyebrow}>수정 전</p>
            <p className={styles.body}>
              {initial.content.sections.find((item) => item.key === section.key)?.content}
            </p>
            <p className={`${styles.eyebrow} mt-4`}>수정 후</p>
            <p className={styles.body}>{section.content}</p>
          </details>
        ))}
        {initial.review.some((item) => item.severity !== "info") && (
          <details className={styles.details}>
            <summary>처음 발견한 확인 의견</summary>
            <ul className={styles.reviewList}>
              {initial.review
                .filter((item) => item.severity !== "info")
                .map((item, index) => (
                  <li key={index}>
                    {item.message} {item.action}
                  </li>
                ))}
            </ul>
          </details>
        )}
      </details>
    </div>
  );
}
