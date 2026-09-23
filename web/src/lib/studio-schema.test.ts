import { describe, expect, it } from "vitest";
import { companyProfileSchema, emptyProfile } from "./studio-schema";

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
