import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  preparedResponseBody,
  type RegisterPreparedResponse,
  type ResponsePreparation,
} from "../../src/lib/studio-response-preparation-types";
import {
  responseReceiptFixture,
  responseReceiptResult,
  agencyId,
} from "./response-preparation-receipt";
export { agencyId };
// Only synthetic memory records: no storage, original file capture or prepared-response writer.
function draftRecord(
  company: StudioCase,
  preparation: ResponsePreparation,
  id: string,
  nonce: string,
  previousResponseId: string | null,
  version: number,
) {
  const request = company.agencyRecords.find(
    (record) => record.id === preparation.requestVersionId,
  );
  if (!request || (request.kind !== "request" && request.kind !== "request-correction"))
    throw new Error("Expected synthetic request");
  return {
    ...request,
    id,
    clientRequestId: nonce,
    inputDigest: "d".repeat(64),
    recordedAt: "2026-10-12T06:50:00.000Z",
    kind: "response" as const,
    requestRecordId: preparation.requestRecordId,
    requestVersionId: preparation.requestVersionId,
    previousVersionId: previousResponseId,
    version,
    title: preparation.title,
    body: preparedResponseBody(preparation).trim(),
    occurredOn: "",
    dueOn: "",
    dueNote: "",
    note: "로컬 작성 보조에서 등록한 미검토·미발송 답변 초안입니다.",
    responseStatus: "draft" as const,
    evidence: [],
    preparedFrom: {
      preparationId: preparation.preparationId,
      preparationVersionId: preparation.id,
    },
  };
}
export function registrationReceiptFixture() {
  const fixture = responseReceiptFixture();
  const company = responseReceiptResult(fixture.company, fixture.input, agencyId(91));
  company.profile.companyName = "합성 답변 초안 등록 기업";
  if (company.agencyRecords.some((record) => record.kind === "response"))
    throw new Error("Expected no prior synthetic response");
  company.agencyRecords.push(
    draftRecord(company, company.responsePreparations[0], agencyId(100), agencyId(101), null, 1),
  );
  const parsed = caseSchema.parse(company);
  return {
    company: parsed,
    preparation: parsed.responsePreparations.at(-1)!,
    previous: parsed.agencyRecords.at(-1)!,
    body: preparedResponseBody(parsed.responsePreparations.at(-1)!).trim(),
  };
}
export function registrationReceiptResult(base: StudioCase, command: RegisterPreparedResponse) {
  const preparation = base.responsePreparations.find(
    (record) =>
      record.id === command.preparationVersionId && record.preparationId === command.preparationId,
  );
  const previous = base.agencyRecords.find((record) => record.id === command.previousResponseId);
  if (!preparation || !previous || previous.kind !== "response")
    throw new Error("Expected synthetic preparation and previous draft");
  const saved = structuredClone(base);
  saved.agencyRecords.push(
    draftRecord(
      base,
      preparation,
      agencyId(110),
      command.clientRequestId,
      previous.id,
      previous.version + 1,
    ),
  );
  saved.revision++;
  saved.updatedAt = "2026-10-12T06:51:00.000Z";
  return caseSchema.parse(saved);
}
