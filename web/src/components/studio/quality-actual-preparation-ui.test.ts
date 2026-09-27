import { webcrypto } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => ({
  default: class {
    constructor() {
      throw new Error("Provider forbidden");
    }
  },
}));
import {
  createCandidateRegistrySource,
  candidateRegistryVersionDigest,
} from "@/lib/studio-plan-quality-candidate-registry";
import {
  candidateRegistryNotice,
  type CandidateRegistrySnapshot,
} from "@/lib/studio-plan-quality-candidate-registry-types";
import { createQualityActualPreparation } from "@/lib/studio-plan-quality-actual-preparation";
import {
  qualityActualPreparationDigestInput,
  qualityActualRequestEvidenceDigestInput,
  type QualityActualPreparation,
} from "@/lib/studio-plan-quality-actual-types";
import { planQualityEvaluationDigest as digest } from "@/lib/studio-plan-quality-evaluation";
import { executionDigest } from "@/lib/studio-engine-request-preparation";
import {
  qualityActualArchive,
  qualityActualPreparation,
  qualityActualSelectionMatches,
} from "./quality-actual-preparation-ui";
import { QualityActualPreparationPanel } from "./quality-actual-preparation-panel";

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
const now = "2026-09-27T03:00:00.000Z",
  model = "synthetic-inspection-model";
const base: Omit<CandidateRegistrySnapshot, "versionDigest"> = {
  ...createCandidateRegistrySource(),
  kind: "validation-candidate-set" as const,
  version: 1,
  previousVersion: null,
  previousDigest: null,
  registeredAt: now,
  clientRequestId: "a75c8462-dc84-4d32-b743-da6581f2f4dd",
  notice: candidateRegistryNotice,
};
const registry: CandidateRegistrySnapshot = {
  ...base,
  versionDigest: candidateRegistryVersionDigest(base),
};
const candidateId = registry.entries[0].candidateId;
function fixture(selectedModel: string | null = model) {
  return createQualityActualPreparation({
    registry,
    candidateId,
    model: selectedModel,
    preparedAt: now,
    price: null,
    tokens: null,
    budget: null,
    environment: "production",
  });
}
function rehash(value: QualityActualPreparation) {
  const evidence = value.requestEvidence;
  if (evidence) {
    evidence.generation.requestDigest = executionDigest(evidence.generation.body);
    evidence.generation.inputChars = evidence.generation.body.input.reduce(
      (sum, item) => sum + item.content.length,
      0,
    );
    const { templateDigest: _ignored, ...template } = evidence.reviewTemplate;
    void _ignored;
    evidence.reviewTemplate.templateDigest = executionDigest(template);
    evidence.evidenceDigest = digest(qualityActualRequestEvidenceDigestInput(evidence));
  }
  value.preparationDigest = digest(qualityActualPreparationDigestInput(value));
  return value;
}
describe("actual preparation production view", () => {
  it("accepts exact source and both request phases without allowing any execution", async () => {
    const value = await qualityActualPreparation(fixture(), registry, candidateId, model);
    expect(value.requestEvidence?.reviewTemplate.complete).toBe(false);
    expect(value.costs).toBeNull();
    expect(value.executionAllowed).toBe(false);
    expect(value.approvalRecorded).toBe(false);
    expect(value.reservationRecorded).toBe(false);
  });
  it("allows missing model only as an incomplete inspection with no fabricated body", async () => {
    const value = await qualityActualPreparation(fixture(null), registry, candidateId, null);
    expect(value.requestEvidence).toBeNull();
    expect(value.blockers).toHaveLength(4);
  });
  it("downloads the exact current snapshot with original generation JSON and fixed timestamp", async () => {
    const snapshot = fixture();
    const archive = await qualityActualArchive(snapshot, registry, candidateId, model);
    expect(JSON.parse(archive.text)).toEqual(snapshot);
    expect(JSON.parse(archive.text).requestEvidence.generation.body.input[1].content).toBe(
      snapshot.requestEvidence!.generation.body.input[1].content,
    );
    expect(archive.filename).toContain(snapshot.preparationDigest.slice(0, 12));
    expect(JSON.parse(archive.text).preparedAt).toBe(now);
  });
  it.each([
    ["candidate", registry.entries[1].candidateId, model],
    ["model", candidateId, "changed-model"],
    ["missing model", candidateId, null],
  ])("rejects stale %s view and prevents its download", async (_name, id, selectedModel) => {
    expect(qualityActualSelectionMatches(fixture(), registry, id, selectedModel)).toBe(false);
    await expect(qualityActualArchive(fixture(), registry, id, selectedModel)).rejects.toThrow();
  });
  it("rejects old registry digest or unmounted registry", async () => {
    const changed = { ...registry, versionDigest: "a".repeat(64) };
    expect(qualityActualSelectionMatches(fixture(), null, candidateId, model)).toBe(false);
    await expect(
      qualityActualPreparation(fixture(), changed, candidateId, model),
    ).rejects.toThrow();
  });
  it.each([
    [
      "preparation context",
      (v: QualityActualPreparation) => {
        const body = v.requestEvidence!.generation.body;
        const input = JSON.parse(body.input[1].content);
        input.preparationContext = "다른 회사의 임의 준비 안내";
        body.input[1].content = JSON.stringify(input);
        v.requestEvidence!.reviewTemplate.fixedUserContext.preparationContext =
          input.preparationContext;
      },
    ],
    [
      "input fact",
      (v: QualityActualPreparation) => {
        const body = v.requestEvidence!.generation.body;
        const input = JSON.parse(body.input[1].content);
        input.profile.companyName = "invented company";
        body.input[1].content = JSON.stringify(input);
      },
    ],
    [
      "reviewer notes",
      (v: QualityActualPreparation) => {
        const body = v.requestEvidence!.generation.body;
        const input = JSON.parse(body.input[1].content);
        input.reviewerMetadata = { answer: "invented" };
        body.input[1].content = JSON.stringify(input);
      },
    ],
    [
      "review invented draft",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.reviewTemplate.fixedUserContext.draft = { answer: "invented" };
      },
    ],
    [
      "review different source",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.reviewTemplate.fixedUserContext.sources = [];
      },
    ],
    [
      "generation system",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.generation.body.input[0].content += " changed";
      },
    ],
    [
      "schema",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.generation.body.text.format.schema = { type: "string" };
      },
    ],
    [
      "review instruction",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.reviewTemplate.systemMessage.content += " changed";
      },
    ],
    [
      "body model",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.generation.body.model = "changed-model";
      },
    ],
    [
      "template model",
      (v: QualityActualPreparation) => {
        v.requestEvidence!.reviewTemplate.model = "changed-model";
      },
    ],
    [
      "scope",
      (v: QualityActualPreparation) => {
        v.scope.modelInputDigest = "a".repeat(64);
      },
    ],
  ] as const)("rejects recomputed envelope with altered %s", async (_name, mutate) => {
    const value = fixture();
    mutate(value);
    rehash(value);
    await expect(qualityActualPreparation(value, registry, candidateId, model)).rejects.toThrow();
  });
  it.each([
    [
      "price",
      (v: QualityActualPreparation) => {
        v.blockers = v.blockers.filter((item) => item.code !== "PRICE_NOT_CONFIGURED");
      },
    ],
    [
      "message",
      (v: QualityActualPreparation) => {
        v.blockers[0].message = "실행 가능합니다";
      },
    ],
    [
      "ready",
      (v: QualityActualPreparation) => {
        v.readiness = "calculation-ready";
      },
    ],
    [
      "test environment",
      (v: QualityActualPreparation) => {
        v.environment = "synthetic-test";
      },
    ],
    [
      "zero cost",
      (v: QualityActualPreparation) => {
        v.costs = {
          currency: "USD",
          unitScale: 6,
          generationUnits: "0",
          reviewUnits: "0",
          unsettledUnits: "0",
          totalUnits: "0",
          budgetUnits: "0",
          rounding: "ceil-each-rate-per-request",
          meaning: "unreserved-upper-bound-not-a-bill",
        };
      },
    ],
  ] as const)("does not reinterpret forged %s as production readiness", async (_name, mutate) => {
    const value = fixture();
    mutate(value);
    rehash(value);
    await expect(qualityActualPreparation(value, registry, candidateId, model)).rejects.toThrow();
  });
  it("rejects a changed digest and complete review flag", async () => {
    const value = fixture();
    value.preparationDigest = "a".repeat(64);
    await expect(qualityActualPreparation(value, registry, candidateId, model)).rejects.toThrow();
    const forged = {
      ...fixture(),
      requestEvidence: {
        ...fixture().requestEvidence,
        reviewTemplate: { ...fixture().requestEvidence!.reviewTemplate, complete: true },
      },
    };
    await expect(qualityActualPreparation(forged, registry, candidateId, model)).rejects.toThrow();
  });
  it("shows only inspection before candidate selection, never approval or execution", () => {
    const markup = renderToStaticMarkup(createElement(QualityActualPreparationPanel, { registry }));
    expect(markup).toContain("실제 AI를 호출하지 않습니다");
    expect(markup).toContain("검토할 모델 ID");
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).not.toContain("실제 AI 실행 승인");
    const noRegistry = renderToStaticMarkup(
      createElement(QualityActualPreparationPanel, { registry: null }),
    );
    expect(noRegistry).toContain("먼저 보관한 후보 등록 버전을 열어 주세요");
  });
});
