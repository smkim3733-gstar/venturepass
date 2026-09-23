import { z } from "zod";
import { mutationSchema } from "@/lib/studio-schema";
import { reviewPlan } from "@/lib/studio-engine";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readJson, studioRoute } from "@/lib/studio-http";
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
    const mutation = mutationSchema.parse(await readJson(request));
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
