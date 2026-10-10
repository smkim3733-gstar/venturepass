import { describe, it, expect } from "vitest";
import { companyContactsSaveAcknowledged } from "./company-contacts";
import {
  contactsReceiptFixture,
  contactsReceiptResult,
  agencyId,
} from "../../../scripts/fixtures/contacts-receipt";
import { emptyCompanyContacts } from "@/lib/studio-company-contacts-types";
type Fixture = ReturnType<typeof contactsReceiptFixture>;
const check = (f: Fixture) =>
  companyContactsSaveAcknowledged(f.saved, f.company, f.request.clientRequestId, {
    previousVersionId: f.request.previousVersionId,
    contacts: f.request.contacts,
  });
describe("contact response history and company boundary", () => {
  it("accepts exact correction preserving prior notes, all other state, and raw input", () => {
    const f = contactsReceiptFixture(),
      copy = structuredClone(f);
    expect(check(f)).toBe(true);
    expect(f).toEqual(copy);
  });
  it("accepts first record and explicit blank correction without copying earlier values", () => {
    const f = contactsReceiptFixture();
    f.company.companyContacts = [];
    f.request.previousVersionId = null;
    f.saved = contactsReceiptResult(f.company, f.request);
    expect(check(f)).toBe(true);
    f.company = structuredClone(f.saved);
    f.request = {
      ...f.request,
      revision: f.company.revision,
      clientRequestId: agencyId(91),
      previousVersionId: f.company.companyContacts[0].id,
      contacts: emptyCompanyContacts(),
    };
    f.saved = contactsReceiptResult(f.company, f.request, agencyId(92));
    expect(check(f)).toBe(true);
    expect(f.saved.companyContacts[0].contacts.address).toBe("합성 소재지\n둘째 줄");
  });
  const cases: [string, (f: Fixture) => void][] = [
    [
      "missing result",
      (f) => {
        f.saved.companyContacts.pop();
      },
    ],
    [
      "different request",
      (f) => {
        f.saved.companyContacts.at(-1)!.clientRequestId = agencyId(99);
      },
    ],
    [
      "parent",
      (f) => {
        f.saved.companyContacts.at(-1)!.previousVersionId = null;
      },
    ],
    [
      "version",
      (f) => {
        f.saved.companyContacts.at(-1)!.version = 3;
      },
    ],
    [
      "address",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.address = "다른 주소";
      },
    ],
    [
      "representative",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.representativeContact = "다른 연락";
      },
    ],
    [
      "company contact",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.companyContact = "다른 연락";
      },
    ],
    [
      "materials owner",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.materialsOwner = "다른 담당";
      },
    ],
    [
      "review owner",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.finalReviewOwner = "다른 담당";
      },
    ],
    [
      "payment owner",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.paymentOwner = "다른 담당";
      },
    ],
    [
      "note",
      (f) => {
        f.saved.companyContacts.at(-1)!.contacts.note = "다른 설명";
      },
    ],
    [
      "previous record changed",
      (f) => {
        f.saved.companyContacts[0].contacts.note = "옛 기록 변경";
      },
    ],
    [
      "previous record lost",
      (f) => {
        f.saved.companyContacts.shift();
      },
    ],
    [
      "additional later record",
      (f) => {
        f.saved.companyContacts.push({
          ...structuredClone(f.saved.companyContacts.at(-1)!),
          id: agencyId(94),
          version: 3,
          clientRequestId: agencyId(95),
        });
      },
    ],
    [
      "record order",
      (f) => {
        f.saved.companyContacts.reverse();
      },
    ],
    [
      "duplicate id",
      (f) => {
        f.saved.companyContacts.at(-1)!.id = f.saved.companyContacts[0].id;
      },
    ],
    [
      "duplicate version",
      (f) => {
        f.saved.companyContacts.at(-1)!.version = 1;
      },
    ],
    [
      "duplicate request",
      (f) => {
        f.saved.companyContacts[0].clientRequestId = f.request.clientRequestId;
      },
    ],
    [
      "ambiguous original",
      (f) => {
        f.company.companyContacts.push(structuredClone(f.company.companyContacts[0]));
      },
    ],
    [
      "another company",
      (f) => {
        f.saved.id = agencyId(96);
      },
    ],
    [
      "same revision",
      (f) => {
        f.saved.revision = f.company.revision;
      },
    ],
    [
      "old revision",
      (f) => {
        f.saved.revision = f.company.revision - 1;
      },
    ],
    [
      "profile",
      (f) => {
        f.saved.profile.companyName = "다른 회사";
      },
    ],
    [
      "task",
      (f) => {
        f.saved.tasks[0].status = f.saved.tasks[0].status === "done" ? "pending" : "done";
      },
    ],
    [
      "plan",
      (f) => {
        f.saved.plans[0].content.title = "다른 원고";
      },
    ],
    [
      "agency record",
      (f) => {
        f.saved.agencyRecords[0].body = "다른 원문";
      },
    ],
    [
      "stage",
      (f) => {
        f.saved.stage = "preparing";
      },
    ],
    [
      "malformed response",
      (f) => {
        Object.assign(f.saved, { companyContacts: null });
      },
    ],
  ];
  it.each(cases)("rejects %s", (_, alter) => {
    const f = contactsReceiptFixture();
    alter(f);
    expect(check(f)).toBe(false);
  });
});
