import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { supplementFixture } from "./studio-plan-supplement-test-helpers";
import { StudioStore } from "./studio-storage";
import { preparePlanSupplement } from "./studio-plan-supplement";
import { answerSuggestionSha as sha } from "./studio-answer-suggestion";
import {
  emptyPublicEvidence,
  publicEvidenceDraftSchema,
  publicEvidenceText,
  preparePublicEvidence,
  publicEvidenceSaved,
} from "./studio-public-evidence";
import { PublicEvidencePanel } from "@/components/studio/public-evidence-panel";
import { PlanSupplementPanel } from "@/components/studio/plan-supplement-panel";
vi.mock("server-only", () => ({}));
const at = "2026-10-05T01:00:00.000Z";
const draft = {
  ...emptyPublicEvidence,
  title: "합성 산업 보고서",
  url: "https://example.invalid/report",
  readOn: "2026-10-05",
  quote: "  합성 공개 발췌입니다.\r\n다른 기준 기간입니다.  ",
  sectionKey: "development" as const,
};
function fixture() {
  const f = supplementFixture();
  f.value.sources = f.value.sources.slice(0, 2);
  return f;
}
it("preserves exact excerpt, distinct date provenance and unknowns without IO or input mutation", () => {
  const f = fixture(),
    before = JSON.stringify({ company: f.value, draft });
  const r = preparePublicEvidence(f.value, draft, randomUUID(), at, true);
  expect(r.command.source.text).toContain("[원문 발췌 시작]\n" + draft.quote + "\n[원문 발췌 끝]");
  expect(r.command.source.text).toContain("발행일 (원문 표기): 미확인");
  expect(r.command.source.text).toContain("자료의 기준 기간·대상: 미확인");
  expect(r.command.source.text).toContain("담당자가 원문을 읽었다고 기록한 날짜: 2026-10-05");
  expect(r.command.source.text).toContain("상충이 없다는 판단은 아님");
  expect(r.command.source.text).toContain("우리 회사의 매출·계약·기술 실적을 증명하지 않습니다");
  expect(r.command.source.extraction).toBe("manual");
  expect(JSON.stringify({ company: f.value, draft })).toBe(before);
  r.command.source.text = "changed";
  expect(f.value.sources[0].text).not.toBe("changed");
});
it("keeps publication, reference period, read date and user notes distinct", () => {
  const text = publicEvidenceText({
    ...draft,
    publisher: "합성 발행처",
    publishedOn: "2024-06-01",
    period: "2023년 산업 전체",
    relevance: "담당자 추정",
    conflicts: "2025년 회사 실적과 기준이 다름",
  });
  for (const part of [
    "발행일 (원문 표기): 2024-06-01",
    "자료의 기준 기간·대상: 2023년 산업 전체",
    "기록한 날짜: 2026-10-05",
    "원문 및 확인된 회사 사실과 구분",
    "담당자 추정",
    "2025년 회사 실적과 기준이 다름",
  ])
    expect(text).toContain(part);
});
it.each([
  "http://example.invalid/a",
  "javascript:alert(1)",
  "https://user:password@example.invalid/a",
  "file:///c:/test",
])("rejects non-public-use URL form %s", (url) => {
  expect(publicEvidenceDraftSchema.safeParse({ ...draft, url }).success).toBe(false);
});
it.each([
  { readOn: "" },
  { readOn: "2026-02-30" },
  { publishedOn: "2025-02-29" },
  { title: "" },
  { quote: "  " },
  { title: "a\nb" },
  { extra: true },
])("rejects invalid or extra input %j", (change) => {
  expect(publicEvidenceDraftSchema.safeParse({ ...draft, ...change }).success).toBe(false);
});
it("retains full boundary text and rejects excess without truncation", () => {
  expect(publicEvidenceText({ ...draft, quote: "가".repeat(50000) })).toContain("가".repeat(50000));
  for (const change of [
    { quote: "가".repeat(50001) },
    { relevance: "x".repeat(3001) },
    { conflicts: "x".repeat(3001) },
  ])
    expect(publicEvidenceDraftSchema.safeParse({ ...draft, ...change }).success).toBe(false);
});
it("requires explicit local storage confirmation and unused source identity", () => {
  const f = fixture();
  expect(() => preparePublicEvidence(f.value, draft, randomUUID(), at, false)).toThrow();
  expect(() => preparePublicEvidence(f.value, draft, f.value.sources[0].id, at, true)).toThrow();
});
it("respects 100 occupied source slots and does not mutate the 99-source boundary", () => {
  const f = supplementFixture();
  expect(() => preparePublicEvidence(f.value, draft, randomUUID(), at, true)).toThrow("100");
  f.value.sources.pop();
  expect(
    preparePublicEvidence(f.value, draft, randomUUID(), at, true).command.source.text,
  ).toContain(draft.quote);
  expect(f.value.sources).toHaveLength(99);
});
it("acknowledges only the exact stored candidate and never an older company view", () => {
  const f = fixture(),
    r = preparePublicEvidence(f.value, draft, randomUUID(), at, true);
  const stored = {
    ...f.value,
    revision: f.value.revision + 1,
    sources: [...f.value.sources, { ...r.command.source, updatedAt: "server-owned-time" }],
  };
  expect(publicEvidenceSaved(stored, r)?.id).toBe(f.value.id);
  for (const change of [
    { id: randomUUID() },
    { revision: f.value.revision },
    { sources: f.value.sources },
  ])
    expect(publicEvidenceSaved({ ...stored, ...change }, r)).toBeNull();
  for (const change of [
    { text: "wrong" },
    { name: "wrong" },
    { kind: "other" },
    { id: randomUUID() },
  ])
    expect(
      publicEvidenceSaved(
        { ...stored, sources: [...f.value.sources, { ...r.command.source, ...change }] },
        r,
      ),
    ).toBeNull();
  expect(
    publicEvidenceSaved(stored, r, { id: f.value.id, revision: stored.revision + 1 }),
  ).toBeNull();
  expect(publicEvidenceSaved(stored, r, { id: randomUUID(), revision: 0 })).toBeNull();
});
it("existing SQLite writer preserves original material/plans and uses original CAS for acknowledgement loss", () => {
  const dir = mkdtempSync(join(tmpdir(), "venturepass-public-evidence-test-")),
    store = new StudioStore(dir);
  try {
    const f = fixture(),
      created = store.create(f.value.profile);
    f.value.id = created.id;
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE studio_cases SET revision = ?, body = ? WHERE id = ?").run(
      f.value.revision,
      JSON.stringify(f.value),
      f.value.id,
    );
    const before = store.get(f.value.id),
      r = preparePublicEvidence(before, draft, randomUUID(), at, true);
    const result = store.mutate(before.id, r.command, () => []);
    expect(result.plans).toEqual(before.plans.map((p) => ({ ...p, confirmedAt: null })));
    expect(result.sources.slice(0, 2)).toEqual(before.sources);
    expect(() => store.mutate(before.id, r.command, () => [])).toThrow();
    const read = store.get(before.id);
    expect(read.sources).toHaveLength(3);
    expect(publicEvidenceSaved(read, r)).not.toBeNull();
    const source = read.sources.at(-1)!;
    const preview = preparePlanSupplement(read, {
      ...f.input,
      revision: read.revision,
      sourceSelections: [
        { sourceId: source.id, sourceUpdatedAt: source.updatedAt, textSha256: sha(source.text) },
      ],
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).toContain("https://example.invalid/report");
    expect(serialized).toContain("2026-10-05");
    expect(serialized).not.toContain("EXCLUDED_TEXT_1");
    const input = JSON.parse(preview.payload);
    expect(input.sources).toHaveLength(1);
    expect(input.sources[0].text).toBe(source.text);
    expect(preview.payload).not.toContain("PRIVATE_PROFILE");
    expect(preview.payload).not.toContain("PRIVATE_SUMMARY");
    expect(store.get(before.id)).toEqual(read);
  } finally {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(dir));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});
it("public form renders empty dates and explicit unchecked storage consent without IO", () => {
  const f = fixture(),
    spy = vi.fn(() => {
      throw Error("Unexpected IO");
    });
  const html = renderToStaticMarkup(
    createElement(PublicEvidencePanel, {
      company: f.value,
      blocked: false,
      onCompany: spy,
      onBusyChange: spy,
      onDirtyChange: spy,
      onUnsettledChange: spy,
      onClose: spy,
      onSupplement: spy,
    }),
  );
  expect(html).toContain("원문을 읽은 날짜");
  expect(html).toContain("원문 주소는 자동 조회하지 않습니다");
  expect(html).not.toContain('checked=""');
  expect(spy).not.toHaveBeenCalled();
});
it("supplement preselection uses only available exact source without auto consent", () => {
  const f = fixture(),
    spy = vi.fn();
  const render = (sourceId: string) =>
    renderToStaticMarkup(
      createElement(PlanSupplementPanel, {
        company: f.value,
        onCompany: spy,
        onBusyChange: spy,
        onUnsettledChange: spy,
        onClose: spy,
        initialSelection: { sourceId, sectionKey: "market" },
      }),
    );
  expect(render(f.value.sources[0].id).match(/checked=""/g)).toHaveLength(1);
  expect(render(randomUUID())).not.toContain('checked=""');
  f.value.sources[0].extraction = "pending";
  f.value.sources[0].text = "";
  expect(render(f.value.sources[0].id)).not.toContain('checked=""');
  expect(spy).not.toHaveBeenCalled();
});
