import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile, type StudioCase } from "@/lib/studio-schema";
import {
  emptyCompanyContacts,
  type CompanyContactsRecord,
} from "@/lib/studio-company-contacts-types";
import {
  CompanyContacts,
  CompanyContactsFieldsEditor,
  CompanyContactsRecordView,
  companyContactsEditorInput,
  companyContactsSaveAcknowledged,
} from "./company-contacts";
import { ProfileEditor } from "./profile-editor";

const companyId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const nonce = "33333333-3333-4333-8333-333333333333";
const priorId = "44444444-4444-4444-8444-444444444444";
const now = "2026-09-25T00:00:00.000Z";
function company(overrides: Partial<StudioCase> = {}): StudioCase {
  return caseSchema.parse({
    id: companyId,
    revision: 2,
    createdAt: now,
    updatedAt: now,
    profile: {
      ...emptyProfile(),
      companyName: "가상 연락 기업",
      team: "기술 설명의 담당자를 연락처로 복사하지 않음",
    },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    plans: [],
    tasks: [],
    stage: "preparing",
    ...overrides,
  });
}
function record(overrides: Partial<CompanyContactsRecord> = {}): CompanyContactsRecord {
  return {
    id: recordId,
    version: 1,
    previousVersionId: null,
    clientRequestId: nonce,
    inputDigest: "a".repeat(64),
    origin: "manual",
    recordedAt: now,
    contacts: {
      ...emptyCompanyContacts(),
      address: "가상 소재지",
      representativeContact: "sample@example.invalid",
      paymentOwner: "가상 납부 담당자",
    },
    ...overrides,
  };
}
function panel(value = company(), blockedReason = "") {
  const mutate = vi.fn(),
    onDirtyChange = vi.fn();
  return {
    html: renderToStaticMarkup(
      createElement(CompanyContacts, { company: value, mutate, blockedReason, onDirtyChange }),
    ),
    mutate,
    onDirtyChange,
  };
}

describe("operational contact editor snapshots and acknowledgements", () => {
  it("starts unknown and copies only saved contacts, never profile or source data", () => {
    expect(companyContactsEditorInput(null)).toEqual({
      previousVersionId: null,
      contacts: emptyCompanyContacts(),
    });
    const previous = record();
    const input = companyContactsEditorInput(previous);
    expect(input.previousVersionId).toBe(previous.id);
    input.contacts.address = "새 주소";
    expect(previous.contacts.address).toBe("가상 소재지");
  });
  it("acknowledges first record with normalized input and exact nonce", () => {
    const input = {
      previousVersionId: null,
      contacts: { ...record().contacts, address: "  가상 소재지  " },
    };
    expect(
      companyContactsSaveAcknowledged(
        company({ revision: 3, companyContacts: [record()] }),
        company(),
        nonce,
        input,
      ),
    ).toBe(true);
  });
  it("acknowledges a correction only against the exact prior version", () => {
    const previous = record({ id: priorId, clientRequestId: priorId, version: 3 });
    const input = companyContactsEditorInput(previous);
    input.contacts.paymentOwner = "";
    const next = record({ version: 4, previousVersionId: priorId, contacts: input.contacts });
    expect(
      companyContactsSaveAcknowledged(
        company({ revision: 3, companyContacts: [previous, next] }),
        company({ companyContacts: [previous] }),
        nonce,
        input,
      ),
    ).toBe(true);
  });
  it("rejects another company, regressed revision and no result", () => {
    const input = { previousVersionId: null, contacts: record().contacts };
    for (const response of [
      null,
      company({ id: nonce, companyContacts: [record()] }),
      company({ revision: 1, companyContacts: [record()] }),
    ]) {
      expect(companyContactsSaveAcknowledged(response, company(), nonce, input)).toBe(false);
    }
  });
  it("rejects missing and duplicate nonce receipts", () => {
    const input = { previousVersionId: null, contacts: record().contacts };
    for (const records of [
      [],
      [record({ clientRequestId: priorId })],
      [record(), record({ id: priorId })],
    ]) {
      expect(
        companyContactsSaveAcknowledged(
          company({ companyContacts: records }),
          company(),
          nonce,
          input,
        ),
      ).toBe(false);
    }
  });
  it.each([
    { previousVersionId: priorId },
    { version: 2 },
    { contacts: { ...record().contacts, address: "다른 내용" } },
    { contacts: { ...record().contacts, paymentOwner: "다른 담당자" } },
  ])("rejects a different persisted payload or parent: %j", (change) => {
    expect(
      companyContactsSaveAcknowledged(
        company({ companyContacts: [record(change)] }),
        company(),
        nonce,
        { previousVersionId: null, contacts: record().contacts },
      ),
    ).toBe(false);
  });
  it("fails closed on malformed stored record or invalid input instead of clearing edits", () => {
    const response = company({ companyContacts: [record()] });
    response.companyContacts[0].origin = "automatic" as "manual";
    expect(
      companyContactsSaveAcknowledged(response, company(), nonce, {
        previousVersionId: null,
        contacts: record().contacts,
      }),
    ).toBe(false);
    expect(
      companyContactsSaveAcknowledged(company({ companyContacts: [record()] }), company(), nonce, {
        previousVersionId: null,
        contacts: { ...record().contacts, address: "x".repeat(501) },
      }),
    ).toBe(false);
  });
});

describe("private contact record UI", () => {
  it("does not infer contacts for legacy companies or render messaging actions", () => {
    const output = panel();
    expect(output.html).toContain("아직 기록한 연락처·신청 담당 역할이 없습니다");
    expect(output.html).not.toContain("기술 설명의 담당자");
    expect(output.html).toContain("기본 분석·원고·진단·제출 준비 묶음에 자동 포함하지 않습니다");
    expect(output.html).toContain("계정 권한·알림 발송 동의·납부 승인·검토 완료가 아닙니다");
    expect(output.html).not.toContain("mailto:");
    expect(output.html).not.toContain("tel:");
    expect(output.mutate).not.toHaveBeenCalled();
  });
  it("retains all seven optional fields, caps and distinct accessible labels", () => {
    const html = renderToStaticMarkup(
      createElement(CompanyContactsFieldsEditor, {
        value: emptyCompanyContacts(),
        onChange: vi.fn(),
      }),
    );
    expect((html.match(/<label/g) ?? []).length).toBe(7);
    expect((html.match(/maxLength="500"/g) ?? []).length).toBe(3);
    expect((html.match(/maxLength="100"/g) ?? []).length).toBe(3);
    expect(html).toContain('maxLength="2000"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('type="tel"');
  });
  it("uses separate field IDs when multiple editors render", () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(CompanyContactsFieldsEditor, {
          value: emptyCompanyContacts(),
          onChange: vi.fn(),
        }),
        createElement(CompanyContactsFieldsEditor, {
          value: emptyCompanyContacts(),
          onChange: vi.fn(),
        }),
      ),
    );
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(14);
  });
  it("marks blanks unknown and escapes manually entered contact strings", () => {
    const html = renderToStaticMarkup(
      createElement(CompanyContactsRecordView, {
        record: record({
          contacts: { ...emptyCompanyContacts(), companyContact: "<script>untrusted()</script>" },
        }),
      }),
    );
    expect((html.match(/<dd[^>]*>미확인<\/dd>/g) ?? []).length).toBe(6);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("담당자 직접 기록 · 연락 가능 여부 미확인");
  });
  it("shows old versions after the latest correction clears values", () => {
    const first = record();
    const second = record({
      id: priorId,
      version: 2,
      previousVersionId: first.id,
      clientRequestId: priorId,
      contacts: emptyCompanyContacts(),
    });
    const html = panel(company({ companyContacts: [first, second] })).html;
    expect(html).toContain("연락처·담당 역할 v2");
    expect(html).toContain("과거 연락 메모 1개 버전");
    expect(html).toContain("가상 납부 담당자");
    expect(html).toContain("미확인");
  });
  it("blocks contact editing while company profile has unsaved changes", () => {
    const output = panel(company(), "기업정보 수정본 먼저 저장");
    expect(output.html).toContain("기업정보 수정본 먼저 저장");
    expect(output.html).toMatch(/<button[^>]*disabled=""[^>]*>연락처·담당 역할 기록<\/button>/);
  });
  it("keeps history and stops new records at the cap", () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      record({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        version: index + 1,
      }),
    );
    const output = panel(company({ companyContacts: records }));
    expect(output.html).toContain("연락 메모 100개 버전 한도");
    expect(output.html).toMatch(/<button[^>]*disabled=""[^>]*>연락 메모 새 버전 작성<\/button>/);
    expect((output.html.match(/<article/g) ?? []).length).toBe(100);
  });
  it("mounts contacts separately from the analysis profile and preserves profile fields", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileEditor, { company: company(), mutate: vi.fn(), setDirty: vi.fn() }),
    );
    expect(html).toContain('id="company-name"');
    expect(html).toContain('id="profile-technologySummary"');
    expect(html).toContain('aria-label="기업 연락처·신청 담당 역할"');
    expect(html).not.toContain('id="profile-companyContact"');
  });
});
