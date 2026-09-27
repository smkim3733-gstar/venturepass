import { describe, expect, it } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import { studioMutationResponse } from "./studio-mutation-response";

const companyId = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-26T02:00:00.000Z";
const binding = Object.freeze({ id: companyId, revision: 3 });
function company(): StudioCase {
  return caseSchema.parse({
    id: companyId,
    profile: { ...emptyProfile(), companyName: "합성 저장 응답 검증 기업" },
    sources: [
      {
        id: sourceId,
        name: "합성 교정 자료",
        kind: "technology",
        text: "확인한 합성 본문",
        originalName: "synthetic.pdf",
        mimeType: "application/pdf",
        extraction: "manual",
        warnings: [],
        createdAt: now,
        updatedAt: now,
      },
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe("자료 편집 화면을 교체하기 전 mutation 응답 검증", () => {
  it("현재 기업의 새 버전은 파싱한 별도 객체로 반환한다", () => {
    const raw = deepFreeze(company());
    const before = structuredClone(raw);
    const result = studioMutationResponse(raw, binding);

    expect(result).toEqual(raw);
    expect(result).not.toBe(raw);
    expect(result.sources).not.toBe(raw.sources);
    expect(result.sources[0]).not.toBe(raw.sources[0]);
    expect(raw).toEqual(before);
    expect(binding).toEqual({ id: companyId, revision: 3 });
  });

  it("같은 버전의 멱등 재응답은 거부하지 않는다", () => {
    const raw = company();
    raw.revision = binding.revision;
    expect(studioMutationResponse(raw, binding).revision).toBe(binding.revision);
  });

  it("새 버전이어도 다른 기업의 응답은 현재 편집에 적용하지 않는다", () => {
    const raw = company();
    raw.id = foreignId;
    const before = structuredClone(raw);
    expect(() => studioMutationResponse(raw, binding)).toThrow(
      "현재 기업·버전과 일치하지 않습니다",
    );
    expect(raw).toEqual(before);
  });

  it("같은 기업의 이전 버전은 편집 상태를 되돌리지 않는다", () => {
    const raw = company();
    raw.revision = binding.revision - 1;
    expect(() => studioMutationResponse(raw, binding)).toThrow("입력 내용을 유지했습니다");
  });

  it.each([undefined, null, false, true, "저장 완료", 4, [], {}, { ok: true }, { accepted: true }])(
    "기업 레코드가 아닌 성공 표시나 잘못된 응답을 거부한다 (%#)",
    (raw) => {
      expect(() => studioMutationResponse(raw, binding)).toThrow("입력 내용을 유지했습니다");
    },
  );

  it.each([-1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "4", null])(
    "유효하지 않은 revision을 거부한다 (%s)",
    (revision) => {
      expect(() => studioMutationResponse({ ...company(), revision }, binding)).toThrow();
    },
  );

  it.each([
    [
      "필수 프로필 누락",
      (raw: Record<string, unknown>) => {
        delete raw.profile;
      },
    ],
    [
      "자료 배열 변조",
      (raw: Record<string, unknown>) => {
        raw.sources = "자료";
      },
    ],
    [
      "잘못된 계획서",
      (raw: Record<string, unknown>) => {
        raw.plans = [{ id: sourceId }];
      },
    ],
    [
      "본문 없이 검토 완료 사칭",
      (raw: Record<string, unknown>) => {
        raw.sources = [{ ...company().sources[0], extraction: "pending" }];
      },
    ],
  ] as const)("%s 응답은 파싱 단계에서 거부하고 입력 객체는 수정하지 않는다", (_, corrupt) => {
    const raw: Record<string, unknown> = { ...company() };
    corrupt(raw);
    deepFreeze(raw);
    const before = structuredClone(raw);
    expect(() => studioMutationResponse(raw, binding)).toThrow();
    expect(raw).toEqual(before);
  });

  it("응답의 추가 필드와 prototype 오염용 키를 기업 객체로 전달하지 않는다", () => {
    const raw = {
      ...company(),
      ...JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"approved":true}',
      ),
    };
    const result = studioMutationResponse(raw, binding);
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(Object.hasOwn(result, "approved")).toBe(false);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(Object.hasOwn(raw, "__proto__")).toBe(true);
  });
});
