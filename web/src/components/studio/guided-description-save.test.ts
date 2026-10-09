import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile } from "@/lib/studio-schema";
import { guidedDescriptionAcknowledged } from "./guided-description-save";

const original = caseSchema.parse({
  id: "c0000000-0000-4000-8000-000000000001",
  revision: 3, profile: { ...emptyProfile(), companyName: "합성 기업" },
  sources: [], plans: [], tasks: [], analysis: null, selectedCandidateId: null,
  stage: "preparing", createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z",
});
const submitted = { ...original.profile, technologySummary: "설비 상태 확인 기술\n근거는 확인 필요" };
const saved = () => ({ ...structuredClone(original), revision: 4, profile: { ...submitted } });

describe("회사 설명의 실제 저장 응답 확인", () => {
  it("같은 회사의 증가 revision과 제출한 전체 profile만 수락하며 값을 변경하지 않는다", () => {
    const response = saved(), before = structuredClone(response);
    expect(guidedDescriptionAcknowledged(response, original, submitted)).toBe(true);
    expect(response).toEqual(before);
    expect(original.profile.technologySummary).toBe("");
  });
  it.each([
    ["응답 없음", () => null],
    ["같은 revision", () => ({ ...saved(), revision: 3 })],
    ["이전 revision", () => ({ ...saved(), revision: 2 })],
    ["다른 회사", () => ({ ...saved(), id: "c0000000-0000-4000-8000-000000000002" })],
    ["저장 전 설명", () => ({ ...saved(), profile: { ...original.profile } })],
    ["다른 profile 필드", () => ({ ...saved(), profile: { ...submitted, companyName: "다른 이름" } })],
    ["원문 줄바꿈 변형", () => ({ ...saved(), profile: { ...submitted, technologySummary: submitted.technologySummary.replace("\n", " ") } })],
  ])("%s이면 입력을 닫을 수 없다", (_name, make) => {
    expect(guidedDescriptionAcknowledged(make(), original, submitted)).toBe(false);
  });
  it("필드 순서만 다른 동일 profile은 수락한다", () => {
    const response = saved();
    response.profile = Object.fromEntries(Object.entries(submitted).reverse()) as typeof submitted;
    expect(guidedDescriptionAcknowledged(response, original, submitted)).toBe(true);
  });
});
