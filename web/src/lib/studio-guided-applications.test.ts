import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  guidedApplicationHistory,
  validGuidedApplicationTarget,
} from "./studio-guided-applications";
import { guidedApplicationsFixture } from "./studio-guided-applications-test-helpers";
import { deriveGuidedFollowup, validateGuidedWorkflowTarget } from "./studio-guided-followup";
import { isApplicationSubmission } from "./studio-application-types";
import { GuidedApplicationHistory } from "../components/studio/guided-application-history";
import { ApplicationHistory } from "../components/studio/application-history";

const fixture = guidedApplicationsFixture;
describe("간단 신청 회차·제출 기록의 읽기와 정확한 이동", () => {
  it("두 회차와 당시 원고를 구분하고 접수 미연결을 그대로 표시한다", () => {
    const { company } = fixture();
    const before = JSON.stringify(company);
    const history = guidedApplicationHistory(company);
    expect(history.needsInspection).toBe(false);
    expect(history.cycles.map((c) => c.submissions.length)).toEqual([1, 0]);
    expect(history.cycles[0].submissions[0]).toMatchObject({
      occurredOn: "2026-09-02",
      planVersion: 1,
      receipt: "접수 기록 연결 없음",
    });
    for (const c of history.cycles)
      expect(validateGuidedWorkflowTarget(company, c.target).valid).toBe(true);
    expect(JSON.stringify(company)).toBe(before);
    history.cycles[0].target.applicationId = randomUUID();
    expect(JSON.stringify(company)).toBe(before);
  });
  it("정정은 기록 시각 대신 보관 순서와 원래 부모를 따른다", () => {
    const { company, apply } = fixture();
    const original = company.applicationEvents.find(isApplicationSubmission)!;
    const old = guidedApplicationHistory(company).cycles[0];
    apply({
      action: "correct-application",
      applicationId: old.id,
      previousVersionId: old.target.metadataVersionId,
      title: "회차 정정",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
    });
    apply({
      action: "correct-application-submission",
      applicationId: old.id,
      submissionRecordId: original.id,
      previousVersionId: original.id,
      planId: company.plans[0].id,
      sourceIds: [],
      taskIds: [],
      receiptRecordId: null,
      occurredOn: "2026-09-03",
      recordedBy: "합성 담당자",
      note: "정정",
    });
    company.applicationEvents.at(-1)!.recordedAt = "2020-01-01T00:00:00.000Z";
    expect(validGuidedApplicationTarget(company, old.target)).toBe(false);
    expect(validGuidedApplicationTarget(company, old.submissions[0].target)).toBe(false);
    const current = guidedApplicationHistory(company).cycles[0];
    expect(current.title).toBe("회차 정정");
    expect(current.submissions[0]).toMatchObject({ version: 2, occurredOn: "2026-09-03" });
    expect(validGuidedApplicationTarget(company, current.submissions[0].target)).toBe(true);
  });
  for (const change of ["company", "revision", "cycle", "metadata", "submission", "extra"] as const)
    it(`다른 ${change} 이동 거절`, () => {
      const { company } = fixture();
      const target = guidedApplicationHistory(company).cycles[0].submissions[0].target;
      const changed = {
        ...target,
        ...{
          company: { caseId: randomUUID() },
          revision: { companyRevision: company.revision + 1 },
          cycle: { applicationId: company.applications[1].id },
          metadata: { metadataVersionId: randomUUID() },
          submission: { submissionVersionId: randomUUID() },
          extra: { transmissionAllowed: true },
        }[change],
      };
      expect(validateGuidedWorkflowTarget(company, changed).valid).toBe(false);
    });
  for (const change of [
    "duplicate",
    "missing-cycle",
    "foreign-snapshot",
    "parent",
    "version",
    "format",
  ] as const)
    it(`모호한 ${change} 이력은 이동을 만들지 않는다`, () => {
      const { company } = fixture();
      const target = guidedApplicationHistory(company).cycles[0].submissions[0].target;
      const event = company.applicationEvents.find(isApplicationSubmission)!;
      if (change === "duplicate") company.applicationEvents.push(structuredClone(event));
      if (change === "missing-cycle") company.applications.shift();
      if (change === "foreign-snapshot") event.companySnapshot.caseId = randomUUID();
      if (change === "parent") event.previousVersionId = randomUUID();
      if (change === "version") event.version = 2;
      if (change === "format") event.recordedAt = "bad date";
      expect(guidedApplicationHistory(company).needsInspection).toBe(true);
      expect(validGuidedApplicationTarget(company, target)).toBe(false);
    });
  it("접수 ID가 소실돼도 원래 제출 기록을 자동 고치지 않는다", () => {
    const { company } = fixture();
    const event = company.applicationEvents.find(isApplicationSubmission)!;
    event.receiptRecordId = randomUUID();
    expect(guidedApplicationHistory(company).cycles[0].submissions[0].receipt).toBe(
      "연결한 접수 기록 확인 필요",
    );
    expect(event.receiptRecordId).not.toBeNull();
  });
  it("회차 등록 시각을 마지막 기록에 포함하되 등록만으로 제출 후 단계로 승격하지 않는다", () => {
    const { company } = fixture();
    company.applicationEvents = [];
    company.applications[0].recordedAt = "2026-10-01T00:00:00.000Z";
    company.applications[1].recordedAt = "2026-10-02T00:00:00.000Z";
    expect(deriveGuidedFollowup(company)).toMatchObject({
      lastRecordedAt: "2026-10-02T00:00:00.000Z",
      lastCheckedAt: null,
    });
    company.stage = "preparing";
    expect(deriveGuidedFollowup(company).state).toBe("none");
  });
  it("빈 과거 회사는 새 이력이나 표시를 만들지 않는다", () => {
    const { company } = fixture();
    company.applications = [];
    company.applicationEvents = [];
    expect(guidedApplicationHistory(company)).toEqual({ cycles: [], needsInspection: false });
    expect(
      renderToStaticMarkup(
        createElement(GuidedApplicationHistory, { company, disabled: false, onNavigate: vi.fn() }),
      ),
    ).toBe("");
  });
  it("SSR은 접힌 수동 안내·문자만 표시하고 호출/전송하지 않는다", () => {
    const { company } = fixture();
    company.applications[0].title = '<img src="https://example.invalid/private">';
    const before = JSON.stringify(company),
      navigate = vi.fn(),
      network = vi.fn();
    vi.stubGlobal("fetch", network);
    try {
      const html = renderToStaticMarkup(
        createElement(GuidedApplicationHistory, { company, disabled: true, onNavigate: navigate }),
      );
      expect(html).toContain("공식 확인 시각 없음");
      expect(html).toContain("실제 미제출을 증명하지 않습니다");
      expect(html).not.toMatch(/<img|href=|<script|<details[^>]* open/);
      expect(html).toContain("&lt;img");
      expect(html).toContain("disabled");
      expect(navigate).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(JSON.stringify(company)).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("상세 이력의 최신 기록과 과거 이력이 함께 있어도 이동 ID는 하나다", () => {
    const { company } = fixture();
    const id = company.applicationEvents.find(isApplicationSubmission)!.id;
    const html = renderToStaticMarkup(
      createElement(ApplicationHistory, {
        company,
        blockedReason: "",
        onDirtyChange: vi.fn(),
        mutate: vi.fn(),
      }),
    );
    expect(html.split(`id="application-submission-${id}"`).length - 1).toBe(1);
  });
});
