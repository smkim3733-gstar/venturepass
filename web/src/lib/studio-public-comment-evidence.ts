import { z } from "zod";
import type { StudioCase } from "./studio-schema";
import { canFillPublicCellEvidence } from "./studio-public-cell-evidence";
import { publicEvidenceDraftSchema, type PublicEvidenceDraft } from "./studio-public-evidence";
import { publicResearchCandidateFields } from "./studio-public-research-result";
import {
  decodePublicTableMetadata,
  readPublicTableMetadataResult,
  type PublicTableMetadata,
} from "./studio-public-table-metadata";

export type PublicCommentSelection = {
  rowIndex: number;
  row: Extract<PublicTableMetadata, { kind: "CMMT" }>["rows"][number];
};
const selectionSchema = z
  .object({ rowIndex: z.number().int().min(0).max(99), row: z.unknown() })
  .strict();
const fieldsSchema = publicEvidenceDraftSchema.pick({ title: true, url: true, quote: true });

/** One explicitly selected response row, retained as editable, unverified manual text. */
export function publicCommentEvidenceFields(
  raw: unknown,
  expectedCommand: unknown,
  selection: unknown,
) {
  const result = readPublicTableMetadataResult(raw, expectedCommand);
  if (result.status !== "results" || result.metadata?.kind !== "CMMT")
    throw Error("읽은 주석 행이 있어야 입력칸으로 옮길 수 있습니다.");
  const selected = selectionSchema.parse(selection);
  const expectedRow = decodePublicTableMetadata([selected.row], "CMMT").rows[0];
  const row = result.metadata.rows[selected.rowIndex];
  if (!row || JSON.stringify(row) !== JSON.stringify(expectedRow) || !row.CMMT_DC.trim())
    throw Error("선택한 원래 주석 본문을 확인할 수 없습니다.");
  const c = result.command;
  const quote = [
    "명시 조회한 KOSIS 주석 응답 중 담당자가 선택한 한 행 · 수동 미확인 기록",
    "전체 주석·특정 수치/기간 적용·회사 해당성·사실은 확인하지 않았습니다.",
    "행 번호는 이 응답 안의 순서이며 제공자의 고유 주석 ID가 아닙니다.",
    "원래 반환 필드만 기록합니다. 필드 없음/null/빈 따옴표는 서로 다르며 공백·줄바꿈은 JSON 문자로 보존합니다.",
    JSON.stringify(
      {
        "검색 후보": c.candidate,
        "검색 주제": c.topic,
        "처음 후보를 조회한 시각": c.searchRetrievedAt,
        "후보를 다시 대조한 시각": result.searchCheckedAt,
        "주석을 조회한 시각 (발행일·읽은 날짜 아님)": result.retrievedAt,
        "선택한 행 번호 (이 응답에서 1부터)": selected.rowIndex + 1,
        "원래 주석 행": row,
      },
      null,
      2,
    ),
    "옮긴 내용은 편집 가능한 수동 기록입니다. 보관·AI 전송·원고 채택은 별도입니다.",
  ].join("\n");
  return fieldsSchema.parse({ ...publicResearchCandidateFields(c.candidate), quote });
}

export function applyPublicCommentEvidence(
  draft: PublicEvidenceDraft,
  raw: unknown,
  expectedCommand: unknown,
  selection: unknown,
  original: Pick<StudioCase, "id" | "revision">,
  current: Pick<StudioCase, "id" | "revision">,
): PublicEvidenceDraft {
  if (original.id !== current.id || original.revision !== current.revision)
    throw Error("회사 자료가 바뀌어 주석을 옮기지 않았습니다.");
  if (!canFillPublicCellEvidence(draft))
    throw Error("제목·주소·발췌·기준 기간의 기존 입력을 덮어쓰지 않습니다.");
  return { ...draft, ...publicCommentEvidenceFields(raw, expectedCommand, selection) };
}
