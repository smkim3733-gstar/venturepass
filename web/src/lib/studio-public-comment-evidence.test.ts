import { expect, it, vi } from "vitest";
import {
  applyPublicCommentEvidence,
  publicCommentEvidenceFields,
} from "./studio-public-comment-evidence";
import { emptyPublicEvidence } from "./studio-public-evidence";
import {
  publicTableMetadataCommandSchema,
  publicTableMetadataLimits,
  readPublicTableMetadataResult,
} from "./studio-public-table-metadata";
import { publicCellEvidenceFields } from "./studio-public-cell-evidence";
import {
  publicSelectedCellCommandSchema,
  publicSelectedCellLimits,
} from "./studio-public-selected-cell";
import { decodePublicStatisticsCell } from "./studio-public-statistics-cell";
import { syntheticCellRow, syntheticCellTarget } from "./studio-public-statistics-test-fixture";

vi.mock("openai", () => {
  throw Error("SDK import forbidden");
});
vi.mock("openai/helpers/zod", () => {
  throw Error("SDK helper forbidden");
});
vi.mock("openai/error", () => {
  throw Error("SDK error forbidden");
});
vi.mock("node:sqlite", () => {
  throw Error("SQL import forbidden");
});
vi.mock("./studio-storage", () => {
  throw Error("storage import forbidden");
});
vi.mock("./quality-store", () => {
  throw Error("quality store forbidden");
});
vi.mock("./quality-provider-production", () => {
  throw Error("runtime forbidden");
});
const owner = { id: "synthetic-company", revision: 7 };
function fixture() {
  const command = publicTableMetadataCommandSchema.parse({
    action: "read-selected-table-metadata",
    topic: "services",
    confirmed: true,
    kind: "CMMT",
    searchRetrievedAt: "2026-10-07T01:00:00.000Z",
    candidate: {
      organizationId: "999",
      tableId: "DT_SYNTHETIC",
      title: "합성 표",
      organization: "합성 기관",
      periodStart: "2020",
      periodEnd: "2024",
      originalUrl: "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC",
    },
  });
  const rows = [
    {
      CMMT_NM: " 주석 ",
      CMMT_DC: "  원문\r\n<script>literal</script>  ",
      OBJ_ID: "",
      OBJ_NM: null,
      ITM_ID: " 01 ",
    },
    {
      CMMT_NM: "같은 분류의 다른 행",
      CMMT_DC: "두 번째 본문",
      OBJ_ID: "",
      OBJ_NM: null,
      ITM_ID: " 01 ",
    },
  ];
  const result = readPublicTableMetadataResult(
    {
      ...publicTableMetadataLimits,
      command,
      source: "kosis-api-response",
      status: "results",
      searchCheckedAt: "2026-10-07T01:01:00.000Z",
      retrievedAt: "2026-10-07T01:02:00.000Z",
      metadata: { kind: "CMMT", rows },
    },
    command,
  );
  return { command, result, selection: { rowIndex: 0, row: rows[0] } };
}
function record(quote: string) {
  return JSON.parse(quote.slice(quote.indexOf("{"), quote.lastIndexOf("}") + 1));
}
it("4H10 preserves exact selected row, field absence and timestamps without IO or mutation", () => {
  const f = fixture();
  const draft = {
    ...emptyPublicEvidence,
    readOn: "2026-09-01",
    publishedOn: "2020-01-01",
    publisher: "수동 발행처",
    relevance: "개인 메모",
    conflicts: "다른 자료",
    sectionKey: "development" as const,
  };
  const before = JSON.stringify({ f, draft });
  const next = applyPublicCommentEvidence(draft, f.result, f.command, f.selection, owner, owner);
  expect(next).toEqual({
    ...draft,
    title: f.command.candidate.title,
    url: f.command.candidate.originalUrl,
    quote: expect.any(String),
  });
  const text = record(next.quote);
  expect(text["원래 주석 행"]).toEqual(f.selection.row);
  expect(text["원래 주석 행"]).not.toHaveProperty("ITM_NM");
  expect(text["선택한 행 번호 (이 응답에서 1부터)"]).toBe(1);
  expect(text["검색 후보"]).toEqual(f.command.candidate);
  expect(text["처음 후보를 조회한 시각"]).toBe(f.command.searchRetrievedAt);
  expect(text["후보를 다시 대조한 시각"]).toBe(f.result.searchCheckedAt);
  expect(text["주석을 조회한 시각 (발행일·읽은 날짜 아님)"]).toBe(f.result.retrievedAt);
  expect(next.period).toBe("");
  expect(next.quote).toContain("수동 미확인");
  expect(JSON.stringify({ f, draft })).toBe(before);
});
it("4H10 selects the second repeated-ID row by position and full original contents", () => {
  const f = fixture();
  const rows = f.result.metadata!.rows;
  const next = publicCommentEvidenceFields(f.result, f.command, { rowIndex: 1, row: rows[1] });
  expect(record(next.quote)["원래 주석 행"]).toEqual(rows[1]);
  expect(record(next.quote)["선택한 행 번호 (이 응답에서 1부터)"]).toBe(2);
  expect(() =>
    publicCommentEvidenceFields(f.result, f.command, { rowIndex: 1, row: rows[0] }),
  ).toThrow();
});
it.each(["title", "url", "period", "quote"] as const)(
  "4H10 preserves occupied %s including whitespace",
  (key) => {
    const f = fixture(),
      draft = { ...emptyPublicEvidence, [key]: " " };
    expect(() =>
      applyPublicCommentEvidence(draft, f.result, f.command, f.selection, owner, owner),
    ).toThrow();
    expect(draft[key]).toBe(" ");
  },
);
it.each([
  { id: "other", revision: 7 },
  { id: owner.id, revision: 8 },
  { id: owner.id, revision: 6 },
])("4H10 rejects changed company/revision %j", (current) => {
  const f = fixture();
  expect(() =>
    applyPublicCommentEvidence(
      { ...emptyPublicEvidence },
      f.result,
      f.command,
      f.selection,
      owner,
      current,
    ),
  ).toThrow();
});
it.each([-1, 0.5, 2, 100, NaN, Infinity, "0", null])(
  "4H10 rejects bad row position %j",
  (rowIndex) => {
    const f = fixture();
    expect(() =>
      publicCommentEvidenceFields(f.result, f.command, { ...f.selection, rowIndex }),
    ).toThrow();
  },
);
it.each(["", " \r\n "])("4H10 rejects empty or whitespace-only body %j", (body) => {
  const f = fixture();
  if (f.result.metadata?.kind !== "CMMT") throw Error("fixture");
  f.result.metadata.rows[0].CMMT_DC = body;
  f.selection.row.CMMT_DC = body;
  expect(() => publicCommentEvidenceFields(f.result, f.command, f.selection)).toThrow();
});
it.each(["CMMT_NM", "CMMT_DC", "OBJ_ID", "OBJ_NM", "ITM_ID", "ITM_NM"])(
  "4H10 rejects changed original field %s",
  (field) => {
    const f = fixture();
    expect(() =>
      publicCommentEvidenceFields(f.result, f.command, {
        ...f.selection,
        row: { ...f.selection.row, [field]: "changed" },
      }),
    ).toThrow();
  },
);
it.each([
  { factChecked: true },
  { databaseChanged: true },
  { source: "supplied-response" },
  { extra: "private" },
])("4H10 rejects modified result authority %j", (change) => {
  const f = fixture();
  expect(() =>
    publicCommentEvidenceFields({ ...f.result, ...change }, f.command, f.selection),
  ).toThrow();
});
it.each(["title", "organization", "tableId", "originalUrl"] as const)(
  "4H10 rejects changed candidate %s",
  (field) => {
    const f = fixture(),
      command = structuredClone(f.command);
    command.candidate[field] = "changed";
    expect(() => publicCommentEvidenceFields(f.result, command, f.selection)).toThrow();
  },
);
it("4H10 rejects changed search time, metadata kind and unknown selection fields", () => {
  const f = fixture();
  for (const command of [
    { ...f.command, searchRetrievedAt: "2026-10-07T02:00:00.000Z" },
    { ...f.command, kind: "TBL" },
  ])
    expect(() => publicCommentEvidenceFields(f.result, command, f.selection)).toThrow();
  expect(() =>
    publicCommentEvidenceFields(f.result, f.command, { ...f.selection, company: "private" }),
  ).toThrow();
});
it("4H10 rejects valid empty, unconfigured and non-comment metadata responses", () => {
  const f = fixture();
  for (const raw of [
    { ...f.result, status: "empty", metadata: { kind: "CMMT", rows: [] } },
    {
      ...f.result,
      status: "not-configured",
      source: "not-requested",
      searchCheckedAt: null,
      retrievedAt: null,
      metadata: null,
    },
  ])
    expect(() => publicCommentEvidenceFields(raw, f.command, f.selection)).toThrow();
  const command = { ...f.command, kind: "TBL" };
  expect(() =>
    publicCommentEvidenceFields(
      { ...f.result, command, metadata: { kind: "TBL", rows: [{ TBL_NM: "표" }] } },
      command,
      f.selection,
    ),
  ).toThrow();
});
it("4H10 rejects overlong title and escaped excerpt without truncation", () => {
  const f = fixture();
  f.command.candidate.title = "가".repeat(121);
  f.result.command.candidate.title = f.command.candidate.title;
  expect(() => publicCommentEvidenceFields(f.result, f.command, f.selection)).toThrow();
  f.command.candidate.title = "가".repeat(120);
  f.result.command.candidate.title = f.command.candidate.title;
  expect(publicCommentEvidenceFields(f.result, f.command, f.selection).title).toHaveLength(120);
  const row = {
    CMMT_NM: "주석",
    CMMT_DC: "\u0001".repeat(3000),
    OBJ_NM: "\u0001".repeat(3000),
    ITM_NM: "\u0001".repeat(3000),
  };
  const raw = { ...f.result, metadata: { kind: "CMMT", rows: [row] } };
  expect(() => publicCommentEvidenceFields(raw, f.command, { rowIndex: 0, row })).toThrow();
  expect(row.CMMT_DC).toHaveLength(3000);
});
it("4H10 keeps optional fields absent/null/empty and duplicate rows without inventing dates", () => {
  const f = fixture();
  const row = { CMMT_NM: "", CMMT_DC: "본문", OBJ_ID: "", OBJ_NM: null, ITM_NM: " " };
  const raw = { ...f.result, metadata: { kind: "CMMT", rows: [row, row] } };
  const next = applyPublicCommentEvidence(
    { ...emptyPublicEvidence },
    raw,
    f.command,
    { rowIndex: 1, row },
    owner,
    owner,
  );
  expect(record(next.quote)["원래 주석 행"]).toEqual(row);
  expect(next.readOn).toBe("");
  expect(next.publishedOn).toBe("");
  expect(next.publisher).toBe("");
  expect(next.period).toBe("");
});
it("4H10 reuses existing single-cell preparation without SQL fixture imports", () => {
  const f = fixture(),
    target = syntheticCellTarget();
  const { kind: _kind, ...baseCommand } = f.command;
  void _kind;
  const command = publicSelectedCellCommandSchema.parse({
    ...baseCommand,
    action: "read-selected-statistics-cell",
    selection: {
      itemId: target.itemId,
      classifications: target.classifications,
      period: target.period,
    },
  });
  // The single-cell command has no metadata kind.
  const decoded = decodePublicStatisticsCell([syntheticCellRow(target)], target);
  if (decoded.status !== "matched") throw Error("fixture");
  const result = {
    ...publicSelectedCellLimits,
    command,
    source: "kosis-api-response",
    status: "matched",
    cell: decoded.cell,
    searchCheckedAt: f.result.searchCheckedAt,
    retrievedAt: f.result.retrievedAt,
  };
  expect(publicCellEvidenceFields(result, command).period).toContain("2024");
});
it("4H10 imports the transfer path without SDK or SQLite", async () => {
  const mod = await import("./studio-public-comment-evidence");
  expect(mod.publicCommentEvidenceFields).toBe(publicCommentEvidenceFields);
});
