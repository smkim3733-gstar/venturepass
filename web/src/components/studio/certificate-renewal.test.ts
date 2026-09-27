import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import type { AgencyNoticeRecord } from "@/lib/studio-agency-records";
import type { GuidedWorkflowTarget } from "@/lib/studio-guided-followup";
import type {
  CertificateTask,
  CreateCertificateTask,
} from "@/lib/studio-certificate-renewal-types";
import {
  CertificateRenewal,
  CertificateTaskReference,
  certificateTaskAcknowledged,
  guidedCertificateNotice,
} from "./certificate-renewal";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const now = "2026-09-25T00:00:00.000Z";
function notice(overrides: Partial<AgencyNoticeRecord> = {}): AgencyNoticeRecord {
  return {
    id: uuid(2),
    noticeRecordId: uuid(2),
    previousVersionId: null,
    version: 1,
    clientRequestId: uuid(3),
    inputDigest: "a".repeat(64),
    kind: "notice",
    origin: "manual",
    recordedAt: now,
    institution: "합성기관",
    title: "합성 확인서",
    body: "확인할 통보 <script>sample()</script>",
    occurredOn: "",
    note: "",
    evidence: [],
    details: {
      category: "certificate",
      certificateNumber: "synthetic-number",
      issuedOn: "",
      validFrom: "",
      validUntil: "2028-09-24",
      statusText: "취소 여부 확인 필요",
    },
    ...overrides,
  };
}
function company(records = [notice()]): StudioCase {
  return caseSchema.parse({
    id: uuid(1),
    profile: { ...emptyProfile(), companyName: "합성기업" },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    agencyRecords: records,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}
function task(): CertificateTask {
  return {
    id: uuid(4),
    title: "합성 준비 업무",
    category: "other",
    status: "pending",
    dueDate: "2028-08-01",
    notes: "",
    certificateOrigin: {
      noticeRecordId: uuid(2),
      noticeVersionId: uuid(2),
      category: "certificate",
      validUntil: "2028-09-24",
      preparationOn: "2028-08-01",
    },
  };
}
const input: Omit<CreateCertificateTask, "revision"> = {
  action: "create-certificate-task",
  noticeRecordId: uuid(2),
  noticeVersionId: uuid(2),
  preparationOn: "2028-08-01",
};
const render = (c: StudioCase, blockedReason = "") =>
  renderToStaticMarkup(
    createElement(CertificateRenewal, {
      company: c,
      mutate: vi.fn(),
      blockedReason,
      onDirtyChange: vi.fn(),
    }),
  );

describe("확인서·차기 준비 UI", () => {
  it("keeps unknown certificate dates explicit and requires a user-selected task date", () => {
    const html = render(company());
    expect(html).toContain("시작일 미확인");
    expect(html).toContain("2028-09-24");
    expect(html).toContain("준비일 직접 정해 업무 연결");
    expect(html).toContain("법정 갱신기한을 계산하거나 자동 입력하지 않습니다");
    expect(html).toContain("진위·현재 효력·취소 여부를 자동 판단하지 않습니다");
    expect(html).toContain("취소 여부 확인 필요");
    expect(html).not.toContain('value="2028-09-24"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("does not create a task or imply certificate verification by rendering", () => {
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CertificateRenewal, {
        company: company([]),
        mutate,
        blockedReason: "",
        onDirtyChange: vi.fn(),
      }),
    );
    expect(html).toContain("최신 분류가 ‘확인서 관련 통보’인 기록이 없습니다");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("blocks task entry when another form is dirty", () => {
    const html = render(company(), "다른 편집을 먼저 저장해 주세요.");
    expect(html).toContain("다른 편집을 먼저 저장");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>준비일 직접 정해 업무 연결/);
  });
  it("shows a linked task's edited date and completion without creating another task", () => {
    const c = company();
    const saved = task();
    saved.dueDate = "2028-07-01";
    saved.status = "done";
    c.tasks.push(saved);
    const html = render(c);
    expect(html).toContain("이 통보 버전의 준비 업무가 있습니다");
    expect(html).toContain("현재 업무 날짜: 2028-07-01");
    expect(html).toContain("담당자 표시 완료");
    expect(html).toContain("최초 사용자 준비일: 2028-08-01");
    expect(html).not.toContain("준비일 직접 정해 업무 연결");
    expect(html).toContain(`#workflow-task-${saved.id}`);
  });
  it("keeps older completed tasks visible after a non-certificate correction", () => {
    const c = company([
      notice(),
      notice({
        id: uuid(5),
        kind: "notice-correction",
        previousVersionId: uuid(2),
        version: 2,
        details: { category: "decision", decisionText: "추가 확인", notifiedOn: "", reasons: "" },
      }),
    ]);
    const saved = task();
    saved.status = "done";
    c.tasks.push(saved);
    const html = render(c);
    expect(html).not.toContain("준비일 직접 정해 업무 연결");
    expect(html).toContain("기존 업무 날짜·완료 상태는 보존");
    expect(html).toContain("담당자 표시 완료");
    expect(html).toContain("2028-08-01");
  });
  it("does not silently substitute a missing notice link", () => {
    const html = renderToStaticMarkup(
      createElement(CertificateTaskReference, { company: company([]), task: task() }),
    );
    expect(html).toContain("고유하게 찾지 못했습니다");
    expect(html).toContain("다른 기록으로 대체하지 않습니다");
    expect(html).not.toContain("href=");
  });
  it("has no certificate reference for a legacy unlinked task", () => {
    const saved = task();
    delete saved.certificateOrigin;
    expect(
      renderToStaticMarkup(
        createElement(CertificateTaskReference, { company: company(), task: saved }),
      ),
    ).toBe("");
  });
});

describe("확인서 업무 응답 확인", () => {
  it("acknowledges the exact original binding while preserving later task edits", () => {
    const c = company();
    const saved = task();
    saved.dueDate = "";
    saved.status = "done";
    c.tasks.push(saved);
    expect(certificateTaskAcknowledged(c, c.id, input, "2028-09-24")).toBe(true);
    expect(certificateTaskAcknowledged(null, c.id, input, "2028-09-24")).toBe(false);
    expect(certificateTaskAcknowledged(c, uuid(99), input, "2028-09-24")).toBe(false);
    c.tasks.push({ ...saved, id: uuid(10) });
    expect(certificateTaskAcknowledged(c, c.id, input, "2028-09-24")).toBe(false);
  });
  it.each(["noticeRecordId", "noticeVersionId", "preparationOn", "validUntil"] as const)(
    "does not accept changed %s",
    (field) => {
      const c = company();
      const saved = task();
      saved.certificateOrigin![field] = field.endsWith("Id") ? uuid(99) : "2028-01-01";
      c.tasks.push(saved);
      expect(certificateTaskAcknowledged(c, c.id, input, "2028-09-24")).toBe(false);
    },
  );
});

describe("기본 안내에서 확인서 준비 연결", () => {
  const destination = (c: StudioCase): GuidedWorkflowTarget => ({
    caseId: c.id,
    companyRevision: c.revision,
    kind: "certificate",
    noticeRecordId: uuid(2),
    noticeVersionId: uuid(2),
  });
  function guided(c: StudioCase, target = destination(c), blockedReason = "") {
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CertificateRenewal, {
        company: c,
        mutate,
        blockedReason,
        onDirtyChange: vi.fn(),
        guidedTarget: target,
      }),
    );
    expect(mutate).not.toHaveBeenCalled();
    return html;
  }
  it("opens a blank preparation date without setting a date or creating a task", () => {
    const c = company();
    const before = JSON.stringify(c);
    const html = guided(c);
    expect(html).toContain("사용자가 정하는 차기 준비일");
    expect(html).toMatch(/type="date"[^>]*value=""/);
    expect(html).toContain(`id="certificate-notice-${uuid(2)}"`);
    expect(JSON.stringify(c)).toBe(before);
  });
  it("shows existing exact linked task instead of another creation form", () => {
    const c = company();
    c.tasks.push(task());
    const html = guided(c);
    expect(html).not.toContain("사용자가 정하는 차기 준비일");
    expect(html).toContain(`#workflow-task-${uuid(4)}`);
    expect(c.tasks).toHaveLength(1);
  });
  it("does not substitute an older certificate after a decision correction", () => {
    const c = company([
      notice(),
      notice({
        id: uuid(5),
        kind: "notice-correction",
        previousVersionId: uuid(2),
        version: 2,
        details: { category: "decision", decisionText: "추가 확인", notifiedOn: "", reasons: "" },
      }),
    ]);
    c.tasks.push({ ...task(), status: "done" });
    expect(guidedCertificateNotice(c, destination(c))).toBeNull();
    const html = guided(c);
    expect(html).not.toContain("사용자가 정하는 차기 준비일");
    expect(html).toContain("다른 통보로 바꾸지 않습니다");
    expect(html).toContain("담당자 표시 완료");
  });
  it.each(["case", "revision", "version"])(
    "rejects mismatched %s without changing dates",
    (field) => {
      const c = company();
      const target = destination(c);
      if (field === "case") target.caseId = uuid(99);
      if (field === "revision") target.companyRevision += 1;
      if (field === "version" && target.kind === "certificate") target.noticeVersionId = uuid(99);
      expect(guidedCertificateNotice(c, target)).toBeNull();
      expect(guided(c, target)).not.toContain("사용자가 정하는 차기 준비일");
    },
  );
  it("does not open over dirty sibling work or after the task limit", () => {
    const c = company();
    expect(guided(c, destination(c), "다른 편집을 먼저 저장")).not.toContain(
      "사용자가 정하는 차기 준비일",
    );
    c.tasks = Array.from({ length: 200 }, (_, n) => ({
      ...task(),
      id: uuid(n + 100),
      certificateOrigin: undefined,
    }));
    expect(guided(c)).not.toContain("사용자가 정하는 차기 준비일");
  });
});
