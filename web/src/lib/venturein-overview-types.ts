import { z } from "zod";

const revision = z.number().int().nonnegative().safe();
/** Local navigation only. This never represents an agency receipt or execution permission. */
export const ventureOverviewSchema = z
  .object({
    caseId: z.string().uuid(),
    companyRevision: revision,
    workflowRevision: revision,
    accountRevision: revision,
    accountSaved: z.boolean(),
    sessionState: z.enum([
      "idle",
      "starting",
      "awaiting_setup",
      "awaiting_login",
      "awaiting_auth",
      "connected_unmapped",
      "login_failed",
      "stopped",
    ]),
    sessionUpdatedAt: z.string().datetime().nullable(),
    screenObservedAt: z.string().datetime().nullable(),
    phase: z.enum(["connect", "inspect", "view", "map", "review", "execute", "verify", "handoff"]),
    previousInputNeedsCheck: z.boolean(),
    readAt: z.string().datetime(),
    automaticSubmissionAvailable: z.literal(false),
    officialStatusChecked: z.literal(false),
    transmissionAllowed: z.literal(false),
  })
  .strict();
export type VentureOverview = z.infer<typeof ventureOverviewSchema>;

export function readVentureOverview(
  value: unknown,
  company: { id: string; revision: number },
): VentureOverview {
  const parsed = ventureOverviewSchema.parse(value);
  if (parsed.caseId !== company.id || parsed.companyRevision !== company.revision)
    throw new Error(
      "기업 자료가 변경되었거나 다른 기업의 연결 기록입니다. 기업 화면을 다시 불러와 주세요.",
    );
  return parsed;
}

export function ventureOverviewAction(value: VentureOverview): {
  title: string;
  description: string;
  label: string;
} {
  if (value.previousInputNeedsCheck)
    return {
      title: "이전 입력 결과를 확인해 주세요",
      description:
        "전송된 값이나 파일이 있을 수 있습니다. 기존 연결 화면에서 결과를 확인하며 같은 요청을 자동으로 다시 보내지 않습니다.",
      label: "이전 입력 결과 확인",
    };
  if (value.sessionState === "awaiting_setup")
    return {
      title: "공식 보안 프로그램 확인이 필요해요",
      description: "열린 공식 Edge 창에서 필요한 설치 안내를 확인한 뒤 기존 연결을 이어가세요.",
      label: "설치 안내와 연결 확인",
    };
  if (["starting", "awaiting_login", "awaiting_auth"].includes(value.sessionState))
    return {
      title: "로그인·추가 인증을 확인해 주세요",
      description:
        "열린 공식 Edge 창에서 본인 인증을 확인하세요. 이 안내를 여는 것만으로 인증이나 로그인 요청을 다시 실행하지 않습니다.",
      label: "로그인 연결 이어서 보기",
    };
  if (value.sessionState !== "connected_unmapped")
    return {
      title: value.accountSaved
        ? "저장한 계정으로 연결을 준비하세요"
        : "벤처인 계정을 연결해 주세요",
      description:
        "다음 화면에서 계정과 연결할 기업을 확인합니다. 계정 저장과 로그인 성공은 별개입니다.",
      label: "벤처인 연결 준비",
    };
  const labels = {
    connect: ["로그인 연결을 확인해 주세요", "벤처인 연결 확인"],
    inspect: ["공식 신청 화면을 확인해 주세요", "신청 화면 연결 준비"],
    view: ["현재 읽은 화면에는 입력할 항목이 없습니다", "읽은 화면 확인하기"],
    map: ["입력할 항목과 자료를 연결해 주세요", "항목·첨부 연결 확인"],
    review: ["선택한 입력 내용을 점검해 주세요", "입력·첨부 점검"],
    execute: ["전송할 값과 파일을 검토해 주세요", "선택 입력 검토하기"],
    verify: ["이전 입력 결과를 확인해 주세요", "이전 입력 결과 확인"],
    handoff: ["공식 화면의 다음 절차를 확인해 주세요", "공식 화면 확인하기"],
  } as const;
  const [title, label] = labels[value.phase];
  return {
    title,
    label,
    description:
      value.phase === "view"
        ? "보관된 화면 내용을 참고용으로 확인합니다. 이 안내로 입력 검토나 새 신청을 시작하지 않으며, 확인 유형·제출·접수 결과를 판정하지 않습니다."
        : value.phase === "handoff"
          ? "선택 항목의 화면 값·첨부 확인 기록입니다. 최종 제출·납부·접수 완료는 공식 사이트에서 별도로 확인해야 합니다."
          : "기존 연결 화면에서 회사·항목·첨부와 전송 범위를 확인합니다. 이 요약은 입력 실행이나 제출 승인이 아닙니다.",
  };
}
