import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CaseSummary } from "@/lib/studio-schema";
import {
  CaseAttentionCard,
  caseAttentionActions,
  localDay,
  selectCaseSummaries,
} from "./case-attention";

const now = "2026-09-25T00:00:00.000Z";
function summary(change: Partial<CaseSummary> = {}): CaseSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyName: "가상 기술 회사",
    industry: "기술업",
    stage: "preparing",
    revision: 2,
    sourceCount: 0,
    planCount: 0,
    pendingTaskCount: 0,
    createdAt: now,
    updatedAt: now,
    attention: {
      pendingSourceCount: 0,
      unconfirmedSectionCount: 0,
      planReviewRequired: false,
      diagnosisState: "current",
      preparationState: "awaiting_review",
      pendingDueDates: [],
      undatedTaskCount: 0,
      requestsWithoutSentResponse: 0,
    },
    ...change,
  };
}
function withAttention(
  change: Partial<NonNullable<CaseSummary["attention"]>>,
  other: Partial<CaseSummary> = {},
) {
  return summary({ ...other, attention: { ...summary().attention!, ...change } });
}
function choose(
  cases: CaseSummary[],
  change: Partial<Parameters<typeof selectCaseSummaries>[1]> = {},
) {
  return selectCaseSummaries(cases, {
    query: "",
    filter: "all",
    sort: "due-date",
    today: "2026-09-25",
    ...change,
  });
}
function card(item = summary(), busy = false) {
  const onOpen = vi.fn();
  return {
    html: renderToStaticMarkup(
      createElement(CaseAttentionCard, { item, today: "2026-09-25", busy, onOpen }),
    ),
    onOpen,
  };
}

describe("company attention filters and ordering", () => {
  it("includes undated certificate preparation without inventing a deadline or legal status", () => {
    const item = withAttention({
      certificate: {
        recordedUntilDates: [],
        missingUntilCount: 1,
        needsPreparationCount: 1,
        changedTaskCount: 0,
      },
    });
    expect(choose([item], { filter: "attention" })).toEqual([item]);
    expect(choose([item], { filter: "due-soon" })).toEqual([]);
    expect(choose([item], { filter: "overdue" })).toEqual([]);
    const { html } = card(item);
    expect(html).toContain("유효종료일 미기재 통보 1건");
    expect(html).toContain("차기 준비 업무·날짜 확인 필요 1건");
    expect(caseAttentionActions(item)).toContainEqual({
      tab: "workflow",
      label: "확인서·차기 준비",
    });
  });
  it("treats a recorded expiry as entered information, separate from task deadlines", () => {
    const item = withAttention({
      certificate: {
        recordedUntilDates: ["2020-01-01", "2028-09-24"],
        missingUntilCount: 0,
        needsPreparationCount: 0,
        changedTaskCount: 1,
      },
    });
    const { html } = card(item);
    expect(html).toContain("가장 이른 기재 유효종료일: 2020-01-01");
    expect(html).toContain("종료일 기재 통보 2건");
    expect(html).toContain("현재 효력 미확인");
    expect(html).toContain("확인서 통보 변경·연결 재확인 업무 1건");
    expect(choose([item], { filter: "overdue" })).toEqual([]);
  });
  it("keeps older summaries without certificate information readable", () => {
    const item = summary();
    expect(item.attention?.certificate).toBeUndefined();
    const { html } = card(item);
    expect(html).not.toContain("유효종료일");
    expect(html).not.toContain("확인서 검증 완료");
    expect(choose([item], { filter: "attention" })).toEqual([]);
  });
  const overdue = withAttention(
    { pendingDueDates: ["2026-09-24"] },
    { id: "overdue", pendingTaskCount: 1 },
  );
  const today = withAttention(
    { pendingDueDates: ["2026-09-25"] },
    { id: "today", pendingTaskCount: 1 },
  );
  const day7 = withAttention(
    { pendingDueDates: ["2026-10-02"] },
    { id: "day7", pendingTaskCount: 1 },
  );
  const day8 = withAttention(
    { pendingDueDates: ["2026-10-03"] },
    { id: "day8", pendingTaskCount: 1 },
  );
  it("uses inclusive today and seventh-day boundaries without including overdue tasks", () => {
    expect(
      choose([day8, day7, today, overdue], { filter: "due-soon" }).map((item) => item.id),
    ).toEqual(["today", "day7"]);
    expect(
      choose([day8, day7, today, overdue], { filter: "overdue" }).map((item) => item.id),
    ).toEqual(["overdue"]);
  });
  it("combines case-insensitive name/industry search with status filtering", () => {
    expect(choose([overdue, today], { query: "  기술업  ", filter: "overdue" })).toEqual([overdue]);
    expect(choose([summary({ companyName: "TEST Company" })], { query: "test" })).toHaveLength(1);
    expect(choose([overdue], { query: "다른 기업" })).toEqual([]);
  });
  it("sorts earliest unfinished date first and undated cases last without mutating input", () => {
    const input = [summary({ id: "undated" }), day7, overdue, today];
    expect(choose(input).map((item) => item.id)).toEqual(["overdue", "today", "day7", "undated"]);
    expect(input[0].id).toBe("undated");
  });
  it("provides recent-first ordering independent of date order", () => {
    const newer = { ...day7, updatedAt: "2026-09-26T00:00:00.000Z" };
    expect(choose([overdue, newer], { sort: "recent" })[0].id).toBe("day7");
  });
  it("includes unavailable legacy detail and unreviewed plans in needs-check filter", () => {
    const old = summary({ id: "old", attention: undefined });
    const review = withAttention({ planReviewRequired: true }, { id: "review" });
    expect(
      choose([summary(), old, review], { filter: "attention" })
        .map((item) => item.id)
        .sort(),
    ).toEqual(["old", "review"]);
  });
  it("waits for a valid local day before claiming overdue or due-soon", () => {
    expect(choose([overdue, today], { filter: "overdue", today: "" })).toEqual([]);
    expect(choose([overdue, today], { filter: "due-soon", today: "2026-02-30" })).toEqual([]);
  });
  it("formats local calendar dates correctly across midnight and year end", () => {
    expect(localDay(new Date(2026, 8, 25, 23, 59))).toBe("2026-09-25");
    expect(localDay(new Date(2026, 8, 26, 0, 0))).toBe("2026-09-26");
    expect(localDay(new Date(2026, 11, 31, 24, 0))).toBe("2027-01-01");
  });
});

describe("company summary action destinations", () => {
  it("links pending materials, diagnosis, plan review, and request work to exact tabs", () => {
    const actions = caseAttentionActions(
      withAttention(
        {
          pendingSourceCount: 2,
          diagnosisState: "stale",
          unconfirmedSectionCount: 3,
          requestsWithoutSentResponse: 1,
        },
        { planCount: 1 },
      ),
    );
    expect(actions.map((item) => item.tab)).toEqual(["workflow", "sources", "diagnosis", "plan"]);
    expect(new Set(actions.map((item) => item.tab)).size).toBe(actions.length);
  });
  it("sends required explicit strategy choice to analysis and missing technology to profile", () => {
    expect(
      caseAttentionActions(withAttention({ preparationState: "awaiting_choice" })),
    ).toContainEqual({ tab: "analysis", label: "신청 아이템 선택" });
    expect(
      caseAttentionActions(withAttention({ preparationState: "awaiting_materials" })),
    ).toContainEqual({ tab: "profile", label: "기술정보 보강" });
  });
  it("does not convert unavailable legacy detail into zero unresolved issues", () => {
    expect(caseAttentionActions(summary({ attention: undefined }))).toEqual([
      { tab: "workflow", label: "상세 현황 확인" },
    ]);
    const html = card(summary({ attention: undefined })).html;
    expect(html).toContain("상세 현황이 없는 이전 응답");
    expect(html).not.toContain("기재된 기한 없음");
  });
});

describe("company attention cards", () => {
  it("shows dates, missing text, review needs and manually recorded correspondence status", () => {
    const item = withAttention(
      {
        pendingDueDates: ["2026-09-24", "2026-09-25"],
        pendingSourceCount: 2,
        unconfirmedSectionCount: 3,
        planReviewRequired: true,
        requestsWithoutSentResponse: 1,
        undatedTaskCount: 1,
      },
      { pendingTaskCount: 3 },
    );
    const output = card(item);
    expect(output.html).toContain("기한 경과 1건");
    expect(output.html).toContain("오늘~7일 내 1건");
    expect(output.html).toContain("본문 미확인 원본 2건");
    expect(output.html).toContain("미확인 항목 3개");
    expect(output.html).toContain("내부 검토 확인 필요");
    expect(output.html).toContain("요청 답변 발송 표시 확인 1건");
    expect(output.html).not.toContain("기관 미접수");
    expect(output.onOpen).not.toHaveBeenCalled();
  });
  it("keeps zero unconfirmed sections separate from uncompleted internal review", () => {
    const html = card(withAttention({ planReviewRequired: true }, { planCount: 1 })).html;
    expect(html).toContain("내부 검토 확인 필요");
    expect(html).not.toContain("미확인 항목 0개");
  });
  it("renders independent buttons without nesting actionable controls", () => {
    const html = card(withAttention({ pendingSourceCount: 1, diagnosisState: "not_run" })).html;
    let depth = 0;
    for (const token of html.match(/<\/?button\b[^>]*>/g) ?? []) {
      if (token.startsWith("</")) depth--;
      else {
        expect(depth).toBe(0);
        depth++;
      }
    }
    expect(depth).toBe(0);
  });
  it("disables every navigation action while busy and escapes company names", () => {
    const html = card(
      withAttention({ pendingSourceCount: 1 }, { companyName: "<script>가상 기업</script>" }),
      true,
    ).html;
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
