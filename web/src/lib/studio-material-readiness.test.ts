import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, sourceSchema, type StudioCase } from "./studio-schema";
import { serializeStudioAiInput } from "./studio-ai-input";
import { aiInput, StudioEngineError } from "./studio-engine-request-preparation";
import {
  guidedPreparationApproval,
  guidedPreparationFingerprint,
} from "./studio-guided-preparation-state";
import { materialReadiness } from "./studio-material-readiness";
import { newSourceIntakeBatch, intakeSha } from "./studio-source-intake";
import { sourceIntakeItemSchema } from "./studio-source-intake-types";

const now = "2026-10-04T13:20:00.000Z";
function company() {
  return caseSchema.parse({
    id: randomUUID(),
    profile: { ...emptyProfile(), companyName: "합성 자료 현황" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}
function source(text = "합성 본문", extraction: "local" | "pending" | "manual" = "local") {
  return sourceSchema.parse({
    id: randomUUID(),
    name: "같은이름.pdf",
    originalName: "같은이름.pdf",
    mimeType: "application/pdf",
    kind: "technology",
    text,
    extraction,
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
}
function pendingResult(c: StudioCase) {
  const [item] = newSourceIntakeBatch({
    action: "create",
    revision: 0,
    clientRequestId: randomUUID(),
    files: [
      { clientFileId: randomUUID(), originalName: "pending.txt", sizeBytes: 3, kind: "technology" },
    ],
  });
  item.original = {
    originalName: "pending.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    sha256: intakeSha("abc"),
    sourceUpdatedAt: now,
  };
  item.phase = "awaiting_review";
  const resultId = randomUUID(),
    attemptId = randomUUID();
  item.attempts = [
    {
      id: attemptId,
      engine: "local-document",
      startedAt: now,
      finishedAt: now,
      originalSha256: item.original.sha256,
      sourceUpdatedAt: now,
      externalRequestStarted: false,
      status: "completed",
      code: null,
      resultId,
    },
  ];
  item.result = {
    id: resultId,
    attemptId,
    engine: "local-document",
    generatedAt: now,
    originalSha256: item.original.sha256,
    sourceUpdatedAt: now,
    textSha256: intakeSha("비채택 판독문"),
    content: { kind: "plain", text: "비채택 판독문" },
    warnings: [],
    reviewStatus: "unreviewed",
    discardedAt: null,
  };
  c.sources.push({ ...source("", "pending"), id: item.sourceId });
  c.sourceIntakes.push(sourceIntakeItemSchema.parse(item));
  return c.sourceIntakes[0];
}
afterEach(() => vi.restoreAllMocks());
describe("saved material scope and first-analysis size", () => {
  it("allows zero attachments to stay empty and distinguishes company description", () => {
    const c = company();
    expect(materialReadiness(c)).toMatchObject({
      stored: 0,
      occupied: 0,
      hasDescription: false,
      included: 0,
    });
    c.profile.technologySummary = "회사 설명으로만 시작";
    expect(materialReadiness(c)).toMatchObject({ stored: 0, hasDescription: true, included: 0 });
    expect(JSON.parse(aiInput(c)).sources).toEqual([]);
  });
  it("matches the existing approval including empty nonpending metadata, excluding pending bodies", () => {
    const c = company();
    c.sources = [source(), source("", "pending"), source(" ", "manual")];
    const overview = materialReadiness(c),
      approval = guidedPreparationApproval(c, "synthetic");
    expect(overview).toMatchObject({
      stored: 3,
      withBody: 1,
      pendingBody: 2,
      included: 2,
      includedEmpty: 1,
      excluded: 1,
    });
    expect(overview.rows.filter((r) => r.included).map((r) => r.sourceId)).toEqual(
      approval.sourceIds,
    );
    expect(JSON.parse(aiInput(c)).sources.map((s: { sourceId: string }) => s.sourceId)).toEqual(
      approval.sourceIds,
    );
  });
  it("does not send a retained unreviewed result or treat it as adopted", () => {
    const c = company();
    pendingResult(c);
    const before = JSON.stringify(c),
      fingerprint = guidedPreparationFingerprint(c);
    expect(materialReadiness(c)).toMatchObject({
      stored: 1,
      withBody: 0,
      awaitingAdoption: 1,
      included: 0,
    });
    expect(serializeStudioAiInput(c)).not.toContain("비채택 판독문");
    expect(JSON.stringify(c)).toBe(before);
    expect(guidedPreparationFingerprint(c)).toBe(fingerprint);
  });
  it("uses the adopted body, preserves unreviewed historical result and flags a later unadopted result separately", () => {
    const c = company(),
      item = pendingResult(c),
      result = item.result!;
    item.adoption = {
      id: randomUUID(),
      clientRequestId: randomUUID(),
      inputDigest: "a".repeat(64),
      resultId: result.id,
      resultTextSha256: result.textSha256,
      adoptedTextSha256: intakeSha("교정하여 채택한 본문"),
      sourceUpdatedAt: now,
      adoptedAt: now,
    };
    item.phase = "adopted";
    c.sources[0] = { ...c.sources[0], extraction: "manual", text: "교정하여 채택한 본문" };
    expect(materialReadiness(c)).toMatchObject({ withBody: 1, awaitingAdoption: 0, included: 1 });
    expect(result.reviewStatus).toBe("unreviewed");
    expect(aiInput(c)).toContain("교정하여 채택한 본문");
    expect(aiInput(c)).not.toContain("비채택 판독문");
    item.result = { ...result, id: randomUUID() };
    item.phase = "awaiting_review";
    expect(materialReadiness(c)).toMatchObject({ withBody: 1, awaitingAdoption: 1, included: 1 });
  });
  it("keeps reservations separate from stored sources and excludes cancelled reservations", () => {
    const c = company();
    const items = newSourceIntakeBatch({
      action: "create",
      revision: 0,
      clientRequestId: randomUUID(),
      files: [1, 2].map((n) => ({
        clientFileId: randomUUID(),
        originalName: n + ".pdf",
        sizeBytes: 1,
        kind: "other" as const,
      })),
    });
    items[1].phase = "cancelled";
    c.sourceIntakes = items;
    expect(materialReadiness(c)).toMatchObject({ stored: 0, occupied: 1, awaitingAdoption: 0 });
  });
  it("does not advertise discarded or cancelled results for adoption", () => {
    const c = company(),
      item = pendingResult(c);
    item.result!.content = null;
    item.result!.discardedAt = now;
    item.phase = "result_discarded";
    expect(materialReadiness(c).awaitingAdoption).toBe(0);
    item.result!.content = { kind: "plain", text: "과거" };
    item.result!.discardedAt = null;
    item.phase = "cancelled";
    expect(materialReadiness(c).awaitingAdoption).toBe(0);
  });
  it("compares exact body content only, never same filenames or a similar assertion", () => {
    const c = company();
    c.sources = [
      source("상충 여부 미확인"),
      source("상충 여부 미확인"),
      source("상충 여부 확인"),
      source("상충 여부 미확인 "),
      source(" "),
      source(" "),
    ];
    const before = JSON.stringify(c);
    expect(materialReadiness(c).equalBodyGroups).toEqual([
      c.sources.slice(0, 2).map(({ id, name }) => ({ sourceId: id, name })),
    ]);
    expect(JSON.stringify(c)).toBe(before);
  });
  it("counts the full serialized UTF-16 input, escapes, warnings and profile; excludes the business-number field only", () => {
    const c = company();
    c.profile.businessNumber = "FIELD-NOT-SENT";
    c.profile.technologySummary = "😀";
    c.sources = [source('본문 속 개인정보는 그대로 \" \n 😀')];
    c.sources[0].warnings = ["긴 경고"];
    const input = aiInput(c),
      parsed = JSON.parse(input);
    expect(input).not.toContain("FIELD-NOT-SENT");
    expect(parsed.sources[0].text).toBe(c.sources[0].text);
    expect(materialReadiness(c).serializedCharacters).toBe(input.length);
    expect(input.length).toBeGreaterThan(
      c.sources[0].text.length + c.profile.technologySummary.length,
    );
    expect(parsed.sources[0].warnings).toEqual(["긴 경고"]);
  });
  it("measures all 100 long bodies without shortening or silently excluding duplicates", () => {
    const c = company();
    c.sources = Array.from({ length: 100 }, () => source("가".repeat(1500)));
    const input = aiInput(c),
      before = JSON.stringify(c);
    expect(materialReadiness(c)).toMatchObject({
      stored: 100,
      occupied: 100,
      included: 100,
      withBody: 100,
      serializedCharacters: input.length,
    });
    const parsed = JSON.parse(input);
    expect(parsed.sources).toHaveLength(100);
    expect(parsed.sources.every((s: { text: string }) => s.text.length === 1500)).toBe(true);
    expect(JSON.stringify(c)).toBe(before);
  });
  it("shows overage without weakening the existing exact 240000/240001 rejection boundary", () => {
    const c = company();
    c.sources = [source(""), source("")];
    const remainder = 240000 - serializeStudioAiInput(c).length;
    const quotes = Math.floor(remainder / 2);
    c.sources[0].text = '"'.repeat(Math.floor(quotes / 2));
    c.sources[1].text = '"'.repeat(quotes - Math.floor(quotes / 2)) + (remainder % 2 ? "가" : "");
    caseSchema.parse(c);
    expect(aiInput(c).length).toBe(240000);
    expect(materialReadiness(c).overLimit).toBe(false);
    c.sources[1].text += "나";
    expect(materialReadiness(c)).toMatchObject({ serializedCharacters: 240001, overLimit: true });
    expect(() => aiInput(c)).toThrow(StudioEngineError);
    expect(() => aiInput(c)).toThrow("총 24만 자");
    expect(c.sources.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThan(160000);
  });
  it("keeps caller extra field order and profile replacement semantics byte-compatible", () => {
    const c = company();
    const extra = {
      draft: { z: 1, a: "원래 순서" },
      selectedCandidate: { z: true },
      profile: { synthetic: true },
    };
    const parsed = JSON.parse(serializeStudioAiInput(c, extra));
    expect(Object.keys(parsed)).toEqual([
      "profile",
      "preparationContext",
      "unextractedSourceCount",
      "sources",
      "draft",
      "selectedCandidate",
    ]);
    expect(Object.keys(parsed.draft)).toEqual(["z", "a"]);
    expect(parsed.profile).toEqual(extra.profile);
  });
  it("returns isolated projections and requires neither provider IO nor a current clock", () => {
    const c = company();
    c.sources = [source(), source()];
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("No clock");
    });
    const before = JSON.stringify(c),
      value = materialReadiness(c);
    value.rows[0].name = "외부 변경";
    value.equalBodyGroups[0][0].name = "다른 변경";
    expect(JSON.stringify(c)).toBe(before);
    expect(network).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });
});
