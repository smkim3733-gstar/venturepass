import type { StudioCase } from "./studio-schema";
import type { VentureConnectionStatus } from "./venturein-schema";
import type { VentureWorkflowStatus } from "./venturein-workflow";
import { readVentureOverview, type VentureOverview } from "./venturein-overview-types";

export const ventureGuidedSections = {
  account: "계정 저장",
  login: "로그인·추가 인증",
  company: "신청기업과 보관 화면",
  mapping: "신청 항목과 원고·첨부 연결",
  review: "선택 입력 준비",
  execution: "입력·첨부 검토와 이전 결과",
  journey: "공식 화면의 다음 단계",
} as const;
export type VentureGuidedSection = keyof typeof ventureGuidedSections;
export type VentureGuidedNavigation =
  { valid: true; section: VentureGuidedSection; label: string } | { valid: false; reason: string };

/** A navigation bookmark only. No approval, inspection, save or execution is created. */
export function resolveVentureGuidedNavigation(
  target: VentureOverview,
  company: Pick<StudioCase, "id" | "revision">,
  connection: VentureConnectionStatus,
  workflow: VentureWorkflowStatus,
): VentureGuidedNavigation {
  const changed = (): VentureGuidedNavigation => ({
    valid: false,
    reason:
      "연결 기록이 간단 화면의 안내와 달라졌습니다. 이전 안내로 이동하지 않습니다. 간단 화면에서 연결 기록을 다시 확인해 주세요.",
  });
  try {
    const value = readVentureOverview(target, company);
    if (
      workflow.report.caseId !== company.id ||
      (workflow.snapshot && workflow.snapshot.caseId !== company.id) ||
      (workflow.draft && workflow.draft.caseId !== company.id) ||
      value.workflowRevision !== workflow.revision ||
      value.accountRevision !== connection.account.revision ||
      value.accountRevision !== workflow.accountRevision ||
      value.accountSaved !== connection.account.saved ||
      value.sessionState !== connection.session.state ||
      value.sessionState !== workflow.session.state ||
      value.sessionUpdatedAt !== connection.session.updatedAt ||
      value.sessionUpdatedAt !== workflow.session.updatedAt ||
      connection.session.startedAt !== workflow.session.startedAt ||
      value.screenObservedAt !== (workflow.snapshot?.screen.observedAt ?? null) ||
      value.phase !== workflow.journey.phase ||
      value.previousInputNeedsCheck !==
        Boolean(
          workflow.execution &&
          (workflow.execution.status !== "completed" ||
            workflow.execution.code === "INPUT_RESULT_UNKNOWN"),
        )
    )
      return changed();
    let section: VentureGuidedSection;
    if (value.previousInputNeedsCheck) section = "execution";
    else if (!connection.account.saved) section = "account";
    else if (connection.session.state !== "connected_unmapped" || value.phase === "connect")
      section = "login";
    else
      section = (
        {
          inspect: "company",
          map: "mapping",
          review: "review",
          execute: "execution",
          verify: "execution",
          handoff: "journey",
        } as const
      )[value.phase];
    return { valid: true, section, label: ventureGuidedSections[section] };
  } catch {
    return changed();
  }
}
