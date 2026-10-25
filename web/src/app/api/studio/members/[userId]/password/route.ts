import { readJson, studioRoute } from "@/lib/studio-route";
import { resetMemberPassword } from "@/lib/studio-members";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: { params: Promise<{ userId: string }> }) {
  return studioRoute(request, async () =>
    resetMemberPassword((await context.params).userId, await readJson(request)),
  );
}
