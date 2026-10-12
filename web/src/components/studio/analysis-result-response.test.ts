import { describe, expect, it } from "vitest";
import { analysisResultResponse } from "./analysis-result-response";
import {
  analysisResultReceiptFixture,
  analysisResultReceiptResult,
} from "../../../scripts/fixtures/analysis-result-receipt";
import type { StudioCase } from "@/lib/studio-schema";
describe("analysisResultResponse", () => {
  it.each(["ai", "assisted"] as const)(
    "accepts %s result and clears only manuscript confirmation without mutating inputs",
    (mode) => {
      const { company } = analysisResultReceiptFixture(),
        next = analysisResultReceiptResult(company, mode),
        copy = structuredClone({ company, next });
      expect(analysisResultResponse(next, company, mode)).toEqual(next);
      expect({ company, next }).toEqual(copy);
    },
  );
  it("accepts a first analysis without selection or manuscripts", () => {
    const { company } = analysisResultReceiptFixture();
    company.analysis = null;
    company.selectedCandidateId = null;
    company.plans = [];
    company.candidateSelections = [];
    const next = analysisResultReceiptResult(company);
    expect(analysisResultResponse(next, company, "assisted")).toEqual(next);
  });
  it("preserves an explicitly empty candidate result without inventing selection", () => {
    const { company } = analysisResultReceiptFixture(),
      next = analysisResultReceiptResult(company);
    next.analysis!.candidates = [];
    expect(analysisResultResponse(next, company, "assisted").selectedCandidateId).toBeNull();
  });
  const invalid: [string, (n: StudioCase, b: StudioCase) => void][] = [
    [
      "missing",
      (n) => {
        n.analysis = null;
      },
    ],
    [
      "old analysis",
      (n, b) => {
        n.analysis = structuredClone(b.analysis);
      },
    ],
    [
      "mode",
      (n) => {
        n.analysis!.mode = "ai";
      },
    ],
    [
      "source revision",
      (n) => {
        n.analysis!.sourceRevision--;
      },
    ],
    [
      "date",
      (n) => {
        n.analysis!.generatedAt = "invalid";
      },
    ],
    [
      "selection retained",
      (n, b) => {
        n.selectedCandidateId = b.selectedCandidateId;
      },
    ],
    [
      "new selection",
      (n) => {
        n.selectedCandidateId = "synthetic-second";
      },
    ],
    [
      "selection history",
      (n) => {
        n.candidateSelections = [];
      },
    ],
    [
      "candidate duplicate",
      (n) => {
        n.analysis!.candidates[1].id = n.analysis!.candidates[0].id;
      },
    ],
    [
      "empty candidate id",
      (n) => {
        n.analysis!.candidates[0].id = " ";
      },
    ],
    [
      "profile",
      (n) => {
        n.profile.companyName += "changed";
      },
    ],
    [
      "source text",
      (n) => {
        n.sources[0].text = n.sources[0].text.trim();
      },
    ],
    [
      "source order",
      (n) => {
        n.sources.reverse();
      },
    ],
    [
      "source count",
      (n) => {
        n.sources.pop();
      },
    ],
    [
      "stage",
      (n) => {
        n.stage = "preparing";
      },
    ],
    [
      "old confirmation",
      (n, b) => {
        n.plans[0].confirmedAt = b.plans[0].confirmedAt;
      },
    ],
    [
      "plan body",
      (n) => {
        n.plans[1].content.sections[1].content += "changed";
      },
    ],
    [
      "plan review",
      (n) => {
        n.plans[1].review.push({
          id: "changed",
          severity: "warning",
          category: "quality",
          message: "changed",
          action: "",
          sourceIds: [],
          sectionKey: null,
        });
      },
    ],
    [
      "plan order",
      (n) => {
        n.plans.reverse();
      },
    ],
    [
      "plan missing",
      (n) => {
        n.plans.pop();
      },
    ],
    [
      "plan extra",
      (n) => {
        n.plans.push(structuredClone(n.plans[0]));
      },
    ],
    [
      "plan id duplicate",
      (n) => {
        n.plans[1].id = n.plans[0].id;
      },
    ],
    [
      "plan version duplicate",
      (n) => {
        n.plans[1].version = n.plans[0].version;
      },
    ],
    [
      "base duplicate",
      (_, b) => {
        b.plans[1].id = b.plans[0].id;
      },
    ],
    [
      "other company",
      (n) => {
        n.id = "00000000-0000-4000-8000-000000000001";
      },
    ],
    [
      "same revision",
      (n, b) => {
        n.revision = b.revision;
      },
    ],
    [
      "older revision",
      (n, b) => {
        n.revision = b.revision - 1;
      },
    ],
    [
      "unsafe revision",
      (n) => {
        n.revision = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "negative base",
      (_, b) => {
        b.revision = -1;
      },
    ],
  ];
  it.each(invalid)("rejects %s", (_, change) => {
    const { company } = analysisResultReceiptFixture(),
      next = analysisResultReceiptResult(company);
    change(next, company);
    expect(() => analysisResultResponse(next, company, "assisted")).toThrow("아이템 분석 결과");
  });
  it.each([null, {}, "ok", { analysis: [] }])("rejects malformed %j", (value) => {
    expect(() =>
      analysisResultResponse(value, analysisResultReceiptFixture().company, "assisted"),
    ).toThrow();
  });
});
