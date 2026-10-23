import { guidedAgencyApplicationContexts } from "@/lib/studio-guided-agency-context";
import { GuidedFollowupApplication } from "./guided-followup-application";
import { stageLabels, type StudioCase } from "@/lib/studio-schema";
import type {
  GuidedFollowupItem,
  GuidedFollowupSummary,
  GuidedWorkflowTarget,
} from "@/lib/studio-guided-followup";
import styles from "./guided-workspace.module.css";

function recordedTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ItemContext({ item }: { item: GuidedFollowupItem }) {
  const procedure = item.procedureDeadline;
  const deadline =
    item.deadlineStatus === "overdue"
      ? " · 날짜 지남"
      : item.deadlineStatus === "today"
        ? " · 오늘"
        : "";
  return (
    <>
      <p className={styles.helper}>
        {item.version !== null ? `기록 v${item.version} · ` : ""}
        {item.description}
      </p>
      <p className={styles.helper}>
        기한·일정: {item.dueOn ? `${item.dueOn}${deadline}` : "미확인"}
        {item.dueNote ? ` · ${item.dueNote}` : ""}
      </p>
      {procedure && (
        <div aria-label="요청의 절차 기한" aria-busy={procedure.state === "pending"}>
          <p className={styles.helper}>{procedure.message}</p>
          <p className={styles.helper}>
            요청 원문 기한: {procedure.originalDueOn ?? "미확인"}
            {procedure.originalDueNote ? ` · ${procedure.originalDueNote}` : ""}
          </p>
          {procedure.record && (
            <details className={styles.details}>
              <summary>절차 기한 근거 보기</summary>
              <p className={styles.helper}>
                {procedure.record.title} · 절차 v{procedure.record.version} · 기록자{" "}
                {procedure.record.recordedBy}
              </p>
              <p className={styles.helper}>
                절차 안내기한: {procedure.record.dueOn || "미확인"} ·{" "}
                {procedure.record.dueBasis || "근거 미기록"}
              </p>
              <p className={styles.helper}>
                연장 기한: {procedure.record.extendedDueOn || "미확인"} ·{" "}
                {procedure.record.extensionBasis || "근거 미기록"}
              </p>
              <p className={styles.helper}>
                기록 시각: {recordedTime(procedure.record.recordedAt)}
              </p>
              <p className={styles.helper}>
                원본 파일과 실제 기관 처리 상태는 별도로 확인해 주세요. 담당자 업무 기한은 자동
                변경하지 않습니다.
              </p>
            </details>
          )}
        </div>
      )}
    </>
  );
}

/** Local records remain local records; this view never claims a live agency check. */
export function GuidedFollowupStatus({
  company,
  stage,
  summary,
  disabled,
  onNavigate,
}: {
  company: StudioCase;
  stage: StudioCase["stage"];
  summary: GuidedFollowupSummary;
  disabled: boolean;
  onNavigate: (target: GuidedWorkflowTarget) => void;
}) {
  if (summary.state === "none") return null;
  const primary = summary.primary;
  const others = summary.items.filter((item) => item !== primary);
  const applications = guidedAgencyApplicationContexts(
    company,
    (primary ? [primary, ...others] : others).map((item) => item.target),
  );
  return (
    <section className={styles.sheet} aria-label="신청 진행 기록 요약">
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>기록된 단계</dt>
          <dd>{stageLabels[stage]} · 사용자 기록</dd>
        </div>
        <div className={styles.fact}>
          <dt>마지막 기록</dt>
          <dd>
            {recordedTime(summary.lastRecordedAt)}
            {summary.lastRecordedAt ? " (한국시간)" : ""}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>공식 상태 확인</dt>
          <dd>확인 시각 없음 · 공식 사이트 자동 조회 미연결</dd>
        </div>
      </dl>
      {primary && (
        <div className={styles.notice}>
          <strong>{primary.title}</strong>
          <ItemContext item={primary} />
          <GuidedFollowupApplication
            key={`${company.id}:${company.revision}:${JSON.stringify(primary.target)}`}
            value={applications[0]}
            disabled={disabled}
            onNavigate={onNavigate}
          />
        </div>
      )}
      {others.length > 0 && (
        <details className={styles.details}>
          <summary>함께 보관한 안내·업무 {others.length}건</summary>
          <ul className={styles.files}>
            {others.map((item, index) => (
              <li key={index} className={styles.followupItem}>
                <strong>{item.title}</strong>
                <ItemContext item={item} />
                <GuidedFollowupApplication
                  key={`${company.id}:${company.revision}:${JSON.stringify(item.target)}`}
                  value={applications[index + (primary ? 1 : 0)]}
                  disabled={disabled}
                  onNavigate={onNavigate}
                />
                <button
                  type="button"
                  className={styles.link}
                  disabled={disabled}
                  onClick={() => onNavigate(item.target)}
                >
                  {item.title} 기록 보기
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
