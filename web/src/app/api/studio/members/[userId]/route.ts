import { readJson, studioRoute } from "@/lib/studio-route";
import { updateMember } from "@/lib/studio-members";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  return studioRoute(request, async () =>
    updateMember((await context.params).userId, await readJson(request)),
  );
}
