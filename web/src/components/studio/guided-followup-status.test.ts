import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GuidedFollowupItem, GuidedFollowupSummary } from "@/lib/studio-guided-followup";
import { GuidedFollowupStatus } from "./guided-followup-status";

const item: GuidedFollowupItem = {
  kind: "response",
  target: {
    kind: "response",
    caseId: "synthetic-case",
    companyRevision: 4,
    requestRecordId: "request-root",
    requestVersionId: "request-v2",
  },
  title: "보완 요청 두 번째 원문",
  description: "이전 답변을 보존하고 현재 원문을 확인합니다.",
  dueOn: "2026-09-28",
  dueNote: "기관 안내 원문 기준",
  deadlineStatus: "upcoming",
  recordedAt: "2026-09-27T00:00:00.000Z",
  version: 2,
  provenance: "manual",
  actionLabel: "보완 답변 준비하기",
};
function summary(change: Partial<GuidedFollowupSummary> = {}): GuidedFollowupSummary {
  return {
    state: "action-required",
    title: "필요한 보완을 준비해 주세요",
    description: "사용자 기록",
    action: { label: item.actionLabel!, target: item.target },
    primary: item,
    items: [item],
    lastRecordedAt: item.recordedAt,
    lastCheckedAt: null,
    provenance: "manual",
    ...change,
  };
}
function render(value = summary(), disabled = false) {
  const onNavigate = vi.fn();
  const html = renderToStaticMarkup(
    createElement(GuidedFollowupStatus, {
      stage: "evaluating",
      summary: value,
      disabled,
      onNavigate,
    }),
  );
  expect(onNavigate).not.toHaveBeenCalled();
  return html;
}
describe("기본 신청 화면의 수동 기록 요약", () => {
  it("정확한 요청 제목·버전·기한을 표시하고 공식 확인 시각과 수동 기록을 구분한다", () => {
    const html = render();
    expect(html).toContain(item.title);
    expect(html).toContain("기록 v2");
    expect(html).toContain("2026-09-28");
    expect(html).toContain("사용자 기록");
    expect(html).toContain("2026. 9. 27. 오전 9:00");
    expect(html).toContain("공식 사이트 자동 조회 미연결");
    expect(html).not.toContain("확인 완료");
    expect(html).not.toContain("<button");
  });
  it("기한이 없으면 추정 날짜를 만들지 않는다", () => {
    expect(
      render(summary({ primary: { ...item, dueOn: null, dueNote: "", version: null }, items: [] })),
    ).toContain("기한·일정: 미확인");
  });
  it.each(["today", "overdue"] as const)("명시 날짜의 %s 표시만 더한다", (deadlineStatus) => {
    const changed = { ...item, deadlineStatus };
    const html = render(summary({ primary: changed, items: [changed] }));
    expect(html).toContain(deadlineStatus === "today" ? "오늘" : "날짜 지남");
    expect(html).toContain(item.dueOn);
  });
  it("대기 상태에서 주 실행을 새로 만들지 않는다", () => {
    const waiting = { ...item, actionLabel: null };
    const html = render(
      summary({ state: "waiting", action: null, primary: waiting, items: [waiting] }),
    );
    expect(html).not.toContain("<button");
  });
  it("함께 보관한 기록은 펼침 안의 비활성 가능한 보조 경로로만 제공한다", () => {
    const other = {
      ...item,
      title: "이어서 볼 기록",
      target: { ...item.target, requestVersionId: "other-v1" },
    };
    const html = render(summary({ items: [item, other] }), true);
    expect(html).toContain("<details");
    expect(html).toContain("함께 보관한 안내·업무 1건");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it("기록이 없거나 날짜가 손상되면 현재 시각으로 채우지 않는다", () => {
    expect(render(summary({ lastRecordedAt: null }))).toContain("기록 없음");
    expect(render(summary({ lastRecordedAt: "invalid" }))).toContain("기록 없음");
    expect(render(summary({ state: "none" }))).toBe("");
  });
  it("원문의 HTML을 실행 가능한 마크업으로 렌더링하지 않는다", () => {
    const changed = { ...item, title: "<script>bad()</script>" };
    const html = render(summary({ primary: changed, items: [changed] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
