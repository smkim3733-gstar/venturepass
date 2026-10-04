import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { caseSchema, emptyProfile, sourceSchema } from "@/lib/studio-schema";
import {
  guidedPreparationApproval,
  guidedSelectedPreparationApproval,
} from "@/lib/studio-guided-preparation-state";
import { deriveGuidedFlow } from "@/lib/studio-guided-flow";
import {
  initialEvidenceSelection,
  selectedEvidenceInput,
  selectedEvidenceSnapshot,
  loadCurrentPreparation,
} from "./guided-evidence-selection-state";
import { GuidedMaterialReadiness } from "./guided-material-readiness";

const now = "2026-10-04T14:00:00.000Z";
function company() {
  const source = (name: string, text: string, extraction: "manual" | "pending" = "manual") =>
    sourceSchema.parse({
      id: randomUUID(),
      name,
      text,
      kind: "technology",
      extraction,
      originalName: null,
      mimeType: null,
      warnings: [],
      createdAt: now,
      updatedAt: now,
    });
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 선택 화면", technologySummary: "합성 설명" },
    sources: [
      source("선택.pdf", "선택 본문"),
      source("제외.docx", "제외 본문"),
      source("대기.pdf", "", "pending"),
    ],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 4,
    createdAt: now,
    updatedAt: now,
  });
}
function preview(c = company(), ids = [c.sources[0].id]) {
  const input = selectedEvidenceInput(c, ids);
  if (!input) throw Error("invalid fixture selection");
  return {
    company: c,
    approval: guidedSelectedPreparationApproval(c, "synthetic-model", ids),
    active: false,
    aiConfigured: true,
    ...input,
    transmissionAllowed: false,
  };
}
function withRun(selected = true) {
  const c = company(),
    approval = selected
      ? guidedSelectedPreparationApproval(c, "synthetic-model", [c.sources[0].id])
      : guidedPreparationApproval(c, "synthetic-model");
  c.guidedPreparationRuns = [
    {
      id: randomUUID(),
      mode: "ai",
      approval,
      approvedAt: now,
      status: "awaiting_materials",
      phase: "analysis",
      analysisDigest: null,
      candidateId: null,
      candidateDigest: null,
      planId: null,
      code: null,
      requests: [{ clientRequestId: randomUUID(), digest: "a".repeat(64) }],
      createdAt: now,
      updatedAt: now,
    },
  ];
  return c;
}
describe("선택 미리보기의 화면 신원과 현재 실행 범위", () => {
  it("새 화면은 사용 가능 자료만 제안하고 기존 선택 실행에는 새 자료를 자동 추가하지 않는다", () => {
    const c = company();
    expect(initialEvidenceSelection(c)).toEqual(c.sources.slice(0, 2).map((s) => s.id));
    const run = withRun();
    expect(initialEvidenceSelection(run)).toEqual([run.sources[0].id]);
    const legacy = withRun(false);
    expect(initialEvidenceSelection(legacy)).toEqual(legacy.sources.slice(0, 2).map((s) => s.id));
  });
  it("0개 선택·원문 전체·정확한 첫 분석 용량을 계산하며 원본이나 판독 대기는 제외한다", () => {
    const c = company();
    const before = JSON.stringify(c);
    expect(selectedEvidenceInput(c, [])?.sourceIds).toEqual([]);
    expect(selectedEvidenceInput(c, [c.sources[2].id])).toBeNull();
    expect(selectedEvidenceInput(c, [c.sources[0].id, c.sources[0].id])).toBeNull();
    expect(selectedEvidenceInput(c, [randomUUID()])).toBeNull();
    const one = selectedEvidenceInput(c, [c.sources[0].id])!;
    expect(one.inputCharacters).toBeLessThan(
      selectedEvidenceInput(
        c,
        c.sources.slice(0, 2).map((s) => s.id),
      )!.inputCharacters,
    );
    expect(JSON.stringify(c)).toBe(before);
  });
  it("100개 장문은 전체 초과/일부 선택 적합을 구분하고 자르거나 자동 선택하지 않는다", () => {
    const c = company(),
      template = c.sources[0];
    c.sources = Array.from({ length: 100 }, (_, i) => ({
      ...template,
      id: randomUUID(),
      name: `합성${i}.pdf`,
      text: '"'.repeat(1250),
    }));
    expect(
      selectedEvidenceInput(
        c,
        c.sources.map((s) => s.id),
      )?.overInputLimit,
    ).toBe(true);
    expect(selectedEvidenceInput(c, [c.sources[99].id])?.overInputLimit).toBe(false);
    expect(c.sources.every((s) => s.text.length === 1250)).toBe(true);
  });
  it("정확한 부분집합 응답만 승인에 쓰고 반환 객체는 분리한다", () => {
    const c = company(),
      ids = [c.sources[1].id, c.sources[0].id],
      raw = preview(c, ids);
    const result = selectedEvidenceSnapshot(raw, c, ids)!;
    expect(result.approval.sourceIds).toEqual(c.sources.slice(0, 2).map((s) => s.id));
    result.company.sources[0].text = "changed";
    result.approval.sourceIds.reverse();
    expect(c.sources[0].text).toBe("선택 본문");
    expect(raw.approval.sourceIds).toEqual(c.sources.slice(0, 2).map((s) => s.id));
  });
  it.each(["scope", "ids", "names", "count", "limit", "over", "authority", "revision", "company"])(
    "%s가 바뀐 미리보기는 거절한다",
    (key) => {
      const c = company(),
        ids = [c.sources[0].id],
        raw = structuredClone(preview(c, ids));
      if (key === "scope") delete raw.approval.sourceScope;
      if (key === "ids") raw.approval.sourceIds = [c.sources[1].id];
      if (key === "names") raw.approval.sourceNames = ["다른 이름"];
      if (key === "count") raw.inputCharacters++;
      if (key === "limit") raw.inputCharacterLimit++;
      if (key === "over") raw.overInputLimit = !raw.overInputLimit;
      if (key === "authority") raw.transmissionAllowed = true;
      if (key === "revision") {
        raw.company.revision++;
        raw.approval.revision++;
      }
      if (key === "company") {
        raw.company.id = randomUUID();
        raw.approval.caseId = raw.company.id;
      }
      expect(selectedEvidenceSnapshot(raw, c, ids)).toBeNull();
    },
  );
  it("현재 선택 run은 같은 고정 ID로 읽기 preview만 하며 전체 GET을 유효성 증거로 쓰지 않는다", async () => {
    const c = withRun(),
      get = {
        company: c,
        approval: guidedPreparationApproval(c, "synthetic-model"),
        active: false,
        aiConfigured: false,
      };
    const read = vi.fn().mockResolvedValueOnce(get).mockResolvedValueOnce(preview(c));
    const result = await loadCurrentPreparation(c, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.parse(read.mock.calls[1][1].body)).toEqual({
      revision: c.revision,
      sourceIds: [c.sources[0].id],
    });
    expect(read.mock.calls[1][0]).toMatch(/\/preview$/);
    expect(
      deriveGuidedFlow(c, { guidedApproval: result.currentApproval ?? undefined }).guidedInputState,
    ).toBe("current");
    expect(deriveGuidedFlow(c, { guidedApproval: get.approval }).guidedInputState).toBe(
      "unverified",
    );
  });
  it("선택 범위 조회 실패/거짓 응답은 미확인으로 남기며 실행 요청이나 전체 범위 fallback을 만들지 않는다", async () => {
    const c = withRun(),
      get = {
        company: c,
        approval: guidedPreparationApproval(c, "synthetic-model"),
        active: false,
        aiConfigured: true,
      };
    for (const fail of [true, false]) {
      const read = vi.fn().mockResolvedValueOnce(get);
      if (fail) read.mockRejectedValueOnce(Error("offline"));
      else read.mockResolvedValueOnce({ ...preview(c), transmissionAllowed: true });
      const result = await loadCurrentPreparation(c, read);
      expect(result.currentApproval).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
      expect(deriveGuidedFlow(c).guidedInputState).toBe("unverified");
    }
  });
  it("기존 전체 승인 run은 GET만으로 이전 방식의 상태를 확인한다", async () => {
    const c = withRun(false),
      raw = {
        company: c,
        approval: guidedPreparationApproval(c, "synthetic-model"),
        active: false,
        aiConfigured: true,
      };
    const read = vi.fn().mockResolvedValue(raw),
      result = await loadCurrentPreparation(c, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.currentApproval).toEqual(raw.approval);
    expect(deriveGuidedFlow(c, { guidedApproval: result.currentApproval! }).guidedInputState).toBe(
      "current",
    );
  });
  it("선택 자료가 제거되거나 제외 자료가 수정돼도 과거 원고를 현재 검증으로 표시하지 않는다", () => {
    const c = withRun();
    c.sources = c.sources.filter((s) => s.id !== c.guidedPreparationRuns![0].approval.sourceIds[0]);
    expect(deriveGuidedFlow(c).guidedInputState).toBe("changed");
    const changed = withRun();
    changed.sources[1].updatedAt = "2026-10-04T14:01:00.000Z";
    expect(deriveGuidedFlow(changed).guidedInputState).toBe("changed");
  });
  it("자료 현황은 전체 기준 용량과 실제 선택 동선을 구분한다", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedMaterialReadiness, {
        company: company(),
        locked: false,
        onReviewSources: () => {},
        onSelectSources: () => {},
      }),
    );
    expect(html).toContain("AI에 사용할 자료 선택");
    expect(html).toContain("전체 자료 기준");
    expect(html).toContain("판독 대기");
  });
});
