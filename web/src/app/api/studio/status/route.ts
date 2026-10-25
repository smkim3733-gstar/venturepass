import { getAiStatus } from "@/lib/studio-engine";
import { supportedFiles } from "@/lib/studio-extract";
import { jsonResponse, studioRoute } from "@/lib/studio-route";
import { currentRequestScope } from "@/lib/studio-request-scope";
import type { StudioStatus } from "@/lib/studio-schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return studioRoute(request, () => {
    const principal = currentRequestScope()?.principal;
    return jsonResponse({
      ...getAiStatus(),
      storage: principal ? "server" : "local",
      supportedFiles,
      ...(principal ? { user: { displayName: principal.displayName, role: principal.role } } : {}),
    } satisfies StudioStatus);
  });
}
