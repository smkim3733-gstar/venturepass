import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { caseSchema, emptyProfile, sourceSchema } from "@/lib/studio-schema";
import { guidedUploadResult } from "./guided-upload-result";
const now = "2026-10-03T10:00:00.000Z";
const source = (name: string) =>
  sourceSchema.parse({
    id: randomUUID(),
    name,
    originalName: name,
    mimeType: "application/pdf",
    kind: "other",
    text: "합성 본문",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
const old = source("과거.pdf"),
  uploaded = source("신규.pdf");
const base = caseSchema.parse({
  id: randomUUID(),
  profile: { ...emptyProfile(), companyName: "합성 저장 확인" },
  sources: [old],
  analysis: null,
  selectedCandidateId: null,
  plans: [],
  tasks: [],
  stage: "preparing",
  revision: 1,
  createdAt: now,
  updatedAt: now,
});
const saved = { ...base, revision: 2, sources: [old, uploaded] };
describe("업로드 저장 확인", () => {
  it("같은 회사에 새 파일이 추가된 응답을 확인한다", () => {
    expect(guidedUploadResult(saved, base, "신규.pdf")?.source).toEqual(uploaded);
  });
  it("본문이 없는 원본 보관도 저장 성공과 미확인 본문을 구분한다", () => {
    const pending = { ...uploaded, extraction: "pending", text: "" };
    expect(
      guidedUploadResult({ ...saved, sources: [old, pending] }, base, "신규.pdf")?.source
        .extraction,
    ).toBe("pending");
  });
  it.each([
    ["과거 응답", base],
    ["과거 revision", { ...saved, revision: 1 }],
    ["다른 회사", { ...saved, id: randomUUID() }],
    ["다른 파일", { ...saved, sources: [old, source("다른.pdf")] }],
    ["기존 자료 유실", { ...saved, sources: [source("대체.pdf"), uploaded] }],
    ["누락 파일", { ...saved, sources: [old] }],
    ["중복 파일", { ...saved, sources: [old, old] }],
    ["손상 응답", { ok: true }],
  ])("%s를 저장 완료로 표시하지 않는다", (_name, value) => {
    expect(guidedUploadResult(value, base, "신규.pdf")).toBeNull();
  });
});
