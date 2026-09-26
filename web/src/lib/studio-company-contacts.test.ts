import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendCompanyContactsMutationSchema,
  companyContactsFieldsSchema,
  companyContactsInputSchema,
  emptyCompanyContacts,
  latestCompanyContacts,
  type CompanyContactsRecord,
} from "./studio-company-contacts-types";
import {
  assertCompanyContactsCapacity,
  buildCompanyContacts,
  companyContactsInputDigest,
  isCompanyContactsReplay,
} from "./studio-company-contacts";

const now = "2026-09-25T12:00:00.000Z";
function input() {
  return appendCompanyContactsMutationSchema.parse({
    action: "append-company-contacts",
    revision: 0,
    clientRequestId: randomUUID(),
    previousVersionId: null,
    contacts: {
      ...emptyCompanyContacts(),
      address: "가상 소재지",
      companyContact: "합성 연락 메모",
      note: "현재 연락 가능 여부 미확인",
    },
  });
}
const metadata = () => ({ id: randomUUID(), recordedAt: now });
describe("분리된 기업 연락 메모 계약", () => {
  it("legacy absence is no record and creates no inferred contact", () => {
    expect(latestCompanyContacts({})).toBeNull();
    expect(Object.values(emptyCompanyContacts()).every((value) => value === "")).toBe(true);
  });
  it("trims edges only and preserves user spelling instead of validating a recipient", () => {
    const contacts = companyContactsFieldsSchema.parse({
      ...emptyCompanyContacts(),
      companyContact: "  문의 예정\n연락처 형식 미확인 +82 (0) 000  \n",
    });
    expect(contacts.companyContact).toBe("문의 예정\n연락처 형식 미확인 +82 (0) 000");
  });
  it.each([
    "address",
    "representativeContact",
    "companyContact",
    "materialsOwner",
    "finalReviewOwner",
    "paymentOwner",
    "note",
  ] as const)("enforces %s cap without truncating", (field) => {
    const cap = field === "note" ? 2000 : field.endsWith("Owner") ? 100 : 500;
    expect(
      companyContactsFieldsSchema.safeParse({ ...emptyCompanyContacts(), [field]: "x".repeat(cap) })
        .success,
    ).toBe(true);
    expect(
      companyContactsFieldsSchema.safeParse({
        ...emptyCompanyContacts(),
        [field]: "x".repeat(cap + 1),
      }).success,
    ).toBe(false);
  });
  it.each(["id", "recordedAt", "origin", "version", "inputDigest", "companyId"])(
    "rejects server property %s in mutation",
    (key) => {
      expect(
        appendCompanyContactsMutationSchema.safeParse({ ...input(), [key]: "forged" }).success,
      ).toBe(false);
    },
  );
  it("rejects unknown field and omitted fields while accepting all blank", () => {
    expect(
      companyContactsFieldsSchema.safeParse({ ...emptyCompanyContacts(), permission: "admin" })
        .success,
    ).toBe(false);
    expect(companyContactsFieldsSchema.safeParse({}).success).toBe(false);
    expect(
      companyContactsInputSchema.safeParse({
        previousVersionId: null,
        contacts: emptyCompanyContacts(),
      }).success,
    ).toBe(true);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revision %s", (revision) => {
    expect(appendCompanyContactsMutationSchema.safeParse({ ...input(), revision }).success).toBe(
      false,
    );
  });
  it("creates server metadata without mutating records or input", () => {
    const raw = input(),
      before = structuredClone(raw),
      records: CompanyContactsRecord[] = [];
    const generated = metadata();
    const result = buildCompanyContacts(records, raw, generated);
    expect(result).toMatchObject({
      ...generated,
      version: 1,
      previousVersionId: null,
      origin: "manual",
      contacts: raw.contacts,
    });
    expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(records).toEqual([]);
    expect(raw).toEqual(before);
  });
  it("appends blank correction and preserves older values", () => {
    const first = buildCompanyContacts([], input(), metadata());
    const before = structuredClone(first);
    const second = buildCompanyContacts(
      [first],
      { ...input(), previousVersionId: first.id, contacts: emptyCompanyContacts() },
      metadata(),
    );
    expect(second.version).toBe(2);
    expect(second.previousVersionId).toBe(first.id);
    expect(second.contacts).toEqual(emptyCompanyContacts());
    expect(first).toEqual(before);
    expect(latestCompanyContacts({ companyContacts: [first, second] })).toEqual(second);
  });
  it("rejects stale and foreign previous version", () => {
    const first = buildCompanyContacts([], input(), metadata());
    for (const previousVersionId of [null, randomUUID()])
      expect(() =>
        buildCompanyContacts([first], { ...input(), previousVersionId }, metadata()),
      ).toThrow(expect.objectContaining({ code: "COMPANY_CONTACTS_VERSION_STALE" }));
    expect(() =>
      buildCompanyContacts([], { ...input(), previousVersionId: first.id }, metadata()),
    ).toThrow(expect.objectContaining({ code: "COMPANY_CONTACTS_VERSION_STALE" }));
  });
  it("canonical whitespace and key order yield the same payload digest", () => {
    const raw = input();
    const payload = { previousVersionId: raw.previousVersionId, contacts: raw.contacts };
    const other = {
      contacts: Object.fromEntries(
        Object.entries(raw.contacts)
          .reverse()
          .map(([key, value]) => [key, `  ${value}  `]),
      ),
      previousVersionId: null,
    };
    expect(companyContactsInputDigest(companyContactsInputSchema.parse(other))).toBe(
      companyContactsInputDigest(payload),
    );
  });
  it("same nonce and same payload is replay; changed payload and duplicate nonce fail", () => {
    const raw = input(),
      first = buildCompanyContacts([], raw, metadata());
    expect(isCompanyContactsReplay([first], raw.clientRequestId, first.inputDigest)).toBe(true);
    expect(isCompanyContactsReplay([first], randomUUID(), first.inputDigest)).toBe(false);
    expect(() => isCompanyContactsReplay([first], raw.clientRequestId, "f".repeat(64))).toThrow(
      expect.objectContaining({ code: "COMPANY_CONTACTS_REQUEST_CONFLICT" }),
    );
    expect(() =>
      isCompanyContactsReplay(
        [first, structuredClone(first)],
        raw.clientRequestId,
        first.inputDigest,
      ),
    ).toThrow(expect.objectContaining({ code: "COMPANY_CONTACTS_REQUEST_CONFLICT" }));
  });
  it("refuses record cap and aggregate text cap without removing history", () => {
    const first = buildCompanyContacts([], input(), metadata());
    const records = Array.from({ length: 100 }, (_, i) => ({
      ...first,
      id: randomUUID(),
      version: i + 1,
    }));
    expect(() =>
      buildCompanyContacts(
        records,
        { ...input(), previousVersionId: records.at(-1)!.id },
        metadata(),
      ),
    ).toThrow(expect.objectContaining({ code: "COMPANY_CONTACTS_LIMIT" }));
    expect(records).toHaveLength(100);
    const full = Array.from({ length: 60 }, () => ({
      ...first,
      contacts: {
        address: "x".repeat(500),
        representativeContact: "x".repeat(500),
        companyContact: "x".repeat(500),
        materialsOwner: "x".repeat(100),
        finalReviewOwner: "x".repeat(100),
        paymentOwner: "x".repeat(100),
        note: "x".repeat(2000),
      },
    }));
    expect(() => assertCompanyContactsCapacity(full)).toThrow(
      expect.objectContaining({ code: "COMPANY_CONTACTS_LIMIT" }),
    );
    expect(full).toHaveLength(60);
  });
});
