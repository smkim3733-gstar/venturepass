import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { publicEvidenceExportFixture } from "@/lib/studio-public-evidence-export-test-helpers";
import { publicEvidenceText } from "@/lib/studio-public-evidence";
import {
  publicEvidenceExportEntries,
  PUBLIC_EVIDENCE_EXPORT_NOTICE,
} from "@/lib/studio-public-evidence-export";
import { PublicEvidenceReferences } from "./public-evidence-references";
import { GuidedPlanEvidence } from "./guided-plan-evidence";
import { PackagePanel } from "./package-panel";
import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
const fetchGuard = vi.fn(() => {
  throw Error("read-only UI must not fetch");
});
beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function render(company: StudioCase, plan: BusinessPlan) {
  return renderToStaticMarkup(createElement(PublicEvidenceReferences, { company, plan }));
}
function escaped(s: string) {
  return renderToStaticMarkup(createElement("span", null, s)).slice(6, -7);
}
it("shows every export-projection line for the saved plan, closed by default, without actions or writes", () => {
  const { record, plan } = publicEvidenceExportFixture();
  const before = JSON.stringify(record);
  const html = render(record, plan);
  expect(html).toContain(escaped(PUBLIC_EVIDENCE_EXPORT_NOTICE));
  for (const e of publicEvidenceExportEntries(record, plan)) {
    expect(html).toContain(escaped(e.title));
    for (const line of e.lines) expect(html).toContain(escaped(line));
  }
  expect(html).toContain("저장한 원고 v1의 인용");
  expect(html).toContain("아직 저장하지 않은 편집 내용은 포함하지 않습니다");
  expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  expect(html).not.toMatch(/<(?:button|input|a|iframe|img)\b/);
  expect(JSON.stringify(record)).toBe(before);
});
it("rejects a supplied draft, missing plan, duplicate plan or a different company's plan", () => {
  const { record, plan } = publicEvidenceExportFixture();
  const supplied = structuredClone(plan);
  supplied.content.summary = "unsaved";
  expect(render(record, supplied)).toBe("");
  expect(render({ ...record, plans: [] }, plan)).toBe("");
  expect(render({ ...record, plans: [plan, structuredClone(plan)] }, plan)).toBe("");
  expect(render(publicEvidenceExportFixture().record, plan)).toBe("");
  expect(render(record, structuredClone(plan))).not.toBe("");
});
it("keeps an older selected plan and the current manual dates distinct from a new plan", () => {
  const { record, plan, draft } = publicEvidenceExportFixture();
  const next = structuredClone(plan);
  next.id = randomUUID();
  next.version = 2;
  next.content.sections[0].evidence[0].quote = "현재 발췌에 없는 새 인용";
  record.plans.push(next);
  expect(render(record, plan)).toContain("저장한 원고 v1");
  expect(render(record, plan)).toContain("같은 문구 있음");
  const html = render(record, next);
  expect(html).toContain("저장한 원고 v2");
  expect(html).toContain("같은 문구를 찾지 못함");
  expect(html).toContain(draft.readOn);
  expect(html).toContain("원고 작성 당시의 출처 이력이나");
});
it("renders long metadata and hostile markup as complete inert text", () => {
  const { record, plan, source, draft } = publicEvidenceExportFixture();
  draft.url = "https://example.invalid/" + "a".repeat(1900);
  draft.relevance =
    '<img src="https://example.invalid/track" onerror="alert(1)">\n<script>alert(1)</script>';
  draft.conflicts = "긴 메모 ".repeat(450);
  source.text = publicEvidenceText(draft);
  const html = render(record, plan);
  expect(html).toContain(escaped(draft.url));
  expect(html).toContain(escaped(draft.relevance));
  expect(html).toContain(escaped(draft.conflicts));
  expect(html).not.toMatch(/<(?:img|script|a)\b/);
  expect(html).toContain("[overflow-wrap:anywhere]");
});
it("keeps pending and malformed sources unresolved and removes old metadata on a new source snapshot", () => {
  const { record, plan, source, draft } = publicEvidenceExportFixture();
  source.extraction = "pending";
  source.text = "";
  let html = render(record, plan);
  expect(html).toContain("형식 확인 필요");
  expect(html).not.toContain(draft.url);
  expect(html).not.toContain("같은 문구 있음");
  source.extraction = "manual";
  source.text = publicEvidenceText(draft).replace("[원문 발췌 끝]", "edited");
  html = render(record, plan);
  expect(html).toContain("형식·경계를 확인하지 못했습니다");
  expect(html).not.toContain(draft.url);
  record.sources = [];
  expect(render(record, plan)).toBe("");
});
it("does not infer public provenance from an ordinary URL or an uncited candidate", () => {
  const { record, plan, source } = publicEvidenceExportFixture();
  plan.content.sections[0].evidence = [];
  expect(render(record, plan)).toBe("");
  plan.content.sections[0].evidence = [
    { sourceId: source.id, quote: "일반 회사 메모", locator: "" },
  ];
  source.name = "일반 자료";
  source.text = "일반 회사 메모 https://example.invalid/";
  expect(render(record, plan)).toBe("");
});
it("integrates the same source status inside existing guided evidence without changing the manuscript", () => {
  const { record, plan, draft } = publicEvidenceExportFixture();
  const before = JSON.stringify(record);
  const html = renderToStaticMarkup(createElement(GuidedPlanEvidence, { company: record, plan }));
  expect(html).toContain("기준·근거 보기");
  expect(html).toContain("공개 근거 출처 확인");
  expect(html).toContain(escaped(draft.url));
  expect(html).toContain("원고 작성 후 수정된 자료입니다");
  expect(JSON.stringify(record)).toBe(before);
});
it("the download panel shows its selected older saved plan even while unsaved changes block downloads", () => {
  const { record, plan } = publicEvidenceExportFixture();
  const next = structuredClone(plan);
  next.id = randomUUID();
  next.version = 2;
  record.plans.push(next);
  const onBusyChange = vi.fn();
  const html = renderToStaticMarkup(
    createElement(PackagePanel, { company: record, plan, dirty: true, onBusyChange }),
  );
  expect(html).toContain("현재 선택은 원고 v1");
  expect(html).toContain("공개 근거 출처 확인 · 원고 v1");
  expect(html).toContain("아직 저장하지 않은 편집 내용은 포함하지 않습니다");
  expect(html).not.toContain("공개 근거 출처 확인 · 원고 v2");
  expect(onBusyChange).not.toHaveBeenCalled();
});
