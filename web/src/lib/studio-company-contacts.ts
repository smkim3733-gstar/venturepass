// Server-owned append-only metadata. No file, external AI, messaging, or portal access.
import { createHash } from "node:crypto";
import { StudioError } from "./studio-http";
import {
  appendCompanyContactsMutationSchema,
  companyContactsInputSchema,
  companyContactsLimits,
  companyContactsRecordSchema,
  type CompanyContactsInput,
  type CompanyContactsMutation,
  type CompanyContactsRecord,
} from "./studio-company-contacts-types";

export function companyContactsInputDigest(raw: CompanyContactsInput): string {
  const input = companyContactsInputSchema.parse(raw);
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
export function assertCompanyContactsCapacity(records: CompanyContactsRecord[]) {
  const count = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, item) => sum + count(item), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
          : 0;
  if (
    records.length > companyContactsLimits.records ||
    count(records) > companyContactsLimits.characters
  )
    throw new StudioError(
      "기업 연락 메모 보관 한도에 도달했습니다. 과거 버전은 보존하고 새 기록은 저장하지 않았습니다.",
      409,
      "COMPANY_CONTACTS_LIMIT",
    );
}
export function isCompanyContactsReplay(
  records: CompanyContactsRecord[],
  clientRequestId: string,
  inputDigest: string,
): boolean {
  const matches = records.filter((record) => record.clientRequestId === clientRequestId);
  if (!matches.length) return false;
  if (matches.length !== 1 || matches[0].inputDigest !== inputDigest)
    throw new StudioError(
      "같은 저장 요청의 연락 메모 내용이 다릅니다. 최신 내용을 확인해 주세요.",
      409,
      "COMPANY_CONTACTS_REQUEST_CONFLICT",
    );
  return true;
}
export function buildCompanyContacts(
  records: CompanyContactsRecord[],
  raw: CompanyContactsMutation,
  generated: { id: string; recordedAt: string },
): CompanyContactsRecord {
  const input = appendCompanyContactsMutationSchema.parse(raw);
  const previous = records.at(-1);
  if ((previous?.id ?? null) !== input.previousVersionId)
    throw new StudioError(
      "기업 연락 메모의 최신 버전이 변경되었습니다. 다시 불러와 주세요.",
      409,
      "COMPANY_CONTACTS_VERSION_STALE",
    );
  if (records.length >= companyContactsLimits.records)
    throw new StudioError(
      "기업 연락 메모 보관 한도에 도달했습니다. 과거 버전은 보존합니다.",
      409,
      "COMPANY_CONTACTS_LIMIT",
    );
  const payload = { previousVersionId: input.previousVersionId, contacts: input.contacts };
  const record = companyContactsRecordSchema.parse({
    ...generated,
    ...payload,
    clientRequestId: input.clientRequestId,
    inputDigest: companyContactsInputDigest(payload),
    version: (previous?.version ?? 0) + 1,
    origin: "manual",
  });
  assertCompanyContactsCapacity([...records, record]);
  return record;
}
