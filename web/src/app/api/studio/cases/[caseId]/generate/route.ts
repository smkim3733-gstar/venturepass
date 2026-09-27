import { analyzeCompany, generatePlan, reviewPlan, StudioEngineError } from "@/lib/studio-engine";
import { generationSchema } from "@/lib/studio-schema";
import { currentVerifiedCandidateSelection } from "@/lib/studio-candidate-selection";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readJson, studioRoute, StudioError } from "@/lib/studio-http";
import { studioGenerationJobs as running } from "@/lib/studio-generation-lock";
import { unresolvedGuidedPreparationRuns } from "@/lib/studio-guided-preparation-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    const input = generationSchema.parse(await readJson(request));
    const { caseId } = await context.params;
    const store = getStudioStore();
    const record = store.get(caseId);
    if (record.revision !== input.revision)
      throw new StudioError(
        "기업정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요.",
        409,
        "STALE_REVISION",
      );
    if (
      running.has(caseId) ||
      unresolvedGuidedPreparationRuns(record.guidedPreparationRuns).length > 0
    )
      throw new StudioError(
        "이 기업의 분석·작성이 진행 중입니다. 완료 후 다시 시도해 주세요.",
        409,
        "GENERATION_RUNNING",
      );
    running.add(caseId);
    try {
      if (input.operation === "analyze") {
        const analysis = await analyzeCompany(record, input.mode);
        return jsonResponse(store.saveAnalysis(caseId, input.revision, analysis, input.mode));
      }
      const candidate = record.analysis?.candidates.find(
        (item) => item.id === record.selectedCandidateId,
      );
      if (!candidate)
        throw new StudioError(
          "기업을 분석한 후 신청 아이템을 선택해 주세요.",
          400,
          "CANDIDATE_REQUIRED",
        );
      if (!currentVerifiedCandidateSelection(record))
        throw new StudioError(
          "현재 분석의 후보와 선택 이유를 먼저 저장해 주세요.",
          409,
          "CANDIDATE_SELECTION_REQUIRED",
        );
      const content = await generatePlan(record, candidate, input.mode);
      return jsonResponse(
        store.saveGeneratedPlan(
          caseId,
          input.revision,
          candidate.id,
          content,
          reviewPlan(record, content),
          input.mode,
        ),
      );
    } catch (error) {
      if (error instanceof StudioEngineError)
        throw new StudioError(error.message, error.status, error.code);
      throw error;
    } finally {
      running.delete(caseId);
    }
  });
}
