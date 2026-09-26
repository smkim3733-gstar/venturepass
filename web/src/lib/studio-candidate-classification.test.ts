import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StudioStore } from "./studio-storage";
import { candidateSchema, emptyProfile } from "./studio-schema";
import { candidateSelectionSnapshotSchema } from "./studio-candidate-selection-types";
import { currentVerifiedCandidateSelection } from "./studio-candidate-selection";
import { preparationDigest } from "./studio-preparation-state";
import {
  candidateClassifications,
  candidateClassificationLabels,
  getCandidateClassification,
} from "./studio-candidate-classification";
import { CandidateClassificationNotice } from "@/components/studio/candidate-classification";
vi.mock("server-only", () => ({}));

const candidate = {
  id: "legacy",
  title: "합성 후보",
  problem: "문제",
  solution: "해결",
  targetCustomer: "고객",
  differentiation: "미확인",
  stage: "개발 중",
  businessModel: "미확인",
  recommendation: "검토 필요",
  evidence: [],
  gaps: [],
};
describe("candidate classification compatibility", () => {
  it("does not insert a default key into legacy candidates or historical snapshots", () => {
    const bytes = JSON.stringify(candidate);
    const parsed = candidateSchema.parse(candidate);
    const snapshot = candidateSelectionSnapshotSchema.parse(candidate);
    expect(getCandidateClassification(parsed)).toBe("unknown");
    expect(JSON.stringify(parsed)).toBe(bytes);
    expect(JSON.stringify(snapshot)).toBe(bytes);
    expect(parsed).not.toHaveProperty("classification");
    expect(preparationDigest(parsed)).toBe(preparationDigest(candidate));
  });
  it.each(candidateClassifications)(
    "stores and displays %s as a recommendation, never confirmation",
    (classification) => {
      const parsed = candidateSchema.parse({ ...candidate, classification });
      expect(candidateSelectionSnapshotSchema.parse(parsed).classification).toBe(classification);
      const html = renderToStaticMarkup(
        createElement(CandidateClassificationNotice, { candidate: parsed }),
      );
      expect(html).toContain(candidateClassificationLabels[classification]);
      expect(html).toContain("추천 분류이며 사실·기관 적합성·사용자 검토 완료를 뜻하지 않습니다.");
    },
  );
  it("displays unknown for historical records without modifying them", () => {
    expect(
      renderToStaticMarkup(createElement(CandidateClassificationNotice, { candidate: {} })),
    ).toContain("후보 구분 미확인");
    expect(candidate).not.toHaveProperty("classification");
  });
  it.each(["verified", null, 1, "<script>test</script>"])(
    "rejects an unsupported classification %s",
    (classification) => {
      expect(candidateSchema.safeParse({ ...candidate, classification }).success).toBe(false);
    },
  );
  it("preserves legacy database bytes, exact choice and preparation binding until content changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "venture-classification-"));
    const store = new StudioStore(directory);
    try {
      let company = store.create({ ...emptyProfile(), companyName: "합성 호환 회사" });
      company = store.saveAnalysis(
        company.id,
        company.revision,
        { summary: "기존 분석", facts: [], candidates: [candidate], questions: [], warnings: [] },
        "assisted",
      );
      company = store.mutate(
        company.id,
        {
          action: "select-candidate",
          revision: company.revision,
          clientRequestId: randomUUID(),
          candidateId: candidate.id,
          analysisGeneratedAt: company.analysis!.generatedAt,
          analysisSourceRevision: company.analysis!.sourceRevision,
          expectedSelectedCandidateId: null,
          reason: "이전 버전에서 명시 선택",
        },
        () => [],
      );
      company = store.beginPreparation(company.id, {
        action: "start",
        revision: company.revision,
        clientRequestId: randomUUID(),
      });
      const db = new DatabaseSync(join(directory, "studio.sqlite"));
      try {
        const body = db.prepare("SELECT body FROM studio_cases WHERE id=?").get(company.id)!.body;
        const selected = structuredClone(company.candidateSelections[0]);
        const fetched = store.get(company.id);
        expect(fetched.analysis!.candidates[0]).not.toHaveProperty("classification");
        expect(fetched.candidateSelections[0].candidate).not.toHaveProperty("classification");
        expect(currentVerifiedCandidateSelection(fetched)).toEqual(selected);
        expect(fetched.preparationRuns[0].stale).toBe(false);
        expect(db.prepare("SELECT body FROM studio_cases WHERE id=?").get(company.id)!.body).toBe(
          body,
        );
        fetched.analysis!.candidates[0].classification = "future-proposal";
        db.prepare("UPDATE studio_cases SET body=? WHERE id=?").run(
          JSON.stringify(fetched),
          fetched.id,
        );
        const changed = store.get(fetched.id);
        expect(currentVerifiedCandidateSelection(changed)).toBeNull();
        expect(changed.preparationRuns[0].stale).toBe(true);
        expect(changed.candidateSelections[0]).toEqual(selected);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      const inside = relative(resolve(tmpdir()), resolve(directory));
      if (!inside.startsWith("..") && !inside.includes(":"))
        rmSync(directory, { recursive: true, force: true });
    }
  });
});
