import { z } from "zod";

// Private operational notes. Deliberately separate from CompanyProfile and evidence inputs.
export const companyContactsLimits = {
  records: 100,
  characters: 200_000,
  requestBytes: 16 * 1024,
} as const;
export const companyContactsLabels = {
  address: "기업 소재지",
  representativeContact: "대표 연락 메모",
  companyContact: "기업 담당 연락 메모",
  materialsOwner: "자료 제공 담당자",
  finalReviewOwner: "최종 내용 확인 담당자",
  paymentOwner: "납부 담당자",
  note: "설명·수정 이유",
} as const;
export const companyContactsFieldsSchema = z
  .object({
    address: z.string().trim().max(500),
    representativeContact: z.string().trim().max(500),
    companyContact: z.string().trim().max(500),
    materialsOwner: z.string().trim().max(100),
    finalReviewOwner: z.string().trim().max(100),
    paymentOwner: z.string().trim().max(100),
    note: z.string().trim().max(2000),
  })
  .strict();
export type CompanyContactsFields = z.infer<typeof companyContactsFieldsSchema>;
export const companyContactsInputSchema = z
  .object({
    previousVersionId: z.string().uuid().nullable(),
    contacts: companyContactsFieldsSchema,
  })
  .strict();
export type CompanyContactsInput = z.infer<typeof companyContactsInputSchema>;
export const appendCompanyContactsMutationSchema = companyContactsInputSchema
  .extend({
    action: z.literal("append-company-contacts"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
  })
  .strict();
export type CompanyContactsMutation = z.infer<typeof appendCompanyContactsMutationSchema>;
export const companyContactsRecordSchema = companyContactsInputSchema
  .extend({
    id: z.string().uuid(),
    version: z.number().int().min(1).max(companyContactsLimits.records),
    clientRequestId: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.literal("manual"),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type CompanyContactsRecord = z.infer<typeof companyContactsRecordSchema>;
export function emptyCompanyContacts(): CompanyContactsFields {
  return {
    address: "",
    representativeContact: "",
    companyContact: "",
    materialsOwner: "",
    finalReviewOwner: "",
    paymentOwner: "",
    note: "",
  };
}
export function latestCompanyContacts(company: {
  companyContacts?: CompanyContactsRecord[];
}): CompanyContactsRecord | null {
  return company.companyContacts?.at(-1) ?? null;
}
