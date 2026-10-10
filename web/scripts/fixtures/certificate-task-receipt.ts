import { caseSchema, taskSchema, type StudioCase } from "../../src/lib/studio-schema";
import { buildCertificateTask } from "../../src/lib/studio-certificate-renewal";
import type { CreateCertificateTask } from "../../src/lib/studio-certificate-renewal-types";
import type { AgencyNoticeRecord } from "../../src/lib/studio-agency-records";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
export { agencyId };
export function certificateTaskFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 확인서 준비 업무 기업";
  const old: AgencyNoticeRecord = {
    id: agencyId(80),
    noticeRecordId: agencyId(80),
    previousVersionId: null,
    version: 1,
    clientRequestId: agencyId(81),
    inputDigest: "a".repeat(64),
    kind: "notice",
    origin: "manual",
    recordedAt: "2026-10-10T00:00:00.000Z",
    institution: "합성 기관",
    title: "합성 확인서 통보",
    body: "  통보 원문\n둘째 줄  ",
    occurredOn: "",
    note: "",
    evidence: [],
    details: {
      category: "certificate",
      certificateNumber: "합성-확인서",
      issuedOn: "",
      validFrom: "",
      validUntil: "2028-09-24",
      statusText: "담당자 입력·효력 미확인",
    },
  };
  company.agencyRecords.push(old);
  const oldRequest: CreateCertificateTask = {
    action: "create-certificate-task",
    revision: company.revision,
    noticeRecordId: old.id,
    noticeVersionId: old.id,
    preparationOn: "2028-08-01",
  };
  const previous = taskSchema.parse(buildCertificateTask(company, oldRequest, agencyId(84)));
  previous.title = "담당자가 바꾼 이전 준비 업무";
  previous.dueDate = "2028-07-03";
  previous.status = "done";
  previous.notes = "  이전 업무 메모\n보존  ";
  previous.owners = {
    materials: "원래 자료 담당",
    writing: "원래 작성 담당",
    review: "원래 검토 담당",
  };
  company.tasks.push(previous);
  if (old.details.category !== "certificate") throw new Error("Synthetic certificate expected");
  const latest: AgencyNoticeRecord = {
    ...structuredClone(old),
    id: agencyId(82),
    kind: "notice-correction",
    previousVersionId: old.id,
    version: 2,
    clientRequestId: agencyId(83),
    details: { ...old.details, validUntil: "2029-09-24" },
  };
  company.agencyRecords.push(latest);
  const request: CreateCertificateTask = {
    ...oldRequest,
    noticeVersionId: latest.id,
    preparationOn: "2029-07-06",
  };
  return {
    company: caseSchema.parse(company),
    request,
    saved: certificateTaskResult(company, request),
  };
}
export function certificateTaskResult(base: StudioCase, request: CreateCertificateTask) {
  const saved = structuredClone(base);
  saved.tasks.push(taskSchema.parse(buildCertificateTask(base, request, agencyId(90))));
  saved.revision++;
  return caseSchema.parse(saved);
}
