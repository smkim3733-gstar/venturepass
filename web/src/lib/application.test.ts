import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applicationSchema,
  getEvidenceItems,
  getPreparationTrack,
  type ApplicationProfile,
} from "./application";
import { useWorkspaceStore } from "./workspace-store";

const profile: ApplicationProfile = {
  companyName: "테스트기업",
  startDate: "2023-09-22",
  applicationDate: "2026-09-22",
  applicationKind: "new",
  industry: "제조업",
  technologyName: "자동화 제어 기술",
};

describe("신청 준비 경로", () => {
  it("설립 3주년 전날은 신규 3년 미만이다", () => {
    expect(getPreparationTrack({ ...profile, applicationDate: "2026-09-21" }).id).toBe(
      "new-under-3",
    );
  });
  it("설립 3주년 당일부터 신규 3년 이상이다", () => {
    expect(getPreparationTrack(profile).id).toBe("new-3-plus");
  });
  it("재확인은 업력보다 신청 구분을 우선한다", () => {
    expect(
      getPreparationTrack({ ...profile, startDate: "2026-01-01", applicationKind: "renewal" }).id,
    ).toBe("renewal");
  });
  it("윤일 설립의 3주년은 해당 연도의 2월 마지막 날로 계산한다", () => {
    expect(
      getPreparationTrack({ ...profile, startDate: "2024-02-29", applicationDate: "2027-02-27" })
        .id,
    ).toBe("new-under-3");
    expect(
      getPreparationTrack({ ...profile, startDate: "2024-02-29", applicationDate: "2027-02-28" })
        .id,
    ).toBe("new-3-plus");
  });
});

describe("기업 정보 검증", () => {
  it.each(["companyName", "technologyName", "industry", "startDate", "applicationDate"])(
    "%s 빈 값은 허용하지 않는다",
    (key) => {
      expect(applicationSchema.safeParse({ ...profile, [key]: "" }).success).toBe(false);
    },
  );
  it("공백만 있는 기업명은 허용하지 않는다", () => {
    expect(applicationSchema.safeParse({ ...profile, companyName: "   " }).success).toBe(false);
  });
  it("존재하지 않는 날짜는 허용하지 않는다", () => {
    expect(applicationSchema.safeParse({ ...profile, startDate: "2023-02-29" }).success).toBe(
      false,
    );
  });
  it("신청예정일이 설립일보다 앞서면 날짜 필드에 오류를 제공한다", () => {
    const result = applicationSchema.safeParse({ ...profile, applicationDate: "2023-09-21" });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === "applicationDate")).toBe(true);
  });
});

describe("경로에 맞는 증빙 안내", () => {
  it("신규 3년 미만은 연구개발비·고용상승률·재확인 성과 항목을 포함하지 않는다", () => {
    const ids = getEvidenceItems("new-under-3").map((item) => item.id);
    expect(ids).not.toContain("research-cost");
    expect(ids).not.toContain("employment-growth");
    expect(ids).not.toContain("business-performance");
    expect(ids).toContain("registration");
    expect(ids).toContain("difference");
  });
  it("재확인 경로에 사업성과 항목을 포함한다", () => {
    expect(getEvidenceItems("renewal").some((item) => item.id === "business-performance")).toBe(
      true,
    );
    expect(getEvidenceItems("new-3-plus").some((item) => item.id === "business-performance")).toBe(
      false,
    );
  });
});

describe("브라우저 저장 실패", () => {
  let failWrites = false;
  beforeEach(() => {
    failWrites = false;
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        if (failWrites) throw new Error("storage blocked");
      },
      removeItem: () => {},
    });
    useWorkspaceStore.getState().resetWorkspace();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("기업 정보 저장 실패 시 저장 전 상태를 유지한다", () => {
    failWrites = true;
    expect(() => useWorkspaceStore.getState().saveProfile(profile)).toThrow("storage blocked");
    expect(useWorkspaceStore.getState().profile).toBeNull();
  });
  it("검토 체크와 삭제 실패 시 기존 기록을 유지한다", () => {
    useWorkspaceStore.getState().saveProfile(profile);
    useWorkspaceStore.getState().toggleEvidence("registration");
    failWrites = true;
    expect(() => useWorkspaceStore.getState().toggleEvidence("registration")).toThrow(
      "storage blocked",
    );
    expect(useWorkspaceStore.getState().checkedEvidence).toEqual(["registration"]);
    expect(() => useWorkspaceStore.getState().resetWorkspace()).toThrow("storage blocked");
    expect(useWorkspaceStore.getState().profile).toEqual(profile);
    expect(useWorkspaceStore.getState().checkedEvidence).toEqual(["registration"]);
  });
});
