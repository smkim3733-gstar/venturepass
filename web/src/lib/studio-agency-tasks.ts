import { isAgencyNoticeRecord, type AgencyRequestRecord } from "./studio-agency-records";
import { StudioError } from "./studio-http";
import type { StudioCase, WorkflowTask } from "./studio-schema";

export function agencyTaskContext(company: StudioCase, task: WorkflowTask) {
  const origin = task.agencyOrigin;
  if (!origin) return null;
  const requests = company.agencyRecords.filter(
    (record): record is AgencyRequestRecord =>
      !isAgencyNoticeRecord(record) &&
      record.kind !== "response" &&
      record.requestRecordId === origin.requestRecordId,
  );
  const version = requests.find((record) => record.id === origin.requestVersionId);
  const latest = requests.at(-1);
  return {
    version,
    latest,
    state: !version || !latest ? "missing" : latest.id === version.id ? "current" : "updated",
  } as const;
}

export function currentAgencyTaskRequest(
  company: StudioCase,
  requestRecordId: string,
  requestVersionId: string,
): AgencyRequestRecord {
  const requests = company.agencyRecords.filter(
    (record): record is AgencyRequestRecord =>
      !isAgencyNoticeRecord(record) &&
      record.kind !== "response" &&
      record.requestRecordId === requestRecordId,
  );
  if (!requests.some((record) => record.id === requestRecordId && record.kind === "request"))
    throw new StudioError(
      "같은 기업의 기관 요청을 찾을 수 없습니다.",
      404,
      "AGENCY_REQUEST_NOT_FOUND",
    );
  const latest = requests.at(-1)!;
  if (latest.id !== requestVersionId)
    throw new StudioError(
      "기관 요청이 정정되었습니다. 최신 요청을 확인해 주세요.",
      409,
      "AGENCY_REQUEST_OUTDATED",
    );
  return latest;
}
