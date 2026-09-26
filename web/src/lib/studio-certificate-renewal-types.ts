import { z } from "zod";
import { isAgencyNoticeRecord, type AgencyNoticeRecord } from "./studio-agency-records";
import type { StudioCase, WorkflowTask } from "./studio-schema";

const date = z.string().refine((value) => {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "날짜를 YYYY-MM-DD 형식으로 확인해 주세요.");

export const certificateTaskOriginSchema = z
  .object({
    noticeRecordId: z.string().uuid(),
    noticeVersionId: z.string().uuid(),
    category: z.literal("certificate"),
    validUntil: date,
    preparationOn: date.refine(Boolean, "준비 업무 날짜를 직접 입력해 주세요."),
  })
  .strict();
export type CertificateTaskOrigin = z.infer<typeof certificateTaskOriginSchema>;
export const createCertificateTaskMutationSchema = z
  .object({
    action: z.literal("create-certificate-task"),
    revision: z.number().int().nonnegative().safe(),
    noticeRecordId: z.string().uuid(),
    noticeVersionId: z.string().uuid(),
    preparationOn: date.refine(Boolean, "준비 업무 날짜를 직접 입력해 주세요."),
  })
  .strict();
export type CreateCertificateTask = z.infer<typeof createCertificateTaskMutationSchema>;
export type CertificateTask = WorkflowTask & { certificateOrigin?: CertificateTaskOrigin };
export type CertificateCompany = Pick<StudioCase, "agencyRecords"> & { tasks: CertificateTask[] };
export type CertificateAttention = {
  recordedUntilDates: string[];
  missingUntilCount: number;
  needsPreparationCount: number;
  changedTaskCount: number;
};

export function latestCertificateNotices(company: Pick<StudioCase, "agencyRecords">) {
  const latest = new Map<string, AgencyNoticeRecord>();
  for (const record of company.agencyRecords)
    if (isAgencyNoticeRecord(record)) latest.set(record.noticeRecordId, record);
  return [...latest.values()].filter((record) => record.details.category === "certificate");
}

export function certificateTaskContext(company: CertificateCompany, task: CertificateTask) {
  const origin = task.certificateOrigin;
  if (!origin) return null;
  const related = company.agencyRecords.filter(
    (record): record is AgencyNoticeRecord =>
      isAgencyNoticeRecord(record) && record.noticeRecordId === origin.noticeRecordId,
  );
  const versions = related.filter((record) => record.id === origin.noticeVersionId);
  const version = versions.length === 1 ? versions[0] : undefined;
  const latest = related.at(-1);
  const state =
    !version || !latest || version.details.category !== "certificate"
      ? "missing"
      : latest.id !== version.id || version.details.validUntil !== origin.validUntil
        ? "updated"
        : "current";
  return { version, latest, state } as const;
}

/** Only dates/counts: certificate numbers, people, notice bodies never enter company lists. */
export function certificateAttention(company: CertificateCompany): CertificateAttention {
  const notices = latestCertificateNotices(company);
  const tasks = company.tasks.filter((task) => task.certificateOrigin);
  return {
    recordedUntilDates: notices
      .flatMap((record) =>
        record.details.category === "certificate" && record.details.validUntil
          ? [record.details.validUntil]
          : [],
      )
      .sort(),
    missingUntilCount: notices.filter(
      (record) => record.details.category === "certificate" && !record.details.validUntil,
    ).length,
    needsPreparationCount: notices.filter((record) => {
      const linked = tasks.filter(
        (task) =>
          task.certificateOrigin?.noticeRecordId === record.noticeRecordId &&
          task.certificateOrigin.noticeVersionId === record.id,
      );
      return linked.length !== 1 || (linked[0].status === "pending" && !linked[0].dueDate);
    }).length,
    changedTaskCount: tasks.filter(
      (task) => certificateTaskContext(company, task)?.state !== "current",
    ).length,
  };
}
