import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, sourceSchema } from "./studio-schema";
import { deriveGuidedFlow } from "./studio-guided-flow";
import { guidedPreparationApproval } from "./studio-guided-preparation-state";
import { aiInput } from "./studio-engine-request-preparation";
import { assertIntakeCapacity } from "./studio-source-intake";
import { MAX_COMPANY_SOURCES, occupiedSourceSlots } from "./studio-source-limits";

function company(count: number) {
  const now = "2026-10-03T00:00:00.000Z";
  return {
    id: randomUUID(),
    profile: {
      ...emptyProfile(),
      companyName: "합성 자료 한도 시험",
      technologySummary: "산업용 센서를 개발 중이며 매출과 인증은 확인되지 않았습니다.",
    },
    sources: Array.from({ length: count }, (_, index) =>
      sourceSchema.parse({
        id: randomUUID(),
        name: `합성 자료 ${index + 1}`,
        kind: "technology",
        text: `자료 ${index + 1}: 내부 개발 기록. 실제 매출 실적은 확인 필요.`,
        originalName: null,
        mimeType: null,
        extraction: "manual",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      }),
    ),
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}
describe("optional company materials: zero through one hundred", () => {
  it("no attachment is required to prepare from a company description", () => {
    const value = caseSchema.parse(company(0));
    expect(deriveGuidedFlow(value).step).toBe("plan");
    expect(guidedPreparationApproval(value, "synthetic-model").sourceIds).toEqual([]);
    const input = JSON.parse(aiInput(value));
    expect(input.sources).toEqual([]);
    expect(input.profile.technologySummary).toBe(value.profile.technologySummary);
  });
  it.each([1, 40, 41, 99, 100])(
    "preserves all %i documents in storage schema, approval and input",
    (count) => {
      const value = caseSchema.parse(company(count));
      expect(() => assertIntakeCapacity(value)).not.toThrow();
      const approval = guidedPreparationApproval(value, "synthetic-model");
      expect(approval.sourceIds).toEqual(value.sources.map((source) => source.id));
      expect(approval.sourceNames).toEqual(value.sources.map((source) => source.name));
      expect(
        JSON.parse(aiInput(value)).sources.map((source: { sourceId: string }) => source.sourceId),
      ).toEqual(approval.sourceIds);
    },
  );
  it("rejects the 101st document at both schema and capacity boundaries", () => {
    expect(MAX_COMPANY_SOURCES).toBe(100);
    const value = caseSchema.parse(company(100));
    value.sources.push(sourceSchema.parse({ ...value.sources[0], id: randomUUID() }));
    expect(caseSchema.safeParse(value).success).toBe(false);
    expect(() => assertIntakeCapacity(value)).toThrow(
      expect.objectContaining({ code: "SOURCE_LIMIT" }),
    );
    expect(() => guidedPreparationApproval(value, "synthetic-model")).toThrow();
  });
  it("still rejects oversized AI input without silently dropping documents", () => {
    const value = caseSchema.parse(company(100));
    for (const source of value.sources) source.text = "합".repeat(2500);
    expect(() => aiInput(value)).toThrow(expect.objectContaining({ code: "AI_INPUT_TOO_LARGE" }));
    expect(value.sources).toHaveLength(100);
    expect(value.sources.at(-1)?.text).toHaveLength(2500);
  });
});

describe("shared saved and reserved material count", () => {
  it("counts a saved intake source once and releases only unsaved cancelled slots", () => {
    const value = {
      sources: [{ id: "saved" }, { id: "retained" }],
      sourceIntakes: [
        { sourceId: "saved", phase: "awaiting_review" },
        { sourceId: "waiting", phase: "awaiting_original" },
        { sourceId: "cancelled", phase: "cancelled" },
        { sourceId: "retained", phase: "cancelled" },
      ],
    };
    const before = structuredClone(value);
    expect(occupiedSourceSlots(value)).toBe(3);
    expect(value).toEqual(before);
  });
  it("preserves old approvals and rejects a new batch that exceeds reserved capacity", () => {
    const value = caseSchema.parse(company(99));
    const oldApproval = guidedPreparationApproval(value, "synthetic-model");
    const waiting = {
      sourceId: randomUUID(),
      phase: "awaiting_original",
    };
    expect(occupiedSourceSlots({ ...value, sourceIntakes: [waiting] })).toBe(100);
    expect(
      occupiedSourceSlots({
        ...value,
        sourceIntakes: [
          waiting,
          {
            sourceId: randomUUID(),
            phase: "awaiting_original",
          },
        ],
      }),
    ).toBe(101);
    expect(guidedPreparationApproval(value, "synthetic-model")).toEqual(oldApproval);
  });
});
