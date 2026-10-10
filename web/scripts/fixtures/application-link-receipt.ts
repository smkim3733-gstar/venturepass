import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  applicationEventSchema,
  currentApplicationLinks,
  type ApplicationMutation,
} from "../../src/lib/studio-application-types";
import { isAgencyNoticeRecord } from "../../src/lib/studio-agency-records";
import { submissionReadCompany } from "./guided-submission-read";
export const linkId = (n: number) => `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
export function linkReceiptCompany() {
  const company = submissionReadCompany();
  company.profile.companyName = "합성 기관 기록 연결 기업";
  company.tasks = [
    {
      id: linkId(20),
      title: "합성 담당 업무",
      category: "other",
      dueDate: "",
      status: "pending",
      notes: "",
    },
  ];
  company.applications.push({
    ...company.applications[0],
    id: linkId(1),
    clientRequestId: linkId(2),
    title: "합성 두 번째 신청",
  });
  return caseSchema.parse(company);
}
export function linkReceiptResult(
  base: StudioCase,
  command: Extract<
    ApplicationMutation,
    { action: "link-application-agency" | "correct-application-agency-link" }
  >,
  id = linkId(3),
) {
  const next = structuredClone(base),
    version = base.agencyRecords.find((r) => r.id === command.recordId)!;
  const notice = isAgencyNoticeRecord(version),
    chainKind = notice ? "notice" : "request",
    rootId = notice ? version.noticeRecordId : version.requestRecordId;
  const previous = currentApplicationLinks(base).find(
    (r) => r.chainRootId === rootId && r.chainKind === chainKind,
  );
  next.applicationEvents.push(
    applicationEventSchema.parse({
      id,
      clientRequestId: command.clientRequestId,
      inputDigest: "a".repeat(64),
      recordedAt: "2026-10-10T09:36:00.000Z",
      origin: "manual",
      kind: command.action === "link-application-agency" ? "agency-link" : "agency-link-correction",
      applicationId:
        command.action === "link-application-agency"
          ? command.applicationId
          : command.toApplicationId,
      fromApplicationId: previous?.applicationId ?? null,
      previousLinkEventId: previous?.id ?? null,
      chainRootId: rootId,
      chainKind,
      recordVersionId: command.recordId,
      note: command.note,
    }),
  );
  next.revision++;
  return caseSchema.parse(next);
}
