import type { StudioCase } from "./studio-schema";
import { publicEvidenceDraftSchema, type PublicEvidenceDraft } from "./studio-public-evidence";
import { publicResearchCandidateFields } from "./studio-public-research-result";
import { readPublicSelectedCellResult } from "./studio-public-selected-cell";

const fieldsSchema = publicEvidenceDraftSchema.pick({
  title: true,
  url: true,
  period: true,
  quote: true,
});
export function canFillPublicCellEvidence(draft: PublicEvidenceDraft) {
  return [draft.title, draft.url, draft.period, draft.quote].every((value) => value === "");
}

/** Editable manual text only. The API response is not a durable server receipt or fact check. */
export function publicCellEvidenceFields(raw: unknown, expectedCommand: unknown) {
  const result = readPublicSelectedCellResult(raw, expectedCommand);
  if (result.status !== "matched" || !result.cell)
    throw Error("읽은 수치 한 건이 있어야 입력칸으로 옮길 수 있습니다.");
  const c = result.command;
  const identity = publicResearchCandidateFields(c.candidate);
  // JSON string escaping preserves empty/null, whitespace and line breaks in provider text.
  const quote = [
    "수동 코드 지정으로 명시 조회한 KOSIS 수치 1건 · 담당자 검토용 기록",
    "코드 선택의 진위·회사 해당성·사실·단위 해석·통계표 전체/주석은 미확인입니다.",
    "아래는 선택조건과 응답 문자를 함께 옮긴 기록이며 통계표 원문 전체의 발췌가 아닙니다.",
    "null은 미제공, 빈 따옴표는 빈 문자입니다. 따옴표·줄바꿈 표기는 조회 문자를 보존합니다.",
    JSON.stringify(
      {
        "선택 방식": "담당자 수동 지정 · 미검증",
        "전송 경로": "KOSIS API 응답 · 영속 공식 증거 아님",
        "검색 후보": c.candidate,
        "검색 주제": c.topic,
        "처음 후보를 조회한 시각": c.searchRetrievedAt,
        "후보를 다시 대조한 시각": result.searchCheckedAt,
        "수치를 조회한 시각 (발행일·읽은 날짜 아님)": result.retrievedAt,
        "항목 코드 (수동)": c.selection.itemId,
        "분류 코드 (분류 1부터 순서대로 수동 지정)": c.selection.classifications,
        "주기·시점 (수동)": c.selection.period,
        "표 이름 원문": result.cell.tableName,
        "항목 이름 원문": result.cell.itemName,
        "분류 이름 원문 (선택 순서)": result.cell.classifications,
        "값 원문": result.cell.value,
        "단위 코드 원문": result.cell.unitId,
        "단위 이름 원문": result.cell.unitName,
        "행 수정일 원문 (발행일 아님)": result.cell.lastChangedText,
      },
      null,
      2,
    ),
    "이 기록을 옮긴 것만으로 보관·AI 전송·원고 채택에 동의한 것이 아닙니다.",
  ].join("\n");
  return fieldsSchema.parse({
    ...identity,
    quote,
    period: `수동 지정 주기·시점: ${c.selection.period.cycle} / ${c.selection.period.point}`,
  });
}
type Owner = Pick<StudioCase, "id" | "revision">;
export function applyPublicCellEvidence(
  draft: PublicEvidenceDraft,
  raw: unknown,
  expectedCommand: unknown,
  original: Owner,
  current: Owner,
): PublicEvidenceDraft {
  if (original.id !== current.id || original.revision !== current.revision)
    throw Error("회사 자료가 바뀌어 조회 기록을 옮기지 않았습니다.");
  if (!canFillPublicCellEvidence(draft))
    throw Error("제목·주소·발췌·기준 기간의 기존 입력을 먼저 확인해 주세요. 덮어쓰지 않습니다.");
  return { ...draft, ...publicCellEvidenceFields(raw, expectedCommand) };
}
