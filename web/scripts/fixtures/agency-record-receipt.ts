import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  agencyAppendMutationSchema,
  buildAgencyRecord,
  type AgencyRecordInput,
} from "../../src/lib/studio-agency-records";
import type { AgencyRecordSaveCommand } from "../../src/components/studio/agency-record-response";
import { submissionReadCompany } from "./guided-submission-read";
export const agencyId = (n: number) => `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
export function agencyReceiptCompany() {
  const c = submissionReadCompany();
  c.profile.companyName = "합성 기관 원문 저장 기업";
  return caseSchema.parse(c);
}
export function agencyReceiptResult(
  base: StudioCase,
  value: AgencyRecordSaveCommand,
  id = agencyId(3),
) {
  const input = agencyAppendMutationSchema.parse(value),
    saved = structuredClone(base);
  // Pure in-memory record construction only; no server store or original file is imported.
  saved.agencyRecords.push(
    buildAgencyRecord(base.agencyRecords, input.record, {
      id,
      clientRequestId: input.clientRequestId,
      inputDigest: "a".repeat(64),
      recordedAt: "2026-10-10T09:52:00.000Z",
      evidence: [],
    }),
  );
  saved.revision++;
  return caseSchema.parse(saved);
}
export function agencyReceiptFixture(kind: AgencyRecordInput["kind"] = "request") {
  let company = agencyReceiptCompany();
  const common = {
    title: "  원래 기록 제목  ",
    body: "  원래 원문\n둘째 문장  ",
    occurredOn: "2026-10-10",
    note: "  원래 메모\n유지  ",
    sourceIds: [],
  };
  const request: AgencyRecordSaveCommand = {
    action: "append-agency-record",
    revision: company.revision,
    clientRequestId: agencyId(10),
    record: {
      kind: "request",
      ...common,
      institution: "  합성 기관  ",
      dueOn: "2026-10-20",
      dueNote: "원래 기한 근거",
    },
  };
  if (kind === "notice" || kind === "notice-correction")
    request.record = {
      kind: "notice",
      ...common,
      institution: "합성 기관",
      details: {
        category: "receipt",
        receiptNumber: "원래-번호",
        receivedOn: "2026-10-10",
        statusText: "담당자 기록",
      },
    };
  if (kind === "request-correction" || kind === "response") {
    company = agencyReceiptResult(company, request, agencyId(1));
    request.record =
      kind === "request-correction"
        ? ({
            ...request.record,
            kind,
            requestRecordId: agencyId(1),
            previousVersionId: agencyId(1),
          } as AgencyRecordInput)
        : {
            ...common,
            kind,
            requestRecordId: agencyId(1),
            previousVersionId: null,
            responseStatus: "draft",
          };
  }
  if (kind === "notice-correction")
    request.record = {
      ...request.record,
      kind,
      noticeRecordId: company.agencyRecords[0].id,
      previousVersionId: company.agencyRecords[1].id,
    } as AgencyRecordInput;
  request.revision = company.revision;
  request.clientRequestId = agencyId(11);
  return { company, request, saved: agencyReceiptResult(company, request) };
}
