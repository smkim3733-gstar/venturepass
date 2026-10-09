import { expect, it } from "vitest";
import {
  readVentureOverview,
  ventureOverviewAction,
  ventureOverviewSchema,
} from "./venturein-overview-types";

const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
  return {
    caseId: id,
    companyRevision: 4,
    workflowRevision: 3,
    accountRevision: 2,
    accountSaved: true,
    sessionState: "connected_unmapped" as const,
    sessionUpdatedAt: "2026-10-09T00:00:00.000Z",
    screenObservedAt: "2026-10-09T00:00:00.000Z",
    phase: "view" as const,
    previousInputNeedsCheck: false,
    readAt: "2026-10-09T00:00:00.000Z",
    automaticSubmissionAvailable: false as const,
    officialStatusChecked: false as const,
    transmissionAllowed: false as const,
  };
}
it("조회 안내를 strict 요약으로 전달하되 입력 권한이나 회사의 확인 결과로 승격하지 않는다", () => {
  const value = fixture();
  const original = structuredClone(value);
  const parsed = readVentureOverview(value, { id, revision: 4 });
  expect(parsed).toEqual(value);
  expect(ventureOverviewAction(parsed)).toMatchObject({
    title: "현재 읽은 화면에는 입력할 항목이 없습니다",
    label: "읽은 화면 확인하기",
  });
  expect(ventureOverviewAction(parsed).description).toContain(
    "입력 검토나 새 신청을 시작하지 않으며",
  );
  expect(value).toEqual(original);
});
it.each(["automaticSubmissionAvailable", "officialStatusChecked", "transmissionAllowed"] as const)(
  "조회 안내도 %s 권한이 true인 응답을 거절한다",
  (permission) => {
    expect(ventureOverviewSchema.safeParse({ ...fixture(), [permission]: true }).success).toBe(
      false,
    );
  },
);
it("조회 안내보다 미확인 실행 결과를 우선한다", () => {
  expect(ventureOverviewAction({ ...fixture(), previousInputNeedsCheck: true }).label).toBe(
    "이전 입력 결과 확인",
  );
});
it("조회 안내라도 다른 회사 또는 revision은 수신하지 않는다", () => {
  expect(() => readVentureOverview(fixture(), { id, revision: 5 })).toThrow();
  expect(() =>
    readVentureOverview(fixture(), { id: "22222222-2222-4222-8222-222222222222", revision: 4 }),
  ).toThrow();
});
