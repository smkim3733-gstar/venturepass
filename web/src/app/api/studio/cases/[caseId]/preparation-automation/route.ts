import { getStudioStore } from "@/lib/studio-storage";
import { localPreparationIsRunning, runLocalPreparation } from "@/lib/studio-preparation";
import { createPreparationAutomationHandlers } from "@/lib/studio-preparation-automation-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = createPreparationAutomationHandlers(getStudioStore, {
  runPreparation: (caseId, input) => runLocalPreparation(getStudioStore(), caseId, input),
  preparationIsRunning: localPreparationIsRunning,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
