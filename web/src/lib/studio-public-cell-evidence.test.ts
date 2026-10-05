import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyPublicCellEvidence,
  canFillPublicCellEvidence,
  publicCellEvidenceFields,
} from "./studio-public-cell-evidence";
import {
  emptyPublicEvidence,
  preparePublicEvidence,
  publicEvidenceSaved,
} from "./studio-public-evidence";
import {
  readManualPublicEvidence,
  publicEvidenceExportEntries,
} from "./studio-public-evidence-export";
import {
  publicSelectedCellCommandSchema,
  publicSelectedCellLimits,
} from "./studio-public-selected-cell";
import { decodePublicStatisticsCell } from "./studio-public-statistics-cell";
import { syntheticCellRow, syntheticCellTarget } from "./studio-public-statistics-test-fixture";
import { StudioStore } from "./studio-storage";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
vi.mock("server-only", () => ({}));
const at = "2026-10-05T10:00:00.000Z";
const owner = { id: "synthetic-company", revision: 7 };
function fixture() {
  const target = syntheticCellTarget();
  const command = publicSelectedCellCommandSchema.parse({
    action: "read-selected-statistics-cell",
    topic: "services",
    candidate: {
      organizationId: "999",
      tableId: "DT_SYNTHETIC",
      title: "합성 표",
      organization: "합성 제공기관",
      periodStart: "2020",
      periodEnd: "2024",
      originalUrl: "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC",
    },
    searchRetrievedAt: at,
    selection: {
      itemId: target.itemId,
      classifications: target.classifications,
      period: target.period,
    },
    confirmed: true,
  });
  const decoded = decodePublicStatisticsCell([syntheticCellRow(target)], target);
  if (decoded.status !== "matched" || !decoded.cell) throw Error("fixture");
  const result = {
    ...publicSelectedCellLimits,
    command,
    status: "matched",
    source: "kosis-api-response",
    searchCheckedAt: "2026-10-05T10:01:00.000Z",
    retrievedAt: "2026-10-05T10:02:00.000Z",
    cell: decoded.cell,
  };
  return { command, result };
}
function recordText(quote: string) {
  return JSON.parse(quote.slice(quote.indexOf("{"), quote.lastIndexOf("}") + 1));
}
it("transfers only four fields; preserves every other manual input without IO or mutating result", () => {
  const { command, result } = fixture();
  const draft = {
    ...emptyPublicEvidence,
    readOn: "2026-09-01",
    publishedOn: "2020-01-01",
    publisher: "담당자 발행처",
    relevance: "회사 관련성은 별도",
    conflicts: "상충 메모",
    sectionKey: "development" as const,
  };
  const before = JSON.stringify({ draft, result, command });
  const next = applyPublicCellEvidence(draft, result, command, owner, { ...owner });
  expect(next).toMatchObject({
    ...draft,
    title: command.candidate.title,
    url: command.candidate.originalUrl,
    period: "수동 지정 주기·시점: Y / 2024",
    quote: expect.any(String),
  });
  const record = recordText(next.quote);
  expect(record["값 원문"]).toBe("12,345.00");
  expect(record["행 수정일 원문 (발행일 아님)"]).toBe("2025-01-01");
  expect(record["수치를 조회한 시각 (발행일·읽은 날짜 아님)"]).toBe(result.retrievedAt);
  expect(record["처음 후보를 조회한 시각"]).toBe(at);
  expect(record["후보를 다시 대조한 시각"]).toBe(result.searchCheckedAt);
  expect(record["검색 후보"]).toEqual(command.candidate);
  expect(next.quote).toContain("미확인");
  expect(JSON.stringify({ draft, result, command })).toBe(before);
  next.title = "changed";
  expect(command.candidate.title).toBe("합성 표");
});
it.each(["", "0", "-", "...", " 1.00\r\n ", "<img src=x>"])(
  "preserves value %j including empty text",
  (value) => {
    const { command, result } = fixture();
    result.cell.value = value;
    const fields = publicCellEvidenceFields(result, command);
    expect(recordText(fields.quote)["값 원문"]).toBe(value);
  },
);
it("preserves null and empty metadata separately; does not invent issuer or reading dates", () => {
  const { command, result } = fixture();
  result.cell.itemName = null;
  result.cell.unitName = "";
  result.cell.lastChangedText = null;
  const next = applyPublicCellEvidence({ ...emptyPublicEvidence }, result, command, owner, owner);
  expect(next.publisher).toBe("");
  expect(next.readOn).toBe("");
  expect(next.publishedOn).toBe("");
  expect(next.relevance).toBe("");
  expect(next.conflicts).toBe("");
  const text = recordText(next.quote);
  expect(text["항목 이름 원문"]).toBeNull();
  expect(text["단위 이름 원문"]).toBe("");
});
it.each(["title", "url", "quote", "period"] as const)(
  "rejects occupied %s without partial changes",
  (key) => {
    const { command, result } = fixture();
    const draft = { ...emptyPublicEvidence, [key]: " " };
    const before = JSON.stringify(draft);
    expect(canFillPublicCellEvidence(draft)).toBe(false);
    expect(() => applyPublicCellEvidence(draft, result, command, owner, owner)).toThrow();
    expect(JSON.stringify(draft)).toBe(before);
  },
);
it.each([
  { id: "another", revision: 7 },
  { id: owner.id, revision: 8 },
  { id: owner.id, revision: 6 },
])("rejects owner change %j", (current) => {
  const { command, result } = fixture();
  expect(() =>
    applyPublicCellEvidence({ ...emptyPublicEvidence }, result, command, owner, current),
  ).toThrow();
});
it.each([
  { status: "empty", cell: null },
  {
    status: "not-configured",
    cell: null,
    source: "not-requested",
    retrievedAt: null,
    searchCheckedAt: null,
  },
  { source: "supplied-response" },
  { factChecked: true },
  { databaseChanged: true },
  { codeCatalogVerified: true },
  { extra: "private" },
])("rejects non-transferable result %j", (change) => {
  const { command, result } = fixture();
  expect(() => publicCellEvidenceFields({ ...result, ...change }, command)).toThrow();
});
it.each(["title", "tableId", "organization", "originalUrl"] as const)(
  "rejects changed candidate %s",
  (key) => {
    const { command, result } = fixture();
    const expected = structuredClone(command);
    expected.candidate[key] = "changed";
    expect(() => publicCellEvidenceFields(result, expected)).toThrow();
  },
);
it.each(["item", "class", "period", "timestamp"])("rejects changed selection %s", (field) => {
  const { command, result } = fixture();
  const expected = structuredClone(command);
  if (field === "item") expected.selection.itemId = "OTHER";
  if (field === "class") expected.selection.classifications.reverse();
  if (field === "period") expected.selection.period.point = "2023";
  if (field === "timestamp") expected.searchRetrievedAt = "2026-10-05T10:03:00.000Z";
  expect(() => publicCellEvidenceFields(result, expected)).toThrow();
});
it("rejects overlong title and serialized excerpt without cutting text", () => {
  const f = fixture();
  f.command.candidate.title = "가".repeat(121);
  expect(() => publicCellEvidenceFields(f.result, f.command)).toThrow();
  f.command.candidate.title = "가".repeat(120);
  expect(publicCellEvidenceFields(f.result, f.command).title).toHaveLength(120);
  f.command.selection.classifications = Array(8).fill("001");
  f.result.cell.classifications = Array.from({ length: 8 }, () => ({
    code: "001",
    dimensionName: "\n".repeat(3000),
    valueName: "\n".repeat(3000),
  }));
  expect(() => publicCellEvidenceFields(f.result, f.command)).toThrow();
  expect(f.result.cell.classifications[0].valueName).toHaveLength(3000);
});
it("normal transferred record remains readable in existing manual export without granting facts", () => {
  const f = fixture();
  const company = supplementFixture().value;
  company.sources = company.sources.slice(0, 2);
  const draft = { ...publicCellEvidenceFields(f.result, f.command), ...emptyPublicEvidence };
  Object.assign(draft, publicCellEvidenceFields(f.result, f.command), { readOn: "2026-10-05" });
  expect(() => preparePublicEvidence(company, draft, randomUUID(), at, false)).toThrow();
  const req = preparePublicEvidence(company, draft, randomUUID(), at, true);
  expect(readManualPublicEvidence(req.command.source)?.quote).toBe(draft.quote);
  company.sources.push(req.command.source);
  company.plans[0].content.sections[0].evidence = [
    { sourceId: req.command.source.id, quote: "12,345.00", locator: "값 원문" },
  ];
  const entries = publicEvidenceExportEntries(company, company.plans[0]);
  expect(entries).toHaveLength(1);
  expect(entries[0].lines.join("\n")).toContain("의미·수치·사실 검증은 아님");
});
it("existing writer and GET recovery preserve source/plan content and create only one manual source", () => {
  const dir = mkdtempSync(join(tmpdir(), "venturepass-cell-evidence-"));
  let store = new StudioStore(dir);
  try {
    const f = fixture();
    const company = supplementFixture().value;
    company.sources = company.sources.slice(0, 2);
    const created = store.create(company.profile);
    company.id = created.id;
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE studio_cases SET revision = ?, body = ? WHERE id = ?").run(
      company.revision,
      JSON.stringify(company),
      company.id,
    );
    const before = store.get(company.id);
    const draft = {
      ...emptyPublicEvidence,
      ...publicCellEvidenceFields(f.result, f.command),
      readOn: "2026-10-05",
    };
    const req = preparePublicEvidence(before, draft, randomUUID(), at, true);
    store.mutate(before.id, req.command, () => []);
    store.close();
    store = new StudioStore(dir);
    const after = store.get(before.id);
    expect(publicEvidenceSaved(after, req)).not.toBeNull();
    expect(after.sources).toHaveLength(3);
    expect(after.sources.slice(0, 2)).toEqual(before.sources);
    expect(after.plans).toEqual(before.plans.map((p) => ({ ...p, confirmedAt: null })));
    expect(readManualPublicEvidence(after.sources.at(-1)!)).toEqual(draft);
    expect(() => store.mutate(before.id, req.command, () => [])).toThrow();
    expect(store.get(before.id)).toEqual(after);
  } finally {
    store.close();
    const r = relative(resolve(tmpdir()), resolve(dir));
    if (!r || r.startsWith("..") || isAbsolute(r)) throw Error("unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});
