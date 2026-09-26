import { describe, expect, it } from "vitest";
import { companyProfileSchema, emptyProfile, mutationSchema } from "./studio-schema";

describe("기업정보 날짜 검증", () => {
  const profile = { ...emptyProfile(), companyName: "테스트 기업" };
  it("설립일 미확정으로도 기업자료 수집을 시작할 수 있다", () => {
    expect(companyProfileSchema.safeParse(profile).success).toBe(true);
  });
  it("잘못된 날짜와 설립 이전 신청일을 거부한다", () => {
    expect(companyProfileSchema.safeParse({ ...profile, foundedOn: "2025-02-29" }).success).toBe(
      false,
    );
    expect(
      companyProfileSchema.safeParse({
        ...profile,
        foundedOn: "2024-02-29",
        applicationDate: "2024-02-28",
      }).success,
    ).toBe(false);
    expect(
      companyProfileSchema.safeParse({
        ...profile,
        foundedOn: "2024-02-29",
        applicationDate: "2026-09-22",
      }).success,
    ).toBe(true);
  });
});

describe("납입자본금과 결산월 검증", () => {
  const profile = { ...emptyProfile(), companyName: "자본금 검증 시험기업" };

  it("필드가 없는 기존 프로필과 수정 요청은 미확정으로 읽고 재무 메모를 보존한다", () => {
    const legacy: Record<string, unknown> = {
      ...profile,
      financials: "2024년 결산 자료의 금액과 단위를 별도로 확인해야 합니다.",
    };
    delete legacy.paidInCapital;
    delete legacy.closingMonth;
    const parsed = companyProfileSchema.parse(legacy);
    expect(parsed).toMatchObject({
      paidInCapital: "",
      closingMonth: "",
      financials: legacy.financials,
    });
    expect(mutationSchema.parse({ action: "profile", revision: 3, profile: legacy })).toEqual({
      action: "profile",
      revision: 3,
      profile: parsed,
    });
  });

  it.each(["", "0", "10000000", "9007199254740991"])(
    "정확한 원 단위 문자열을 반올림 없이 유지한다: %j",
    (paidInCapital) => {
      expect(companyProfileSchema.parse({ ...profile, paidInCapital }).paidInCapital).toBe(
        paidInCapital,
      );
    },
  );

  it.each([
    "9007199254740992",
    "10000000000000000",
    "-1",
    "-0",
    "+1",
    "00",
    "010000000",
    "10,000,000",
    "1.5",
    "1.0",
    "1e7",
    "0x10",
    "10000000원",
    " 10000000",
    "10000000 ",
    "1\n",
    " ",
    "NaN",
    "Infinity",
    10000000,
    null,
  ])("단위·형식·안전 정수 범위가 맞지 않는 자본금을 거부한다: %j", (paidInCapital) => {
    const result = companyProfileSchema.safeParse({ ...profile, paidInCapital });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual(["paidInCapital"]);
  });

  it.each(["", ...Array.from({ length: 12 }, (_, index) => String(index + 1))])(
    "미확정 또는 1~12월 문자열을 허용한다: %j",
    (closingMonth) => {
      expect(companyProfileSchema.parse({ ...profile, closingMonth }).closingMonth).toBe(
        closingMonth,
      );
    },
  );

  it.each(["0", "13", "01", "12월", "1.0", "1e1", " 1", "1 ", "1\n", 12, null])(
    "범위 밖이거나 표준 형식이 아닌 결산월을 거부한다: %j",
    (closingMonth) => {
      const result = companyProfileSchema.safeParse({ ...profile, closingMonth });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].path).toEqual(["closingMonth"]);
    },
  );
});
