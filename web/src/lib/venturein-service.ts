import { getStudioStore, type StudioStore } from "./studio-storage";
import { StudioError } from "./studio-http";
import { getVentureAccountStatus } from "./venturein-vault";
import { getVentureSession } from "./venturein-runner";
import type { VentureConnectionStatus, VenturePreparation } from "./venturein-schema";

const processState = globalThis as typeof globalThis & { __ventureinOperationLocks?: Set<string> };
const locks = (processState.__ventureinOperationLocks ??= new Set<string>());
export async function withVentureLock<T>(caseId: string, action: () => Promise<T>): Promise<T> {
  if (locks.has(caseId))
    throw new StudioError(
      "계정 연결 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.",
      409,
      "VENTURE_BUSY",
    );
  locks.add(caseId);
  try {
    return await action();
  } finally {
    locks.delete(caseId);
  }
}

export function prepareVentureApplication(store: StudioStore, caseId: string): VenturePreparation {
  const company = store.get(caseId);
  const plan = company.plans.at(-1);
  const blockers: string[] = [];
  if (!plan) blockers.push("사업계획서 작성본을 먼저 준비해 주세요.");
  if (plan && !store.isPlanCurrent(caseId, plan))
    blockers.push("기업 자료나 아이템이 변경되었습니다. 최신 자료로 작성본을 다시 검토해 주세요.");
  if (plan && !plan.confirmedAt)
    blockers.push("사업계획서의 내부 검토 완료가 아직 기록되지 않았습니다.");
  if (plan?.content.sections.some((section) => section.needsConfirmation))
    blockers.push("사업계획서에 사실·증빙 확인이 필요한 항목이 남아 있습니다.");
  if (plan?.review.some((finding) => finding.severity === "error"))
    blockers.push("사업계획서의 검토 오류를 먼저 해결해 주세요.");
  if (!company.profile.businessNumber.trim())
    blockers.push("공식 계정의 기업과 대조할 사업자등록번호가 필요합니다.");
  const attachments = company.sources
    .filter((source) => source.originalName)
    .map((source) => ({
      id: source.id,
      name: source.name,
      originalName: source.originalName!,
    }));
  blockers.push(
    "로그인 후 기업 일치 여부, 공식 입력 항목·첨부 규격·제출 결과 화면의 연결 검증이 필요합니다.",
  );
  return {
    planId: plan?.id ?? null,
    planVersion: plan?.version ?? null,
    planTitle: plan?.content.title ?? null,
    sections:
      plan?.content.sections.map(({ key, title, content, needsConfirmation }) => ({
        key,
        title,
        content,
        needsConfirmation,
      })) ?? [],
    attachments,
    blockers,
  };
}

export function getVentureConnection(caseId: string): VentureConnectionStatus {
  const store = getStudioStore();
  return {
    account: getVentureAccountStatus(store, caseId),
    session: getVentureSession(caseId),
    preparation: prepareVentureApplication(store, caseId),
    credentialStorage: process.platform === "win32" ? "windows-dpapi" : "unavailable",
    automaticSubmissionAvailable: false,
  };
}
