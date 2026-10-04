import { isAgencyNoticeRecord, type AgencyRecord } from "./studio-agency-records";
import {
  currentApplicationLinks,
  isApplicationLink,
  type ApplicationLink,
} from "./studio-application-types";
import {
  guidedApplicationHistory,
  type GuidedApplicationTarget,
} from "./studio-guided-applications";
import { guidedAgencyChain, type GuidedAgencyRecordTarget } from "./studio-guided-agency-records";
import { validateGuidedWorkflowTarget, type GuidedWorkflowTarget } from "./studio-guided-followup";
import type { StudioCase } from "./studio-schema";

type RecordAddress = { label: string; target: GuidedAgencyRecordTarget };
export type GuidedAgencyApplicationContext = {
  state: "linked" | "unassigned" | "released" | "unknown";
  label: string;
  detail: string;
  recordedAt: string | null;
  application: { title: string; target: GuidedApplicationTarget } | null;
  record: RecordAddress | null;
  fixedRecord: RecordAddress | null;
};
const recordLabel = (r: AgencyRecord) =>
  `${isAgencyNoticeRecord(r) ? "통보" : r.kind === "response" ? "답변" : "요청"} v${r.version}`;

function prepareContext(company: StudioCase) {
  const history = guidedApplicationHistory(company);
  const latest = new Map<string, ApplicationLink>();
  const records = new Map<string, ReturnType<typeof guidedAgencyChain>>();
  let invalid = history.needsInspection;
  for (const link of company.applicationEvents.filter(isApplicationLink)) {
    const key = `${link.chainKind}:${link.chainRootId}`;
    if (!records.has(key))
      records.set(key, guidedAgencyChain(company, link.chainKind, link.chainRootId));
    const chain = records.get(key),
      previous = latest.get(key);
    if (
      (previous
        ? link.kind !== "agency-link-correction" ||
          link.previousLinkEventId !== previous.id ||
          link.fromApplicationId !== previous.applicationId
        : link.kind !== "agency-link" ||
          link.previousLinkEventId !== null ||
          link.fromApplicationId !== null ||
          link.applicationId === null) ||
      !chain?.some((r) => r.id === link.recordVersionId) ||
      [link.applicationId, link.fromApplicationId].some(
        (id) => id !== null && !history.cycles.some((c) => c.id === id),
      )
    )
      invalid = true;
    latest.set(key, link);
  }
  return { history, latest, invalid };
}
/** Current manual assignment and its fixed source version. No new assignment or official check. */
function readContext(
  company: StudioCase,
  target: GuidedWorkflowTarget,
  prepared: ReturnType<typeof prepareContext>,
): GuidedAgencyApplicationContext | null {
  const unknown: GuidedAgencyApplicationContext = {
    state: "unknown",
    label: "신청 회차 연결 확인 필요",
    detail: "원래 기관 기록과 회차 연결 이력을 확인해 주세요. 현재 연결을 추정하지 않습니다.",
    recordedAt: null,
    application: null,
    record: null,
    fixedRecord: null,
  };
  if (!validateGuidedWorkflowTarget(company, target).valid) return unknown;
  let kind: "request" | "notice", rootId: string, versionId: string;
  if (target.kind === "response") {
    kind = "request";
    rootId = target.requestRecordId;
    versionId = target.requestVersionId;
  } else if (target.kind === "notice" || target.kind === "certificate") {
    kind = "notice";
    rootId = target.noticeRecordId;
    versionId = target.noticeVersionId;
  } else if (target.kind === "task") {
    const task = company.tasks.find((t) => t.id === target.taskId)!;
    if (task.agencyOrigin && task.certificateOrigin) return unknown;
    if (task.agencyOrigin) {
      kind = "request";
      rootId = task.agencyOrigin.requestRecordId;
      versionId = task.agencyOrigin.requestVersionId;
    } else if (task.certificateOrigin) {
      kind = "notice";
      rootId = task.certificateOrigin.noticeRecordId;
      versionId = task.certificateOrigin.noticeVersionId;
    } else return null;
  } else return null;
  const chain = guidedAgencyChain(company, kind, rootId);
  const shown = chain?.find((r) => r.id === versionId);
  if (!chain || !shown) return unknown;
  if (target.kind === "task") {
    const task = company.tasks.find((t) => t.id === target.taskId)!;
    if (task.agencyOrigin && (isAgencyNoticeRecord(shown) || shown.kind === "response"))
      return unknown;
    if (
      task.certificateOrigin &&
      (!isAgencyNoticeRecord(shown) ||
        shown.details.category !== "certificate" ||
        shown.details.validUntil !== task.certificateOrigin.validUntil)
    )
      return unknown;
  }

  const address = (r: AgencyRecord): RecordAddress => ({
    label: recordLabel(r),
    target: {
      kind: "agency-record",
      caseId: company.id,
      companyRevision: company.revision,
      chainKind: kind,
      chainRootId: rootId,
      recordVersionId: r.id,
    },
  });
  const base = { ...unknown, record: address(shown) };
  const { history } = prepared;
  if (prepared.invalid) return base;
  const current = currentApplicationLinks(company).find(
    (e) => e.chainKind === kind && e.chainRootId === rootId,
  );
  if (!current)
    return {
      ...base,
      state: "unassigned",
      label: "신청 회차 미지정",
      detail:
        "이 기관 기록에 연결한 신청 회차가 없습니다. 최근 회차나 접수번호로 추정하지 않습니다.",
    };
  if (current.id !== prepared.latest.get(`${kind}:${rootId}`)?.id) return base;
  const fixed = chain.find((r) => r.id === current.recordVersionId)!;
  const versionDetail =
    current.recordVersionId === shown.id
      ? `연결 기준: ${recordLabel(fixed)}.`
      : `연결 기준: ${recordLabel(fixed)} · 이 안내의 원문: ${recordLabel(shown)}. 다른 버전을 자동으로 같은 연결 기준으로 바꾸지 않습니다.`;
  const cycle = history.cycles.find((c) => c.id === current.applicationId);
  const from = history.cycles.find((c) => c.id === current.fromApplicationId);
  return {
    ...base,
    state: cycle ? "linked" : "released",
    label: cycle ? `신청 회차: ${cycle.title}` : "신청 회차 연결 해제 기록",
    detail: `${current.fromApplicationId !== current.applicationId && from ? `이전 회차 ‘${from.title}’에서 ${cycle ? "다른 회차로 변경" : "연결 해제"}했다고 기록했습니다. ` : ""}${versionDetail}`,
    recordedAt: current.recordedAt,
    application: cycle ? { title: cycle.title, target: { ...cycle.target } } : null,
    fixedRecord: address(fixed),
  };
}

export function guidedAgencyApplicationContexts(
  company: StudioCase,
  targets: GuidedWorkflowTarget[],
) {
  const prepared = prepareContext(company);
  return targets.map((target) => readContext(company, target, prepared));
}
export function guidedAgencyApplicationContext(company: StudioCase, target: GuidedWorkflowTarget) {
  return guidedAgencyApplicationContexts(company, [target])[0];
}
