import { sectionDefinitions, sourceKindLabels, type StudioCase } from "@/lib/studio-schema";
import {
  guidedQuestionExamples,
  type GuidedQuestionContext,
  type GuidedQuestionLink,
} from "./guided-question-context";
import styles from "./guided-workspace.module.css";

export function GuidedQuestionCard({
  question,
  company,
  link,
  onLink,
  disabled = false,
}: {
  question: GuidedQuestionContext;
  company: StudioCase;
  link?: GuidedQuestionLink;
  onLink?: (link: GuidedQuestionLink) => void;
  disabled?: boolean;
}) {
  const value = link ?? { sectionKey: "", sourceIds: [] };
  const examples = guidedQuestionExamples(value.sectionKey);
  return (
    <div className="space-y-2 mb-3">
      <p className={styles.helper}>
        {question.priority === "high" ? "우선 확인 · " : ""}
        {question.reason}
      </p>
      <details className={styles.details}>
        <summary>질문 출처 확인</summary>
        {question.origins.map((origin, i) => (
          <p key={i} className={styles.helper}>
            {origin.label} · {origin.identity}
            <br />
            {origin.reason}
          </p>
        ))}
      </details>
      {onLink ? (
        <>
          <label className="block text-sm">
            관련 계획서 항목 (직접 지정)
            <select
              className="block w-full mt-1 border rounded p-2 bg-white"
              value={value.sectionKey}
              disabled={disabled}
              onChange={(e) => onLink({ ...value, sectionKey: e.target.value })}
            >
              <option value="">연결 항목 미지정</option>
              {sectionDefinitions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <p className={styles.helper}>
            질문에 항목 정보가 없어 자동으로 연결하지 않습니다. 실제 관련 항목을 선택해 주세요.
          </p>
          <p className={styles.helper}>
            도움이 될 수 있는 자료 예시:{" "}
            {examples.length ? examples.join(" · ") : "질문과 관련된 원문, 작성 시점과 담당자 메모"}
            . 필수서류 목록은 아닙니다.
          </p>
          <details className={styles.details}>
            <summary>보관 자료 연결 · {value.sourceIds.length}개</summary>
            <p className={styles.helper}>
              연결만으로 내용 채택·사실 확인·AI 전송이 되지는 않습니다.
            </p>
            <p className={styles.helper}>
              자료 이름이 같으면 저장된 본문을 펼쳐 구분한 뒤 연결해 주세요. 현재 보관 중인
              내용이며, 읽기만 해서는 자료가 선택되지 않습니다.
            </p>
            <div className="max-h-96 overflow-y-auto">
              {company.sources.map((source, index) => (
                <div key={`${company.id}:${source.id}`} className="border-b py-2 last:border-0">
                  <label className="flex gap-2 py-2 text-sm break-all">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={value.sourceIds.includes(source.id)}
                      onChange={(e) =>
                        onLink({
                          ...value,
                          sourceIds: e.target.checked
                            ? [...value.sourceIds, source.id]
                            : value.sourceIds.filter((id) => id !== source.id),
                        })
                      }
                    />
                    자료 {index + 1} · {source.name}{" "}
                    {source.extraction === "pending" ? "· 본문 채택 전" : "· 진위 확인 별도"}
                  </label>
                  <details className={styles.details} aria-label={`자료 ${index + 1} 저장된 본문`}>
                    <summary>저장된 본문 보기</summary>
                    <p className={styles.helper}>
                      자료 종류: {sourceKindLabels[source.kind]}
                      {source.originalName ? ` · 원래 파일: ${source.originalName}` : ""}
                    </p>
                    {source.extraction === "pending" && (
                      <p className={styles.helper}>
                        본문 판독·채택 전 자료입니다. 자료 화면에서 필요한 본문을 먼저 확인해
                        주세요.
                      </p>
                    )}
                    {source.text.trim() ? (
                      <p className="whitespace-pre-wrap break-words text-sm leading-6">
                        {source.text}
                      </p>
                    ) : (
                      <p className={styles.helper}>저장된 본문이 없습니다.</p>
                    )}
                  </details>
                </div>
              ))}
              {!company.sources.length && (
                <p className={styles.helper}>
                  보관한 파일이 없습니다. 짧은 답변이나 메모만 남겨도 됩니다.
                </p>
              )}
            </div>
          </details>
        </>
      ) : (
        <p className={styles.helper}>
          답변 화면에서 관련 항목과 보완 자료를 직접 연결할 수 있습니다.
        </p>
      )}
    </div>
  );
}
