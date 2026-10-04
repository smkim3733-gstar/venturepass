"use client";

import { materialReadiness } from "@/lib/studio-material-readiness";
import type { StudioCase } from "@/lib/studio-schema";
import styles from "./guided-material-readiness.module.css";

const number = (value: number) => value.toLocaleString("ko-KR");

export function GuidedMaterialReadiness({
  company,
  locked,
  onReviewSources,
}: {
  company: StudioCase;
  locked: boolean;
  onReviewSources: () => void;
}) {
  const state = materialReadiness(company);
  return (
    <section className={styles.panel} aria-label="자료와 AI 입력 현황">
      <div className={styles.heading}>
        <h3>현재 자료로 어디까지 쓸 수 있나요?</h3>
        <span>
          저장·접수 예약 {state.occupied} / {state.sourceLimit}개
        </span>
      </div>
      <dl className={styles.counts}>
        <div>
          <dt>저장된 자료</dt>
          <dd>{state.stored}개</dd>
        </div>
        <div>
          <dt>본문 있음</dt>
          <dd>{state.withBody}개</dd>
        </div>
        <div>
          <dt>본문 준비 필요</dt>
          <dd>{state.pendingBody}개</dd>
        </div>
      </dl>
      <p>
        {state.overLimit
          ? "현재 입력이 첫 분석 한도를 넘었습니다. 아래에서 용량을 확인하고 내용을 정리해 주세요."
          : state.withBody
            ? "본문이 있는 자료와 저장된 회사 설명으로 초안을 준비할 수 있습니다."
            : state.hasDescription
              ? "첨부 본문이 없어도 저장된 회사 설명으로 초안을 시작할 수 있습니다."
              : "회사 설명을 적거나 자료 본문을 준비하면 초안을 시작할 수 있습니다."}{" "}
        근거가 부족한 내용과 수치·시점·확정 여부는 최종 사용 전에 확인해 주세요.
      </p>
      {state.awaitingAdoption > 0 && (
        <p className={styles.attention}>
          판독 결과 확인 대기 {state.awaitingAdoption}개 · 판독된 결과는 본문으로 채택하기 전까지 AI
          입력에 반영되지 않습니다.
        </p>
      )}
      {(state.pendingBody > 0 || state.awaitingAdoption > 0 || state.occupied > state.stored) && (
        <button type="button" disabled={locked} onClick={onReviewSources}>
          본문 판독·채택 확인
        </button>
      )}
      <details className={styles.details}>
        <summary>AI 입력 범위와 용량 확인</summary>
        <p>
          현재 첫 분석에는 저장된 회사 정보와 판독 대기 상태가 아닌 자료 {state.included}개의
          본문·기본 정보가 포함됩니다. 판독 대기 자료 {state.excluded}개의 내용은 제외됩니다.
          {state.includedEmpty > 0 &&
            ` 이 중 본문이 빈 ${state.includedEmpty}개는 기본 정보만 포함됩니다.`}
        </p>
        <p>
          원본 파일과 사업자등록번호 입력칸은 보내지 않습니다. 본문에 적힌 개인정보는 별도로 확인해
          주세요.
        </p>
        <p
          className={state.overLimit ? styles.attention : undefined}
          role={state.overLimit ? "alert" : undefined}
        >
          첫 분석 입력 {number(state.serializedCharacters)} / {number(state.characterLimit)}자
          {state.overLimit &&
            " · 한도 초과: 내용을 정리해야 분석할 수 있습니다. 원문을 자동으로 자르지 않습니다."}
        </p>
        <p className={styles.note}>
          전송 형식과 회사 정보를 포함한 글자 수입니다. 초안·검토에는 추가 내용이 붙어 한도를 다시
          확인합니다. AI 토큰 한도나 결과 품질을 보장하는 수치는 아닙니다. 파일 개수·크기와 본문
          저장 한도는 별도입니다.
        </p>
        <ul className={styles.sources} aria-label="현재 첫 분석 자료 범위">
          {state.rows.map((row) => (
            <li key={row.sourceId}>
              <strong>{row.name}</strong>
              <span>
                {row.included
                  ? row.hasBody
                    ? "본문 포함"
                    : "빈 본문 · 기본 정보만 포함"
                  : "내용 제외 · 판독 대기"}
              </span>
              {row.resultAwaitingAdoption && <span>새 판독 결과는 채택 전</span>}
            </li>
          ))}
        </ul>
        <p className={styles.note}>
          검색·필터는 이 입력 범위를 바꾸지 않습니다. 실제 전송은 별도 승인 단계에서 확인합니다.
        </p>
      </details>
      {state.equalBodyGroups.length > 0 && (
        <details className={styles.details}>
          <summary>같은 본문이 있는 자료 {state.equalBodyGroups.length}묶음 확인</summary>
          <p>
            저장된 본문이 완전히 같습니다. 같은 원본인지, 다른 시점의 자료인지 대조해 주세요.
            자동으로 제외하거나 중복 파일로 확정하지 않습니다.
          </p>
          <ul className={styles.sources}>
            {state.equalBodyGroups.map((group) => (
              <li key={group[0].sourceId}>{group.map((row) => row.name).join(" · ")}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
