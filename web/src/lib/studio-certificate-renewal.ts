import type { AgencyNoticeRecord } from "./studio-agency-records";
import { isAgencyNoticeRecord } from "./studio-agency-records";
import { StudioError } from "./studio-http";
import {
  createCertificateTaskMutationSchema,
  type CertificateCompany,
  type CertificateTask,
  type CreateCertificateTask,
} from "./studio-certificate-renewal-types";

export function currentCertificateNotice(
  company: CertificateCompany,
  input: CreateCertificateTask,
) {
  const records = company.agencyRecords.filter(
    (record): record is AgencyNoticeRecord =>
      isAgencyNoticeRecord(record) && record.noticeRecordId === input.noticeRecordId,
  );
  if (
    records.filter((record) => record.kind === "notice" && record.id === input.noticeRecordId)
      .length !== 1
  )
    throw new StudioError(
      "같은 기업의 확인서 통보 기록을 찾을 수 없습니다.",
      404,
      "CERTIFICATE_NOTICE_NOT_FOUND",
    );
  const latest = records.at(-1)!;
  if (
    latest.id !== input.noticeVersionId ||
    records.filter((record) => record.id === input.noticeVersionId).length !== 1
  )
    throw new StudioError(
      "통보가 정정되었습니다. 최신 통보 원문을 확인해 주세요. 기존 준비 업무는 보존했습니다.",
      409,
      "CERTIFICATE_NOTICE_OUTDATED",
    );
  if (latest.details.category !== "certificate")
    throw new StudioError(
      "현재 통보 분류는 확인서가 아닙니다. 기존 업무를 확인해 주세요.",
      409,
      "CERTIFICATE_CATEGORY_CHANGED",
    );
  return { record: latest, details: latest.details };
}

export function existingCertificateTask(
  company: CertificateCompany,
  raw: CreateCertificateTask,
): CertificateTask | null {
  const input = createCertificateTaskMutationSchema.parse(raw);
  const { details } = currentCertificateNotice(company, input);
  const tasks = company.tasks.filter(
    (task) =>
      task.certificateOrigin?.noticeRecordId === input.noticeRecordId &&
      task.certificateOrigin.noticeVersionId === input.noticeVersionId,
  );
  if (tasks.length > 1)
    throw new StudioError(
      "같은 확인서 통보에 연결된 준비 업무가 중복되어 있습니다. 기존 업무를 확인해 주세요.",
      409,
      "CERTIFICATE_TASK_AMBIGUOUS",
    );
  const task = tasks[0];
  if (task && task.certificateOrigin!.validUntil !== details.validUntil)
    throw new StudioError(
      "연결 당시 통보 내용과 현재 기록이 다릅니다. 기존 업무와 원문을 확인해 주세요.",
      409,
      "CERTIFICATE_TASK_CONTEXT_CHANGED",
    );
  if (task && task.certificateOrigin!.preparationOn !== input.preparationOn)
    throw new StudioError(
      "이 통보 버전의 준비 업무가 이미 있습니다. 날짜는 기존 업무에서 직접 수정해 주세요.",
      409,
      "CERTIFICATE_TASK_EXISTS",
    );
  return task ?? null;
}

export function buildCertificateTask(
  company: CertificateCompany,
  raw: CreateCertificateTask,
  id: string,
): CertificateTask {
  const input = createCertificateTaskMutationSchema.parse(raw);
  const existing = existingCertificateTask(company, input);
  if (existing) return existing;
  if (company.tasks.length >= 200)
    throw new StudioError("기업별 업무는 200개까지 저장할 수 있습니다.", 413, "TASK_LIMIT");
  const { record, details } = currentCertificateNotice(company, input);
  return {
    id,
    title: `차기 재확인 준비: ${record.title}`.slice(0, 300),
    category: "other",
    dueDate: input.preparationOn,
    status: "pending",
    notes: `확인서 관련 통보 v${record.version}에 연결한 준비 업무입니다.\n통보에 기재한 유효종료일: ${details.validUntil || "미확인"}\n사용자가 정한 준비일: ${input.preparationOn}\n날짜는 담당자 기록이며 법정 갱신기한을 계산한 결과가 아닙니다. 확인서의 현재 효력·진위·취소 여부는 별도로 확인해 주세요. 업무 완료는 재신청·기관 접수·확인서 유효 확인을 의미하지 않습니다.`,
    certificateOrigin: {
      noticeRecordId: input.noticeRecordId,
      noticeVersionId: input.noticeVersionId,
      category: "certificate",
      validUntil: details.validUntil,
      preparationOn: input.preparationOn,
    },
  };
}
