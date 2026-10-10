import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  companyContactsRecordSchema,
  companyContactsInputSchema,
  emptyCompanyContacts,
  type CompanyContactsMutation,
} from "../../src/lib/studio-company-contacts-types";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
export { agencyId };
export function contactsReceiptFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 연락 메모 저장 기업";
  const prior = companyContactsRecordSchema.parse({
    id: agencyId(80),
    version: 1,
    previousVersionId: null,
    clientRequestId: agencyId(81),
    inputDigest: "a".repeat(64),
    origin: "manual",
    recordedAt: "2026-10-10T00:00:00.000Z",
    contacts: {
      ...emptyCompanyContacts(),
      address: "원래 소재지",
      paymentOwner: "원래 납부 담당",
      note: "이전 연락 메모 보존",
    },
  });
  company.companyContacts = [prior];
  const rawContacts = {
    address: "  합성 소재지\n둘째 줄  ",
    representativeContact: "  대표 연락 메모\nexample.invalid  ",
    companyContact: "  기업 연락 메모  ",
    materialsOwner: "  새 자료 담당  ",
    finalReviewOwner: "  새 확인 담당  ",
    paymentOwner: "  새 납부 담당  ",
    note: "  설명 수정 이유\n둘째 줄  ",
  };
  const input = companyContactsInputSchema.parse({
    previousVersionId: prior.id,
    contacts: rawContacts,
  });
  const request: CompanyContactsMutation = {
    action: "append-company-contacts",
    revision: company.revision,
    clientRequestId: agencyId(82),
    ...input,
  };
  return {
    company: caseSchema.parse(company),
    rawContacts,
    request,
    saved: contactsReceiptResult(company, request),
  };
}
export function contactsReceiptResult(
  base: StudioCase,
  request: CompanyContactsMutation,
  id = agencyId(90),
) {
  const saved = structuredClone(base),
    prior = base.companyContacts.at(-1);
  saved.companyContacts.push(
    companyContactsRecordSchema.parse({
      id,
      version: (prior?.version ?? 0) + 1,
      previousVersionId: request.previousVersionId,
      contacts: request.contacts,
      clientRequestId: request.clientRequestId,
      inputDigest: "b".repeat(64),
      origin: "manual",
      recordedAt: "2026-10-10T12:09:00.000Z",
    }),
  );
  saved.revision++;
  return caseSchema.parse(saved);
}
