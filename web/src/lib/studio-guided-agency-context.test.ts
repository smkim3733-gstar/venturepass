import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { guidedAgencyApplicationContext as read } from "./studio-guided-agency-context";
import { guidedAgencyContextFixture as fixture } from "./studio-guided-agency-context-test-helpers";
import { currentApplicationLinks } from "./studio-application-types";
import {
  deriveGuidedFollowup,
  validateGuidedWorkflowTarget,
  type GuidedWorkflowTarget,
} from "./studio-guided-followup";
import { GuidedFollowupApplication } from "../components/studio/guided-followup-application";
import { GuidedFollowupStatus } from "../components/studio/guided-followup-status";
const latestLink = (value: ReturnType<typeof fixture>) => currentApplicationLinks(value.company)[0];
function reassign(
  value: ReturnType<typeof fixture>,
  to: string | null,
  recordId = value.request.id,
) {
  const link = latestLink(value);
  value.apply({
    action: "correct-application-agency-link",
    previousLinkEventId: link.id,
    fromApplicationId: link.applicationId,
    toApplicationId: to,
    recordId,
    note: "수동 연결 변경",
  });
}
describe("기관 안내의 현재 수동 귀속·고정 원문 읽기", () => {
  it("현재 안내와 고정 연결의 다른 원문 버전을 그대로 표시한다", () => {
    const f = fixture(),
      before = JSON.stringify(f.company);
    const value = read(f.company, f.target)!;
    expect(value).toMatchObject({
      state: "linked",
      record: { label: "요청 v2", target: { recordVersionId: f.corrected.id } },
      fixedRecord: { label: "요청 v1", target: { recordVersionId: f.request.id } },
    });
    expect(value.application?.target.applicationId).toBe(f.company.applications[0].id);
    expect(validateGuidedWorkflowTarget(f.company, value.application!.target).valid).toBe(true);
    expect(validateGuidedWorkflowTarget(f.company, value.fixedRecord!.target).valid).toBe(true);
    value.application!.title = "변경";
    value.record!.target.recordVersionId = randomUUID();
    expect(JSON.stringify(f.company)).toBe(before);
  });
  it("미지정은 최근 회차로 추정하지 않는다", () => {
    const f = fixture();
    expect(read(f.company, f.noticeTarget)).toMatchObject({
      state: "unassigned",
      application: null,
      fixedRecord: null,
      recordedAt: null,
    });
  });
  it("다른 회차로의 변경과 명시 연결 해제를 구분한다", () => {
    const f = fixture();
    reassign(f, f.company.applications[1].id);
    let value = read(f.company, f.target)!;
    expect(value.application?.target.applicationId).toBe(f.company.applications[1].id);
    expect(value.detail).toContain("다른 회차로 변경");
    expect(value.detail).toContain(f.company.applications[0].title);
    reassign(f, null);
    value = read(f.company, f.target)!;
    expect(value).toMatchObject({ state: "released", application: null });
    expect(value.detail).toContain("연결 해제");
    expect(value.fixedRecord?.target.recordVersionId).toBe(f.request.id);
  });
  it("같은 회차의 명시 최신 원문 연결은 회차 이전으로 오인하지 않는다", () => {
    const f = fixture();
    reassign(f, f.company.applications[0].id, f.corrected.id);
    const value = read(f.company, f.target)!;
    expect(value.fixedRecord?.target).toEqual(value.record?.target);
    expect(value.detail).not.toContain("다른 회차");
  });
  it("날짜가 과거여도 마지막 보관된 귀속 변경을 읽는다", () => {
    const f = fixture();
    reassign(f, f.company.applications[1].id);
    latestLink(f).recordedAt = "2020-01-01T00:00:00.000Z";
    expect(read(f.company, f.target)?.application?.title).toBe(f.company.applications[1].title);
  });
  for (const mode of [
    "duplicate",
    "parent",
    "from",
    "record",
    "missing-cycle",
    "format",
    "wrong-root",
  ] as const)
    it(`모호한 ${mode} 연결은 회차 이동을 제공하지 않는다`, () => {
      const f = fixture();
      reassign(f, f.company.applications[1].id);
      const link = latestLink(f);
      if (mode === "duplicate") f.company.applicationEvents.push(structuredClone(link));
      if (mode === "parent") link.previousLinkEventId = randomUUID();
      if (mode === "from") link.fromApplicationId = null;
      if (mode === "record") link.recordVersionId = f.notice.id;
      if (mode === "missing-cycle") f.company.applications.shift();
      if (mode === "format") link.recordedAt = "bad date";
      if (mode === "wrong-root") link.chainRootId = f.notice.id;
      expect(read(f.company, f.target)).toMatchObject({
        state: "unknown",
        application: null,
        fixedRecord: null,
      });
    });
  it("최초 연결의 부모·출발 회차와 null 목적지를 거절한다", () => {
    for (const change of [
      { previousLinkEventId: randomUUID() },
      { fromApplicationId: randomUUID() },
      { applicationId: null },
    ]) {
      const f = fixture();
      Object.assign(latestLink(f), change);
      expect(read(f.company, f.target)?.state).toBe("unknown");
    }
  });
  for (const mode of ["company", "revision", "root", "record", "extra"] as const)
    it(`원문 이동의 ${mode} 변경은 거절한다`, () => {
      const f = fixture(),
        target = read(f.company, f.target)!.fixedRecord!.target;
      const changed = {
        ...target,
        ...{
          company: { caseId: randomUUID() },
          revision: { companyRevision: 99 },
          root: { chainRootId: f.notice.id },
          record: { recordVersionId: f.notice.id },
          extra: { confirmed: true },
        }[mode],
      };
      expect(validateGuidedWorkflowTarget(f.company, changed).valid).toBe(false);
    });
  it("원문 체인이 훼손되면 옛 버전도 이동 근거가 되지 않는다", () => {
    const f = fixture(),
      target = read(f.company, f.target)!.fixedRecord!.target;
    f.corrected.previousVersionId = randomUUID();
    expect(validateGuidedWorkflowTarget(f.company, target).valid).toBe(false);
    expect(read(f.company, f.target)?.state).toBe("unknown");
  });
  it("업무의 원래 요청 버전은 현재 요청으로 교체하지 않는다", () => {
    const f = fixture(),
      id = randomUUID();
    f.company.tasks.push({
      id,
      title: "합성 원문 업무",
      category: "supplement",
      dueDate: "",
      status: "pending",
      notes: "",
      agencyOrigin: { requestRecordId: f.request.id, requestVersionId: f.request.id },
    });
    const target: GuidedWorkflowTarget = {
      kind: "task",
      taskId: id,
      caseId: f.company.id,
      companyRevision: f.company.revision,
    };
    expect(read(f.company, target)?.record?.label).toBe("요청 v1");
    delete f.company.tasks[0].agencyOrigin;
    expect(read(f.company, target)).toBeNull();
  });
  it("확인서 업무는 원래 유효기간·버전의 출처를 대조한다", () => {
    const f = fixture();
    f.notice.details = {
      category: "certificate",
      certificateNumber: "합성 번호",
      issuedOn: "2026-10-01",
      validFrom: "2026-10-01",
      validUntil: "2027-10-01",
      statusText: "수동",
    };
    const id = randomUUID();
    f.company.tasks.push({
      id,
      title: "합성 확인서 업무",
      category: "other",
      dueDate: "",
      status: "pending",
      notes: "",
      certificateOrigin: {
        noticeRecordId: f.notice.id,
        noticeVersionId: f.notice.id,
        category: "certificate",
        validUntil: "2027-10-01",
        preparationOn: "2027-09-01",
      },
    });
    const target: GuidedWorkflowTarget = {
      kind: "task",
      taskId: id,
      caseId: f.company.id,
      companyRevision: f.company.revision,
    };
    expect(read(f.company, target)?.state).toBe("unassigned");
    f.company.tasks[0].certificateOrigin!.validUntil = "2028-10-01";
    expect(read(f.company, target)?.state).toBe("unknown");
  });
  it("회차 제목 정정과 현재 revision이 이전 이동을 무효화한다", () => {
    const f = fixture(),
      target = read(f.company, f.target)!.application!.target;
    f.apply({
      action: "correct-application",
      applicationId: target.applicationId,
      previousVersionId: target.metadataVersionId,
      title: "수동 회차명 정정",
      kind: "new",
      plannedOn: "",
      criteriaNote: "",
      previousApplicationId: null,
    });
    expect(validateGuidedWorkflowTarget(f.company, target).valid).toBe(false);
    expect(read(f.company, f.target)?.application?.title).toBe("수동 회차명 정정");
    f.company.revision++;
    expect(read(f.company, f.target)?.state).toBe("unknown");
  });
  it("표시 조회는 후속 행동·기한·확인 시각을 바꾸지 않는다", () => {
    const f = fixture(),
      before = deriveGuidedFollowup(f.company),
      bytes = JSON.stringify(f.company);
    for (const item of before.items) read(f.company, item.target);
    expect(deriveGuidedFollowup(f.company)).toEqual(before);
    expect(before.lastCheckedAt).toBeNull();
    expect(JSON.stringify(f.company)).toBe(bytes);
  });
  it("회차 연결 제목·버전은 펼친 상세의 비활성 문자이며 SSR 전송·이동은 없다", () => {
    const f = fixture();
    f.company.applications[0].title = '<img src="https://example.invalid/">';
    const navigate = vi.fn(),
      network = vi.fn();
    vi.stubGlobal("fetch", network);
    try {
      const html = renderToStaticMarkup(
        createElement(GuidedFollowupApplication, {
          value: read(f.company, f.target),
          disabled: true,
          onNavigate: navigate,
        }),
      );
      expect(html).toContain("&lt;img");
      expect(html).toContain("요청 v1");
      expect(html).toContain("요청 v2");
      expect(html).not.toMatch(/<img|href=|<script|<details[^>]* open/);
      expect(html.match(/disabled/g)).toHaveLength(3);
      expect(network).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("간단 원문 안내의 주 항목과 다른 항목에 현재 회차를 표시한다", () => {
    const f = fixture(),
      summary = deriveGuidedFollowup(f.company);
    const html = renderToStaticMarkup(
      createElement(GuidedFollowupStatus, {
        company: f.company,
        stage: f.company.stage,
        summary,
        disabled: false,
        onNavigate: vi.fn(),
      }),
    );
    expect(html).toContain(`신청 회차: ${f.company.applications[0].title}`);
    expect(html).toContain("신청 회차 미지정");
    expect(html).toContain("공식 사이트 자동 조회 미연결");
  });
});
