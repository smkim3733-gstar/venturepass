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
    </>
  );
}

/** Local records remain local records; this view never claims a live agency check. */
export function GuidedFollowupStatus({
  stage,
  summary,
  disabled,
  onNavigate,
}: {
  stage: StudioCase["stage"];
  summary: GuidedFollowupSummary;
  disabled: boolean;
  onNavigate: (target: GuidedWorkflowTarget) => void;
}) {
  if (summary.state === "none") return null;
  const primary = summary.primary;
  const others = summary.items.filter((item) => item !== primary);
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
