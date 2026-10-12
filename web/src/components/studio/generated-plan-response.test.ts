import { describe, expect, it } from "vitest";
import { generatedPlanResponse } from "./generated-plan-response";
import {
  generatedPlanReceiptFixture,
  generatedPlanReceiptResult,
} from "../../../scripts/fixtures/generated-plan-receipt";
import type { StudioCase } from "@/lib/studio-schema";

describe("generatedPlanResponse", () => {
  it.each(["ai", "assisted"] as const)(
    "accepts exactly one %s unreviewed version without mutating inputs",
    (mode) => {
      const { company } = generatedPlanReceiptFixture(),
        next = generatedPlanReceiptResult(company, mode);
      const snapshot = structuredClone({ company, next });
      expect(generatedPlanResponse(next, company, mode)).toEqual(next);
      expect({ company, next }).toEqual(snapshot);
    },
  );
  it("accepts the first version with current selection", () => {
    const { company } = generatedPlanReceiptFixture();
    company.plans = [];
    const next = generatedPlanReceiptResult(company);
    expect(generatedPlanResponse(next, company, "assisted").plans[0].version).toBe(1);
  });
  const invalid: [string, (next: StudioCase, base: StudioCase) => void][] = [
    [
      "missing",
      (n) => {
        n.plans.pop();
      },
    ],
    [
      "extra",
      (n) => {
        n.plans.push(structuredClone(n.plans.at(-1)!));
      },
    ],
    [
      "old body",
      (n) => {
        n.plans[0].content.sections[0].content += "changed";
      },
    ],
    [
      "old confirmation",
      (n) => {
        n.plans[0].confirmedAt = n.updatedAt;
      },
    ],
    [
      "old order",
      (n) => {
        [n.plans[0], n.plans[1]] = [n.plans[1], n.plans[0]];
      },
    ],
    [
      "new position",
      (n) => {
        n.plans.unshift(n.plans.pop()!);
      },
    ],
    [
      "new version",
      (n) => {
        n.plans.at(-1)!.version++;
      },
    ],
    [
      "reused ID",
      (n) => {
        n.plans.at(-1)!.id = n.plans[0].id;
      },
    ],
    [
      "duplicate old ID",
      (_, b) => {
        b.plans[1].id = b.plans[0].id;
      },
    ],
    [
      "duplicate old version",
      (_, b) => {
        b.plans[1].version = b.plans[0].version;
      },
    ],
    [
      "unsafe version",
      (n) => {
        n.plans.at(-1)!.version = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "mode",
      (n) => {
        n.plans.at(-1)!.mode = "ai";
      },
    ],
    [
      "manual",
      (n) => {
        n.plans.at(-1)!.mode = "manual";
      },
    ],
    [
      "candidate",
      (n) => {
        n.plans.at(-1)!.candidateId = "other";
      },
    ],
    [
      "source revision",
      (n) => {
        n.plans.at(-1)!.sourceRevision--;
      },
    ],
    [
      "confirmed",
      (n) => {
        n.plans.at(-1)!.confirmedAt = n.updatedAt;
      },
    ],
    [
      "invalid time",
      (n) => {
        n.plans.at(-1)!.generatedAt = "invalid";
      },
    ],
    [
      "profile",
      (n) => {
        n.profile.companyName += "changed";
      },
    ],
    [
      "analysis",
      (n) => {
        n.analysis!.summary += "changed";
      },
    ],
    [
      "selection",
      (n) => {
        n.selectedCandidateId = null;
      },
    ],
    [
      "selection history",
      (n) => {
        n.candidateSelections = [];
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
      "old revision",
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
    [
      "no original candidate",
      (_, b) => {
        b.selectedCandidateId = null;
      },
    ],
    [
      "ambiguous candidate",
      (_, b) => {
        b.analysis!.candidates.push(structuredClone(b.analysis!.candidates[0]));
      },
    ],
  ];
  it.each(invalid)("rejects %s", (_, change) => {
    const { company } = generatedPlanReceiptFixture(),
      next = generatedPlanReceiptResult(company);
    change(next, company);
    expect(() => generatedPlanResponse(next, company, "assisted")).toThrow("새 원고");
  });
  it.each([null, {}, { plans: [] }, "ok"])("rejects malformed %j", (value) => {
    expect(() =>
      generatedPlanResponse(value, generatedPlanReceiptFixture().company, "assisted"),
    ).toThrow();
  });
});
