import { getAiStatus } from "@/lib/studio-engine";
import { supportedFiles } from "@/lib/studio-extract";
import { jsonResponse, studioRoute } from "@/lib/studio-http";
import type { StudioStatus } from "@/lib/studio-schema";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return studioRoute(request, () =>
    jsonResponse({ ...getAiStatus(), storage: "local", supportedFiles } satisfies StudioStatus),
  );
}
