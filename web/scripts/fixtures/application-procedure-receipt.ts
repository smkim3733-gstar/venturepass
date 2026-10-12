import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  applicationMetadata,
  currentApplicationLinks,
} from "../../src/lib/studio-application-types";
import { isAgencyNoticeRecord } from "../../src/lib/studio-agency-records";
import {
  applicationProcedureInputSchema,
  applicationProcedureSchema,
  type ApplicationProcedureInput,
} from "../../src/lib/studio-application-procedure-types";
import { linkReceiptCompany, linkReceiptResult, linkId } from "./application-link-receipt";
export { linkId };
export async function procedureReceiptHash(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}
export async function procedureReceiptResult(
  base: StudioCase,
  raw: ApplicationProcedureInput,
  nonce: string,
  id = linkId(432),
) {
  const input = applicationProcedureInputSchema.parse(raw),
    company = structuredClone(base);
  const { expectedLinkEventId: _link, ...fields } = input;
  void _link;
  const agency = company.agencyRecords.find((r) => r.id === input.agencyVersionId)!;
  const notice = isAgencyNoticeRecord(agency);
  if (!notice && agency.kind !== "request" && agency.kind !== "request-correction")
    throw Error("Synthetic request or notice required");
  const chainKind = notice ? "notice" : "request",
    chainRootId = notice ? agency.noticeRecordId : agency.requestRecordId;
  const cycle = applicationMetadata(company, input.applicationId)!;
  const link = currentApplicationLinks(company).find((r) => r.id === input.expectedLinkEventId)!;
  const previous = company.applicationProcedures.find((r) => r.id === input.previousVersionId);
  company.applicationProcedures.push(
    applicationProcedureSchema.parse({
      ...fields,
      id,
      procedureId: input.procedureId ?? id,
      version: (previous?.version ?? 0) + 1,
      applicationTitle: cycle.title,
      applicationSha256: await procedureReceiptHash(JSON.stringify(cycle)),
      chainKind,
      chainRootId,
      linkEventId: input.expectedLinkEventId,
      linkEventSha256: await procedureReceiptHash(JSON.stringify(link)),
      agencySnapshot: structuredClone(agency),
      agencySha256: await procedureReceiptHash(JSON.stringify(agency)),
      sourceSnapshots: [],
      clientRequestId: nonce,
      inputDigest: await procedureReceiptHash(JSON.stringify(input)),
      recordedAt: "2026-10-12T04:30:00.000Z",
      origin: "manual",
      officialVerification: "unverified",
    }),
  );
  company.revision++;
  return caseSchema.parse(company);
}
export async function procedureReceiptFixture() {
  let company = linkReceiptCompany();
  company.profile.companyName = "합성 절차 안내기한 기업";
  company.applicationProcedures = [];
  const common = {
    institution: "합성 기관",
    occurredOn: "2026-10-09",
    dueOn: "",
    dueNote: "",
    note: "기관 기록 합성 메모",
    evidence: [],
    origin: "manual" as const,
    inputDigest: "a".repeat(64),
    recordedAt: "2026-10-10T00:00:00.000Z",
  };
  const request = {
    ...common,
    id: linkId(401),
    clientRequestId: linkId(403),
    kind: "request" as const,
    requestRecordId: linkId(401),
    requestVersionId: linkId(401),
    responseStatus: null,
    previousVersionId: null,
    version: 1,
    title: "원래 보완 요청",
    body: "이전 기관 요청 원문",
  };
  company.agencyRecords.push(request);
  const applicationId = company.applications[1].id;
  company = linkReceiptResult(
    company,
    {
      action: "link-application-agency",
      revision: company.revision,
      clientRequestId: linkId(411),
      applicationId,
      recordId: request.id,
      note: "합성 두 번째 회차 귀속",
    },
    linkId(410),
  );
  const initial = applicationProcedureInputSchema.parse({
    procedureId: null,
    previousVersionId: null,
    applicationId,
    applicationMetadataVersionId: applicationMetadata(company, applicationId)!.metadataVersionId,
    agencyVersionId: request.id,
    expectedLinkEventId: linkId(410),
    title: "이전 절차 기록",
    procedureType: "document",
    requester: "이전 담당",
    requestedOn: "",
    dueOn: "",
    dueBasis: "",
    extensionStatus: "unknown",
    extensionRequestedOn: "",
    extensionDecidedOn: "",
    extendedDueOn: "",
    extensionBasis: "",
    status: "unknown",
    statusBasis: "",
    completionBasis: "",
    recordedBy: "이전 기록자",
    note: "이전 절차 메모",
    evidence: [],
  });
  company = await procedureReceiptResult(company, initial, linkId(421), linkId(420));
  company.agencyRecords.push({
    ...request,
    id: linkId(402),
    clientRequestId: linkId(404),
    kind: "request-correction",
    requestVersionId: linkId(402),
    previousVersionId: request.id,
    version: 2,
    title: "정정 보완 요청",
    body: "정정된 기관 요청 원문",
  });
  company = caseSchema.parse(company);
  const raw = {
    title: "  새 절차 기록  ",
    requester: "  새 담당 주체\n담당 부서  ",
    requestedOn: "2026-10-10",
    dueOn: "2026-10-20",
    dueBasis: "  합성 안내기한 근거\n담당자 수기 기록  ",
    extensionRequestedOn: "2026-10-11",
    extensionDecidedOn: "2026-10-12",
    extendedDueOn: "2026-11-03",
    extensionBasis: "  합성 연장 근거\n기관 확인 결과 아님  ",
    statusBasis: "  합성 준비 상태 근거\n추가 자료 대기  ",
    completionBasis: "  완료 여부는 아직 미확인  ",
    recordedBy: "  새 기록 담당자  ",
    note: "  새 절차 메모\n추가 확인 내용  ",
  };
  const input = applicationProcedureInputSchema.parse({
    ...initial,
    ...raw,
    procedureId: linkId(420),
    previousVersionId: linkId(420),
    agencyVersionId: linkId(402),
    procedureType: "evaluation",
    extensionStatus: "reported_allowed",
    status: "preparing",
  });
  const nonce = linkId(431);
  return {
    company: caseSchema.parse(company),
    initial,
    raw,
    input,
    nonce,
    saved: await procedureReceiptResult(company, input, nonce),
  };
}
