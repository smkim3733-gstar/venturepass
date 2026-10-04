import { randomUUID } from "node:crypto";
import { guidedApplicationsFixture } from "./studio-guided-applications-test-helpers";
import type { AgencyNoticeRecord, AgencyRequestRecord } from "./studio-agency-records";
import type { GuidedWorkflowTarget } from "./studio-guided-followup";
export function guidedAgencyContextFixture() {
  const { company, apply } = guidedApplicationsFixture();
  const id = randomUUID();
  const request: AgencyRequestRecord = {
    id,
    clientRequestId: randomUUID(),
    inputDigest: "a".repeat(64),
    recordedAt: "2026-10-01T00:00:00.000Z",
    origin: "manual",
    kind: "request",
    requestRecordId: id,
    requestVersionId: id,
    previousVersionId: null,
    version: 1,
    institution: "합성 기관",
    title: "합성 보완 원문 v1",
    body: "합성 최초 요청 본문",
    occurredOn: "2026-10-01",
    dueOn: "2026-11-01",
    dueNote: "담당자 기재 기한",
    note: "",
    responseStatus: null,
    evidence: [],
  };
  const correctedId = randomUUID();
  const corrected: AgencyRequestRecord = {
    ...request,
    id: correctedId,
    clientRequestId: randomUUID(),
    kind: "request-correction",
    requestVersionId: correctedId,
    previousVersionId: request.id,
    version: 2,
    title: "합성 보완 원문 v2",
    body: "합성 정정 요청 본문",
  };
  const noticeId = randomUUID();
  const notice: AgencyNoticeRecord = {
    id: noticeId,
    clientRequestId: randomUUID(),
    inputDigest: "b".repeat(64),
    recordedAt: "2026-10-01T00:00:00.000Z",
    origin: "manual",
    kind: "notice",
    noticeRecordId: noticeId,
    previousVersionId: null,
    version: 1,
    institution: "합성 기관",
    title: "합성 납부 안내",
    body: "합성 납부 기록 본문",
    occurredOn: "2026-10-01",
    note: "",
    evidence: [],
    details: {
      category: "payment",
      amountWon: "",
      dueOn: "2026-11-02",
      dueNote: "합성 기한",
      paidOn: "",
      referenceNumber: "",
      statusText: "담당자 기록",
    },
  };
  company.agencyRecords = [request, corrected, notice];
  apply({
    action: "link-application-agency",
    applicationId: company.applications[0].id,
    recordId: request.id,
    note: "처음 회차 연결",
  });
  const target: GuidedWorkflowTarget = {
    kind: "response",
    caseId: company.id,
    companyRevision: company.revision,
    requestRecordId: request.id,
    requestVersionId: corrected.id,
  };
  const noticeTarget: GuidedWorkflowTarget = {
    kind: "notice",
    caseId: company.id,
    companyRevision: company.revision,
    noticeRecordId: notice.id,
    noticeVersionId: notice.id,
  };
  return { company, apply, request, corrected, notice, target, noticeTarget };
}
