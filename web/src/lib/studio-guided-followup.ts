import {
  isAgencyNoticeRecord,
  type AgencyNoticeRecord,
  type AgencyRequestRecord,
} from "./studio-agency-records";
import { applicationMetadata, currentApplicationLinks } from "./studio-application-types";
import type { StudioCase } from "./studio-schema";

type TargetContext = { caseId: string; companyRevision: number };
/** Navigation only. Never approves a mutation, an official action, or a newer record version. */
export type GuidedWorkflowTarget = TargetContext &
  (
    | { kind: "response"; requestRecordId: string; requestVersionId: string }
    | { kind: "notice"; noticeRecordId: string; noticeVersionId: string }
    | { kind: "certificate"; noticeRecordId: string; noticeVersionId: string }
    | { kind: "task"; taskId: string }
  );
export type GuidedDeadlineStatus = "unknown" | "upcoming" | "today" | "overdue";
export type GuidedFollowupItem = {
  kind: GuidedWorkflowTarget["kind"];
  target: GuidedWorkflowTarget;
  title: string;
  description: string;
  dueOn: string | null;
  dueNote: string;
  deadlineStatus: GuidedDeadlineStatus;
  recordedAt: string | null;
  version: number | null;
  provenance: "manual";
  actionLabel: string | null;
};
export type GuidedFollowupSummary = {
  state: "none" | "action-required" | "waiting";
  title: string;
  description: string;
  action: { label: string; target: GuidedWorkflowTarget } | null;
  primary: GuidedFollowupItem | null;
  items: GuidedFollowupItem[];
  lastRecordedAt: string | null;
  /** No current StudioCase field proves an official check. Do not substitute updatedAt. */
  lastCheckedAt: null;
  provenance: "manual" | "none";
};
export type GuidedFollowupOptions = { today?: string };

function date(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}
function recordedAt(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}
function deadline(due: string | null, today: string | null): GuidedDeadlineStatus {
  return !due || !today
    ? "unknown"
    : due < today
      ? "overdue"
      : due === today
        ? "today"
        : "upcoming";
}
function currentRequests(company: StudioCase) {
  const records = company.agencyRecords.filter(
    (record): record is AgencyRequestRecord => !isAgencyNoticeRecord(record),
  );
  return records
    .filter((record) => record.kind === "request")
    .flatMap((root) => {
      const chain = records.filter((record) => record.requestRecordId === root.id);
      let latest: AgencyRequestRecord | undefined;
      let response: AgencyRequestRecord | undefined;
      for (const record of chain) {
        if (company.agencyRecords.filter((item) => item.id === record.id).length !== 1) return [];
        if (record.kind === "response") {
          if (
            !latest ||
            record.previousVersionId !== (response?.id ?? null) ||
            record.version !== (response?.version ?? 0) + 1 ||
            record.requestVersionId !== latest.id
          )
            return [];
          response = record;
        } else {
          if (
            record.previousVersionId !== (latest?.id ?? null) ||
            record.version !== (latest?.version ?? 0) + 1 ||
            record.kind !== (latest ? "request-correction" : "request") ||
            record.requestVersionId !== record.id ||
            (!latest && record.id !== root.id)
          )
            return [];
          latest = record;
        }
      }
      return latest ? [{ root, latest, response }] : [];
    });
}
function currentNotices(company: StudioCase) {
  const records = company.agencyRecords.filter(isAgencyNoticeRecord);
  return records
    .filter((record) => record.kind === "notice")
    .flatMap((root) => {
      const chain = records.filter((record) => record.noticeRecordId === root.id);
      for (const [index, record] of chain.entries()) {
        if (
          company.agencyRecords.filter((item) => item.id === record.id).length !== 1 ||
          record.previousVersionId !== (chain[index - 1]?.id ?? null) ||
          record.version !== index + 1 ||
          record.kind !== (index ? "notice-correction" : "notice") ||
          (!index && record.id !== root.id)
        )
          return [];
      }
      return chain.length ? [chain.at(-1)!] : [];
    });
}
/** A matching manual completion can remove a repeated reminder, never prove official completion. */
function visitReportedCompleted(company: StudioCase, notice: AgencyNoticeRecord) {
  const link = currentApplicationLinks(company).find(
    (item) => item.chainKind === "notice" && item.chainRootId === notice.noticeRecordId,
  );
  if (
    !link?.applicationId ||
    link.recordVersionId !== notice.id ||
    company.applicationEvents.filter((item) => item.id === link.id).length !== 1 ||
    company.applications.filter((item) => item.id === link.applicationId).length !== 1
  )
    return false;
  const cycle = applicationMetadata(company, link.applicationId);
  if (!cycle) return false;
  const related = company.applicationProcedures.filter(
    (item) => item.chainKind === "notice" && item.chainRootId === notice.noticeRecordId,
  );
  const roots = [...new Set(related.map((item) => item.procedureId))];
  if (!roots.length) return false;
  return roots.every((id) => {
    const chain = related.filter((item) => item.procedureId === id);
    if (
      chain.some(
        (item, index) =>
          item.version !== index + 1 ||
          item.previousVersionId !== (chain[index - 1]?.id ?? null) ||
          company.applicationProcedures.filter((other) => other.id === item.id).length !== 1,
      )
    )
      return false;
    const latest = chain.at(-1)!;
    return (
      latest.applicationId === link.applicationId &&
      latest.applicationMetadataVersionId === cycle.metadataVersionId &&
      latest.applicationTitle === cycle.title &&
      latest.linkEventId === link.id &&
      latest.agencyVersionId === notice.id &&
      JSON.stringify(latest.agencySnapshot) === JSON.stringify(notice) &&
      latest.status === "reported_completed" &&
      Boolean(latest.completionBasis.trim()) &&
      Boolean(latest.statusBasis.trim())
    );
  });
}
export function validateGuidedWorkflowTarget(
  company: StudioCase,
  target: GuidedWorkflowTarget,
): { valid: true } | { valid: false; reason: string } {
  const invalid = {
    valid: false as const,
    reason: "기업이나 기록이 변경되었습니다. 현재 안내를 다시 확인해 주세요.",
  };
  if (!target || target.caseId !== company.id || target.companyRevision !== company.revision)
    return invalid;
  if (target.kind === "task")
    return company.tasks.filter((task) => task.id === target.taskId).length === 1
      ? { valid: true }
      : invalid;
  if (target.kind === "response")
    return currentRequests(company).filter(
      ({ root, latest }) =>
        root.id === target.requestRecordId && latest.id === target.requestVersionId,
    ).length === 1
      ? { valid: true }
      : invalid;
  if (target.kind === "notice" || target.kind === "certificate") {
    const matches = currentNotices(company).filter(
      (record) =>
        record.noticeRecordId === target.noticeRecordId &&
        record.id === target.noticeVersionId &&
        (target.kind !== "certificate" || record.details.category === "certificate"),
    );
    return matches.length === 1 ? { valid: true } : invalid;
  }
  return invalid;
}

/** Read append order, not dates or unrelated response.version numbers. No record is mutated. */
export function deriveGuidedFollowup(
  company: StudioCase,
  options: GuidedFollowupOptions = {},
): GuidedFollowupSummary {
  const today = date(options.today);
  const context = { caseId: company.id, companyRevision: company.revision };
  const requests = currentRequests(company);
  const notices = currentNotices(company);
  const unverifiedHistory = company.agencyRecords.some((record) =>
    isAgencyNoticeRecord(record)
      ? !notices.some((latest) => latest.noticeRecordId === record.noticeRecordId)
      : !requests.some(({ root }) => root.id === record.requestRecordId),
  );
  const afterSubmission = !["preparing", "drafting"].includes(company.stage);
  const items: GuidedFollowupItem[] = [];
  const add = (item: Omit<GuidedFollowupItem, "provenance" | "deadlineStatus">) =>
    items.push({ ...item, provenance: "manual", deadlineStatus: deadline(item.dueOn, today) });
  for (const { root, latest, response } of requests) {
    const sent =
      response?.responseStatus === "reported-sent" && response.requestVersionId === latest.id;
    add({
      kind: "response",
      target: {
        ...context,
        kind: "response",
        requestRecordId: root.id,
        requestVersionId: latest.id,
      },
      title: latest.title,
      description: sent
        ? "최신 요청에 답변을 발송했다고 기록했습니다. 기관 수신·검토 결과는 아직 확인되지 않았습니다."
        : "최신 요청 원문과 기한을 확인하고 답변을 준비해 주세요. 이전 버전의 발송 기록은 새 요청의 답변이 아닙니다.",
      dueOn: date(latest.dueOn),
      dueNote: latest.dueNote,
      recordedAt: recordedAt(response?.recordedAt ?? latest.recordedAt),
      version: latest.version,
      actionLabel: sent ? null : "답변 준비하기",
    });
  }
  for (const notice of notices) {
    const details = notice.details;
    let dueOn: string | null = null,
      dueNote = "",
      actionLabel: string | null = null;
    let description = "사용자가 남긴 통보 기록입니다. 공식 결과를 자동 확인한 기록이 아닙니다.";
    let kind: "notice" | "certificate" = "notice";
    if (details.category === "payment") {
      dueOn = date(details.dueOn);
      dueNote = details.dueNote;
      if (!date(details.paidOn)) {
        actionLabel = "납부 안내 확인하기";
        description =
          "납부했다고 기록한 날짜가 없습니다. 기관 안내의 금액·기한과 실제 납부 상태를 확인해 주세요.";
      } else
        description =
          "납부했다고 기록한 통보입니다. 기관의 납부 처리 결과를 자동 확인한 것은 아닙니다.";
    } else if (details.category === "visit") {
      dueOn = date(details.scheduledOn);
      dueNote = [details.timeText, details.location].filter(Boolean).join(" · ");
      const completed = visitReportedCompleted(company, notice);
      actionLabel = completed ? null : "실사 안내 확인하기";
      description = completed
        ? "현재 통보·신청 회차에 연결된 절차를 완료했다고 기록했습니다. 공식 실사 완료를 자동 확인한 것은 아닙니다."
        : "기록된 실사 일정과 준비사항을 확인해 주세요. 실제 실사 완료로 추정하지 않습니다.";
    } else if (details.category === "certificate") {
      kind = "certificate";
      dueOn = date(details.validUntil);
      dueNote = "사용자가 기록한 확인서 유효기간 종료일";
      const linked = company.tasks.filter(
        (task) =>
          task.certificateOrigin?.noticeRecordId === notice.noticeRecordId &&
          task.certificateOrigin.noticeVersionId === notice.id &&
          task.certificateOrigin.validUntil === details.validUntil,
      );
      if (
        !dueOn ||
        linked.length !== 1 ||
        (linked[0].status === "pending" && !date(linked[0].dueDate))
      )
        actionLabel = "확인서 후속 일정 준비하기";
      description =
        "확인서 번호·유효기간과 다음 준비 일정을 사용자가 기록한 상태입니다. 공식 발급이나 현재 유효성을 자동 확인하지 않습니다.";
    }
    add({
      kind,
      target: {
        ...context,
        kind,
        noticeRecordId: notice.noticeRecordId,
        noticeVersionId: notice.id,
      },
      title: notice.title,
      description,
      dueOn,
      dueNote,
      recordedAt: recordedAt(notice.recordedAt),
      version: notice.version,
      actionLabel,
    });
  }
  for (const task of company.tasks) {
    if (
      task.status !== "pending" ||
      !(
        task.agencyOrigin ||
        task.certificateOrigin ||
        ["payment", "supplement", "visit", "appeal"].includes(task.category) ||
        afterSubmission
      )
    )
      continue;
    const dueOn = date(task.dueDate);
    const futureCertificate = Boolean(task.certificateOrigin && dueOn && today && dueOn > today);
    const request =
      task.agencyOrigin &&
      currentRequests(company).find(({ root }) => root.id === task.agencyOrigin!.requestRecordId);
    const certificate =
      task.certificateOrigin &&
      currentNotices(company).find(
        (record) => record.noticeRecordId === task.certificateOrigin!.noticeRecordId,
      );
    const changed =
      Boolean(task.agencyOrigin && request?.latest.id !== task.agencyOrigin.requestVersionId) ||
      Boolean(
        task.certificateOrigin &&
        (certificate?.id !== task.certificateOrigin.noticeVersionId ||
          certificate.details.category !== "certificate" ||
          certificate.details.validUntil !== task.certificateOrigin.validUntil),
      );
    add({
      kind: "task",
      target: { ...context, kind: "task", taskId: task.id },
      title: task.title,
      description: changed
        ? "연결한 원문이 없거나 이후 정정되었습니다. 이전 업무 상태는 보존하고 현재 원문을 확인해 주세요."
        : "담당자가 기록한 미완료 업무입니다. 업무 완료 표시는 기관 처리 완료와 다릅니다.",
      dueOn,
      dueNote: "담당자가 정한 업무 기한",
      recordedAt: null,
      version: null,
      actionLabel: futureCertificate && !changed ? null : "업무 확인하기",
    });
  }
  const priority = { response: 0, task: 1, certificate: 2, notice: 3 };
  const actionable = items
    .filter((item) => item.actionLabel && validateGuidedWorkflowTarget(company, item.target).valid)
    .sort(
      (left, right) =>
        (left.dueOn ?? "9999").localeCompare(right.dueOn ?? "9999") ||
        priority[left.kind] - priority[right.kind],
    );
  const primary = actionable[0] ?? items.at(-1) ?? null;
  const hasHistory =
    afterSubmission ||
    items.length > 0 ||
    company.agencyRecords.length > 0 ||
    company.applicationEvents.some(
      (event) => event.kind === "submission-recorded" || event.kind === "submission-correction",
    );
  const timestamps = [
    ...company.agencyRecords,
    ...company.applicationEvents,
    ...company.stageHistory,
    ...company.applicationProcedures,
    ...company.responsePreparations,
    ...company.visitAnswers,
    ...company.appealPreparations,
  ]
    .map((record) => recordedAt(record.recordedAt))
    .filter((value): value is string => value !== null);
  const lastRecordedAt = timestamps.reduce<string | null>(
    (latest, value) => (!latest || Date.parse(value) > Date.parse(latest) ? value : latest),
    null,
  );
  const action = actionable[0]
    ? { label: actionable[0].actionLabel!, target: actionable[0].target }
    : null;
  return {
    state: action || unverifiedHistory ? "action-required" : hasHistory ? "waiting" : "none",
    title: action
      ? actionable[0].title
      : unverifiedHistory
        ? "기관 기록의 연결을 확인해야 합니다"
        : hasHistory
          ? "기록을 보관하고 다음 안내를 기다리고 있어요"
          : "현재 기록된 후속 업무가 없습니다",
    description: action
      ? actionable[0].description
      : unverifiedHistory
        ? "중복되거나 이전 버전 연결을 확인할 수 없는 기록이 있습니다. 발송 완료나 대기로 판단하지 않고 원래 기록을 보존합니다. 진행 기록에서 원문과 이력을 확인해 주세요."
        : "현재 기록만으로 추가 실행이 필요한 일을 확인하지 못했습니다. 새 요청이나 결과를 받으면 기록을 추가해 주세요. 기관 상태를 자동으로 확인한 것은 아닙니다.",
    action,
    primary,
    items,
    lastRecordedAt,
    lastCheckedAt: null,
    provenance: hasHistory ? "manual" : "none",
  };
}
