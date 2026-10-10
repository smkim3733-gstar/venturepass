import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { submissionReadCompany } from "../../../scripts/fixtures/guided-submission-read";
import { guidedApplicationHistory } from "@/lib/studio-guided-applications";
import { GuidedApplicationHistory, GuidedSubmissionRead } from "./guided-application-history";

describe("간단 신청의 제출 당시 보관 내용 읽기", () => {
  const fixture = () => {
    const company = submissionReadCompany();
    return { company, target: guidedApplicationHistory(company).cycles[0].submissions[0].target };
  };
  it("정정된 제출 기록과 고정된 접수 버전을 읽으며 현재 원고를 바꾸지 않는다", () => {
    const { company } = fixture();
    const original = structuredClone(company);
    const navigate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(GuidedApplicationHistory, { company, disabled: false, onNavigate: navigate }),
    );
    expect(html).toContain("제출 당시 보관 내용 읽기");
    expect(html).toContain("기록 v2");
    expect(html).toContain("당시 선택 원고 v1");
    expect(html).toContain("원래-접수번호");
    expect(html).not.toContain("다른-최신번호");
    expect(html).not.toContain("정정 전 메모");
    expect(html).toContain("당시 준비자");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("기관 확인 미실시");
    expect(company).toEqual(original);
    expect(navigate).not.toHaveBeenCalled();
  });
  for (const change of ["company", "revision", "old-record", "duplicate", "blocked"] as const)
    it(`${change}에서는 보관 내용을 열지 않는다`, () => {
      const { company, target } = fixture();
      if (change === "company") target.caseId = "d0000000-0000-4000-8000-000000000001";
      if (change === "revision") target.companyRevision--;
      if (change === "old-record") target.submissionVersionId = company.applicationEvents[0].id;
      if (change === "duplicate")
        company.applicationEvents.push(structuredClone(company.applicationEvents[1]));
      const html = renderToStaticMarkup(
        createElement(GuidedSubmissionRead, { company, target, disabled: change === "blocked" }),
      );
      expect(html).not.toContain("당시 선택 원고");
      expect(html).not.toContain("제출 당시 보관 내용 읽기");
    });
  for (const change of ["duplicate-receipt", "unrelated-receipt"] as const)
    it(`${change}에서 첫 접수 기록을 추정하지 않는다`, () => {
      const { company, target } = fixture();
      if (change === "duplicate-receipt")
        company.agencyRecords.push(structuredClone(company.agencyRecords[0]));
      else
        company.agencyRecords[0] = {
          ...company.agencyRecords[0],
          details: {
            category: "payment",
            amountWon: "",
            dueOn: "",
            dueNote: "",
            paidOn: "",
            referenceNumber: "",
            statusText: "",
          },
        } as (typeof company.agencyRecords)[number];
      const html = renderToStaticMarkup(
        createElement(GuidedSubmissionRead, { company, target, disabled: false }),
      );
      expect(html).toContain("연결한 접수 기록 확인 필요");
      expect(html).not.toContain("원래-접수번호");
    });
  it("소실된 접수 기록을 현재 기록으로 대신하지 않는다", () => {
    const { company, target } = fixture();
    company.agencyRecords.shift();
    const html = renderToStaticMarkup(
      createElement(GuidedSubmissionRead, { company, target, disabled: false }),
    );
    expect(html).toContain("연결 기록 확인 필요");
    expect(html).toContain("당시 선택 원고 v1");
    expect(html).not.toContain("다른-최신번호");
  });
});
