import { z } from "zod";
import { criteriaVersionActions, criteriaVersionLimits } from "@/lib/studio-criteria-version-types";
import { applicationProcedureLimits } from "@/lib/studio-application-procedure-types";
import { sourceSuggestionLimits } from "@/lib/studio-source-suggestion-types";
import { claimReviewLimits } from "@/lib/studio-claim-review-types";
import { companyContactsLimits } from "@/lib/studio-company-contacts-types";
import { mutationSchema } from "@/lib/studio-schema";
import { numericCheckLimits } from "@/lib/studio-numeric-check-types";
import { applicationActions, applicationLimits } from "@/lib/studio-application-types";
import { responsePreparationLimits } from "@/lib/studio-response-preparation-types";
import { planReviewLimits } from "@/lib/studio-plan-review-types";
import { candidateSelectionLimits } from "@/lib/studio-candidate-selection-types";
import { reviewPlan } from "@/lib/studio-engine";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, readJson, studioRoute } from "@/lib/studio-http";
import { StudioError } from "@/lib/studio-http";
import { withVentureLock } from "@/lib/venturein-service";
import { stopVentureSession } from "@/lib/venturein-runner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () =>
    jsonResponse(getStudioStore().get((await context.params).caseId)),
  );
}
export function PATCH(request: Request, context: Context) {
  return studioRoute(request, async () => {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const bytes = await readBoundedBody(request, 2 * 1024 * 1024);
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const applicationRequest =
      typeof raw === "object" &&
      raw !== null &&
      "action" in raw &&
      (applicationActions as readonly unknown[]).includes(raw.action);
    if (applicationRequest && bytes.byteLength > applicationLimits.requestBytes)
      throw new StudioError("신청회차 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "action" in raw &&
      raw.action === "append-numeric-check" &&
      bytes.byteLength > numericCheckLimits.requestBytes
    )
      throw new StudioError("수치 대조 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "action" in raw &&
      raw.action === "append-visit-answer" &&
      bytes.byteLength > 512 * 1024
    )
      throw new StudioError("실사 답변 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "action" in raw &&
      ["append-response-preparation", "register-prepared-response"].includes(String(raw.action)) &&
      bytes.byteLength > responsePreparationLimits.requestBytes
    )
      throw new StudioError("답변 준비 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      typeof raw === "object" &&
      raw !== null &&
      "action" in raw &&
      raw.action === "append-claim-review" &&
      bytes.byteLength > claimReviewLimits.requestBytes
    )
      throw new StudioError("주장 검토 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    const mutation = mutationSchema.parse(raw);
    if (mutation.action === "set-preparation-automation" && bytes.byteLength > 4096)
      throw new StudioError("로컬 준비 설정 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      (criteriaVersionActions as readonly string[]).includes(mutation.action) &&
      bytes.byteLength > criteriaVersionLimits.requestBytes
    )
      throw new StudioError("기준 기록 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      mutation.action === "append-application-procedure" &&
      bytes.byteLength > applicationProcedureLimits.requestBytes
    )
      throw new StudioError("신청 절차 기록 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      mutation.action === "adopt-source-suggestions" &&
      bytes.byteLength > sourceSuggestionLimits.requestBytes
    )
      throw new StudioError("기업정보 제안 채택 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      mutation.action === "append-company-contacts" &&
      bytes.byteLength > companyContactsLimits.requestBytes
    )
      throw new StudioError("기업 연락 메모 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      mutation.action === "select-candidate" &&
      bytes.byteLength > candidateSelectionLimits.requestBytes
    )
      throw new StudioError("아이템 선택 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (mutation.action === "create-certificate-task" && bytes.byteLength > 4096)
      throw new StudioError("확인서 준비 업무 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      mutation.action === "append-plan-review" &&
      bytes.byteLength > planReviewLimits.requestBytes
    )
      throw new StudioError("검토 판단 요청 용량을 초과했습니다.", 413, "TOO_LARGE");
    if (
      [
        ...applicationActions,
        ...criteriaVersionActions,
        "diagnose",
        "diagnosis-answers",
        "diagnosis-tasks",
        "create-agency-task",
        "create-certificate-task",
        "append-appeal-preparation",
        "append-visit-answer",
        "append-numeric-check",
        "append-claim-review",
        "append-application-procedure",
        "append-response-preparation",
        "register-prepared-response",
        "append-plan-review",
        "select-candidate",
        "append-company-contacts",
        "adopt-source-suggestions",
        "set-preparation-automation",
      ].includes(mutation.action) &&
      new URL(request.url).search
    )
      throw new StudioError("이 요청에는 URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    return jsonResponse(
      getStudioStore().mutate((await context.params).caseId, mutation, reviewPlan),
    );
  });
}
export function DELETE(request: Request, context: Context) {
  return studioRoute(request, async () => {
    const { revision } = z
      .object({ revision: z.number().int().nonnegative() })
      .parse(await readJson(request));
    const { caseId } = await context.params;
    return withVentureLock(caseId, async () => {
      const store = getStudioStore();
      if (store.get(caseId).revision !== revision)
        throw new StudioError(
          "기업정보가 변경되었습니다. 다시 불러와 주세요.",
          409,
          "STALE_REVISION",
        );
      await stopVentureSession(caseId);
      store.delete(caseId, revision);
      return jsonResponse({ ok: true });
    });
  });
}
